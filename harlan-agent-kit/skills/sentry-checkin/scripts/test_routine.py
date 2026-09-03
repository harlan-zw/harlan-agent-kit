#!/usr/bin/env python3

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent

FAKE_PYTHON3 = """#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -n "$out" ]; then printf '{}' > "$out"; fi
exit 0
"""


class RoutineSequenceTest(unittest.TestCase):
    def routine_sequence(self):
        lines = (SKILL_DIR / "SKILL.md").read_text().splitlines()
        marker = next(
            index for index, line in enumerate(lines) if "Routine command sequence" in line
        )
        opener = next(
            index
            for index in range(marker, len(lines))
            if lines[index].startswith("```bash")
        )
        closer = next(
            index for index in range(opener + 1, len(lines)) if lines[index].startswith("```")
        )
        return "\n".join(lines[opener + 1 : closer])

    def test_routine_sequence_runs_from_a_fresh_state_home(self):
        with tempfile.TemporaryDirectory() as directory:
            state_home = Path(directory) / "state"
            state_home.mkdir()
            bin_dir = Path(directory) / "bin"
            bin_dir.mkdir()
            stub = bin_dir / "python3"
            stub.write_text(FAKE_PYTHON3)
            stub.chmod(0o755)
            script = "set -e\n" + self.routine_sequence() + "\n"
            script += 'test -f "$RUN_DIR/PROJECT.digest.json"\n'
            result = subprocess.run(
                ["bash", "-c", script],
                capture_output=True,
                text=True,
                cwd=SKILL_DIR,
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "XDG_STATE_HOME": str(state_home),
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(
                any(state_home.joinpath("sentry-checkin").iterdir()),
                "the sequence must create runs under the state home",
            )


if __name__ == "__main__":
    unittest.main()
