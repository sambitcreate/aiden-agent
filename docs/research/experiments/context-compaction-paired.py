"""Sequential before/after samples using the immutable pre-optimization module.
Prepare the reproducible pinned baseline first:
  python3 docs/research/experiments/prepare-context-compaction-baseline.py
Run with other build/test work held:
  python3 docs/research/experiments/context-compaction-paired.py > docs/research/experiments/context-compaction-paired-results.json
Every child has a 30 second timeout. No provider or application session is opened.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

baseline = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "tmp/research/generation-context-before-scaling.ts")
script = "docs/research/experiments/context-compaction-scaling.ts"
cells = [dict(historicalPairs=n, textChars=64, contextWindow=16000, usage="zero") for n in [5000, 10000, 20000]]
cells.append(dict(historicalPairs=20000, textChars=512, contextWindow=64000, usage="matching-anchor"))
rows = []
for cell in cells:
    for repetition, phases in enumerate([("baseline", "candidate"), ("candidate", "baseline")]):
        pair = []
        for phase in phases:
            command = ["node", "--import", "tsx", script, "--case", json.dumps(cell)]
            if phase == "baseline":
                command.append(str(baseline))
            start = time.monotonic()
            try:
                child = subprocess.run(command, text=True, capture_output=True, timeout=30)
                row = json.loads(child.stdout) if child.returncode == 0 else dict(**cell, status="failed", error=child.stderr[-2000:])
            except subprocess.TimeoutExpired:
                row = dict(**cell, status="timeout")
            row.update(phase=phase, repetition=repetition, processWallMs=(time.monotonic()-start)*1000)
            rows.append(row)
            pair.append(row)
            print(json.dumps({k: row.get(k) for k in ["historicalPairs", "textChars", "contextWindow", "usage", "phase", "repetition", "status", "durationMs"]}), file=sys.stderr, flush=True)
        if all(row["status"] == "completed" for row in pair):
            assert pair[0]["inputSha256"] == pair[1]["inputSha256"]
            assert pair[0]["outputSha256"] == pair[1]["outputSha256"]
print(json.dumps(dict(evidenceKind="sequential-paired-synthetic-performance", generatedAt=datetime.now(timezone.utc).isoformat(),
    baselineModuleSha256=hashlib.sha256(baseline.read_bytes()).hexdigest(),
    candidateSourceSha256=hashlib.sha256(pathlib.Path("main/services/generation-context.ts").read_bytes()).hexdigest(),
    processTimeoutMs=30000, cells=len(cells), repetitions=2,
    limitations=["Other coordinated agents were asked to hold heavy builds/tests; unrelated host load is not controlled.",
        "Two paired repetitions with reversed order, not a statistically powered performance study.",
        "Transform duration excludes startup/data generation; peak RSS includes the whole child, including both modules in baseline mode.",
        "No live model or UI responsiveness measurement; output hashes must match within every completed pair."], rows=rows), indent=2))
