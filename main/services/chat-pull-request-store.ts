// Durable chat ↔ pull request relationships.
//
// One small JSON document per chat under userData/chat-pull-requests/<chat-id>.json.
// Links live outside the chat transcript payload so linking/unlinking never
// rewrites a growing message history. All writes go through DataStore, which
// stages and atomically publishes replacements; a corrupt file is preserved
// rather than overwritten.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHAT_PULL_REQUEST_SCHEMA_VERSION,
  MAX_CHAT_PULL_REQUEST_LINKS,
  isSafeChatPullRequestChatId,
  normalizeChatPullRequestCreateIntent,
  normalizeChatPullRequestLink,
  normalizeChatPullRequestSnapshot,
  pullRequestRefKey,
  type ChatPullRequestCreateIntent,
  type ChatPullRequestLink,
  type ChatPullRequestRef,
  type ChatPullRequestSnapshot,
} from "../../renderer/shared/chat-pull-requests.js";
import { DataStore } from "./data-store.js";

const MAX_FILE_BYTES = 256 * 1_024;
const MAX_PENDING_CREATES = 16;

export interface ChatPullRequestFile {
  schemaVersion: 1;
  chatId: string;
  links: ChatPullRequestLink[];
  /**
   * Durable intents for `gh pr create` calls whose remote outcome is unknown.
   * Recorded before the CLI runs so a crash cannot turn a created PR into a
   * blind duplicate retry.
   */
  pendingCreates: ChatPullRequestCreateIntent[];
}

function emptyFile(chatId: string): ChatPullRequestFile {
  return { schemaVersion: CHAT_PULL_REQUEST_SCHEMA_VERSION, chatId, links: [], pendingCreates: [] };
}

function normalizeFile(chatId: string) {
  return (value: unknown): ChatPullRequestFile => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return emptyFile(chatId);
    }
    const record = value as Record<string, unknown>;
    // A file renamed between chats must not leak another chat's links.
    if (record.chatId !== chatId) return emptyFile(chatId);
    const rawLinks = Array.isArray(record.links) ? record.links : [];
    const deduped = new Map<string, ChatPullRequestLink>();
    for (const raw of rawLinks) {
      const link = normalizeChatPullRequestLink(raw);
      if (!link) continue;
      if (deduped.has(pullRequestRefKey(link))) continue;
      if (deduped.size >= MAX_CHAT_PULL_REQUEST_LINKS) break;
      deduped.set(pullRequestRefKey(link), link);
    }
    const rawPending = Array.isArray(record.pendingCreates) ? record.pendingCreates : [];
    const pending = new Map<string, ChatPullRequestCreateIntent>();
    for (const raw of rawPending) {
      const intent = normalizeChatPullRequestCreateIntent(raw);
      if (!intent || pending.has(intent.operationId)) continue;
      if (pending.size >= MAX_PENDING_CREATES) break;
      pending.set(intent.operationId, intent);
    }
    return {
      schemaVersion: CHAT_PULL_REQUEST_SCHEMA_VERSION,
      chatId,
      links: [...deduped.values()],
      pendingCreates: [...pending.values()],
    };
  };
}

function isSafeFile(chatId: string) {
  return (value: unknown): boolean => {
    const record = value as Record<string, unknown> | null;
    return (
      typeof record === "object" &&
      record !== null &&
      record.schemaVersion === CHAT_PULL_REQUEST_SCHEMA_VERSION &&
      record.chatId === chatId &&
      Array.isArray(record.links) &&
      (record.pendingCreates === undefined || Array.isArray(record.pendingCreates))
    );
  };
}

export class ChatPullRequestStore {
  private readonly stores = new Map<string, DataStore<ChatPullRequestFile>>();

  constructor(private readonly root: () => string) {}

  async list(chatId: string): Promise<ChatPullRequestLink[]> {
    const file = await this.store(chatId).load();
    return file.links.map((link) => structuredClone(link));
  }

  async get(chatId: string, ref: ChatPullRequestRef): Promise<ChatPullRequestLink | undefined> {
    const key = pullRequestRefKey(ref);
    const file = await this.store(chatId).load();
    const found = file.links.find((link) => pullRequestRefKey(link) === key);
    return found ? structuredClone(found) : undefined;
  }

