import * as React from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys } from "../../lib/queries";
import type { BotAllowedEntry } from "../../shared/tool-approval-scope";

const subscriptions = new WeakMap<QueryClient, { users: number; off(): void }>();

function invalidateAllowed(client: QueryClient, botId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.botAllowed(botId), exact: true }),
    client.invalidateQueries({ queryKey: queryKeys.botAllowed(), exact: true }),
  ]);
}

/** One host subscription per cache, shared by Profile and Settings readers. */
function subscribe(client: QueryClient) {
  let shared = subscriptions.get(client);
  if (!shared) {
    shared = { users: 0, off: botsApi.onAllowedChanged(({ botId }) => { void invalidateAllowed(client, botId); }) };
    subscriptions.set(client, shared);
  }
  shared.users++;
  return () => {
    if (--shared.users === 0) {
      shared.off();
      subscriptions.delete(client);
    }
  };
}

export function useBotAllowed(botId?: string) {
  const client = useQueryClient();
  React.useEffect(() => subscribe(client), [client]);
  return useQuery({ queryKey: queryKeys.botAllowed(botId), queryFn: () => botsApi.allowedList(botId) });
}

export function useBotAllowedRemoval() {
  const client = useQueryClient();
  const inFlight = React.useRef(false);
  const [removing, setRemoving] = React.useState<{ botId: string; entryId: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const remove = async (entry: BotAllowedEntry) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRemoving({ botId: entry.botId, entryId: entry.id });
    setError(null);
    try {
      await botsApi.removeAllowed(entry.botId, entry.id);
      // A naturally idempotent Remove can report false when already gone.
      // Refresh both caches from the host rather than inventing a new list.
      await invalidateAllowed(client, entry.botId);
    } catch (cause) {
      setError(userFacingErrorMessage(cause, "Aiden couldn’t remove this allowance."));
    } finally {
      inFlight.current = false;
      setRemoving(null);
    }
  };
  return { removing, error, remove };
}
