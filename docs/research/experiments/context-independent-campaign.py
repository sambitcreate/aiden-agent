"""Bounded sequential seeded policy campaign (no network).
Prepare the immutable baseline, then run from the repository root:
  python3 docs/research/experiments/context-independent-campaign.py
For the final multipart-marker correction applied equally to both arms:
  python3 docs/research/experiments/prepare-context-final-marker-baseline.py
  python3 docs/research/experiments/context-independent-campaign.py --final-marker
Creates incremental machine-readable results after every child. To pause after
this child, create tmp/research/independent-campaign.pause. Remove it to resume;
reruns skip completed seeds only when both source hashes still match.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import time
from datetime import datetime, timezone

arguments = argparse.ArgumentParser()
arguments.add_argument("--final-marker", action="store_true", help="Use equally corrected baseline and a distinct final-marker receipt")
args = arguments.parse_args()
ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "docs/research/experiments/context-independent-campaign.ts"
suffix = "-final-marker" if args.final_marker else ""
OUTPUT = ROOT / f"docs/research/experiments/context-independent-campaign{suffix}-results.json"
ARTIFACTS = ROOT / f"tmp/research/independent-campaign{suffix}"
BASELINE = ROOT / f"tmp/research/generation-context-before-scaling{suffix}.ts"
PAUSE = ROOT / "tmp/research/independent-campaign.pause"
SEEDS = [260920811 + 7919 * index for index in range(24)]
FIXTURES_PER_SEED = 120
source_hash = hashlib.sha256((ROOT / "main/services/generation-context.ts").read_bytes()).hexdigest()
baseline_hash = hashlib.sha256(BASELINE.read_bytes()).hexdigest()
generator_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
rows = []
if OUTPUT.exists():
    existing = json.loads(OUTPUT.read_text())
    if (existing["candidateSha256"], existing["baselineSha256"], existing["generatorSha256"]) != (source_hash, baseline_hash, generator_hash):
        raise SystemExit("Existing campaign has different sources; preserve it before starting a new campaign.")
    rows = existing["rows"]
started = time.monotonic()
status = "running"
def checkpoint():
    data = dict(evidenceKind="independent-seeded-exact-policy-differential", generatedAt=datetime.now(timezone.utc).isoformat(),
        status=status, comparisonVariant="equally-corrected-final-marker" if args.final_marker else "original-recovery-marker", baselinePath=str(BASELINE.relative_to(ROOT)), candidateSha256=source_hash, baselineSha256=baseline_hash, generatorSha256=generator_hash,
        childMemoryLimitMiB=512, childWallLimitSeconds=45, invocationWallLimitSeconds=1200,
        plannedSeeds=SEEDS, fixturesPerSeed=FIXTURES_PER_SEED, rows=rows,
        limitations=["Synthetic generated transcripts; image payloads are illustrative and never decoded.",
        "No network, paid-model quality, billing or timing comparison.",
        "Input aliases are preserved; failures retain unique objects and slot maps for reconstruction."])
    temp = OUTPUT.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    temp.replace(OUTPUT)
for seed in SEEDS:
    if any(row.get("initialSeed") == seed for row in rows):
        continue
    if PAUSE.exists():
        status = "paused"; break
    if time.monotonic() - started >= 1200:
        status = "wall-budget-reached"; break
    command = ["node", "--max-old-space-size=512", "--import", "tsx", str(SCRIPT), str(seed), str(FIXTURES_PER_SEED), str(ARTIFACTS), str(BASELINE)]
    try:
        child = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=45)
        if child.returncode:
            rows.append(dict(initialSeed=seed, status="counterexample" if child.returncode == 2 else "worker-failed", exitCode=child.returncode, stderr=child.stderr[-5000:]))
            status = rows[-1]["status"]; checkpoint(); break
        row = json.loads(child.stdout)
    except subprocess.TimeoutExpired:
        row = dict(initialSeed=seed, status="timeout")
        rows.append(row); status="timeout"; checkpoint(); break
    rows.append(row)
    checkpoint()
    print(json.dumps({key: row.get(key) for key in ["initialSeed", "status", "checks", "elapsedMs"]}), flush=True)
else:
    status = "passed"
checkpoint()
print(json.dumps(dict(status=status, completedSeeds=len(rows), checks=sum(row.get("checks", 0) for row in rows), output=str(OUTPUT.relative_to(ROOT)))), flush=True)
if status not in ["passed", "paused", "wall-budget-reached"]:
    raise SystemExit(1)
