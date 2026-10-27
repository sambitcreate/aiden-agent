// Re-reads lists built from a workspace's files when an agent tool may have
// changed them (`workspace:files-touched`), so a skill the agent just wrote
// shows in the / menu without waiting for the window to lose and regain focus.
// The Files panel and Git reads follow the same notice on their own.

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";

type Subscribe = (channel: string, handler: (payload: unknown) => void) => () => void;

export function subscribeWorkspaceFilesSync(queryClient: QueryClient, subscribe: Subscribe): () => void {
  return subscribe("workspace:files-touched", (payload) => {
    const workspaceId = payload && typeof payload === "object" ? (payload as { workspaceId?: unknown }).workspaceId : undefined;
    if (typeof workspaceId !== "string" || !workspaceId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.skillCatalog(workspaceId) });
  });
}
