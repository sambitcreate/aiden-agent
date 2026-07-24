import * as path from "node:path";
import { Notification, ipcMain, logger } from "../platform.js";
import { APPROVAL_TOOL_NAMES } from "./coding-tools.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";
import { scheduleStore, type ScheduleStore } from "./schedule-store.js";
import type { ChatDone, ChatError, ScheduledRun, ScheduledTask } from "./types.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";

const SCHEDULE_TOOL_NAME = "schedule_task";

function createBackgroundOwner(
  streamId: string,
): { owner: ChatGenerationOwner; terminal: Promise<ChatDone | ChatError>; destroy(): void } {
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
      if (channel === "chat:done" || channel === "chat:error") settle?.(payload as ChatDone | ChatError);
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

async function appendChatMessage(chatId: string, content: string): Promise<void> {
  const chat = await chatStore.appendMessage(chatId, { role: "assistant", content });
  ipcMain.broadcast("chats:metadata-updated", {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
  });
}

function notify(task: ScheduledTask, body: string): void {
  if (!task.notify || !Notification.isSupported()) return;
  const notification = new Notification({
    title: task.name,
    body: body.replace(/\s+/gu, " ").trim().slice(0, 120),
  });
  notification.show();
}

export function createScheduleExecution(store: ScheduleStore = scheduleStore) {
  const activeStreams = new Map<string, string>();

  async function ensureChat(task: ScheduledTask): Promise<string> {
    const chatId = await store.ensureChatId(task.id, () =>
      chatStore.create({
        title: task.name,
        workspaceId: task.workspaceId,
        providerId: task.providerId,
        model: task.model,
      }),
    );
    const chat = await chatStore.get(chatId);
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

  async function executeScript(task: ScheduledTask, chatId: string): Promise<{
    result: ScheduledRun["result"];
    output: string;
    error?: string;
  }> {
    const workspace = task.workspaceId ? await configStore.getWorkspace(task.workspaceId) : undefined;
    if (task.workspaceId && !workspace) throw new Error("The task workspace no longer exists.");
    if (workspace?.permission === "none") throw new Error("The task workspace has No Access.");
    const script = await resolveScheduledScript({
      script: task.script ?? "",
      workspaceRoot: workspace?.folderPath,
    });
    const processResult = await runScheduledScript(script, {
      cwd: workspace?.folderPath ?? path.dirname(script),
    });
    if (processResult.timedOut) {
      const error = "Script timed out after 60 seconds.";
      await appendChatMessage(chatId, `Scheduled task failed: ${error}`);
      return { result: "error", output: processResult.stdout, error };
    }
    if (processResult.outputLimitExceeded) {
      const error = "Script exceeded the 1 MB output limit.";
      await appendChatMessage(chatId, `Scheduled task failed: ${error}`);
      return { result: "error", output: processResult.stdout, error };
    }
    if (processResult.exitCode !== 0) {
      const detail = processResult.stderr.trim() || `Process exited with code ${String(processResult.exitCode)}.`;
      const error = detail.slice(0, 4_096);
      await appendChatMessage(chatId, `Scheduled task failed: ${error}`);
      return { result: "error", output: processResult.stdout, error };
    }
    if (!processResult.stdout.trim()) return { result: "silent", output: "" };
    await appendChatMessage(chatId, processResult.stdout);
    return { result: "success", output: processResult.stdout };
  }

  async function executeLlm(task: ScheduledTask, chatId: string): Promise<{
    result: ScheduledRun["result"];
    output: string;
    error?: string;
  }> {
    const workspace = task.workspaceId ? await configStore.getWorkspace(task.workspaceId) : undefined;
    if (task.workspaceId && !workspace) throw new Error("The task workspace no longer exists.");
    if (workspace?.permission === "none") throw new Error("The task workspace has No Access.");
    const settings = await configStore.getSettings();
    const providerId = task.providerId ?? settings.lastProviderId;
    if (!providerId) throw new Error("Choose a provider before running this scheduled task.");
    const provider = await configStore.getProvider(providerId);
    if (!provider) throw new Error("The task provider no longer exists.");
    const model = task.model ?? settings.lastModel ?? provider.defaultModel ?? provider.models[0];
    if (!model) throw new Error("Choose a model before running this scheduled task.");
    const prompt = task.prompt?.trim();
    if (!prompt) throw new Error("The scheduled task prompt is empty.");

    await chatStore.appendMessage(
      chatId,
      { role: "user", content: prompt },
      { providerId, model },
    );
    const streamId = `scheduled-${task.id}-${Date.now().toString(36)}`;
    const background = createBackgroundOwner(streamId);
    activeStreams.set(task.id, streamId);
    try {
      const excluded = new Set<string>([SCHEDULE_TOOL_NAME]);
      if (task.permission === "read-only") {
        for (const name of APPROVAL_TOOL_NAMES) excluded.add(name);
      }
      const started = await llmClient.start(
        streamId,
        {
          chatId,
          workspaceId: task.workspaceId,
          providerId,
          model,
          messages: [{ role: "user", content: prompt }],
        },
        background.owner,
        {
          permission: task.permission,
          excludeToolNames: excluded,
          allowComputerUse: false,
        },
      );
      if (!started) throw new Error("The scheduled generation was cancelled before it started.");
      const terminal = await background.terminal;
      if ("message" in terminal) {
        const error = terminal.message;
        return {
          result: /\bblocked\b|\bread-only\b|\bdenied\b/iu.test(error) ? "blocked" : "error",
          output: terminal.content ?? "",
          error,
        };
      }
      return { result: "success", output: terminal.content };
    } finally {
      background.destroy();
      activeStreams.delete(task.id);
    }
  }

  return {
    async run(task: ScheduledTask): Promise<ScheduledRun> {
      const startedAt = Date.now();
      let chatId: string | undefined;
      let result: ScheduledRun["result"] = "error";
      let output = "";
      let error: string | undefined;
      try {
        chatId = await ensureChat(task);
        const execution =
          task.mode === "script"
            ? await executeScript(task, chatId)
            : await executeLlm(task, chatId);
        result = execution.result;
        output = execution.output;
        error = execution.error;
      } catch (cause) {
        error = resultError(cause).slice(0, 4_096);
        if (chatId) {
          await appendChatMessage(chatId, `Scheduled task failed: ${error}`).catch((appendError) => {
            logger.warn("schedule", "Could not append a scheduled task error to its chat.", appendError);
          });
        }
      }
      const run = await store.recordRun({
        taskId: task.id,
        startedAt,
        finishedAt: Date.now(),
        result,
        output,
        error,
        chatId,
      });
      if (result !== "silent") notify(task, error ?? output);
      ipcMain.broadcast("schedule:updated", { taskId: task.id, run });
      return run;
    },

    cancel(taskId: string): boolean {
      const streamId = activeStreams.get(taskId);
      return streamId ? llmClient.cancel(streamId) : false;
    },

    cancelAll(): void {
      for (const streamId of activeStreams.values()) llmClient.cancel(streamId);
    },
  };
}

export const scheduleExecution = createScheduleExecution();
export type ScheduleExecution = ReturnType<typeof createScheduleExecution>;
