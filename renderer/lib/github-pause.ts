// GitHub reads pause after a rate limit until the time GitHub gave. These
// helpers keep the renderer from polling or re-requesting during the pause and
// word it for people.

interface MaybePaused {
  availability?: string;
  retryAt?: number;
}

/** When a `rate-limited` answer may be retried, if that is still ahead. */
export function githubPausedUntil(status: unknown, now: number): number | undefined {
  if (!status || typeof status !== "object") return undefined;
  const { availability, retryAt } = status as MaybePaused;
  return availability === "rate-limited" && typeof retryAt === "number" && retryAt > now ? retryAt : undefined;
}

/** The poll interval, stretched so the next poll lands after a pause ends. */
export function pausedPollInterval(status: unknown, now: number, intervalMs: number): number {
  const until = githubPausedUntil(status, now);
  return until === undefined ? intervalMs : Math.max(intervalMs, until - now + 1_000);
}

/** While paused, keep showing the pull request from the last good answer. */
export function keepPullRequestWhilePaused<T extends { availability?: string; pullRequest?: unknown }>(
  previous: T | undefined,
  next: T,
): T {
  if (next.availability !== "rate-limited" || next.pullRequest || !previous?.pullRequest) return next;
  return { ...next, pullRequest: previous.pullRequest };
}

/** "GitHub paused until 3:45 PM" in the user's locale; adds the day when it is not today. */
export function formatGitHubPausedUntil(retryAt: number, now: number, locale?: string): string {
  const until = new Date(retryAt);
  const sameDay = until.toDateString() === new Date(now).toDateString();
  const time = until.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const when = sameDay ? time : `${until.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `GitHub paused until ${when}`;
}
