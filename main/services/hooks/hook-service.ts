/**
 * The hooks management API: listing, proposals and approvals, enable and
 * pause switches, test runs and the run log. It also owns the dispatcher
 * that the rest of Aiden reaches through `getHookDispatcher()`.
 *
 * Trust model: a hook runs only when the owner approved its exact digest.
 * Owner edits made in Settings are approved as they are saved; an agent may
 * only propose, and a proposal changes nothing until the owner approves it.
 * A repo's `.aiden/hooks.json` is read and listed, never written, and each of
 * its hooks waits for approval; an edit to an approved one shows as changed.
 * A workspace hook's digest also covers the in-workspace script files its
 * command runs (see hook-script-files.ts), read from the folder it runs in,
 * so editing or swapping a script stops the hook until it is approved again.
 * The files are read again just before the command starts, so a script
 * swapped after the check refuses to run instead of running unapproved code.
 * A command whose scripts can't all be checked (too many words or files, or
 * a file over the size cap) is unsupported; one that also runs something the
 * scan can't follow (`npm run`, `bash -c`, `cd`…) is listed as partial.
 */

import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createHookDispatcher, normalizeHookPayload, type AidenHookDispatcher, type HookRunFunction } from "./hook-dispatcher.js";
import { claudeToolName } from "./hook-aliases.js";
import {
  hookDefinitionFor,
  hookDigest,
  hookEventScopeProblem,
  hookScopeKey,
  hookScopesEqual,
  isHookEvent,
  MAX_AGENT_HOOK_TIMEOUT_SECONDS,
  normalizeHookScope,
  clampHookTimeout,
  validateHookHandler,
} from "./hook-config.js";
import { compileHookMatcher, matcherMatchesTool, matcherMatchesValue } from "./hook-matcher.js";
import { mergeHookResults } from "./hook-merge.js";
import { interpretHookRun, runHookCommand, type HookHandlerResult, type HookRawRun, type ShellRunner } from "./hook-runner.js";
import { digestWithScriptFiles, hookScriptFiles, type HookScriptScan } from "./hook-script-files.js";
import {
  HookEntryStore,
  listingDefinition,
  readWorkspaceHooksFile,
  storedEntryListing,
  workspaceFileIdPrefix,
  type StoredHookEntry,
  type WorkspaceHooksFile,
} from "./hook-store.js";
import { HookTrustStore } from "./hook-trust-store.js";
import type {
  HookCommandHandler,
  HookDefinition,
  HookEvent,
  HookListing,
  HookOutcome,
  HookPayload,
  HookRunRecord,
  HookScope,
} from "./hook-types.js";

export const MAX_PENDING_HOOK_PROPOSALS = 50;
export const HOOK_PROPOSAL_TTL_MS = 60 * 60 * 1000;

export type HookOrigin = "agent" | "owner";

export interface HookServiceDeps {
  /** Profile folder for `hooks.json` and `hooks-trust.json`. */
  root: () => string;
  now?: () => number;
  /** Host environment: `AIDEN_HOOKS=0` turns every hook off, and the runner copies its allowlist from here. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for hooks outside a workspace (test runs of global, chat and Bot hooks). */
  homeDir?: () => string;
  /** Replaces the real command runner, for tests. */
  run?: HookRunFunction;
  /** Replaces the shell under the real runner, for tests. */
  shell?: ShellRunner;
  readWorkspaceFile?: (workspaceRoot: string) => Promise<WorkspaceHooksFile>;
  randomId?: () => string;
}

export interface HookProposalInput {
  scope: HookScope;
  event: string;
  matcher?: string;
  /** A Claude-style handler object, validated here: `{ type: "command", command, timeout?, failClosed?, envAllow? }`. */
  handler?: unknown;
  name?: string;
  /** Edit or delete this stored hook instead of adding one. */
  existingId?: string;
  delete?: boolean;
  /** Default `agent`: no global scope and a 30 second timeout ceiling. */
  origin?: HookOrigin;
}

export interface HookProposal {
  id: string;
  origin: HookOrigin;
  action: "create" | "update" | "delete";
  /** The hook this creates, changes or deletes. */
  hookId: string;
  /** What will run (for delete, what stops running). */
  definition: HookDefinition;
  digest: string;
  /** One or two plain sentences for the approval card. */
  summary: string;
  warnings: string[];
  /** Workspace files the approval also covers, relative to the workspace root. */
  scriptFiles?: string[];
  /** `partial` when the command also runs something Aiden can't follow to a file. */
  scriptCoverage?: "partial";
  /** For an update or delete: the stored hook's digest when the card was built, so approval can't overwrite a version the owner never saw. */
  targetDigest?: string;
  createdAt: number;
  expiresAt: number;
}

export type HookResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface HookWorkspaceFileStatus {
  workspaceRoot: string;
  present: boolean;
  problems: string[];
  warnings: string[];
}

export interface HookList {
  hooks: HookListing[];
  /** Pause-all switch from Settings. */
  paused: boolean;
  /** `AIDEN_HOOKS=0` in the environment. */
  disabledByEnvironment: boolean;
  workspaceFiles: HookWorkspaceFileStatus[];
}

