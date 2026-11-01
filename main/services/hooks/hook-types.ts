/**
 * Shared contract for Aiden hooks: owner-approved shell commands that run at
 * agent lifecycle points. The schema follows Claude Code's hooks format so
 * existing scripts work unchanged. See docs/plans/aiden-hooks-plan.md.
 *
 * Hooks can only tighten what a chat may do. They block, ask or add context;
 * an `allow` never grants more than a remembered approval scope could.
 */

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "Notification",
  "PreCompact",
  "WorktreeSetup",
  "RoutineRun",
  "RoutineFailed",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Where a hook is configured. `global` is edited only from Settings. */
export type HookScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceRoot: string }
  | { kind: "chat"; chatId: string }
  | { kind: "bot"; botId: string };

/**
 * The scope kinds each event is ever dispatched with, read from the dispatch
 * sites: workspace chats (desktop and `aiden serve`) pass global, workspace
 * and chat; Bots, their routines and their subagents pass global and bot;
 * WorktreeSetup passes global and the source workspace. A hook saved for any
 * other pair could never run, so proposals and Settings refuse it.
 */
export const HOOK_EVENT_SCOPE_KINDS: Readonly<Record<HookEvent, readonly HookScope["kind"][]>> = {
  PreToolUse: ["global", "workspace", "chat", "bot"],
  PostToolUse: ["global", "workspace", "chat", "bot"],
  UserPromptSubmit: ["global", "workspace", "chat"],
  SessionStart: ["global", "workspace", "chat", "bot"],
  SessionEnd: ["global", "workspace", "chat"],
  Stop: ["global", "workspace", "chat", "bot"],
  SubagentStop: ["global", "workspace", "chat", "bot"],
  Notification: ["global", "workspace", "chat"],
  PreCompact: ["global", "workspace", "chat", "bot"],
  WorktreeSetup: ["global", "workspace"],
  RoutineRun: ["global", "bot"],
  RoutineFailed: ["global", "bot"],
};

export interface HookCommandHandler {
  type: "command";
  command: string;
  /** Seconds. Default 30, maximum 120 (600 for `async` hooks; 30 when proposed by the agent). */
  timeout?: number;
  /**
   * Claude-compatible: start the command and do not wait for it. Its decision,
   * blocking and context output are ignored; the run is logged and a
   * `systemMessage` is shown as a notice. Part of the digest.
   */
  async?: boolean;
  /** PreToolUse only: a crash or timeout blocks the tool instead of failing open. */
  failClosed?: boolean;
  /** Extra environment variable names passed through; part of the digest. */
  envAllow?: string[];
}

