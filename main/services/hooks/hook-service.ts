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
 */

import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createHookDispatcher, normalizeHookPayload, type AidenHookDispatcher, type HookRunFunction } from "./hook-dispatcher.js";
import { claudeToolName } from "./hook-aliases.js";
import {
  hookDefinitionFor,
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
  /** Approve the hook's current digest. Pass the digest the owner saw to refuse a hook that changed since. */
  approveDigest(hookId: string, expectedDigest?: string): Promise<HookResult<HookListing>>;
  setEnabled(hookId: string, enabled: boolean): Promise<void>;
  /** Removes a stored hook. A repo hook stays in its file but loses its approval. */
  deleteHook(hookId: string): Promise<HookResult<void>>;
  setPaused(paused: boolean): Promise<void>;
  /**
   * Run one hook against a fixture without changing its health or run log.
   * This executes the command, so call it only for an explicit owner action.
   */
  testHook(target: string | HookDraft, fixturePayload?: Partial<HookPayload>): Promise<HookResult<HookTestResult>>;
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
    case "WorktreeCreate":
      return "when a worktree is created";
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
  const details = [`Stops after ${clampHookTimeout(definition.handler.timeout)} s`];
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
    case "WorktreeCreate":
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
    else if (trust.isDisabled(listing.id)) status = "disabled";
    else status = "active";
    return { ...listing, status };
  };

  const readRepo = async (workspaceRoot: string): Promise<WorkspaceHooksFile> => {
    let file: WorkspaceHooksFile;
    try {
      file = await readWorkspaceFile(workspaceRoot);
    } catch (error) {
      file = { present: true, hooks: [], problems: [`The hooks file could not be read: ${(error as Error).message}`], warnings: [] };
    }
    for (const hook of file.hooks) repoHookRoots.set(hook.id, workspaceRoot);
    return file;
  };

  const repoHasApprovals = (scope: HookScope): boolean => {
    const root = workspaceRootOf(scope);
    if (!root) return false;
    const prefix = `${workspaceFileIdPrefix(root)}:`;
    return trust.approvalsFor(scope).some((record) => record.hookId.startsWith(prefix));
  };

  const storedListingsIn = (scope: HookScope): HookListing[] =>
    entries
      .entries()
      .filter((entry) => hookScopesEqual(entry.scope, scope))
      .map((entry) => statusOf(storedEntryListing(entry)));

  const dispatcher = createHookDispatcher({
    run: runOne,
    now,
    source: {
      async activeHooks(event, scopes) {
        if (hooksOff()) return [];
        const active: HookDefinition[] = [];
        for (const rawScope of scopes) {
          const scope = normalizeHookScope(rawScope);
          const listings = storedListingsIn(scope);
          // The repo file is re-read on every fire once one of its hooks is approved,
          // so an edit is caught as `changed` and stops running at once.
          if (repoHasApprovals(scope)) listings.push(...(await readRepo(workspaceRootOf(scope) as string)).hooks.map(statusOf));
          for (const listing of listings) {
            if (listing.status !== "active" || listing.event !== event) continue;
            const definition = listingDefinition(listing);
            if (definition) active.push(definition);
          }
        }
        return active;
      },
      mayHaveActiveHooks(event, scopes, toolName) {
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
            .some((record) => record.event === event && !trust.isDisabled(record.hookId) && !trust.isDisabledAfterFailures({ id: record.hookId, digest: record.digest }) && matches(record.matcher));
        });
      },
    },
    health: {
      recordSuccess: (hook) => trust.recordSuccess(hook.id),
      recordFailure: (hook) => trust.recordFailure(hook),
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

  /** A hook by id: stored entries first, then a repo file whose hooks were read before. */
  const findListing = async (hookId: string): Promise<{ listing: HookListing; entry?: StoredHookEntry } | undefined> => {
    const entry = entries.get(hookId);
    if (entry) return { listing: statusOf(storedEntryListing(entry)), entry };
    const root = repoHookRoots.get(hookId);
    if (!root) return undefined;
    const listing = (await readRepo(root)).hooks.find((hook) => hook.id === hookId);
    return listing ? { listing: statusOf(listing) } : undefined;
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
        value: { ...base, action: "delete", hookId: existing.id, definition, digest: definition.digest, summary: `Stops and deletes "${definition.name}". ${summarizeHook(definition)}`, warnings: [] },
      };
    }
    if (!isHookEvent(input.event)) return { ok: false, reason: `"${String(input.event)}" is not an event Aiden supports.` };
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
      source: origin === "agent" ? "agent" : scope.kind === "bot" ? "bot" : "settings",
    });
    const summary = summarizeHook(definition);
    return {
      ok: true,
      value: {
        ...base,
        action: existing ? "update" : "create",
        hookId,
        definition,
        digest: definition.digest,
        summary: existing ? `Changes "${definition.name}". ${summary}` : summary,
        warnings: validation.warnings,
      },
    };
  };

  const storedEntryListingDefinition = (entry: StoredHookEntry): HookDefinition => {
    const listing = storedEntryListing(entry);
    const { id, name, matcher, handler, scope, source, digest } = listing;
    return { id, name, event: entry.event, matcher, handler, scope, source, digest };
  };

  const applyProposal = async (proposal: HookProposal): Promise<HookResult<HookListing | undefined>> => {
    const existing = entries.get(proposal.hookId);
    if (proposal.action === "delete") {
      if (!existing) return { ok: false, reason: "That hook was already deleted." };
      await entries.remove(proposal.hookId);
      await trust.revoke(existing);
      emit({ reason: "hooks", hookId: proposal.hookId });
      return { ok: true, value: undefined };
    }
    if (proposal.action === "update" && !existing) return { ok: false, reason: "The hook this proposal changes was deleted." };
    if (proposal.action === "create" && existing) return { ok: false, reason: "This proposal was already applied." };
    const time = now();
    const { definition } = proposal;
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
    emit({ reason: "hooks", hookId: definition.id });
    return { ok: true, value: withLastRun(statusOf(storedEntryListing(entry))) };
  };

  return {
    dispatcher,

    async load() {
      await Promise.all([entries.load(), trust.load()]);
    },

    async flush() {
      await Promise.all([entries.flush(), trust.flush()]);
    },

    async listHooks(scopes) {
      const targets = (scopes ?? knownScopes()).map(normalizeHookScope);
      const seen = new Set<string>();
      const hooks: HookListing[] = [];
      const workspaceFiles: HookWorkspaceFileStatus[] = [];
      for (const scope of targets) {
        const key = hookScopeKey(scope);
        if (seen.has(key)) continue;
        seen.add(key);
        hooks.push(...storedListingsIn(scope).map(withLastRun));
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
      pruneProposals();
      const built = buildProposal(input);
      if (!built.ok) return built;
      if (proposals.size >= MAX_PENDING_HOOK_PROPOSALS) {
        const oldest = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) proposals.delete(oldest.id);
      }
      proposals.set(built.value.id, built.value);
      emit({ reason: "proposals" });
      return built;
    },

    listProposals() {
      pruneProposals();
      return [...proposals.values()];
    },

    async approveProposal(proposalId) {
      pruneProposals();
      const proposal = proposals.get(proposalId);
      if (!proposal) return { ok: false, reason: "That proposal expired or was already answered." };
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
      const built = buildProposal({ ...input, origin: "owner" });
      if (!built.ok) return built;
      return applyProposal(built.value);
    },

    async approveDigest(hookId, expectedDigest) {
      const found = await findListing(hookId);
      if (!found) return { ok: false, reason: `There is no hook with the id ${hookId}.` };
      const { listing } = found;
      if (listing.status === "unsupported") return { ok: false, reason: listing.unsupportedReason ?? "This hook is not supported." };
      if (expectedDigest && expectedDigest !== listing.digest) return { ok: false, reason: "The hook changed since it was shown; review it again." };
      const definition = listingDefinition(listing);
      if (!definition) return { ok: false, reason: "This hook is not supported." };
      await trust.approve(definition);
      emit({ reason: "hooks", hookId });
      return { ok: true, value: withLastRun(statusOf(listing)) };
    },

    async setEnabled(hookId, enabled) {
      await trust.setEnabled(hookId, enabled);
      emit({ reason: "hooks", hookId });
    },

    async deleteHook(hookId) {
      const entry = entries.get(hookId);
      if (entry) {
        await entries.remove(hookId);
        await trust.revoke(entry);
        emit({ reason: "hooks", hookId });
        return { ok: true, value: undefined };
      }
      const found = await findListing(hookId);
      if (!found) return { ok: false, reason: `There is no hook with the id ${hookId}.` };
      await trust.revoke(found.listing);
      emit({ reason: "hooks", hookId });
      return { ok: true, value: undefined };
    },

    async setPaused(paused) {
      await trust.setPaused(paused);
      emit({ reason: "hooks" });
    },

    async testHook(target, fixturePayload) {
      let definition: HookDefinition | undefined;
      if (typeof target === "string") {
        const found = await findListing(target);
        if (!found) return { ok: false, reason: `There is no hook with the id ${target}.` };
        if (found.listing.status === "unsupported") return { ok: false, reason: found.listing.unsupportedReason ?? "This hook is not supported." };
        definition = listingDefinition(found.listing);
      } else {
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
          ...(typeof target === "string" ? { hookId: target } : {}),
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
