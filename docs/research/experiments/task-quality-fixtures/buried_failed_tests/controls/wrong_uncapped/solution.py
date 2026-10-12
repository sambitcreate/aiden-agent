def retry_delay(attempt):
    return 100 * 2 ** (attempt - 1)
