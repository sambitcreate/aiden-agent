# Independent offline acceptance oracle. Candidate workspace is argv[1].
# Keep this file and controls outside the future model-visible workspace.
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv[1]) / "solution.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for subtotal, expected in [(0, 499), (4999, 499), (5000, 499), (7499, 499), (7500, 0), (9000, 0)]:
    actual = module.delivery_fee(subtotal, False)
    assert type(actual) is int, "integer_cents"
    assert actual == expected, "corrected_threshold: apply latest inclusive cutoff"
for subtotal, expected in [(0, 499), (5000, 499), (7499, 499), (7500, 0)]:
    actual = module.delivery_fee(subtotal, True)
    assert type(actual) is int, "integer_cents"
    assert actual == expected, "no_member_discount: latest correction overrides old exemption"
assert type(module.delivery_fee(7500, False)) is int, "integer_cents"

print(json.dumps({"case": 'superseded_instructions', "accepted": True}))