export interface HookMatcherGroup {
  /** Claude matcher semantics: exact `a|b` list for `[A-Za-z0-9_\- ,|]`, else an anchored regex. Empty or `*` matches all. */
  matcher?: string;
  hooks: HookCommandHandler[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

/** One hook after parsing: a single handler with its event, matcher and scope. */
export interface HookDefinition {
  /** Stable id: `${scopeKey}:${event}:${index}` style, stable across reloads of the same file. */
  id: string;
  /** Short human name shown in tool rows and Settings (defaults from the command). */
  name: string;
  event: HookEvent;
  matcher: string;
  handler: HookCommandHandler;
  scope: HookScope;
  /** Where it was read from, for display only. */
  source: "settings" | "workspace-file" | "agent" | "bot";
  /** sha256 over event, matcher, command, cwd policy, envAllow, timeout and failClosed. */
  digest: string;
}

export type HookStatus =
  | "active"
  | "waiting-for-approval"
  | "changed"
  | "disabled"
  | "disabled-after-failures"
  | "unsupported";

export interface HookListing extends Omit<HookDefinition, "event"> {
  /** `unknown` when the file names an event Aiden does not support; see `configuredEvent`. */
  event: HookEvent | "unknown";
  /** The event name exactly as configured. */
  configuredEvent: string;
  /** The handler type as configured (`command`, or an unsupported `http`, `prompt`…). */
  configuredType: string;
  status: HookStatus;
  /** Why it is unsupported, when it is. */
  unsupportedReason?: string;
  lastRun?: HookRunRecord;
  /**
   * Workspace hooks: the workspace files folded into the digest, relative to
   * the workspace root. A file edit changes the digest and the hook waits for
   * approval again.
   */
  scriptFiles?: string[];
  /**
   * `partial` when the command also runs something Aiden can not follow to a
   * file (a `cd … &&`, `source`, `bash -c`, `npx`, `npm run`, `python -m`,
   * `make`…): editing what that runs does not change the digest.
   */
  scriptCoverage?: "partial";
}

export type HookPermissionDecision = "allow" | "deny" | "ask";

/** Payload written to the hook's stdin as JSON. Claude-compatible field names. */
export interface HookPayload {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  /** Claude spelling (`Bash`, `Edit`…) when an alias exists, else the Aiden name. */
  tool_name?: string;
  aiden_tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  source?: "startup" | "resume" | "compact";
  stop_hook_active?: boolean;
  message?: string;
  trigger?: "manual" | "auto";
  [extra: string]: unknown;
}

/** Combined result of every matching hook for one event. Strictest wins: deny > ask > allow. */
export interface HookOutcome {
  /** PreToolUse; undefined means no hook expressed a decision. */
  decision?: HookPermissionDecision;
  /** Reason shown to the person and the model for deny/ask, attributed to hook names. */
  reason?: string;
  /** PreToolUse: replacement input for non-shell tools only. Never applied to `run_command`. */
  updatedInput?: Record<string, unknown>;
  /** UserPromptSubmit: refuse the prompt. */
  blockPrompt?: boolean;
  /** Stop/SubagentStop: keep the turn going with `reason` as the next instruction. */
  continueTurn?: boolean;
  /** Already fenced with fenceAsData and capped; safe to put in model context. */
  additionalContext?: string;
  /** Names of hooks that ran, for the tool row. */
  ranHooks: string[];
  /** `reason` fenced with fenceAsData, for model-facing text (a tool error, a continuation). */
  reasonForModel?: string;
  /** PostToolUse: a hook flagged the tool result (`decision: "block"` or exit 2); `reason` says why. */
  flaggedResult?: boolean;
  /** A hook returned `continue: false`: end the turn now, showing `stopReason` to the person. */
  stopTurn?: boolean;
  stopReason?: string;
  /** `systemMessage` text from hooks, shown to the person only, attributed to the hook. */
  systemMessages?: string[];
  /** Aiden's own notices for the person, e.g. a hook that failed open. */
  notices?: string[];
}

export interface HookRunRecord {
  hookId: string;
  event: HookEvent;
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  /** Capped excerpt, display only. */
  outputExcerpt: string;
  result: "ok" | "blocked" | "asked" | "error";
}

export interface HookDispatchContext {
  /** Every scope that applies to this run, in order global → workspace → bot → chat. */
  scopes: HookScope[];
  /** Working directory for the command (workspace root, or the Bot's folder). */
  cwd: string;
  sessionId: string;
  /** Idempotency key so a durable replay never re-runs a hook: event + chat + tool-call id. */
  idempotencyKey?: string;
  /** Ends this dispatch's own hooks. `async` hooks run on and are not stopped by it. */
  signal?: AbortSignal;
  /**
   * Where the lines from this dispatch's `async` hooks go once they finish
   * (their `systemMessage` and Aiden's notices), for the person only, never
   * the model. Without it they reach only the hook's run log.
   */
  reportAsync?: (lines: string[]) => void;
}

export interface HookDispatcher {
  dispatch(event: HookEvent, payload: HookPayload, context: HookDispatchContext): Promise<HookOutcome>;
  /** True when at least one active hook could match; lets callers skip building payloads. */
  hasHooks(event: HookEvent, scopes: HookScope[], toolName?: string): boolean;
}
