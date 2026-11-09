"""Compatibility entry for the current packaged Electron startup smoke test."""
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


if __name__ == "__main__":
    node = shutil.which("node")
    if not node:
        sys.exit("Node.js is required for the Electron development smoke test.")
    sys.exit(subprocess.call([node, str(ROOT / "desktop/tests/electron-smoke.cjs")], cwd=ROOT / "desktop"))
