"""
The environment the children are spawned with.

Vite's own `loadEnv` lets a real process variable win over the same key in
`.env`, so everything the suite injects below overrides the repository's
dotfile — which is what makes per-instance data directories hold.
"""

import os
import re
import secrets
from collections.abc import Callable
from pathlib import Path

from devsuite.instance import Instance, InstanceConfig, RunState
from devsuite.layout import CADDY_APP_HOST, CADDY_SANDBOX_HOST, REPO

DOTENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")

# The four values §6.2 requires and gives no default for. Absent from both the
# environment and `.env`, the suite mints a development value per instance and
# keeps it in the instance's own (gitignored) config — never in `.env`, which
# belongs to the operator.
GENERATED_SECRETS: dict[str, Callable[[], str]] = {
    "SETUN_STUDENT_CODE_PEPPER": lambda: secrets.token_hex(32),
    "SETUN_EDUCATOR_SEED_USERNAME": lambda: "educator",
    "SETUN_EDUCATOR_SEED_PASSWORD": lambda: "educator",
    "SETUN_CPA_LISTENER_KEY": lambda: secrets.token_hex(24),
}

# The two of those four the first-run wizard collects for itself. Under
# `--first-run` they are set to the empty string rather than left out: a blank
# counts as absent (`optionalValue`, src/lib/server/config.ts), and absent seed
# credentials are the whole of what hands an installation to the wizard rather
# than adopting it as already set up (PRD §6.2). Set rather than omitted,
# because an omitted key would simply inherit whatever the parent environment
# or `.env` holds — which is the case the flag exists to override.
EDUCATOR_SEED_KEYS: tuple[str, ...] = (
    "SETUN_EDUCATOR_SEED_USERNAME",
    "SETUN_EDUCATOR_SEED_PASSWORD",
)


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        match = DOTENV_LINE.match(raw)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def resolve_secrets(
    config: InstanceConfig, *, first_run: bool = False
) -> tuple[dict[str, str], list[str]]:
    """
    Fill the four required variables, remembering anything generated.

    Stored on the instance rather than regenerated per start: a persistent
    instance that changed its pepper between `stop` and `resume` would
    invalidate every access code it had issued (PRD §7).

    `first_run` blanks the two educator seed variables and neither mints nor
    stores them, so the instance has no operator account and boot gates every
    path to the wizard. This is the one place the ordinary precedence — a real
    environment variable or `.env` beats anything the suite holds — is
    deliberately inverted, because a `.env` the operator filled in would
    otherwise silently defeat the flag. `supplied_seed_keys` names what was
    overridden so the caller can say so rather than leave it to be discovered.
    """
    dotenv = read_dotenv(REPO / ".env")
    stored = dict(config.get("secrets", {}))
    resolved: dict[str, str] = {}
    minted: list[str] = []

    for key, mint in GENERATED_SECRETS.items():
        if first_run and key in EDUCATOR_SEED_KEYS:
            resolved[key] = ""
            continue
        supplied = os.environ.get(key) or dotenv.get(key)
        if supplied:
            resolved[key] = supplied
            continue
        if key not in stored:
            stored[key] = mint()
            minted.append(key)
        resolved[key] = stored[key]

    config["secrets"] = stored
    return resolved, minted


def supplied_seed_keys() -> list[str]:
    """Educator seed variables a real environment or `.env` would otherwise set."""
    dotenv = read_dotenv(REPO / ".env")
    return [key for key in EDUCATOR_SEED_KEYS if os.environ.get(key) or dotenv.get(key)]


def educator_credentials(
    config: InstanceConfig, state: RunState | None
) -> tuple[str, str | None] | None:
    """
    The educator this instance signs in as, and its password where the suite
    knows it. None where the instance has no seeded account at all.

    A *running* stack is answered for out of its own `state.json`. The children
    were spawned with a fixed environment and the application seeds the account
    from it on every boot, so the environment and `.env` as they read *now* are
    not evidence of anything: an operator who edited either after the stack came
    up would otherwise be shown a username the running application never seeded,
    or — where the line was removed outright — no seeded identity at all, since
    a value that came from outside is never kept in `instance.json`.

    Where no run state exists there is no stack to contradict, and the same
    precedence `resolve_secrets` uses answers instead: a real environment
    variable or `.env` beats what the instance holds. That is the case on the
    banner a foreground `start` prints, which runs before the supervisor has
    written any state, and on every instance that is currently stopped.

    A password the *operator* supplied — a real environment variable, or a line
    in `.env` — is named rather than echoed. Only the development value the
    suite minted itself is printed, and that one is already in a gitignored
    file the banner names two lines further up.
    """
    if config.get("first_run"):
        return None

    stored = config.get("secrets", {})
    username_key, password_key = EDUCATOR_SEED_KEYS

    if state:
        running = state.get("educator_username")
        if running:
            minted = state.get("educator_password_minted", False)
            return running, (stored.get(password_key) if minted else None)

    dotenv = read_dotenv(REPO / ".env")
    username = os.environ.get(username_key) or dotenv.get(username_key) or stored.get(username_key)
    if not username:
        return None

    supplied = os.environ.get(password_key) or dotenv.get(password_key)
    return username, (None if supplied else stored.get(password_key))


