import * as React from "react";
import type { WorkspaceArtifactsChangedEvent, WorkspaceArtifactView } from "../shared/workspace-artifacts";
import { workspaceArtifactsApi } from "./ipc";

export interface WorkspaceArtifactsState {
  /** The workspace this list belongs to; null when no workspace is active. */
  workspaceId: string | null;
  views: WorkspaceArtifactView[];
  /** The list for `workspaceId` has been read at least once. */
  loaded: boolean;
  error: string | null;
  reload: () => void;
  /** Records page state the person changed, so the list matches what was saved. */
  rememberState: (artifactId: string, state: Record<string, unknown>) => void;
}

/**
 * The active workspace's artifacts, re-read whenever main reports a change
 * to that workspace. `onChange` sees every change event, for any workspace.
 */
export function useWorkspaceArtifacts(
  workspaceId: string | null,
  onChange?: (event: WorkspaceArtifactsChangedEvent) => void,
): WorkspaceArtifactsState {
  const [state, setState] = React.useState<Omit<WorkspaceArtifactsState, "reload" | "rememberState">>({
    workspaceId,
    views: [],
    loaded: workspaceId === null,
    error: null,
  });
  const requestRef = React.useRef(0);
  const workspaceRef = React.useRef(workspaceId);
  const onChangeRef = React.useRef(onChange);
  React.useLayoutEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const load = React.useCallback((id: string | null) => {
    const request = ++requestRef.current;
    if (id === null) {
      setState({ workspaceId: null, views: [], loaded: true, error: null });
      return;
    }
    workspaceArtifactsApi.list(id).then(
      (views) => {
        if (request !== requestRef.current) return;
        setState({ workspaceId: id, views, loaded: true, error: null });
      },
      (error: unknown) => {
        if (request !== requestRef.current) return;
        setState((current) => ({
          workspaceId: id,
          // Keep the last good list for this workspace; a failed re-read is not an empty one.
          views: current.workspaceId === id ? current.views : [],
          loaded: true,
          error: error instanceof Error ? error.message : "Could not load artifacts.",
        }));
      },
    );
  }, []);

  React.useEffect(() => {
    workspaceRef.current = workspaceId;
    setState((current) =>
      current.workspaceId === workspaceId ? current : { workspaceId, views: [], loaded: false, error: null },
    );
    load(workspaceId);
  }, [load, workspaceId]);

  React.useEffect(
    () =>
      workspaceArtifactsApi.onChanged((event) => {
        if (event.workspaceId === workspaceRef.current) load(event.workspaceId);
        onChangeRef.current?.(event);
      }),
    [load],
  );

  const reload = React.useCallback(() => load(workspaceRef.current), [load]);
  const rememberState = React.useCallback((artifactId: string, pageState: Record<string, unknown>) => {
    setState((current) => ({
      ...current,
      views: current.views.map((view) =>
        view.artifact.id === artifactId
          ? { ...view, artifact: { ...view.artifact, visual: { ...view.artifact.visual, state: pageState } } }
          : view,
      ),
    }));
  }, []);
  return React.useMemo(() => ({ ...state, reload, rememberState }), [reload, rememberState, state]);
}
