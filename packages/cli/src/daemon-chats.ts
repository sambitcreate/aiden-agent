import { createMemoryInlineExtension } from "./extensions/memory.ts";
import { createPromptCacheBreakpointsInlineExtension } from "./extensions/prompt-cache-breakpoints.ts";
import { createWebSearchInlineExtension } from "./extensions/web-search.ts";
import { createTodoInlineExtension } from "./extensions/todo.ts";
import { createAdvisorInlineExtension } from "./extensions/advisor.ts";
import { createArtifactsExtension } from "./extensions/artifacts.ts";
import { createServerVisualCollector } from "./server-visuals.ts";
import { createMcpExtension } from "./mcp.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { visionAttachmentAlias } from "../../../main/services/vision-attachment-reference.js";
import { formatGrabbedElementsForPrompt, withoutGrabbedElementThumbnails } from "../../../renderer/shared/browser-element-grab.js";
import { withoutMessageThreads } from "../../../main/services/pi-message-threads.js";
import { daemonSettingsManager, profileKeepsLongPromptCache, profileWarmsCaches } from "./daemon-session-settings.ts";
import { PiCacheWarmer, settleReplyCacheWarmer } from "../../../main/services/pi-cache-warming.js";
import { withPromptCacheBreakpointsPayload } from "../../../main/services/prompt-cache-breakpoints.js";
import type { ResolvedModelRuntime } from "../../../main/services/model-runtime-core.js";
import { createSideCallPrefixLedger } from "../../../main/services/side-call-prefix.js";
import { compactWithoutMemoryFacts } from "./daemon-compaction-memory.ts";
import type { CliBotGenerationRuntime } from "./bots.ts";
import type { BotRuntimeAuthorityAdmission } from "../../../main/services/bot-runtime-authority.js";
import { assertBotRuntimeProviderSelection } from "../../../main/services/bot-runtime-authority.js";
import { mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { convertToLlm, createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createPromptCacheTelemetry, formatPromptCacheMissLog, promptCacheWarmsSinceLastResponse, type PromptCacheRequestObservation } from "../../../main/services/pi-cache-telemetry.js";
import { chatTurnPromptCache, promptCacheTtlMs } from "../../../main/services/prompt-cache-lifetimes.js";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentTurnDecision, StreamFn } from "@earendil-works/pi-agent-core";
import { createChatStore } from "../../../main/services/chat-store-core.js";
import { ChatActivityRegistry } from "../../../main/services/chat-activity-core.js";
import { commandReadingForCall } from "../../../renderer/shared/command-reading.js";
import { homedir } from "node:os";
import type { ChatActivitySnapshot } from "../../../renderer/shared/chat-activity.js";
import { HostRunRegistry } from "../../../main/services/host-run-registry.js";
import { createHostRunRecorders } from "../../../main/services/host-runs.js";
import type { ChatStartParams } from "../../../main/services/types.js";
import { remoteDeviceDocumentPrefix, type ChatGenerationOwner } from "../../../main/services/chat-generation-owner.js";
import type { UsageRequestSource } from "../../../main/services/usage-store-core.js";
import { ChatTurnAdmission } from "../../../main/services/chat-turn-admission.js";
import { ChatDeletionGate } from "../../../main/services/chat-deletion-gate.js";
import { parseAttachments, withReadableImages } from "../../../main/services/attachment-contract.js";
import { createCliModelRuntime } from "./providers.ts";
import { acquireLease, JsonStore, readJson } from "./state.ts";
import { deleteCliBotSubagentHistory } from "./bot-subagents.ts";
import { DaemonGenerationRun, DaemonTurnOwner } from "./daemon-turn-lifecycle.ts";
import { createDaemonApprovals } from "./daemon-approvals.ts";
import { workspaceStore, accessFor, accessForWorkspace, assertCliWorkspaceFolderPresent, type CliWorkspace } from "./workspaces.ts";
import {
  assertCanonicalDirectoryIdentity,
  bindCliSessionAuthority,
  captureCanonicalDirectoryIdentity,
  createCliChatSessionInstructions,
} from "./cli-agents-instructions.ts";
import { recordUsage } from "./usage-ledger.ts";
import { messageText } from "./sessions.ts";
import { GenerationTimelineProjector } from "../../../main/services/generation-timeline.js";
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import { mcpToolActivityLabel } from "../../../main/services/mcp-tool-identity.js";
import { MAX_STOP_HOOK_CONTINUATIONS, botSurfaceHooks, createSurfaceHooks, hookAskText, hookBlockText, hookNoticeLines, hookPostToolAdditions, hookStopContinuation, hookStopMessage, hookToolPayload } from "../../../main/services/agent-surface-hooks.js";
import { toolCallIdempotencyKey } from "../../../main/services/hooks/hook-config.js";
import type { HookOutcome } from "../../../main/services/hooks/hook-types.js";
import { hookContextCustomMessage, markWorkspaceChatCompacted, runPromptIntakeHooks, workspaceChatHookScopes } from "../../../main/services/workspace-chat-hooks.js";
import { isProtectedAgentConfigPath, PROTECTED_AGENT_CONFIG_WRITE_MESSAGE } from "../../../main/services/protected-agent-config-paths.js";
import { cliWorkspaceCodingTools } from "./workspace-coding-tools.ts";
import { createGenerationWatchdog } from "./generation-watchdog.ts";

