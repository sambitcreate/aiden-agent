/**
 * Parse and validate Claude-compatible hook configuration:
 *
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…" }] }] } }
 *
 * Nothing is dropped silently: unknown events, non-`command` handlers, an
 * event that never runs in the file's scope and other fields Aiden does not
 * implement come back as listings with status `unsupported` and a reason.
 * Pure; no filesystem access.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { compileHookMatcher } from "./hook-matcher.js";
import {
  HOOK_EVENTS,
  HOOK_EVENT_SCOPE_KINDS,
  type HookCommandHandler,
  type HookDefinition,
  type HookEvent,
  type HookListing,
  type HookScope,
} from "./hook-types.js";

export { aidenToolInput, aidenToolName, claudeToolInput, claudeToolName, toolInputFile, toolNameSpellings } from "./hook-aliases.js";

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_TIMEOUT_SECONDS = 120;
/** `async: true` hooks run in the background, so they may run longer. */
export const MAX_ASYNC_HOOK_TIMEOUT_SECONDS = 600;
export const MAX_AGENT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_COMMAND_LENGTH = 4096;
export const MAX_HOOK_ENV_ALLOW = 32;
/** Hooks per configuration file; more are reported, not loaded. */
export const MAX_HOOKS_PER_FILE = 200;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
/** Variables Aiden sets for every run; `envAllow` can not override them. */
export const RESERVED_HOOK_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "USER",
  "SHELL",
  "AIDEN_PROJECT_DIR",
  "AIDEN_HOOK_EVENT",
  "AIDEN_SESSION_ID",
  "AIDEN_HOOK_FILE",
  "CLAUDE_PROJECT_DIR",
]);

const HANDLER_KEYS = new Set(["type", "command", "timeout", "async", "failClosed", "envAllow", "statusMessage"]);
const GROUP_KEYS = new Set(["matcher", "hooks"]);

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}

const SCOPE_PHRASES: Record<HookScope["kind"], string> = {
  global: "everywhere",
  workspace: "a workspace",
  chat: "a chat",
  bot: "a Bot",
};

/**
 * Why `event` never fires for a hook saved in `scope`, or undefined when it
 * can. See `HOOK_EVENT_SCOPE_KINDS`.
 */
export function hookEventScopeProblem(event: HookEvent, scope: Pick<HookScope, "kind">): string | undefined {
  const kinds = HOOK_EVENT_SCOPE_KINDS[event];
  if (kinds.includes(scope.kind)) return undefined;
  const where = kinds.filter((kind) => kind !== "global").map((kind) => SCOPE_PHRASES[kind]);
  const list = where.length <= 1 ? where.join("") : `${where.slice(0, -1).join(", ")} or ${where[where.length - 1]}`;
  return `${event} hooks never run for ${SCOPE_PHRASES[scope.kind]}; save it globally or for ${list}.`;
}

/** Normalized workspace root: absolute, no trailing separator. */
export function normalizeWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

export function normalizeHookScope(scope: HookScope): HookScope {
  return scope.kind === "workspace" ? { kind: "workspace", workspaceRoot: normalizeWorkspaceRoot(scope.workspaceRoot) } : scope;
}

/** Exact, stable key for persistence and digests. */
export function hookScopeKey(scope: HookScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "workspace":
      return `workspace:${normalizeWorkspaceRoot(scope.workspaceRoot)}`;
    case "chat":
      return `chat:${scope.chatId}`;
    case "bot":
      return `bot:${scope.botId}`;
  }
}

export function hookScopesEqual(a: HookScope, b: HookScope): boolean {
  return hookScopeKey(a) === hookScopeKey(b);
}

/**
 * The scopes that apply to one run, in dispatch order global → workspace →
 * bot → chat. Callers pass this as `HookDispatchContext.scopes`.
 */
export function hookScopesFor(input: { workspaceRoot?: string | null; botId?: string | null; chatId?: string | null }): HookScope[] {
  const scopes: HookScope[] = [{ kind: "global" }];
  if (input.workspaceRoot) scopes.push({ kind: "workspace", workspaceRoot: normalizeWorkspaceRoot(input.workspaceRoot) });
  if (input.botId) scopes.push({ kind: "bot", botId: input.botId });
  if (input.chatId) scopes.push({ kind: "chat", chatId: input.chatId });
  return scopes;
}

