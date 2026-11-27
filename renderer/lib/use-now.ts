import * as React from "react";

/** Wall-clock time, refreshed on one interval only while `live` is true. */
export function useNow(live: boolean, intervalMs = 1_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(interval);
  }, [live, intervalMs]);
  return now;
}
