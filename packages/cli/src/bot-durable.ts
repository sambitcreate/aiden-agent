import { botMessageChainOf } from "../../../renderer/shared/bot-messages.js";
import { createBotMessageLedger } from "../../../main/services/bot-messages/ledger.js";
import { createBotMessageCourier } from "../../../main/services/bot-messages/courier.js";
import { createBotMessageLifecycle } from "../../../main/services/bot-messages/lifecycle.js";
import { projectBotMessageRoster } from "../../../main/services/bot-messages/roster.js";
import { messageBotCandidate } from "../../../main/services/bot-messages/candidate.js";
import { createCliBotSpending } from "./bot-spending.ts";
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
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setBotFileToolProtectedRoots } from "../../../main/services/bot-file-tool-router.js";
import { cliBotProtectedRoots } from "../../../main/services/bot-protected-settings.js";
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
import { composioServiceCallRequiresForeground, isComposioServiceToolDescriptor } from "../../../main/services/composio-service-tool.js";
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
  pauses: BotPauseStore;
  /** Absent means on, like the desktop setting. */
  messagingEnabled?(): Promise<boolean>;
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
  // Like the desktop, a Bot's file tools cannot edit Aiden's settings files.
  setBotFileToolProtectedRoots(() => cliBotProtectedRoots(profileDir));
  const models = createBotRuntimeModels();
  const imageInputs = new Map<string, boolean>();
  const approvals = createBotApprovals({ publish: () => {} });
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir }) });
  const stateListeners = new Set<(botId: string) => void>();
  /** Pause changes commit no entry; open phone streams hear them here. */
  const stateChanges = (listener: (botId: string) => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; };
  const spending = createCliBotSpending(profileDir);
  const spendingRefusal = async (botId: string) => spending.refusal(botId, (await ports.botStore.get(botId))?.name);
  const roster = async () => projectBotMessageRoster(await ports.botStore.list(), {
    paused: async (id) => (await ports.pauses.get(id)) !== undefined,
    hasModel: async (id) => {
      if (await ports.capabilities.getBotModelAuthority(id) === undefined) return false;
      await admitted(id, async () => {});
      return true;
    },
    spendingRefusal: (id, name) => spending.refusal(id, name),
    report: (id, error) => process.stderr.write(`Bot ${id} messaging availability: ${String(error)}\n`),
  });
  const messages = createBotMessageLifecycle({
    report: (error) => process.stderr.write(`Bot messaging could not start: ${String(error)}\n`),
    create: () => createBotMessageCourier({
      ledger: createBotMessageLedger({ file: () => join(profileDir, "bots", "bot-messages.json"), now: Date.now }),
      // Only external courier work reaches sessions. Tool post() reads local authority only.
      sessions: {
        send: (...args) => runtime.send(...args), awaitReply: (...args) => runtime.awaitReply(...args),
        markSilent: (...args) => runtime.markSilent(...args), appendEntry: (...args) => runtime.appendEntry(...args),
        state: (...args) => runtime.state(...args), submissionForRequest: (...args) => runtime.submissionForRequest(...args),
        awaitMessageTaskSettlement: (...args) => runtime.awaitMessageTaskSettlement(...args),
      },
      roster, botExists: async (botId) => (await ports.botStore.get(botId)) !== null,
      enabled: () => ports.messagingEnabled?.() ?? Promise.resolve(true), approvals, onStateChange: stateChanges,
      now: Date.now, setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return { cancel: () => clearTimeout(timer) }; },
      report: (error) => process.stderr.write(`Bot message courier: ${String(error)}\n`),
    }),
  });
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
    spendingRefusal,
    knownBotIds: async () => new Set((await ports.botStore.list()).map((bot) => bot.id)),
    resolveModel: async (botId) => {
      if (await ports.capabilities.getBotModelAuthority(botId) === undefined) return null;
      return admitted(botId, async (lease) => {
        const { sourceProviderId, sourceModelId } = lease.authority.provider;
        const cliModels = await createCliModelRuntime(profileDir);
        const resolved = await resolveRuntimeFromContext({ modelRegistry: new ModelRegistry(cliModels) }, sourceProviderId, sourceModelId);
        imageInputs.set(botId, resolved.model.input.includes("image"));
        spending.register(botId, { local: /^(ollama|lmstudio)$/.test(sourceProviderId), provider: resolved.provider, models: cliModels });
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
      currentTools: async (bot, turn) => {
        const available = botMessageChainOf([turn.requestId]).canSend && (await (ports.messagingEnabled?.() ?? Promise.resolve(true)))
          ? (await ports.botStore.list()).map((peer) => ({
            id: peer.id, name: peer.name, purpose: peer.description ?? "",
            acceptsMessages: peer.acceptsBotMessages !== false,
            sendsMessages: peer.messagesOtherBots !== false,
          })) : [];
        const offer = available.find((item) => item.id === bot.id)?.sendsMessages && available.some((item) => item.id !== bot.id && item.acceptsMessages);
        return [
          ...(await currentTools(bot.id)).map((tool) => ({
            tool: { ...tool, execute: async () => { throw new Error("A durable Bot tool requires its calling conversation."); } },
            bind: (call: BotToolCall) => bindTool(bot.id, tool, call),
            replay: "unsafe" as const, ...(mcpAgentToolDescriptor(tool) ? { mcp: true } : {}),
          })),
          botMemoryToolEntry(bot.id, memory), botRecallToolEntry(),
          ...(offer ? [{ ...await messageBotCandidate(bot.id, { roster, descriptionRoster: available, post: (input) => messages.post(input) }), replay: "safe" as const }] : []),
        ];
      },
      checkPolicy: async (botId, name, call) => admitted(botId, async (lease) => {
        if (name === "bot_memory" || name === "bot_recall" || name === "message_bot") return { allowed: true };
        const tool = (await ports.tools(lease, { attachments: [], loadChat: async () => null })).find((candidate) => candidate.name === name);
        if (!tool) return { allowed: false, reason: "This Bot tool is no longer available." };
        if (composioServiceCallRequiresForeground(call?.args) && isComposioServiceToolDescriptor(mcpAgentToolDescriptor(tool))
          && !botIngressAllowsTool("sign_in", call?.requestIds ?? [])) return { allowed: false, reason: "Composio connection setup needs the person in the foreground." };
        // An MCP descriptor is treated conservatively: all connection calls
        // ask the person, including providers without effect annotations.
        return { allowed: true, ...(mcpAgentToolDescriptor(tool) ? { approval: { summary: `Allow ${tool.label ?? name}?` } } : {}) };
      }),
      requestApproval: async (request) => {
        const window = await messages.announceWaiting(request.botId, request.owner?.inputs.map((input) => input.requestId) ?? [], request.summary, request.waitId);
        if (window?.expired) return { id: request.waitId, authorizationFingerprint: request.authorizationFingerprint, answer: "deny", source: "expiry" };
        return approvals.request(request);
      },
      spending: {
        refusal: (botId, requestIds) => spending.refusal(botId, undefined, requestIds),
        record: (botId, requestIds, message) => spending.record(botId, requestIds, message),
      },
      codemodeSandbox: botCodemodeSandbox,
      turnAllows: withBotMemoryIngress(botIngressAllowsTool),
      readmit: async (botId) => {
        if (!await ports.botStore.get(botId)) return { ok: false, reason: "bot_missing" };
        try { await admitted(botId, async () => {}); return { ok: true }; }
        catch { return { ok: false, reason: "access_changed" }; }
      },
    },
    onSessionOpen: (botId) => memory.beginSession(botId),
    onStateChange: (botId) => {
      for (const listener of stateListeners) {
        try { listener(botId); } catch (error) { process.stderr.write(`Bot ${botId} state listener failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
    },
    deleteEffects: [(botId) => messages.forgetBot(botId), ports.deleteRoutines, async (botId) => { try { await spending.forgetBot(botId); } catch (error) { process.stderr.write(`Bot ${botId} spending cleanup: ${String(error)}\n`); } }, async (botId) => { memory.forgetBot(botId); models.forget(botId); imageInputs.delete(botId); }, async (botId) => { await ports.pauses.forgetBot(botId); }, async (botId) => { await ports.application.deleteBot({ botId }); }],
    onReport: (botId, error) => process.stderr.write(`Bot ${botId}: ${error instanceof Error ? error.message : String(error)}\n`),
  });
  try { await runtime.initialize(); await messages.start(); } // Interrupted runs stay paused; accepted courier work reattaches.
  catch (error) { await messages.dispose(); await runtime.shutdown(); throw error; }
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
  return { runtime, messages, approvals, memory, stateChanges, presets: { list: () => BOT_PRESETS, create: async (presetId: string, { audienceId }: { audienceId: string }) => {
    const result = await starter.startFromPreset(presetId, { createBot: (bot, botId) => ports.application.createBot({ audienceId, botId, bot }) });
    return { botId: result.bot.id, created: result.created };
  } } };
}

/**
 * The sandbox Bot scripts run in. pi-codemode's own worker file is not on disk
 * in the bundle, so workers start from the CLI's bundled codemode worker, read
 * once into a data: URL (as Pi does) so an update that replaces the file never
 * breaks a running daemon.
 */
function botCodemodeSandbox(): CodemodeSandbox {
  const worker = join(dirname(process.env.AIDEN_CLI_ENTRY!), "chunks", "codemode-worker.js");
  return new CodemodeSandbox({
    memoryLimitBytes: 64 * 1024 * 1024,
    wasm: loadQuickJSWasm(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")),
    workerUrl: new URL(`data:text/javascript;base64,${readFileSync(worker).toString("base64")}`),
  });
}
