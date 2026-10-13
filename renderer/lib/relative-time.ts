/**
 * A locale-aware relative label ("in 2 hours", "yesterday", "5 minutes ago")
 * for `timestamp` measured from `now`. Under 90 seconds it counts seconds,
 * under 90 minutes minutes, under 36 hours hours, and days beyond that.
 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 90_000) return formatter.format(Math.round(delta / 1_000), "second");
  if (absolute < 90 * 60_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (absolute < 36 * 3_600_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
}
