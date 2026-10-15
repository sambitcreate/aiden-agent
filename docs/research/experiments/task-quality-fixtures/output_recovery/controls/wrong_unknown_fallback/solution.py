def release_id(channel):
    return {"production": "prod-r17", "staging": "stage-r23"}.get(channel, "prod-r17")
