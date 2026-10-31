// Settings → Hooks over IPC. Every argument is checked here before it reaches
// the hook service; `hooks:test` runs a command, so the renderer calls it only
// from the Test button.

import path from "node:path";
import { HOOK_EVENTS, type HookEvent, type HookListing, type HookScope } from "../services/hooks/hook-types.js";
import { MAX_HOOK_COMMAND_LENGTH, MAX_HOOK_TIMEOUT_SECONDS, normalizeWorkspaceRoot } from "../services/hooks/hook-config.js";
import type { HookChange, HookList, HookService } from "../services/hooks/hook-service.js";
import {
  HOOK_MAX_MATCHER_LENGTH,
  HOOK_MAX_NAME_LENGTH,
  type HooksOverview,
  type HooksWorkspaceLabel,
} from "../../renderer/shared/hooks-settings.js";

const MAX_ID_LENGTH = 300;
const DIGEST = /^[0-9a-f]{64}$/u;
// Ids, names and matchers are single lines; a command may span lines but never holds a NUL.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/u;

function invalid(): never {
  throw new Error("Invalid hooks request.");
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || CONTROL.test(value)) invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) invalid();
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function event(value: unknown): HookEvent {
  if (typeof value !== "string" || !(HOOK_EVENTS as readonly string[]).includes(value)) invalid();
  return value as HookEvent;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export interface HookHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Undefined until the service has started during launch. */
  service(): HookService | undefined;
  /** Folders a workspace hook may belong to, with display names. */
  workspaces(): Promise<HooksWorkspaceLabel[]>;
  /** Tell every window that hooks changed. */
  broadcast(change: HookChange): void;
  /** For the `AIDEN_HOOKS=0` note before the service has started. */
  env?: NodeJS.ProcessEnv;
}

export function registerHookHandlers<Event>(dependencies: HookHandlerDependencies<Event>): void {
  let subscribedTo: HookService | undefined;

  const ready = (): HookService => {
    const service = dependencies.service();
    if (!service) throw new Error("Hooks are still starting. Try again in a moment.");
    if (subscribedTo !== service) {
      subscribedTo = service;
      service.onChange((change) => dependencies.broadcast({ reason: change.reason, ...(change.hookId ? { hookId: change.hookId } : {}) }));
    }
    return service;
  };

  const knownWorkspaces = async (): Promise<HooksWorkspaceLabel[]> => {
    const seen = new Set<string>();
    const labels: HooksWorkspaceLabel[] = [];
    for (const workspace of await dependencies.workspaces()) {
      if (typeof workspace.workspaceRoot !== "string" || !path.isAbsolute(workspace.workspaceRoot)) continue;
      const workspaceRoot = normalizeWorkspaceRoot(workspace.workspaceRoot);
      if (seen.has(workspaceRoot)) continue;
      seen.add(workspaceRoot);
      labels.push({ workspaceRoot, name: workspace.name });
    }
    return labels;
  };

  dependencies.handle("hooks:list", async (): Promise<HooksOverview> => {
    const service = dependencies.service();
    if (!service) {
      return {
        available: false,
        hooks: [],
        paused: false,
        disabledByEnvironment: (dependencies.env ?? process.env).AIDEN_HOOKS === "0",
        workspaceFiles: [],
        proposals: [],
        workspaces: [],
      };
    }
    ready();
    const workspaces = await knownWorkspaces();
    // Listing a workspace scope by name is what reads its `.aiden/hooks.json`;
    // the unscoped list then covers global, chat and Bot hooks as well.
    const scoped: HookList | undefined = workspaces.length
      ? await service.listHooks(workspaces.map((workspace): HookScope => ({ kind: "workspace", workspaceRoot: workspace.workspaceRoot })))
      : undefined;
    const all = await service.listHooks();
    const hooks = new Map<string, HookListing>();
    for (const hook of [...all.hooks, ...(scoped?.hooks ?? [])]) if (!hooks.has(hook.id)) hooks.set(hook.id, hook);
    const files = new Map(all.workspaceFiles.map((file) => [file.workspaceRoot, file]));
    for (const file of scoped?.workspaceFiles ?? []) files.set(file.workspaceRoot, file);
    return {
      available: true,
      hooks: [...hooks.values()],
      paused: all.paused,
      disabledByEnvironment: all.disabledByEnvironment,
      workspaceFiles: [...files.values()],
      proposals: service.listProposals(),
      workspaces,
    };
  });

  dependencies.handle("hooks:approveProposal", async (_event, proposalId) => ready().approveProposal(id(proposalId)));

  dependencies.handle("hooks:rejectProposal", async (_event, proposalId) => ready().rejectProposal(id(proposalId)));

  dependencies.handle("hooks:save", async (_event, request) => {
    const input = plainObject(request);
    const scopeInput = plainObject(input.scope);
    let scope: HookScope;
    if (scopeInput.kind === "global") scope = { kind: "global" };
    else if (scopeInput.kind === "workspace" && typeof scopeInput.workspaceRoot === "string" && path.isAbsolute(scopeInput.workspaceRoot)) {
      const workspaceRoot = normalizeWorkspaceRoot(scopeInput.workspaceRoot);
      // Only folders Aiden already knows as workspaces; Settings never writes a hook for an arbitrary path.
      if (!(await knownWorkspaces()).some((workspace) => workspace.workspaceRoot === workspaceRoot)) invalid();
      scope = { kind: "workspace", workspaceRoot };
    } else invalid();
    const hookEvent = event(input.event);
    if (typeof input.command !== "string" || input.command.includes("\u0000") || input.command.length > MAX_HOOK_COMMAND_LENGTH) invalid();
    const command = input.command.trim();
    if (!command) invalid();
    let timeout: number | undefined;
    if (input.timeout !== undefined && input.timeout !== null) {
      if (typeof input.timeout !== "number" || !Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > MAX_HOOK_TIMEOUT_SECONDS) invalid();
      timeout = input.timeout;
    }
    const failClosed = input.failClosed === undefined ? false : bool(input.failClosed);
    if (failClosed && hookEvent !== "PreToolUse") invalid();
    return ready().saveHook({
      scope,
      event: hookEvent,
      matcher: optionalText(input.matcher, HOOK_MAX_MATCHER_LENGTH),
      name: optionalText(input.name, HOOK_MAX_NAME_LENGTH),
      handler: { type: "command", command, ...(timeout ? { timeout } : {}), ...(failClosed ? { failClosed: true } : {}) },
    });
  });

  dependencies.handle("hooks:approveDigest", async (_event, hookId, digest) => {
    if (typeof digest !== "string" || !DIGEST.test(digest)) invalid();
    // The digest the owner saw: a hook that changed since then is refused, not approved.
    return ready().approveDigest(id(hookId), digest);
  });

  dependencies.handle("hooks:setEnabled", async (_event, hookId, enabled) => {
    await ready().setEnabled(id(hookId), bool(enabled));
    return true;
  });

  dependencies.handle("hooks:delete", async (_event, hookId) => ready().deleteHook(id(hookId)));

  dependencies.handle("hooks:setPaused", async (_event, paused) => {
    await ready().setPaused(bool(paused));
    return true;
  });

  dependencies.handle("hooks:test", async (_event, hookId) => ready().testHook(id(hookId)));

  dependencies.handle("hooks:runLog", async (_event, hookId) => ready().getRunLog(id(hookId)));
}
