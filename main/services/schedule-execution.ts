import * as path from "node:path";
import { Notification, ipcMain, logger } from "../platform.js";
import { reportChatMessageSent } from "./analytics/analytics-feature-reports.js";
import { analyticsRunTrigger, analyticsWorkspaceKind } from "./analytics/analytics-ids.js";
import { reportAnalyticsEvent } from "./analytics/analytics-report.js";
import { requestAppPath } from "./app-navigation.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { providerRegistry } from "./provider-registry.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleStore, type ScheduleStore } from "./schedule-store.js";
import { scheduledGenerationToolPolicy } from "./scheduled-generation-policy.js";
import { webSearchService } from "./web-search-main.js";
import {
  assertAssistantScheduleExecutionBoundary,
  isSilentAssistantScheduleResponse,
  scheduledTaskGenerationMode,
} from "./schedule-guard.js";
import { showScheduledNotification } from "./schedule-notification.js";
import type { ChatDone, ChatError, ScheduledRun, ScheduledTask } from "./types.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import { assertWorkspaceFolderPresent } from "./workspace-folder-presence.js";
import { createScheduledChatClaim } from "./scheduled-chat-creation.js";
import { firstVisibleModelForProvider } from "../../renderer/shared/model-visibility.js";
import { canUseGeminiChatModel } from "../../renderer/shared/gemini-usage-scope.js";
import {
  beginSurfaceGeneration,
  scheduledGenerationSurface,
  startSurfaceGeneration,
} from "./conversation-surface-generation.js";
import { acpHarnessUnavailableReason, isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";
import { createBotRoutineExecutor, type BotRoutineExecutor } from "./scheduled-bot-routines.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import type { AgentNoticePost } from "./follow-through/notice-delivery.js";
import { noticeDelivery } from "./follow-through/notice-delivery-main.js";
import {
  createTaskRunChatDelivery,
  type AdmittedTaskTurn,
  type TaskRunExecution,
  type TaskRunOutcome,
} from "./schedule-chat-delivery.js";
import { formatScheduledTaskCadence } from "../../renderer/shared/scheduled-task-presentation.js";
import { formatScheduledTaskTriggerLabel } from "../../renderer/shared/scheduled-task-trigger.js";

function createBackgroundOwner(streamId: string): {
  owner: ChatGenerationOwner;
  terminal: Promise<ChatDone | ChatError>;
  destroy(): void;
} {
  let destroyed = false;
  let settle: ((payload: ChatDone | ChatError) => void) | undefined;
  const terminal = new Promise<ChatDone | ChatError>((resolve) => {
    settle = resolve;
  });
  const owner: ChatGenerationOwner = {
    id: 0,
    documentId: `scheduled:${streamId}`,
    isDestroyed: () => destroyed,
    send: (channel: NotificationChannel, payload: unknown) => {
      if (destroyed) throw new Error("The scheduled generation is no longer active.");
      if (channel === "chat:done" || channel === "chat:error")
        settle?.(payload as ChatDone | ChatError);
    },
    onInvalidated: () => () => undefined,
  };
  return {
    owner,
    terminal,
    destroy: () => {
      destroyed = true;
    },
  };
}

function resultError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let scheduledTurnSequence = 0;

function scheduledTurnId(taskId: string, kind: string): string {
  scheduledTurnSequence += 1;
  return `scheduled-${kind}-${taskId}-${Date.now().toString(36)}-${scheduledTurnSequence.toString(36)}`;
}

async function appendClaimedChatMessage(chatId: string, content: string): Promise<void> {
  const chat = await chatStore.appendMessage(chatId, {
    role: "assistant",
    content,
  });
  ipcMain.broadcast("chats:metadata-updated", {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
  });
}

async function appendSerializedChatMessage(
  chatId: string,
  content: string,
  turnId: string,
): Promise<void> {
  const ownerId = `scheduled-write:${turnId}`;
  const turn = llmClient.beginChatTurn(chatId, turnId, ownerId);
  if (!turn) {
    throw new Error("The scheduled task's chat has another turn in progress.");
  }
  try {
    await appendClaimedChatMessage(chatId, content);
  } finally {
    turn.release();
    turn.settleAsyncWork();
  }
}

async function isFolderWorkspace(workspaceId: string | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  return analyticsWorkspaceKind(await configStore.getWorkspace(workspaceId)) !== "none";
}

// A cancelled or skipped run is neither a success nor a failure, so it is not
// counted. A run that ended blocked by a permission did fail.
function reportScheduledTaskRan(
  result: ScheduledRun["result"],
  trigger: ScheduledRunTrigger | undefined,
  cancelled: boolean,
): void {
  if (cancelled || result === "skipped") return;
  reportAnalyticsEvent("scheduled_task_ran", {
    trigger: trigger ? analyticsRunTrigger(trigger) : "manual",
    result: result === "success" || result === "silent" ? result : "failed",
  });
}

function notify(task: ScheduledTask, body: string, chatId: string | undefined): void {
  showScheduledNotification(task, body, chatId, {
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    openChat: async (id) => {
      await requestAppPath(`/chat/${encodeURIComponent(id)}`);
    },
    onError: (stage) => {
      // Native errors can include notification content; retain only the phase.
      logger.warn("schedule", `Scheduled notification ${stage} failed.`);
    },
  });
}

export function createScheduleExecution(store: ScheduleStore = scheduleStore) {
  const activeStreams = new Map<string, string>();
  const activeControllers = new Map<string, AbortController>();
  // Bot routines submit to their Bot's conversation, never a workspace chat.
  let botRoutines: BotRoutineExecutor | undefined;
  const botRoutineExecutor = () =>
    (botRoutines ??= createBotRoutineExecutor({
      store,
      ports: async () => (await import("./scheduled-bot-routines-main.js")).botRoutinePorts(),
      // Everything a Bot says to the person leaves through one funnel: the
      // delivery log, the Mac banner, Telegram and the phone feed.
      deliver: async (input) => (await import("./bot-delivery/funnel-main.js")).botDeliveryFunnel().deliver(input),
      broadcast: (payload) => ipcMain.broadcast("bots:changed", payload),
      afterRun: async (task, run, trigger) => {
        const outcome = await (await import("./bot-routine-recovery-main.js")).botRoutineRecovery().afterRun(task, run, trigger);
        // Reflection runs on its own time; the routine's delivery never waits for it.
        void import("./bot-learning/learning-main.js")
          .then(({ afterRoutineRunForLearning }) => afterRoutineRunForLearning(task, run))
          .catch(() => undefined);
        return outcome;
      },
    }));

  async function ensureChat(task: ScheduledTask): Promise<string> {
    const create = (claimedChatId: string) =>
      createScheduledChatClaim(claimedChatId, () =>
        chatStore.create({
          id: claimedChatId,
          title: task.name,
          workspaceId: task.workspaceId,
          providerId: task.providerId,
          model: task.model,
        }),
      );
    let chatId = await store.ensureChatId(task.id, create);
    let chat = await chatStore.get(chatId);
    if (!chat) {
      await store.clearChatId(task.id, chatId);
      chatId = await store.ensureChatId(task.id, create);
      chat = await chatStore.get(chatId);
      if (!chat) throw new Error("Could not create the scheduled task's dedicated chat.");
    }
    if (chat) {
      ipcMain.broadcast("chats:metadata-updated", {
        chatId: chat.id,
        workspaceId: chat.workspaceId,
        title: chat.title,
        updatedAt: chat.updatedAt,
      });
    }
    return chatId;
  }

  /** Runs the task's script; `output` is what it printed. Holds no chat. */
  async function runTaskScript(task: ScheduledTask, signal: AbortSignal): Promise<TaskRunExecution> {
    if (task.permission !== "full") {
      throw new Error(
        "Script tasks require Full permission because scripts can change the system.",
      );
    }
    const workspace = await assertTaskWorkspaceReady(task);
    const script = await resolveScheduledScript({
      script: task.script ?? "",
      workspaceRoot: workspace?.folderPath,
    });
    const processResult = await runScheduledScript(script, {
      cwd: workspace?.folderPath ?? path.dirname(script),
      signal,
    });
    if (processResult.aborted) {
      return { result: "blocked", output: processResult.stdout, error: "Scheduled task was cancelled." };
    }
    if (processResult.timedOut) {
      return { result: "error", output: processResult.stdout, error: "Script timed out after 60 seconds." };
    }
    if (processResult.outputLimitExceeded) {
      return { result: "error", output: processResult.stdout, error: "Script exceeded the 1 MB output limit." };
    }
    if (processResult.exitCode !== 0) {
      const detail =
        processResult.stderr.trim() ||
        `Process exited with code ${String(processResult.exitCode)}.`;
      return { result: "error", output: processResult.stdout, error: detail.slice(0, 4_096) };
    }
    if (!processResult.stdout.trim()) return { result: "silent", output: "" };
    return { result: "success", output: processResult.stdout };
  }

  /** A script run in the task's own chat: the chat is held while it runs, then says what happened. */
  async function executeScript(
    task: ScheduledTask,
    chatId: string,
    signal: AbortSignal,
  ): Promise<TaskRunExecution> {
    const turnId = scheduledTurnId(task.id, "script");
    const turn = llmClient.beginChatTurn(chatId, turnId, `scheduled-script:${task.id}`);
    if (!turn) {
      throw new Error("The scheduled task's dedicated chat already has a turn in progress.");
    }
    try {
      const execution = await runTaskScript(task, signal);
      if (execution.result === "blocked") {
        await appendClaimedChatMessage(chatId, execution.error ?? "Scheduled task was cancelled.");
      } else if (execution.result === "error") {
        await appendClaimedChatMessage(chatId, `Scheduled task failed: ${execution.error ?? "unknown error"}`);
      } else if (execution.result === "success") {
        await appendClaimedChatMessage(chatId, execution.output);
      }
      return execution;
    } finally {
      turn.release();
      turn.settleAsyncWork();
    }
  }

  /** Everything a model run needs, checked before it takes the chat. */
  async function prepareLlm(task: ScheduledTask, chatId: string, prompt: string, keepChatModel = false) {
    assertAssistantScheduleExecutionBoundary(task);
    await assertTaskWorkspaceReady(task);
    const settings = await configStore.getSettings();
    if (!task.providerId && isAcpHarnessProvider(settings.lastProviderId ?? "")) {
      throw new Error(
        "This task follows your last-used model, which can't run scheduled tasks. Pin a model in the task's settings.",
      );
    }
    const providerId = task.providerId ?? settings.lastProviderId;
    if (!providerId) throw new Error("Choose a provider before running this scheduled task.");
    const provider =
      (await providerRegistry.selectionProvider(providerId)) ??
      (await configStore.getProvider(providerId));
    if (!provider) throw new Error("The task provider no longer exists.");
    const harnessReason = acpHarnessUnavailableReason(providerId);
    if (harnessReason) throw new Error(harnessReason);
    if (!canUseGeminiChatModel(settings.geminiUsageScope, providerId)) {
      throw new Error(
        "Google chat models are off while Gemini is configured for transcription only.",
      );
    }
    const model =
      task.model ??
      firstVisibleModelForProvider(settings.hiddenModelsByProvider, providerId, provider.models, [
        settings.lastProviderId === providerId ? settings.lastModel : undefined,
        provider.defaultModel,
      ]);
    if (!model) throw new Error("Choose a model before running this scheduled task.");
    if (!task.prompt?.trim()) throw new Error("The scheduled task prompt is empty.");
    const toolPolicy = await scheduledGenerationToolPolicy(task, () =>
      webSearchService.availability(),
    );
    const streamId = `scheduled-${task.id}-${Date.now().toString(36)}`;
    const background = createBackgroundOwner(streamId);
    const surface = scheduledGenerationSurface({
      chatId,
      streamId,
      ownerId: background.owner.documentId,
      workspaceId: task.workspaceId,
      providerId,
      model,
      mode: scheduledTaskGenerationMode(task),
      prompt,
      permission: task.permission,
      ...toolPolicy,
      ...(keepChatModel ? { keepChatModel: true } : {}),
    });
    return { providerId, model, surface, background, streamId };
  }

  type PreparedLlm = Awaited<ReturnType<typeof prepareLlm>>;
  type SurfaceTurn = NonNullable<ReturnType<typeof llmClient.beginChatTurn>>;

  /** A model run in the task's own chat: the prompt is a plain user message, as it always was. */
  async function executeLlm(
    task: ScheduledTask,
    chatId: string,
    signal: AbortSignal,
    eventText?: string,
  ): Promise<TaskRunExecution> {
    // A trigger's event follows the person's instructions, already fenced as data.
    const prompt = [task.prompt?.trim() ?? "", ...(eventText ? [eventText] : [])].join("\n\n");
    const prepared = await prepareLlm(task, chatId, prompt);
    if (signal.aborted) {
      prepared.background.destroy();
      throw new Error("Scheduled task was cancelled.");
    }
    const { surface } = prepared;
    const turn = beginSurfaceGeneration(llmClient.beginChatTurn.bind(llmClient), surface);
    if (!turn) {
      prepared.background.destroy();
      throw new Error("The scheduled task's dedicated chat already has a turn in progress.");
    }
    try {
      await chatStore.appendMessage(
        chatId,
        { role: "user", content: prompt },
        { providerId: prepared.providerId, model: prepared.model },
      );
    } catch (error) {
      turn.release();
      prepared.background.destroy();
      throw error;
    } finally {
      // Generation still owns the authority lease after this append frame,
      // but no renderer/scheduler payload remains retained by persistence.
      turn.settleAsyncWork();
    }
    return finishLlm(task, prepared, turn, signal, async () => {
      await llmClient.waitForChatIdle(chatId);
      await appendSerializedChatMessage(
        chatId,
        "Scheduled task was cancelled.",
        scheduledTurnId(task.id, "cancelled"),
      );
    });
  }

  /** Starts the admitted generation and waits for its answer. Releases the turn. */
  async function finishLlm(
    task: ScheduledTask,
    prepared: PreparedLlm,
    turn: SurfaceTurn,
    signal: AbortSignal,
    onCancelled: () => Promise<void>,
  ): Promise<TaskRunExecution> {
    const { surface, background, streamId } = prepared;
    activeStreams.set(task.id, streamId);
    try {
      if (signal.aborted) throw new Error("Scheduled task was cancelled.");
      const started = await startSurfaceGeneration(
        llmClient.start.bind(llmClient),
        surface,
        background.owner,
      );
      if (!started) throw new Error("The scheduled generation was cancelled before it started.");
      reportChatMessageSent({
        providerId: surface.params.providerId,
        model: surface.params.model,
        origin: "schedule",
        inWorkspace: () => isFolderWorkspace(surface.params.workspaceId),
      });
      const terminal = await background.terminal;
      if (signal.aborted) {
        await onCancelled();
        return { result: "blocked", output: "", error: "Scheduled task was cancelled." };
      }
      // The person pressed Stop in the chat: the partial answer stays there,
      // and the run counts as stopped, never as a success or a failure.
      if (!("message" in terminal) && terminal.timeline?.status === "cancelled") {
        return { result: "blocked", output: terminal.content, error: "Stopped before it finished.", cancelled: true };
      }
      if ("message" in terminal) {
        const error = terminal.message;
        return {
          result: /\bblocked\b|\bread-only\b|\bdenied\b/iu.test(error) ? "blocked" : "error",
          output: terminal.content ?? "",
          error,
        };
      }
      if (isSilentAssistantScheduleResponse(task, terminal.content)) {
        return { result: "silent", output: "" };
      }
      return { result: "success", output: terminal.content };
    } finally {
      turn.release();
      background.destroy();
      activeStreams.delete(task.id);
    }
  }

  async function assertTaskWorkspaceReady(task: ScheduledTask) {
    const workspace = task.workspaceId
      ? await configStore.getWorkspace(task.workspaceId)
      : undefined;
    if (task.workspaceId && !workspace) throw new Error("The task workspace no longer exists.");
    if (workspace?.permission === "none") throw new Error("The task workspace has No Access.");
    if (workspace) {
      await assertWorkspaceFolderPresent(workspace);
      await assertManagedWorktreeAdmission(workspace);
    }
    return workspace;
  }

  /**
   * A model run in the chat the task was made in: the prompt is saved as a
   * "Scheduled task" notice and the answer follows in the conversation.
   */
  async function admitTurnInChat(
    task: ScheduledTask,
    chatId: string,
    post: AgentNoticePost,
    signal: AbortSignal,
  ): Promise<AdmittedTaskTurn> {
    // The task may answer on another model than the chat's own; the chat
    // keeps its choice, so nothing this run saves changes the chat's model.
    const prepared = await prepareLlm(task, chatId, post.text, true);
    if (signal.aborted) {
      prepared.background.destroy();
      throw new Error("Scheduled task was cancelled.");
    }
    const turn = beginSurfaceGeneration(llmClient.beginChatTurn.bind(llmClient), prepared.surface);
    if (!turn) {
      prepared.background.destroy();
      return { kind: "busy" };
    }
    try {
      turn.reserveAppendPayload(Buffer.byteLength(post.text, "utf8") + 1_024);
      await chatStore.appendMessage(
        chatId,
        { role: "user", content: post.text, notice: post.notice },
        {
          expectedWorkspaceId: task.workspaceId,
          isCurrent: () => turn.isActive(),
        },
      );
      ipcMain.broadcast("chats:changed", {});
      ipcMain.broadcast("chats:follow-through-changed", { chatId, transcript: true });
    } catch (error) {
      turn.release();
      prepared.background.destroy();
      throw error;
    } finally {
      turn.settleAsyncWork();
    }
    return {
      kind: "admitted",
      finish: () => finishLlm(task, prepared, turn, signal, async () => undefined),
    };
  }

  const chatDelivery = createTaskRunChatDelivery({
    getChat: async (chatId) => (await chatStore.get(chatId)) ?? undefined,
    currentTask: (taskId) => store.get(taskId),
    releaseOriginChat: async (taskId, chatId) => {
      if (await store.clearOriginChat(taskId, { expectedChatId: chatId })) {
        ipcMain.broadcast("schedule:updated", { taskId });
      }
    },
    ensureOwnChat: ensureChat,
    runInOwnChat: (task, chatId, signal, eventText) =>
      task.mode === "script" ? executeScript(task, chatId, signal) : executeLlm(task, chatId, signal, eventText),
    reportOwnChatFailure: async (task, chatId, message) => {
      if (task.mode === "llm") await llmClient.waitForChatIdle(chatId);
      await appendSerializedChatMessage(chatId, message, scheduledTurnId(task.id, "error"));
    },
    runScript: runTaskScript,
    admitTurn: admitTurnInChat,
    waitForIdle: (chatId, timeoutMs) => llmClient.waitForChatIdleWithin(chatId, timeoutMs),
    postNotice: (post) => noticeDelivery.post(post),
    inChatOrder: (chatId, work) => noticeDelivery.inOrder(chatId, work),
    cadence: (task) => task.trigger ? formatScheduledTaskTriggerLabel(task.trigger) : formatScheduledTaskCadence(task.cron, task.timezone),
    now: Date.now,
    onError: (error) => logger.warn("schedule", "A scheduled task's chat delivery step failed.", error),
  });

  /**
   * Every task run, whatever started it, lands through here: in the chat the
   * task was made in when it has one, otherwise in the task's own chat.
   */
  function deliverTaskRunToChat(
    task: ScheduledTask,
    options: { trigger?: ScheduledRunTrigger; eventText?: string; signal: AbortSignal },
  ): Promise<TaskRunOutcome> {
    return chatDelivery.deliverTaskRunToChat(task, options);
  }

  return {
    claimRoutineExecution: (task: ScheduledTask, trigger: ScheduledRunTrigger) =>
      import("./scheduled-bot-routines-main.js").then(({ claimBotRoutineExecution }) => claimBotRoutineExecution(task, trigger)),
    deliverTaskRunToChat,
    /** A record-only card where the task's runs land (a trigger or the task was paused). */
    recordInLandingChat: (task: ScheduledTask, card: Parameters<typeof chatDelivery.recordInLandingChat>[1]) =>
      chatDelivery.recordInLandingChat(task, card),
    /** The project folder a task's script runs in, after the same checks as a run. */
    async taskWorkspaceFolder(task: ScheduledTask): Promise<string | undefined> {
      return (await assertTaskWorkspaceReady(task))?.folderPath;
    },
    async run(
      task: ScheduledTask,
      runId?: string,
      trigger?: ScheduledRunTrigger,
    ): Promise<ScheduledRun> {
      if (activeControllers.has(task.id)) {
        throw new Error("This scheduled task is already running.");
      }
      const controller = new AbortController();
      activeControllers.set(task.id, controller);
      if (task.botId !== undefined) {
        try {
          return await botRoutineExecutor().run(task, {
            runId,
            trigger,
            signal: controller.signal,
          });
        } finally {
          activeControllers.delete(task.id);
        }
      }
      const startedAt = Date.now();
      let chatId: string | undefined;
      let result: ScheduledRun["result"] = "error";
      let reason: ScheduledRun["reason"];
      let output = "";
      let error: string | undefined;
      let stopped = false;
      try {
        assertAssistantScheduleExecutionBoundary(task);
        // A trigger's event reaches the model only as fenced data after the prompt.
        const eventText = trigger?.kind === "event" ? trigger.payload : undefined;
        const outcome = await deliverTaskRunToChat(task, { trigger, ...(eventText ? { eventText } : {}), signal: controller.signal });
        chatId = outcome.chatId;
        output = outcome.output;
        if (outcome.kind === "skipped") {
          result = "skipped";
          reason = outcome.reason;
        } else {
          result = outcome.result;
          error = outcome.error;
          stopped = outcome.cancelled === true;
        }
      } catch (cause) {
        error = resultError(cause).slice(0, 4_096);
        if (controller.signal.aborted) result = "blocked";
      }
      // Stopped from the task list (the scheduler's cancel) or with the chat's Stop button.
      const cancelled = controller.signal.aborted || stopped;
      try {
        const run = await store.recordRun({
          id: runId,
          taskId: task.id,
          startedAt,
          finishedAt: Date.now(),
          result,
          ...(reason ? { reason } : {}),
          output,
          error,
          chatId,
          ...(trigger?.kind === "manual" ? { byHand: true as const } : {}),
          ...(result === "blocked" && cancelled ? { cancelled: true as const } : {}),
        });
        reportScheduledTaskRan(result, trigger, cancelled);
        if (result !== "silent" && result !== "skipped" && !cancelled) notify(task, error ?? output, chatId);
        ipcMain.broadcast("schedule:updated", { taskId: task.id, run });
        return run;
      } finally {
        activeControllers.delete(task.id);
      }
    },

    cancel(taskId: string): boolean {
      const controller = activeControllers.get(taskId);
      controller?.abort();
      const streamId = activeStreams.get(taskId);
      const streamCancelled = streamId
        ? llmClient.cancel(streamId, "scheduled_task_cancel")
        : false;
      return Boolean(controller) || streamCancelled;
    },

    cancelAll(): void {
      for (const [taskId, controller] of activeControllers) {
        controller.abort();
        const streamId = activeStreams.get(taskId);
        if (streamId) llmClient.cancel(streamId, "scheduled_task_cancel");
      }
    },
  };
}

export const scheduleExecution = createScheduleExecution();
export type ScheduleExecution = ReturnType<typeof createScheduleExecution>;
