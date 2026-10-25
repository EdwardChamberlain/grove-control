"""Virtual printer bind/detect server: the framed detect handshake over a
real loopback socket, malformed requests, and start/stop."""

import asyncio
import errno
import json
import struct
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services.virtual_printer import bind_server as bs
from backend.app.services.virtual_printer.bind_server import BindServer


def frame(payload) -> bytes:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return b"\xa5\xa5" + struct.pack("<H", 4 + len(body) + 2) + body + b"\xa7\xa7"


@pytest.fixture
def server():
    return BindServer(serial="SER123", model="C11", name="Farm VP", version="01.07.00.00")


async def exchange(server: BindServer, data: bytes) -> bytes:
    """Send data to the handler over loopback TCP and return whatever comes back."""
    listener = await asyncio.start_server(server._handle_client, "127.0.0.1", 0)
    port = listener.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        if data:
            writer.write(data)
            await writer.drain()
        writer.write_eof()
        reply = await asyncio.wait_for(reader.read(), timeout=5)
        writer.close()
        return reply
    finally:
        listener.close()
        await listener.wait_closed()


class TestHandshake:
    async def test_detect_returns_the_printer_identity(self, server):
        reply = await exchange(server, frame({"login": {"command": "detect", "sequence_id": "20000"}}))

        login = server._parse_frame(reply)["login"]
        assert (login["id"], login["model"], login["name"], login["version"]) == (
            "SER123",
            "C11",
            "Farm VP",
            "01.07.00.00",
        )
        assert (login["bind"], login["connect"], login["sequence_id"]) == ("free", "lan", 3021)

    @pytest.mark.parametrize(
        "data",
        [
            b"",
            b"short",
            b"XX" + b"\x00" * 10,  # wrong header
            b"\xa5\xa5\x0a\x00{}\x00\x00",  # wrong trailer
            frame(b"{not json"),
            frame({"login": {"command": "bind"}}),
            frame({"login": "detect"}),
        ],
        ids=["empty", "short", "bad-header", "bad-trailer", "bad-json", "other-command", "login-not-dict"],
    )
    async def test_bad_requests_get_no_reply(self, server, data):
        assert await exchange(server, data) == b""

    def test_length_mismatch_is_tolerated(self, server):
        data = b"\xa5\xa5\xff\x00" + b'{"a":1}' + b"\xa7\xa7"

        assert server._parse_frame(data) == {"a": 1}

    def test_build_frame_round_trips(self, server):
        assert server._parse_frame(server._build_frame({"x": [1, 2]})) == {"x": [1, 2]}

    async def test_timeouts_and_errors_close_the_connection(self, server):
        writer = AsyncMock()
        writer.get_extra_info = lambda key: None
        writer.close = lambda: None
        writer.wait_closed = AsyncMock(side_effect=OSError("gone"))

        for error in (TimeoutError(), RuntimeError("boom")):
            reader = AsyncMock()
            reader.read.side_effect = error
            await server._handle_client(reader, writer)


class TestTls:
    def test_no_certificate_means_no_tls(self, server):
        assert server._create_tls_context() is None


class TestLifecycle:
    async def test_serves_on_free_ports_then_stops(self, server):
        with patch.object(bs, "BIND_PORTS", [0, 0]):
            task = asyncio.create_task(server.start())
            await asyncio.wait_for(server.ready.wait(), timeout=5)
            assert len(server._servers) == 2
            await server.start()  # already running: no-op
            task.cancel()
            await task

        assert server._servers == [] and not server.ready.is_set()

    @pytest.mark.parametrize("code", [errno.EADDRINUSE, errno.EACCES, errno.EINVAL])
    async def test_no_bindable_port(self, server, code):
        with patch.object(bs.asyncio, "start_server", AsyncMock(side_effect=OSError(code, "nope"))):
            await server.start()

        assert server._servers == [] and not server.ready.is_set()

    async def test_unexpected_error_stops_the_server(self, server):
        with patch.object(bs.asyncio, "start_server", AsyncMock(side_effect=RuntimeError("boom"))):
            await server.start()

        assert server._running is False
