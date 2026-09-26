import { createMemoryInlineExtension } from "./extensions/memory.ts";
import { createWebSearchInlineExtension } from "./extensions/web-search.ts";
import { createTodoInlineExtension } from "./extensions/todo.ts";
import { createAdvisorInlineExtension } from "./extensions/advisor.ts";
import { createArtifactsExtension } from "./extensions/artifacts.ts";
import { createMcpExtension } from "./mcp.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { visionAttachmentAlias } from "../../../main/services/vision-attachment-reference.js";
import type { CliBotGenerationRuntime } from "./bots.ts";
import type { BotRuntimeAuthorityAdmission } from "../../../main/services/bot-runtime-authority.js";
import { assertBotRuntimeProviderSelection } from "../../../main/services/bot-runtime-authority.js";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createChatStore } from "../../../main/services/chat-store-core.js";
import { ChatActivityRegistry } from "../../../main/services/chat-activity-core.js";
import type { ChatStartParams } from "../../../main/services/types.js";
import type { ChatGenerationOwner } from "../../../main/services/chat-generation-owner.js";
import type { UsageRequestSource } from "../../../main/services/usage-store-core.js";
import { ChatTurnAdmission } from "../../../main/services/chat-turn-admission.js";
import { ChatDeletionGate } from "../../../main/services/chat-deletion-gate.js";
import { parseAttachments } from "../../../main/services/attachment-contract.js";
import { createCliModelRuntime } from "./providers.ts";
import { acquireLease } from "./state.ts";
import { workspaceStore, accessFor } from "./workspaces.ts";
import { recordUsage } from "./usage-ledger.ts";
import { messageText } from "./sessions.ts";
import { GenerationTimelineProjector } from "../../../main/services/generation-timeline.js";

