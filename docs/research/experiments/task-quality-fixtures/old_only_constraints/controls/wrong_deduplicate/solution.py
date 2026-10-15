import csv
import io
def render_events(events):
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["id", "label"])
    unique = {(r["id"], r["label"]) for r in events}
    writer.writerows(sorted(unique))
    return out.getvalue()
