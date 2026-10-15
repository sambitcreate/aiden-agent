import { ipcMain, logger } from "../platform.js";
import { hostRunRegistry } from "../services/host-runs-main.js";
import { llmClient } from "../services/llm-client.js";
import { LocalRunObservers } from "../services/local-run-observers.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { registerLocalRunHandlers } from "./local-runs.js";

let observers: LocalRunObservers | null = null;

function localRunObservers(): LocalRunObservers {
  observers ??= new LocalRunObservers({
    registry: hostRunRegistry,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return observers;
}

export function registerLocalRunIpc(): void {
  registerLocalRunHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: (event) => {
      const owner = rendererDocumentOwner(
        event,
        () => new Error("Watching a run requires an active application document."),
      );
      return {
        key: `${owner.id}:${owner.documentId}`,
        isDestroyed: owner.isDestroyed,
        send: owner.send,
        onInvalidated: owner.onInvalidated,
      };
    },
    observers: localRunObservers,
    stopRun: (runId) => {
      const summary = hostRunRegistry.summary(runId);
      if (!summary || summary.state === "done" || summary.state === "failed" || summary.state === "cancelled") {
        return false;
      }
      // The same host-authority stop Aiden Remote's run controls use.
      const cancelled = llmClient.cancel(runId, "user_stop");
      if (cancelled) logger.info("chat", JSON.stringify({ event: "renderer_host_run_stop", runId }));
      return cancelled;
    },
    isRunSettled: (runId) => {
      const state = hostRunRegistry.summary(runId)?.state;
      const terminal = state === "done" || state === "failed" || state === "cancelled";
      return terminal && !llmClient.isGenerationLive(runId);
    },
  });
}
