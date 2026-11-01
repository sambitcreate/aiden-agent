import { app, ipcMain } from "../platform.js";
import { ChatTriageStore, wakeTriageOnAttention } from "./chat-triage.js";
import { hostRunRegistry } from "./host-runs-main.js";

export const chatTriage = new ChatTriageStore(() => app.getPath("userData"), {
  onChange: (snapshot) => ipcMain.broadcast("chats:triage-changed", snapshot),
});

let stopWaking: (() => void) | null = null;

/** Arm the snooze timer and the early wake. Called once the app is ready. */
export function startChatTriage(): void {
  if (stopWaking) return;
  stopWaking = wakeTriageOnAttention(hostRunRegistry, chatTriage);
  void chatTriage.start().catch(() => undefined);
}

export function stopChatTriage(): void {
  stopWaking?.();
  stopWaking = null;
  chatTriage.dispose();
}
