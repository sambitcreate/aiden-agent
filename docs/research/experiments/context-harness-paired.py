"""Real managed-harness paired probes, offline and bounded.
Preparation: python3 docs/research/experiments/prepare-context-compaction-baseline.py
Boundary controls: python3 docs/research/experiments/context-harness-paired.py --boundary > docs/research/experiments/context-harness-boundary-results.json
Timing (coordinate quiet host): python3 docs/research/experiments/context-harness-paired.py --timing > docs/research/experiments/context-harness-paired-results.json
Each child: 30-second wall cap, 512MiB V8 old-space cap (not whole-process RSS cap).
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

boundary = "--boundary" in sys.argv
script = "docs/research/experiments/context-harness-integration.ts"
modules = dict(baseline="tmp/research/generation-context-before-scaling.ts", candidate="main/services/generation-context.ts")
if boundary:
    cells = [dict(kind="active", batches=batches, resultChars=512,
        staticChars=44000 if batches == 0 else 48, userChars=4000 if batches == 0 else 24,
        toolRoundtrip=False, persistSystem=persist) for persist in [False, True] for batches in [0, 100]]
else:
    cells = [dict(kind="active", batches=1000, resultChars=128), dict(kind="historical", batches=1000, resultChars=128),
        dict(kind="active", batches=1000, resultChars=128, automaticSummary=False),
        dict(kind="active", batches=5000, resultChars=128, automaticSummary=False)]
rows = []
errors = []
for cell in cells:
    phases = [("baseline", "candidate")] if boundary else [("baseline", "candidate"), ("candidate", "baseline")]
    for repetition, order in enumerate(phases):
        pair = []
        for phase in order:
            command = ["node", "--max-old-space-size=512", "--import", "tsx", script, "--case", json.dumps(cell), modules[phase]]
            start = time.monotonic()
            try:
                child = subprocess.run(command, text=True, capture_output=True, timeout=30)
                row = json.loads(child.stdout) if child.returncode == 0 else dict(**cell, status="failed", error=child.stderr[-3000:])
            except subprocess.TimeoutExpired:
                row = dict(**cell, status="timeout")
            row.update(phase=phase, repetition=repetition, processWallMs=(time.monotonic() - start) * 1000)
            rows.append(row); pair.append(row)
            print(json.dumps({k: row.get(k) for k in ["kind", "batches", "automaticSummary", "persistSystem", "phase", "repetition", "status", "harnessMs", "transformMs", "summaryCalls"]}), file=sys.stderr, flush=True)
        if all(row["status"] == "completed" for row in pair):
            for key in ["seedHash", "preservedSeedHash", "journalPayloadHash", "requestHashes", "summaryRequests", "summaryEvidence", "transformHashes", "outcomeHash", "providerCalls", "toolCalls", "summaryCalls", "lifecycle", "projections"]:
                if pair[0][key] != pair[1][key]: errors.append(dict(cell=cell, repetition=repetition, mismatch=key))
        else:
            errors.append(dict(cell=cell, repetition=repetition, failure="incomplete pair"))
print(json.dumps(dict(evidenceKind="real-managed-harness-boundary-controls" if boundary else "real-managed-harness-paired-synthetic-performance",
    generatedAt=datetime.now(timezone.utc).isoformat(), modules={phase: dict(path=path, sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest()) for phase, path in modules.items()},
    coordinatorSha256=hashlib.sha256(Path("main/services/pi-compaction-core.ts").read_bytes()).hexdigest(),
    harnessSha256=hashlib.sha256(Path("main/services/pi-agent-runtime-harness.ts").read_bytes()).hexdigest(),
    processTimeoutMs=30000, v8OldSpaceLimitMiB=512, cells=len(cells), repetitions=1 if boundary else 2, errors=errors,
    limitations=["Faux providers and one in-memory echo tool; no inference, network, filesystem tool effects, or task-quality measurement.",
        "Only injected GenerationContextTransform module differs between paired arms; both use current production runtime/coordinator/session code.",
        "Default summary lifecycle remains enabled unless automaticSummary=false explicitly selects the supported setting in both arms.",
        "Provider/summary/outcome/journal hashes omit timestamp fields; tool IDs, content, order, usage and counts remain checked.",
        "runManaged timing includes seeding/preflight/clone/conversion/transforms/fake-provider/tool/flush, excludes fixture/harness construction and post-run validation.",
        "transform timing covers only awaited injected transforms; unrelated CPU load not controlled, two reversed pairs not a statistical study.",
        "Process RSS includes V8 young space, native memory, fixtures and validation;512MiB is only the V8 old-space limit."], rows=rows), indent=2))
if errors: raise SystemExit(1)
