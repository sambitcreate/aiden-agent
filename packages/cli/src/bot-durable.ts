import { cliSubagentIdentity } from "./subagent-identity.ts";
import { imageAttachmentsFromEntries } from "../../../main/services/bot-runtime/bot-images.js";
import { projectBotTranscript } from "../../../main/services/bot-runtime/live-projection.js";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Attachment, Chat } from "../../../main/services/types.js";
import type { BotToolCall } from "../../../main/services/bot-runtime/tool-adapter.js";
import { recordUsage } from "./usage-ledger.ts";
import { BOT_PRESETS } from "../../../renderer/shared/bot-presets.js";
import { createBotStarter } from "../../../main/services/bot-runtime/bot-starter.js";
import { createBotCreationKeyStore } from "../../../main/services/bot-creation-keys.js";
import { newBotId } from "../../../main/services/bot-application-service.js";
/** Node host for the shared durable Bot core. No Electron singleton imports. */
import { lazyStream } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { setBotFileToolProtectedRoots } from "../../../main/services/bot-file-tool-router.js";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBotSessionService } from "../../../main/services/bot-runtime/bot-session-service.js";
import { createBotRuntimeModels } from "../../../main/services/bot-runtime/bot-models.js";
import { createBotApprovals } from "../../../main/services/bot-runtime/bot-approvals.js";
import { createBotMemoryService } from "../../../main/services/bot-memory/service.js";
import { createBotMemoryStore } from "../../../main/services/bot-memory/store.js";
import { renderBotMemorySection } from "../../../main/services/bot-memory/prompt.js";
import { botMemoryToolEntry, withBotMemoryIngress } from "../../../main/services/bot-memory/tool.js";
import { botRecallToolEntry } from "../../../main/services/bot-memory/recall.js";
import { botIngressAllowsTool } from "../../../main/services/bot-runtime/bot-tool-policy.js";
import { mcpAgentToolDescriptor } from "../../../main/services/mcp-agent-tool-descriptor.js";
import type { BotRuntimeAuthorityAdmission } from "../../../main/services/bot-runtime-authority.js";
import type { createBotApplicationService } from "../../../main/services/bot-application-service.js";
import type { createBotRuntimeAuthorityResolver } from "../../../main/services/bot-runtime-authority.js";
import type { createBotStore } from "../../../main/services/bot-store-core.js";
import type { createBotCapabilityStore } from "../../../main/services/bot-capability-store.js";
import { createCliModelRuntime } from "./providers.ts";
import { resolveRuntimeFromContext } from "./pi-bridge/model-runtime.ts";
import { cliLeaseHelperPath } from "./state.ts";
import type { BotPauseStore } from "../../../main/services/bot-pause-store.js";

export interface CliDurableBotPorts {
  application: ReturnType<typeof createBotApplicationService>;
  botStore: ReturnType<typeof createBotStore>;
  capabilities: ReturnType<typeof createBotCapabilityStore>;
  authority: ReturnType<typeof createBotRuntimeAuthorityResolver>;
  tools(admission: BotRuntimeAuthorityAdmission, context?: CliDurableBotToolContext): Promise<AgentTool[]>;
  instructions(admission: BotRuntimeAuthorityAdmission): Promise<string>;
  deleteRoutines(botId: string): Promise<void>;
  /** The CLI's pause store (`aiden bots pause`), shared so both paths read one file. */
  pauses?: BotPauseStore;
}

export interface CliDurableBotToolContext {
  attachments: Attachment[];
  loadChat(): Promise<Chat | null>;
}

