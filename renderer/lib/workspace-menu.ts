// Pure rules behind the draft workspace menu (composer chip, headline name and
// the New chat in… palette): which workspaces it lists, what a typed path row
// offers, and how clone outcomes read. No React, IPC or DOM here.

import { defaultFilter } from "cmdk";
import type { Workspace } from "./types";
import type { NewChatWorkspaceChoice } from "./new-chat-workspaces";
import type {
  WorkspaceCloneFailureCode,
  WorkspaceCloneProgress,
  WorkspaceCloneResult,
  WorkspacePathInspection,
} from "../shared/workspace-intake";

/** How many workspaces the menu lists before offering "All workspaces (n)". */
export const RECENT_WORKSPACE_LIMIT = 5;

/** A typed query is a path when it starts like one: `/…`, `~…` or `.…`. */
export function isWorkspacePathQuery(query: string): boolean {
  return /^[/~.]/u.test(query.trim());
}

export interface WorkspaceMenuList {
  heading: "Recent" | "All workspaces" | "Matches";
  rows: NewChatWorkspaceChoice[];
  /** Total workspace count for the "All workspaces (n)" row; 0 hides the row. */
  allCount: number;
}

/**
 * The workspace rows the menu shows for a query. Empty query: the most recent
 * few (all of them once expanded). A search matches every workspace by name or
 * folder, best match first. A path query lists none: the path row answers it.
 */
export function workspaceMenuList(
  choices: readonly NewChatWorkspaceChoice[],
  { query, expanded, limit = RECENT_WORKSPACE_LIMIT }: { query: string; expanded: boolean; limit?: number },
): WorkspaceMenuList {
  const search = query.trim();
  if (search && isWorkspacePathQuery(search)) return { heading: "Matches", rows: [], allCount: 0 };
  if (search) {
    // Best match first; equal scores keep recency order (the sort is stable).
    const rows = choices
      .map((choice) => ({
        choice,
        score: defaultFilter(`${choice.workspace.name} ${choice.workspace.folderPath ?? ""}`, search),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ choice }) => choice);
    return { heading: "Matches", rows, allCount: 0 };
  }
  if (expanded || choices.length <= limit) {
    return { heading: expanded ? "All workspaces" : "Recent", rows: [...choices], allCount: 0 };
  }
  return { heading: "Recent", rows: choices.slice(0, limit), allCount: choices.length };
}

/** What choosing the row for a typed path does. */
export type WorkspacePathRow =
  | { action: "select"; input: string; workspaceId: string; path: string; label: string; detail: string }
  | { action: "open"; input: string; path: string; label: string; detail?: string }
  | { action: "create"; input: string; path: string; label: string }
  | { action: "invalid"; input: string; message: string };

/** Map a main-process inspection of `input` to the row the menu shows. */
export function workspacePathRow(
  input: string,
  inspection: WorkspacePathInspection,
  workspaces: readonly Pick<Workspace, "id" | "name">[],
): WorkspacePathRow {
  switch (inspection.kind) {
    case "existing-workspace": {
      const name = workspaces.find((workspace) => workspace.id === inspection.workspaceId)?.name;
      return {
        action: "select",
        input,
        workspaceId: inspection.workspaceId,
        path: inspection.path,
        label: name ?? inspection.path,
        detail: "Already a workspace",
      };
    }
    case "folder":
      return {
        action: "open",
        input,
        path: inspection.path,
        label: `Open ${inspection.path}`,
        ...(inspection.isGitRepo ? { detail: "Git repository" } : {}),
      };
    case "creatable":
      return {
        action: "create",
        input,
        path: inspection.path,
        label: `Create folder and open ${inspection.path}`,
      };
    case "invalid":
      return { action: "invalid", input, message: inspection.reason };
  }
}

const CLONE_FAILURE_FALLBACK: Readonly<Record<WorkspaceCloneFailureCode, string>> = {
  "invalid-url": "Enter an https:// or SSH repository URL, or owner/repo for GitHub.",
  "invalid-destination": "Choose a different destination folder.",
  "destination-exists": "That destination already exists. Choose another folder.",
  busy: "That folder is already being cloned.",
  cancelled: "Clone cancelled.",
  timeout: "The clone took too long and was stopped.",
  "auth-failed": "Git couldn't sign in. Check your Git credentials or SSH key for that host.",
  "host-key": "The host's SSH key isn't trusted yet. Connect to it once from Terminal, then try again.",
  "not-found": "That repository wasn't found, or you don't have access to it.",
  network: "Git couldn't reach that host. Check the URL and your connection.",
  "git-unavailable": "Git isn't available on this Mac.",
  failed: "Git couldn't clone that repository.",
  "register-failed": "The repository was cloned, but Aiden couldn't add it as a workspace.",
};

/**
 * The inline message for a failed clone, or `null` when the user cancelled it
 * (nothing went wrong, so nothing is shown). Main's sentence wins; the code's
 * fallback covers an empty one. A clone that landed on disk but could not be
 * registered says where it is, so the user can open it with Open folder….
 */
export function cloneFailureMessage(
  result: Extract<WorkspaceCloneResult<unknown>, { ok: false }>,
): string | null {
  if (result.code === "cancelled") return null;
  const reason = result.reason.trim() || CLONE_FAILURE_FALLBACK[result.code];
  if (result.code === "register-failed" && result.destination) {
    return `${reason} It is in ${result.destination}.`;
  }
  return reason;
}

/** "Receiving objects · 42%", or "Cloning…" before Git reports a phase. */
export function cloneProgressLabel(progress: Pick<WorkspaceCloneProgress, "phase" | "percent"> | null): string {
  if (!progress?.phase) return "Cloning…";
  return progress.percent === undefined
    ? progress.phase
    : `${progress.phase} · ${Math.round(Math.min(100, Math.max(0, progress.percent)))}%`;
}

/** A fresh clone id that satisfies main's `[A-Za-z0-9_-]{8,64}` routing contract. */
export function newCloneId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return `clone_${randomUUID().replace(/[^A-Za-z0-9]/gu, "")}`.slice(0, 64);
}

/**
 * Why a draft can't change workspace right now, or undefined when it can.
 * Every way into the workspace menu (chip, headline, palette Clone, ⌘⇧O)
 * shares this: a draft being sent must not be retargeted mid-send.
 */
export function workspaceChangeBusyReason(state: {
  sending: boolean;
  generating: boolean;
  gitBusy: boolean;
}): string | undefined {
  if (state.sending) return "Wait for the message to finish sending before changing workspaces.";
  if (state.generating) return "Stop the current response before changing workspaces.";
  if (state.gitBusy) return "Wait for the current Git operation to finish before switching workspaces.";
  return undefined;
}
