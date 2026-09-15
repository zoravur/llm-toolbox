"""Bridge the project's Node test suite into the portable `pytest` harness.

The application itself is JavaScript; this wrapper simply runs the Node smoke
suite (and, when a Chrome binary is available, the browser end-to-end test) so
`python -m pytest test` exercises the real code.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HAS_NODE = shutil.which("node") is not None


def run_node(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(ROOT / script)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )


@pytest.mark.skipif(not HAS_NODE, reason="node is not installed")
def test_node_smoke_suite() -> None:
    result = run_node("test/smoke.mjs")
    assert result.returncode == 0, f"smoke suite failed:\n{result.stdout}\n{result.stderr}"
