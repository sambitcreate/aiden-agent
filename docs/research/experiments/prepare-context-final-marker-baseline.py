"""Reconstruct equally corrected comparison arms for final optimization checks.
Run: python3 docs/research/experiments/prepare-context-final-marker-baseline.py
Preserves old baselines/receipts; applies the same multipart recovery fix to each.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
subprocess.run(["python3", str(HERE / "prepare-context-active-prototype.py")], check=True, stdout=subprocess.DEVNULL)
STAGES = [('generation-context-before-scaling.ts', 'generation-context-before-scaling-final-marker.ts', '629adad876fd24c73c1c5a01635643f7d11fc1e97fbb197c8cc608f999b64910'), ('generation-context-before-active.ts', 'generation-context-before-active-final-marker.ts', 'cf1f93c31c978de927265bc613bd082da75688b4781206b6e268f8ff38c7dc5d'), ('generation-context-active-prototype.ts', 'generation-context-active-prototype-final-marker.ts', '839a4346a4269635185219fb4f3f04e7d77e85510e88a4fd6cc6349769fd2acc')]
patch = HERE / "context-compaction-multipart-recovery.patch"
records = []
for source_name, output_name, expected in STAGES:
    source = ROOT / "tmp/research" / source_name
    with tempfile.TemporaryDirectory(prefix="aiden-final-marker-") as directory:
        path = Path(directory) / "generation-context.ts"
        path.write_bytes(source.read_bytes())
        subprocess.run(["git", "apply", "--no-index", "--check", str(patch)], cwd=directory, check=True)
        subprocess.run(["git", "apply", "--no-index", str(patch)], cwd=directory, check=True)
        data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise SystemExit(f"Patched source mismatch: {actual}; expected {expected}")
    output = ROOT / "tmp/research" / output_name
    if output.exists():
        if output.read_bytes() != data:
            raise SystemExit(f"Refusing to replace different existing file: {output}")
    else:
        with output.open("xb") as stream:
            stream.write(data)
    records.append(dict(source=str(source.relative_to(ROOT)), sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(), output=str(output.relative_to(ROOT)), outputSha256=actual))
print(json.dumps(dict(evidenceKind="final-multipart-recovery-baseline-provenance", prerequisite="prepare-context-active-prototype.py", patch=str(patch.relative_to(ROOT)), patchSha256=hashlib.sha256(patch.read_bytes()).hexdigest(), stages=records), indent=2))