export interface HookDraft {
  scope: HookScope;
  event: HookEvent;
  matcher?: string;
  handler: HookCommandHandler;
  name?: string;
}

/** A saved hook to test, with the digest the owner was shown. */
export interface HookTestTarget {
  hookId: string;
  digest: string;
}

export interface HookTestResult {
  hookId?: string;
  /** False when the matcher would skip the fixture; the hook ran anyway. */
  matched: boolean;
  payload: HookPayload;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  result: HookHandlerResult;
  /** What Aiden would do with this answer. */
  outcome: HookOutcome;
}

export type HookChangeReason = "hooks" | "proposals" | "run" | "auto-disabled";

export interface HookChange {
  reason: HookChangeReason;
  hookId?: string;
}

export interface HookService {
  readonly dispatcher: AidenHookDispatcher;
  /**
   * Read the profile's hook store. Throws when it exists but can't be read;
   * until a later load succeeds, tool calls are denied, Settings changes are
   * refused rather than overwriting it, and every use tries loading again.
   */
  load(): Promise<void>;
  flush(): Promise<void>;
  /** Hooks in `scopes` (all known scopes when omitted), each with its current status and last run. */
  listHooks(scopes?: readonly HookScope[]): Promise<HookList>;
  proposeHook(input: HookProposalInput): Promise<HookResult<HookProposal>>;
  listProposals(): HookProposal[];
  approveProposal(proposalId: string): Promise<HookResult<HookListing | undefined>>;
  rejectProposal(proposalId: string): boolean;
  /** Owner shortcut for Settings: propose as the owner and approve at once. */
  saveHook(input: Omit<HookProposalInput, "origin">): Promise<HookResult<HookListing | undefined>>;
  /** Approve the hook's current digest, only when it is still the digest the owner was shown. */
  approveDigest(hookId: string, expectedDigest: string): Promise<HookResult<HookListing>>;
  /** Turn a hook off or back on. Returns false when there is no such hook. */
  setEnabled(hookId: string, enabled: boolean): Promise<boolean>;
  /** Removes a stored hook. A repo hook stays in its file but loses its approval. */
  deleteHook(hookId: string): Promise<HookResult<void>>;
  setPaused(paused: boolean): Promise<void>;
  /**
   * Run one hook against a fixture without changing its health or run log.
   * This executes the command, so call it only for an explicit owner action.
   * A saved hook runs only when `digest` is still its current digest, so a
   * Test press never runs a command the owner wasn't shown.
   */
  testHook(target: HookTestTarget | HookDraft, fixturePayload?: Partial<HookPayload>): Promise<HookResult<HookTestResult>>;
  getRunLog(hookId: string): HookRunRecord[];
  onChange(listener: (change: HookChange) => void): () => void;
}

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse"]);

function workspaceRootOf(scope: HookScope): string | undefined {
  return scope.kind === "workspace" ? scope.workspaceRoot : undefined;
}

function describeScope(scope: HookScope): string {
  switch (scope.kind) {
    case "global":
      return "in every chat";
    case "workspace":
      return `in the workspace ${scope.workspaceRoot}`;
    case "chat":
      return "in this chat";
    case "bot":
      return "for this Bot";
  }
}

function describeTrigger(event: HookEvent, matcher: string): string {
  const compiled = compileHookMatcher(matcher);
  const all = !compiled.ok || compiled.matcher.kind === "all";
  const list = compiled.ok && compiled.matcher.kind === "list" ? compiled.matcher.names : undefined;
  const tools = all ? "every tool call" : list ? `${[...list].map((name) => claudeToolName(name)).join(", ")} calls` : `tool calls matching /${matcher}/`;
  switch (event) {
    case "PreToolUse":
      return `before ${tools}`;
    case "PostToolUse":
      return `after ${tools}`;
    case "UserPromptSubmit":
      return "when a message is sent";
    case "SessionStart":
      return all ? "when a chat starts" : `when a chat starts (${matcher})`;
    case "SessionEnd":
      return "when a chat ends";
    case "Stop":
      return "when Aiden finishes a reply";
    case "SubagentStop":
      return "when a subagent finishes";
    case "Notification":
      return "when Aiden sends a notification";
    case "PreCompact":
      return "before the conversation is compacted";
    case "WorktreeSetup":
      return "after Aiden sets up a worktree";
    case "RoutineRun":
      return "when a routine runs";
    case "RoutineFailed":
      return "when a routine fails";
  }
}

/** Plain summary for an approval card, e.g. `Runs "./guard.sh" before Bash calls in this chat.` */
export function summarizeHook(definition: Pick<HookDefinition, "event" | "matcher" | "handler" | "scope">): string {
  const command = definition.handler.command.length > 200 ? `${definition.handler.command.slice(0, 200)}…` : definition.handler.command;
  const parts = [`Runs "${command}" ${describeTrigger(definition.event, definition.matcher)} ${describeScope(definition.scope)}.`];
  const details = [`Stops after ${clampHookTimeout(definition.handler.timeout, definition.handler.async)} s`];
  if (definition.handler.async) details.push("runs in the background; Aiden doesn't wait for it");
  if (definition.event === "PreToolUse") details.push(definition.handler.failClosed ? "blocks the tool if it fails" : "lets the tool run if it fails");
  if (definition.handler.envAllow?.length) details.push(`can read ${definition.handler.envAllow.join(", ")}`);
  parts.push(`${details.join("; ")}.`);
  return parts.join(" ");
}

