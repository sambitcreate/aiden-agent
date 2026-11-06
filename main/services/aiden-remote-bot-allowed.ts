import { randomBytes } from "node:crypto";
import type { BotAllowedEntry } from "../../renderer/shared/tool-approval-scope.js";
import { withoutBotHandoffControls } from "../../renderer/shared/bot-handoffs.js";
import type { BotAllowList } from "./bot-runtime/bot-allow-list.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE,
  parseAidenRemoteBotAllowedCursor,
  parseAidenRemoteBotAllowedEntryId,
  parseAidenRemoteBotAllowedList,
  type AidenRemoteBotAllowedEntry,
  type AidenRemoteBotAllowedList,
} from "./aiden-remote-protocol.js";

const SNAPSHOT_TTL_MS = 120_000;
const MAX_SNAPSHOTS = 64;
const MAX_DEVICE_SNAPSHOTS = 4;
const MAX_SNAPSHOT_BYTES = 8 * 1_024 * 1_024;
interface Snapshot {
  deviceId: string;
  botId: string;
  entries: AidenRemoteBotAllowedEntry[];
  expiresAt: number;
  bytes: number;
  cursors: Map<number, string>;
}
interface Cursor { snapshot: Snapshot; offset: number }
export interface AidenRemoteBotAllowList {
  list(deviceId: string, botId: string, cursor?: string): Promise<AidenRemoteBotAllowedList>;
  remove(deviceId: string, botId: string, entryId: string): Promise<AidenRemoteBotAllowedList>;
}
function display(value: string): string {
  const text = withoutBotHandoffControls(value)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "�")
    .replace(/\b(?:sk|pk|rk|xox[abpr]|gh[pousr]|AIza)[-_A-Za-z0-9]{12,}/gu, "[redacted]")
    .replace(/\s+/gu, " ").trim();
  const points = [...text];
  return points.length > 200 ? `${points.slice(0, 199).join("")}…` : text;
}
function project(entry: BotAllowedEntry): AidenRemoteBotAllowedEntry {
  const base = { id: entry.id, what: display(entry.what), addedAt: entry.createdAt };
  return entry.kind === "folder" ? { ...base, kind: "folder" } : {
    ...base, kind: "rule", uses: entry.uses,
    ...(entry.uses > 0 && entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
  };
}

/** The cache holds display snapshots, never permission or publication receipts. */
export function createAidenRemoteBotAllowList(deps: {
  allowed: Pick<BotAllowList, "list" | "remove">;
  botExists(botId: string): Promise<boolean>;
  now?(): number;
}): AidenRemoteBotAllowList {
  const snapshots = new Set<Snapshot>();
  const cursors = new Map<string, Cursor>();
  const lanes = new Map<string, Promise<void>>();
  let heldBytes = 0, observedTime = 0;
  const now = () => {
    const value = deps.now?.() ?? Date.now();
    if (!Number.isFinite(value)) throw new AidenRemoteServiceError("internal_error", "The allow list clock is unavailable.", 500);
    observedTime = Math.max(observedTime, value); return observedTime;
  };
  function forget(snapshot: Snapshot) {
    if (!snapshots.delete(snapshot)) return;
    heldBytes -= snapshot.bytes;
    for (const token of snapshot.cursors.values()) cursors.delete(token);
  }
  function prune() { const time = now(); for (const snapshot of snapshots) if (snapshot.expiresAt <= time) forget(snapshot); }
  function invalidate(deviceId: string, botId: string) {
    for (const snapshot of snapshots) if (snapshot.deviceId === deviceId && snapshot.botId === botId) forget(snapshot);
  }
  async function known(botId: string) {
    if (!await deps.botExists(botId)) throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
  }
  function serial<T>(botId: string, action: () => Promise<T>): Promise<T> {
    const result = (lanes.get(botId) ?? Promise.resolve()).then(action);
    const settled = result.then(() => {}, () => {});
    lanes.set(botId, settled);
    void settled.then(() => { if (lanes.get(botId) === settled) lanes.delete(botId); });
    return result;
  }
  const invalidCursor = () => new AidenRemoteServiceError("invalid_request", "This allow list cursor is invalid or expired. Refresh the list.", 400, true);
  function page(snapshot: Snapshot, offset: number): AidenRemoteBotAllowedList {
    const entries = snapshot.entries.slice(offset, offset + AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE);
    const next = offset + entries.length;
    let nextCursor: string | undefined;
    if (next < snapshot.entries.length) {
      nextCursor = snapshot.cursors.get(next);
      if (!nextCursor) {
        do { nextCursor = `cur_${randomBytes(32).toString("base64url")}`; } while (cursors.has(nextCursor));
        snapshot.cursors.set(next, nextCursor); cursors.set(nextCursor, { snapshot, offset: next });
      }
    }
    return parseAidenRemoteBotAllowedList({ botId: snapshot.botId, entries, ...(nextCursor ? { nextCursor } : {}) });
  }
  async function capture(deviceId: string, botId: string): Promise<AidenRemoteBotAllowedList> {
    const source = await deps.allowed.list(botId);
    // Check again after the await: a deleted Bot cannot publish a cached view.
    await known(botId);
    if (source.some(row => row.botId !== botId)) throw new AidenRemoteServiceError("internal_error", "The allow list could not be read.", 500);
    const entries = source.map(project).sort((a, b) => b.addedAt < a.addedAt ? -1 : b.addedAt > a.addedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new AidenRemoteServiceError("internal_error", "The allow list could not be read.", 500);
    // Include space for the bounded cursor index, not just row text.
    const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8") + Math.ceil(entries.length / AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE) * 128;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new AidenRemoteServiceError("payload_too_large", "This complete allow list is too large to review remotely.", 413);
    // Validate every row before exposing the first page, including later pages.
    for (let offset = 0; offset < entries.length; offset += AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE) {
      parseAidenRemoteBotAllowedList({ botId, entries: entries.slice(offset, offset + AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE) });
    }
    const snapshot: Snapshot = { deviceId, botId, entries, bytes, expiresAt: now() + SNAPSHOT_TTL_MS, cursors: new Map() };
    if (entries.length > AIDEN_REMOTE_BOT_ALLOWED_PAGE_SIZE) {
      prune();
      const owned = [...snapshots].filter(s => s.deviceId === deviceId);
      while (owned.length >= MAX_DEVICE_SNAPSHOTS) forget(owned.shift()!);
      while (snapshots.size >= MAX_SNAPSHOTS || heldBytes + bytes > MAX_SNAPSHOT_BYTES) forget(snapshots.values().next().value!);
      snapshots.add(snapshot); heldBytes += bytes;
    }
    return page(snapshot, 0);
  }
  return {
    list(deviceId, botId, cursor) {
      return serial(botId, async () => {
        prune(); await known(botId);
        if (cursor === undefined) return capture(deviceId, botId);
        try { parseAidenRemoteBotAllowedCursor(cursor); } catch { throw invalidCursor(); }
        const record = cursors.get(cursor);
        if (!record || record.snapshot.deviceId !== deviceId || record.snapshot.botId !== botId || record.snapshot.expiresAt <= now()) throw invalidCursor();
        return page(record.snapshot, record.offset);
      });
    },
    remove(deviceId, botId, entryId) {
      return serial(botId, async () => {
        await known(botId);
        try { parseAidenRemoteBotAllowedEntryId(entryId); } catch { throw new AidenRemoteServiceError("invalid_request", "This allow list entry is invalid.", 400); }
        await deps.allowed.remove(botId, entryId);
        // A no-op Remove also starts a new review. Invalidate before its awaited capture.
        invalidate(deviceId, botId);
        return capture(deviceId, botId);
      });
    },
  };
}
