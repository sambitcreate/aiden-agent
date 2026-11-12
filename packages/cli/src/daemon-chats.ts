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
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTurnDecision } from "@earendil-works/pi-agent-core";
import { createChatStore } from "../../../main/services/chat-store-core.js";
import { ChatActivityRegistry } from "../../../main/services/chat-activity-core.js";
import type { ChatActivitySnapshot } from "../../../renderer/shared/chat-activity.js";
import { HostRunRegistry } from "../../../main/services/host-run-registry.js";
import { createHostRunRecorders } from "../../../main/services/host-runs.js";
import type { ChatStartParams } from "../../../main/services/types.js";
import type { ChatGenerationOwner } from "../../../main/services/chat-generation-owner.js";
import type { UsageRequestSource } from "../../../main/services/usage-store-core.js";
import { ChatTurnAdmission } from "../../../main/services/chat-turn-admission.js";
import { ChatDeletionGate } from "../../../main/services/chat-deletion-gate.js";
import { parseAttachments, withReadableImages } from "../../../main/services/attachment-contract.js";
import { createCliModelRuntime } from "./providers.ts";
import { acquireLease, JsonStore, readJson } from "./state.ts";
import { deleteCliBotSubagentHistory } from "./bot-subagents.ts";
import { DaemonGenerationRun, DaemonTurnOwner } from "./daemon-turn-lifecycle.ts";
import { createDaemonApprovals } from "./daemon-approvals.ts";
import { workspaceStore, accessFor } from "./workspaces.ts";
import { recordUsage } from "./usage-ledger.ts";
import { messageText } from "./sessions.ts";
import { GenerationTimelineProjector } from "../../../main/services/generation-timeline.js";
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import { mcpToolActivityLabel } from "../../../main/services/mcp-tool-identity.js";
import { MAX_STOP_HOOK_CONTINUATIONS, botSurfaceHooks, createSurfaceHooks, hookAskText, hookBlockText, hookNoticeLines, hookPostToolAdditions, hookStopContinuation, hookStopMessage, hookToolPayload } from "../../../main/services/agent-surface-hooks.js";
import { toolCallIdempotencyKey } from "../../../main/services/hooks/hook-config.js";
import type { HookOutcome } from "../../../main/services/hooks/hook-types.js";
import { markWorkspaceChatCompacted, runPromptIntakeHooks, workspaceChatHookScopes } from "../../../main/services/workspace-chat-hooks.js";
import { isProtectedAgentConfigPath, PROTECTED_AGENT_CONFIG_WRITE_MESSAGE } from "../../../main/services/protected-agent-config-paths.js";
import { cliWorkspaceCodingTools } from "./workspace-coding-tools.ts";
import { createGenerationWatchdog } from "./generation-watchdog.ts";

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
  const readable = toolName === "run_command" ? only("command") && `Run command: ${only("command")}`
    : toolName === "read_file" ? only("path") && `Read file: ${only("path")}`
      : toolName === "list_dir" ? only("path") && `List folder: ${only("path")}`
        : undefined;
  return readable || `${toolName}: ${JSON.stringify(input)}`;
}

/**
 * At most this much of a hook's ask reason joins the phone's approval summary.
 * It goes after the tool: Remote clips a summary at 2,000 characters, and the
 * clip must never take the end of what the person is approving.
 */
const HOOK_ASK_SUMMARY_CHARS = 400;

