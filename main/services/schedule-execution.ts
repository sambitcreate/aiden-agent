import * as path from "node:path";
import { Notification, ipcMain, logger } from "../platform.js";
import { requestAppPath } from "./app-navigation.js";
import { APPROVAL_TOOL_NAMES } from "./coding-tools.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { providerRegistry } from "./provider-registry.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleStore, type ScheduleStore } from "./schedule-store.js";
import { SCHEDULE_TOOL_NAME } from "./schedule-tool.js";
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
import { recordDiagnosticCounter, recordDiagnosticGauge } from "./performance-diagnostics.js";

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
  const chat = await chatStore.appendMessage(chatId, { role: "assistant", content });
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
  }
}

function notify(task: ScheduledTask, body: string, chatId: string | undefined): void {
  showScheduledNotification(task, body, chatId, {
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    openChat: async (id) => {
      await requestAppPath(`/chat/${encodeURIComponent(id)}`);
    },
  });
}

export function createScheduleExecution(store: ScheduleStore = scheduleStore) {
  const activeStreams = new Map<string, string>();
  const activeControllers = new Map<string, AbortController>();

  async function ensureChat(task: ScheduledTask): Promise<string> {
    let chatId = await store.ensureChatId(task.id, () =>
      chatStore.create({
        title: task.name,
        workspaceId: task.workspaceId,
        providerId: task.providerId,
        model: task.model,
      }),
    );
    let chat = await chatStore.get(chatId);
    if (!chat) {
      await store.clearChatId(task.id, chatId);
      chatId = await store.ensureChatId(task.id, () =>
        chatStore.create({
          title: task.name,
          workspaceId: task.workspaceId,
          providerId: task.providerId,
          model: task.model,
        }),
      );
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

  async function executeScript(
    task: ScheduledTask,
    chatId: string,
    signal: AbortSignal,
  ): Promise<{
    result: ScheduledRun["result"];
    output: string;
    error?: string;
  }> {
    if (task.permission !== "full") {
      throw new Error(
        "Script tasks require Full permission because scripts can change the system.",
      );
    }
    const workspace = task.workspaceId
      ? await configStore.getWorkspace(task.workspaceId)
      : undefined;
    if (task.workspaceId && !workspace) throw new Error("The task workspace no longer exists.");
    if (workspace?.permission === "none") throw new Error("The task workspace has No Access.");
    if (workspace) await assertManagedWorktreeAdmission(workspace);
    const script = await resolveScheduledScript({
      script: task.script ?? "",
      workspaceRoot: workspace?.folderPath,
    });
    const turnId = scheduledTurnId(task.id, "script");
    const turn = llmClient.beginChatTurn(chatId, turnId, `scheduled-script:${task.id}`);
    if (!turn) {
      throw new Error("The scheduled task's dedicated chat already has a turn in progress.");
    }
    try {
      const processResult = await runScheduledScript(script, {
        cwd: workspace?.folderPath ?? path.dirname(script),
        signal,
      });
      if (processResult.aborted) {
        const error = "Scheduled task was cancelled.";
        await appendClaimedChatMessage(chatId, error);
        return { result: "blocked", output: processResult.stdout, error };
      }
      if (processResult.timedOut) {
        const error = "Script timed out after 60 seconds.";
        await appendClaimedChatMessage(chatId, `Scheduled task failed: ${error}`);
        return { result: "error", output: processResult.stdout, error };
      }
      if (processResult.outputLimitExceeded) {
        const error = "Script exceeded the 1 MB output limit.";
        await appendClaimedChatMessage(chatId, `Scheduled task failed: ${error}`);
        return { result: "error", output: processResult.stdout, error };
      }
      if (processResult.exitCode !== 0) {
        const detail =
          processResult.stderr.trim() ||
          `Process exited with code ${String(processResult.exitCode)}.`;
        const error = detail.slice(0, 4_096);
        await appendClaimedChatMessage(chatId, `Scheduled task failed: ${error}`);
        return { result: "error", output: processResult.stdout, error };
      }
      if (!processResult.stdout.trim()) return { result: "silent", output: "" };
      await appendClaimedChatMessage(chatId, processResult.stdout);
      return { result: "success", output: processResult.stdout };
    } finally {
      turn.release();
    }
  }

  async function executeLlm(
    task: ScheduledTask,
    chatId: string,
    signal: AbortSignal,
  ): Promise<{
    result: ScheduledRun["result"];
    output: string;
    error?: string;
  }> {
    assertAssistantScheduleExecutionBoundary(task);
    const workspace = task.workspaceId
      ? await configStore.getWorkspace(task.workspaceId)
      : undefined;
    if (task.workspaceId && !workspace) throw new Error("The task workspace no longer exists.");
    if (workspace?.permission === "none") throw new Error("The task workspace has No Access.");
    if (workspace) await assertManagedWorktreeAdmission(workspace);
    const settings = await configStore.getSettings();
    const providerId = task.providerId ?? settings.lastProviderId;
    if (!providerId) throw new Error("Choose a provider before running this scheduled task.");
    const provider =
      (await providerRegistry.selectionProvider(providerId)) ??
      (await configStore.getProvider(providerId));
    if (!provider) throw new Error("The task provider no longer exists.");
    const model = task.model ?? settings.lastModel ?? provider.defaultModel ?? provider.models[0];
    if (!model) throw new Error("Choose a model before running this scheduled task.");
    const prompt = task.prompt?.trim();
    if (!prompt) throw new Error("The scheduled task prompt is empty.");
    if (signal.aborted) throw new Error("Scheduled task was cancelled.");
    const excluded = new Set<string>([SCHEDULE_TOOL_NAME]);
    if (task.permission === "read-only") {
      for (const name of APPROVAL_TOOL_NAMES) excluded.add(name);
    }
    const streamId = `scheduled-${task.id}-${Date.now().toString(36)}`;
    const legacyAllMcp =
      task.mcpServerIds === undefined &&
      task.executionProfile === undefined &&
      task.permission === "full";
    const mcpServerIds = task.mcpServerIds ?? (legacyAllMcp ? undefined : []);
    const allowMcpTools =
      task.permission === "full" && (legacyAllMcp || (mcpServerIds?.length ?? 0) > 0);
    const background = createBackgroundOwner(streamId);
    const turn = llmClient.beginChatTurn(chatId, streamId, background.owner.documentId);
    if (!turn) {
      throw new Error("The scheduled task's dedicated chat already has a turn in progress.");
    }
    activeStreams.set(task.id, streamId);
    try {
      await chatStore.appendMessage(
        chatId,
        { role: "user", content: prompt },
        { providerId, model },
      );
      if (signal.aborted) throw new Error("Scheduled task was cancelled.");
      const started = await llmClient.start(
        streamId,
        {
          chatId,
          workspaceId: task.workspaceId,
          providerId,
          model,
          mode: scheduledTaskGenerationMode(task),
          messages: [{ role: "user", content: prompt }],
        },
        background.owner,
        {
          permission: task.permission,
          excludeToolNames: excluded,
          allowComputerUse: false,
          allowMcpTools,
          mcpServerIds,
          mcpServerBindings: task.mcpServerBindings,
          providerFingerprint: task.providerFingerprint,
          allowSubagents: false,
          usageSource: "scheduled",
          turnId: streamId,
        },
      );
      if (!started) throw new Error("The scheduled generation was cancelled before it started.");
      const terminal = await background.terminal;
      if (signal.aborted) {
        const error = "Scheduled task was cancelled.";
        await llmClient.waitForChatIdle(chatId);
        await appendSerializedChatMessage(chatId, error, scheduledTurnId(task.id, "cancelled"));
        return { result: "blocked", output: "", error };
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

  return {
    async run(task: ScheduledTask): Promise<ScheduledRun> {
      if (activeControllers.has(task.id)) {
        recordDiagnosticCounter("schedule:run-duplicate", { errors: 1 });
        throw new Error("This scheduled task is already running.");
      }
      const controller = new AbortController();
      activeControllers.set(task.id, controller);
      recordDiagnosticCounter("schedule:run-start");
      recordDiagnosticCounter("schedule:run-duplicate", { count: 0 });
      recordDiagnosticGauge("live:schedule-run", activeControllers.size);
      const startedAt = Date.now();
      let chatId: string | undefined;
      let result: ScheduledRun["result"] = "error";
      let output = "";
      let error: string | undefined;
      try {
        assertAssistantScheduleExecutionBoundary(task);
        chatId = await ensureChat(task);
        const execution =
          task.mode === "script"
            ? await executeScript(task, chatId, controller.signal)
            : await executeLlm(task, chatId, controller.signal);
        result = execution.result;
        output = execution.output;
        error = execution.error;
      } catch (cause) {
        error = resultError(cause).slice(0, 4_096);
        if (controller.signal.aborted) result = "blocked";
        if (chatId) {
          if (task.mode === "llm") await llmClient.waitForChatIdle(chatId);
          await appendSerializedChatMessage(
            chatId,
            `Scheduled task failed: ${error}`,
            scheduledTurnId(task.id, "error"),
          ).catch((appendError) => {
            logger.warn(
              "schedule",
              "Could not append a scheduled task error to its chat.",
              appendError,
            );
          });
        }
      }
      try {
        const run = await store.recordRun({
          taskId: task.id,
          startedAt,
          finishedAt: Date.now(),
          result,
          output,
          error,
          chatId,
        });
        recordDiagnosticCounter(`schedule:run-terminal:${result}`);
        if (result !== "silent") notify(task, error ?? output, chatId);
        ipcMain.broadcast("schedule:updated", { taskId: task.id, run });
        return run;
      } finally {
        activeControllers.delete(task.id);
        recordDiagnosticGauge("live:schedule-run", activeControllers.size);
      }
    },

    cancel(taskId: string): boolean {
      const controller = activeControllers.get(taskId);
      controller?.abort();
      const streamId = activeStreams.get(taskId);
      const streamCancelled = streamId ? llmClient.cancel(streamId) : false;
      return Boolean(controller) || streamCancelled;
    },

    cancelAll(): void {
      for (const [taskId, controller] of activeControllers) {
        controller.abort();
        const streamId = activeStreams.get(taskId);
        if (streamId) llmClient.cancel(streamId);
      }
    },
  };
}

export const scheduleExecution = createScheduleExecution();
export type ScheduleExecution = ReturnType<typeof createScheduleExecution>;
