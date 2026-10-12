def render_events(events):
    return "id,label\n" + "".join(r["id"] + "," + r["label"] + "\n" for r in events)
