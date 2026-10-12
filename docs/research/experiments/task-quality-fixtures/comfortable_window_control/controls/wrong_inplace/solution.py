def merge_ranges(ranges):
    ranges.sort()
    result = []
    for start, end in ranges:
        if result and start < result[-1][1]:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return result
