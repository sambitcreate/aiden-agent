import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import {
  workspaceArtifactDataJson,
  workspaceArtifactSourceAccess,
  type WorkspaceArtifactSourceAccess,
  type WorkspaceArtifactsChangedEvent,
  type WorkspaceArtifactView,
} from "../shared/workspace-artifacts";
import type { WorkspacePermission } from "./types";

/** The page as the Artifacts tab draws it: the saved visual with every source's latest data bound in. */
export function workspaceArtifactPage(view: WorkspaceArtifactView): ChatUiVisualV1 {
  const dataJson = workspaceArtifactDataJson(view.artifact, view.snapshot);
  const { dataJson: _static, ...visual } = view.artifact.visual;
  return dataJson ? { ...visual, dataJson } : visual;
}

/**
 * What the page may run right now, from the workspace's access and whether
 * the person approved these exact commands. Null when it runs nothing.
 */
export function workspaceArtifactPageAccess(
  view: WorkspaceArtifactView,
  workspace: { permission: WorkspacePermission; folderPath?: string } | null,
): WorkspaceArtifactSourceAccess | null {
  const { sources, actions, approvedDigest } = view.artifact;
  if (sources.length === 0 && actions.length === 0) return null;
  const approved = approvedDigest === view.digest;
  const permission = workspace?.permission ?? "none";
  const hasFolder = Boolean(workspace?.folderPath);
  const states = sources.map((source) => workspaceArtifactSourceAccess(permission, hasFolder, source, approved));
  if (actions.length > 0) {
    // Buttons run shell commands, so they follow the same rule as shell sources.
    states.push(
      workspaceArtifactSourceAccess(permission, hasFolder, { name: "action", kind: "shell", command: "", parse: "text" }, approved),
    );
  }
  if (states.includes("blocked")) return "blocked";
  if (states.includes("needs-approval")) return "needs-approval";
  return "run";
}

export interface WorkspaceArtifactProblem {
  name: string;
  /** "blocked" waits on access or approval, which the access notice explains. */
  status: "error" | "blocked";
  message: string;
}

/** Sources whose last refresh failed or was held back, with what the person should know. */
export function workspaceArtifactProblems(view: WorkspaceArtifactView): WorkspaceArtifactProblem[] {
  const results = view.snapshot?.sources ?? {};
  return view.artifact.sources.flatMap((source) => {
    const result = results[source.name];
    if (!result || result.status === "ok") return [];
    return [{ name: source.name, status: result.status, message: result.error ?? (result.status === "blocked" ? "Not run." : "Failed.") }];
  });
}

/** Keeps the person's choice while it exists; otherwise the first artifact. */
export function pickWorkspaceArtifact(views: readonly WorkspaceArtifactView[], selectedId: string | null): string | null {
  if (selectedId && views.some((view) => view.artifact.id === selectedId)) return selectedId;
  return views[0]?.artifact.id ?? null;
}

/** A chat that just created an artifact shows it beside that chat; other windows only update their list. */
export function revealsWorkspaceArtifact(
  event: WorkspaceArtifactsChangedEvent,
  activeChat: { chatId: string | null; workspaceId: string | null },
): boolean {
  return (
    event.reason === "created" &&
    Boolean(event.chatId) &&
    event.chatId === activeChat.chatId &&
    event.workspaceId === activeChat.workspaceId
  );
}

/** Text staged in the composer by "Ask Aiden to change this". */
export function workspaceArtifactChangeRequest(view: WorkspaceArtifactView): string {
  return `Update the "${view.artifact.visual.title}" artifact (id ${view.artifact.id}): `;
}
