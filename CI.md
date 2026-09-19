# CI and dependency maintenance

Every pull request and default-branch push runs Svelte/TypeScript checking,
read-only Biome checking, Bun unit tests, both nonempty Vitest projects, full
Playwright E2E, Python quality, and prek hygiene. `ci / required` checks their
exact job list and fails on every result other than success. It also verifies
the exact PR head on repair dispatches. The separately required `policy / ci /
policy` check validates the PR title, commit sign-offs, review state and hold
labels from fresh read-only API evidence. Repository protection must require
both checks from GitHub Actions and up-to-date branches before dependency
automerging is enabled.

The shared Bun/Python workflows and gate come from immutable full version tags in
`edbfi/automation`. Other actions also use full version tags. Renovate proposes
updates; source code and lockfiles must stay unchanged during validation. Jobs
use read-only permissions, bounded timeouts, and cancel obsolete runs. Browser
failure reports are retained for seven days. Dependency caches are keyed by the
runtime, runner architecture, and lockfile; browser binaries match the lockfile.

## Local checks

Use Bun 1.4.2 and `bun install --frozen-lockfile`. Install Chromium with
`bunx playwright install chromium`, then run the commands in README's quality gates.
Run browser/component suites sequentially locally because both generate SvelteKit
and Paraglide outputs. CI jobs have separate checkouts. `prek install` aligns local
hygiene and Python checks with CI. CI skips hooks already covered by dedicated jobs.
Python tools are locked with uv in `scripts/uv.lock`; `bun run check:python` installs
them reproducibly and enforces zero type errors and warnings without broad overrides.

Playwright retains one worker and four isolated test servers, including a loopback
provider stub and a cold setup instance. It exercises the real production server,
app build, and all three sandbox build targets. The application and artifact/sandbox
origins remain separate. No real model credentials or provider access are needed.
Bun, Vitest client/server, and Playwright retain disjoint filename conventions.
The authentication test verifies real Argon2 work and minimum response duration
without comparing two noisy absolute wall-clock durations.

## Renovate

The shared default and mixed-ecosystem presets discover Bun, Python/uv, actions,
prek hooks and Biome's schema/package versions. The v3 presets keep native
Renovate PR merging disabled during migration. The legacy Actions merger and
maintainer merge command are retired. After a protected real canary proves
Renovate operation, opt-in can be reviewed separately; all application and
compatibility checks remain mandatory.

Biome repair uses a read-only compute job and a separate publisher, limited to
approved source/config paths. It runs safe formatting and the official migration,
then explicitly dispatches full CI for the exact repaired commit. Package/lockfile
and workflow writes are forbidden. Repairs exceeding 200 changed files require
manual handling; this matters for broad formatting changes in this application.
Repository Actions settings must allow the intended automation and workflow runs.

## Limits

Tests use local provider fixtures, not live paid models. This does not validate
production hosting, real provider behavior, or an actual external artifact origin's
network configuration. Python has lint/types/syntax coverage but no dedicated unit
suite for its development orchestration. Pullfrog remains an explicitly invoked
agent workflow and is not a required check. Existing application tests and their
security assertions remain required independently of dependency automerging.

Repair CI recovery reads `.github/repair-policy.json`. Recovery remains disabled,
preserving the previous policy; the configured Biome App repair workflow remains
enabled and uses the released v3 action. A repair must receive complete current-head
CI and policy checks. If a workflow-token publication suppresses PR events, the
missing policy check blocks merging until a supported App/Renovate update triggers
full validation. Metadata and review events refresh policy; GitHub review rules
provide the independent server-side review guarantee during event propagation.
