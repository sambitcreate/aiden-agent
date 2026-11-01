/**
 * Run one command hook: JSON payload on stdin, a minimal environment, a
 * deadline and an output cap, then interpret the exit code and output with
 * Claude Code's protocol.
 *
 * - Exit 0: stdout that looks like JSON is parsed as structured output;
 *   other stdout is context for SessionStart and UserPromptSubmit only.
 * - Exit 2: block, with stderr as the reason.
 * - Any other exit, a timeout or the output cap: an error that fails open,
 *   except a `failClosed` PreToolUse hook, which denies.
 */

import * as path from "node:path";
import { runBoundedShellCommand, type BoundedShellCommandOptions, type BoundedShellCommandResult } from "../bounded-shell-command.js";
import { clampHookTimeout, toolInputFile } from "./hook-config.js";
import type { HookDefinition, HookEvent, HookPayload, HookPermissionDecision } from "./hook-types.js";

export const HOOK_OUTPUT_LIMIT_BYTES = 64 * 1024;
const EXCERPT_CHARS = 2_000;

const BASE_ENV_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL"] as const;
const FALLBACK_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface HookEnvInput {
  event: HookEvent;
  /** The project directory: the workspace root or the Bot's folder. */
  projectDir: string;
  sessionId: string;
  /** Absolute path of the file the tool call touches, when there is one. */
  file?: string;
  envAllow?: readonly string[];
}

/**
 * The environment a hook runs with. Only a fixed allowlist is copied from
 * the host, plus names the hook lists in `envAllow` (part of its digest).
 * Tokens such as GH_TOKEN never reach a hook unless it names them.
 */
export function buildHookEnv(base: NodeJS.ProcessEnv, input: HookEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE_ENV_NAMES) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  env.PATH ??= FALLBACK_PATH;
  env.LANG ??= "en_US.UTF-8";
  for (const name of input.envAllow ?? []) {
    const value = base[name];
    if (typeof value === "string" && !(name in env)) env[name] = value;
  }
  env.AIDEN_PROJECT_DIR = input.projectDir;
  env.CLAUDE_PROJECT_DIR = input.projectDir;
  env.AIDEN_HOOK_EVENT = input.event;
  env.AIDEN_SESSION_ID = input.sessionId;
  if (input.file) env.AIDEN_HOOK_FILE = input.file;
  return env;
}

export type ShellRunner = (options: BoundedShellCommandOptions) => Promise<BoundedShellCommandResult>;

export interface HookRunInput {
  hook: Pick<HookDefinition, "event" | "handler">;
  payload: HookPayload;
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
  /** Host environment the allowlist is copied from. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  shell?: ShellRunner;
  now?: () => number;
}

export interface HookRawRun {
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  /** The command could not be started at all. */
  spawnError?: string;
}

