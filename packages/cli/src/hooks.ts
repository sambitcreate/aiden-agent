// Aiden hooks on the CLI server (docs/plans/aiden-hooks-plan.md §7, phase 3).
// The daemon owns one hook service over `<agentDir>/hooks/`, the same module
// the desktop app runs; `aiden hooks …` talks to it over the daemon socket,
// or opens the store itself (under the serve lease) when no daemon runs.
import { homedir } from "node:os";
import { join } from "node:path";
import { createHookService, type HookService } from "../../../main/services/hooks/hook-service.js";
import { setHookDispatcher, type HookListing, type HookScope } from "../../../main/services/hooks/index.js";
import { hostPlatformCapabilities } from "../../../main/services/host-platform-capabilities.js";
import { setProtectedAgentConfigRoots } from "../../../main/services/protected-agent-config-paths.js";
import { remoteDaemonCommand } from "./daemon-control.ts";
import { acquireLease } from "./state.ts";
import { workspaceStore } from "./workspaces.ts";

export const HOOKS_USAGE = "Usage: hooks list | approve <id> <digest> | disable <id> | enable <id> | pause | resume | test <id> <digest>";

/** Commands that let a hook run, which only a person at a terminal may give. */
const INTERACTIVE_ACTIONS = new Set(["approve", "enable"]);

const DIGEST = /^[0-9a-f]{64}$/u;

/** At most this much of a test run's output is printed. */
const TEST_OUTPUT_CHARS = 4_000;

export const cliHooksRoot = (agentDir: string) => join(agentDir, "hooks");

export function createCliHookService(agentDir: string): HookService {
  return createHookService({ root: () => cliHooksRoot(agentDir), homeDir: () => homedir() });
}

/**
 * The daemon's hooks: loads the store and installs its dispatcher for every
 * surface (chats, Bots, routines, subagents, worktrees). The store is
 * protected from agent file tools first, whether or not hooks can run here.
 * Undefined when this computer can't run hooks or the store can't be read;
 * then no hook runs and the daemon carries on.
 */
