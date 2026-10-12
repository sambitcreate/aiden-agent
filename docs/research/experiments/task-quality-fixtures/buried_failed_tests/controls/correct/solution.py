def retry_delay(attempt):
    return min(800, 100 * 2 ** (attempt - 1))
