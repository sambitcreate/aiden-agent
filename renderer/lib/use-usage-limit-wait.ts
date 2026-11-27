/**
 * One shared read of the replies waiting for a provider usage limit. It
 * listens over IPC only while a chat or Bot that shows waits is mounted.
 */
import * as React from "react";
import { usageLimitsApi } from "./ipc";
import { createSharedSnapshot } from "./shared-snapshot";
import { usageLimitWaitFor, type UsageLimitWaitView } from "../shared/usage-limits";

const NONE: UsageLimitWaitView[] = [];

const usageLimitSnapshot = createSharedSnapshot<UsageLimitWaitView[]>({
  empty: NONE,
  subscribe: (onValue) => usageLimitsApi.onChanged(onValue),
  read: () => usageLimitsApi.list(),
  normalize: (next) => (next.length ? next : NONE),
  ignoreReadAfterPush: true,
});

/** The wait of one chat or Bot, while its reply waits for a usage limit. */
export function useUsageLimitWait(
  ownerKind: UsageLimitWaitView["ownerKind"],
  ownerId: string | null | undefined,
): UsageLimitWaitView | undefined {
  const waits = usageLimitSnapshot.useSnapshot(Boolean(ownerId));
  return React.useMemo(
    () => (ownerId ? usageLimitWaitFor(waits, ownerKind, ownerId) : undefined),
    [waits, ownerKind, ownerId],
  );
}

/** Retry now for one chat or Bot. Resolves to false when it was tried in the last 30 seconds. */
export function retryUsageLimitNow(ownerKind: UsageLimitWaitView["ownerKind"], ownerId: string): Promise<boolean> {
  return usageLimitsApi.retryNow(ownerKind, ownerId).catch(() => false);
}

/** The current time, refreshed when the wait's next try comes due, so its label turns to "Trying again". */
export function useUsageLimitNow(wait: UsageLimitWaitView | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());
  const nextTryAt = wait?.nextTryAt;
  const trying = wait?.trying;
  React.useEffect(() => {
    setNow(Date.now());
    if (nextTryAt === undefined || trying) return;
    const delay = nextTryAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [nextTryAt, trying]);
  return now;
}