/** Short id-safe token for a scope, used in hook ids. */
export function hookScopeIdPart(scope: HookScope): string {
  if (scope.kind === "global") return "global";
  return `${scope.kind}-${createHash("sha256").update(hookScopeKey(scope)).digest("hex").slice(0, 12)}`;
}

/** The longest a handler may run: 600 seconds for `async` hooks, 120 otherwise. */
export function maxHookTimeoutSeconds(async: boolean | undefined): number {
  return async === true ? MAX_ASYNC_HOOK_TIMEOUT_SECONDS : MAX_HOOK_TIMEOUT_SECONDS;
}

export function clampHookTimeout(seconds: number | undefined, async?: boolean): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_HOOK_TIMEOUT_SECONDS;
  return Math.min(maxHookTimeoutSeconds(async), seconds);
}

/**
 * sha256 over everything that decides what a hook does: event, matcher,
 * command, timeout, failClosed, async, the sorted envAllow names and the
 * scope (which also fixes its working directory). Any change needs
 * re-approval. `async` is folded in only when set, so approvals of hooks
 * saved before it existed keep their digest.
 */
export function hookDigest(input: { event: string; matcher: string; handler: HookCommandHandler; scope: HookScope; configuredType?: string }): string {
  const canonical = JSON.stringify({
    v: 1,
    event: input.event,
    matcher: input.matcher,
    type: input.configuredType ?? input.handler.type,
    command: input.handler.command,
    timeout: clampHookTimeout(input.handler.timeout, input.handler.async),
    failClosed: input.handler.failClosed === true,
    ...(input.handler.async === true ? { async: true } : {}),
    envAllow: [...new Set(input.handler.envAllow ?? [])].sort(),
    scope: hookScopeKey(input.scope),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const RUNNERS = new Set(["npx", "bunx", "node", "bun", "deno", "bash", "sh", "zsh", "python", "python3", "uv", "uvx", "ruby", "perl", "pnpm", "npm", "yarn", "exec", "env"]);

/** A short display name from the command: `~/.aiden/hooks/guard-shell.sh` → `guard-shell`. */
/**
 * Control and text-direction characters (tabs and newlines aside), which can
 * make a command or name read differently from what runs: the same set the
 * approval cards refuse.
 */
// eslint-disable-next-line no-control-regex -- matching these characters is the point
const UNSAFE_DISPLAY_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/u;

function displayableName(name: string | undefined): string | undefined {
  const cleaned = name?.replace(new RegExp(UNSAFE_DISPLAY_CHARACTER.source, "gu"), "").trim().slice(0, 60);
  return cleaned ? cleaned : undefined;
}

export function defaultHookName(command: string): string {
  const tokens = command.trim().split(/\s+/u).map((token) => token.replace(/^["']|["']$/gu, ""));
  let token = tokens[0] ?? "";
  for (let index = 0; index < tokens.length - 1 && (RUNNERS.has(path.basename(token)) || token.includes("=")); index += 1) {
    const next = tokens[index + 1];
    if (!next || next.startsWith("-")) break;
    token = next;
  }
  const base = path.basename(token).replace(/\.[A-Za-z0-9]{1,5}$/u, "");
  const name = base.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (name || "hook").slice(0, 40);
}

export type HandlerValidation =
  | { ok: true; handler: HookCommandHandler; warnings: string[] }
  | { ok: false; reason: string; configuredType: string; command: string };

function describeType(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

/** Validate one handler object. `maxTimeout` lets agent proposals use a lower ceiling. */
export function validateHookHandler(raw: unknown, options: { maxTimeoutSeconds?: number } = {}): HandlerValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The hook is not an object.", configuredType: "unknown", command: "" };
  }
  const record = raw as Record<string, unknown>;
  const configuredType = describeType(record.type);
  const commandText = typeof record.command === "string" ? record.command : "";
  const fail = (reason: string): HandlerValidation => ({ ok: false, reason, configuredType, command: commandText });
  if (record.type !== "command") {
    return fail(
      record.type === undefined
        ? "The hook has no type; Aiden runs only \"command\" hooks."
        : `"${configuredType}" hooks are not supported in Aiden; only "command" hooks run.`,
    );
  }
  if (record.async !== undefined && typeof record.async !== "boolean") return fail("async must be true or false.");
  const isAsync = record.async === true;
  const unknown = Object.keys(record).filter((key) => !HANDLER_KEYS.has(key));
  if (unknown.length > 0) return fail(`Unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  if (!commandText.trim()) return fail("The hook has no command.");
  if (commandText.length > MAX_HOOK_COMMAND_LENGTH) return fail(`The command is longer than ${MAX_HOOK_COMMAND_LENGTH} characters.`);
  if (commandText.includes("\0")) return fail("The command contains a NUL character.");
  if (UNSAFE_DISPLAY_CHARACTER.test(commandText)) {
    return fail("The command contains a control or text-direction character, which could hide what it runs.");
  }
  const warnings: string[] = [];
  let timeout: number | undefined;
  if (record.timeout !== undefined) {
    if (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0) {
      return fail("The timeout must be a positive number of seconds.");
    }
    const maximum = maxHookTimeoutSeconds(isAsync);
    const ceiling = Math.min(options.maxTimeoutSeconds ?? maximum, maximum);
    if (options.maxTimeoutSeconds !== undefined && record.timeout > ceiling) {
      return fail(`The timeout can be at most ${ceiling} seconds.`);
    }
    timeout = Math.min(record.timeout, maximum);
    if (record.timeout > maximum) {
      warnings.push(`The timeout was lowered to Aiden's maximum of ${maximum} seconds${isAsync ? " for async hooks" : ""}.`);
    }
  }
  if (record.failClosed !== undefined && typeof record.failClosed !== "boolean") return fail("failClosed must be true or false.");
  if (isAsync && record.failClosed === true) return fail("An async hook can not be failClosed: Aiden does not wait for it.");
  let envAllow: string[] | undefined;
  if (record.envAllow !== undefined) {
    if (!Array.isArray(record.envAllow) || record.envAllow.some((name) => typeof name !== "string" || !ENV_NAME.test(name))) {
      return fail("envAllow must be a list of environment variable names.");
    }
    const names = [...new Set(record.envAllow as string[])];
    if (names.length > MAX_HOOK_ENV_ALLOW) return fail(`envAllow can name at most ${MAX_HOOK_ENV_ALLOW} variables.`);
    const reserved = names.filter((name) => RESERVED_HOOK_ENV_NAMES.has(name));
    if (reserved.length > 0) return fail(`envAllow can not name variables Aiden sets: ${reserved.join(", ")}.`);
    envAllow = names.sort();
  }
  const handler: HookCommandHandler = { type: "command", command: commandText };
  if (timeout !== undefined) handler.timeout = timeout;
  if (isAsync) handler.async = true;
  if (record.failClosed === true) handler.failClosed = true;
  if (envAllow && envAllow.length > 0) handler.envAllow = envAllow;
  return { ok: true, handler, warnings };
}

export interface ParsedHooksFile {
  /** Every handler found, supported or not. Status is `unsupported` or `waiting-for-approval` (trust decides the rest). */
  hooks: HookListing[];
  /** File-level problems: not JSON, wrong shape, too many hooks. */
  problems: string[];
  /** Non-blocking notes, e.g. a lowered timeout. */
  warnings: string[];
}

export interface ParseHooksOptions {
  scope: HookScope;
  source: HookDefinition["source"];
  /** Id prefix; ids are `${idPrefix}:${event}:${group}.${handler}`. */
  idPrefix: string;
}

/** Parse a whole `{ "hooks": { … } }` document (already JSON-decoded). */
function unknownEventReason(configuredEvent: string): string {
  if (configuredEvent === "WorktreeCreate") {
    return "Claude Code's WorktreeCreate replaces how a worktree is created, which Aiden doesn't support. Aiden's WorktreeSetup runs after it creates one.";
  }
  return `"${configuredEvent}" is not an event Aiden supports.`;
}

export function parseHooksConfig(raw: unknown, options: ParseHooksOptions): ParsedHooksFile {
  const result: ParsedHooksFile = { hooks: [], problems: [], warnings: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    result.problems.push("The hooks file must be a JSON object with a \"hooks\" field.");
    return result;
  }
  const document = raw as Record<string, unknown>;
  const ignored = Object.keys(document).filter((key) => key !== "hooks" && key !== "$schema");
  if (ignored.length > 0) result.warnings.push(`Ignored top-level field${ignored.length === 1 ? "" : "s"}: ${ignored.join(", ")}.`);
  const events = document.hooks;
  if (events === undefined) return result;
  if (!events || typeof events !== "object" || Array.isArray(events)) {
    result.problems.push("\"hooks\" must be an object keyed by event name.");
    return result;
  }
  const scope = normalizeHookScope(options.scope);
  for (const [configuredEvent, groups] of Object.entries(events as Record<string, unknown>)) {
    const known = isHookEvent(configuredEvent);
    if (!Array.isArray(groups)) {
      result.problems.push(`"${configuredEvent}" must be a list of matcher groups.`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const groupRecord = group && typeof group === "object" && !Array.isArray(group) ? (group as Record<string, unknown>) : undefined;
      const matcher = typeof groupRecord?.matcher === "string" ? groupRecord.matcher : "";
      const handlers = Array.isArray(groupRecord?.hooks) ? (groupRecord.hooks as unknown[]) : undefined;
      if (!groupRecord || !handlers) {
        result.problems.push(`"${configuredEvent}" group ${groupIndex + 1} needs a "hooks" list.`);
        return;
      }
      let groupReason: string | undefined;
      if (groupRecord.matcher !== undefined && typeof groupRecord.matcher !== "string") groupReason = "The matcher must be a string.";
      const extraGroupKeys = Object.keys(groupRecord).filter((key) => !GROUP_KEYS.has(key));
      if (!groupReason && extraGroupKeys.length > 0) groupReason = `Unsupported field${extraGroupKeys.length === 1 ? "" : "s"}: ${extraGroupKeys.join(", ")}.`;
      if (!groupReason) {
        const compiled = compileHookMatcher(matcher);
        if (!compiled.ok) groupReason = compiled.reason;
      }
      handlers.forEach((rawHandler, handlerIndex) => {
        if (result.hooks.length >= MAX_HOOKS_PER_FILE) {
          if (!result.problems.some((problem) => problem.startsWith("More than"))) {
            result.problems.push(`More than ${MAX_HOOKS_PER_FILE} hooks; the rest were not loaded.`);
          }
          return;
        }
        const id = `${options.idPrefix}:${configuredEvent}:${groupIndex}.${handlerIndex}`;
        const validation = validateHookHandler(rawHandler);
        const reason = !known
          ? unknownEventReason(configuredEvent)
          : groupReason ?? (validation.ok ? hookEventScopeProblem(configuredEvent, scope) : validation.reason);
        const handler: HookCommandHandler = validation.ok ? validation.handler : { type: "command", command: validation.command };
        const configuredType = validation.ok ? "command" : validation.configuredType;
        if (validation.ok) result.warnings.push(...validation.warnings);
        const listing: HookListing = {
          id,
          name: defaultHookName(handler.command || configuredType),
          event: known ? configuredEvent : "unknown",
          configuredEvent,
          configuredType,
          matcher,
          handler,
          scope,
          source: options.source,
          digest: hookDigest({ event: configuredEvent, matcher, handler, scope, configuredType }),
          status: reason ? "unsupported" : "waiting-for-approval",
        };
        if (reason) listing.unsupportedReason = reason;
        result.hooks.push(listing);
      });
    });
  }
  return result;
}

/** Parse JSON text; a syntax error becomes a problem rather than a throw. */
export function parseHooksConfigText(text: string, options: ParseHooksOptions): ParsedHooksFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { hooks: [], problems: [`The hooks file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
  return parseHooksConfig(raw, options);
}

/** Build a definition for a single handler (Settings or agent entries). */
export function hookDefinitionFor(input: {
  id: string;
  name?: string;
  event: HookEvent;
  matcher?: string;
  handler: HookCommandHandler;
  scope: HookScope;
  source: HookDefinition["source"];
}): HookDefinition {
  const scope = normalizeHookScope(input.scope);
  const matcher = input.matcher ?? "";
  return {
    id: input.id,
    name: displayableName(input.name) ?? defaultHookName(input.handler.command),
    event: input.event,
    matcher,
    handler: input.handler,
    scope,
    source: input.source,
    digest: hookDigest({ event: input.event, matcher, handler: input.handler, scope }),
  };
}
