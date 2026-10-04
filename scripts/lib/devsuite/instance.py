"""
Instances — a named directory holding one stack's data, logs and runtime state.

Persistent instances survive `stop`; ephemeral ones are removed on the way out,
whichever way out that turns out to be. Everything an instance owns hangs off
`Instance`, so "where does X live" has exactly one answer and ephemeral cleanup
is a directory removal.
"""

import errno
import fcntl
import json
import os
import re
import signal
import subprocess
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import IO, TypedDict, cast

from devsuite.compose import compose_argv, compose_command
from devsuite.console import fail, note
from devsuite.layout import INSTANCES, REPO
from devsuite.util import process_alive, signal_group, write_json

INSTANCE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")


# Both documents are read back from disk, where a hand edit or an older version
# of the suite may have left any key out — so every field is optional and every
# read goes through `.get`, with the shape naming what the writer puts there.


class ServiceState(TypedDict, total=False):
    """One service's entry in `state.json`."""

    pid: int | None
    port: int
    containerised: bool


class RunState(TypedDict, total=False):
    """`state.json` — what a running instance's supervisor recorded about it."""

    instance: str
    mode: str
    supervisor_pid: int
    started_at: str
    log_level: str
    with_cpa: bool
    production: bool
    caddy: bool
    compose_project: str
    services: dict[str, ServiceState]
    # The educator the running children were spawned with, and whether its
    # password is the development value in `instance.json`: see
    # `educator_credentials`. Absent where the run seeded no operator account.
    educator_username: str
    educator_password_minted: bool


class InstanceConfig(TypedDict, total=False):
    """`instance.json` — what survives between runs of one instance."""

    name: str
    mode: str
    created_at: str
    ports: dict[str, int]
    secrets: dict[str, str]
    # Set once by `start --first-run`, and never cleared: see `first_run_wanted`.
    first_run: bool