/** One daemon owns this store. CLI imports always copy its journals into new sessions. */
export function createDaemonChats(agentDir: string) {
  let bots: CliBotGenerationRuntime | undefined;
  const root = join(agentDir, "daemon-chats"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const chatStore = createChatStore(async () => root);
  const activity = new ChatActivityRegistry(() => {});
  const admission = new ChatTurnAdmission();
  const deletion = new ChatDeletionGate();
  const active = new Map<string, { streamId: string; ownerId: string; workspaceId?: string; abort: AbortController; session?: AgentSession; settled: Promise<void>; finish(): void; release(): void }>();
  const reserved = new Set<string>();
  const idleWaiters = new Map<string, Set<() => void>>();
  const wakeIdle = (id: string) => { for (const wake of idleWaiters.get(id) ?? []) wake(); idleWaiters.delete(id); };
  const approvals = new Map<string, { ownerId: string; resolve(allowed: boolean): void }>();
  const sessionPath = (id: string) => join(root, "journals", `${createHash("sha256").update(id).digest("hex")}.jsonl`);
  const llmClient = {
    beginChatTurn(chatId: string, streamId: string, ownerId: string) {
      if (deletion.isDeleting(chatId) || new Set([...reserved, ...active.keys()]).size >= 3) return null;
      const lease = admission.tryBegin(chatId, streamId, ownerId, active.has(chatId));
      if (lease) {
        reserved.add(chatId);
        lease.onReleased(() => { reserved.delete(chatId); queueMicrotask(() => wakeIdle(chatId)); });
        const settle = lease.settleAsyncWork;
        lease.settleAsyncWork = () => { settle(); wakeIdle(chatId); };
      }
      return lease;
    },
    isChatBusy: (id: string) => active.has(id) || admission.isAdmitted(id),
    async waitForChatIdle(id: string) {
      while (active.has(id) || admission.isAdmitted(id)) {
        const running = active.get(id);
        if (running) await running.settled;
        else await new Promise<void>((resolve) => {
          const waiters = idleWaiters.get(id) ?? new Set(); waiters.add(resolve); idleWaiters.set(id, waiters);
        });
      }
      return true;
    },
    async cancelChat(id: string) { admission.releaseChat(id); const entry = active.get(id); entry?.abort.abort(); await entry?.session?.abort(); },
    approve(id: string, decision: "allow" | "deny", ownerId: string) {
      const pending = approvals.get(id); if (!pending || pending.ownerId !== ownerId) return false;
      approvals.delete(id); pending.resolve(decision === "allow"); return true;
    },
    cancel(streamId: string, ownerId: string) {
      const pair = [...active.entries()].find(([, entry]) => entry.streamId === streamId && entry.ownerId === ownerId);
      if (!pair) return false;
      void llmClient.cancelChat(pair[0]); return true;
    },
    async start(streamId: string, params: ChatStartParams, owner: ChatGenerationOwner, options: { usageSource: UsageRequestSource; turnId?: string; botAudienceId?: string; onTurnAccepted?(): void }) {
      if (owner.isDestroyed() || !admission.owns(params.chatId, options.turnId ?? streamId, owner.documentId)) return false;
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => { finish = resolve; });
      let releaseFile: () => void;
      try { releaseFile = acquireLease(sessionPath(params.chatId)); }
      catch (error) { admission.releaseMatching(params.chatId, options.turnId ?? streamId, owner.documentId); throw error; }
      const entry = { streamId, ownerId: owner.documentId, workspaceId: params.workspaceId, abort: new AbortController(), settled, finish,
        session: undefined as AgentSession | undefined,
        release() { if (active.get(params.chatId) !== entry) return; active.delete(params.chatId); activity.settle(streamId); releaseFile(); finish(); wakeIdle(params.chatId); },
      };
      const handedOff = admission.handoff(params.chatId, options.turnId ?? streamId, owner.documentId, () => { active.set(params.chatId, entry); activity.begin(streamId, params.chatId); });
      if (!handedOff) { releaseFile(); return false; }
      void perform(streamId, params, owner, options, entry).finally(entry.release).catch(() => {
        process.stderr.write("aiden: Could not deliver the terminal generation event.\n");
      });
      return true;
    },
  };
  async function perform(streamId: string, params: ChatStartParams, owner: ChatGenerationOwner, options: { usageSource: UsageRequestSource; turnId?: string; botAudienceId?: string; onTurnAccepted?(): void }, entry: NonNullable<ReturnType<typeof active.get>>) {
      let unsubscribe = () => {};
      let botAdmission: BotRuntimeAuthorityAdmission | undefined;
      let removeBotAbort = () => {};
      const disposeOwner = owner.onInvalidated(() => { entry.abort.abort(); void entry.session?.abort(); });
      const timer = setTimeout(() => { entry.abort.abort(); void entry.session?.abort(); }, 300_000);
      const send: typeof owner.send = (channel, payload) => { if (!owner.isDestroyed()) owner.send(channel, payload); };
      const produced: AssistantMessage[] = [];
      let content = "", separator = false, persisted = false;
      const timeline = new GenerationTimelineProjector(streamId, (value) => send("chat:timeline", { streamId, timeline: value }));
      try {
        const chat = await chatStore.get(params.chatId);
        if (!chat) throw new Error("The chat is unavailable.");
        if (chat.botId) {
          if (!bots || !options.botAudienceId) throw new Error("This chat requires a Bot capability audience.");
          botAdmission = await bots.authority.admit({ audienceId: options.botAudienceId, botId: chat.botId, chatId: chat.id });
          assertBotRuntimeProviderSelection(botAdmission.authority.provider, { providerId: params.providerId, model: params.model });
          const cancel = () => { entry.abort.abort(); void entry.session?.abort(); };
          botAdmission.signal.addEventListener("abort", cancel, { once: true });
          removeBotAbort = () => botAdmission?.signal.removeEventListener("abort", cancel);
          if (botAdmission.signal.aborted) cancel();
        }
        const workspace = botAdmission ? { id: botAdmission.authority.managedHome.workspaceId, folderPath: botAdmission.authority.workingDirectory } : (await workspaceStore(agentDir).load()).find((workspace) => workspace.id === params.workspaceId);
        if (!workspace) throw new Error("The workspace is unavailable.");
        const unattended = !botAdmission && (options.usageSource === "telegram" || options.usageSource === "scheduled");
        if (unattended && (!workspace.folderPath || accessFor(agentDir, workspace.folderPath) !== "full")) throw new Error("Unattended generation requires explicitly granted full workspace access.");
        const cwd = workspace.folderPath || root;
        const assertAuthority = async () => {
          if (entry.abort.signal.aborted || owner.isDestroyed()) throw new Error("Generation authority was revoked.");
          if (botAdmission) { await botAdmission.revalidateBeforeEffect(); return; }
          const current = (await workspaceStore(agentDir).load()).find((item) => item.id === workspace.id);
          if (entry.abort.signal.aborted || owner.isDestroyed() || current?.folderPath !== workspace.folderPath || (unattended && accessFor(agentDir, cwd) !== "full")) throw new Error("The unattended workspace authority was revoked.");
        };
        const runtime = await createCliModelRuntime(agentDir);
        const model = runtime.getModel(params.providerId, params.model);
        if (!model) throw new Error("The saved provider/model is unavailable.");
        const botTools = botAdmission ? await bots!.tools(botAdmission) : [];
        const additionalNames: string[] = [];
        const extensions: InlineExtension[] = botAdmission || !workspace.folderPath ? [] : [
          // A corrupt settings file or wedged shared DB must degrade to
          // no-memory, never brick the generation (desktop parity: llm-client
          // warns and continues without memory).
          await createMemoryInlineExtension({ agentDir, workspaceRoot: cwd, readOnly: unattended })
            .catch((error: unknown) => {
              process.stderr.write(`[daemon-chats] memory unavailable: ${error instanceof Error ? error.message : error}\n`);
              return { name: "aiden-memory", factory: () => undefined };
            }),
          createTodoInlineExtension({ latestContext: () => undefined }),
          createMcpExtension(agentDir),
          createAdvisorInlineExtension({ agentDir, latestContext: () => undefined }),
          createArtifactsExtension(agentDir),
        ];
        if (!botAdmission && workspace.folderPath) {
          const web = await createWebSearchInlineExtension({ agentDir });
          if (web) extensions.push(web);
        }
        const additionalExtensions = extensions.map((extension): InlineExtension => ({
          name: extension.name,
          factory: (pi) => (typeof extension === "function" ? extension : extension.factory)(new Proxy(pi, { get(target, key, receiver) {
            if (key === "registerTool") return (tool: Parameters<typeof pi.registerTool>[0]) => {
              additionalNames.push(tool.name); target.registerTool(tool);
            };
            return Reflect.get(target, key, receiver);
          } })),
        }));
        const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          extensionFactories: [...additionalExtensions, { name: "aiden-daemon-authority", factory(pi) {
            pi.on("before_agent_start", async (event) => {
              if (!botAdmission) return;
              await assertAuthority();
              const instructions = await bots!.instructions(botAdmission);
              return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
            });
            for (const tool of botTools) pi.registerTool({ ...tool, label: tool.label ?? tool.name });
            pi.on("tool_call", async (event) => {
            try {
              await assertAuthority();
              if (botAdmission) return botTools.some((tool) => tool.name === event.toolName) ? undefined : { block: true, reason: "This tool is outside the Bot capability grant." };
              const tier = workspace.folderPath ? accessFor(agentDir, cwd) : "none";
              if (tier === "none") return { block: true, reason: "Workspace tools are disabled." };
              if (tier === "full") return;
              const original = JSON.stringify(event.input);
              if (Buffer.byteLength(original) > 1_700) return { block: true, reason: "The tool request exceeds the remote approval display budget." };
              timeline.toolAwaitingApproval(event.toolCallId);
              const approvalId = `approval_${randomUUID()}`;
              const allowed = await new Promise<boolean>((resolve) => {
                const settle = (result: boolean) => { clearTimeout(expiry); entry.abort.signal.removeEventListener("abort", cancel); approvals.delete(approvalId); resolve(result); };
                const cancel = () => settle(false);
                const expiry = setTimeout(cancel, 300_000);
                approvals.set(approvalId, { ownerId: owner.documentId, resolve: settle });
                entry.abort.signal.addEventListener("abort", cancel, { once: true });
                if (entry.abort.signal.aborted) cancel();
                else send("chat:approval", { streamId, approvalId, toolCallId: event.toolCallId, toolName: event.toolName, summary: `${event.toolName}: ${original}` });
              });
              await assertAuthority();
              if (!allowed || JSON.stringify(event.input) !== original || accessFor(agentDir, cwd) === "none") return { block: true, reason: "The tool request was denied, changed or expired." };
            }
            catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
          }); } }],
        });
        await loader.reload(); await assertAuthority();
        const manager = SessionManager.open(sessionPath(params.chatId), join(root, "journals"), cwd);
        const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
          thinkingLevel: params.thinkingLevel, resourceLoader: loader, sessionManager: manager,
          tools: botAdmission ? botTools.map((tool) => tool.name) : workspace.folderPath ? ["read", "bash", "edit", "write", "grep", "find", "ls", ...additionalNames] : [],
        });
        entry.session = session;
        unsubscribe = session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            timeline.thinkingEnded();
            const delta = (separator && content ? "\n" : "") + event.assistantMessageEvent.delta;
            separator = false; content += delta; timeline.setContentOffset(content.length);
            send("chat:delta", { streamId, delta });
          }
          if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
            timeline.thinkingStarted(); send("chat:reasoning-delta", { streamId, delta: event.assistantMessageEvent.delta });
          }
          if (event.type === "message_end" && event.message.role === "assistant") { produced.push(event.message); separator = true; }
          if (event.type === "tool_execution_start") {
            timeline.toolStarted(event.toolCallId, event.toolName, event.args);
            send("chat:tool", { streamId, toolName: event.toolName, phase: "call" });
          }
          if (event.type === "tool_execution_end") {
            timeline.toolFinished(event.toolCallId, event.isError ? "failed" : "completed");
            send("chat:tool", { streamId, toolName: event.toolName, phase: event.isError ? "error" : "result" });
          }
        });
        const input = params.messages.at(-1) ?? chat.messages.at(-1);
        if (!input) throw new Error("A user message is required.");
        const attachments = parseAttachments(input.attachments ?? []) ?? [];
        const text = [input.content, ...attachments.filter((item) => item.kind === "image" && !model.input.includes("image")).map((item) => `Attached image: ${visionAttachmentAlias(item)} (${item.name}). Use inspect_image to analyze it.`), ...attachments.filter((item) => item.kind === "text").map((item) => `Attachment: ${item.name}\n${item.text ?? ""}`)].join("\n\n");
        await assertAuthority();
        await session.prompt(text, { expandPromptTemplates: false, preflightResult: (accepted) => { if (accepted) options.onTurnAccepted?.(); }, images: (model.input.includes("image") ? attachments : []).flatMap((item) => item.kind === "image" && item.data ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }] : []) });
        if (entry.abort.signal.aborted) throw new Error("Generation cancelled.");
        const last = produced.at(-1);
        if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "Generation returned no final answer.");
        content ||= produced.map((message) => messageText(message.content)).filter(Boolean).join("\n");
        const finalTimeline = timeline.finish("completed");
        const updated = await chatStore.appendMessage(params.chatId, { role: "assistant", content, timeline: finalTimeline }, { providerId: model.provider, model: model.id });
        persisted = true;
        send("chat:done", { streamId, content, chat: updated, timeline: finalTimeline }); return true;
      } catch (error) {
        const cancelled = entry.abort.signal.aborted;
        const finalTimeline = timeline.finish(cancelled ? "cancelled" : "failed");
        if (!persisted && (content || produced.length)) {
          await chatStore.appendMessage(params.chatId, { role: "assistant", content, timeline: finalTimeline }).catch(() => {
            process.stderr.write("aiden: Could not persist the partial response.\n");
          });
        }
        send("chat:error", { streamId, message: error instanceof Error ? error.message : String(error), cancelled, timeline: finalTimeline }); return true;
      } finally {
        clearTimeout(timer); unsubscribe(); disposeOwner(); removeBotAbort(); botAdmission?.release();
        if (entry.session) {
          try { await entry.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
          finally { entry.session.dispose(); }
        }
        for (const message of produced) await recordUsage(agentDir, options.usageSource, message).catch(() => {});
      }
  }
  return { chatStore, llmClient, activity, admission, deletion, sessionPath,
    setBots(runtime: CliBotGenerationRuntime) { bots = runtime; },
    async stop() { const ids = new Set([...reserved, ...active.keys()]); admission.releaseAll(); await Promise.allSettled([...ids].map((id) => llmClient.cancelChat!(id))); await Promise.all([...ids].map((id) => llmClient.waitForChatIdle(id))); },
  };
}
