import { assertBotCanSavePendingChanges } from "../../lib/bot-local-pending";
import { parseBotRoutineModelSave, type BotRoutineModelSave } from "../../shared/bot-routine-models";

export interface PendingRoutineModelChange { version: 1; createdAt: number; attempts: number; request: BotRoutineModelSave }
export const ROUTINE_MODEL_JOURNAL_EVENT = "aiden:routine-model-pending";
const prefix = (botId: string, routineId: string) => `aiden:routine-model:pending:${encodeURIComponent(botId)}:${encodeURIComponent(routineId)}:`;
const key = (row: PendingRoutineModelChange) => prefix(row.request.botId, row.request.routineId) + row.request.mutationId;
function parse(text: string): PendingRoutineModelChange {
  if (new TextEncoder().encode(text).byteLength > 16 * 1024) throw new Error("This device’s saved model change is too large.");
  const row = JSON.parse(text) as PendingRoutineModelChange;
  if (!row || row.version !== 1 || Object.keys(row).some((name) => !["version", "createdAt", "attempts", "request"].includes(name)) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 1) throw new Error("This device’s saved model change is unreadable.");
  return { version: 1, createdAt: row.createdAt, attempts: row.attempts, request: parseBotRoutineModelSave(row.request) };
}
export function pendingRoutineModelChanges(botId: string, routineId: string): PendingRoutineModelChange[] {
  const expected = prefix(botId, routineId), result: PendingRoutineModelChange[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index); if (!name?.startsWith(expected)) continue;
    const saved = localStorage.getItem(name); if (saved === null) continue;
    const row = parse(saved);
    if (row.request.botId !== botId || row.request.routineId !== routineId || key(row) !== name || result.length >= 32) throw new Error("This device’s saved model changes need review.");
    result.push(row);
  }
  return result.sort((a, b) => a.createdAt - b.createdAt);
}
export function recordRoutineModelAttempt(request: BotRoutineModelSave, retry = false): PendingRoutineModelChange {
  assertBotCanSavePendingChanges(request.botId);
  request = parseBotRoutineModelSave(request);
  const existing = pendingRoutineModelChanges(request.botId, request.routineId);
  const previous = existing.find((row) => row.request.mutationId === request.mutationId);
  if (retry ? !previous || JSON.stringify(previous.request) !== JSON.stringify(request) : existing.length > 0) throw new Error("Confirm the device’s saved model change first.");
  if (previous && Date.now() - previous.createdAt >= 23 * 60 * 60 * 1000) throw new Error("This change is too old to retry safely. Its outcome remains unconfirmed; keep its details for review on the owning computer.");
  const row: PendingRoutineModelChange = { version: 1, createdAt: previous?.createdAt ?? Date.now(), attempts: (previous?.attempts ?? 0) + 1, request };
  const serialized = JSON.stringify(row); parse(serialized); localStorage.setItem(key(row), serialized);
  if (localStorage.getItem(key(row)) !== serialized) throw new Error("This device couldn’t retain the model change safely.");
  window.dispatchEvent(new Event(ROUTINE_MODEL_JOURNAL_EVENT)); return row;
}
export function clearRoutineModelAttempt(row: PendingRoutineModelChange, accepted: boolean): void {
  const saved = localStorage.getItem(key(row)); if (saved === null) return;
  const current = parse(saved);
  if (JSON.stringify(current.request) !== JSON.stringify(row.request)) throw new Error("The saved model change identity changed.");
  if (!accepted && (row.attempts !== 1 || current.attempts !== 1)) return;
  localStorage.removeItem(key(row)); window.dispatchEvent(new Event(ROUTINE_MODEL_JOURNAL_EVENT));
}
