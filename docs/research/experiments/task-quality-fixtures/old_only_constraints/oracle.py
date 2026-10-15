# Independent offline acceptance oracle. Candidate workspace is argv[1].
# Keep this file and controls outside the future model-visible workspace.
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv[1]) / "solution.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
import csv
import io
rows = [{"id": "b", "label": "second"}, {"id": "a", "label": "first"}, {"id": "b", "label": "second"}]
original = json.loads(json.dumps(rows))
actual = list(csv.reader(io.StringIO(module.render_events(rows))))
assert actual == [["id", "label"], ["b", "second"], ["a", "first"], ["b", "second"]], "audit_rows: preserve order and duplicates"
framed = module.render_events(rows)
assert "\r" not in framed and framed.endswith("\n"), "lf_record_framing: LF between records for fields without CR data"
assert rows == original, "input_unchanged"
special = [{"id": "c,1", "label": 'line1\n"東京"'}]
assert list(csv.reader(io.StringIO(module.render_events(special)))) == [["id", "label"], ["c,1", 'line1\n"東京"']], "csv_roundtrip: escaped fields must survive"
empty = module.render_events([])
assert list(csv.reader(io.StringIO(empty))) == [["id", "label"]], "empty_header"
assert "\r" not in empty and empty.endswith("\n"), "empty_lf_framing"

print(json.dumps({"case": 'old_only_constraints', "accepted": True}))
