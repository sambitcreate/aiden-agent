import csv
import io
def render_events(events):
    if not events: return "id,label\n"
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(["id", "label"])
    writer.writerows((row["id"], row["label"]) for row in events)
    return out.getvalue()
