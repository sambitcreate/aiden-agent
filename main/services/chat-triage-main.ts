import { app, ipcMain, logger, powerMonitor } from "../platform.js";
import { ChatTriageStore, wakeTriageOnAttention } from "./chat-triage.js";
import { hostRunRegistry } from "./host-runs-main.js";

export const chatTriage = new ChatTriageStore(() => app.getPath("userData"), {
  onChange: (snapshot) => ipcMain.broadcast("chats:triage-changed", snapshot),
  logError: (message, error) => logger.error("chat-triage", message, error),
});

let stopWaking: (() => void) | null = null;

/** A timer may have slept through its time: clear passed snoozes and re-arm. */
const checkSnoozes = (): void => {
  void chatTriage.checkSnoozes().catch(() => undefined);
};

/**
 * Arm the snooze timer and the early wake, and re-check snoozes when the Mac
 * wakes from sleep or unlocks. Called once the app is ready (powerMonitor is
 * only usable then).
 */
export function startChatTriage(): void {
  if (stopWaking) return;
  const stopAttention = wakeTriageOnAttention(hostRunRegistry, chatTriage);
  powerMonitor.on("resume", checkSnoozes);
  powerMonitor.on("unlock-screen", checkSnoozes);
  stopWaking = () => {
    stopAttention();
    powerMonitor.removeListener("resume", checkSnoozes);
    powerMonitor.removeListener("unlock-screen", checkSnoozes);
  };
  void chatTriage.start().catch(() => undefined);
}

/** Stop the timer, the early wake and the power listeners. Called at quit. */
export function stopChatTriage(): void {
  stopWaking?.();
  stopWaking = null;
  chatTriage.dispose();
}
