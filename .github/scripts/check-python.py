"""Keep the documented Python scope strict while excluding prose from tool input."""

import json
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
config_path = root / "scripts/lib/basedpyrightconfig.json"
config = json.loads(config_path.read_text())
assert set(config) == {"//", "pythonVersion", "typeCheckingMode", "include"}
assert config["pythonVersion"] == "3.14"
assert config["typeCheckingMode"] == "recommended"
assert config["include"] == ["devsuite"]
# Basedpyright 1.40 rejects the prose-only // property. Preserve the authoritative
# file and its import root; pass only the three supported settings to the tool.
with tempfile.NamedTemporaryFile(
    mode="w", suffix=".json", prefix=".ci-pyright-", dir=config_path.parent
) as clean:
    json.dump({key: value for key, value in config.items() if key != "//"}, clean)
    clean.flush()
    subprocess.run(["basedpyright", "--warnings", "--project", clean.name], cwd=root, check=True)
