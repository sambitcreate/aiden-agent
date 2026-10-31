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
import { mkdirSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTurnDecision } from "@earendil-works/pi-agent-core";
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
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import { mcpToolActivityLabel } from "../../../main/services/mcp-tool-identity.js";
import { MAX_STOP_HOOK_CONTINUATIONS, botSurfaceHooks, createSurfaceHooks, hookAskText, hookBlockText, hookNoticeLines, hookPostToolAdditions, hookStopContinuation, hookStopMessage, hookToolPayload } from "../../../main/services/agent-surface-hooks.js";
import type { HookOutcome } from "../../../main/services/hooks/hook-types.js";
import { hookTurnContextText, markWorkspaceChatCompacted, markWorkspaceChatSessionStarted, promptBlockedMessage, workspaceChatHookScopes, workspaceChatSessionStartSource } from "../../../main/services/workspace-chat-hooks.js";
import { isProtectedAgentConfigPath, PROTECTED_AGENT_CONFIG_WRITE_MESSAGE } from "../../../main/services/protected-agent-config-paths.js";

/**
 * The approval summary a paired phone shows. A call with only a command or path reads
 * like the desktop host's ("Run command: npm test"); anything else stays the exact
 * request, so nothing the call would do is hidden.
 */
export function daemonApprovalSummary(toolName: string, input: unknown): string {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  const only = (key: string) => {
    const value = args && Object.keys(args).length === 1 ? args[key] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const readable = toolName === "bash" ? only("command") && `Run command: ${only("command")}`
    : toolName === "read" ? only("path") && `Read file: ${only("path")}`
      : toolName === "ls" ? only("path") && `List folder: ${only("path")}`
        : undefined;
  return readable || `${toolName}: ${JSON.stringify(input)}`;
}

/** At most this much of a hook's ask reason joins the phone's approval summary. */
const HOOK_ASK_SUMMARY_CHARS = 400;

/**
 * Whether a pi `write` or `edit` call targets hook or agent settings
 * (`.aiden/hooks.json`, `.claude/settings.json`, the daemon's own hook
 * store …). Both the lexical path and its symlink-resolved form are checked,
 * so a link cannot route around the rule.
 */
export function daemonWriteTargetsProtectedConfig(cwd: string, input: unknown): boolean {
  const raw = input !== null && typeof input === "object" ? (input as Record<string, unknown>).path : undefined;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const target = resolve(cwd, raw.startsWith("@") ? raw.slice(1) : raw);
  const forms = [target];
  try { forms.push(realpathSync.native(target)); }
  catch {
    try { forms.push(join(realpathSync.native(dirname(target)), basename(target))); }
    catch { /* A parent that does not exist yet has no other spelling. */ }
  }
  return forms.some(isProtectedAgentConfigPath);
}

/**
 * pi's built-in tool names as Aiden names, so a hook matcher such as `Bash`
 * or `Write` (or `run_command`) matches the daemon's tools as it does the
 * desktop's. Other tools (Aiden's own, MCP) already carry Aiden names.
 */
const PI_TOOL_AIDEN_NAMES: Readonly<Record<string, string>> = {
  bash: "run_command", write: "write_file", edit: "edit_file", read: "read_file", grep: "grep", find: "glob", ls: "list_dir",
};

/** The name a hook sees for one of the daemon's tools. */
export function daemonHookToolName(toolName: string): string {
  return Object.prototype.hasOwnProperty.call(PI_TOOL_AIDEN_NAMES, toolName) ? PI_TOOL_AIDEN_NAMES[toolName]! : toolName;
}

function resultText(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** One daemon owns this store. CLI imports always copy its journals into new sessions. */
export function createDaemonChats(agentDir: string) {
  let bots: CliBotGenerationRuntime | undefined;
  const root = join(agentDir, "daemon-chats"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const chatStore = createChatStore(async () => root);
  const activity = new ChatActivityRegistry(() => {});
  const admission = new ChatTurnAdmission();
  const deletion = new ChatDeletionGate();
  const active = new Map<string, { streamId: string; ownerId: string; workspaceId?: string; abort: AbortController; cancellationOrigin?: GenerationCancellationOrigin; session?: AgentSession; settled: Promise<void>; finish(): void; release(): void }>();
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
    /** Stops the chat's turn; the first stop's origin is what its timeline records, as on the desktop. */
    async cancelChat(id: string, origin: GenerationCancellationOrigin = "chat_deletion") {
      admission.releaseChat(id); const entry = active.get(id);
      if (entry && !entry.abort.signal.aborted) entry.cancellationOrigin ??= origin;
      entry?.abort.abort(); await entry?.session?.abort();
    },
    /** A Bot the person paused: its reply ends as their Stop, and the chat is kept. */
    async stopChatWork(id: string) { await llmClient.cancelChat(id, "user_stop"); return llmClient.waitForChatIdle(id); },
    approve(id: string, decision: "allow" | "deny", ownerId: string) {
      const pending = approvals.get(id); if (!pending || pending.ownerId !== ownerId) return false;
      approvals.delete(id); pending.resolve(decision === "allow"); return true;
    },
    cancel(streamId: string, ownerId: string) {
      const pair = [...active.entries()].find(([, entry]) => entry.streamId === streamId && entry.ownerId === ownerId);
      if (!pair) return false;
      void llmClient.cancelChat(pair[0], "user_stop"); return true;
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
          bots?.assertLegacyChatAllowed?.();
          if (!bots || !options.botAudienceId) throw new Error("This chat requires a Bot capability audience.");
          await bots.assertNotPaused(chat.botId);
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
        // Hooks (docs/plans/aiden-hooks-plan.md §7): a workspace chat runs the
        // person's global, workspace and chat hooks; a legacy Bot chat runs
        // global and Bot hooks, for its tools only.
        const hookTarget = { chatId: chat.id, ...(workspace.folderPath ? { workspaceRoot: workspace.folderPath } : {}) };
        const hooks = botAdmission ? botSurfaceHooks(chat.botId!, cwd) : createSurfaceHooks({ scopes: workspaceChatHookScopes(hookTarget), cwd, sessionId: chat.id });
        let turnHookContext: string | undefined;
        // Hook messages reach the person as transcript status events, never the model.
        const reportHookLines = (messages: readonly string[]) => { if (messages.length) send("chat:status", { streamId, phase: "hook_messages", messages: [...messages] }); };
        // PreToolUse context waits for its tool's result; a hook's `continue: false` ends the turn after the tool.
        const preToolContext = new Map<string, string>();
        let hookStop: string | undefined;
        const requestHookStop = (outcome: HookOutcome | undefined) => {
          if (!outcome?.stopTurn || hookStop !== undefined) return;
          hookStop = hookStopMessage(outcome); reportHookLines([hookStop]);
        };
        const dispatchHook = async (...args: Parameters<typeof hooks.dispatch>) => {
          const outcome = await hooks.dispatch(...args);
          reportHookLines(hookNoticeLines(outcome));
          return outcome;
        };
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
        const registeredTools: { readonly name: string; readonly label?: string }[] = [];
        // Activity shows MCP tools by their server label, not the generated name.
        timeline.setToolLabels((toolName) => mcpToolActivityLabel([...botTools, ...registeredTools], toolName));
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
              additionalNames.push(tool.name); registeredTools.push(tool); target.registerTool(tool);
            };
            return Reflect.get(target, key, receiver);
          } })),
        }));
        const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          extensionFactories: [...additionalExtensions, { name: "aiden-daemon-authority", factory(pi) {
            pi.on("before_agent_start", async (event) => {
              // SessionStart and UserPromptSubmit context, once per turn, as host data the chat store never saves.
              const context = turnHookContext; turnHookContext = undefined;
              if (!botAdmission) return context ? { message: { customType: "aiden-hook-context", content: context, display: false } } : undefined;
              await assertAuthority();
              const instructions = await bots!.instructions(botAdmission);
              return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
            });
            for (const tool of botTools) pi.registerTool({ ...tool, label: tool.label ?? tool.name });
            pi.on("tool_call", async (event) => {
            try {
              await assertAuthority();
              if (botAdmission && !botTools.some((tool) => tool.name === event.toolName)) return { block: true, reason: "This tool is outside the Bot capability grant." };
              const tier = botAdmission ? "full" : workspace.folderPath ? accessFor(agentDir, cwd) : "none";
              if (tier === "none") return { block: true, reason: "Workspace tools are disabled." };
              if (!botAdmission && (event.toolName === "write" || event.toolName === "edit") && daemonWriteTargetsProtectedConfig(cwd, event.input)) return { block: true, reason: PROTECTED_AGENT_CONFIG_WRITE_MESSAGE };
              // PreToolUse runs after Aiden's own rules allowed the call, so a
              // hook can only tighten them; its updatedInput is not applied.
              const hooked = await dispatchHook("PreToolUse", { ...hookToolPayload(daemonHookToolName(event.toolName), event.input), tool_use_id: event.toolCallId },
                { idempotencyKey: `PreToolUse:${chat.id}:${event.toolCallId}`, signal: entry.abort.signal });
              if (hooked) await assertAuthority();
              requestHookStop(hooked);
              if (hooked?.additionalContext) preToolContext.set(event.toolCallId, hooked.additionalContext);
              if (hooked?.decision === "deny") return { block: true, reason: hookBlockText(hooked) };
              const hookAsks = hooked?.decision === "ask";
              if (hookAsks && (botAdmission || unattended)) return { block: true, reason: `${hookBlockText(hooked)} No one is here to approve it on this turn.` };
              if (tier === "full" && !hookAsks) return;
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
                else send("chat:approval", { streamId, approvalId, toolCallId: event.toolCallId, toolName: event.toolName, summary: hookAsks ? `${hookAskText(hooked).slice(0, HOOK_ASK_SUMMARY_CHARS)}\n${daemonApprovalSummary(event.toolName, event.input)}` : daemonApprovalSummary(event.toolName, event.input) });
              });
              await assertAuthority();
              if (!allowed || JSON.stringify(event.input) !== original || accessFor(agentDir, cwd) === "none") return { block: true, reason: "The tool request was denied, changed or expired." };
            }
            catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
          });
            pi.on("tool_result", async (event) => {
              const hookToolName = daemonHookToolName(event.toolName);
              const preContext = preToolContext.get(event.toolCallId);
              preToolContext.delete(event.toolCallId);
              const outcome = hooks.has("PostToolUse", hookToolName) ? await dispatchHook("PostToolUse", {
                ...hookToolPayload(hookToolName, event.input), tool_use_id: event.toolCallId,
                tool_response: { content: resultText(event.content), is_error: event.isError },
              }, { idempotencyKey: `PostToolUse:${chat.id}:${event.toolCallId}`, signal: entry.abort.signal }) : undefined;
              requestHookStop(outcome);
              const addition = [preContext, hookPostToolAdditions(outcome)].filter(Boolean).join("\n\n");
              return addition ? { content: [...event.content, { type: "text" as const, text: addition }] } : undefined;
            });
            pi.on("session_before_compact", (event) => {
              hooks.observe("PreCompact", { trigger: event.reason === "manual" ? "manual" : "auto", aiden_reason: event.reason },
                { idempotencyKey: `PreCompact:${chat.id}:${streamId}:${event.reason}` });
            });
            pi.on("session_compact", () => { if (!botAdmission) markWorkspaceChatCompacted(chat.id); });
          } }],
        });
        await loader.reload(); await assertAuthority();
        const manager = SessionManager.open(sessionPath(params.chatId), join(root, "journals"), cwd);
        const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
          thinkingLevel: params.thinkingLevel, resourceLoader: loader, sessionManager: manager,
          tools: botAdmission ? botTools.map((tool) => tool.name) : workspace.folderPath ? ["read", "bash", "edit", "write", "grep", "find", "ls", ...additionalNames] : [],
        });
        entry.session = session;
        // A hook's `continue: false` ends the run once the current tool batch finishes.
        const sessionFinishTurn = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
          const decision = await sessionFinishTurn?.(turn, signal);
          return hookStop !== undefined ? { action: "end" } : decision ?? undefined;
        };
        await session.bindExtensions({ mode: "rpc" });
        await assertAuthority();
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
        if (!botAdmission) {
          const hookContext: (string | undefined)[] = [];
          const source = workspaceChatSessionStartSource(chat.id, chat.messages.some((message) => message.role === "assistant"));
          if (source) {
            const started = await dispatchHook("SessionStart", { source }, { idempotencyKey: `SessionStart:${chat.id}:${streamId}`, signal: entry.abort.signal });
            markWorkspaceChatSessionStarted(hookTarget);
            hookContext.push(started?.additionalContext);
          }
          const submitted = await dispatchHook("UserPromptSubmit", { prompt: input.content }, { idempotencyKey: `UserPromptSubmit:${chat.id}:${streamId}`, signal: entry.abort.signal });
          if (submitted?.blockPrompt || submitted?.stopTurn) {
            // The prompt never reaches the journal; marking the stored copy keeps forks and summaries from sending it later.
            const blocked = promptBlockedMessage(submitted);
            const stored = chat.messages.findLast((message) => message.role === "user");
            if (stored?.content === input.content) {
              await chatStore.setPromptHookBlock(chat.id, stored.id, blocked).catch(() => { process.stderr.write("aiden: Could not mark a hook-blocked prompt.\n"); });
            }
            throw new Error(blocked);
          }
          hookContext.push(submitted?.additionalContext);
          turnHookContext = hookTurnContextText(hookContext);
        }
        await assertAuthority();
        await session.prompt(text, { expandPromptTemplates: false, preflightResult: (accepted) => { if (accepted) options.onTurnAccepted?.(); }, images: (model.input.includes("image") ? attachments : []).flatMap((item) => item.kind === "image" && item.data ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }] : []) });
        if (entry.abort.signal.aborted) throw new Error("Generation cancelled.");
        // Stop hooks may keep a workspace chat's turn going, at most MAX_STOP_HOOK_CONTINUATIONS times.
        for (let continuation = 0; !botAdmission && hookStop === undefined && continuation < MAX_STOP_HOOK_CONTINUATIONS; continuation += 1) {
          const ended = produced.at(-1);
          if (entry.abort.signal.aborted || !ended || ended.stopReason === "error" || ended.stopReason === "aborted" || ended.stopReason === "length") break;
          const stop = await dispatchHook("Stop", { stop_hook_active: continuation > 0 }, { idempotencyKey: `Stop:${chat.id}:${streamId}:${continuation}`, signal: entry.abort.signal });
          const next = hookStopContinuation(stop);
          if (!next) break;
          await assertAuthority();
          await session.prompt(next, { expandPromptTemplates: false });
        }
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
        const finalTimeline = cancelled ? timeline.finish("cancelled", entry.cancellationOrigin) : timeline.finish("failed");
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
    async stop() { const ids = new Set([...reserved, ...active.keys()]); admission.releaseAll(); await Promise.allSettled([...ids].map((id) => llmClient.cancelChat(id, "application_shutdown"))); await Promise.all([...ids].map((id) => llmClient.waitForChatIdle(id))); },
  };
}
