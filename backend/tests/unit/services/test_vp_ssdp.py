"""Virtual printer SSDP: the discovery responder and the proxy that
re-broadcasts a real printer's announcements onto another network.

Sockets are replaced with an in-memory fake, so nothing binds port 2021."""

import errno
import socket
import types
from unittest.mock import patch

import pytest

from backend.app.services.virtual_printer import ssdp_server as ssdp
from backend.app.services.virtual_printer.ssdp_server import (
    BAMBU_SEARCH_TARGET,
    SSDPProxy,
    VirtualPrinterSSDPServer,
)

MSEARCH = f"M-SEARCH * HTTP/1.1\r\nST: {BAMBU_SEARCH_TARGET}\r\n\r\n".encode()
PRINTER_NOTIFY = (
    "NOTIFY * HTTP/1.1\r\n"
    "Location: 192.168.1.50\r\n"
    f"NT: {BAMBU_SEARCH_TARGET}\r\n"
    "NTS: ssdp:alive\r\n"
    "USN: 01P00A000000001\r\n"
    "DevName.bambu.com: Workshop P1S\r\n"
    "DevBind.bambu.com: occupied\r\n"
    "\r\n"
).encode()


class FakeSocket:
    """Records sendto calls; recvfrom replays queued packets, then stops the owner."""

    instances: list["FakeSocket"] = []

    def __init__(self, *args, **kwargs):
        self.sent: list[tuple[bytes, tuple]] = []
        self.inbox: list[tuple[bytes, tuple]] = []
        self.bound = None
        self.closed = False
        self.on_empty = None
        self.fail_send = False
        self.fail_bind = False
        FakeSocket.instances.append(self)

    def setsockopt(self, *args):
        pass

    def setblocking(self, flag):
        pass

    def bind(self, addr):
        if self.fail_bind:
            raise OSError("bind failed")
        self.bound = addr

    def sendto(self, data, addr):
        if self.fail_send:
            raise OSError("network down")
        self.sent.append((data, addr))

    def recvfrom(self, size):
        if self.inbox:
            item = self.inbox.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        if self.on_empty:
            self.on_empty()
        raise BlockingIOError

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def fake_sockets():
    FakeSocket.instances = []
    # Swap only the module's own reference; the event loop keeps real sockets.
    fake_module = types.SimpleNamespace(**{**vars(socket), "socket": FakeSocket})
    with patch.object(ssdp, "socket", fake_module):
        yield FakeSocket.instances


def _headers(data: bytes) -> dict[str, str]:
    return SSDPProxy("a", "b", "c")._parse_ssdp_message(data)


