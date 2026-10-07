"""
`--production` stops the built app the way a deployment does: one SIGTERM, then a drain.

The supervisor starts every child in its own session and stops it by signalling the
whole process group (`Supervisor.spawn`, `Supervisor._terminate`). Whatever sits between
the group and server.js must not deliver that SIGTERM a second time: adapter-bun treats a
second signal during its drain as a demand to stop at once (`process.exit(1)`), which
cuts every request still in flight.

This runs the real supervisor against a stand-in for the adapter-bun build (as
server.test.ts does): a small `index.js` in a temporary SETUN_BUILD_DIR that listens on
the front's socket, drains on its first signal and exits 1 on a second one, as
`@sveltejs/adapter-bun` does. It needs `bun` on PATH, as the suite does.
"""

import os
import signal
import socket
import tempfile
import time
import unittest
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from typing import cast, override

from devsuite.instance import Instance, InstanceLock
from devsuite.services import app_service
from devsuite.supervisor import Supervisor
from devsuite.util import signal_group

STANDIN = """
import process from "node:process";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const server = Bun.serve({
  unix: process.env.SOCKET_PATH,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/slow") return new Response("not found", { status: 404 });
    console.log("standin request started");
    await sleep(Number(url.searchParams.get("ms")));
    return new Response("slow request done");
  },
});
console.log("standin listening");

let stopping = false;
async function shutdown(reason) {
  console.log("standin received " + reason);
  if (stopping) return process.exit(1);
  stopping = true;
  await server.stop();
  process.emit("sveltekit:shutdown", reason);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
"""

SLOW_MS = 2000


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        # socket.getsockname() is typed Any; an AF_INET socket's is (host, port).
        _, port = cast(tuple[str, int], probe.getsockname())
        return port


def until(check: Callable[[], bool], timeout: float, what: str, log: Callable[[], str]) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}:\n{log()}")
        time.sleep(0.05)


def slow_request(port: int) -> str:
    """One request the build takes SLOW_MS to answer; what the client got, as text."""
    connection = HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.request("GET", f"/slow?ms={SLOW_MS}")
        response = connection.getresponse()
        return f"{response.status} {response.read().decode()}"
    except (OSError, HTTPException) as error:
        return f"request failed: {error!r}"
    finally:
        connection.close()


class BuiltAppShutdownTest(unittest.TestCase):
    root: Path = Path()

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="setun-devsuite-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_group_sigterm_drains_an_in_flight_request(self) -> None:
        build = self.root / "build"
        build.mkdir()
        _ = (build / "index.js").write_text(STANDIN, encoding="utf-8")
        scratch = self.root / "tmp"
        scratch.mkdir()

        port = free_port()
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            "TMPDIR": str(scratch),
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "ORIGIN": f"http://127.0.0.1:{port}",
            "SETUN_BUILD_DIR": str(build),
            "SHUTDOWN_TIMEOUT": "10",
            "NO_COLOR": "1",
        }
        instance = Instance(name="test", mode="persistent", root=self.root / "instance")
        supervisor = Supervisor(
            instance=instance,
            ports={"app": port},
            level="silent",
            with_cpa=False,
            production=True,
            environment=environment,
            lock=InstanceLock(instance.lock_path),
        )
        supervisor.open_logs(["suite", "app"])
        app_log = instance.logs / "app.log"

        def log() -> str:
            return app_log.read_text(encoding="utf-8") if app_log.exists() else ""

        service = app_service("info", port, built=True)
        supervisor.spawn(service)
        process = service.process
        assert process is not None
        group = os.getpgid(process.pid)

        # Whatever the outcome, nothing the test started outlives it.
        self.addCleanup(signal_group, group, signal.SIGKILL)

        until(lambda: "standin listening" in log(), 15, "the stand-in build", log)
        with ThreadPoolExecutor(max_workers=1) as pool:
            reply = pool.submit(slow_request, port)
            until(lambda: "standin request started" in log(), 10, "the slow request", log)
            # What `stop` and Ctrl+C do: `_terminate` signals the app's process group.
            supervisor.shutdown()
            outcome = reply.result(timeout=SLOW_MS / 1000 + 15)

        self.assertEqual(outcome, "200 slow request done", log())
        self.assertEqual(process.returncode, 0, log())
        self.assertEqual(log().count("standin received SIGTERM"), 1, log())
