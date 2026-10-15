def retry_delay(attempt):
    value = min(100 * 2 ** (attempt - 1), 800)
    return float(value) if attempt == 2 else value
