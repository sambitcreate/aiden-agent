import { subagentsEnabled, subagentChildWriteEnabled, subagentChildShellEnabled, subagentChildWebEnabled, subagentChildMcpEnabled, subagentChildMcpMutationsEnabled, subagentChildDelegationEnabled } from "../../../../main/services/subagents/feature-flag.js";
import { cliSubagentIdentity } from "../subagent-identity.ts";
import type { InlineExtension, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { join, dirname } from "node:path";
import { realpathSync, statSync, mkdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { SubagentSupervisor } from "../../../../main/services/subagents/subagent-supervisor-core.js";
import { createSubagentTool } from "../../../../main/services/subagents/subagent-tool.js";
import { SubagentEventProjector } from "../../../../main/services/subagents/subagent-event-projector.js";
import { createProductionSubagentRunStore } from "../../../../main/services/subagents/subagent-run-store-production.js";
import { createNativeSubagentRunStoreStorage } from "../../../../main/services/subagents/subagent-run-store-io.js";
import { createForegroundSubagentPersistenceV2 } from "../../../../main/services/subagents/subagent-foreground-persistence-v2.js";
import { buildProductionSubagentChildTools } from "../../../../main/services/subagents/subagent-tool-assembly.js";
import { SUBAGENT_READ_TOOL_NAMES } from "../../../../main/services/subagents/capability-profile.js";
import { projectRequestableSubagentMcpInventoryV2, projectRequestableSubagentMcpMutationInventoryV2 } from "../../../../main/services/subagents/request-capabilities-v2.js";
import { WorkspaceOperationRegistry } from "../../../../main/services/workspace-operation-registry.js";
import type { Workspace } from "../../../../main/services/types.js";
import { resolveRuntimeFromContext, asModelRuntimeContext } from "../pi-bridge/model-runtime.ts";
import { runCliSubagent } from "../subagent-process.ts";
import { createCliSubagentHosts } from "../subagent-hosts.ts";
import { acquireLease, readJson } from "../state.ts";
import { accessFor, workspaceId, workspaceStore } from "../workspaces.ts";
import { sessionChat } from "../sessions.ts";

/** Race UI dismissal against cancellation without letting a late answer authorize an effect. */
async function confirmOnce(ctx: ExtensionContext, title: string, body: string, signal?: AbortSignal) {
  if (!ctx.hasUI || signal?.aborted) return false;
  if (Buffer.byteLength(body) > 48_000) throw new Error("Approval exceeds the terminal display budget.");
  let cancel = () => {};
  try {
    return await Promise.race([ctx.ui.confirm(title, body), new Promise<boolean>((resolve) => {
      cancel = () => resolve(false); signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    })]);
  } finally { signal?.removeEventListener("abort", cancel); }
}

export function createSubagentsExtension(agentDir: string): InlineExtension {
  if (!subagentsEnabled()) return { name: "aiden-subagents-disabled", factory: () => {} };
  const writeEnabled = subagentChildWriteEnabled(), shellEnabled = subagentChildShellEnabled();
  const mutationsEnabled = subagentChildMcpMutationsEnabled(), delegationEnabled = subagentChildDelegationEnabled();
  const readInventory = (signal: AbortSignal) => subagentChildMcpEnabled() ? hosts.inventory(signal) : Promise.resolve([]);
  let generationId = cliSubagentIdentity(randomUUID()), supervisor: SubagentSupervisor | undefined;
  let storage: ReturnType<typeof createProductionSubagentRunStore> | undefined, storageId: string | undefined, releaseStorage: (() => void) | undefined;
  const active = new Map<string, AbortController>(), pending = new Set<Promise<unknown>>();
  const hosts = createCliSubagentHosts(agentDir), operations = new WorkspaceOperationRegistry();
  let appDirectory: string | undefined;
  const binary = (name: string) => join(appDirectory ??= dirname(process.env.AIDEN_CLI_ENTRY!), `native/aiden-${name}`);
  async function history(ctx: ExtensionContext) {
    const id = ctx.sessionManager.getSessionId();
    if (storageId === id && storage) return storage;
    await storage?.close(); releaseStorage?.(); storage = undefined; storageId = undefined; releaseStorage = undefined;
    const directory = join(agentDir, "subagent-history", createHash("sha256").update(id).digest("hex"));
    const release = acquireLease(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const next = createProductionSubagentRunStore({ resolveUserDataDirectory: async () => directory,
      storageFactory: (root) => createNativeSubagentRunStoreStorage(root, binary("subagent-run-store")) });
    try { await next.initialize(); } catch (error) { await next.close(); release(); throw error; }
    storage = next; storageId = id; releaseStorage = release; return next;
  }
  async function getSupervisor(ctx: ExtensionContext) {
    if (supervisor) return supervisor;
    if (!ctx.model) throw new Error("Choose a model before delegating work.");
    const store = await history(ctx), chatId = cliSubagentIdentity(ctx.sessionManager.getSessionId()), cwd = realpathSync(ctx.cwd), id = cliSubagentIdentity(workspaceId(cwd));
    const rootIdentity = statSync(cwd, { bigint: true });
    async function currentWorkspace(): Promise<Workspace> {
      const saved = (await workspaceStore(agentDir).load()).find((item) => item.folderPath === cwd);
      return { ...saved, id, name: saved?.name ?? "Current workspace", folderPath: cwd, permission: accessFor(agentDir, cwd), createdAt: saved?.createdAt ?? 0, updatedAt: saved?.updatedAt ?? 0 };
    }
    const workspace = await currentWorkspace();
    const runtime = await resolveRuntimeFromContext(asModelRuntimeContext(ctx), ctx.model.provider, ctx.model.id);
    const providerState = () => JSON.stringify([readJson(join(agentDir, "auth.json"), {}), readJson(join(agentDir, "models.json"), {})]);
    const initialProviderState = providerState();
    const inventory = await readInventory(new AbortController().signal);
    const persistence = createForegroundSubagentPersistenceV2({ store, generationId, chatId, workspace, runtime, thinkingLevel: "off", ownerDocumentId: `cli:${chatId}`, permission: workspace.permission ?? "ask",
      webEnabled: subagentChildWebEnabled() && (await hosts.web.availability()).ready, writeEnabled, fileMutatorBinary: binary("subagent-file-mutator"),
      shellEnabled, shellBinary: binary("subagent-shell-runner"), mcpInventory: inventory, mcpMutationsEnabled: mutationsEnabled, mcpMutationHost: hosts.mcpMutationHost,
      delegationEnabled, currentWorkspace, workspaceOperationRegistry: operations,
      validateWorkspace: async () => {
        const current = statSync(cwd, { bigint: true });
        if (realpathSync(cwd) !== cwd || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || initialProviderState !== providerState()) throw new Error("Delegated workspace or provider authority changed.");
      },
      requestApproval: async (descriptor, signal) => confirmOnce(ctx, `Subagent: allow ${descriptor.toolName} once?`, JSON.stringify(descriptor, null, 2), signal),
    });
    const projector = new SubagentEventProjector({ generationId, chatId, workspaceId: id, modelId: ctx.model.id,
      prepareSnapshot: persistence.prepare,
      onSnapshot: async (snapshot) => { await persistence.upsert(snapshot); ctx.ui.setStatus("subagents", active.size ? `${active.size} subagent(s) running` : undefined); },
    });
    supervisor = new SubagentSupervisor({ generationId, chatId, workspaceId: id, runtime, thinkingLevel: "off", workspaceRoot: cwd, permission: workspace.permission ?? "ask",
      inheritedCeiling: SUBAGENT_READ_TOOL_NAMES, loadPersistedChatForFork: async () => ({ ...sessionChat(ctx.sessionManager), id: chatId }), projector, prepareRun: persistence.prepareRun,
      runChild: async (input) => {
        const controller = new AbortController(), runId = input.runId!;
        const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
        try {
        const assembly = await buildProductionSubagentChildTools({ workspaceRoot: cwd, permission: accessFor(agentDir, cwd), role: input.request.role, inheritedCeiling: input.inheritedCeiling,
          authority: input.v2Authority, currentAuthority: input.currentV2Authority, consumeNetworkOperation: input.consumeNetworkOperation, mcpMutationsEnabled: mutationsEnabled, shellEnabled, signal }, hosts);
        const outbound = assembly.outboundApprovalBindings.length ? input.prepareOutboundApproval!(assembly.outboundApprovalBindings) : undefined;
        const write = assembly.workspaceWriteApprovalBindings.length ? input.prepareWorkspaceWriteApproval!(assembly.workspaceWriteApprovalBindings, signal) : undefined;
        const mutation = assembly.mcpMutationApprovalBindings.length ? input.prepareMcpMutationApproval!(assembly.mcpMutationApprovalBindings, signal) : undefined;
        const shell = assembly.shellApprovalBindings.length ? input.prepareShellApproval!(assembly.shellApprovalBindings, signal) : undefined;
        const outboundNames = new Set(assembly.outboundApprovalBindings.map(({ toolName }) => toolName));
        const writeNames = new Set<string>(assembly.workspaceWriteApprovalBindings.map(({ toolName }) => toolName));
        const mutationNames = new Set(assembly.mcpMutationApprovalBindings.map(({ childAgentToolName }) => childAgentToolName));
        const tools: AgentTool[] = assembly.tools.map((tool) => ({ ...tool, execute: async (toolCallId, args, signal, update) => {
          if (writeNames.has(tool.name)) return write!.execute({ toolCallId, toolName: tool.name, arguments: args, signal });
          if (mutationNames.has(tool.name)) return mutation!.execute({ toolCallId, toolName: tool.name, arguments: args, signal });
          if (tool.name === "run_command" && shell) return shell.execute({ toolCallId, toolName: tool.name, arguments: args, signal });
          if (outboundNames.has(tool.name)) outbound!.consume({ toolCallId, toolName: tool.name, arguments: args });
          return tool.execute(toolCallId, args, signal, update);
        } }));
        if (input.executeNested) tools.push(createSubagentTool({ execute: (params, nestedSignal) => input.executeNested!(params, nestedSignal) },
          projectRequestableSubagentMcpInventoryV2(input.v2Authority!.capabilities.mcp), writeEnabled,
          projectRequestableSubagentMcpMutationInventoryV2(input.v2Authority!.capabilities.mcp), shellEnabled, false));
        active.set(runId, controller);
        try {
          return await runCliSubagent(agentDir, { ...input, signal }, tools, async (name, toolCallId, args, context) => {
            if (signal.aborted || accessFor(agentDir, cwd) === "none" || initialProviderState !== providerState()) throw new Error("Delegated authority was revoked.");
            const result = await write?.beforeToolCall(context!, signal) ?? await mutation?.beforeToolCall(context!, signal) ?? await shell?.beforeToolCall(context!, signal) ?? await outbound?.beforeToolCall(context!, signal);
            if (result?.block) throw new Error(result.reason ?? "Delegated effect was denied.");
            if (writeNames.has(name) || mutationNames.has(name) || outboundNames.has(name) || name === "run_command" || name === "subagent" || accessFor(agentDir, cwd) === "full") return;
            if (!await confirmOnce(ctx, `Subagent: allow ${name} once?`, JSON.stringify(args), signal) || signal.aborted || accessFor(agentDir, cwd) === "none") throw new Error("Delegated read was denied or revoked.");
          });
        } finally {
          await Promise.allSettled([write?.shutdown(), mutation?.shutdown(), shell?.shutdown()]);
        }
        } finally {
          active.delete(runId); ctx.ui.setStatus("subagents", active.size ? `${active.size} subagent(s) running` : undefined);
        }
      },
    });
    return supervisor;
  }
  return { name: "aiden-subagents", async factory(pi) {
    const inventory = await readInventory(new AbortController().signal);
    const tool = createSubagentTool({ execute: async () => "" }, projectRequestableSubagentMcpInventoryV2(inventory), writeEnabled, mutationsEnabled ? projectRequestableSubagentMcpMutationInventoryV2(inventory) : [], shellEnabled, delegationEnabled);
    pi.registerTool({ ...tool, label: tool.label!, async execute(_id, params, signal, _onUpdate, ctx) {
      const operation = (async () => ({ content: [{ type: "text" as const, text: await (await getSupervisor(ctx)).execute(params, signal) }], details: {} }))();
      pending.add(operation); try { return await operation; } finally { pending.delete(operation); }
    } });
    pi.on("before_agent_start", async () => { await supervisor?.flush(); generationId = cliSubagentIdentity(randomUUID()); supervisor = undefined; });
    pi.registerCommand("subagents", { description: "Inspect durable subagent history or cancel a run", handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/);
      if (action === "cancel") { const controller = active.get(id); if (!controller) throw new Error("No active run with that id."); controller.abort(); }
      else { await supervisor?.flush(); ctx.ui.notify(JSON.stringify(await (await history(ctx)).listByChat(cliSubagentIdentity(ctx.sessionManager.getSessionId())), null, 2), "info"); }
    } });
    pi.on("session_shutdown", async () => { for (const controller of active.values()) controller.abort(); await Promise.allSettled(pending); await supervisor?.flush(); await storage?.close(); releaseStorage?.(); });
  } };
}
