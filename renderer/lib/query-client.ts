import { QueryClient } from "@tanstack/react-query";

/**
 * The renderer's query defaults. Every query reads local IPC, so:
 * - `staleTime` 30 s: a remount or route switch reuses fresh data instead of
 *   re-reading it. Data main changes on its own is invalidated by push
 *   notifications (chats, workspaces, bots, schedules, config, Git).
 * - `refetchOnWindowFocus` off: focusing the window must not resend every
 *   active query (including whole chats) over IPC. Queries that mirror state
 *   which can change outside the app with no push event opt back in.
 * - `retry` 1: IPC failures are almost always deterministic, so three
 *   backed-off retries only delay the error by seconds.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
