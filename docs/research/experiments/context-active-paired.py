"""Sequential before/after samples using the immutable pre-optimization module.
Prepare the reproducible pinned baseline first:
  python3 docs/research/experiments/prepare-context-active-prototype.py
Run with other build/test work held:
  python3 docs/research/experiments/context-active-paired.py > docs/research/experiments/context-active-paired-results.json
Every child has a 15 second timeout. No provider or application session is opened.
"""
import hashlib
import json
import pathlib
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone

baseline = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "tmp/research/generation-context-before-active.ts")
script = "docs/research/experiments/context-active-tool-scaling.ts"
candidate = pathlib.Path("tmp/research/generation-context-active-prototype.ts")
cells = [dict(batches=n, resultChars=chars) for n in [1000, 5000] for chars in [128, 4096]]
rows = []
for cell in cells:
    for repetition, phases in enumerate([("baseline", "candidate"), ("candidate", "baseline")]):
        pair = []
        for phase in phases:
            command = ["node", "--import", "tsx", script, "--case", json.dumps(cell)]
            command.append(str(baseline if phase == "baseline" else candidate))
            start = time.monotonic()
            try:
                child = subprocess.run(command, text=True, capture_output=True, timeout=15)
                row = json.loads(child.stdout) if child.returncode == 0 else dict(**cell, status="failed", error=child.stderr[-2000:])
            except subprocess.TimeoutExpired:
                row = dict(**cell, status="timeout")
            row.update(phase=phase, repetition=repetition, processWallMs=(time.monotonic()-start)*1000)
            rows.append(row)
            pair.append(row)
            print(json.dumps({k: row.get(k) for k in ["batches", "resultChars", "phase", "repetition", "status", "durationMs"]}), file=sys.stderr, flush=True)
        if all(row["status"] == "completed" for row in pair):
            assert pair[0]["outputSha256"] == pair[1]["outputSha256"]
print(json.dumps(dict(evidenceKind="sequential-paired-synthetic-performance", generatedAt=datetime.now(timezone.utc).isoformat(),
    node=subprocess.check_output(["node", "--version"], text=True).strip(), platform=platform.system(), arch=platform.machine(),
    baselineModuleSha256=hashlib.sha256(baseline.read_bytes()).hexdigest(),
    candidateSourceSha256=hashlib.sha256(candidate.read_bytes()).hexdigest(),
    processTimeoutMs=15000, cells=len(cells), repetitions=2,
    limitations=["Other coordinated agents were asked to hold heavy builds/tests; unrelated host load is not controlled.",
        "Two paired repetitions with reversed order, not a statistically powered performance study.",
        "Transform duration excludes startup/data generation; peak RSS includes the whole child, including fixture serialization.",
        "No live model or UI responsiveness measurement; output hashes must match within every completed pair."], rows=rows), indent=2))