/** Immutable visible transcript snapshot for this exact durable tool call. */
export function cliDurableBotToolContext(entries: readonly EntryRecord[], identity: { chatId: string; botId: string }): CliDurableBotToolContext {
  const attachmentsOf = (records: readonly EntryRecord[]) => imageAttachmentsFromEntries(records).map((image) => ({ ...image, size: Buffer.from(image.data!, "base64").byteLength }));
  const chronological = [...entries].reverse(); // call.entries() is newest first.
  const byId = new Map(chronological.map((entry) => [String(entry.id), entry]));
  const messages = projectBotTranscript(chronological).flatMap((entry) => entry.type === "user" || entry.type === "assistant" ? [{
    id: entry.id, role: entry.type, content: entry.text, createdAt: entry.at ?? 0,
    ...(entry.type === "user" && byId.has(entry.id) ? { attachments: attachmentsOf([byId.get(entry.id)!]) } : {}),
  }] : []);
  const snapshot: Chat = { id: cliSubagentIdentity(identity.chatId), botId: identity.botId, title: "Bot conversation", createdAt: messages[0]?.createdAt ?? 0,
    updatedAt: messages.at(-1)?.createdAt ?? 0, messages };
  return { attachments: attachmentsOf(chronological), loadChat: async () => structuredClone(snapshot) };
}

