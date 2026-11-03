import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BotOpenWorkItem, BotOpenWorkMutation, BotOpenWorkResult, BotOpenWorkSnapshot, BotOpenWorkSource, BotOpenWorkUndoOption, BotOpenWorkStopReceipt } from "../../../renderer/shared/bot-open-work.js";
import { parseBotOpenWorkMutation, parseBotOpenWorkSnapshot, parseBotOpenWorkResult, parseBotOpenWorkId } from "../../../renderer/shared/bot-open-work.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic, syncDirectory } from "../durable-fs.js";

export const BOT_OPEN_WORK_FILE = "open-work.json";
export const BOT_OPEN_WORK_STORE_LIMITS = { active: 64, terminal: 128, receipts: 512, receiptMs: 86_400_000, publicBytes: 768 * 1024, privateBytes: 8 * 1024 * 1024 } as const;
export interface BotOpenWorkOrigin { source: BotOpenWorkSource; requestId: string; }
type StoredItem = Omit<BotOpenWorkItem, "execution"> & { logicalKey?: string };
interface Receipt {
  mutationId: string; signature: string; itemId: string; expiresAt: number;
  afterRevision: string; before?: StoredItem; undoable: boolean;
  stop?: BotOpenWorkStopReceipt; stopAndDismiss?: boolean;
}
interface State { version: 1; botId: string; revision: string; items: StoredItem[]; receipts: Receipt[]; }
type ErrorCode = Extract<BotOpenWorkResult, { ok: false }>["code"];
class WorkRefusal extends Error { constructor(readonly code: ErrorCode, message: string) { super(message); } }
const active = (item: Pick<StoredItem, "state">) => item.state === "open" || item.state === "waiting";
const pendingStop = (item: StoredItem) => item.lastStop?.state === "requested" || item.lastStop?.state === "uncertain";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function publicItem(item: StoredItem): BotOpenWorkItem {
  const { logicalKey: _key, ...shown } = item;
  return { ...structuredClone(shown), execution: { state: "idle", canStop: false } };
}
function optionsFor(state: State, at: number): BotOpenWorkUndoOption[] {
  return state.receipts.filter((receipt) => receipt.undoable && receipt.expiresAt > at && state.items.some((item) => item.id === receipt.itemId && item.revision === receipt.afterRevision && !pendingStop(item)))
    .map((receipt) => ({ mutationId: receipt.mutationId, itemId: receipt.itemId, expectedRevision: receipt.afterRevision, expiresAt: receipt.expiresAt }));
}
function project(state: State, at: number): BotOpenWorkSnapshot {
  return { botId: state.botId, revision: state.revision, items: state.items.map(publicItem), undo: optionsFor(state, at) };
}
function prune(state: State, at: number): void {
  if (state.items.filter(active).length > BOT_OPEN_WORK_STORE_LIMITS.active) throw new WorkRefusal("active_full", "This Bot already has 64 active work items.");
  const reservations = () => state.receipts.filter((receipt) => receipt.stopAndDismiss && receipt.stop && ["requested", "uncertain"].includes(receipt.stop.state) && state.items.some((item) => item.id === receipt.itemId && active(item))).length;
  while (state.items.filter((item) => !active(item)).length + reservations() > BOT_OPEN_WORK_STORE_LIMITS.terminal) {
    const protectedIds = new Set(optionsFor(state, at).map((option) => option.itemId));
    const oldest = state.items.filter((item) => !active(item) && !pendingStop(item) && !protectedIds.has(item.id)).sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))[0];
    if (!oldest) throw new WorkRefusal("history_full", "Work history is full while Undo or Stop is pending. Try again after those changes expire or settle.");
    state.items = state.items.filter((item) => item.id !== oldest.id);
  }
  if (Buffer.byteLength(JSON.stringify(project(state, at))) > BOT_OPEN_WORK_STORE_LIMITS.publicBytes) throw new WorkRefusal("active_full", "This Bot's work list is full. Shorten or dismiss an item before adding more.");
}
function validToken(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9:_-]+$/u.test(value); }
function parseState(value: unknown, botId: string): State {
  const raw = value as State;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["version", "botId", "revision", "items", "receipts"].includes(key)) || raw.version !== 1 || raw.botId !== botId || !Array.isArray(raw.items) || !Array.isArray(raw.receipts) || raw.receipts.length > BOT_OPEN_WORK_STORE_LIMITS.receipts) throw new Error("Open work storage is invalid.");
  const snapshot = parseBotOpenWorkSnapshot({ botId, revision: raw.revision, items: raw.items.map((item) => ({ ...item, logicalKey: undefined, execution: { state: "idle", canStop: false } })).map(({ logicalKey: _logicalKey, ...item }) => item), undo: [] });
  if (snapshot.items.length !== raw.items.length || raw.items.some((item) => "execution" in item) || raw.items.some((item) => item.logicalKey !== undefined && !/^[a-f0-9]{64}$/u.test(item.logicalKey))) throw new Error("Open work storage has an invalid logical identity.");
  if (snapshot.items.filter(active).length > 64 || snapshot.items.filter((item) => !active(item)).length > 128) throw new Error("Open work storage exceeds its item limits.");
  const ids = new Set<string>();
  for (const receipt of raw.receipts) {
    if (!receipt || typeof receipt !== "object" || Object.keys(receipt).some((key) => !["mutationId", "signature", "itemId", "expiresAt", "afterRevision", "before", "undoable", "stop", "stopAndDismiss"].includes(key)) || !validToken(receipt.mutationId) || ids.has(receipt.mutationId) || !/^[a-f0-9]{64}$/u.test(receipt.signature) || !validToken(receipt.itemId) || !validToken(receipt.afterRevision) || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt < 0 || typeof receipt.undoable !== "boolean" || (receipt.stopAndDismiss !== undefined && typeof receipt.stopAndDismiss !== "boolean")) throw new Error("Open work storage has an invalid mutation receipt.");
    ids.add(receipt.mutationId);
    parseBotOpenWorkId(receipt.itemId); parseBotOpenWorkId(receipt.afterRevision);
    parseBotOpenWorkResult({ ok: true, mutationId: receipt.mutationId, replayed: true, snapshot: { botId, revision: raw.revision, items: [], undo: [] }, ...(receipt.stop ? { stop: receipt.stop } : {}) });
    if (receipt.before) parseBotOpenWorkSnapshot({ botId, revision: raw.revision, items: [publicItem(receipt.before)], undo: [] });
    if (receipt.stop) {
      const item = snapshot.items.find((candidate) => candidate.id === receipt.itemId);
      if (item) parseBotOpenWorkSnapshot({ botId, revision: raw.revision, items: [{ ...item, lastStop: receipt.stop }], undo: [] });
      if (receipt.stop.mutationId !== receipt.mutationId || ["requested", "uncertain"].includes(receipt.stop.state) && (!item || item.revision !== receipt.afterRevision || JSON.stringify(item.lastStop) !== JSON.stringify(receipt.stop))) throw new Error("Open work storage has an invalid stop receipt.");
    }
  }
  if (raw.items.some((item) => pendingStop(item) && !raw.receipts.some((receipt) => receipt.mutationId === item.lastStop?.mutationId && receipt.itemId === item.id && receipt.stop && ["requested", "uncertain"].includes(receipt.stop.state)))) throw new Error("Open work storage lost a pending Stop receipt.");
  return structuredClone(raw);
}

