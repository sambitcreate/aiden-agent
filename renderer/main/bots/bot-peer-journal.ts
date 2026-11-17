import { assertBotCanSavePendingChanges } from "../../lib/bot-local-pending";
import { parseBotPeerMutation, parseBotPeerStopMutation, type BotPeerExchangeDetail, type BotPeerMutation, type BotPeerSettings, type BotPeerStopMutation } from "../../shared/bot-peers";

export const BOT_PEER_JOURNAL_EVENT = "aiden:bot-peer-pending";
const PREFIX = "aiden:bot-peer:pending:";
const RETRY_MS = 23 * 60 * 60 * 1_000;
type Command = { kind: "settings"; request: BotPeerMutation } | { kind: "stop"; request: BotPeerStopMutation };
export type BotPeerAttempt = Command & { version: 1; createdAt: number; attempts: number };
const prefix = (botId: string) => PREFIX + encodeURIComponent(botId) + ":";
const resource = (command: Command) => command.kind === "settings" ? "settings" : `stop:${encodeURIComponent(command.request.exchangeId)}`;
const key = (command: Command) => prefix(command.request.botId) + resource(command) + ":" + command.request.mutationId;
const notify = () => window.dispatchEvent(new Event(BOT_PEER_JOURNAL_EVENT));

function parse(value: string): BotPeerAttempt {
  if (new TextEncoder().encode(value).byteLength > 20 * 1_024) throw new Error("This device’s saved Bot message control is too large.");
  const row = JSON.parse(value) as BotPeerAttempt;
  if (!row || row.version !== 1 || Object.keys(row).some((name) => !["version", "kind", "request", "createdAt", "attempts"].includes(name))
    || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 1) throw new Error("This device’s saved Bot message control is unreadable.");
  const common = { version: 1 as const, createdAt: row.createdAt, attempts: row.attempts };
  if (row.kind === "settings") return { ...common, kind: row.kind, request: parseBotPeerMutation(row.request) };
  if (row.kind === "stop") return { ...common, kind: row.kind, request: parseBotPeerStopMutation(row.request) };
  throw new Error("This device’s saved Bot message control is unreadable.");
}

/** A separate key per request preserves unknown outcomes across page visits. */
export function pendingBotPeerChanges(botId: string): BotPeerAttempt[] {
  const rows: BotPeerAttempt[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index); if (!name?.startsWith(prefix(botId))) continue;
    const value = localStorage.getItem(name); if (value === null) continue;
    const row = parse(value);
    if (row.request.botId !== botId || key(row) !== name || rows.length >= 129) throw new Error("This device’s saved Bot message controls need review.");
    rows.push(row);
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.request.mutationId.localeCompare(b.request.mutationId));
}

export function recordBotPeerAttempt(command: Command, options: { retry?: boolean; freshExchange?: BotPeerExchangeDetail } = {}): BotPeerAttempt {
  assertBotCanSavePendingChanges(command.request.botId);
  const canonical: Command = command.kind === "settings" ? { kind: "settings", request: parseBotPeerMutation(command.request) } : { kind: "stop", request: parseBotPeerStopMutation(command.request) };
  const existing = pendingBotPeerChanges(canonical.request.botId), previous = existing.find((row) => key(row) === key(canonical));
  if (!previous && existing.length >= 129) throw new Error("This device has too many saved Bot message controls awaiting confirmation.");
  if (options.retry ? !previous || JSON.stringify(previous.request) !== JSON.stringify(canonical.request)
    : existing.some((row) => resource(row) === resource(canonical))) throw new Error("Confirm the saved request for this control first.");
  const now = Date.now();
  if (previous && (now < previous.createdAt || now - previous.createdAt >= RETRY_MS)) {
    const proof = options.freshExchange;
    if (now < previous.createdAt || canonical.kind !== "stop" || !proof || proof.id !== canonical.request.exchangeId
      || (proof.direction === "sent" ? proof.sender : proof.recipient).botId !== canonical.request.botId
      || proof.lastStop?.mutationId !== canonical.request.mutationId || !["requested", "uncertain"].includes(proof.lastStop.state)) throw new Error("This request is too old to retry without a matching pending Stop receipt from the computer. Its outcome remains unconfirmed.");
  }
  const common = { version: 1 as const, createdAt: previous?.createdAt ?? now, attempts: (previous?.attempts ?? 0) + 1 };
  const row = { ...common, ...canonical } as BotPeerAttempt;
  const serialized = JSON.stringify(row); parse(serialized);
  localStorage.setItem(key(row), serialized);
  if (localStorage.getItem(key(row)) !== serialized) throw new Error("This device couldn’t retain the request safely.");
  notify(); return row;
}

export function clearBotPeerAttempt(attempt: BotPeerAttempt, confirmed: boolean): void {
  const value = localStorage.getItem(key(attempt)); if (value === null) return;
  const current = parse(value);
  if (JSON.stringify(current.request) !== JSON.stringify(attempt.request)) throw new Error("The saved request changed on this device.");
  if (!confirmed && (attempt.attempts !== 1 || current.attempts !== 1)) return;
  localStorage.removeItem(key(attempt)); notify();
}

export function settleBotPeerSettings(settings: BotPeerSettings): boolean {
  const match = pendingBotPeerChanges(settings.botId).find((row) => row.kind === "settings" && row.request.mutationId === settings.lastMutationId);
  if (!match) return false;
  clearBotPeerAttempt(match, true); return true;
}

export function settleBotPeerStop(botId: string, exchange: BotPeerExchangeDetail): boolean {
  if ((exchange.direction === "sent" ? exchange.sender : exchange.recipient).botId !== botId || !exchange.lastStop || ["requested", "uncertain"].includes(exchange.lastStop.state)) return false;
  const match = pendingBotPeerChanges(botId).find((row) => row.kind === "stop" && row.request.exchangeId === exchange.id && row.request.mutationId === exchange.lastStop!.mutationId);
  if (!match) return false;
  clearBotPeerAttempt(match, true); return true;
}