/** A realistic sample payload for each event, used by test runs. */
export function hookFixturePayload(event: HookEvent, cwd: string): HookPayload {
  const base = { hook_event_name: event, session_id: "hook-test", cwd };
  switch (event) {
    case "PreToolUse":
      return { ...base, tool_name: "Bash", aiden_tool_name: "run_command", tool_input: { command: "echo hello", description: "Print hello" } };
    case "PostToolUse":
      return {
        ...base,
        tool_name: "Bash",
        aiden_tool_name: "run_command",
        tool_input: { command: "echo hello", description: "Print hello" },
        tool_response: { stdout: "hello\n", stderr: "", exitCode: 0 },
      };
    case "UserPromptSubmit":
      return { ...base, prompt: "Summarize the open pull requests." };
    case "SessionStart":
      return { ...base, source: "startup" };
    case "SessionEnd":
      return { ...base, reason: "other" };
    case "Stop":
    case "SubagentStop":
      return { ...base, stop_hook_active: false };
    case "Notification":
      return { ...base, message: "Aiden needs your approval to run a command.", notification_type: "permission_prompt" };
    case "PreCompact":
      return { ...base, trigger: "manual", custom_instructions: "" };
    case "WorktreeSetup":
      return { ...base, worktree_path: path.join(cwd, ".aiden", "worktrees", "example"), branch: "aiden/example" };
    case "RoutineRun":
      return { ...base, routine_id: "routine-example", routine_name: "Morning summary" };
    case "RoutineFailed":
      return { ...base, routine_id: "routine-example", routine_name: "Morning summary", error: "The model provider was unavailable." };
  }
}

function fixtureMatches(definition: HookDefinition, payload: HookPayload): boolean {
  const compiled = compileHookMatcher(definition.matcher);
  if (!compiled.ok) return false;
  if (TOOL_EVENTS.has(definition.event)) {
    const tool = payload.aiden_tool_name ?? payload.tool_name;
    return compiled.matcher.kind === "all" || (tool !== undefined && matcherMatchesTool(compiled.matcher, tool));
  }
  if (definition.event === "SessionStart") return matcherMatchesValue(compiled.matcher, payload.source);
  if (definition.event === "PreCompact") return matcherMatchesValue(compiled.matcher, payload.trigger);
  if (definition.event === "Notification") {
    return matcherMatchesValue(compiled.matcher, typeof payload.notification_type === "string" ? payload.notification_type : undefined);
  }
  return true;
}

/** How many repo hooks' scripts are read at once. */
const REPO_SCAN_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function uncheckableScriptsReason(overLimit: string): string {
  return `Aiden can't check everything this command runs (${overLimit}), so it won't run it; move the commands into one script.`;
}

const CHAT_HOOK_SCRIPTS_WARNING =
  "Approving this chat hook covers its command text only. A script it runs isn't checked, so an edit to that script won't stop the hook; point it at a file outside any repo the agent can edit.";

function partialCoverageWarning(unfollowed: readonly string[]): string {
  const list = unfollowed.map((item) => `\`${item}\``).join(", ");
  return `Approving this doesn't cover what ${list} runs: Aiden can't follow it to a file, so an edit there won't stop the hook. Point the hook at a script file to cover it.`;
}

/** The refusal recorded when a workspace hook's scripts changed between the check and the start. */
export const HOOK_SCRIPTS_CHANGED_ERROR = "a script it runs changed after Aiden checked it, so it didn't run";

/**
 * Wraps a runner so a workspace hook's script files are read again just
 * before the command starts. If they no longer match the approved digest
 * (or can no longer all be checked) the command does not start; the run
 * reports a start failure, which a failClosed PreToolUse hook turns into a
 * deny. Other scopes run unchanged.
 */
export function recheckScriptsBeforeRun(run: HookRunFunction, now: () => number = Date.now): HookRunFunction {
  return async (hook, payload, context) => {
    const root = workspaceRootOf(hook.scope);
    if (!root) return run(hook, payload, context);
    let unchanged = false;
    try {
      const scan = await hookScriptFiles(hook.handler.command, { workspaceRoot: root, cwd: context.cwd });
      const base = hookDigest({ event: hook.event, matcher: hook.matcher, handler: hook.handler, scope: hook.scope });
      unchanged = !scan.overLimit && digestWithScriptFiles(base, scan.files) === hook.digest;
    } catch {
      unchanged = false;
    }
    if (unchanged) return run(hook, payload, context);
    return {
      startedAt: now(),
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: false,
      aborted: false,
      stdout: "",
      stderr: "",
      spawnError: HOOK_SCRIPTS_CHANGED_ERROR,
    };
  };
}

