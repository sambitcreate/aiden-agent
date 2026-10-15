import csv
import io
def render_events(events):
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_ALL)
    writer.writerow(["id", "label"])
    writer.writerows((row["id"], row["label"]) for row in events)
    return out.getvalue()
