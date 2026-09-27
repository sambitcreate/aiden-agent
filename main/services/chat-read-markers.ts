// Durable "last viewed" markers for honest unread chat rows.
//
// One small main-owned JSON document (userData/chat-read-markers.json) shared
// by the desktop sidebar and every paired Aiden Remote device, so viewing a
// chat on any surface clears its unread marker everywhere. Markers live outside
// the chat payload and index: marking a chat read must never bump its summary
// revision or race a rename/move revision check.

import {
  MAX_CHAT_READ_MARKERS,
  isChatUnread,
  type ChatReadMarkersSnapshot,
} from "../../renderer/shared/chat-row-state.js";
import { DataStore } from "./data-store.js";
import type { Chat, ChatMeta } from "./types.js";

interface ChatReadMarkersFile {
  version: 1;
  /** 0 until the first load stamps the installation baseline. */
  baselineAt: number;
  readThrough: Record<string, number>;
  readThroughSequence?: Record<string, number>;
}

const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeFile(value: unknown): ChatReadMarkersFile {
  const empty: ChatReadMarkersFile = { version: 1, baselineAt: 0, readThrough: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isTimestamp(record.baselineAt)) return empty;
  const readThrough: Record<string, number> = {};
  const raw = record.readThrough;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [chatId, at] of Object.entries(raw as Record<string, unknown>)) {
      if (SAFE_CHAT_ID.test(chatId) && isTimestamp(at)) readThrough[chatId] = at;
    }
  }
  const readThroughSequence: Record<string, number> = {};
  if (typeof record.readThroughSequence === "object" && record.readThroughSequence !== null) {
    for (const [id, sequence] of Object.entries(record.readThroughSequence)) {
      if (Object.prototype.hasOwnProperty.call(readThrough, id) && isTimestamp(sequence))
        readThroughSequence[id] = sequence;
    }
  }
  return { version: 1, baselineAt: record.baselineAt, readThrough, readThroughSequence };
}

/** Keep the newest markers when the bounded map would overflow. */
function pruned(readThrough: Record<string, number>): Record<string, number> {
  const entries = Object.entries(readThrough);
  if (entries.length <= MAX_CHAT_READ_MARKERS) return readThrough;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_CHAT_READ_MARKERS));
}

export class ChatReadMarkerStore {
  private readonly store: DataStore<ChatReadMarkersFile>;
  private revision = 0;
  private ready: Promise<void> | null = null;

  constructor(
    root: () => string,
    private readonly options: {
      now?: () => number;
      onChange?: (snapshot: ChatReadMarkersSnapshot) => void;
    } = {},
  ) {
    this.store = new DataStore<ChatReadMarkersFile>(
      "chat-read-markers.json",
      { version: 1, baselineAt: 0, readThrough: {} },
      root,
      { normalize: normalizeFile, fileMode: 0o600, maxBytes: 2 * 1_024 * 1_024 },
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Stamp the baseline once so pre-existing output never reads as unread. */
  private async initialized(): Promise<void> {
    this.ready ??= (async () => {
      const file = await this.store.load();
      if (file.baselineAt > 0) return;
      const baselineAt = this.now();
      await this.store.update((draft) => {
        if (draft.baselineAt === 0) draft.baselineAt = baselineAt;
      });
    })().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async snapshot(): Promise<ChatReadMarkersSnapshot> {
    await this.initialized();
    const file = await this.store.load();
    return {
      revision: this.revision,
      baselineAt: file.baselineAt,
      readThrough: { ...file.readThrough },
      readThroughSequence: { ...file.readThroughSequence },
    };
  }

  async isUnread(
    meta: Pick<ChatMeta, "id" | "lastAssistantAt" | "lastAssistantSequence">,
  ): Promise<boolean> {
    return isChatUnread(
      meta.lastAssistantAt,
      await this.snapshot(),
      meta.id,
      meta.lastAssistantSequence,
    );
  }

  /**
   * Record that the user viewed a chat through `throughAt`. Markers only move
   * forward, so a late or duplicate report from a slower surface is harmless.
   */
  async markRead(chatId: string, throughAt: number, sequence?: number): Promise<boolean> {
    if (
      !SAFE_CHAT_ID.test(chatId) ||
      !isTimestamp(throughAt) ||
      (sequence !== undefined && !isTimestamp(sequence))
    )
      return false;
    await this.initialized();
    const ahead = (file: ChatReadMarkersFile) => {
      const at = file.readThrough[chatId];
      return (
        at === undefined ||
        throughAt > at ||
        (throughAt === at &&
          sequence !== undefined &&
          sequence > (file.readThroughSequence?.[chatId] ?? -1))
      );
    };
    if (!ahead(await this.store.load())) return false;
    const changed = await this.store.update((draft) => {
      if (!ahead(draft)) return false;
      draft.readThrough = pruned({ ...draft.readThrough, [chatId]: throughAt });
      draft.readThroughSequence ??= {};
      if (sequence !== undefined) draft.readThroughSequence[chatId] = sequence;
      else delete draft.readThroughSequence[chatId];
      for (const id of Object.keys(draft.readThroughSequence)) {
        if (!Object.prototype.hasOwnProperty.call(draft.readThrough, id))
          delete draft.readThroughSequence[id];
      }
      return true;
    });
    if (changed) await this.publish();
    return changed;
  }

  async remove(chatId: string): Promise<void> {
    if ((await this.store.load()).readThrough[chatId] === undefined) return;
    await this.store.update((draft) => {
      delete draft.readThrough[chatId];
      delete draft.readThroughSequence?.[chatId];
    });
    await this.publish();
  }

  private async publish(): Promise<void> {
    this.revision += 1;
    if (!this.options.onChange) return;
    this.options.onChange(await this.snapshot());
  }
}

/**
 * Resolve the "viewed through" time for a chat read report. With a message id
 * the marker lands exactly on what the viewer rendered; without one, it covers
 * the newest visible message persisted right now. Unknown ids resolve to null
 * so a client can never advance the marker past output it never received.
 */
export function chatReadThroughAt(
  chat: Pick<Chat, "messages">,
  throughMessageId?: string,
): number | null {
  const visible = chat.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (throughMessageId !== undefined) {
    const message = visible.find((entry) => entry.id === throughMessageId);
    return message && isTimestamp(message.createdAt) ? message.createdAt : null;
  }
  const latest = visible.reduce<number | null>(
    (max, message) =>
      isTimestamp(message.createdAt) && (max === null || message.createdAt > max)
        ? message.createdAt
        : max,
    null,
  );
  return latest;
}
