#!/usr/bin/env bash
set -euo pipefail
uv sync --project scripts --frozen
uv run --project scripts --frozen ruff check --config scripts/ruff.toml scripts scripts/devsuite .github/scripts/check-python.py
uv run --project scripts --frozen ruff format --check --config scripts/ruff.toml scripts scripts/devsuite .github/scripts/check-python.py
uv run --project scripts --frozen python .github/scripts/check-python.py
uv run --project scripts --frozen python -m compileall -q scripts/lib/devsuite
