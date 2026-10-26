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
    const unsubscribe = spendingApi.onChanged((event) => {
      if (event.ownerKind === ownerKind && (event.ownerId === ownerId || event.ownerId === "*")) read();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [ownerKind, ownerId]);
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
