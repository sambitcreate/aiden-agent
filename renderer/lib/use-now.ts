import * as React from "react";

/** Wall-clock time, refreshed once a second through one interval only while `live` is true. */
export function useNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [live]);
  return now;
}
