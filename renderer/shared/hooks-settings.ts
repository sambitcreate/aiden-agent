// What Settings → Hooks reads over IPC, and the pure helpers its page uses to
// group and label hooks. The hook contract itself lives in
// main/services/hooks/hook-types.ts; this file only shapes it for display.

import { HOOK_EVENTS, type HookEvent, type HookListing, type HookRunRecord, type HookScope, type HookStatus } from "../../main/services/hooks/hook-types.js";
import type { HookProposal, HookTestResult, HookWorkspaceFileStatus } from "../../main/services/hooks/hook-service.js";

export { HOOK_EVENTS };
export type { HookEvent, HookListing, HookProposal, HookRunRecord, HookScope, HookStatus, HookTestResult, HookWorkspaceFileStatus };

/** Main → renderer: hooks, proposals, a run or an auto-disable changed. */
export const HOOKS_CHANGED_CHANNEL = "hooks:changed";

export interface HooksChangedEvent {
  reason: "hooks" | "proposals" | "run" | "auto-disabled";
  hookId?: string;
}

export interface HooksWorkspaceLabel {
  workspaceRoot: string;
  name: string;
}

export interface HooksOverview {
  /** False until the hook service has started; the page shows a quiet note. */
  available: boolean;
  hooks: HookListing[];
  /** The Pause all hooks switch. */
  paused: boolean;
  /** `AIDEN_HOOKS=0` turns every hook off for this launch. */
  disabledByEnvironment: boolean;
  workspaceFiles: HookWorkspaceFileStatus[];
  proposals: HookProposal[];
  /** Names for the workspace folders hooks can belong to, for group titles and the Add hook picker. */
  workspaces: HooksWorkspaceLabel[];
}

/** What the Add hook sheet sends. Main validates every field again. */
export interface HookSaveRequest {
  scope: { kind: "global" } | { kind: "workspace"; workspaceRoot: string };
  event: HookEvent;
  matcher?: string;
  command: string;
  /** Seconds, 1–120. */
  timeout?: number;
  /** PreToolUse only. */
  failClosed?: boolean;
  name?: string;
}

export const HOOK_DEFAULT_TIMEOUT_SECONDS = 30;
export const HOOK_MAX_TIMEOUT_SECONDS = 120;
export const HOOK_MAX_COMMAND_LENGTH = 4096;
export const HOOK_MAX_MATCHER_LENGTH = 500;
export const HOOK_MAX_NAME_LENGTH = 120;

/** Events whose matcher filters by tool name. Other events ignore the matcher. */
export const HOOK_TOOL_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["PreToolUse", "PostToolUse"]);

export const HOOK_EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: "Before a tool runs. Can block it or ask you first.",
  PostToolUse: "After a tool finishes. Can flag the result or add context.",
  UserPromptSubmit: "When you send a message. Can refuse it or add context.",
  SessionStart: "When a chat starts or resumes.",
  SessionEnd: "When a chat ends.",
  Stop: "When a reply finishes. Can ask the agent to keep going.",
  SubagentStop: "When a subagent finishes.",
  Notification: "When Aiden shows you a notice.",
  PreCompact: "Before a long chat is compacted.",
  WorktreeCreate: "When Aiden creates a worktree.",
  RoutineRun: "After a Bot routine run succeeds.",
  RoutineFailed: "When a Bot routine fails.",
};

export interface HookStatusPresentation {
  label: string;
  color: "green" | "warning" | "red" | "gray" | "blue";
}

export function hookStatusPresentation(listing: Pick<HookListing, "status">): HookStatusPresentation {
  switch (listing.status) {
    case "active":
      return { label: "Active", color: "green" };
    case "waiting-for-approval":
      return { label: "Waiting for approval", color: "blue" };
    case "changed":
      return { label: "Changed — re-approve", color: "warning" };
    case "disabled-after-failures":
      return { label: "Disabled after failures", color: "red" };
    case "unsupported":
      return { label: "Not supported in Aiden", color: "gray" };
    case "disabled":
      return { label: "Off", color: "gray" };
  }
}

/** True when the owner's approval is what stands between this hook and running. */
export function hookNeedsApproval(listing: Pick<HookListing, "status">): boolean {
  return listing.status === "waiting-for-approval" || listing.status === "changed";
}

