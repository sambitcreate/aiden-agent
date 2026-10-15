# Independent offline acceptance oracle. Candidate workspace is argv[1].
# Keep this file and controls outside the future model-visible workspace.
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv[1]) / "solution.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for source, expected, label in [
    ([[1, 3], [2, 5], [8, 9]], [[1, 5], [8, 9]], "overlap_merge"),
    ([[1, 3], [3, 5]], [[1, 3], [3, 5]], "touching_separate"),
    ([[8, 10], [-3, 2], [-1, 1], [8, 10]], [[-3, 2], [8, 10]], "nested_duplicate_ranges"),
    ([], [], "empty_input"),
]:
    snapshot = json.loads(json.dumps(source))
    actual = module.merge_ranges(source)
    assert actual == expected, label
    assert all(type(endpoint) is int for pair in actual for endpoint in pair), "integer_endpoints"
    assert source == snapshot, "input_unchanged: caller owns source order"

print(json.dumps({"case": 'comfortable_window_control', "accepted": True}))
