"""Recreate the immutable pruning baseline from a pinned local Git object.
Run from the repository root: python3 docs/research/experiments/prepare-context-compaction-baseline.py
No network, dependencies, application files, or existing different output is modified.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

COMMIT = "203a8f2082aaa60c3d22bc8b464a7f29541606dd"
SOURCE_PATH = "main/services/generation-context.ts"
SOURCE_SHA256 = "fa3bca66db2eba2c72f99528f35bc5ffc22ee9c109ebcccebdc4d22b6825999c"
PATCHED_SHA256 = "c9b2ad3e0c6b801150d94655c8d16564f6f427de2d728a8dec5fac82ff4f7413"
OUTPUT_SHA256 = "ffb82edac6abc49c6bbd32a4a3b310c1e760a57c7754f93654f386c440645ad5"
ROOT = Path(__file__).resolve().parents[3]
PATCH = Path(__file__).resolve().with_name("context-compaction-recovery-marker.patch")
OUTPUT = ROOT / "tmp/research/generation-context-before-scaling.ts"


def checked(data, expected, label):
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise SystemExit(f"{label} SHA-256 mismatch: {actual}; expected {expected}")
    return data


try:
    source = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE_PATH}"], cwd=ROOT, stderr=subprocess.PIPE)
except subprocess.CalledProcessError as error:
    raise SystemExit(f"Pinned local commit {COMMIT} is unavailable; provide that Git object before running this offline preparation.") from error
checked(source, SOURCE_SHA256, "Pinned source")
with tempfile.TemporaryDirectory(prefix="aiden-compaction-baseline-") as directory:
    path = Path(directory) / "generation-context.ts"
    path.write_bytes(source)
    # Apply only the checked-in recovery-marker change, never the pruning optimization.
    subprocess.run(["git", "apply", "--no-index", "--check", str(PATCH)], cwd=directory, check=True)
    subprocess.run(["git", "apply", "--no-index", str(PATCH)], cwd=directory, check=True)
    patched = checked(path.read_bytes(), PATCHED_SHA256, "Recovery-patched source")
old_import = b'from "./pi-legacy-harness.js"'
new_import = b'from "../../main/services/pi-legacy-harness.js"'
if patched.count(old_import) != 1:
    raise SystemExit("Expected exactly one relative Pi legacy import for relocation.")
output = checked(patched.replace(old_import, new_import), OUTPUT_SHA256, "Relocated baseline")
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
if OUTPUT.exists():
    checked(OUTPUT.read_bytes(), OUTPUT_SHA256, "Existing baseline (refusing to replace different content)")
else:
    # Exclusive creation avoids replacing a file written concurrently.
    with OUTPUT.open("xb") as stream:
        stream.write(output)
print(json.dumps(dict(baselineCommit=COMMIT, source=SOURCE_PATH, sourceSha256=SOURCE_SHA256,
    patch=str(PATCH.relative_to(ROOT)), patchSha256=hashlib.sha256(PATCH.read_bytes()).hexdigest(),
    patchedSourceSha256=PATCHED_SHA256, output=str(OUTPUT.relative_to(ROOT)), outputSha256=OUTPUT_SHA256), indent=2))