/**
 * Whether a file mutation targets hook or agent settings
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
 * Hooks receive the same tool names as desktop chats. Legacy Pi names can
 * still appear in old journals, so normalize them when replaying results.
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
  // Picture files of deleted chats are cleaned up a couple of minutes later, and once after start.
  const chatStore = createChatStore(async () => root, undefined, { imageSweepDelayMs: 2 * 60 * 1000 });
  chatStore.scheduleImageSweep();
  const activityListeners = new Set<(snapshot: ChatActivitySnapshot) => void>();
  const activity = new ChatActivityRegistry((snapshot) => { for (const listener of activityListeners) listener(snapshot); });
  // The same run journal the desktop keeps: paired desktops observe and steer these runs (`runs:*`, `/host/events`).
  const runs = new HostRunRegistry({ now: Date.now });
  const recorders = createHostRunRecorders((_scope, message) => process.stderr.write(`aiden: ${message}\n`));
  const admission = new ChatTurnAdmission();
  const deletion = new ChatDeletionGate();
  // A journal deletion is a durable roll-forward checkpoint, including after a crash:
  // its chat stays closed from here until recoverChatDeletions finishes the job.
  const tombstones = new JsonStore<string[]>(join(agentDir, "daemon-chat-deletions.json"), []);
  const interrupted = new Map<string, () => void>();
  // Without this record any chat may be one whose deletion committed, so all of them stay closed.
  let deletionRecordFailure: Error | undefined;
  try {
    const ids = readJson<string[]>(tombstones.file, []);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error(`${tombstones.file} is not a list of chat ids.`);
    for (const id of new Set(ids)) interrupted.set(id, deletion.begin(id));
  } catch (error) {
    deletionRecordFailure = new Error(`Could not read unfinished chat deletions: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const turns = new DaemonTurnOwner<DaemonGenerationRun<AgentSession>>({ admission, isDeleting: (id) => deletionRecordFailure !== undefined || deletion.isDeleting(id) });
  const approvals = createDaemonApprovals({
    raised: (prompt) => activity.requestAttention(prompt.approvalId, prompt.streamId, "approval"),
    resolved: (id, decision) => { recorders.recordRunAttentionResolved(runs, id, { kind: "approval", decision }); activity.resolveAttention(id); },
  });
  const sessionPath = (id: string) => join(root, "journals", `${createHash("sha256").update(id).digest("hex")}.jsonl`);
  const llmClient = {
    beginChatTurn: (chatId: string, streamId: string, ownerId: string) => turns.begin(chatId, streamId, ownerId),
    isChatBusy: (id: string) => turns.isBusy(id),
    async waitForChatIdle(id: string) { await turns.waitForIdle(id); return true; },
    /** Stops the chat's turn; the first stop's origin is what its timeline records, as on the desktop. */
    async cancelChat(id: string, origin: GenerationCancellationOrigin = "chat_deletion") {
      admission.releaseChat(id); await turns.run(id)?.requestStop(origin);
    },
    /** A Bot the person paused: its reply ends as their Stop, and the chat is kept. */
    async stopChatWork(id: string) { await llmClient.cancelChat(id, "user_stop"); return llmClient.waitForChatIdle(id); },
    approve: approvals.approve,
    approveAsHost: approvals.approveAsHost,
    cancel(streamId: string, ownerId: string) {
      const found = turns.findRun((run) => run.streamId === streamId && run.ownerId === ownerId);
      if (!found) return false;
      void llmClient.cancelChat(found.chatId, "user_stop").catch(() => {}); return true;
    },
    /** Stop a run by its stream id whoever started it (`runs:control`). */
    cancelRun(streamId: string) {
      const found = turns.findRun((run) => run.streamId === streamId);
      if (!found) return false;
      void llmClient.cancelChat(found.chatId, "user_stop").catch(() => {}); return true;
    },
    async start(streamId: string, params: ChatStartParams, owner: ChatGenerationOwner, options: { usageSource: UsageRequestSource; turnId?: string; botAudienceId?: string; onTurnAccepted?(): void }) {
      if (!turns.accepting || owner.isDestroyed() || !admission.owns(params.chatId, options.turnId ?? streamId, owner.documentId)) return false;
      let releaseFile: () => void;
      try { releaseFile = acquireLease(sessionPath(params.chatId)); }
      catch (error) { admission.releaseMatching(params.chatId, options.turnId ?? streamId, owner.documentId); throw error; }
      const entry = new DaemonGenerationRun<AgentSession>({ streamId, ownerId: owner.documentId, workspaceId: params.workspaceId });
      // Each step runs whatever an earlier one threw: idle waiters and shutdown read `settled` as all of them.
      const cleanUp = () => {
        const failures: unknown[] = [];
        for (const step of [() => activity.settle(streamId), () => recorders.recordRunSettled(runs, streamId), releaseFile]) {
          try { step(); } catch (error) { failures.push(error); }
        }
        entry.markReleased();
        if (failures.length) throw failures[0];
      };
      const release = () => { if (turns.release(params.chatId, entry)) cleanUp(); };
      let handedOff: boolean;
      try {
        handedOff = turns.handoff(params.chatId, options.turnId ?? streamId, owner.documentId, entry, () => { activity.begin(streamId, params.chatId); recorders.recordRunBegin(runs, streamId, params.chatId, owner); });
      } catch (error) {
        // Registration failed partway, so nothing will ever run or release this entry.
        turns.release(params.chatId, entry);
        admission.releaseMatching(params.chatId, options.turnId ?? streamId, owner.documentId);
        try { cleanUp(); } catch { /* The registration failure is the one to report. */ }
        throw error;
      }
      if (!handedOff) { releaseFile(); return false; }
      void perform(streamId, params, owner, options, entry).finally(release).catch(() => {
        process.stderr.write("aiden: Could not deliver the terminal generation event.\n");
      });
      return true;
    },
  };
  async function perform(streamId: string, params: ChatStartParams, owner: ChatGenerationOwner, options: { usageSource: UsageRequestSource; turnId?: string; botAudienceId?: string; onTurnAccepted?(): void }, entry: DaemonGenerationRun<AgentSession>) {
      let unsubscribe = () => {};
      let botAdmission: BotRuntimeAuthorityAdmission | undefined;
      let removeBotAbort = () => {};
      const disposeOwner = owner.onInvalidated(() => entry.requestStopQuietly());
      const watchdog = createGenerationWatchdog(() => entry.requestStopQuietly());
      // Every event also feeds the run journal, so a paired desktop sees the run even after its owner leaves.
      const send: typeof owner.send = (channel, payload) => { recorders.recordRunNotification(runs, streamId, channel, payload); if (!owner.isDestroyed()) owner.send(channel, payload); };
      const produced: AssistantMessage[] = [];
      let content = "", separator = false;
      const timeline = new GenerationTimelineProjector(streamId, (value) => send("chat:timeline", { streamId, timeline: value }));
      // Extensions open their resources (MCP pool, memory store) before the session exists; a turn that
      // fails before then still runs their shutdown handlers and closers.
      const shutdownHandlers: ((event: { type: "session_shutdown"; reason: "quit" }) => unknown)[] = [];
      const closers: (() => Promise<void>)[] = [];
      try {
        const chat = await chatStore.get(params.chatId);
        if (!chat) throw new Error("The chat is unavailable.");
        if (chat.botId) {
          bots?.assertLegacyChatAllowed?.();
          if (!bots || !options.botAudienceId) throw new Error("This chat requires a Bot capability audience.");
          await bots.assertNotPaused(chat.botId);
          botAdmission = await bots.authority.admit({ audienceId: options.botAudienceId, botId: chat.botId, chatId: chat.id });
          assertBotRuntimeProviderSelection(botAdmission.authority.provider, { providerId: params.providerId, model: params.model });
          const cancel = () => entry.requestStopQuietly();
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
        // Hook messages reach the person as transcript status events, never the model.
        const reportHookLines = (messages: readonly string[]) => { if (messages.length) send("chat:status", { streamId, phase: "hook_messages", messages: [...messages] }); };
        const hookReport = { report: reportHookLines };
        const hooks = botAdmission ? botSurfaceHooks(chat.botId!, cwd, undefined, hookReport) : createSurfaceHooks({ scopes: workspaceChatHookScopes(hookTarget), cwd, sessionId: chat.id }, undefined, hookReport);
        let turnHookContext: string | undefined;
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
          const assertNotStopped = () => { if (entry.stopRequested || owner.isDestroyed()) throw new Error("Generation authority was revoked."); };
          assertNotStopped();
          // A stop can land during this await, and the next step may be the provider request.
          if (botAdmission) { await botAdmission.revalidateBeforeEffect(); assertNotStopped(); return; }
          const current = (await workspaceStore(agentDir).load()).find((item) => item.id === workspace.id);
          if (entry.stopRequested || owner.isDestroyed() || current?.folderPath !== workspace.folderPath || (unattended && accessFor(agentDir, cwd) !== "full")) throw new Error("The unattended workspace authority was revoked.");
        };
        const runtime = await createCliModelRuntime(agentDir);
        const model = runtime.getModel(params.providerId, params.model);
        if (!model) throw new Error("The saved provider/model is unavailable.");
        const botTools = botAdmission ? await bots!.tools(botAdmission) : [];
        const codingTools = !botAdmission && workspace.folderPath ? cliWorkspaceCodingTools(cwd) : [];
        const additionalNames: string[] = [];
        const registeredTools: { readonly name: string; readonly label?: string }[] = [];
        // Activity shows MCP tools by their server label, not the generated name.
        timeline.setToolLabels((toolName) => mcpToolActivityLabel([...botTools, ...registeredTools], toolName));
        // A corrupt settings file or wedged shared DB must degrade to
        // no-memory, never brick the generation (desktop parity: llm-client
        // warns and continues without memory).
        const memory = botAdmission || !workspace.folderPath ? undefined : await createMemoryInlineExtension({ agentDir, workspaceRoot: cwd, readOnly: unattended })
          .catch((error: unknown) => {
            process.stderr.write(`[daemon-chats] memory unavailable: ${error instanceof Error ? error.message : error}\n`);
            return { name: "aiden-memory", factory: () => undefined };
          });
        if (memory && "close" in memory && memory.close) closers.push(memory.close);
        const extensions: InlineExtension[] = !memory ? [] : [
          memory,
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
            if (key === "on") return (event: string, handler: (event: { type: "session_shutdown"; reason: "quit" }) => unknown) => {
              if (event === "session_shutdown") shutdownHandlers.push(handler);
              return (target.on as (event: string, handler: unknown) => void)(event, handler);
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
            for (const tool of [...botTools, ...codingTools]) pi.registerTool({ ...tool, label: tool.label ?? tool.name });
            pi.on("tool_call", async (event) => {
            try {
              await assertAuthority();
              if (botAdmission && !botTools.some((tool) => tool.name === event.toolName)) return { block: true, reason: "This tool is outside the Bot capability grant." };
              const tier = botAdmission ? "full" : workspace.folderPath ? accessFor(agentDir, cwd) : "none";
              if (tier === "none") return { block: true, reason: "Workspace tools are disabled." };
              if (!botAdmission && (event.toolName === "write_file" || event.toolName === "edit_file") && daemonWriteTargetsProtectedConfig(cwd, event.input)) return { block: true, reason: PROTECTED_AGENT_CONFIG_WRITE_MESSAGE };
              // PreToolUse runs after Aiden's own rules allowed the call, so a
              // hook can only tighten them; its updatedInput is not applied.
              const hooked = await dispatchHook("PreToolUse", { ...hookToolPayload(daemonHookToolName(event.toolName), event.input), tool_use_id: event.toolCallId },
                { idempotencyKey: toolCallIdempotencyKey(`PreToolUse:${chat.id}`, event.toolCallId, event.input), signal: entry.abort.signal });
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
              const outcome = await approvals.request({ streamId, toolCallId: event.toolCallId, toolName: event.toolName, summary: hookAsks ? `${daemonApprovalSummary(event.toolName, event.input)}\n\n${hookAskText(hooked).slice(0, HOOK_ASK_SUMMARY_CHARS)}` : daemonApprovalSummary(event.toolName, event.input) }, entry.abort.signal, owner.documentId,
                ({ approvalId, toolCallId, toolName, summary }) => send("chat:approval", { streamId, approvalId, toolCallId, toolName, summary }));
              await assertAuthority();
              if (outcome !== "allowed" || JSON.stringify(event.input) !== original || accessFor(agentDir, cwd) === "none") return { block: true, reason: "The tool request was denied, changed or expired." };
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
                { idempotencyKey: `PreCompact:${chat.id}:${streamId}:${event.reason}`, report: reportHookLines });
            });
            pi.on("session_compact", () => { if (!botAdmission) markWorkspaceChatCompacted(chat.id); });
          } }],
        });
        await loader.reload(); await assertAuthority();
        const manager = SessionManager.open(sessionPath(params.chatId), join(root, "journals"), cwd);
        const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
          thinkingLevel: params.thinkingLevel, resourceLoader: loader, sessionManager: manager,
          tools: botAdmission ? botTools.map((tool) => tool.name) : workspace.folderPath ? [...codingTools.map((tool) => tool.name), ...additionalNames] : [],
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
          watchdog.activity(event);
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
        const attachments = parseAttachments(withReadableImages(input.attachments)) ?? [];
        const text = [input.content, ...attachments.filter((item) => item.kind === "image" && !model.input.includes("image")).map((item) => `Attached image: ${visionAttachmentAlias(item)} (${item.name}). Use inspect_image to analyze it.`), ...attachments.filter((item) => item.kind === "text").map((item) => `Attachment: ${item.name}\n${item.text ?? ""}`)].join("\n\n");
        if (!botAdmission) {
          // SessionStart then UserPromptSubmit, as on the desktop. A SessionStart `continue: false` or a refused
          // prompt throws before the model runs; a refused prompt never reaches the journal, and its stored copy
          // is marked (by id) so forks and summaries never send it later. A retried prompt that goes through now
          // loses the mark.
          const stored = "id" in input && typeof input.id === "string"
            ? chat.messages.find((message) => message.id === input.id && message.role === "user")
            : chat.messages.findLast((message) => message.role === "user" && message.content === input.content);
          turnHookContext = await runPromptIntakeHooks({
            target: hookTarget, dispatch: dispatchHook,
            hasPriorMessages: chat.messages.some((message) => message.role === "assistant"),
            prompt: stored ?? { content: input.content }, store: chatStore,
            idempotencyKeys: { sessionStart: `SessionStart:${chat.id}:${streamId}`, userPromptSubmit: `UserPromptSubmit:${chat.id}:${streamId}` },
            signal: entry.abort.signal,
            onStoreError: (message) => { process.stderr.write(`aiden: ${message}\n`); },
          });
        }
        await assertAuthority();
        await session.prompt(text, { expandPromptTemplates: false, preflightResult: (accepted) => { if (accepted) options.onTurnAccepted?.(); }, images: (model.input.includes("image") ? attachments : []).flatMap((item) => item.kind === "image" && item.data ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }] : []) });
        if (entry.stopRequested) throw new Error("Generation cancelled.");
        // Stop hooks may keep a workspace chat's turn going, at most MAX_STOP_HOOK_CONTINUATIONS times.
        for (let continuation = 0; !botAdmission && hookStop === undefined && continuation < MAX_STOP_HOOK_CONTINUATIONS; continuation += 1) {
          const ended = produced.at(-1);
          if (entry.stopRequested || !ended || ended.stopReason === "error" || ended.stopReason === "aborted" || ended.stopReason === "length") break;
          const stop = await dispatchHook("Stop", { stop_hook_active: continuation > 0 }, { idempotencyKey: `Stop:${chat.id}:${streamId}:${continuation}`, signal: entry.abort.signal });
          const next = hookStopContinuation(stop);
          if (!next) break;
          await assertAuthority();
          await session.prompt(next, { expandPromptTemplates: false });
        }
        if (entry.stopRequested) throw new Error("Generation cancelled.");
        const last = produced.at(-1);
        if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "Generation returned no final answer.");
        content ||= produced.map((message) => messageText(message.content)).filter(Boolean).join("\n");
        const finalTimeline = timeline.finish("completed");
        const updated = await chatStore.appendMessage(params.chatId, { role: "assistant", content, timeline: finalTimeline }, { providerId: model.provider, model: model.id });
        entry.persistence = "final_saved";
        send("chat:done", { streamId, content, chat: updated, timeline: finalTimeline }); return true;
      } catch (error) {
        const cancelled = entry.stopRequested;
        const finished = cancelled ? timeline.finish("cancelled", entry.cancellationOrigin) : timeline.finish("failed");
        // A failed final save already closed the projector as completed, but this turn did not complete.
        const finalTimeline = finished.status !== "completed" ? finished
          : { ...finished, status: cancelled ? "cancelled" as const : "failed" as const, ...(cancelled && entry.cancellationOrigin ? { cancellationOrigin: entry.cancellationOrigin } : {}) };
        if (entry.persistence === "none" && (content || produced.length)) {
          entry.persistence = await chatStore.appendMessage(params.chatId, { role: "assistant", content, timeline: finalTimeline }).then(() => "partial_saved" as const, () => {
            process.stderr.write("aiden: Could not persist the partial response.\n");
            return "partial_lost" as const;
          });
        }
        send("chat:error", { streamId, message: error instanceof Error ? error.message : String(error), cancelled, timeline: finalTimeline }); return true;
      } finally {
        watchdog.dispose(); unsubscribe(); disposeOwner(); removeBotAbort(); botAdmission?.release();
        if (entry.session) {
          try { await entry.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
          finally { entry.session.dispose(); }
        } else {
          for (const handler of shutdownHandlers) await Promise.resolve().then(() => handler({ type: "session_shutdown", reason: "quit" })).catch(() => {});
        }
        await Promise.allSettled(closers.map((close) => close()));
        for (const message of produced) await recordUsage(agentDir, options.usageSource, message).catch(() => {});
      }
  }
  return { chatStore, llmClient, activity, runs, admission, deletion, sessionPath,
    /** Unlike a deletion that fails to finish, a lost record cannot be scoped to its chats. */
    assertChatDeletionsReadable() { if (deletionRecordFailure) throw deletionRecordFailure; },
    /** Finishes deletions a crash interrupted. Repeatable: a failure leaves its tombstone and its chat closed. */
    async recoverChatDeletions() {
      if (deletionRecordFailure) throw deletionRecordFailure;
      for (const [id, reopen] of [...interrupted]) {
        await deleteCliBotSubagentHistory(agentDir, id);
        await rm(sessionPath(id), { force: true });
        if (await chatStore.get(id)) await chatStore.remove(id);
        await tombstones.update((values) => { for (let index = values.indexOf(id); index >= 0; index = values.indexOf(id)) values.splice(index, 1); });
        interrupted.delete(id); reopen();
      }
    },
    /** Every activity change (a run began or ended, an approval was raised or settled). */
    onActivityChange(listener: (snapshot: ChatActivitySnapshot) => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
    setBots(runtime: CliBotGenerationRuntime) { bots = runtime; },
    /** Closes intake before its first await, so no ingress stopping alongside it can begin a turn. */
    async stop() { const ids = turns.closeIntake(); admission.releaseAll(); await Promise.allSettled(ids.map((id) => llmClient.cancelChat(id, "application_shutdown"))); await Promise.all(ids.map((id) => llmClient.waitForChatIdle(id))); },
  };
}