@dataclass
class Instance:
    name: str
    mode: str  # "persistent" | "ephemeral"
    root: Path

    @property
    def config_path(self) -> Path:
        return self.root / "instance.json"

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def run(self) -> Path:
        return self.root / "run"

    @property
    def state_path(self) -> Path:
        return self.run / "state.json"

    @property
    def lock_path(self) -> Path:
        return self.run / "suite.lock"

    @property
    def bootstrap_token_path(self) -> Path:
        """
        Where the application drops the first-run token, when asked to.

        Under run/ rather than data/: the token is runtime state with a
        fifteen-minute life, and `docs/setun-operations.md` §4 says explicitly
        never to point SETUN_BOOTSTRAP_TOKEN_PATH inside storage/ or backups/,
        which the nightly snapshot copies.
        """
        return self.run / "bootstrap-token"

    @property
    def database_path(self) -> Path:
        return self.data / "db" / "setun.sqlite"

    @property
    def storage_path(self) -> Path:
        return self.data / "storage"

    @property
    def backup_path(self) -> Path:
        return self.data / "backups"

    @property
    def build_path(self) -> Path:
        """
        Where `--production` puts the application build for *this* instance.

        Not the repository's own `build/`. That directory is one for the whole
        checkout, and `vite build` empties it before it writes: a second
        instance starting would delete the files the first one is serving, and
        an application reading a hashed asset that has just vanished is exactly
        the failure ISSUE-001 was. Per-instance output is what makes two
        `--production` stacks independent rather than merely concurrent.

        Beside data/ rather than inside it: this is derived output, not the
        instance's data, and `destroy` takes the whole root anyway.
        """
        return self.root / "build"

    @property
    def sandbox_build_path(self) -> Path:
        """
        The instance's own `build-sandbox/`, for the same reason as `build_path`.

        Every instance builds the sandbox, not only `--production` ones (see
        `sandbox_service`), so this collision is the wider of the two: two dev
        stacks share it as readily as two production ones.
        """
        return self.root / "build-sandbox"

    @property
    def compose_project(self) -> str:
        # Compose object names allow a narrow alphabet; instance names allow a
        # wider one, so it is folded rather than assumed compatible.
        safe = re.sub(r"[^a-z0-9_-]", "-", self.name.lower())
        return f"setun-devsuite-{safe}"

    def materialise(self) -> None:
        for directory in (
            self.data / "db",
            self.storage_path,
            self.backup_path,
            self.logs,
            self.run,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def read_config(self) -> InstanceConfig:
        if self.config_path.exists():
            return cast("InstanceConfig", json.loads(self.config_path.read_text(encoding="utf-8")))
        return {}

    def write_config(self, config: InstanceConfig) -> None:
        write_json(self.config_path, config)

    def read_state(self) -> RunState | None:
        try:
            return cast("RunState", json.loads(self.state_path.read_text(encoding="utf-8")))
        except FileNotFoundError, json.JSONDecodeError:
            return None


def instance_for(name: str, mode: str) -> Instance:
    """
    Address an instance by name.

    `mode` is only a default: an instance that already exists carries its own
    mode in instance.json, so `--persistent ephemeral-1234` still finds an
    ephemeral instance and still destroys it on the way out.
    """
    if not INSTANCE_NAME.match(name):
        fail(
            f"'{name}' is not a usable instance name",
            hint="Letters, digits, dot, dash and underscore; 40 characters at most.",
        )
    root = INSTANCES / name
    stored: InstanceConfig = {}
    config_path = root / "instance.json"
    if config_path.exists():
        try:
            stored = cast("InstanceConfig", json.loads(config_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            stored = {}
    return Instance(name=name, mode=stored.get("mode", mode), root=root)


def list_instances() -> list[Instance]:
    if not INSTANCES.is_dir():
        return []
    found: list[Instance] = []
    for directory in sorted(INSTANCES.iterdir()):
        if not directory.is_dir():
            continue
        config: InstanceConfig = {}
        config_path = directory / "instance.json"
        if config_path.exists():
            try:
                config = cast("InstanceConfig", json.loads(config_path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                config = {}
        found.append(
            Instance(
                name=directory.name,
                mode=config.get("mode", "persistent"),
                root=directory,
            )
        )
    return found


# ─────────────────────────────────────────────────────────────────────────────
# The lock
#
# `flock` rather than a PID file: a PID can be recycled between a crash and the
# next `start`, and the whole point is that `start` twice never spawns a second
# stack.
# ─────────────────────────────────────────────────────────────────────────────


class InstanceLock:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path: Path = path
        self._handle: IO[str] | None = None

    def acquire(self) -> bool:
        handle = self.path.open("a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            if error.errno in (errno.EACCES, errno.EAGAIN):
                return False
            raise
        self._handle = handle
        self.stamp()
        return True

    def stamp(self) -> None:
        """
        Record the pid that owns the lock.

        A detached supervisor calls this again after the fork: the child holds
        the lock through the open file description it inherited, so the file
        would otherwise keep naming a parent that has since returned.
        """
        if self._handle is None:
            return
        _ = self._handle.truncate(0)
        _ = self._handle.write(str(os.getpid()))
        self._handle.flush()

    def release(self) -> None:
        if self._handle is not None:
            try:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._handle.close()
                self._handle = None


def instance_is_running(instance: Instance) -> bool:
    """
    True when some other process holds the instance lock.

    Opens an existing file rather than creating one. `InstanceLock.acquire`
    makes the directory and the file, which is right for the owner and wrong
    for a probe: `stop` polls this until the lock clears, and an ephemeral
    supervisor removes its instance directory just before releasing — so a
    probe that created as it looked would resurrect the directory it was
    waiting to see the end of.
    """
    try:
        handle = instance.lock_path.open("r+")
    except FileNotFoundError, NotADirectoryError:
        return False
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            return True
        raise
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        handle.close()


# ─────────────────────────────────────────────────────────────────────────────
# Stale state
#
# A supervisor killed with SIGKILL leaves state.json behind and, possibly,
# children. The next command reaps both rather than reporting a stack that is
# not there.
# ─────────────────────────────────────────────────────────────────────────────


def reap_stale(instance: Instance, *, announce: bool = True) -> None:
    state = instance.read_state()
    if state is None:
        return
    if announce:
        note(f"instance '{instance.name}' has stale runtime state — cleaning it up")

    for name, entry in (state.get("services") or {}).items():
        pid = entry.get("pid")
        if entry.get("containerised") or pid is None or not process_alive(pid):
            continue
        note(f"killing orphaned {name} (pid {pid})")
        with suppress(ProcessLookupError):
            signal_group(os.getpgid(pid), signal.SIGKILL)

    if (state.get("with_cpa") or state.get("caddy")) and compose_command():
        arguments = ["down"] + (["--volumes"] if state.get("mode") == "ephemeral" else [])
        _ = subprocess.run(
            compose_argv(state.get("compose_project", instance.compose_project), *arguments),
            cwd=REPO,
            capture_output=True,
            text=True,
            check=False,
        )

    instance.state_path.unlink(missing_ok=True)