/**
 * The approval summary a paired phone shows. A call with only a command or path reads
 * like the desktop host's ("Run command: npm test"); anything else stays the exact
 * request, so nothing the call would do is hidden. A command's `description` is the
 * model's plain words, shown beside the command (never instead of it), so it may
 * come with the command.
 */
export function daemonApprovalSummary(toolName: string, input: unknown): string {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  const only = (key: string, alongside: readonly string[] = []) => {
    const keys = args ? Object.keys(args) : [];
    const value = args && keys.every((name) => name === key || (alongside.includes(name) && typeof args[name] === "string")) ? args[key] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const command = only("command", ["description"]);
  const readable = toolName === "run_command" ? command && `Run command: ${command}`
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
  // Prompt-cache miss attribution, shared with the desktop: section hashes per chat, never content.
  const promptCache = createPromptCacheTelemetry();
  // The memory fact lines each workspace chat's always-on prompt has told it, kept in
  // memory only: the prompt is not in the session, and a compaction summary may state none.
  const memoryFactsTold = new Map<string, Set<string>>();
  // Each chat's idle cache warmer, one per chat as on the desktop. A chat is
  // attended on the server while the paired device whose turn produced its
  // last reply is still paired: a new turn on the chat, a write to it, its
  // deletion, that device's revocation or the daemon stopping ends warming.
  const idleWarmers = new Map<string, PiCacheWarmer>();
  const idleWarmersStopped = new AbortController();
  // Each workspace chat's last completed session request, so its compaction
  // can continue the cached prefix (daemon-compaction-memory.ts).
  const sessionPrefixes = createSideCallPrefixLedger();
  const adoptIdleWarmer = (chatId: string, warmer: PiCacheWarmer | undefined) => {
    const previous = idleWarmers.get(chatId);
    if (previous && previous !== warmer) previous.dispose();
    idleWarmers.delete(chatId);
    if (!warmer || warmer.isDisposed) return;
    idleWarmers.set(chatId, warmer);
    warmer.onDispose(() => { if (idleWarmers.get(chatId) === warmer) idleWarmers.delete(chatId); });
  };
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
      // Visuals this turn drew go on its reply in the same write, under an id chosen up front.
      let visuals = createServerVisualCollector();
      const replyId = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
      const visualFields = () => visuals.messageFields(params.chatId, replyId, (raw) => timeline.publicToolCallId(raw));
      // Extensions open their resources (MCP pool, memory store) before the session exists; a turn that
      // fails before then still runs their shutdown handlers and closers.
      const shutdownHandlers: ((event: { type: "session_shutdown"; reason: "quit" }) => unknown)[] = [];
      const closers: (() => Promise<void>)[] = [];
      let idleWarmer: PiCacheWarmer | undefined;
      let idleWarmerSettled = false;
      try {
        const chat = await chatStore.get(params.chatId);
        if (!chat) throw new Error("The chat is unavailable.");
        visuals = createServerVisualCollector({ existingUiVisuals: chat.messages.reduce((total, message) => total + (message.uiVisuals?.length ?? 0), 0) });
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
        // A Bot's home is Aiden's own folder; any other chat's folder may have been moved or deleted.
        if (!botAdmission) await assertCliWorkspaceFolderPresent(workspace as CliWorkspace, "turn");
        const unattended = !botAdmission && (options.usageSource === "telegram" || options.usageSource === "scheduled");
        const declaredAccess = botAdmission ? "full" : (workspace as CliWorkspace).access;
        const pinnedWorkspaceRoot = !botAdmission && declaredAccess !== "none" && workspace.folderPath
          ? await captureCanonicalDirectoryIdentity(workspace.folderPath, { requireCanonicalPath: true })
          : undefined;
        const initialAccess = botAdmission ? "full" : accessForWorkspace(agentDir, workspace.id);
        if (unattended && (!workspace.folderPath || initialAccess !== "full" || accessFor(agentDir, workspace.folderPath) !== "full")) throw new Error("Unattended generation requires explicitly granted full workspace access.");
        const hasWorkspaceAccess = Boolean(botAdmission || (workspace.folderPath && initialAccess !== "none"));
        const cwd = hasWorkspaceAccess && workspace.folderPath ? workspace.folderPath : root;
        // Hooks (docs/plans/aiden-hooks-plan.md §7): a workspace chat runs the
        // person's global, workspace and chat hooks; a legacy Bot chat runs
        // global and Bot hooks, for its tools only.
        const hookTarget = { chatId: chat.id, ...(hasWorkspaceAccess && workspace.folderPath ? { workspaceRoot: workspace.folderPath } : {}) };
        // Hook messages reach the person as transcript status events, never the model.
        const reportHookLines = (messages: readonly string[]) => { if (messages.length) send("chat:status", { streamId, phase: "hook_messages", messages: [...messages] }); };
        const hookReport = { report: reportHookLines };
        const hooks = botAdmission ? botSurfaceHooks(chat.botId!, cwd, undefined, hookReport) : createSurfaceHooks({ scopes: workspaceChatHookScopes(hookTarget), cwd, sessionId: chat.id }, undefined, hookReport);
        let turnHookContext: string | undefined;
        let promptCacheRequest: PromptCacheRequestObservation | undefined;
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
        const assertAuthority = async (signal?: AbortSignal) => {
          const assertNotStopped = () => {
            signal?.throwIfAborted();
            if (entry.stopRequested || owner.isDestroyed()) throw new Error("Generation authority was revoked.");
          };
          assertNotStopped();
          // A stop can land during this await, and the next step may be the provider request.
          if (botAdmission) { await botAdmission.revalidateBeforeEffect(); assertNotStopped(); return; }
          const current = (await workspaceStore(agentDir).load()).find((item) => item.id === workspace.id);
          assertNotStopped();
          if (!current || current.folderPath !== workspace.folderPath) throw new Error("The unattended workspace authority was revoked.");
          if (!hasWorkspaceAccess) {
            if (current.access !== declaredAccess) throw new Error("Workspace instruction access changed. Start a new response.");
            return;
          }
          if (pinnedWorkspaceRoot) await assertCanonicalDirectoryIdentity(pinnedWorkspaceRoot);
          const currentTier = accessForWorkspace(agentDir, workspace.id);
          if (unattended && (currentTier !== "full" || accessFor(agentDir, cwd) !== "full")) throw new Error("The unattended workspace authority was revoked.");
          if (currentTier === "none" || accessFor(agentDir, cwd) === "none") throw new Error("Workspace instruction access changed. Start a new response.");
          assertNotStopped();
        };
        const runtime = await createCliModelRuntime(agentDir);
        const found = runtime.getModel(params.providerId, params.model);
        if (!found) throw new Error("The saved provider/model is unavailable.");
        const model = withoutMessageThreads(found);
        const attended = !botAdmission && !unattended;
        const stableHead = () => memory && "stableHead" in memory ? memory.stableHead?.() : undefined;
        // After an attended reply settles, a profile that warms caches keeps this chat's
        // prefix warm with the desktop's idle limits, unless it asked for the hour.
        let headAtRequest: string | undefined;
        const inner = runtime.streamSimple.bind(runtime);
        const observed: StreamFn = (requestModel, context, requestOptions) => {
          const warmer = idleWarmer;
          let finished: ((message: AssistantMessage) => void) | undefined;
          let recorded: ((message: AssistantMessage) => void) | undefined;
          // A replay applies the breakpoints itself, and is never tied to this turn's abort signal.
          const { onPayload: _payload, transformHeaders: _headers, signal, ...replayable } = (requestOptions ?? {}) as Parameters<typeof inner>[2] & object;
          if (!botAdmission) {
            try { recorded = signal?.aborted ? undefined : sessionPrefixes.begin(chat.id, requestModel, context, replayable); }
            catch { sessionPrefixes.forget(chat.id); }
          }
          if (warmer && !warmer.isDisposed) {
            try {
              headAtRequest = stableHead();
              finished = warmer.requestStarted(requestModel, context, replayable);
            } catch { warmer.stop(); }
          }
          const stream = inner(requestModel, context, requestOptions as Parameters<typeof inner>[2]);
          if (recorded) void stream.result().then(recorded, () => sessionPrefixes.forget(chat.id));
          if (warmer && finished) void stream.result().then(finished, () => warmer.stop());
          return stream;
        };
        // Deliberately no `ownerKind`: on the desktop a paired device's turn keeps the
        // default lifetime, but every attended serve turn is a paired device's, so the
        // server's own aiden.json switch is what asks for the hour here.
        const turnCache = chatTurnPromptCache({ longPromptCacheRetention: attended && profileKeepsLongPromptCache(agentDir), agentHarness: false, bot: !!botAdmission, usageSource: options.usageSource }, observed, model);
        if (attended && owner.kind === "remote" && turnCache.retention !== "long" && profileWarmsCaches(agentDir)) {
          const warmer: PiCacheWarmer = new PiCacheWarmer({
            signal: idleWarmersStopped.signal, documentId: owner.documentId, idleOnly: true,
            enabled: async () => profileWarmsCaches(agentDir),
            isCurrent: () => idleWarmers.get(chat.id) === warmer,
            async resolveRuntime() {
              const fresh = await createCliModelRuntime(agentDir);
              const current = fresh.getModel(params.providerId, params.model);
              if (!current) throw new Error("The saved provider/model is unavailable.");
              const head = headAtRequest;
              const streams: ResolvedModelRuntime["streams"] = {
                streamSimple: (replayModel, context, replayOptions) => fresh.streamSimple(replayModel, context, { ...replayOptions,
                  onPayload: (payload, payloadModel) => withPromptCacheBreakpointsPayload(payload, payloadModel.api, head, payloadModel) }),
              };
              // The warmer reads only the model, credentials and stream; the server's runtime resolves its own credentials.
              return { model: withoutMessageThreads(current), apiKey: undefined, headers: undefined, streams } as unknown as ResolvedModelRuntime;
            },
            async recordUsage(message) { promptCache.observeWarm(chat.id, message); await recordUsage(agentDir, "cache-warm", message); },
            // Forgetting a fact or turning memory off writes nothing to the chat,
            // so each refresh confirms the facts its request states.
            approvedMemoryFacts: async () => memory && "approvedFactLines" in memory && memory.approvedFactLines ? memory.approvedFactLines() : [],
          });
          idleWarmer = warmer;
        }
        // A new turn on the chat ends the warmer its last reply left, even one that does not warm.
        adoptIdleWarmer(chat.id, idleWarmer);
        const botTools = botAdmission ? await bots!.tools(botAdmission) : [];
        const codingTools = !botAdmission && hasWorkspaceAccess ? cliWorkspaceCodingTools(cwd) : [];
        const additionalNames: string[] = [];
        const registeredTools: { readonly name: string; readonly label?: string }[] = [];
        // Activity shows MCP tools by their server label, not the generated name.
        timeline.setToolLabels((toolName) => mcpToolActivityLabel([...botTools, ...registeredTools], toolName));
        // A corrupt settings file or wedged shared DB must degrade to
        // no-memory, never brick the generation (desktop parity: llm-client
        // warns and continues without memory).
        const toldFacts = memoryFactsTold.get(chat.id) ?? new Set<string>();
        if (!botAdmission && hasWorkspaceAccess) memoryFactsTold.set(chat.id, toldFacts);
        const memory = botAdmission || !hasWorkspaceAccess ? undefined : await createMemoryInlineExtension({ agentDir, workspaceRoot: cwd, readOnly: unattended, toldFacts })
          .catch((error: unknown) => {
            process.stderr.write(`[daemon-chats] memory unavailable: ${error instanceof Error ? error.message : error}\n`);
            return { name: "aiden-memory", factory: () => undefined };
          });
        if (memory && "close" in memory && memory.close) closers.push(memory.close);
        const extensions: InlineExtension[] = !memory ? [] : [
          memory,
          createTodoInlineExtension(),
          createMcpExtension(agentDir),
          createAdvisorInlineExtension({ agentDir }),
          createArtifactsExtension(agentDir, { visuals }),
        ];
        if (!botAdmission && hasWorkspaceAccess) {
          const web = await createWebSearchInlineExtension({ agentDir });
          if (web) extensions.push(web);
        }
        const agentsInstructions = botAdmission ? undefined : await createCliChatSessionInstructions({
          globalRoot: agentDir,
          workspaceRoot: hasWorkspaceAccess ? cwd : undefined,
          userDataDir: agentDir,
          chatId: chat.id,
          revalidate: assertAuthority,
          onNotices: (notices) => send("chat:status", { streamId, phase: "agents_instructions_limited", notices }),
        }, entry.abort.signal);
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
        const sessionSettings = daemonSettingsManager(cwd, agentDir, { attended, longRetention: turnCache.retention === "long" });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: sessionSettings, noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          extensionFactories: [...(agentsInstructions ? [agentsInstructions.extension] : []), ...additionalExtensions, createPromptCacheBreakpointsInlineExtension(stableHead), { name: "aiden-daemon-authority", factory(pi) {
            pi.on("before_agent_start", async (event) => {
              // SessionStart and UserPromptSubmit context, once per turn, as host data the chat store never
              // saves. Pi journals it after the prompt, in the same shape the desktop journals.
              const context = turnHookContext; turnHookContext = undefined;
              if (!botAdmission) return context ? { message: hookContextCustomMessage(context) } : undefined;
              await assertAuthority();
              const instructions = await bots!.instructions(botAdmission);
              return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
            });
            for (const tool of [...botTools, ...codingTools]) pi.registerTool({ ...tool, label: tool.label ?? tool.name });
            pi.on("tool_call", async (event) => {
            try {
              await assertAuthority();
              if (botAdmission && !botTools.some((tool) => tool.name === event.toolName)) return { block: true, reason: "This tool is outside the Bot capability grant." };
              const tier = botAdmission ? "full" : hasWorkspaceAccess ? accessForWorkspace(agentDir, workspace.id) : "none";
              if (tier === "none" || (!botAdmission && accessFor(agentDir, cwd) === "none")) return { block: true, reason: "Workspace tools are disabled." };
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
              const reading = commandReadingForCall(event.toolName, event.input, { workspaceRoot: cwd, home: homedir() });
              const outcome = await approvals.request({ streamId, toolCallId: event.toolCallId, toolName: event.toolName, summary: hookAsks ? `${daemonApprovalSummary(event.toolName, event.input)}\n\n${hookAskText(hooked).slice(0, HOOK_ASK_SUMMARY_CHARS)}` : daemonApprovalSummary(event.toolName, event.input), ...(reading ? { reading } : {}) }, entry.abort.signal, owner.documentId,
                ({ approvalId, toolCallId, toolName, summary, reading: shown }) => send("chat:approval", { streamId, approvalId, toolCallId, toolName, summary, ...(shown ? { reading: shown } : {}) }));
              await assertAuthority();
              if (outcome !== "allowed" || JSON.stringify(event.input) !== original || accessForWorkspace(agentDir, workspace.id) === "none" || accessFor(agentDir, cwd) === "none") return { block: true, reason: "The tool request was denied, changed or expired." };
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
            pi.on("session_before_compact", async (event, ctx) => {
              // Observe-only; a throw here must not skip the memory filter, or Pi would store its own summary.
              try {
                hooks.observe("PreCompact", { trigger: event.reason === "manual" ? "manual" : "auto", aiden_reason: event.reason },
                  { idempotencyKey: `PreCompact:${chat.id}:${streamId}:${event.reason}`, report: reportHookLines });
              } catch { /* the hook is the person's; compaction goes on */ }
              // A workspace chat's summary keeps no memory fact; a Bot's memory is its own.
              if (botAdmission) return undefined;
              if (!entry.session) return { cancel: true };
              return compactWithoutMemoryFacts(event, { session: entry.session, settings: sessionSettings, model: ctx.model, toldFacts,
                approvedFactLines: memory && "approvedFactLines" in memory ? memory.approvedFactLines : undefined,
                cachedPrefix: () => sessionPrefixes.latest(chat.id) });
            });
            pi.on("session_compact", () => { promptCache.reset(chat.id); sessionPrefixes.forget(chat.id); if (!botAdmission) markWorkspaceChatCompacted(chat.id); });
            // The last context handler sees each request's final transcript; it only observes, so the messages stay as they are.
            pi.on("context_with_system", (event, ctx) => {
              try {
                // Pi's cache warmer records its reads as session entries; they restart the lifetime, as in Pi's own miss scan.
                for (const warm of promptCacheWarmsSinceLastResponse(ctx.sessionManager.getEntries())) promptCache.observeWarm(chat.id, warm);
                promptCacheRequest = ctx.model
                  ? promptCache.beginRequest(chat.id, { messages: convertToLlm(event.messages), model: ctx.model, cacheTtlMs: promptCacheTtlMs(ctx.model, turnCache.retention) })
                  : undefined;
              } catch { promptCacheRequest = undefined; }
              return undefined;
            });
          } }],
        });
        await loader.reload(); await assertAuthority();
        const manager = SessionManager.open(sessionPath(params.chatId), join(root, "journals"), cwd);
        // Only this session's own requests ask for the turn's retention and reach the idle warmer:
        // compaction and summaries name their own, and Pi's refreshes replay what they warmed.
        runtime.streamSimple = (requestModel, context, requestOptions) => requestOptions?.sessionId === manager.getSessionId() && !requestOptions.disableContinuation
          ? turnCache.streamFn(requestModel, context as TranscriptContext, requestOptions) as ReturnType<typeof inner>
          : inner(requestModel, context, requestOptions);
        const { session } = await createAgentSession({ cwd, agentDir, settingsManager: sessionSettings, modelRuntime: runtime, model,
          thinkingLevel: params.thinkingLevel, resourceLoader: loader, sessionManager: manager,
          tools: botAdmission ? botTools.map((tool) => tool.name) : hasWorkspaceAccess ? [...codingTools.map((tool) => tool.name), ...additionalNames] : [],
        });
        entry.session = session;
        // A hook's `continue: false` ends the run once the current tool batch finishes.
        const sessionFinishTurn = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
          const decision = await sessionFinishTurn?.(turn, signal);
          return hookStop !== undefined ? { action: "end" } : decision ?? undefined;
        };
        await session.bindExtensions({ mode: "rpc" });
        if (agentsInstructions) agentsInstructions.bindSession(session);
        else bindCliSessionAuthority(session, assertAuthority);
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
          if (event.type === "message_end" && event.message.role === "assistant") {
            produced.push(event.message); separator = true;
            const miss = promptCacheRequest?.complete(event.message); promptCacheRequest = undefined;
            if (miss && process.env.AIDEN_PROMPT_CACHE_DEBUG === "1") process.stderr.write(`aiden: ${formatPromptCacheMissLog(miss)}\n`);
          }
          if (event.type === "tool_execution_start") {
            timeline.toolStarted(event.toolCallId, event.toolName, event.args);
            send("chat:tool", { streamId, toolName: event.toolName, phase: "call" });
          }
          if (event.type === "tool_execution_end") {
            // After a stop, Pi ends every unstarted call in the batch with an error result; like the
            // desktop, show those (and the interrupted call) as stopped rather than failed.
            const status = entry.stopRequested ? "cancelled" : event.isError ? "failed" : "completed";
            timeline.toolFinished(event.toolCallId, status, undefined, { stoppedByUser: status === "cancelled" && entry.cancellationOrigin === "user_stop" });
            send("chat:tool", { streamId, toolName: event.toolName, phase: event.isError ? "error" : "result" });
          }
        });
        const input = params.messages.at(-1) ?? chat.messages.at(-1);
        if (!input) throw new Error("A user message is required.");
        const stored = "id" in input && typeof input.id === "string"
          ? chat.messages.find((message) => message.id === input.id && message.role === "user")
          : chat.messages.findLast((message) => message.role === "user" && message.content === input.content);
        const attachments = parseAttachments(withReadableImages(input.attachments)) ?? [];
        const supportsImages = model.input.includes("image");
        const grabbedElements = input.role === "user"
          ? (input.grabbedElements ?? stored?.grabbedElements)
          : undefined;
        const readableImagesById = new Map(
          attachments
            .filter((item) => item.kind === "image" && Boolean(item.data))
            .map((item) => [item.id, item] as const),
        );
        const grabbedForPrompt = grabbedElements?.map((element) => {
          if (supportsImages && element.thumbnailAttachmentId && readableImagesById.has(element.thumbnailAttachmentId)) {
            return element;
          }
          if (element.thumbnailAttachmentId === undefined) return element;
          const { thumbnailAttachmentId: _omitted, ...withoutThumb } = element;
          return withoutThumb;
        });
        const grabbedText = formatGrabbedElementsForPrompt(grabbedForPrompt, { includeThumbnailNote: supportsImages });
        const nonGrabAttachments = withoutGrabbedElementThumbnails(attachments);
        const text = [
          grabbedText,
          input.content,
          ...nonGrabAttachments.filter((item) => item.kind === "image" && !supportsImages).map((item) => `Attached image: ${visionAttachmentAlias(item)} (${item.name}). Use inspect_image to analyze it.`),
          ...attachments.filter((item) => item.kind === "text").map((item) => `Attachment: ${item.name}\n${item.text ?? ""}`),
        ].filter(Boolean).join("\n\n");
        if (!botAdmission) {
          // SessionStart then UserPromptSubmit, as on the desktop. A SessionStart `continue: false` or a refused
          // prompt throws before the model runs; a refused prompt never reaches the journal, and its stored copy
          // is marked (by id) so forks and summaries never send it later. A retried prompt that goes through now
          // loses the mark.
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
        const promptImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
        if (supportsImages) {
          for (const item of nonGrabAttachments) {
            if (item.kind === "image" && item.data) promptImages.push({ type: "image", data: item.data, mimeType: item.mimeType });
          }
          const emittedThumbnails = new Set<string>();
          for (const element of grabbedElements ?? []) {
            const thumbId = element.thumbnailAttachmentId;
            if (!thumbId || emittedThumbnails.has(thumbId)) continue;
            const thumb = readableImagesById.get(thumbId);
            if (thumb?.data) {
              emittedThumbnails.add(thumbId);
              promptImages.push({ type: "image", data: thumb.data, mimeType: thumb.mimeType });
            }
          }
        }
        await session.prompt(text, { expandPromptTemplates: false, preflightResult: (accepted) => { if (accepted) options.onTurnAccepted?.(); }, images: promptImages });
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
        const updated = await chatStore.appendMessage(params.chatId, { id: replyId, role: "assistant", content, timeline: finalTimeline, ...visualFields() }, { providerId: model.provider, model: model.id });
        entry.persistence = "final_saved";
        send("chat:done", { streamId, content, chat: updated, timeline: finalTimeline });
        idleWarmerSettled = true;
        await settleReplyCacheWarmer(idleWarmer, { owner: { isDestroyed: () => !idleWarmer || idleWarmers.get(chat.id) !== idleWarmer }, delivered: true, chat: () => chatStore.getMeta(chat.id) });
        return true;
      } catch (error) {
        const cancelled = entry.stopRequested;
        const finished = cancelled ? timeline.finish("cancelled", entry.cancellationOrigin) : timeline.finish("failed");
        // A failed final save already closed the projector as completed, but this turn did not complete.
        const finalTimeline = finished.status !== "completed" ? finished
          : { ...finished, status: cancelled ? "cancelled" as const : "failed" as const, ...(cancelled && entry.cancellationOrigin ? { cancellationOrigin: entry.cancellationOrigin } : {}) };
        if (entry.persistence === "none" && (content || produced.length)) {
          entry.persistence = await chatStore.appendMessage(params.chatId, { id: replyId, role: "assistant", content, timeline: finalTimeline, ...visualFields() }).then(() => "partial_saved" as const, () => {
            process.stderr.write("aiden: Could not persist the partial response.\n");
            return "partial_lost" as const;
          });
        }
        send("chat:error", { streamId, message: error instanceof Error ? error.message : String(error), cancelled, timeline: finalTimeline }); return true;
      } finally {
        watchdog.dispose(); unsubscribe(); disposeOwner(); removeBotAbort(); botAdmission?.release();
        if (!idleWarmerSettled) idleWarmer?.dispose();
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
    /** A deleted chat's journal is gone, and so is what its memory prompt told it, and its cache is no longer kept warm. */
    forgetMemoryFactsTold(chatId: string) { memoryFactsTold.delete(chatId); idleWarmers.get(chatId)?.dispose(); sessionPrefixes.forget(chatId); },
    /** A revoked device no longer attends the chats its turns left warming. */
    releaseDeviceAttendance(deviceId: string) {
      let prefix: string;
      try { prefix = remoteDeviceDocumentPrefix(deviceId); } catch { return; } // No paired device has that id.
      for (const warmer of [...idleWarmers.values()]) if (warmer.documentId?.startsWith(prefix)) warmer.dispose();
    },
    /** Whether a settled chat's prompt cache is being kept warm. */
    isKeepingChatWarm: (chatId: string) => idleWarmers.has(chatId),
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
        interrupted.delete(id); memoryFactsTold.delete(id); idleWarmers.get(id)?.dispose(); sessionPrefixes.forget(id); reopen();
      }
    },
    /** Every activity change (a run began or ended, an approval was raised or settled). */
    onActivityChange(listener: (snapshot: ChatActivitySnapshot) => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
    setBots(runtime: CliBotGenerationRuntime) { bots = runtime; },
    /** Closes intake before its first await, so no ingress stopping alongside it can begin a turn. */
    async stop() { idleWarmersStopped.abort(); const ids = turns.closeIntake(); admission.releaseAll(); await Promise.allSettled(ids.map((id) => llmClient.cancelChat(id, "application_shutdown"))); await Promise.all(ids.map((id) => llmClient.waitForChatIdle(id))); },
  };
}