export async function createCliDurableBots(profileDir: string, ports: CliDurableBotPorts) {
  setBotFileToolProtectedRoots(() => [join(profileDir, "bots")]);
  const models = createBotRuntimeModels();
  const imageInputs = new Map<string, boolean>();
  const approvals = createBotApprovals({ publish: () => {} });
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir }) });
  async function admit(botId: string) {
    const chat = await ports.application.getCanonicalChat(botId) ?? await ports.application.createChat({ audienceId: "cli:local", botId });
    return ports.authority.admit({ audienceId: "cli:local", botId, chatId: chat.id });
  }
  async function admitted<T>(botId: string, action: (admission: BotRuntimeAuthorityAdmission) => Promise<T>): Promise<T> {
    const lease = await admit(botId);
    try { await lease.revalidateBeforeEffect(); return await action(lease); }
    finally { lease.release(); }
  }
  async function currentTools(botId: string) {
    return admitted(botId, (lease) => ports.tools(lease, { attachments: [], loadChat: async () => null }));
  }
  function bindTool(botId: string, tool: AgentTool, call: BotToolCall): AgentTool {
    return { ...tool, execute: (callId, args, signal, onUpdate) => admitted(botId, async (lease) => {
      const context = cliDurableBotToolContext(await call.entries(), lease.authority);
      const live = (await ports.tools(lease, context)).find((candidate) => candidate.name === tool.name);
      if (!live) throw new Error("This Bot tool is no longer available.");
      const expected = mcpAgentToolDescriptor(tool), actual = mcpAgentToolDescriptor(live);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("The connection tool changed before invocation.");
      return live.execute(callId, args, signal ? AbortSignal.any([signal, lease.signal]) : lease.signal, onUpdate);
    }) };
  }
  const runtime = await createBotSessionService({
    profileDir, leaseHelperPath: cliLeaseHelperPath(), models: models.modelsFor, pauses: ports.pauses,
    knownBotIds: async () => new Set((await ports.botStore.list()).map((bot) => bot.id)),
    resolveModel: async (botId) => {
      if (await ports.capabilities.getBotModelAuthority(botId) === undefined) return null;
      return admitted(botId, async (lease) => {
        const { sourceProviderId, sourceModelId } = lease.authority.provider;
        const resolved = await resolveRuntimeFromContext({ modelRegistry: new ModelRegistry(await createCliModelRuntime(profileDir)) }, sourceProviderId, sourceModelId);
        imageInputs.set(botId, resolved.model.input.includes("image"));
        models.register(botId, { ...resolved, streams: { streamSimple: (model, context, options) => lazyStream(model, async () => {
          const requestLease = await admit(botId);
          try {
            await requestLease.revalidateBeforeEffect();
            const selected = requestLease.authority.provider;
            if (selected.sourceProviderId !== sourceProviderId || selected.sourceModelId !== sourceModelId) throw new Error("The Bot model changed.");
            const current = await resolveRuntimeFromContext({ modelRegistry: new ModelRegistry(await createCliModelRuntime(profileDir)) }, sourceProviderId, sourceModelId);
            await requestLease.revalidateBeforeEffect();
            const stream = current.models.streamSimple(current.model, context, { ...options, apiKey: current.apiKey, headers: current.headers,
              signal: options?.signal ? AbortSignal.any([options.signal, requestLease.signal]) : requestLease.signal });
            void stream.result().then((message) => recordUsage(profileDir, "chat", message)).catch((error: unknown) => { process.stderr.write(`Bot usage could not be recorded: ${error instanceof Error ? error.message : String(error)}\n`); }).finally(() => requestLease.release());
            return stream;
          } catch (error) { requestLease.release(); throw error; }
        }) } });
        return { provider: resolved.model.provider, modelId: resolved.model.id };
      });
    },
    extension: {
      loadBot: async (botId) => { const bot = await ports.botStore.get(botId); if (!bot) throw new Error("Bot is unavailable."); return bot; },
      systemSections: (bot) => admitted(bot.id, async (lease) => [await ports.instructions(lease), `Working directory: ${lease.authority.workingDirectory}. Use only the offered tools within their granted locations.`]),
      imageInput: async (botId) => imageInputs.get(botId) ?? false,
      memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
      currentTools: async (bot) => [
        ...(await currentTools(bot.id)).map((tool) => ({
          tool: { ...tool, execute: async () => { throw new Error("A durable Bot tool requires its calling conversation."); } },
          bind: (call: BotToolCall) => bindTool(bot.id, tool, call),
          replay: "unsafe" as const, ...(mcpAgentToolDescriptor(tool) ? { mcp: true } : {}),
        })),
        botMemoryToolEntry(bot.id, memory), botRecallToolEntry(),
      ],
      checkPolicy: async (botId, name) => admitted(botId, async (lease) => {
        if (name === "bot_memory" || name === "bot_recall") return { allowed: true };
        const tool = (await ports.tools(lease, { attachments: [], loadChat: async () => null })).find((candidate) => candidate.name === name);
        if (!tool) return { allowed: false, reason: "This Bot tool is no longer available." };
        // An MCP descriptor is treated conservatively: all connection calls
        // ask the person, including providers without effect annotations.
        return { allowed: true, ...(mcpAgentToolDescriptor(tool) ? { approval: { summary: `Allow ${tool.label ?? name}?` } } : {}) };
      }),
      requestApproval: approvals.request,
      turnAllows: withBotMemoryIngress(botIngressAllowsTool),
      readmit: async (botId) => {
        if (!await ports.botStore.get(botId)) return { ok: false, reason: "bot_missing" };
        try { await admitted(botId, async () => {}); return { ok: true }; }
        catch { return { ok: false, reason: "access_changed" }; }
      },
    },
    onSessionOpen: (botId) => memory.beginSession(botId),
    deleteEffects: [ports.deleteRoutines, async (botId) => { memory.forgetBot(botId); models.forget(botId); imageInputs.delete(botId); }, async (botId) => { await ports.pauses?.forgetBot(botId); }, async (botId) => { await ports.application.deleteBot({ botId }); }],
    onReport: (botId, error) => process.stderr.write(`Bot ${botId}: ${error instanceof Error ? error.message : String(error)}\n`),
  });
  try { await runtime.initialize(); } // Inspection only; interrupted work never resumes.
  catch (error) { await runtime.shutdown(); throw error; }
  const creationKeys = createBotCreationKeyStore({ root: () => profileDir });
  const starter = createBotStarter({
    findBotByCreationKey: async (key) => {
      const id = await creationKeys.get(key);
      const bot = id ? await ports.botStore.get(id) : null;
      if (!bot && id) await creationKeys.forget(key);
      return bot ?? null;
    }, mintBotId: newBotId,
    reserveCreation: (key, botId) => creationKeys.set(key, botId),
    createBot: (bot, access, botId) => ports.application.createBot({ audienceId: "cli:local", botId, bot, access }),
    session: runtime,
  });
  return { runtime, approvals, memory, presets: { list: () => BOT_PRESETS, create: async (presetId: string, { audienceId }: { audienceId: string }) => {
    const result = await starter.startFromPreset(presetId, { createBot: (bot, botId) => ports.application.createBot({ audienceId, botId, bot }) });
    return { botId: result.bot.id, created: result.created };
  } } };
}
