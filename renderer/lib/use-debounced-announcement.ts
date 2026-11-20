import * as React from "react";

/**
 * A live-region message that settles `delayMs` after the last change, so a
 * screen reader hears one count after typing pauses instead of one per key.
 * The setter announces something at once, like why a row can't be chosen.
 */
export function useDebouncedAnnouncement(
  message: string,
  delayMs: number,
): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [announcement, setAnnouncement] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(message), delayMs);
    return () => window.clearTimeout(timer);
  }, [message, delayMs]);
  return [announcement, setAnnouncement];
}

/** "3 results" or "No results" for a filtered list; nothing for an empty query. */
export function resultCountMessage(count: number, query: string): string {
  if (!query.trim()) return "";
  return count === 0 ? "No results" : `${count} result${count === 1 ? "" : "s"}`;
}
