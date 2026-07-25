/** Default character budget for workspace path sublabels in menus (~max-w-72). */
export const DEFAULT_PATH_TRUNCATE_LENGTH = 44;

/**
 * Truncate a filesystem path with an ellipsis in the middle so both the
 * leading directories and the trailing leaf stay recognizable.
 *
 * Prefers keeping a meaningful root (for example `/Users`) plus the leaf,
 * cutting on path separators when that still fits the budget.
 */
export function truncatePathMiddle(
  path: string,
  maxLength: number = DEFAULT_PATH_TRUNCATE_LENGTH,
): string {
  const value = path.trim();
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;

  const ellipsis = "…";
  if (maxLength <= ellipsis.length) return ellipsis;

  const budget = maxLength - ellipsis.length;
  const sep = value.includes("/") ? "/" : value.includes("\\") ? "\\" : null;

  if (sep) {
    const parts = value.split(sep);
    if (parts.length >= 2) {
      const isAbsoluteUnix = parts[0] === "";
      const isWindowsDrive = /^[A-Za-z]:$/u.test(parts[0] ?? "");
      // Prefer `/Users/…/leaf` or `C:\Users\…\leaf` over bare `/…/leaf`.
      const preferredLeft =
        (isAbsoluteUnix || isWindowsDrive) && parts.length >= 3 ? 2 : 1;

      let leftCount = preferredLeft;
      let rightCount = 1;
      let candidate = formatPathEnds(parts, leftCount, rightCount, sep, ellipsis);

      if (candidate.length > maxLength && leftCount > 1) {
        leftCount = 1;
        candidate = formatPathEnds(parts, leftCount, rightCount, sep, ellipsis);
      }

      if (candidate.length <= maxLength) {
        while (leftCount + rightCount < parts.length) {
          const growRight = rightCount <= leftCount;
          const nextLeft = growRight ? leftCount : leftCount + 1;
          const nextRight = growRight ? rightCount + 1 : rightCount;
          if (nextLeft + nextRight > parts.length) break;
          const next = formatPathEnds(parts, nextLeft, nextRight, sep, ellipsis);
          if (next.length > maxLength) break;
          leftCount = nextLeft;
          rightCount = nextRight;
          candidate = next;
        }
        if (candidate.includes(ellipsis)) return candidate;
      }
    }
  }

  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${value.slice(0, head)}${ellipsis}${value.slice(value.length - tail)}`;
}

function formatPathEnds(
  parts: string[],
  leftCount: number,
  rightCount: number,
  sep: string,
  ellipsis: string,
): string {
  const left = parts.slice(0, leftCount);
  const right = parts.slice(parts.length - rightCount);
  // Absolute Unix paths keep the leading empty segment as a leading separator.
  const prefix = left[0] === "" ? `${sep}${left.slice(1).join(sep)}` : left.join(sep);
  const suffix = right.join(sep);
  if (leftCount + rightCount >= parts.length) {
    return left[0] === "" ? `${sep}${parts.slice(1).join(sep)}` : parts.join(sep);
  }
  if (prefix.endsWith(sep) || prefix === sep) return `${prefix}${ellipsis}${sep}${suffix}`;
  return `${prefix}${sep}${ellipsis}${sep}${suffix}`;
}