export async function runHookCommand(input: HookRunInput): Promise<HookRawRun> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const file = toolInputFile(input.payload.tool_input);
  const env = buildHookEnv(input.baseEnv ?? process.env, {
    event: input.hook.event,
    projectDir: input.cwd,
    sessionId: input.sessionId,
    file: file ? path.resolve(input.cwd, file) : undefined,
    envAllow: input.hook.handler.envAllow,
  });
  try {
    const result = await (input.shell ?? runBoundedShellCommand)({
      command: input.hook.handler.command,
      cwd: input.cwd,
      env,
      timeoutMs: clampHookTimeout(input.hook.handler.timeout, input.hook.handler.async) * 1000,
      maxOutputBytes: HOOK_OUTPUT_LIMIT_BYTES,
      signal: input.signal,
      input: JSON.stringify(input.payload),
    });
    return { startedAt, durationMs: Math.max(0, now() - startedAt), ...result };
  } catch (error) {
    return {
      startedAt,
      durationMs: Math.max(0, now() - startedAt),
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: false,
      aborted: false,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One hook's answer, after applying the protocol for its event. */
export interface HookHandlerResult {
  result: "ok" | "blocked" | "asked" | "error";
  /** PreToolUse only. */
  decision?: HookPermissionDecision;
  /** Exit 2 or `decision: "block"` (PostToolUse, UserPromptSubmit, Stop, SubagentStop). */
  block?: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  stopTurn?: boolean;
  stopReason?: string;
  systemMessage?: string;
  /** Why the run counts as a failure, for the notice and health counters. */
  error?: string;
  excerpt: string;
}

const PLAIN_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["SessionStart", "UserPromptSubmit"]);
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(["PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]);

function excerptOf(run: HookRawRun): string {
  const text = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join("\n");
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPermissionDecision(value: unknown): value is HookPermissionDecision {
  return value === "allow" || value === "deny" || value === "ask";
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Apply Claude Code's exit-code and output protocol to one finished run. */
export function interpretHookRun(event: HookEvent, run: HookRawRun, handler: { failClosed?: boolean }): HookHandlerResult {
  const excerpt = excerptOf(run);
  const failure =
    run.spawnError !== undefined
      ? `could not start: ${run.spawnError}`
      : run.aborted
        ? "was cancelled"
        : run.timedOut
          ? "timed out"
          : run.outputLimitExceeded
            ? "printed more output than Aiden allows"
            : run.exitCode !== 0 && run.exitCode !== 2
              ? `exited with code ${run.exitCode ?? "unknown"}`
              : undefined;
  if (failure !== undefined) {
    if (event === "PreToolUse" && handler.failClosed && !run.aborted) {
      return { result: "error", decision: "deny", reason: `The hook ${failure}, and it is set to block when it fails.`, error: failure, excerpt };
    }
    return { result: "error", error: failure, excerpt };
  }
  if (run.exitCode === 2) {
    const reason = run.stderr.trim() || "Blocked by hook.";
    if (event === "PreToolUse") return { result: "blocked", decision: "deny", reason, excerpt };
    if (BLOCKING_EVENTS.has(event)) return { result: "blocked", block: true, reason, excerpt };
    // Events that can not block: the reason is shown to the person only.
    return { result: "ok", systemMessage: reason, excerpt };
  }
  const output = parseJsonObject(run.stdout);
  if (!output) {
    const text = run.stdout.trim();
    return PLAIN_CONTEXT_EVENTS.has(event) && text ? { result: "ok", additionalContext: text, excerpt } : { result: "ok", excerpt };
  }
  const parsed: HookHandlerResult = { result: "ok", excerpt };
  const specific =
    output.hookSpecificOutput && typeof output.hookSpecificOutput === "object" && !Array.isArray(output.hookSpecificOutput)
      ? (output.hookSpecificOutput as Record<string, unknown>)
      : {};
  const reason = stringField(specific, "permissionDecisionReason") ?? stringField(output, "reason");
  const context = stringField(specific, "additionalContext");
  if (context) parsed.additionalContext = context;
  const systemMessage = stringField(output, "systemMessage");
  if (systemMessage) parsed.systemMessage = systemMessage;
  if (output.continue === false) {
    parsed.stopTurn = true;
    parsed.stopReason = stringField(output, "stopReason");
  }
  if (event === "PreToolUse") {
    const legacy = output.decision === "approve" ? "allow" : output.decision === "block" ? "deny" : undefined;
    const decision = isPermissionDecision(specific.permissionDecision) ? specific.permissionDecision : legacy;
    if (decision) {
      parsed.decision = decision;
      parsed.result = decision === "deny" ? "blocked" : decision === "ask" ? "asked" : "ok";
      if (reason) parsed.reason = reason;
    }
    const updated = specific.updatedInput;
    if (updated && typeof updated === "object" && !Array.isArray(updated)) parsed.updatedInput = updated as Record<string, unknown>;
  } else if (BLOCKING_EVENTS.has(event) && output.decision === "block") {
    parsed.block = true;
    parsed.result = "blocked";
    parsed.reason = reason ?? "Blocked by hook.";
  }
  return parsed;
}
