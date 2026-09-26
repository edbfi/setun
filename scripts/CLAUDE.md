# CLAUDE.md — scripts

`scripts/devsuite` is the entry point. The Python package lives in `scripts/lib/devsuite/`: 3.14,
stdlib only (`pyproject.toml` has no runtime dependencies), and run from the checkout without being
installed. `scripts/lib` is the import root, so imports are absolute (`from devsuite.layout import
…`). `recover-educator.ts` is Bun/TypeScript and follows the root rules.

- Run `bun run check:python` from the repository root. It runs Ruff lint and format checks
  (`scripts/ruff.toml`), basedpyright in `recommended` mode, and `compileall`, all pinned by
  `scripts/uv.lock`. It must end with 0 errors and 0 warnings.
- Leave `scripts/lib/basedpyrightconfig.json` as it is. `scripts/check-python.py` asserts
  its exact keys and fails on any change. Fix the diagnostic instead. If an untyped third-party call
  really can't be fixed, suppress that one line with `# pyright: ignore[ruleName]` and a
  justification, never with `# type: ignore`.
- The file is strict JSON, and prek's `check-json` hook rejects comments. Its prose goes in the
  `"//"` array.
- Tool versions are dev-group pins in `pyproject.toml`. Change them with `uv` so `uv.lock` stays in
  sync, because every check runs `--frozen`.

## Reference

- `.agents/rules/python-3_14-core.md`: Python 3.14 / uv / Ruff / basedpyright conventions. Read
  before writing or restructuring code in `scripts/lib/devsuite/`.
