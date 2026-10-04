// Keeps Git display queries fresh from push events instead of fast polling:
// - `git:changed` (main watches HEAD, index, refs) for repository changes;
// - agent tool results and `chats:settled` for working-tree edits;
// - window re-activation for edits made in other apps.
// Queries keep a slow safety-net interval while the window is active.

import type { Query, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";
import { subscribeWindowActivated } from "./window-activity";

type Subscribe = (channel: string, handler: (payload: unknown) => void) => () => void;

const root = (key: readonly unknown[]) => key[0] as string;
const WORKING_TREE_ROOTS = new Set([
  root(queryKeys.git(undefined)),
  root(queryKeys.gitReview(undefined)),
  root(queryKeys.gitComparisons(undefined)),
]);
const REPOSITORY_ROOTS = new Set([
  ...WORKING_TREE_ROOTS,
  root(queryKeys.gitPushCapability(undefined)),
  root(queryKeys.gitBranches(undefined)),
  root(queryKeys.gitWorktrees(undefined)),
]);
const PULL_REQUEST_ROOT = root(queryKeys.gitPullRequestStatus(undefined));
/** Agent tools can run in quick succession; refresh working-tree state at most this often. */
export const TOOL_RESULT_REFRESH_MS = 5_000;

function workspaceOf(payload: unknown): string | undefined {
  const id = payload && typeof payload === "object" ? (payload as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof id === "string" && id ? id : undefined;
}

function matches(roots: ReadonlySet<string>, workspaceId?: string) {
  return (query: Query) => {
    const [root, id] = query.queryKey;
    return typeof root === "string" && roots.has(root) && (workspaceId === undefined || id === workspaceId);
  };
}

export function subscribeGitQuerySync(
  queryClient: QueryClient,
  subscribe: Subscribe,
  options: { onWindowActivated?: (listener: () => void) => () => void; now?: () => number } = {},
): () => void {
  const now = options.now ?? Date.now;
  const onWindowActivated = options.onWindowActivated ?? subscribeWindowActivated;
  let lastToolRefresh = Number.NEGATIVE_INFINITY;
  let pendingToolRefresh: ReturnType<typeof setTimeout> | undefined;

  const refreshWorkingTree = (workspaceId?: string) => {
    void queryClient.invalidateQueries({ predicate: matches(WORKING_TREE_ROOTS, workspaceId) });
  };
  // `gh pr view` is a network call: refresh pull-request status on change
  // events only when its cached answer is already stale.
  const refreshPullRequestIfStale = (workspaceId?: string) => {
    void queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === PULL_REQUEST_ROOT && (workspaceId === undefined || query.queryKey[1] === workspaceId),
      type: "active",
      stale: true,
    });
  };

  const unsubscribers = [
    subscribe("git:changed", (payload) => {
      const workspaceId = workspaceOf(payload);
      if (!workspaceId) return;
      void queryClient.invalidateQueries({ predicate: matches(REPOSITORY_ROOTS, workspaceId) });
      refreshPullRequestIfStale(workspaceId);
    }),
    subscribe("chats:settled", (payload) => {
      const workspaceId = workspaceOf(payload);
      if (workspaceId) refreshWorkingTree(workspaceId);
    }),
    subscribe("chat:tool", (payload) => {
      const phase = payload && typeof payload === "object" ? (payload as { phase?: unknown }).phase : undefined;
      if (phase !== "result" && phase !== "error") return;
      if (pendingToolRefresh) return;
      const wait = Math.max(0, lastToolRefresh + TOOL_RESULT_REFRESH_MS - now());
      pendingToolRefresh = setTimeout(() => {
        pendingToolRefresh = undefined;
        lastToolRefresh = now();
        // Tool events carry no workspace; only mounted (active) queries refetch.
        refreshWorkingTree();
      }, wait);
    }),
    onWindowActivated(() => {
      const gitQuery = (query: Query) => matches(REPOSITORY_ROOTS)(query) || query.queryKey[0] === PULL_REQUEST_ROOT;
      // Safety-net intervals were switched off while inactive; re-evaluating
      // each observer's options restarts them without a fetch.
      for (const query of queryClient.getQueryCache().findAll({ predicate: gitQuery, type: "active" })) {
        for (const observer of query.observers) observer.setOptions(observer.options);
      }
      void queryClient.refetchQueries({ predicate: matches(REPOSITORY_ROOTS), type: "active", stale: true });
      refreshPullRequestIfStale();
    }),
  ];
  return () => {
    if (pendingToolRefresh) clearTimeout(pendingToolRefresh);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