export async function startCliHooks(agentDir: string): Promise<HookService | undefined> {
  setProtectedAgentConfigRoots([cliHooksRoot(agentDir)]);
  if (!hostPlatformCapabilities().hooks) return undefined;
  const service = createCliHookService(agentDir);
  try { await service.load(); }
  catch (error) {
    process.stderr.write(`aiden: Hooks are off because the hook store could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  setHookDispatcher(service.dispatcher);
  return service;
}

export async function stopCliHooks(service: HookService | undefined): Promise<void> {
  setHookDispatcher(undefined);
  await service?.flush();
}

function scopeLabel(scope: HookScope): string {
  switch (scope.kind) {
    case "global": return "global";
    case "workspace": return `workspace:${scope.workspaceRoot}`;
    case "chat": return `chat:${scope.chatId}`;
    case "bot": return `bot:${scope.botId}`;
  }
}

/** One hook as `aiden hooks list` prints it. `envAllow` lists names only, never values. */
function hookRow(hook: HookListing) {
  return {
    id: hook.id, name: hook.name, event: hook.configuredEvent, matcher: hook.matcher, scope: scopeLabel(hook.scope),
    source: hook.source, status: hook.status, command: hook.handler.command, digest: hook.digest,
    ...(hook.handler.timeout !== undefined ? { timeout: hook.handler.timeout } : {}),
    ...(hook.handler.failClosed ? { failClosed: true } : {}),
    ...(hook.handler.envAllow?.length ? { envAllow: hook.handler.envAllow } : {}),
    ...(hook.unsupportedReason ? { unsupportedReason: hook.unsupportedReason } : {}),
    ...(hook.lastRun ? { lastRun: { at: new Date(hook.lastRun.startedAt).toISOString(), result: hook.lastRun.result, exitCode: hook.lastRun.exitCode, timedOut: hook.lastRun.timedOut, durationMs: hook.lastRun.durationMs } } : {}),
  };
}

/**
 * Every hook the service knows plus each registered workspace's
 * `.aiden/hooks.json`, read now so a repo hook can be approved by id.
 */
async function everyHook(agentDir: string, service: HookService) {
  const workspaces = (await workspaceStore(agentDir).load()).filter((workspace) => workspace.folderPath);
  const registered = await service.listHooks([{ kind: "global" }, ...workspaces.map((workspace): HookScope => ({ kind: "workspace", workspaceRoot: workspace.folderPath }))]);
  const known = await service.listHooks();
  const hooks = new Map<string, HookListing>();
  for (const hook of [...registered.hooks, ...known.hooks]) if (!hooks.has(hook.id)) hooks.set(hook.id, hook);
  const files = new Map([...registered.workspaceFiles, ...known.workspaceFiles].map((file) => [file.workspaceRoot, file]));
  return { hooks: [...hooks.values()], paused: known.paused, disabledByEnvironment: known.disabledByEnvironment, workspaceFiles: [...files.values()] };
}

function requireId(id: string | undefined, rest: string[]): string {
  if (!id || rest.length > 0) throw new Error(HOOKS_USAGE);
  return id;
}

/** `aiden hooks …` against one hook service: the daemon's, or one opened for this command. */
export async function hooksCommand(agentDir: string, service: HookService, args: string[]): Promise<unknown> {
  const [action = "list", ...rest] = args;
  switch (action) {
    case "list": {
      if (rest.length > 0) throw new Error(HOOKS_USAGE);
      const listed = await everyHook(agentDir, service);
      return {
        paused: listed.paused, disabledByEnvironment: listed.disabledByEnvironment,
        ...(hostPlatformCapabilities().hooks ? {} : { unavailable: "Hooks run only on macOS and Linux." }),
        hooks: listed.hooks.map(hookRow),
        workspaceFiles: listed.workspaceFiles.filter((file) => file.present).map((file) => ({ workspaceRoot: file.workspaceRoot, problems: file.problems, warnings: file.warnings })),
      };
    }
    case "approve": {
      // The digest is the one `hooks list` showed: approval covers exactly what was read.
      const [id, digest, ...extra] = rest;
      if (!id || !digest || extra.length > 0) throw new Error(HOOKS_USAGE);
      if (!DIGEST.test(digest)) throw new Error(`${digest} is not a hook digest. Copy it from \`aiden hooks list\`.`);
      await everyHook(agentDir, service);
      const approved = await service.approveDigest(id, digest);
      if (!approved.ok) throw new Error(approved.reason);
      return hookRow(approved.value);
    }
    case "disable":
    case "enable": {
      const id = requireId(rest[0], rest.slice(1));
      if (!(await everyHook(agentDir, service)).hooks.some((hook) => hook.id === id)) throw new Error(`There is no hook with the id ${id}.`);
      if (!(await service.setEnabled(id, action === "enable"))) throw new Error(`There is no hook with the id ${id}.`);
      const hook = (await everyHook(agentDir, service)).hooks.find((item) => item.id === id);
      return hook ? hookRow(hook) : { id, enabled: action === "enable" };
    }
    case "pause":
    case "resume": {
      if (rest.length > 0) throw new Error(HOOKS_USAGE);
      await service.setPaused(action === "pause");
      return { paused: action === "pause" };
    }
    case "test": {
      const [id, digest, ...extra] = rest;
      if (!id || !digest || extra.length > 0) throw new Error(HOOKS_USAGE);
      if (!DIGEST.test(digest)) throw new Error(`${digest} is not a hook digest. Copy it from \`aiden hooks list\`.`);
      if (!hostPlatformCapabilities().hooks) throw new Error("Hooks run only on macOS and Linux.");
      await everyHook(agentDir, service);
      // Runs the command against a fixture payload, without touching its health or run log,
      // and only when it is still the hook whose digest was shown.
      const tested = await service.testHook({ hookId: id, digest });
      if (!tested.ok) throw new Error(tested.reason);
      const { value } = tested;
      return {
        hookId: id, matched: value.matched, exitCode: value.exitCode, timedOut: value.timedOut, durationMs: value.durationMs,
        ...(value.outcome.decision ? { decision: value.outcome.decision } : {}),
        ...(value.outcome.reason ? { reason: value.outcome.reason } : {}),
        stdout: value.stdout.slice(0, TEST_OUTPUT_CHARS), stderr: value.stderr.slice(0, TEST_OUTPUT_CHARS),
      };
    }
    default: throw new Error(HOOKS_USAGE);
  }
}

export interface HooksAdminOptions {
  /** Whether a person is at a terminal; defaults to stdin and stdout both being TTYs. */
  isInteractive?: () => boolean;
}

const terminalAttached = () => process.stdin.isTTY === true && process.stdout.isTTY === true;

/**
 * `aiden hooks …` from the shell: through the running daemon, else directly under the serve lease.
 * `approve` and `enable` need a terminal, so an agent's shell command or a
 * script cannot approve a hook it wrote. This keeps honest automation out; it
 * is not a boundary against code already running as this user.
 */
export async function hooksAdminCommand(agentDir: string, args: string[], options: HooksAdminOptions = {}): Promise<unknown> {
  if (INTERACTIVE_ACTIONS.has(args[0] ?? "") && !(options.isInteractive ?? terminalAttached)()) {
    throw new Error(`aiden hooks ${args[0]} must be run by a person at a terminal: stdin and stdout must both be a TTY.`);
  }
  try { return await remoteDaemonCommand(agentDir, "hooks", args); }
  catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  const release = acquireLease(join(agentDir, "serve"));
  try {
    const service = createCliHookService(agentDir);
    await service.load();
    try { return await hooksCommand(agentDir, service, args); }
    finally { await service.flush(); }
  } finally { release(); }
}
