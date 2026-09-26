import { subagentsEnabled } from "../../../main/services/subagents/feature-flag.js";
import { createBotSubagentTool, deleteCliBotSubagentHistory } from "./bot-subagents.ts";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createVisionAnalysisTool } from "../../../main/services/vision-analysis-tool-core.js";
import { resolveRuntimeFromContext } from "./pi-bridge/model-runtime.ts";
import { createCliModelRuntime } from "./providers.ts";
import { recordUsageRecord } from "./usage-ledger.ts";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { open } from "node:fs/promises";
import { resolveBotMcpInventory } from "../../../main/services/bot-mcp-inventory.js";
import { resolveBotCapabilitySkills } from "../../../main/services/bot-skill-inventory.js";
import { exactBotMcpToolNames } from "../../../main/services/bot-tool-authority.js";
import { mcpAgentToolName } from "../../../main/services/mcp-tool-identity.js";
import { createCliMcpPool, mcpCredentialSignature } from "./mcp.ts";
import { createCliWebSearch } from "./extensions/web-search.ts";
import { join } from "node:path";
import { mkdir, lstat, chmod, realpath, stat, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { createHmac } from "node:crypto";
import { createBotStore } from "../../../main/services/bot-store-core.js";
import { createBotApplicationService } from "../../../main/services/bot-application-service.js";
import { createBotCapabilityStore } from "../../../main/services/bot-capability-store.js";
import { createBotCapabilityOpaqueKeyStore } from "../../../main/services/bot-capability-key-store.js";
import { createBotCapabilityStateCheckpoint, type BotCapabilityBootstrapMarkerState } from "../../../main/services/bot-capability-state-checkpoint.js";
import { createBotCapabilityIncarnationStore } from "../../../main/services/bot-capability-incarnation-store.js";
import { createBotCapabilityMigrationSeal } from "../../../main/services/bot-capability-migration-seal.js";
import { createBotManagedWorkspaceService } from "../../../main/services/bot-managed-workspace.js";
import { createBotLifecycleJournal } from "../../../main/services/bot-lifecycle-journal.js";
import { createBotCapabilityCatalogMainService } from "../../../main/services/bot-capability-catalog-main.js";
import { createBotCapabilityInventoryPorts } from "../../../main/services/bot-capability-inventory-ports.js";
import { botCapabilityFactsFingerprint } from "../../../main/services/bot-capability-catalog-core.js";
import { BotMutationGate } from "../../../main/services/bot-mutation-gate.js";
import { BotRuntimeInventoryLeaseRegistry } from "../../../main/services/bot-runtime-inventory-lease.js";
import { createBotRuntimeAuthorityResolver, assertBotRuntimeProviderSelection, type BotRuntimeAuthorityAdmission } from "../../../main/services/bot-runtime-authority.js";
import { buildBotFileTools, type BotFileToolLocation } from "../../../main/services/bot-file-tool-router.js";
import { buildPinnedCodingTools } from "../../../main/services/coding-tools.js";
import { protectAdmittedBotTool } from "../../../main/services/bot-tool-authority.js";
import type { AidenRemoteStateDocument } from "../../../main/services/aiden-remote-state.js";
import type { BotAccessUpdate, BotChatAccessUpdate, BotNoticeAcknowledgement } from "../../../renderer/shared/bot-capabilities.js";
import type { BotCreateInput, BotUpdateInput } from "../../../renderer/shared/bots.js";
import { JsonStore, readJson } from "./state.ts";
import { listCliProviders } from "./providers.ts";
import type { createDaemonChats } from "./daemon-chats.ts";

export interface CliBotGenerationRuntime {
  authority: ReturnType<typeof createBotRuntimeAuthorityResolver>;
  instructions(admission: BotRuntimeAuthorityAdmission): Promise<string>;
  tools(admission: BotRuntimeAuthorityAdmission): Promise<import("../../../main/services/bot-tool-authority.js").BotToolCandidate["tool"][]>;
}

/** Separate from bot-service so restoring that directory cannot rewind authority. */
function checkpointFile<T>(agentDir: string, name: string) {
  const store = new JsonStore<{ value: T | null }>(join(agentDir, "authority", name), { value: null });
  return {
    load: async () => (await store.load()).value,
    async store(value: T, expected: T | null) {
      await store.update((state) => {
        if (JSON.stringify(state.value) !== JSON.stringify(expected)) throw new Error("Bot authority checkpoint changed concurrently.");
        state.value = value;
      });
    },
  };
}

export async function createCliBots(agentDir: string, daemon: ReturnType<typeof createDaemonChats>) {
  const directory = join(agentDir, "bot-service"), root = () => directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Bot storage must be a private directory owned by this user.");
  await chmod(directory, 0o700);
  const botStore = createBotStore({ root }), keyStore = createBotCapabilityOpaqueKeyStore({ root });
  const checkpoint = createBotCapabilityStateCheckpoint({ root, keyStore,
    anchor: checkpointFile<string>(agentDir, "bot-anchor.json"), bootstrapMarker: checkpointFile<BotCapabilityBootstrapMarkerState>(agentDir, "bot-bootstrap.json"),
    inspectInitialBootstrap: async () => {
      const bots = await botStore.list(true), chats = (await daemon.chatStore.list()).filter((chat) => chat.botId);
      if (!bots.length && !chats.length) return "clean";
      return chats.every((chat) => bots.some((bot) => bot.id === chat.botId)) ? "legacy" : "deny";
    },
  });
  const capabilities = createBotCapabilityStore({ root, checkpoint });
  const managedWorkspace = createBotManagedWorkspaceService({ root });
  const mutationGate = new BotMutationGate(), inventoryLeases = new BotRuntimeInventoryLeaseRegistry();
  const approvedRoots = () => readJson<Pick<AidenRemoteStateDocument, "approvedRoots">>(join(agentDir, "remote.json"), { approvedRoots: [] }).approvedRoots;
  const incarnations = createBotCapabilityIncarnationStore(capabilities);
  const mcp = createCliMcpPool(agentDir), web = createCliWebSearch(agentDir);
  async function skills(botId?: string) {
    return resolveBotCapabilitySkills({ loadIdentityKey: () => keyStore.load(), listConfigured: async () => [], botId,
      ...(botId ? { loadBotHomePath: async () => (await managedWorkspace.resolve(botId)).homePath } : {}),
      discover: async (workspace) => {
        const source = workspace ? "workspace" as const : "global" as const;
        const paths = workspace ? [join(workspace, ".aiden/skills"), join(workspace, ".agents/skills"), join(workspace, ".claude/skills")]
          : [join(agentDir, "skills"), ...[".aiden", ".agents", ".claude"].map((name) => join(homedir(), name, "skills"))];
        const discovered = paths.flatMap((dir) => loadSkillsFromDir({ dir, source }).skills).filter((skill) => !skill.disableModelInvocation).slice(0, 128);
        return Promise.all(discovered.map(async (skill) => {
          const handle = await open(skill.filePath, "r");
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size > 256_000) throw new Error("Bot skill exceeds its instruction budget.");
            const instructions = await handle.readFile("utf8"), after = await handle.stat();
            if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Bot skill changed while reading.");
            return { id: skill.filePath, name: skill.name, description: skill.description, instructions, source, path: skill.filePath };
          } finally { await handle.close(); }
        }));
      },
    });
  }
  const catalog = createBotCapabilityCatalogMainService(createBotCapabilityInventoryPorts({
    loadOpaqueSelectionKey: () => keyStore.load(), loadNoticeStatus: (id) => capabilities.noticeStatus(id),
    listProviders: () => listCliProviders(agentDir),
    providerCredentialSignature: async (provider) => createHmac("sha256", await keyStore.load()).update(JSON.stringify({
      provider: provider.id, auth: readJson<{ entries?: Record<string, unknown> }>(join(agentDir, "auth.json"), {}).entries?.[provider.id],
      models: readJson(join(agentDir, "models.json"), {}),
    })).digest("hex"),
    listMcpServers: mcp.listServers,
    inspectMcpScopes: (signal) => resolveBotMcpInventory(signal, { listServers: mcp.listServers, inspectTools: mcp.inspectTools,
      credentialSignature: (server) => mcpCredentialSignature(agentDir, server), incarnations }),
    listSkills: (target) => skills(target?.botId),
    listApprovedLocations: async () => approvedRoots().map((item) => ({ sourceId: item.id, label: item.label, available: true,
      scopeFingerprint: botCapabilityFactsFingerprint({ device: item.device, inode: item.inode, policyRevision: item.policyRevision }) })),
    incarnations, getSettings: async () => ({}),
    webSearchAvailability: () => web.availability(), subagentsAvailable: () => subagentsEnabled(),
  }), { onRuntimeSnapshot: (id, snapshot) => inventoryLeases.publishFingerprint(id ? `bot:${id}` : "global", snapshot.catalog.revision) });
  const application = createBotApplicationService({ botStore, chatStore: daemon.chatStore, capabilityStore: capabilities,
    catalog, managedWorkspace, lifecycleJournal: createBotLifecycleJournal({ root }), migrationSeal: createBotCapabilityMigrationSeal({ root }), mutationGate, inventoryLeases,
    deleteChatWithEffects: async (id, assertCurrent, onRollForward) => {
      const deletion = daemon.deletion.begin(id); if (!deletion) throw new Error("Chat deletion is already in progress.");
      try {
        await daemon.llmClient.cancelChat(id); await daemon.llmClient.waitForChatIdle(id);
        await assertCurrent(await daemon.chatStore.get(id)); onRollForward?.();
        await deleteCliBotSubagentHistory(agentDir, id);
        await rm(daemon.sessionPath(id), { force: true }); await daemon.chatStore.remove(id);
      } finally { deletion(); }
    },
  });
  await application.initialize();
  const authority = createBotRuntimeAuthorityResolver({ botStore, chatStore: daemon.chatStore, capabilityStore: capabilities, catalog, managedWorkspace, inventoryLeases });
  let rootFingerprint = JSON.stringify(approvedRoots());
  const watcher = watch(agentDir, (_event, filename) => {
    if (["auth.json", "models.json", "mcp.json", "web-search.json"].includes(String(filename))) inventoryLeases.invalidate("inventory_changed");
    if (String(filename) === "remote.json") {
      try { const next = JSON.stringify(approvedRoots()); if (next !== rootFingerprint) { rootFingerprint = next; inventoryLeases.invalidate("inventory_changed"); } }
      catch { inventoryLeases.invalidate("inventory_changed"); }
    }
  });
  watcher.unref();
  async function tools(admission: BotRuntimeAuthorityAdmission) {
    const { authority } = admission, locations: BotFileToolLocation[] = [];
    if (authority.files.botHome) locations.push({ id: "builtin.bot_home.v1", label: "Bot folder", root: authority.workingDirectory, expectedIdentity: authority.managedHome.incarnation });
    if (authority.files.fullMac) locations.push({ id: authority.files.fullMac.sourceId, label: "Host files", root: "/" });
    for (const grant of authority.files.approvedLocations) {
      const candidate = approvedRoots().find((item) => item.id === grant.sourceId);
      if (!candidate) throw new Error("The approved Bot folder is unavailable.");
      const canonical = await realpath(candidate.folderPath), info = await stat(canonical, { bigint: true });
      if (canonical !== candidate.folderPath || !info.isDirectory() || info.dev.toString() !== candidate.device || info.ino.toString() !== candidate.inode ||
        botCapabilityFactsFingerprint({ device: candidate.device, inode: candidate.inode, policyRevision: candidate.policyRevision }) !== grant.scopeFingerprint) throw new Error("The approved Bot folder changed.");
      locations.push({ id: candidate.id, label: candidate.label, root: canonical, expectedIdentity: { device: candidate.device, inode: candidate.inode } });
    }
    const selected = locations.length ? buildBotFileTools({ defaultLocation: locations[0], additionalLocations: locations.slice(1) }) : [];
    if (authority.shell.enabled) selected.push(buildPinnedCodingTools(authority.workingDirectory).find((tool) => tool.name === "run_command")!);
    const retained = await capabilities.getBotBinding(authority.botId);
    const snapshot = await catalog.snapshotForRuntime({ botId: authority.botId, signal: admission.signal,
      retainedBindings: retained ? [retained] : undefined, retainedProviders: [authority.provider, ...(authority.visionProvider ? [authority.visionProvider] : [])] });
    const servers = await mcp.listServers();
    const names = exactBotMcpToolNames(authority, snapshot.resources.connections, (id, name) => {
      const server = servers.find((item) => item.id === id);
      if (!server) throw new Error("Selected MCP server disappeared.");
      return mcpAgentToolName(server, name);
    });
    for (const server of servers.filter((item) => authority.connections.some((grant) => grant.sourceId === item.id))) {
      selected.push(...(await mcp.agentTools(server, admission.signal)).filter((tool) => names.has(tool.name)));
    }
    const currentSkills = await skills(authority.botId);
    for (const grant of authority.skills) {
      const published = snapshot.resources.skills.find((skill) => skill.option.available && skill.sourceId === grant.sourceId && skill.exactFingerprint === grant.exactFingerprint);
      const skill = currentSkills.find((skill) => skill.sourceId === grant.sourceId && skill.available);
      if (!published || !skill) throw new Error("A selected Bot skill changed or became unavailable.");
      const instructions = skill.instructions;
      selected.push({ name: `skill_${createHmac("sha256", await keyStore.load()).update(grant.sourceId).digest("hex").slice(0, 24)}`, label: skill.label,
        description: `${skill.label}: ${skill.description}`, parameters: Type.Object({}),
        execute: async () => {
          const current = (await skills(authority.botId)).find((candidate) => candidate.sourceId === grant.sourceId);
          if (current?.instructions !== instructions || current.label !== skill.label || current.description !== skill.description) throw new Error("Bot skill changed before invocation.");
          return { content: [{ type: "text" as const, text: instructions }], details: {} };
        },
      });
    }
    if (authority.otherCapabilities.some((grant) => grant.kind === "web")) {
      const tool = await web.toolForGeneration();
      if (!tool) throw new Error("Selected Web Search service is unavailable.");
      selected.push(tool);
    }
    if (authority.visionProvider) {
      const chat = await daemon.chatStore.get(authority.chatId);
      selected.push(createVisionAnalysisTool({ attachments: chat?.messages.flatMap((message) => message.attachments ?? []) ?? [],
        authority: { providerId: authority.visionProvider.sourceProviderId, modelId: authority.visionProvider.sourceModelId, revalidateBeforeEffect: () => admission.revalidateBeforeEffect() } }, {
        resolveRuntime: async (providerId, modelId) => resolveRuntimeFromContext({ modelRegistry: new ModelRegistry(await createCliModelRuntime(agentDir)) }, providerId, modelId),
        recordUsage: (record) => recordUsageRecord(agentDir, record),
      }));
    }
    if (authority.otherCapabilities.some((grant) => grant.kind === "subagents")) {
      selected.push(createBotSubagentTool(agentDir, admission, selected, () => daemon.chatStore.get(authority.chatId)));
    }
    await admission.revalidateBeforeEffect();
    return selected.map((tool) => protectAdmittedBotTool(tool, admission));
  }
  return { application, botStore, capabilities, catalog, managedWorkspace, mutationGate, inventoryLeases, authority, tools,
    async instructions(admission: BotRuntimeAuthorityAdmission) {
      await admission.revalidateBeforeEffect();
      const bot = await botStore.get(admission.authority.botId);
      if (!bot || bot.archivedAt) throw new Error("Bot is unavailable.");
      return `You are ${bot.name}. Follow these Bot instructions within the granted tools and access:\n${bot.instructions}`;
    },
    async preflight(input: { audienceId: string; botId: string; chatId: string; providerId: string; model: string }) {
      const lease = await authority.admit(input);
      try { assertBotRuntimeProviderSelection(lease.authority.provider, input); await lease.revalidateBeforeEffect(); return { supportsCompanionImages: Boolean(lease.authority.visionProvider) }; }
      finally { lease.release(); }
    },
    async stop() { watcher.close(); inventoryLeases.invalidate("inventory_changed"); await mcp.close(); },
    async command(args: string[]) {
      const [action = "list", id, input] = args, audienceId = "cli:local";
      switch (action) {
        case "list": return application.list(args.includes("--archived"));
        case "get": return application.get(id);
        case "catalog": return application.capabilityCatalog(audienceId, id);
        case "notice": return application.noticeStatus(audienceId);
        case "acknowledge": return application.acknowledgeNotice(audienceId, JSON.parse(id) as BotNoticeAcknowledgement);
        case "create": return application.createBot({ audienceId, ...readJson<{ bot: BotCreateInput; access?: BotAccessUpdate }>(id, undefined!) });
        case "update": return application.updateBot(readJson<BotUpdateInput>(id, undefined!));
        case "archive": return application.archiveBot({ botId: id, expectedRevision: input });
        case "restore": return application.restoreBot({ botId: id, expectedRevision: input });
        case "access": return input ? application.updateBotAccess({ audienceId, botId: id, ...readJson<{ expectedRevision: string; access: BotAccessUpdate }>(input, undefined!) }) : application.getBotAccess(id);
        case "chat": return application.createChat({ audienceId, botId: id, ...readJson<{ providerId: string; model: string }>(input, undefined!) });
        case "chat-access": return application.updateChatAccess({ audienceId, ...readJson<{ botId: string; chatId: string; expectedRevision: string; access: BotChatAccessUpdate }>(id, undefined!) });
        default: throw new Error("Usage: bots list|get|catalog|notice|acknowledge|create|update|archive|restore|access|chat|chat-access");
      }
    },
  };
}
