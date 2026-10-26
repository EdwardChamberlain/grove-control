"""Virtual printer FTP session over plain loopback TCP: login, passive and
extended-passive uploads, the upload-done callback, and simple commands.

TLS is left off (ssl_context=None) so the control and data channels are
ordinary sockets; the FTP state machine is the same."""

import asyncio
import socket
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services.virtual_printer import ftp_server
from backend.app.services.virtual_printer.ftp_server import FTPSession, VirtualPrinterFTPServer


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    """Minimal FTP control-channel client."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    async def line(self) -> str:
        return (await asyncio.wait_for(self.reader.readline(), timeout=5)).decode().strip()

    async def cmd(self, text: str) -> str:
        self.writer.write(f"{text}\r\n".encode())
        await self.writer.drain()
        return await self.line()

    async def login(self, code="12345678") -> str:
        await self.cmd("USER bblp")
        return await self.cmd(f"PASS {code}")


@pytest.fixture
async def ftp(tmp_path):
    """Start a control listener whose handler runs an FTPSession; yields (connect, received)."""
    received: list[tuple] = []
    sessions: list[FTPSession] = []

    async def on_file(path, ip):
        received.append((path.name, path.read_bytes(), ip))

    async def handler(reader, writer):
        session = FTPSession(
            reader,
            writer,
            tmp_path,
            "12345678",
            None,
            on_file,
            passive_port_range=(free_port(),) * 2,
            bind_address="127.0.0.1",
            vp_name="VP",
        )
        sessions.append(session)
        await session.handle()

    listener = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = listener.sockets[0].getsockname()[1]

    async def connect() -> Client:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        client = Client(reader, writer)
        assert (await client.line()).startswith("220")
        return client

    yield connect, received, sessions
    listener.close()
    await listener.wait_closed()


async def upload(client: Client, name: str, data: bytes, mode="PASV") -> list[str]:
    reply = await client.cmd(mode)
    if mode == "PASV":
        nums = reply[reply.index("(") + 1 : reply.index(")")].split(",")
        port = int(nums[4]) * 256 + int(nums[5])
        assert ".".join(nums[:4]) == "127.0.0.1"
    else:
        port = int(reply.split("|||")[1].rstrip("|)"))
    started = await client.cmd(f"STOR ../../{name}")
    _, data_writer = await asyncio.open_connection("127.0.0.1", port)
    data_writer.write(data)
    await data_writer.drain()
    data_writer.close()
    return [reply, started, await client.line()]


class TestLogin:
    async def test_login_and_basic_commands(self, ftp):
        connect, _, _ = ftp
        client = await connect()

        assert (await client.cmd("PWD")).startswith("530")
        assert (await client.cmd("PASS nope")).startswith("503")
        assert (await client.cmd("USER root")).startswith("530")
        assert (await client.cmd("USER bblp")).startswith("331")
        assert (await client.cmd("PASS wrong")).startswith("530")
        assert (await client.login()).startswith("230")

        replies = {
            "SYST": "215",
            "PWD": "257",
            "CWD /sdcard": "250",
            "TYPE I": "200",
            "TYPE A": "200",
            "TYPE E": "504",
            "SIZE x.3mf": "550",
            "NOOP": "200",
            "OPTS UTF8 ON": "200",
            "OPTS MLST": "501",
            "PBSZ 0": "200",
            "PROT P": "200",
            "PROT C": "536",
            "PROT X": "504",
            "MKD cache": "257",
            "XYZZY": "502",
        }
        for command, code in replies.items():
            assert (await client.cmd(command)).startswith(code), command

        assert (await client.cmd("FEAT")) == "211-Features:"
        assert [await client.line() for _ in range(5)][-1] == "211 End"
        assert (await client.cmd("LIST")).startswith("150")
        assert (await client.line()).startswith("226")
        assert (await client.cmd("QUIT")).startswith("221")

    @pytest.mark.parametrize("command", ["CWD x", "TYPE I", "PASV", "EPSV", "STOR a", "SIZE a", "MKD a", "LIST"])
    async def test_commands_need_login(self, ftp, command):
        connect, _, _ = ftp
        client = await connect()

        assert (await client.cmd(command)).startswith("530")


class TestUpload:
    @pytest.mark.parametrize("mode", ["PASV", "EPSV"])
    async def test_upload_saves_the_file_and_notifies(self, ftp, tmp_path, mode):
        connect, received, _ = ftp
        client = await connect()
        await client.login()

        replies = await upload(client, "Benchy.3mf", b"PK" + b"x" * 200_000, mode=mode)

        assert [r[:3] for r in replies] == ["227" if mode == "PASV" else "229", "150", "226"]
        # The path is reduced to its name, so ../../ cannot escape the upload dir.
        assert (tmp_path / "Benchy.3mf").stat().st_size == 200_002
        assert received[0][0] == "Benchy.3mf" and received[0][2] == "127.0.0.1"

    async def test_two_uploads_in_one_session(self, ftp):
        connect, received, _ = ftp
        client = await connect()
        await client.login()

        await upload(client, "a.3mf", b"one")
        await upload(client, "b.3mf", b"two")

        assert [(name, data) for name, data, _ in received] == [("a.3mf", b"one"), ("b.3mf", b"two")]

    async def test_stor_without_pasv(self, ftp):
        connect, _, _ = ftp
        client = await connect()
        await client.login()

        assert (await client.cmd("STOR a.3mf")).startswith("425")

    async def test_data_connection_timeout(self, ftp):
        connect, _, _ = ftp
        client = await connect()
        await client.login()
        await client.cmd("PASV")

        real_wait_for = asyncio.wait_for

        async def fast_timeout(awaitable, timeout):
            if timeout == 30:
                awaitable.close()
                raise TimeoutError
            return await real_wait_for(awaitable, timeout)

        with patch.object(ftp_server.asyncio, "wait_for", fast_timeout):
            assert (await client.cmd("STOR a.3mf")).startswith("150")
            assert (await client.line()).startswith("425 Data connection timeout")

    async def test_oversized_upload_is_rejected_and_removed(self, ftp, tmp_path):
        connect, received, _ = ftp
        client = await connect()
        await client.login()

        with patch.object(ftp_server, "MAX_UPLOAD_BYTES", 10):
            replies = await upload(client, "big.3mf", b"x" * 1000)

        assert replies[-1].startswith("426")
        assert not (tmp_path / "big.3mf").exists()
        assert received == []

    async def test_no_free_passive_port(self, ftp):
        connect, _, _ = ftp
        client = await connect()
        await client.login()

        with patch.object(ftp_server.asyncio, "start_server", AsyncMock(side_effect=OSError("in use"))):
            assert (await client.cmd("PASV")).startswith("425")
            assert (await client.cmd("EPSV")).startswith("425")

    async def test_pasv_address_override(self, tmp_path):
        writer = AsyncMock()
        writer.get_extra_info = lambda key: None
        writer.write = lambda data: sent.append(data.decode())
        sent: list[str] = []
        session = FTPSession(
            AsyncMock(),
            writer,
            tmp_path,
            "c",
            None,
            None,
            passive_port_range=(free_port(),) * 2,
            pasv_address="203.0.113.7",
            bind_address="127.0.0.1",
        )
        session.authenticated = True

        await session.cmd_PASV("")
        await session._close_data_connection()

        assert "203,0,113,7" in sent[-1]

    async def test_callback_errors_do_not_break_the_session(self, ftp):
        connect, _, sessions = ftp
        client = await connect()
        await client.login()
        sessions[0].on_file_received = lambda path, ip: (_ for _ in ()).throw(RuntimeError("callback failed"))

        replies = await upload(client, "a.3mf", b"data")

        assert replies[-1].startswith("226")
        assert (await client.cmd("NOOP")).startswith("200")


class TestServer:
    async def test_stop_cancels_sessions(self, tmp_path):
        server = VirtualPrinterFTPServer(tmp_path, "c", tmp_path / "cert", tmp_path / "key", vp_name="VP")
        task = asyncio.create_task(asyncio.sleep(10))
        server._active_sessions.append(task)
        server._server = AsyncMock()
        server._server.close = lambda: None

        await server.stop()

        assert task.cancelled() and server._server is None and server._active_sessions == []

    async def test_handle_client_runs_a_session(self, tmp_path):
        server = VirtualPrinterFTPServer(tmp_path, "c", tmp_path / "cert", tmp_path / "key")

        with patch.object(FTPSession, "handle", AsyncMock()) as handle:
            writer = AsyncMock()
            writer.get_extra_info = lambda key: ("10.0.0.2", 5000)
            await server._handle_client(AsyncMock(), writer)

        handle.assert_awaited_once()
        assert server._active_sessions == []

    @pytest.mark.parametrize("error", [OSError(98, "in use"), OSError("other"), RuntimeError("x")])
    async def test_start_failures(self, tmp_path, error):
        server = VirtualPrinterFTPServer(tmp_path / "up", "c", tmp_path / "cert", tmp_path / "key")

        with (
            patch.object(ftp_server.ssl.SSLContext, "load_cert_chain"),
            patch.object(ftp_server.asyncio, "start_server", AsyncMock(side_effect=error)),
        ):
            await server.start()

        assert (tmp_path / "up" / "cache").is_dir()
        assert server._running is False