/**
 * The trailing switch is on only for a hook that runs now. A hook waiting for
 * approval (or re-approval) shows off until the owner approves it, and one
 * Aiden turned off after failures shows off until the owner turns it back on.
 */
export function hookSwitchOn(listing: Pick<HookListing, "status">): boolean {
  return listing.status === "active";
}

/** The owner can flip the switch: not for unsupported hooks, and not before approval (Approve is the action). */
export function hookSwitchAvailable(listing: Pick<HookListing, "status">): boolean {
  return listing.status !== "unsupported" && !hookNeedsApproval(listing);
}

export function hookScopeKey(scope: HookScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "workspace":
      return `workspace:${scope.workspaceRoot}`;
    case "chat":
      return `chat:${scope.chatId}`;
    case "bot":
      return `bot:${scope.botId}`;
  }
}

function folderName(root: string): string {
  const parts = root.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

export function hookScopeLabel(scope: HookScope, workspaces: readonly HooksWorkspaceLabel[]): string {
  switch (scope.kind) {
    case "global":
      return "Global";
    case "workspace":
      return workspaces.find((workspace) => workspace.workspaceRoot === scope.workspaceRoot)?.name ?? folderName(scope.workspaceRoot);
    case "chat":
      return "Chat hooks";
    case "bot":
      return "Bot hooks";
  }
}

export interface HookScopeGroup {
  key: string;
  title: string;
  /** A second line under the title: the folder for a workspace, the id for a chat or Bot. */
  detail?: string;
  scope: HookScope;
  hooks: HookListing[];
  /** Problems reading the workspace's `.aiden/hooks.json`. */
  fileProblems: string[];
  fileWarnings: string[];
}

const SCOPE_ORDER: Record<HookScope["kind"], number> = { global: 0, workspace: 1, bot: 2, chat: 3 };

/**
 * One group per scope that has hooks (or a workspace file with problems),
 * in the order global → workspaces → Bots → chats. Hooks keep their order.
 */
export function groupHooksByScope(overview: Pick<HooksOverview, "hooks" | "workspaceFiles" | "workspaces">): HookScopeGroup[] {
  const groups = new Map<string, HookScopeGroup>();
  const groupFor = (scope: HookScope): HookScopeGroup => {
    const key = hookScopeKey(scope);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: hookScopeLabel(scope, overview.workspaces),
        detail:
          scope.kind === "workspace" ? scope.workspaceRoot : scope.kind === "chat" ? scope.chatId : scope.kind === "bot" ? scope.botId : undefined,
        scope,
        hooks: [],
        fileProblems: [],
        fileWarnings: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const hook of overview.hooks) groupFor(hook.scope).hooks.push(hook);
  for (const file of overview.workspaceFiles) {
    if (file.problems.length === 0 && file.warnings.length === 0) continue;
    const group = groupFor({ kind: "workspace", workspaceRoot: file.workspaceRoot });
    group.fileProblems.push(...file.problems);
    group.fileWarnings.push(...file.warnings);
  }
  return [...groups.values()].sort((a, b) => {
    const order = SCOPE_ORDER[a.scope.kind] - SCOPE_ORDER[b.scope.kind];
    return order !== 0 ? order : a.title.localeCompare(b.title);
  });
}

export function hookShortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export function hookMatcherLabel(listing: Pick<HookListing, "matcher" | "event">): string | undefined {
  if (listing.event !== "PreToolUse" && listing.event !== "PostToolUse") return undefined;
  const matcher = listing.matcher.trim();
  return matcher === "" || matcher === "*" ? "Every tool" : matcher;
}

/** Plain parse of the Add hook sheet's timeout field: blank is the default, else a whole number of seconds 1–120. */
export function parseHookTimeoutField(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/u.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return seconds >= 1 && seconds <= HOOK_MAX_TIMEOUT_SECONDS ? seconds : null;
}

export function isHooksOverview(value: unknown): value is HooksOverview {
  if (!value || typeof value !== "object") return false;
  const overview = value as Partial<HooksOverview>;
  return (
    typeof overview.available === "boolean" &&
    Array.isArray(overview.hooks) &&
    typeof overview.paused === "boolean" &&
    typeof overview.disabledByEnvironment === "boolean" &&
    Array.isArray(overview.workspaceFiles) &&
    Array.isArray(overview.proposals) &&
    Array.isArray(overview.workspaces)
  );
}