def origins(ports: dict[str, int], *, caddy: bool) -> tuple[str, str]:
    """
    The two origins a browser actually uses, application first.

    Behind Caddy they are the deployment's shape — two hostnames on one port,
    which is also what the Caddyfile's site addresses and its `frame-ancestors`
    read. Without it they are the two Vite servers on their own ports. Every
    caller wants the same answer, so none of them may build it by hand.
    """
    if caddy:
        return (
            f"http://{CADDY_APP_HOST}:{ports['caddy']}",
            f"http://{CADDY_SANDBOX_HOST}:{ports['caddy']}",
        )
    return f"http://localhost:{ports['app']}", f"http://localhost:{ports['sandbox']}"


def child_environment(
    instance: Instance,
    ports: dict[str, int],
    level: str,
    resolved_secrets: dict[str, str],
    bootstrap_token_path: Path | None = None,
    *,
    caddy: bool = False,
) -> dict[str, str]:
    app_origin, sandbox_origin = origins(ports, caddy=caddy)

    environment = dict(os.environ)
    environment.update(resolved_secrets)
    environment.update(
        {
            # Per-instance data. These three are the whole of an instance's
            # state, which is what makes ephemeral cleanup a directory removal.
            "SETUN_DATABASE_PATH": str(instance.database_path),
            "SETUN_STORAGE_PATH": str(instance.storage_path),
            "SETUN_BACKUP_PATH": str(instance.backup_path),
            # Per-instance build output. Read by vite.config.ts (the adapter's
            # `out`), by server.js when it loads that build, and by
            # sandbox/vite.config.ts as its `outDir` — so a second instance's
            # build never empties the directory the first one is serving from.
            # Unset outside the suite, where both fall back to the repository's
            # own build/ and build-sandbox/ exactly as before.
            "SETUN_BUILD_DIR": str(instance.build_path),
            "SETUN_SANDBOX_BUILD_DIR": str(instance.sandbox_build_path),
            # Both origins, and ORIGIN, which server.js supplies to SvelteKit's
            # CSRF check (plain HTTP needs it).
            "SETUN_APP_ORIGIN": app_origin,
            "SETUN_SANDBOX_ORIGIN": sandbox_origin,
            "ORIGIN": app_origin,
            # server.js listens on PORT. Vite takes --port on
            # the command line and ignores this, so it is safe to set for both.
            "PORT": str(ports["app"]),
            "SETUN_SANDBOX_PORT": str(ports["sandbox"]),
            # The app runs on the host here, so it reaches CPA on a published
            # port rather than over Compose's internal network.
            "SETUN_CPA_BASE_URL": f"http://127.0.0.1:{ports['cpa']}",
            "SETUN_LOG_LEVEL": level,
            # Colour is decided by the suite for the whole view; a child that
            # coloured its own output would fight the level column.
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
        }
    )

    if caddy:
        environment.update(
            {
                # Read by the Caddyfile as its two site addresses, and by its CSP
                # as the sources it names. One variable serves both because a
                # site address with a scheme is also a valid CSP host-source.
                "SETUN_APP_HOSTNAME": app_origin,
                "SETUN_SANDBOX_HOSTNAME": sandbox_origin,
                # The application is a host process here, not a container on
                # Caddy's network, so `reverse_proxy` needs a route back out.
                "SETUN_APP_UPSTREAM": f"host.docker.internal:{ports['app']}",
                "SETUN_CADDY_PORT": str(ports["caddy"]),
                # Behind a proxy every request carries Caddy's socket address, so
                # the per-IP axis of the rate limiters would be one global bucket.
                # `reverse_proxy` appends exactly one hop, which is the depth.
                # docker-compose.yml sets the same pair for the same reason.
                "ADDRESS_HEADER": "x-forwarded-for",
                "XFF_DEPTH": "1",
            }
        )

    if bootstrap_token_path is not None:
        # The application always prints the first-run token to its own log, and
        # given a path writes it there too — mode 0600, removed the moment setup
        # completes. Pointing that at the instance's run/ directory is what lets
        # the suite read it back and put it on the banner, which is the only way
        # a `--detach`ed start ever shows it: the log the token is printed to is
        # a file nobody is watching.
        environment["SETUN_BOOTSTRAP_TOKEN_PATH"] = str(bootstrap_token_path)

    if level == "trace":
        # Vite has no level below `info`; its debug namespaces are what goes
        # further, and they are what `trace` means for a Vite process.
        environment["DEBUG"] = "vite:*"

    return environment
