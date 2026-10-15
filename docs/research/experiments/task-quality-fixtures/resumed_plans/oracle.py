# Independent offline acceptance oracle. Candidate workspace is argv[1].
# Keep this file and controls outside the future model-visible workspace.
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv[1]) / "solution.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.clean_label(None) is None, "legacy_none"
assert module.clean_label("  東京  room  ") == "東京  room", "trim_outer: preserve interior spacing and Unicode"
for value in ["", " ", "\t\n"]:
    try:
        module.clean_label(value)
    except ValueError:
        pass
    else:
        raise AssertionError("blank_rejected")
# argv[2] is an out-of-band host receipt, not a model-editable workspace file.
plan = json.loads(Path(sys.argv[2]).read_text())
assert [task["id"] for task in plan["tasks"]] == [3, 8, 12], "stable_plan_ids: resume existing branch tasks"
assert [task["subject"] for task in plan["tasks"]] == ["Preserve legacy None", "Trim outer whitespace", "Reject blank labels"], "branch_plan_identity"
assert all(task["status"] == "completed" for task in plan["tasks"]), "finished_plan_state"
assert plan["nextId"] == 13, "no_replacement_plan"

print(json.dumps({"case": 'resumed_plans', "accepted": True}))
