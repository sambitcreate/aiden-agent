import { assertBotCanSavePendingChanges } from "../../lib/bot-local-pending";
import { parseBotResumeAcknowledgement, type BotResumeAcknowledgement } from "../../shared/bot-execution-resume";
import { parseBotRoutineModelId } from "../../shared/bot-routine-models";

export interface BotResumeAttempt {
  version: 1;
  botId: string;
  submissionId: string;
  requestId: string;
  acknowledgement: BotResumeAcknowledgement;
  createdAt: number;
  attempts: number;
}
export const BOT_RESUME_JOURNAL_EVENT = "aiden:bot-resume-pending";
const prefix = (botId: string) => `aiden:bot-resume:pending:${encodeURIComponent(botId)}:`;
const key = (row: BotResumeAttempt) => prefix(row.botId) + row.requestId;
function parse(text: string): BotResumeAttempt {
  if (new TextEncoder().encode(text).length > 8192) throw new Error("The saved Resume request is too large.");
  const row = JSON.parse(text) as BotResumeAttempt;
  if (!row || Object.keys(row).sort().join(",") !== "acknowledgement,attempts,botId,createdAt,requestId,submissionId,version" || row.version !== 1 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.requestId)) throw new Error("The saved Resume request is unreadable.");
  return { ...row, botId: parseBotRoutineModelId(row.botId), submissionId: parseBotRoutineModelId(row.submissionId), acknowledgement: parseBotResumeAcknowledgement(row.acknowledgement) };
}
export function pendingBotResumes(botId: string): BotResumeAttempt[] {
  const rows: BotResumeAttempt[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index); if (!name?.startsWith(prefix(botId))) continue;
    const text = localStorage.getItem(name); if (text === null) continue;
    const row = parse(text);
    if (row.botId !== botId || key(row) !== name || rows.length >= 32) throw new Error("Saved Resume requests need review on this device.");
    rows.push(row);
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}
export function recordBotResume(input: Omit<BotResumeAttempt, "version" | "createdAt" | "attempts">, retry = false): BotResumeAttempt {
  assertBotCanSavePendingChanges(input.botId);
  const rows = pendingBotResumes(input.botId), previous = rows.find((row) => row.requestId === input.requestId);
  if (retry ? !previous || previous.submissionId !== input.submissionId || JSON.stringify(previous.acknowledgement) !== JSON.stringify(input.acknowledgement) : rows.length > 0) throw new Error("Confirm the saved Resume request before starting another.");
  if (previous && (Date.now() < previous.createdAt || Date.now() - previous.createdAt >= 23 * 60 * 60 * 1000)) throw new Error("The saved Resume request is too old to retry safely. Its outcome remains unknown; inspect the computer that runs this Bot.");
  const row = parse(JSON.stringify({ ...input, version: 1, createdAt: previous?.createdAt ?? Date.now(), attempts: (previous?.attempts ?? 0) + 1 }));
  const text = JSON.stringify(row); localStorage.setItem(key(row), text);
  if (localStorage.getItem(key(row)) !== text) throw new Error("This device couldn’t retain the Resume request safely.");
  window.dispatchEvent(new Event(BOT_RESUME_JOURNAL_EVENT));
  return row;
}
export function settleBotResume(row: BotResumeAttempt): void {
  const text = localStorage.getItem(key(row)); if (text === null) return;
  const current = parse(text);
  if (key(current) !== key(row) || current.submissionId !== row.submissionId || JSON.stringify(current.acknowledgement) !== JSON.stringify(row.acknowledgement)) throw new Error("The saved Resume request changed identity.");
  localStorage.removeItem(key(row)); window.dispatchEvent(new Event(BOT_RESUME_JOURNAL_EVENT));
}
