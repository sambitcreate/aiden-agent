import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workspacesApi } from "./ipc";
import { queryKeys } from "./queries";
import type { Workspace } from "./types";
import { isWorkspacePathQuery, workspacePathRow, type WorkspacePathRow } from "./workspace-menu";

export const WORKSPACE_PATH_INSPECT_DELAY_MS = 150;

export interface WorkspacePathIntake {
  /** True while the query is a path (`/`, `~`, `.`), whether or not it has been checked yet. */
  pathQuery: boolean;
  /** The row for the latest checked input; null until that check answers. */
  row: WorkspacePathRow | null;
  /** A check for the current input is still pending. */
  checking: boolean;
}

/**
 * Inspect a typed path in main after a short pause. Only the answer for the
 * latest input is kept: a slow answer for an older input never replaces a
 * newer one. `.` paths resolve against `relativeToWorkspaceId`'s folder.
 */
export function useWorkspacePathIntake(
  query: string,
  {
    enabled = true,
    relativeToWorkspaceId,
    workspaces,
  }: { enabled?: boolean; relativeToWorkspaceId?: string; workspaces: readonly Workspace[] },
): WorkspacePathIntake {
  const input = query.trim();
  const pathQuery = enabled && isWorkspacePathQuery(input);
  const [answer, setAnswer] = React.useState<{ input: string; row: WorkspacePathRow } | null>(null);
  const workspacesRef = React.useRef(workspaces);
  workspacesRef.current = workspaces;

  React.useEffect(() => {
    if (!pathQuery) return;
    let current = true;
    const timer = setTimeout(() => {
      workspacesApi.inspectPath(input, relativeToWorkspaceId).then(
        (inspection) => {
          if (current) setAnswer({ input, row: workspacePathRow(input, inspection, workspacesRef.current) });
        },
        (error: unknown) => {
          if (!current) return;
          setAnswer({
            input,
            row: {
              action: "invalid",
              input,
              message: error instanceof Error && error.message ? error.message : "Aiden couldn't check that path.",
            },
          });
        },
      );
    }, WORKSPACE_PATH_INSPECT_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [input, pathQuery, relativeToWorkspaceId]);

  const row = pathQuery && answer?.input === input ? answer.row : null;
  return { pathQuery, row, checking: pathQuery && row === null };
}

/**
 * Register the folder a path row names (creating it first for a create row)
 * and refresh the workspace list so the new id can be selected. Throws the
 * main process's reason when it refuses.
 */
export function useOpenWorkspacePathRow(relativeToWorkspaceId?: string) {
  const queryClient = useQueryClient();
  return React.useCallback(
    async (row: Extract<WorkspacePathRow, { action: "open" | "create" }>): Promise<Workspace> => {
      const result = await workspacesApi.openPath(row.input, {
        create: row.action === "create",
        ...(relativeToWorkspaceId ? { relativeToWorkspaceId } : {}),
      });
      if (!result.ok) throw new Error(result.reason);
      await adoptWorkspace(queryClient, result.workspace);
      return result.workspace;
    },
    [queryClient, relativeToWorkspaceId],
  );
}

/** Put a newly registered workspace in the cache, then refetch the list. */
export async function adoptWorkspace(
  queryClient: ReturnType<typeof useQueryClient>,
  workspace: Workspace,
): Promise<void> {
  queryClient.setQueryData<Workspace[]>(queryKeys.workspaces, (current) => [
    workspace,
    ...(current ?? []).filter((entry) => entry.id !== workspace.id),
  ]);
  await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
}
