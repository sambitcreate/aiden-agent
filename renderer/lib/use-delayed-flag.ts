import * as React from "react";

/**
 * True once `value` has stayed true for `delayMs`, and false the moment it turns
 * false. Lets a brief state (a commit that finishes in a blink) skip its visible
 * treatment while a longer one still shows it.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    if (!value) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && elapsed;
}