  /**
   * Insert or refresh a link. Deduplicates on (host, repository, number): a
   * re-link keeps the original `linkedAt` and merges the freshest snapshot.
   */
  async link(chatId: string, link: ChatPullRequestLink): Promise<ChatPullRequestLink> {
    const normalized = normalizeChatPullRequestLink(link);
    if (!normalized) throw new Error("The pull request link is invalid.");
    return this.store(chatId).update((file) => {
      const key = pullRequestRefKey(normalized);
      const existing = file.links.find((entry) => pullRequestRefKey(entry) === key);
      if (existing) {
        existing.url = normalized.url;
        existing.source = normalized.source;
        if (normalized.snapshot) existing.snapshot = normalized.snapshot;
        return structuredClone(existing);
      }
      if (file.links.length >= MAX_CHAT_PULL_REQUEST_LINKS) {
        throw new Error("This chat already has the maximum number of linked pull requests.");
      }
      file.links.push(normalized);
      return structuredClone(normalized);
    });
  }

  async unlink(chatId: string, ref: ChatPullRequestRef): Promise<boolean> {
    const key = pullRequestRefKey(ref);
    return this.store(chatId).update((file) => {
      const next = file.links.filter((entry) => pullRequestRefKey(entry) !== key);
      if (next.length === file.links.length) return false;
      file.links = next;
      return true;
    });
  }

  async updateSnapshot(
    chatId: string,
    ref: ChatPullRequestRef,
    snapshot: ChatPullRequestSnapshot,
  ): Promise<ChatPullRequestLink | undefined> {
    const normalized = normalizeChatPullRequestSnapshot(snapshot);
    if (!normalized) throw new Error("The pull request snapshot is invalid.");
    const key = pullRequestRefKey(ref);
    return this.store(chatId).update((file) => {
      const existing = file.links.find((entry) => pullRequestRefKey(entry) === key);
      if (!existing) return undefined;
      existing.snapshot = normalized;
      return structuredClone(existing);
    });
  }

  /** Persist create intent before `gh pr create` runs; survives a crash. */
  async recordCreateIntent(chatId: string, intent: ChatPullRequestCreateIntent): Promise<void> {
    const normalized = normalizeChatPullRequestCreateIntent(intent);
    if (!normalized) throw new Error("The pull request creation intent is invalid.");
    await this.store(chatId).update((file) => {
      file.pendingCreates = file.pendingCreates.filter(
        (entry) => entry.operationId !== normalized.operationId,
      );
      // Never evict: a dropped intent is a remote create we may have to
      // reconcile. At capacity the caller must resolve the backlog first.
      if (file.pendingCreates.length >= MAX_PENDING_CREATES) {
        throw new Error(
          "This chat has too many unresolved pull request creations. Resolve or clear them before creating another.",
        );
      }
      file.pendingCreates.push(normalized);
      return undefined;
    });
  }

  async listCreateIntents(chatId: string): Promise<ChatPullRequestCreateIntent[]> {
    const file = await this.store(chatId).load();
    return file.pendingCreates.map((intent) => structuredClone(intent));
  }

  /** Drop the intent once its outcome is known (linked, retried, or resolved). */
  async clearCreateIntent(chatId: string, operationId: string): Promise<void> {
    await this.store(chatId).update((file) => {
      file.pendingCreates = file.pendingCreates.filter(
        (entry) => entry.operationId !== operationId,
      );
      return undefined;
    });
  }

  /**
   * Remove every link for a chat. Local files only — unlinking/deleting never
   * touches GitHub. Missing files are fine.
   */
  async deleteChat(chatId: string): Promise<void> {
    if (!isSafeChatPullRequestChatId(chatId)) throw new Error("Invalid chat id.");
    this.stores.delete(chatId);
    await fs.rm(path.join(this.root(), `${chatId}.json`), { force: true });
  }

  private store(chatId: string): DataStore<ChatPullRequestFile> {
    if (!isSafeChatPullRequestChatId(chatId)) throw new Error("Invalid chat id.");
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const created = new DataStore<ChatPullRequestFile>(
      `${chatId}.json`,
      emptyFile(chatId),
      this.root,
      {
        maxBytes: MAX_FILE_BYTES,
        fileMode: 0o600,
        preserveCorruptFile: true,
        normalize: normalizeFile(chatId),
        isSafe: isSafeFile(chatId),
      },
    );
    this.stores.set(chatId, created);
    return created;
  }
}