class TestResponder:
    def test_messages_advertise_the_virtual_printer(self):
        server = VirtualPrinterSSDPServer(name="Farm VP", serial="SER1", model="C12", advertise_ip="10.0.0.9")

        notify = _headers(server._build_notify_message())
        response = _headers(server._build_response_message())

        assert (notify["location"], notify["usn"], notify["devname.bambu.com"]) == ("10.0.0.9", "SER1", "Farm VP")
        assert notify["nts"] == "ssdp:alive"
        assert (response["st"], response["devmodel.bambu.com"]) == (BAMBU_SEARCH_TARGET, "C12")

    def test_local_ip_detection(self, fake_sockets):
        server = VirtualPrinterSSDPServer()
        with (
            patch.object(FakeSocket, "connect", create=True),
            patch.object(FakeSocket, "getsockname", create=True, return_value=("192.168.5.5", 1234)),
        ):
            assert server._get_local_ip() == "192.168.5.5"
        assert server._get_local_ip() == "192.168.5.5"  # cached

        with patch.object(FakeSocket, "connect", create=True, side_effect=OSError("no route")):
            assert VirtualPrinterSSDPServer()._get_local_ip() == "127.0.0.1"

    async def test_answers_bambu_and_ssdp_all_searches_only(self):
        server = VirtualPrinterSSDPServer(advertise_ip="10.0.0.9")
        server._socket = FakeSocket()
        other = FakeSocket()

        await server._handle_message(MSEARCH.decode(), ("10.0.0.2", 5000))
        await server._handle_message("M-SEARCH * HTTP/1.1\r\nST: ssdp:ALL\r\n", ("10.0.0.3", 5000), other)
        await server._handle_message("M-SEARCH * HTTP/1.1\r\nST: urn:other\r\n", ("10.0.0.4", 5000))
        await server._handle_message("NOTIFY * HTTP/1.1\r\n", ("10.0.0.5", 5000))

        assert [addr for _, addr in server._socket.sent] == [("10.0.0.2", 5000)]
        assert [addr for _, addr in other.sent] == [("10.0.0.3", 5000)]

        server._socket.fail_send = True
        await server._handle_message(MSEARCH.decode(), ("10.0.0.2", 5000))  # send errors are swallowed

    async def test_start_announces_answers_and_says_goodbye(self, fake_sockets):
        server = VirtualPrinterSSDPServer(name="VP", bind_ip="10.0.0.9", extra_interfaces=["100.64.0.1"])
        packets = [(MSEARCH, ("10.0.0.2", 5000)), OSError("blip")]

        original_init = FakeSocket.__init__

        def init(sock, *a, **kw):
            original_init(sock, *a, **kw)
            if len(FakeSocket.instances) == 1:
                sock.inbox = list(packets)
            else:
                sock.inbox = [(MSEARCH, ("100.64.0.7", 6000)), OSError("x")]
            sock.on_empty = lambda: setattr(server, "_running", False)

        with patch.object(FakeSocket, "__init__", init), patch.object(ssdp.asyncio, "sleep"):
            await server.start()

        primary, extra = fake_sockets
        assert primary.bound == ("10.0.0.9", ssdp.SSDP_PORT)
        assert extra.bound == ("100.64.0.1", ssdp.SSDP_PORT)
        sent = [_headers(data) for data, _ in primary.sent]
        assert sent[0]["nts"] == "ssdp:alive"  # initial NOTIFY
        assert any(h.get("st") == BAMBU_SEARCH_TARGET for h in sent)  # M-SEARCH answer
        assert sent[-1]["nts"] == "ssdp:byebye"
        assert any(addr == ("100.64.0.7", 6000) for _, addr in extra.sent)
        assert primary.closed and extra.closed
        assert server.ready.is_set()

    async def test_bound_to_an_ip_adds_a_wildcard_listener(self, fake_sockets):
        server = VirtualPrinterSSDPServer(bind_ip="10.0.0.9")

        original_init = FakeSocket.__init__

        def init(sock, *a, **kw):
            original_init(sock, *a, **kw)
            sock.on_empty = lambda: setattr(server, "_running", False)
            if len(FakeSocket.instances) == 2:
                sock.fail_bind = True  # extra interface bind failure is tolerated

        with patch.object(FakeSocket, "__init__", init), patch.object(ssdp.asyncio, "sleep"):
            await server.start()

        assert len(fake_sockets) == 2
        assert server._extra_sockets == []

    @pytest.mark.parametrize("error", [OSError(errno.EADDRINUSE, "in use"), OSError("other"), RuntimeError("x")])
    async def test_start_failures_clean_up(self, fake_sockets, error):
        server = VirtualPrinterSSDPServer()

        with patch.object(FakeSocket, "bind", side_effect=error):
            await server.start()

        assert server._socket is None

    async def test_stop_and_double_start(self):
        server = VirtualPrinterSSDPServer()
        server._running = True
        await server.start()  # already running: no-op
        server._socket = FakeSocket()
        server._extra_sockets = [FakeSocket()]
        server._socket.fail_send = True  # byebye failure is swallowed

        await server.stop()

        assert (server._running, server._socket, server._extra_sockets) == (False, None, [])

    async def test_notify_survives_send_failures(self):
        server = VirtualPrinterSSDPServer(advertise_ip="1.2.3.4")
        server._socket = FakeSocket()
        server._socket.fail_send = True
        extra = FakeSocket()
        extra.fail_send = True
        server._extra_sockets = [extra]

        await server._send_notify()
        await server._send_byebye()
        server._socket = None
        await server._send_byebye()


