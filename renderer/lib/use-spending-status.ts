/**
 * One chat's or Bot's spending against its limit, kept current from main's
 * change events. Undefined while loading and when no limit applies.
 */
import * as React from "react";
import { spendingApi } from "./ipc";
import type { SpendingStatusView } from "../shared/spending";

export function useSpendingStatus(
  ownerKind: SpendingStatusView["ownerKind"],
  ownerId: string | null | undefined,
): { status: SpendingStatusView | undefined; allowMore(): Promise<void>; allowing: boolean } {
  const [status, setStatus] = React.useState<SpendingStatusView | undefined>(undefined);
  const [allowing, setAllowing] = React.useState(false);
  const reread = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => {
    setStatus(undefined);
    if (!ownerId) return;
    let current = true;
    let generation = 0;
    const read = () => {
      const mine = ++generation;
      void spendingApi.status(ownerKind, ownerId).then(
        (next) => {
          if (current && mine === generation) setStatus(next ?? undefined);
        },
        () => undefined,
      );
    };
    read();
    reread.current = read;
    const unsubscribe = spendingApi.onChanged((event) => {
      if (event.ownerKind === ownerKind && (event.ownerId === ownerId || event.ownerId === "*")) read();
    });
    return () => {
      current = false;
      reread.current = undefined;
      unsubscribe();
    };
  }, [ownerKind, ownerId]);
  // A Bot's month starts over with no change event: read again once it has
  // ended. Checked at least every minute, so a Mac that slept through the
  // boundary catches up soon after it wakes.
  const periodEnd = status?.periodEnd;
  React.useEffect(() => {
    if (periodEnd === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (Date.now() >= periodEnd) reread.current?.();
      else timer = setTimeout(tick, Math.min(periodEnd - Date.now() + 50, 60_000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [periodEnd]);
  const allowMore = React.useCallback(async () => {
    if (!ownerId) return;
    setAllowing(true);
    try {
      const next = await spendingApi.allowMore(ownerKind, ownerId);
      setStatus(next ?? undefined);
    } finally {
      setAllowing(false);
    }
  }, [ownerKind, ownerId]);
  return { status, allowMore, allowing };
}