export function createHookService(deps: HookServiceDeps): HookService {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? (() => os.homedir());
  const readWorkspaceFile = deps.readWorkspaceFile ?? readWorkspaceHooksFile;
  const randomId = deps.randomId ?? (() => randomBytes(6).toString("hex"));
  const entries = new HookEntryStore(deps.root);
  const trust = new HookTrustStore(deps.root, now);
  const proposals = new Map<string, HookProposal>();
  const listeners = new Set<(change: HookChange) => void>();
  /** Repo hook id → its workspace root, learned whenever a repo file is read. */
  const repoHookRoots = new Map<string, string>();

  const disabledByEnvironment = () => env.AIDEN_HOOKS === "0";
  const hooksOff = () => disabledByEnvironment() || trust.paused;

  /**
   * Why the profile's hook store last failed to load, until a load succeeds.
   * While it is set nothing can say which hooks are approved, so tool calls
   * are denied (see the dispatcher), and every use tries loading again.
   */
  let loadError: Error | undefined;
  let loading: Promise<void> | undefined;
  const loadStores = (): Promise<void> => {
    loading ??= Promise.all([entries.load(), trust.load()])
      .then(
        () => {
          loadError = undefined;
        },
        (error: unknown) => {
          loadError = error instanceof Error ? error : new Error(String(error));
          throw loadError;
        },
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  /** Resolves once the store is loaded; retries a failed load and throws while it still fails. */
  const ensureLoaded = async (): Promise<void> => {
    if (loadError || loading) await loadStores();
  };

  const emit = (change: HookChange) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A listener must not break the service.
      }
    }
  };

  const runOne: HookRunFunction =
    deps.run ??
    ((hook, payload, context) =>
      runHookCommand({ hook, payload, cwd: context.cwd, sessionId: context.sessionId, signal: context.signal, baseEnv: env, shell: deps.shell, now }));

  const statusOf = (listing: HookListing): HookListing => {
    if (listing.status === "unsupported" || listing.event === "unknown") return listing;
    const verdict = trust.verdict(listing);
    let status: HookListing["status"];
    if (verdict !== "approved") status = verdict;
    else if (trust.isDisabledAfterFailures(listing)) status = "disabled-after-failures";
    else if (trust.isDisabled(listing)) status = "disabled";
    else status = "active";
    return { ...listing, status };
  };

  /**
   * Fold the script files a workspace hook runs into its digest, read from
   * `cwd` (the workspace root unless the hook runs elsewhere, as WorktreeSetup
   * hooks do in the new worktree). Other scopes have no fixed folder to read.
   */
  const scriptsOf = async (
    hook: Pick<HookDefinition, "scope" | "handler" | "digest">,
    cwd?: string,
  ): Promise<{ digest: string; scan?: HookScriptScan }> => {
    const root = workspaceRootOf(hook.scope);
    if (!root || typeof hook.handler?.command !== "string") return { digest: hook.digest };
    const scan = await hookScriptFiles(hook.handler.command, { workspaceRoot: root, cwd: cwd ?? root });
    return { digest: digestWithScriptFiles(hook.digest, scan.files), scan };
  };

  const withScripts = async (listing: HookListing, cwd?: string): Promise<HookListing> => {
    const { digest, scan } = await scriptsOf(listing, cwd);
    if (!scan) return listing;
    const next: HookListing = { ...listing, digest };
    if (scan.paths.length > 0) next.scriptFiles = scan.paths;
    if (scan.unfollowed.length > 0) next.scriptCoverage = "partial";
    if (scan.overLimit) {
      next.status = "unsupported";
      next.unsupportedReason = uncheckableScriptsReason(scan.overLimit);
    }
    return next;
  };

  /** A stored entry as a listing with its scripts folded in, before trust decides its status. */
  const storedListing = (entry: StoredHookEntry, cwd?: string): Promise<HookListing> => {
    const listing = storedEntryListing(entry);
    return listing.status === "unsupported" ? Promise.resolve(listing) : withScripts(listing, cwd);
  };

  /**
   * The repo file with its hooks' scripts folded in. `scan` limits which hooks
   * are read (the rest come back unscanned), and at most
   * REPO_SCAN_CONCURRENCY are read at once, so a large cloned hooks file
   * can't start hundreds of scans together.
   */
  const readRepo = async (
    workspaceRoot: string,
    cwd?: string,
    scan: (hook: HookListing) => boolean = () => true,
  ): Promise<WorkspaceHooksFile> => {
    let file: WorkspaceHooksFile;
    try {
      file = await readWorkspaceFile(workspaceRoot);
    } catch (error) {
      file = { present: true, unreadable: true, hooks: [], problems: [`The hooks file could not be read: ${(error as Error).message}`], warnings: [] };
    }
    for (const hook of file.hooks) repoHookRoots.set(hook.id, workspaceRoot);
    const hooks = await mapWithConcurrency(file.hooks, REPO_SCAN_CONCURRENCY, (hook) =>
      hook.status === "unsupported" || hook.event === "unknown" || !scan(hook) ? Promise.resolve(hook) : withScripts(hook, cwd),
    );
    return { ...file, hooks };
  };

  const repoHasApprovals = (scope: HookScope): boolean => {
    const root = workspaceRootOf(scope);
    if (!root) return false;
    const prefix = `${workspaceFileIdPrefix(root)}:`;
    return trust.approvalsFor(scope).some((record) => record.hookId.startsWith(prefix));
  };

  const storedListingsIn = async (scope: HookScope, cwd?: string): Promise<HookListing[]> =>
    (await Promise.all(entries.entries().filter((entry) => hookScopesEqual(entry.scope, scope)).map((entry) => storedListing(entry, cwd)))).map(statusOf);

  const dispatcher = createHookDispatcher({
    run: recheckScriptsBeforeRun(runOne, now),
    now,
    source: {
      async activeHooks(event, scopes, cwd) {
        if (disabledByEnvironment()) return [];
        await ensureLoaded();
        if (hooksOff()) return [];
        const active: HookDefinition[] = [];
        for (const rawScope of scopes) {
          const scope = normalizeHookScope(rawScope);
          // Scripts are read from where the hook will run, so a different copy
          // there (a swapped script in a new worktree) reads as changed.
          const listings = await storedListingsIn(scope, cwd);
          // The repo file is re-read on every fire once one of its hooks is approved,
          // so an edit is caught as `changed` and stops running at once. A file
          // that can no longer be read may still hold an approved guard, so it
          // fails like an unreadable store rather than reading as no hooks.
          if (repoHasApprovals(scope)) {
            // Only this event's hooks can run, so only their scripts are read.
            // Every one is scanned, not just those whose saved id still matches:
            // ids follow position, and approval follows the full digest, so a
            // hook moved within the file still runs.
            const eventApproved = trust.approvalsFor(scope).some((record) => record.event === event);
            const file = await readRepo(workspaceRootOf(scope) as string, cwd, (hook) => eventApproved && hook.event === event);
            if (file.unreadable) throw new Error(`.aiden/hooks.json could not be loaded: ${file.problems.join(" ")}`);
            listings.push(...file.hooks.map(statusOf));
          }
          for (const listing of listings) {
            if (listing.status !== "active" || listing.event !== event) continue;
            const definition = listingDefinition(listing);
            if (definition) active.push(definition);
          }
        }
        return active;
      },
      mayHaveActiveHooks(event, scopes, toolName) {
        if (disabledByEnvironment()) return false;
        // Hooks that could not load can't be ruled out; dispatching retries the load.
        if (loadError) return true;
        if (hooksOff()) return false;
        const matches = (matcher: string) => {
          if (!toolName || !TOOL_EVENTS.has(event)) return true;
          const compiled = compileHookMatcher(matcher);
          return compiled.ok && (compiled.matcher.kind === "all" || matcherMatchesTool(compiled.matcher, toolName));
        };
        return scopes.some((rawScope) => {
          const scope = normalizeHookScope(rawScope);
          return trust
            .approvalsFor(scope)
            .some((record) => {
              const flags = { scope, digest: record.digest };
              return record.event === event && !trust.isDisabled(flags) && !trust.isDisabledAfterFailures(flags) && matches(record.matcher);
            });
        });
      },
    },
    health: {
      recordSuccess: (hook) => trust.recordSuccess(hook),
      recordFailure: (hook, options) => trust.recordFailure(hook, options),
    },
    onRun: (hook) => emit({ reason: "run", hookId: hook.id }),
    onAutoDisabled: (hook) => emit({ reason: "auto-disabled", hookId: hook.id }),
  });

  const withLastRun = (listing: HookListing): HookListing => {
    const lastRun = dispatcher.lastRun(listing.id);
    return lastRun ? { ...listing, lastRun } : listing;
  };

  const knownScopes = (): HookScope[] => {
    const byKey = new Map<string, HookScope>([["global", { kind: "global" }]]);
    for (const entry of entries.entries()) byKey.set(hookScopeKey(entry.scope), entry.scope);
    for (const key of trust.approvedScopeKeys()) {
      if (key.startsWith("workspace:")) byKey.set(key, { kind: "workspace", workspaceRoot: key.slice("workspace:".length) });
    }
    for (const root of repoHookRoots.values()) byKey.set(`workspace:${root}`, { kind: "workspace", workspaceRoot: root });
    return [...byKey.values()];
  };

  /** The workspace a repo hook id belongs to: learned from a read, or matched against known workspaces. */
  const repoRootFor = (hookId: string): string | undefined => {
    const known = repoHookRoots.get(hookId);
    if (known) return known;
    if (!hookId.startsWith("repo:")) return undefined;
    for (const scope of knownScopes()) {
      const root = workspaceRootOf(scope);
      if (root && hookId.startsWith(`${workspaceFileIdPrefix(root)}:`)) return root;
    }
    return undefined;
  };

  /** A hook by id: stored entries first, then a repo file in a known workspace. */
  const findListing = async (hookId: string): Promise<{ listing: HookListing; entry?: StoredHookEntry } | undefined> => {
    const entry = entries.get(hookId);
    if (entry) return { listing: statusOf(await storedListing(entry)), entry };
    const root = repoRootFor(hookId);
    if (!root) return undefined;
    const listing = (await readRepo(root, undefined, (hook) => hook.id === hookId)).hooks.find((hook) => hook.id === hookId);
    return listing ? { listing: statusOf(listing) } : undefined;
  };

  /** Anything that changes which hooks may run also drops cached replay outcomes. */
  const changed = (change: HookChange) => {
    dispatcher.clearIdempotencyCache();
    emit(change);
  };

  const pruneProposals = () => {
    const time = now();
    for (const [id, proposal] of proposals) if (proposal.expiresAt <= time) proposals.delete(id);
  };

  const buildProposal = (input: HookProposalInput): HookResult<HookProposal> => {
    const origin: HookOrigin = input.origin ?? "agent";
    if (!input.scope || typeof input.scope !== "object") return { ok: false, reason: "A hook needs a scope." };
    if (input.scope.kind === "workspace" && !path.isAbsolute(input.scope.workspaceRoot ?? "")) {
      return { ok: false, reason: "A workspace hook needs an absolute workspace path." };
    }
    if ((input.scope.kind === "chat" && !input.scope.chatId) || (input.scope.kind === "bot" && !input.scope.botId)) {
      return { ok: false, reason: "A chat or Bot hook needs its id." };
    }
    const scope = normalizeHookScope(input.scope);
    if (origin === "agent" && scope.kind === "global") return { ok: false, reason: "Global hooks can only be added from Settings." };
    const existing = input.existingId ? entries.get(input.existingId) : undefined;
    if (input.existingId && !existing) {
      return {
        ok: false,
        reason: repoHookRoots.has(input.existingId)
          ? "Hooks in a repo's .aiden/hooks.json can't be edited from Aiden; change the file instead."
          : `There is no hook with the id ${input.existingId}.`,
      };
    }
    if (existing && !hookScopesEqual(existing.scope, scope)) return { ok: false, reason: "A hook can't be moved to another scope; add a new one instead." };
    if (existing && origin === "agent" && existing.scope.kind === "global") return { ok: false, reason: "Global hooks can only be changed from Settings." };
    const createdAt = now();
    const base = { id: `hp_${randomId()}`, origin, createdAt, expiresAt: createdAt + HOOK_PROPOSAL_TTL_MS };
    if (input.delete) {
      if (!existing) return { ok: false, reason: "Say which hook to delete." };
      const definition = storedEntryListingDefinition(existing);
      return {
        ok: true,
        value: { ...base, action: "delete", hookId: existing.id, definition, digest: definition.digest, targetDigest: definition.digest, summary: `Stops and deletes "${definition.name}". ${summarizeHook(definition)}`, warnings: [] },
      };
    }
    if (!isHookEvent(input.event)) return { ok: false, reason: `"${String(input.event)}" is not an event Aiden supports.` };
    const scopeProblem = hookEventScopeProblem(input.event, scope);
    if (scopeProblem) return { ok: false, reason: scopeProblem };
    const matcher = typeof input.matcher === "string" ? input.matcher : "";
    const compiled = compileHookMatcher(matcher);
    if (!compiled.ok) return { ok: false, reason: compiled.reason };
    const validation = validateHookHandler(input.handler, origin === "agent" ? { maxTimeoutSeconds: MAX_AGENT_HOOK_TIMEOUT_SECONDS } : {});
    if (!validation.ok) return { ok: false, reason: validation.reason };
    if (validation.handler.failClosed && input.event !== "PreToolUse") return { ok: false, reason: "failClosed applies only to PreToolUse hooks." };
    const hookId = existing?.id ?? `hk_${randomId()}`;
    const definition = hookDefinitionFor({
      id: hookId,
      name: input.name ?? existing?.name,
      event: input.event,
      matcher,
      handler: validation.handler,
      scope,
      // An edit keeps who added the hook: an approved agent edit of the owner's
      // hook must not make it one the agent may switch off.
      source: existing?.source ?? (origin === "agent" ? "agent" : scope.kind === "bot" ? "bot" : "settings"),
    });
    const summary = summarizeHook(definition);
    return {
      ok: true,
      value: {
        ...base,
        action: existing ? "update" : "create",
        hookId,
        ...(existing ? { targetDigest: storedEntryListingDefinition(existing).digest } : {}),
        definition,
        digest: definition.digest,
        summary: existing ? `Changes "${definition.name}". ${summary}` : summary,
        warnings: definition.handler.async
          ? [...validation.warnings, "It runs in the background: Aiden doesn't wait for it, so it can't block or change anything."]
          : validation.warnings,
      },
    };
  };

  const storedEntryListingDefinition = (entry: StoredHookEntry): HookDefinition => {
    const listing = storedEntryListing(entry);
    const { id, name, matcher, handler, scope, source, digest } = listing;
    return { id, name, event: entry.event, matcher, handler, scope, source, digest };
  };

  /**
   * The proposal with its scripts read now, so the card shows what approval
   * would trust. A command whose scripts can't all be checked is refused, and
   * one that runs something the scan can't follow says so.
   */
  const withProposalScripts = async (proposal: HookProposal): Promise<HookResult<HookProposal>> => {
    if (proposal.action === "delete") return { ok: true, value: proposal };
    const { digest, scan } = await scriptsOf(proposal.definition);
    if (!scan) {
      // A chat hook has no fixed folder, so nothing it runs is pinned: say so
      // on the card rather than let it look as covered as a workspace hook.
      if (proposal.definition.scope.kind !== "chat") return { ok: true, value: proposal };
      return {
        ok: true,
        value: { ...proposal, warnings: [...proposal.warnings, CHAT_HOOK_SCRIPTS_WARNING] },
      };
    }
    if (scan.overLimit) return { ok: false, reason: uncheckableScriptsReason(scan.overLimit) };
    const partial = scan.unfollowed.length > 0;
    const warnings = partial ? [...proposal.warnings, partialCoverageWarning(scan.unfollowed)] : proposal.warnings;
    return {
      ok: true,
      value: {
        ...proposal,
        definition: { ...proposal.definition, digest },
        digest,
        warnings,
        ...(scan.paths.length > 0 ? { scriptFiles: scan.paths } : {}),
        ...(partial ? { scriptCoverage: "partial" as const } : {}),
      },
    };
  };

  const applyProposal = async (proposal: HookProposal): Promise<HookResult<HookListing | undefined>> => {
    const existing = entries.get(proposal.hookId);
    // An update or delete applies only to the version its card showed; an edit
    // made since (in Settings or by another approved proposal) is never overwritten.
    if (existing && proposal.targetDigest !== undefined && storedEntryListingDefinition(existing).digest !== proposal.targetDigest) {
      return { ok: false, reason: "The hook changed since this proposal was shown; propose it again so the owner sees the current version." };
    }
    if (proposal.action === "delete") {
      if (!existing) return { ok: false, reason: "That hook was already deleted." };
      await entries.remove(proposal.hookId);
      await trust.revoke(storedEntryListing(existing));
      changed({ reason: "hooks", hookId: proposal.hookId });
      return { ok: true, value: undefined };
    }
    if (proposal.action === "update" && !existing) return { ok: false, reason: "The hook this proposal changes was deleted." };
    if (proposal.action === "create" && existing) return { ok: false, reason: "This proposal was already applied." };
    const { definition } = proposal;
    const current = await scriptsOf({ ...definition, digest: hookDefinitionFor(definition).digest });
    if (current.scan?.overLimit) return { ok: false, reason: uncheckableScriptsReason(current.scan.overLimit) };
    if (current.digest !== proposal.digest) {
      return { ok: false, reason: "A script this hook runs changed after it was proposed; propose it again so the owner sees the current version." };
    }
    const time = now();
    const entry: StoredHookEntry = {
      id: definition.id,
      name: definition.name,
      scope: definition.scope,
      event: definition.event,
      matcher: definition.matcher,
      handler: definition.handler,
      source: definition.source === "agent" ? "agent" : definition.source === "bot" ? "bot" : "settings",
      createdAt: existing?.createdAt ?? time,
      updatedAt: time,
    };
    await entries.upsert(entry);
    await trust.approve(definition);
    changed({ reason: "hooks", hookId: definition.id });
    return { ok: true, value: withLastRun(statusOf(await storedListing(entry))) };
  };

  return {
    dispatcher,

    load: loadStores,

    async flush() {
      await Promise.all([entries.flush(), trust.flush()]);
    },

    async listHooks(scopes) {
      await ensureLoaded();
      const targets = (scopes ?? knownScopes()).map(normalizeHookScope);
      const seen = new Set<string>();
      const hooks: HookListing[] = [];
      const workspaceFiles: HookWorkspaceFileStatus[] = [];
      for (const scope of targets) {
        const key = hookScopeKey(scope);
        if (seen.has(key)) continue;
        seen.add(key);
        hooks.push(...(await storedListingsIn(scope)).map(withLastRun));
        const root = workspaceRootOf(scope);
        if (root) {
          const file = await readRepo(root);
          hooks.push(...file.hooks.map((hook) => withLastRun(statusOf(hook))));
          workspaceFiles.push({ workspaceRoot: root, present: file.present, problems: file.problems, warnings: file.warnings });
        }
      }
      return { hooks, paused: trust.paused, disabledByEnvironment: disabledByEnvironment(), workspaceFiles };
    },

    async proposeHook(input) {
      await ensureLoaded();
      pruneProposals();
      const built = buildProposal(input);
      if (!built.ok) return built;
      const scripted = await withProposalScripts(built.value);
      if (!scripted.ok) return scripted;
      const proposal = scripted.value;
      if (proposals.size >= MAX_PENDING_HOOK_PROPOSALS) {
        const oldest = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) proposals.delete(oldest.id);
      }
      proposals.set(proposal.id, proposal);
      emit({ reason: "proposals" });
      return { ok: true, value: proposal };
    },

    listProposals() {
      pruneProposals();
      return [...proposals.values()];
    },

    async approveProposal(proposalId) {
      pruneProposals();
      const proposal = proposals.get(proposalId);
      if (!proposal) return { ok: false, reason: "That proposal expired or was already answered." };
      await ensureLoaded();
      proposals.delete(proposalId);
      emit({ reason: "proposals" });
      return applyProposal(proposal);
    },

    rejectProposal(proposalId) {
      const removed = proposals.delete(proposalId);
      if (removed) emit({ reason: "proposals" });
      return removed;
    },

    async saveHook(input) {
      await ensureLoaded();
      const built = buildProposal({ ...input, origin: "owner" });
      if (!built.ok) return built;
      const scripted = await withProposalScripts(built.value);
      return scripted.ok ? applyProposal(scripted.value) : scripted;
    },

    async approveDigest(hookId, expectedDigest) {
      await ensureLoaded();
      const found = await findListing(hookId);
      if (!found) return { ok: false, reason: `There is no hook with the id ${hookId}.` };
      const { listing } = found;
      if (listing.status === "unsupported") return { ok: false, reason: listing.unsupportedReason ?? "This hook is not supported." };
      if (typeof expectedDigest !== "string" || !expectedDigest) return { ok: false, reason: "Approving a hook needs the digest that was shown for it." };
      if (expectedDigest !== listing.digest) return { ok: false, reason: "The hook changed since it was shown; review it again." };
      const definition = listingDefinition(listing);
      if (!definition) return { ok: false, reason: "This hook is not supported." };
      // A repo hook's id is its position in the file; let an approval displaced by
      // an inserted hook follow the unchanged hook to its new place.
      const root = found.entry ? undefined : repoRootFor(hookId);
      await trust.approve(definition, root ? (await readRepo(root)).hooks : []);
      changed({ reason: "hooks", hookId });
      return { ok: true, value: withLastRun(statusOf(listing)) };
    },

    async setEnabled(hookId, enabled) {
      await ensureLoaded();
      const found = await findListing(hookId);
      if (!found) return false;
      await trust.setEnabled(found.listing, enabled);
      changed({ reason: "hooks", hookId });
      return true;
    },

    async deleteHook(hookId) {
      await ensureLoaded();
      const entry = entries.get(hookId);
      if (entry) {
        await entries.remove(hookId);
        await trust.revoke(await storedListing(entry));
        changed({ reason: "hooks", hookId });
        return { ok: true, value: undefined };
      }
      const found = await findListing(hookId);
      if (!found) return { ok: false, reason: `There is no hook with the id ${hookId}.` };
      const root = repoRootFor(hookId);
      await trust.revoke(found.listing, root ? (await readRepo(root)).hooks : []);
      changed({ reason: "hooks", hookId });
      return { ok: true, value: undefined };
    },

    async setPaused(paused) {
      await ensureLoaded();
      await trust.setPaused(paused);
      // Pausing also stops hooks still running in the background.
      if (paused) dispatcher.stopBackgroundHooks();
      changed({ reason: "hooks" });
    },

    async testHook(target, fixturePayload) {
      await ensureLoaded();
      if (disabledByEnvironment()) return { ok: false, reason: "AIDEN_HOOKS=0 turns hooks off, so Test didn't run anything." };
      if (trust.paused) return { ok: false, reason: "Hooks are paused, so Test didn't run anything. Resume them to test a hook." };
      let definition: HookDefinition | undefined;
      const saved = "hookId" in target ? target : undefined;
      if (saved) {
        const found = await findListing(saved.hookId);
        if (!found) return { ok: false, reason: `There is no hook with the id ${saved.hookId}.` };
        if (found.listing.status === "unsupported") return { ok: false, reason: found.listing.unsupportedReason ?? "This hook is not supported." };
        if (typeof saved.digest !== "string" || saved.digest !== found.listing.digest) {
          return { ok: false, reason: "The hook changed since it was shown; review it again before testing it." };
        }
        definition = listingDefinition(found.listing);
      } else if ("scope" in target) {
        const built = buildProposal({ ...target, origin: "owner" });
        if (!built.ok) return built;
        definition = { ...built.value.definition, id: "hook-test" };
      }
      if (!definition) return { ok: false, reason: "This hook is not supported." };
      const cwd = workspaceRootOf(definition.scope) ?? homeDir();
      const context = { scopes: [definition.scope], cwd, sessionId: "hook-test" };
      const payload = normalizeHookPayload(definition.event, { ...hookFixturePayload(definition.event, cwd), ...fixturePayload }, context);
      const raw: HookRawRun = await runOne(definition, payload, context);
      const result = interpretHookRun(definition.event, raw, definition.handler);
      return {
        ok: true,
        value: {
          ...(saved ? { hookId: saved.hookId } : {}),
          matched: fixtureMatches(definition, payload),
          payload,
          exitCode: raw.exitCode,
          timedOut: raw.timedOut,
          durationMs: raw.durationMs,
          stdout: raw.stdout,
          stderr: raw.stderr,
          result,
          outcome: mergeHookResults(definition.event, [{ hook: definition, result }], payload),
        },
      };
    },

    getRunLog(hookId) {
      return dispatcher.getRunLog(hookId);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
