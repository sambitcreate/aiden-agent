import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import {
  workspaceArtifactCommandAccess,
  workspaceArtifactDataJson,
  workspaceArtifactSourceAccess,
  type WorkspaceArtifactSourceAccess,
  type WorkspaceArtifactRevisionSummary,
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

type ArtifactWorkspace = { permission: WorkspacePermission; folderPath?: string } | null;

function workspaceAccess(workspace: ArtifactWorkspace) {
  return { permission: workspace?.permission ?? "none", hasFolder: Boolean(workspace?.folderPath) };
}

function accessInputs(view: WorkspaceArtifactView, workspace: ArtifactWorkspace) {
  return { ...workspaceAccess(workspace), approved: view.artifact.approvedDigest === view.digest };
}

/**
 * Whether restoring an earlier version would leave its commands waiting for
 * the person to allow them. Only Ask waits: Full runs them and Off, or a
 * workspace without a folder, runs nothing either way.
 */
export function workspaceArtifactRevisionWaitsForApproval(
  entry: WorkspaceArtifactRevisionSummary,
  workspace: ArtifactWorkspace,
): boolean {
  const { permission, hasFolder } = workspaceAccess(workspace);
  return entry.needsApproval && workspaceArtifactCommandAccess(permission, hasFolder, false) === "needs-approval";
}

/**
 * What an imported page's commands would do once added here. An import is
 * never approved, so under Ask they wait to be allowed; Full runs them and
 * Off, or a workspace without a folder, runs nothing.
 */
export function workspaceArtifactImportAccess(workspace: ArtifactWorkspace): WorkspaceArtifactSourceAccess {
  const { permission, hasFolder } = workspaceAccess(workspace);
  return workspaceArtifactCommandAccess(permission, hasFolder, false);
}

/**
 * What the page may run right now, from the workspace's access and whether
 * the person approved these exact commands. Null when it runs nothing.
 */
export function workspaceArtifactPageAccess(
  view: WorkspaceArtifactView,
  workspace: ArtifactWorkspace,
): WorkspaceArtifactSourceAccess | null {
  const { sources, actions } = view.artifact;
  if (sources.length === 0 && actions.length === 0) return null;
  const { permission, hasFolder, approved } = accessInputs(view, workspace);
  const states = sources.map((source) => workspaceArtifactSourceAccess(permission, hasFolder, source, approved));
  if (actions.length > 0) states.push(workspaceArtifactCommandAccess(permission, hasFolder, approved));
  if (states.includes("blocked")) return "blocked";
  if (states.includes("needs-approval")) return "needs-approval";
  return "run";
}

/**
 * Whether a refresh would read anything now. Under Ask, file sources load
 * before the page's commands are approved, so a page can refresh while its
 * buttons still wait.
 */
export function workspaceArtifactCanRefresh(view: WorkspaceArtifactView, workspace: ArtifactWorkspace): boolean {
  const { permission, hasFolder, approved } = accessInputs(view, workspace);
  return view.artifact.sources.some((source) => workspaceArtifactSourceAccess(permission, hasFolder, source, approved) === "run");
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

/** A New page suggestion: the chip's label, and the words it puts in the field. */
export interface WorkspaceArtifactPageIdea {
  label: string;
  subject: string;
}

/** Ideas the New page dialog offers. Each subject reads naturally after "shows". */
export const WORKSPACE_ARTIFACT_PAGE_IDEAS: readonly WorkspaceArtifactPageIdea[] = [
  { label: "Open pull requests", subject: "this repository's open pull requests" },
  { label: "CI status on main", subject: "CI status on main" },
  { label: "TODO board from TODO.md", subject: "a TODO board from TODO.md" },
  { label: "Release checklist", subject: "a release checklist" },
];

/**
 * The chat request a New page dialog drafts from what the person wants the
 * page to show, in their own words. Empty when there is nothing to ask for.
 */
export function workspaceArtifactNewPageRequest(subject: string): string {
  const words = subject.trim();
  if (!words) return "";
  return `Make a workspace artifact page that shows ${words}${/[.?!]$/u.test(words) ? "" : "."}`;
}
