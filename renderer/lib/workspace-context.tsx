// Shared "active workspace" state for the chat shell. The sidebar switches it;
// the chat pane / composer read it. Persisted in localStorage so the last-used
// workspace is restored on launch.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getChatDraft, listChatDrafts, updateChatDraft } from "./chat-draft";
import { workspacesApi } from "./ipc";
import { isNoWorkspace, noWorkspaceHome } from "./no-workspace";
import { rehomeStrandedNoWorkspaceDrafts, releasedNoWorkspaceIds } from "./no-workspace-send";
import { queryKeys, useWorkspaces } from "./queries";
import type { Workspace } from "./types";

const STORAGE_KEY = "aiden-agent.workspaceId";

interface WorkspaceContextValue {
  workspaces: Workspace[];
  active: Workspace | undefined;
  activeId: string | undefined;
  select: (id: string) => void;
  isLoading: boolean;
  isReady: boolean;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const workspaces = useWorkspaces();
  const list = React.useMemo(() => workspaces.data ?? [], [workspaces.data]);
  const [activeId, setActiveId] = React.useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  const select = React.useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  // Keep the active id pointing at a real workspace as the list loads/changes.
  // Deleting a No workspace chat releases its hidden workspace: the selection
  // and any draft still aimed at it stay in the Chats group.
  const qc = useQueryClient();
  const hiddenIdsRef = React.useRef<ReadonlySet<string>>(new Set());
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;
  React.useEffect(() => {
    if (list.length === 0) return;
    const released = releasedNoWorkspaceIds(hiddenIdsRef.current, list);
    hiddenIdsRef.current = new Set(list.filter(isNoWorkspace).map((workspace) => workspace.id));
    const activeReleased = Boolean(activeId && released.has(activeId));
    let fallbackId: string | undefined;
    if (!activeId || !list.some((w) => w.id === activeId)) {
      fallbackId = (activeReleased ? noWorkspaceHome(list)?.id : undefined) ?? list[0].id;
      select(fallbackId);
    }
    if (released.size === 0) return;
    const moveDraft = (draftId: string, workspaceId: string) => {
      try {
        updateChatDraft(draftId, { workspaceId });
      } catch {
        // Its first message is already saving.
      }
    };
    const draftWorkspaceId = (draftId: string) => {
      const draft = getChatDraft(draftId);
      return draft && !draft.sending ? draft.chat.workspaceId : undefined;
    };
    void rehomeStrandedNoWorkspaceDrafts(
      { createNoWorkspace: workspacesApi.createNoWorkspace, draftWorkspaceId, moveDraft },
      listChatDrafts(),
      released,
      list,
    )
      .then(async (home) => {
        if (!home || list.some((workspace) => workspace.id === home)) return;
        await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        // Unless a workspace was picked meanwhile.
        if (activeReleased && activeIdRef.current === fallbackId) select(home);
      })
      .catch(() => undefined);
  }, [list, activeId, qc, select]);

  const active = list.find((w) => w.id === activeId) ?? list[0];
  const isLoading = workspaces.isLoading;
  const isReady = workspaces.isSuccess;
  const value = React.useMemo<WorkspaceContextValue>(
    () => ({ workspaces: list, active, activeId: active?.id, select, isLoading, isReady }),
    [list, active, select, isLoading, isReady],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useActiveWorkspace(): WorkspaceContextValue {
  const ctx = React.useContext(WorkspaceContext);
  if (!ctx) throw new Error("useActiveWorkspace must be used within a WorkspaceProvider");
  return ctx;
}