class TestProxy:
    def proxy(self, name=None):
        p = SSDPProxy("192.168.1.10", "10.0.0.10", "192.168.1.50", name=name)
        p._remote_socket = FakeSocket()
        return p

    def test_rewrite_points_at_the_proxy_and_frees_binding(self):
        headers = _headers(self.proxy()._rewrite_ssdp(PRINTER_NOTIFY))

        assert headers["location"] == "10.0.0.10"
        assert headers["devbind.bambu.com"] == "free"
        assert headers["devname.bambu.com"] == "Workshop P1S - Proxy"

    def test_rewrite_uses_the_configured_name(self):
        assert (
            _headers(self.proxy(name="Remote P1S")._rewrite_ssdp(PRINTER_NOTIFY))["devname.bambu.com"] == "Remote P1S"
        )

    def test_rewrite_without_matching_headers_is_unchanged(self):
        assert self.proxy()._rewrite_ssdp(b"hello") == b"hello"

    async def test_printer_notify_is_cached_and_rebroadcast(self):
        proxy = self.proxy()

        await proxy._handle_local_packet(PRINTER_NOTIFY, ("192.168.1.50", 2021))

        assert proxy._printer_info["devname.bambu.com"] == "Workshop P1S"
        data, addr = proxy._remote_socket.sent[0]
        assert addr == (ssdp.SSDP_BROADCAST_ADDR, ssdp.SSDP_PORT)
        assert _headers(data)["location"] == "10.0.0.10"

    @pytest.mark.parametrize(
        ("data", "sender"),
        [
            (PRINTER_NOTIFY, "192.168.1.10"),  # our own interface
            (PRINTER_NOTIFY, "10.0.0.10"),
            (b"M-SEARCH * HTTP/1.1\r\nST: urn:other\r\n", "10.0.0.20"),  # irrelevant search
            (b"NOTIFY * HTTP/1.1\r\nNT: urn:other\r\n", "192.168.1.50"),  # not a Bambu printer
            (b"GARBAGE", "192.168.1.50"),
            (b"hello", "10.0.0.20"),  # neither printer nor M-SEARCH
        ],
    )
    async def test_ignored_packets(self, data, sender):
        proxy = self.proxy()

        await proxy._handle_local_packet(data, (sender, 2021))

        assert proxy._remote_socket.sent == []

    async def test_answers_slicer_searches_from_the_cache(self):
        proxy = self.proxy()
        await proxy._handle_local_packet(MSEARCH, ("10.0.0.20", 5000))  # nothing cached yet
        assert proxy._remote_socket.sent == []

        proxy._last_printer_ssdp = PRINTER_NOTIFY
        await proxy._handle_local_packet(MSEARCH, ("10.0.0.20", 5000))

        data, addr = proxy._remote_socket.sent[0]
        text = data.decode()
        assert addr == ("10.0.0.20", 5000)
        assert text.startswith("HTTP/1.1 200 OK")
        assert f"ST: {BAMBU_SEARCH_TARGET}" in text and "NTS:" not in text

        proxy._remote_socket.fail_send = True
        await proxy._respond_to_msearch(MSEARCH, ("10.0.0.20", 5000))
        await proxy._broadcast_to_remote()  # send failures are logged, not raised

    async def test_start_relays_and_stops(self, fake_sockets):
        proxy = SSDPProxy("192.168.1.10", "10.0.0.10", "192.168.1.50")
        original_init = FakeSocket.__init__

        def init(sock, *a, **kw):
            original_init(sock, *a, **kw)
            if len(FakeSocket.instances) == 1:
                sock.inbox = [(PRINTER_NOTIFY, ("192.168.1.50", 2021)), OSError("blip")]
            sock.on_empty = lambda: setattr(proxy, "_running", False)

        with patch.object(FakeSocket, "__init__", init), patch.object(ssdp.asyncio, "sleep"):
            await proxy.start()

        local, remote = fake_sockets
        assert local.bound == ("", ssdp.SSDP_PORT) and remote.bound == ("10.0.0.10", 0)
        assert len(remote.sent) >= 1
        assert local.closed and remote.closed

    @pytest.mark.parametrize("error", [OSError("no iface"), RuntimeError("x")])
    async def test_start_failure_cleans_up(self, fake_sockets, error):
        proxy = SSDPProxy("192.168.1.10", "10.0.0.10", "192.168.1.50")

        with patch.object(FakeSocket, "bind", side_effect=error):
            await proxy.start()

        assert proxy._local_socket is None

    async def test_stop_and_double_start(self):
        proxy = self.proxy()
        proxy._running = True
        await proxy.start()

        await proxy.stop()

        assert proxy._remote_socket is None
