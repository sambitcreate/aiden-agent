"""Recreate both active-path comparison modules without modifying production.
Run from repository root: python3 docs/research/experiments/prepare-context-active-prototype.py
Uses the pinned recovery baseline, then checked-in historical and active patches.
Both arms include the independent large-array repair and historical alias fallback.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
subprocess.run(["python3", str(HERE / "prepare-context-compaction-baseline.py")], check=True, stdout=subprocess.DEVNULL)
source = (ROOT / "tmp/research/generation-context-before-scaling.ts").read_bytes()
stages = [
    ("context-compaction-historical-pruning.patch", "generation-context-before-active.ts", "965a130046591bd565b59544f24534a0b0a753665758455f0b1553f379907acd"),
    ("context-compaction-active-prototype.patch", "generation-context-active-prototype.ts", "ccf64f0558606e754d385da114bdd8b69589160ea0f0d0d2d00c18cb8f136c8a"),
]
records = []
with tempfile.TemporaryDirectory(prefix="aiden-active-prototype-") as directory:
    path = Path(directory) / "generation-context.ts"
    path.write_bytes(source)
    for patch_name, output_name, expected in stages:
        patch = HERE / patch_name
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
        records.append(dict(patch=patch_name, patchSha256=hashlib.sha256(patch.read_bytes()).hexdigest(), output=str(output.relative_to(ROOT)), outputSha256=actual))
print(json.dumps(dict(evidenceKind="active-prototype-offline-provenance", baselinePreparation="prepare-context-compaction-baseline.py", stages=records), indent=2))
