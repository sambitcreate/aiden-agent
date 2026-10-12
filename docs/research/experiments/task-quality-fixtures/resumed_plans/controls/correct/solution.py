def clean_label(value):
    if value is None:
        return None
    result = value.strip()
    if not result:
        raise ValueError("blank label")
    return result