export interface BotOpenWorkStoreOptions {
  profileDir(): string;
  botExists(botId: string): Promise<boolean>;
  now?(): number;
  id?(): string;
  /** Test-only barrier at the actual durable publication fence. */
  beforePublish?(botId: string): Promise<void>;
}
export function createBotOpenWorkStore(ports: BotOpenWorkStoreOptions) {
  const serial = createKeyedSerial();
  const deleted = new Set<string>();
  const now = ports.now ?? Date.now, id = ports.id ?? randomUUID;
  const fileOf = (botId: string) => path.join(botSessionDirectory(ports.profileDir(), botId), BOT_OPEN_WORK_FILE);
  async function assertCurrent(botId: string) {
    if (deleted.has(botId) || !await ports.botExists(botId)) throw new WorkRefusal("deleted", "This Bot is no longer available.");
  }
  async function load(botId: string): Promise<State> {
    await assertCurrent(botId);
    try {
      const file = fileOf(botId), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BOT_OPEN_WORK_STORE_LIMITS.privateBytes) throw new Error("Open work storage is unavailable.");
      return parseState(JSON.parse(await fs.readFile(file, "utf8")), botId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, botId, revision: `ow_${digest({ botId, empty: true }).slice(0, 32)}`, items: [], receipts: [] };
      throw error;
    }
  }
  async function save(state: State) {
    await assertCurrent(state.botId);
    if (Buffer.byteLength(JSON.stringify(state)) > BOT_OPEN_WORK_STORE_LIMITS.privateBytes) throw new WorkRefusal("receipts_full", "Open work history is full until its retry records expire.");
    await writeJsonAtomic(fileOf(state.botId), state, { mode: 0o600, mkdirMode: 0o700, beforePublish: async () => { await ports.beforePublish?.(state.botId); await assertCurrent(state.botId); } });
  }
  function result(state: State, receipt: Receipt, replayed: boolean): BotOpenWorkResult {
    const snapshot = project(state, now()), undo = snapshot.undo.find((option) => option.mutationId === receipt.mutationId);
    return { ok: true, mutationId: receipt.mutationId, replayed, itemId: receipt.itemId, snapshot, ...(undo ? { undo } : {}), ...(receipt.stop ? { stop: structuredClone(receipt.stop) } : {}) };
  }
  async function operate(botId: string, input: BotOpenWorkMutation, actor: "person" | "bot", origin?: BotOpenWorkOrigin): Promise<BotOpenWorkResult> {
    let current: State | undefined;
    let admittedSignature: string | undefined;
    try {
      const command = parseBotOpenWorkMutation(input);
      current = await load(botId);
      const signature = digest(canonical({ command, actor, origin })); admittedSignature = signature;
      const old = current.receipts.find((receipt) => receipt.mutationId === command.mutationId);
      if (old) {
        if (old.signature !== signature) throw new WorkRefusal("mutation_conflict", "That mutation identity belongs to another change.");
        return result(current, old, true);
      }
      const at = now(), next = structuredClone(current);
      next.receipts = next.receipts.filter((receipt) => receipt.expiresAt > at || receipt.stop?.state === "requested" || receipt.stop?.state === "uncertain");
      if (next.receipts.length >= BOT_OPEN_WORK_STORE_LIMITS.receipts) throw new WorkRefusal("receipts_full", "Too many work changes are waiting for their retry window to expire.");
      let item: StoredItem, before: StoredItem | undefined;
      if (command.action === "add") {
        if (command.expectedRevision !== current.revision) throw new WorkRefusal("stale", "Open work changed. Review the current list and try again.");
        const logicalKey = origin && digest(canonical({ source: origin.source, title: command.title.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase() }));
        const existing = logicalKey ? next.items.find((candidate) => candidate.logicalKey === logicalKey) : undefined;
        if (existing) {
          const receipt: Receipt = { mutationId: command.mutationId, signature, itemId: existing.id, expiresAt: at + BOT_OPEN_WORK_STORE_LIMITS.receiptMs, afterRevision: existing.revision, undoable: false };
          next.receipts.push(receipt); next.revision = id(); await save(next); return result(next, receipt, false);
        }
        item = { id: id(), revision: id(), title: command.title, note: command.note ?? "", state: "open", createdAt: at, updatedAt: at, source: origin?.source ?? { kind: "person" }, links: origin?.source.submissionId && origin.source.entryId ? [{ kind: "source", submissionId: origin.source.submissionId, entryId: origin.source.entryId }] : [], ...(logicalKey ? { logicalKey } : {}) };
        if (origin?.source.kind === "routine") item.links.push({ kind: "routine", routineId: origin.source.routineId, runId: origin.source.runId });
        next.items.push(item);
      } else if (command.action === "undo") {
        const undone = current.receipts.find((receipt) => receipt.mutationId === command.undoOf);
        if (!undone || !undone.undoable) throw new WorkRefusal("undo_expired", "This change can no longer be undone.");
        if (undone.expiresAt <= at) throw new WorkRefusal("undo_expired", "This change's Undo window expired.");
        const index = next.items.findIndex((candidate) => candidate.id === undone.itemId);
        if (index < 0 || next.items[index]!.revision !== undone.afterRevision || command.expectedRevision !== undone.afterRevision || pendingStop(next.items[index]!)) throw new WorkRefusal("undo_conflict", "This item changed after that action. Undo would overwrite a later change.");
        item = undone.before ? structuredClone(undone.before) : { ...next.items[index]!, state: "dismissed" };
        if (item.state !== "waiting") delete item.waitingReason;
        if (item.state !== "done") delete item.completion;
        item.revision = id(); item.updatedAt = at; next.items[index] = item;
      } else {
        const found = next.items.find((candidate) => candidate.id === command.id);
        if (!found) throw new WorkRefusal("not_found", "This work item is no longer available.");
        if (found.revision !== command.expectedRevision) throw new WorkRefusal("stale", "This work item changed. Review it and try again.");
        if (pendingStop(found)) throw new WorkRefusal("unavailable", "This item's Stop is still being confirmed. Retry that action first.");
        item = found; before = structuredClone(item);
        if (command.action === "edit") Object.assign(item, command.patch);
        if (command.action === "dismiss") item.state = "dismissed";
        if (command.action === "stop" || command.action === "stop_and_dismiss") item.lastStop = { mutationId: command.mutationId, state: "requested", requestedAt: at };
        if (item.state !== "waiting") delete item.waitingReason;
        if (item.state === "waiting" && !item.waitingReason?.trim()) throw new WorkRefusal("invalid", "Say what this work is waiting for.");
        if (item.state === "done" && before.state !== "done") item.completion = { by: actor, at };
        if (item.state !== "done") delete item.completion;
        item.revision = id(); item.updatedAt = at;
      }
      const stopping = command.action === "stop" || command.action === "stop_and_dismiss";
      const receipt: Receipt = { mutationId: command.mutationId, signature, itemId: item.id, expiresAt: at + BOT_OPEN_WORK_STORE_LIMITS.receiptMs, afterRevision: item.revision, ...(before && !stopping ? { before } : {}), undoable: command.action !== "undo" && !stopping, ...(stopping ? { stop: item.lastStop, stopAndDismiss: command.action === "stop_and_dismiss" } : {}) };
      next.receipts.push(receipt); next.revision = id(); prune(next, at);
      // Reuse the exact public validator for accepted content, sources and limits.
      parseBotOpenWorkSnapshot(project(next, at));
      await save(next); return result(next, receipt, false);
    } catch (error) {
      if (error instanceof WorkRefusal) return { ok: false, code: error.code, error: error.message, ...(current ? { snapshot: project(current, now()) } : {}) };
      if (admittedSignature) {
        try {
          const observed = await load(botId);
          const receipt = observed.receipts.find((candidate) => candidate.mutationId === input.mutationId && candidate.signature === admittedSignature);
          if (receipt) return result(observed, receipt, false);
        } catch { /* Keep the uncertain original error; never replace unreadable work with empty state. */ }
      }
      throw error;
    }
  }
  return {
    snapshot: (botId: string) => serial(botId, async () => project(await load(botId), now())),
    mutate: (botId: string, command: BotOpenWorkMutation, actor: "person" | "bot" = "person", origin?: BotOpenWorkOrigin) => serial(botId, () => operate(botId, command, actor, origin)),
    acknowledgeStop: (botId: string, mutationId: string, outcome: Pick<BotOpenWorkStopReceipt, "state" | "reason">) => serial(botId, async (): Promise<BotOpenWorkResult> => {
      const state = await load(botId), receipt = state.receipts.find((candidate) => candidate.mutationId === mutationId);
      if (!receipt?.stop) return { ok: false, code: "not_found", error: "This Stop is no longer available.", snapshot: project(state, now()) };
      if (receipt.stop.state !== "requested" && receipt.stop.state !== "uncertain") return result(state, receipt, true);
      const item = state.items.find((candidate) => candidate.id === receipt.itemId);
      if (!item || item.revision !== receipt.afterRevision || item.lastStop?.mutationId !== mutationId) return { ok: false, code: "stale", error: "The work item changed before Stop was confirmed.", snapshot: project(state, now()) };
      const at = now();
      receipt.stop = { ...receipt.stop, ...outcome, ...(outcome.state !== "uncertain" && outcome.state !== "requested" ? { finishedAt: at } : {}) };
      item.lastStop = structuredClone(receipt.stop);
      if (receipt.stopAndDismiss && ["stopped", "already_finished", "not_running"].includes(outcome.state)) { item.state = "dismissed"; delete item.waitingReason; delete item.completion; }
      item.revision = id(); item.updatedAt = at; receipt.afterRevision = item.revision; state.revision = id(); prune(state, at); await save(state); return result(state, receipt, false);
    }),
    forgetBot(botId: string): Promise<void> {
      deleted.add(botId);
      return serial(botId, async () => { const file = fileOf(botId); await fs.rm(file, { force: true }); await syncDirectory(path.dirname(file)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); });
    },
  };
}
export type BotOpenWorkStore = ReturnType<typeof createBotOpenWorkStore>;
