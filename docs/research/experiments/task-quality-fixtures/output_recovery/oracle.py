# Independent offline acceptance oracle. Candidate workspace is argv[1].
# Keep this file and controls outside the future model-visible workspace.
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv[1]) / "solution.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.release_id("production") == "prod-r17", "active_release: archived production must not win"
assert module.release_id("staging") == "stage-r23", "active_release: channels must remain distinct"
try:
    module.release_id("preview")
except KeyError:
    pass
else:
    raise AssertionError("unknown_rejected: no silent production fallback")

print(json.dumps({"case": 'output_recovery', "accepted": True}))
