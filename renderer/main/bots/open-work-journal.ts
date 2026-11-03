import { parseBotOpenWorkMutation, type BotOpenWorkMutation, type BotOpenWorkSnapshot } from "../../shared/bot-open-work";

const PREFIX = "aiden:open-work:pending:";
export const OPEN_WORK_JOURNAL_EVENT = "aiden:open-work:pending-changed";
export interface PendingOpenWork {
  version: 1;
  botId: string;
  mutation: BotOpenWorkMutation;
  attempts: number;
  createdAt: number;
}

const prefix = (botId: string) => PREFIX + encodeURIComponent(botId) + ":";
const key = (botId: string, mutationId: string) => prefix(botId) + mutationId;
const notify = () => window.dispatchEvent(new Event(OPEN_WORK_JOURNAL_EVENT));

/** Each request has its own key, so two windows cannot overwrite an uncertain request. */
export function pendingOpenWork(botId: string): PendingOpenWork[] {
  const requests: PendingOpenWork[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(prefix(botId))) continue;
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 32 * 1024) throw new Error("A saved Open work change could not be restored. Keep this device's saved data and reload the page.");
    const saved = JSON.parse(raw) as PendingOpenWork;
    if (saved.version !== 1 || saved.botId !== botId || !Number.isSafeInteger(saved.attempts) || saved.attempts < 1
      || !Number.isSafeInteger(saved.createdAt) || saved.createdAt < 0) throw new Error("A saved Open work change could not be restored.");
    const mutation = parseBotOpenWorkMutation(saved.mutation);
    if (storageKey !== key(botId, mutation.mutationId)) throw new Error("A saved Open work change has an invalid identity.");
    requests.push({ ...saved, mutation });
  }
  return requests.sort((a, b) => a.createdAt - b.createdAt || a.mutation.mutationId.localeCompare(b.mutation.mutationId));
}

export function recordOpenWorkAttempt(botId: string, mutation: BotOpenWorkMutation, retry = false): PendingOpenWork {
  const current = pendingOpenWork(botId);
  const previous = current.find((request) => request.mutation.mutationId === mutation.mutationId);
  if (!retry && current.length) throw new Error("Confirm the saved Open work change before making another.");
  if (retry && (!previous || JSON.stringify(previous.mutation) !== JSON.stringify(parseBotOpenWorkMutation(mutation)))) {
    throw new Error("This saved change moved to another window. Reload before retrying.");
  }
  const saved: PendingOpenWork = {
    version: 1, botId, mutation: parseBotOpenWorkMutation(mutation),
    attempts: (previous?.attempts ?? 0) + 1, createdAt: previous?.createdAt ?? Date.now(),
  };
  localStorage.setItem(key(botId, mutation.mutationId), JSON.stringify(saved));
  notify();
  return saved;
}

/** A definitive first rejection may clear only that attempt, never a later retry. */
export function clearOpenWorkPending(request: PendingOpenWork, accepted: boolean): boolean {
  const current = pendingOpenWork(request.botId).find((saved) => saved.mutation.mutationId === request.mutation.mutationId);
  if (!current || JSON.stringify(current.mutation) !== JSON.stringify(request.mutation)
    || !accepted && (request.attempts !== 1 || current.attempts !== request.attempts)) return false;
  localStorage.removeItem(key(request.botId, request.mutation.mutationId));
  notify();
  return true;
}

/** Only host-owned positive receipts settle a lost response; equal content is insufficient. */
export function settleOpenWorkPending(snapshot: BotOpenWorkSnapshot): string[] {
  const resolved: string[] = [];
  for (const request of pendingOpenWork(snapshot.botId)) {
    const mutationId = request.mutation.mutationId;
    const undo = ["add", "edit", "dismiss"].includes(request.mutation.action) && snapshot.undo.some((option) => option.mutationId === mutationId);
    const stop = ["stop", "stop_and_dismiss"].includes(request.mutation.action) && snapshot.items.some((item) => item.lastStop?.mutationId === mutationId
      && ["stopped", "already_finished", "not_running", "blocked"].includes(item.lastStop.state));
    if ((undo || stop) && clearOpenWorkPending(request, true)) resolved.push(mutationId);
  }
  return resolved;
}
