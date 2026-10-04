"""
The four services, as commands.

Commands are the repository's own package.json scripts with arguments appended,
not reimplementations of them: `bun run dev` stays the one place that knows how
the dev server starts.
"""

import subprocess
import threading
from dataclasses import dataclass

from devsuite.compose import compose_argv
from devsuite.logview import VITE_LEVEL


@dataclass
class Service:
    name: str
    argv: list[str]
    port: int
    # A container's lifetime is Compose's; the suite only follows its logs.
    containerised: bool = False
    process: subprocess.Popen[str] | None = None
    reader: threading.Thread | None = None
    health: str = "starting"


def app_service(level: str, port: int, *, built: bool) -> Service:
    if built:
        # The adapter-bun build, through server.js, exactly as a deployment runs it. It takes its
        # port and origin from the environment rather than the command line.
        return Service(name="app", argv=["bun", "run", "start"], port=port)

    return Service(
        name="app",
        argv=["bun", "run", "dev", "--port", str(port), "--logLevel", VITE_LEVEL[level]],
        port=port,
    )


def sandbox_service(level: str, port: int) -> Service:
    """
    The sandbox is always served from its build, never from Vite's dev server.

    This service exists only where Caddy does not. With `--production` the same
    `build-sandbox/` directory is mounted into Caddy and served by the same
    `file_server` a deployment uses, so running Vite's preview server beside it
    would be a second answer to a question that already has one.

    Not a performance choice — the dev server cannot serve a working sandbox at
    all. The runner document is sandboxed without `allow-same-origin`, so its
    origin is opaque, and a document with an opaque origin may not fetch a
    subresource from an `http://` origin on the local network. Vite's dev server
    serves unbundled ES modules, which is nothing but such subresources: the
    runner's own module, and every module it imports. None of them load, the
    runner never posts `ready`, and the artifact panel waits on a build that
    cannot start.

    The build inlines the runner into `index.html` for the same reason, which
    leaves the pinned runtimes as the only files the origin still serves. So the
    built sandbox works and the dev-server sandbox cannot, and there is no
    version of this worth offering as a choice.

    The sandbox reads its port from SETUN_SANDBOX_PORT (sandbox/vite.config.ts
    binds it with strictPort), so only the level is passed on the command line.
    """
    return Service(
        name="sandbox",
        argv=["bun", "run", "preview:sandbox", "--logLevel", VITE_LEVEL[level]],
        port=port,
    )


def cpa_service(project: str, port: int) -> Service:
    return Service(
        name="cpa",
        argv=compose_argv(project, "logs", "--follow", "--no-log-prefix", "cpa"),
        port=port,
        containerised=True,
    )


def caddy_service(project: str, port: int) -> Service:
    return Service(
        name="caddy",
        argv=compose_argv(project, "logs", "--follow", "--no-log-prefix", "caddy"),
        port=port,
        containerised=True,
    )
