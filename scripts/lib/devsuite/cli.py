"""
The command line: the parser, its help, and the dispatch `main` performs.

Every flag any subcommand defines is also given a default on the top-level
parser, so `Options` is one shape whichever subcommand ran.
"""

import argparse
from collections.abc import Sequence
from typing import cast

from devsuite.commands.inspection import command_list, command_logs, command_status
from devsuite.commands.instances import command_destroy, command_resume
from devsuite.commands.lifecycle import (
    command_kill,
    command_restart,
    command_start,
    command_stop,
)
from devsuite.layout import DEFAULT_INSTANCE
from devsuite.logview import DEFAULT_LEVEL, LEVELS
from devsuite.options import Options

DESCRIPTION = """\
Setun development suite — start, stop and watch the whole local stack.

  app       SvelteKit application       :5173   bun run dev
  sandbox   artifact origin             :5174   built, served by vite preview
  cpa       CLIProxyAPI gateway         :8317   container, opt-in (--with-cpa)
                                                Docker Desktop or Colima; either the
                                                `docker compose` plugin or standalone
                                                `docker-compose` will do
  caddy     proxy tier                  :8080   container, part of --production
  database  SQLite file, per instance   —       no process to run

--production replaces the two Vite ports with the deployment's own topology: the
adapter-bun build behind the repository's Caddyfile, on http://setun.localhost:8080
and http://sandbox.setun.localhost:8080, with build-sandbox/ served by Caddy's own
file_server. TLS is the only piece left out. --no-caddy opts back out.
"""

EPILOG = """\
modes
  --persistent NAME   named instance, data survives `stop`   (default: dev)
  --ephemeral         throwaway instance, destroyed on exit — including on
                      Ctrl-C and on crash

signing in            every start, resume and attach prints where to sign in for
                      the instance's own origin. That origin's root is the
                      *student* login and asks for an access code; the educator
                      entry point is /educator/login, panel at /educator.
                      A generated educator signs in as educator / educator, read
                      back from instance.json on every run. A password supplied
                      through the environment or .env is named, never echoed.

  --first-run         run with no operator account, so the first-run setup wizard
                      owns the instance: the two SETUN_EDUCATOR_SEED_* variables
                      are blanked for the child — overriding the environment and
                      .env, which is the one place the suite does — and the app
                      gates every path to /setup. The bootstrap token is lifted
                      onto the banner from SETUN_BOOTSTRAP_TOKEN_PATH, pointed at
                      the instance's run/ directory, so a --detach'd start shows
                      it too. It is valid 15 minutes and a restart mints another.

                      Needs a database that has never been through setup, because
                      that is where "setup started" and "setup completed" are
                      recorded; an instance that already has one is refused
                      rather than emptied. Remembered on the instance, so
                      `resume` comes back to an unfinished wizard rather than
                      seeding an account half-way through it.

log levels            silent < error < warn < info < debug < trace  (default: info)
  app, sandbox        Vite's own --logLevel for silent/error/warn/info; debug and
                      trace pin Vite at info and raise SETUN_LOG_LEVEL, which
                      gates the application's server logging and turns on
                      Drizzle query logging. trace also sets DEBUG=vite:*.
  cpa                 not reachable: CPA reads `debug:` from cpa/config.yaml,
                      an operator file the suite will not rewrite. Its lines are
                      filtered at the log view instead.
  the view            whatever a service still prints below the chosen level is
                      dropped on the way to the terminal. The per-service files
                      under .devsuite/instances/<name>/logs/ always keep it all.

state                 everything lives in .devsuite/ inside the repository:
                      instances/<name>/{data,logs,run,build,build-sandbox}. Each
                      instance builds into its own directories, so a second
                      stack never empties the output the first one is serving.
                      Nothing is written to $HOME or /tmp.

examples
  ./scripts/devsuite start                       # persistent 'dev', attached
  ./scripts/devsuite start --ephemeral -vv       # throwaway, trace logging
  ./scripts/devsuite start --with-cpa --detach   # full stack in the background
  ./scripts/devsuite start --production          # the deployment topology, Caddy included
  ./scripts/devsuite start --first-run \
      --persistent setup --port 6173 --sandbox-port 6174   # exercise the wizard
  ./scripts/devsuite logs app                    # follow one service
  ./scripts/devsuite resume demo                 # bring a saved instance back
  ./scripts/devsuite destroy demo --force        # remove it for good
"""


class Formatter(argparse.RawDescriptionHelpFormatter):
    def __init__(self, prog: str) -> None:
        super().__init__(prog, max_help_position=28, width=88)


def add_instance_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    _ = group.add_argument(
        "--persistent",
        metavar="NAME",
        help=f"named instance whose data survives stop (default: {DEFAULT_INSTANCE})",
    )
    _ = group.add_argument(
        "--ephemeral",
        action="store_true",
        help="throwaway instance, destroyed on exit",
    )
    _ = parser.add_argument(
        "--log-level",
        choices=LEVELS,
        default=None,
        help=f"verbosity propagated to every service (default: {DEFAULT_LEVEL})",
    )
    _ = parser.add_argument(
        "-v",
        dest="verbose",
        action="count",
        default=0,
        help="-v is --log-level debug, -vv is trace",
    )


