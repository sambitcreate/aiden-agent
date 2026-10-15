"""Validate six synthetic task oracles against supplied positive/negative controls.
Run from any directory: python3 docs/research/experiments/task-quality-fixtures/validate.py
No model, dependency installation, network, production session or rollout is involved.
Only included, reviewed Python controls execute. -I is isolation from Python imports,
not a security sandbox for future untrusted model-generated code.
"""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
CASES = ["old_only_constraints", "superseded_instructions", "buried_failed_tests", "output_recovery", "resumed_plans", "comfortable_window_control"]
rows = []
observations = []
started = time.monotonic()
for name in CASES:
    case = ROOT / name
    task = json.loads((case / "task.json").read_text())
    for key in ["tool_observation_recipe", "retained_output_recipe"]:
        if key not in task:
            continue
        recipe = task[key]
        text = recipe["prefix_line"] * recipe["prefix_repetitions"] + recipe["decisive_text"] + recipe["suffix_line"] * recipe["suffix_repetitions"]
        decisive_offset = text.index(recipe["decisive_text"])
        assert text.count(recipe["decisive_text"]) == 1
        assert decisive_offset > 16_000 and len(text) - decisive_offset - len(recipe["decisive_text"]) > 16_000
        observations.append({"case": name, "kind": key, "utf8Bytes": len(text.encode()), "characters": len(text), "sha256": sha256(text.encode()).hexdigest(), "decisiveOffset": decisive_offset,
                             "decisiveAbsentFrom16000CharHeadAndTail": recipe["decisive_text"] not in text[:16000] + text[-16000:]})
    for control, expectation in task["candidate_controls"].items():
        candidate = case / ("workspace" if control == "starter" else f"controls/{control}")
        with tempfile.TemporaryDirectory(prefix="aiden-offline-task-oracle-") as temporary:
            workspace = Path(temporary) / "workspace"
            workspace.mkdir()
            shutil.copyfile(candidate / "solution.py", workspace / "solution.py")
            # Oracles/answers never enter the workspace. This host receipt is separate.
            command = [sys.executable, "-I", str(case / "oracle.py"), str(workspace)]
            if name == "resumed_plans":
                receipt = case / "workspace-initial-host-plan.json" if control == "starter" else candidate / "host-plan-receipt.json"
                command.append(str(receipt))
            begin = time.monotonic()
            completed = subprocess.run(command, cwd=workspace, capture_output=True, text=True, timeout=10)
            if expectation["expected"] == "pass":
                assert completed.returncode == 0, (name, control, completed.stderr)
                assert json.loads(completed.stdout) == {"case": name, "accepted": True}
                finding = "accepted"
            else:
                assert completed.returncode != 0 and "AssertionError" in completed.stderr, (name, control, "control must fail a behavioral assertion, not imports or setup", completed.stderr)
                if "required_failure" in expectation:
                    assert expectation["required_failure"] in completed.stderr, (name, control, "wrong failure mode", completed.stderr)
                finding = next(line.strip() for line in completed.stderr.splitlines() if line.startswith("AssertionError"))
            rows.append({"case": name, "control": control, "expected": expectation["expected"], "exitCode": completed.returncode, "result": finding,
                         "elapsedMs": round((time.monotonic() - begin) * 1000, 3), "candidateSha256": sha256((candidate / "solution.py").read_bytes()).hexdigest()})
files = {str(path.relative_to(ROOT)): sha256(path.read_bytes()).hexdigest() for path in sorted(ROOT.rglob("*")) if path.is_file() and path.name not in ["validation-results.json", "pilot-manifest.json"] and "__pycache__" not in path.parts}
manifest_path = ROOT / "pilot-manifest.json"
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text())
    assert manifest["frozen_files_sha256"] == files, "Frozen fixture changed: review and explicitly version the manifest before future pilot"
receipt = {"evidenceKind": "offline-synthetic-task-oracle-controls", "generatedAt": datetime.now(timezone.utc).isoformat(), "python": sys.version.split()[0],
           "status": "passed", "modelCalls": 0, "rows": rows, "expandedObservations": observations, "filesSha256": files,
           "elapsedMs": round((time.monotonic() - started) * 1000, 3),
           "limitations": ["Known-correct/negative implementations are authored fixtures, not model-generated repairs or an estimate of success rate.",
                           "Checks establish only explicit finite behavioral assertions; task-specific limits are in task.json.",
                           "Future output-store and durable-plan setup must use host adapters; offline plan receipts are synthetic.",
                           "Ten-second control subprocess cap is not a security sandbox or a live-pilot time budget."]}
(ROOT / "validation-results.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"status": "passed", "tasks": len(CASES), "positiveControls": sum(row["expected"] == "pass" for row in rows), "rejectedControls": sum(row["expected"] == "fail" for row in rows), "modelCalls": 0}))
