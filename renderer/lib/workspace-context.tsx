// Shared "active workspace" state for the chat shell. The sidebar switches it;
// the chat pane / composer read it. Persisted in localStorage so the last-used
// workspace is restored on launch.

import * as React from "react";
import { useWorkspaces } from "./queries";
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

  // Keep the active id pointing at a real workspace as the list loads/changes.
  React.useEffect(() => {
    if (list.length === 0) return;
    if (!activeId || !list.some((w) => w.id === activeId)) {
      const next = list[0].id;
      setActiveId(next);
      localStorage.setItem(STORAGE_KEY, next);
    }
  }, [list, activeId]);

  const select = React.useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  const active = list.find((w) => w.id === activeId) ?? list[0];
  const value: WorkspaceContextValue = {
    workspaces: list,
    active,
    activeId: active?.id,
    select,
    isLoading: workspaces.isLoading,
    isReady: workspaces.isSuccess,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useActiveWorkspace(): WorkspaceContextValue {
  const ctx = React.useContext(WorkspaceContext);
  if (!ctx) throw new Error("useActiveWorkspace must be used within a WorkspaceProvider");
  return ctx;
}