def add_lifecycle_flags(parser: argparse.ArgumentParser) -> None:
    _ = parser.add_argument("--port", type=int, help="application port (default 5173)")
    _ = parser.add_argument("--sandbox-port", type=int, help="artifact origin port (default 5174)")
    _ = parser.add_argument("--cpa-port", type=int, help="gateway port (default 8317)")
    _ = parser.add_argument(
        "--caddy-port", type=int, help="proxy port, both origins (default 8080)"
    )
    _ = parser.add_argument(
        "--with-cpa",
        action="store_true",
        help=(
            "also run the CLIProxyAPI container (needs a Docker engine and "
            "cpa/config.yaml); pass it on each run, it is not remembered"
        ),
    )
    _ = parser.add_argument(
        "--production",
        action="store_true",
        help=(
            "run the whole stack the way a deployment does: `bun run build` and the "
            "production server (bun ./server.js) instead of the Vite dev server, behind the "
            "deployment's own Caddy on http://setun.localhost:8080 and "
            "http://sandbox.setun.localhost:8080. Slower to start and no hot reload, "
            "and the only way to reproduce behaviour that differs between a dev "
            "server and a build. The artifact sandbox is always built, with or "
            "without this flag"
        ),
    )
    _ = parser.add_argument(
        "--no-caddy",
        action="store_true",
        help=(
            "with --production, leave Caddy out and serve the two origins from the "
            "app and a Vite preview on their own ports, as without --production. For "
            "a machine with no Docker engine; the proxy hop, the static server and "
            "the response headers are then not a deployment's"
        ),
    )
    _ = parser.add_argument(
        "--first-run",
        action="store_true",
        help=(
            "start with no operator account so the first-run setup wizard owns the "
            "instance; needs a database that has never been set up, and is remembered "
            "in instance.json rather than passed on every run"
        ),
    )
    _ = parser.add_argument(
        "-d", "--detach", action="store_true", help="run the supervisor in the background"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="devsuite",
        description=DESCRIPTION,
        epilog=EPILOG,
        formatter_class=Formatter,
    )
    parser.set_defaults(
        service=None,
        tail=50,
        force=False,
        detach=False,
        with_cpa=False,
        production=False,
        no_caddy=False,
        first_run=False,
        port=None,
        sandbox_port=None,
        cpa_port=None,
        caddy_port=None,
        persistent=None,
        ephemeral=False,
        verbose=0,
        log_level=None,
    )
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    start = commands.add_parser(
        "start", help="bring the stack up and attach to the log view", formatter_class=Formatter
    )
    add_instance_flags(start)
    add_lifecycle_flags(start)
    _ = start.add_argument("--tail", type=int, default=50, help=argparse.SUPPRESS)
    start.set_defaults(run=command_start)

    stop = commands.add_parser(
        "stop", help="graceful shutdown, state preserved", formatter_class=Formatter
    )
    add_instance_flags(stop)
    stop.set_defaults(run=command_stop)

    killer = commands.add_parser(
        "kill", help="force-terminate everything, no cleanup wait", formatter_class=Formatter
    )
    add_instance_flags(killer)
    _ = killer.add_argument("-f", "--force", action="store_true", help="skip the confirmation")
    killer.set_defaults(run=command_kill)

    restart = commands.add_parser("restart", help="stop, then start", formatter_class=Formatter)
    add_instance_flags(restart)
    add_lifecycle_flags(restart)
    _ = restart.add_argument("--tail", type=int, default=50, help=argparse.SUPPRESS)
    restart.set_defaults(run=command_restart)

    status = commands.add_parser(
        "status", help="what is running, on which ports, healthy or not", formatter_class=Formatter
    )
    add_instance_flags(status)
    status.set_defaults(run=command_status)

    logs = commands.add_parser(
        "logs", help="attach to the log view, all services or one", formatter_class=Formatter
    )
    add_instance_flags(logs)
    _ = logs.add_argument("service", nargs="?", help="app, sandbox or cpa; omit for all")
    _ = logs.add_argument(
        "--tail", type=int, default=50, help="lines of history per service to replay first"
    )
    logs.set_defaults(run=command_logs)

    listing = commands.add_parser("list", help="saved instances", formatter_class=Formatter)
    listing.set_defaults(run=command_list)

    resume = commands.add_parser(
        "resume", help="bring a stopped instance back with its data", formatter_class=Formatter
    )
    add_instance_flags(resume)
    add_lifecycle_flags(resume)
    _ = resume.add_argument("name", help="instance to resume")
    _ = resume.add_argument("--tail", type=int, default=50, help=argparse.SUPPRESS)
    resume.set_defaults(run=command_resume)

    destroy = commands.add_parser(
        "destroy", help="remove an instance permanently", formatter_class=Formatter
    )
    _ = destroy.add_argument("name", help="instance to delete")
    _ = destroy.add_argument("-f", "--force", action="store_true", help="skip the confirmation")
    destroy.set_defaults(run=command_destroy)

    return parser


def resolve_level(options: Options) -> str:
    if options.log_level:
        return options.log_level
    if options.verbose >= 2:
        return "trace"
    if options.verbose == 1:
        return "debug"
    return DEFAULT_LEVEL


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    # argparse hands back an attribute bag; `Options` is the shape it has by
    # the time `build_parser` has given every flag a default.
    options = cast("Options", cast("object", parser.parse_args(argv)))

    if not options.command:
        parser.print_help()
        return 0

    options.log_level = resolve_level(options)

    try:
        return options.run(options)
    except KeyboardInterrupt:
        print()
        return 130
