// Chat history persistence: an index.json of metadata + one file per chat.
// Every read-modify-write operation is serialized because all chats share the
// same index file and background title generation can overlap message writes.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CHAT_TITLE,
  isDefaultChatTitle,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
} from "./chat-title-policy.js";
import type { Chat, ChatMessage, ChatMeta } from "./types.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import { parseSubagentMessageReferenceV1 } from "../../renderer/shared/subagent-runs.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";

const INDEX = "index.json";
const DEFAULT_WORKSPACE_ID = "default";
const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]+$/u;
const CHAT_DELETE_STAGING =
  /^\.index\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.chat-delete\.tmp$/u;
const INDEX_WRITE_STAGING =
  /^\.index\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.index-write\.tmp$/u;
const CHAT_WRITE_STAGING =
  /^\.[A-Za-z0-9._:-]+\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.chat-write\.tmp$/u;
const CHAT_TRANSACTION = /^\.chat-transaction\.([A-Za-z0-9._:-]+)\.pending$/u;

async function syncPath(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface ChatStoreDurability {
  readFile?: (target: string) => Promise<string>;
  syncDirectory?: (target: string) => Promise<void>;
  syncFile?: (target: string) => Promise<void>;
}

export function createChatStore(
  resolveChatsDir: () => Promise<string>,
  resolveProviderId: (providerId: string | undefined) => Promise<string | undefined> = async (
    providerId,
  ) => migrateLegacyPiProviderId(providerId),
  durability: ChatStoreDurability = {},
) {
  let operationTail: Promise<void> = Promise.resolve();
  const syncDirectory = durability.syncDirectory ?? syncPath;
  const syncFile = durability.syncFile ?? syncPath;
  const readFile =
    durability.readFile ??
    (async (target: string) => {
      const contents = await fs.readFile(target, "utf-8");
      recordDiagnosticCounter("filesystem:read", {
        bytesOut: Buffer.byteLength(contents, "utf8"),
      });
      return contents;
    });
  let pendingDirectorySync: string | undefined;

  async function syncDirectoryDurably(directory: string): Promise<void> {
    pendingDirectorySync = directory;
    await syncDirectory(directory);
    pendingDirectorySync = undefined;
  }

  async function retryPendingDirectorySync(): Promise<void> {
    if (!pendingDirectorySync) return;
    await syncDirectory(pendingDirectorySync);
    pendingDirectorySync = undefined;
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      await retryPendingDirectorySync();
      await reconcileChatTransactions();
      return operation();
    };
    const result = operationTail.then(guarded, guarded);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function indexPath(): Promise<string> {
    return path.join(await resolveChatsDir(), INDEX);
  }

  async function chatPath(id: string): Promise<string> {
    if (
      id.length === 0 ||
      id.length > 160 ||
      id.normalize("NFKC") !== id ||
      !SAFE_CHAT_ID.test(id)
    ) {
      throw new Error("Invalid chat id.");
    }
    return path.join(await resolveChatsDir(), `${id}.json`);
  }

  async function transactionPath(id: string): Promise<string> {
    const payload = await chatPath(id);
    return path.join(path.dirname(payload), `.chat-transaction.${id}.pending`);
  }

  function isValidMeta(value: unknown): value is ChatMeta {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const meta = value as Record<string, unknown>;
    return (
      typeof meta.id === "string" &&
      meta.id.length > 0 &&
      meta.id.length <= 160 &&
      meta.id.normalize("NFKC") === meta.id &&
      SAFE_CHAT_ID.test(meta.id) &&
      typeof meta.title === "string" &&
      typeof meta.createdAt === "number" &&
      Number.isFinite(meta.createdAt) &&
      typeof meta.updatedAt === "number" &&
      Number.isFinite(meta.updatedAt) &&
      (meta.workspaceId === undefined || typeof meta.workspaceId === "string") &&
      (meta.providerId === undefined || typeof meta.providerId === "string") &&
      (meta.model === undefined || typeof meta.model === "string")
    );
  }

  async function removeCrashLeftStages(directory: string): Promise<void> {
    let removed = false;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (
        !CHAT_DELETE_STAGING.test(entry.name) &&
        !INDEX_WRITE_STAGING.test(entry.name) &&
        !CHAT_WRITE_STAGING.test(entry.name)
      ) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fs.rm(candidate);
      removed = true;
    }
    if (removed) await syncDirectoryDurably(directory);
  }

  async function removeStagedFileDurably(staged: string, directory: string): Promise<void> {
    try {
      await fs.rm(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await syncDirectoryDurably(directory);
  }

  async function writeIndexDurably(
    index: readonly ChatMeta[],
    purpose: "chat-delete" | "index-write",
  ): Promise<void> {
    const target = await indexPath();
    const directory = path.dirname(target);
    await removeCrashLeftStages(directory);
    const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
    const serialized = JSON.stringify(sorted, null, 2);
    const staged = path.join(directory, `.${path.basename(target)}.${randomUUID()}.${purpose}.tmp`);
    try {
      await fs.writeFile(staged, serialized, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      recordDiagnosticCounter("filesystem:write", {
        bytesIn: Buffer.byteLength(serialized, "utf8"),
      });
      await syncFile(staged);
      await fs.rename(staged, target);
      await syncDirectoryDurably(directory);
    } finally {
      await removeStagedFileDurably(staged, directory);
    }
  }

  async function writeIndex(index: readonly ChatMeta[]): Promise<void> {
    await writeIndexDurably(index, "index-write");
  }

  async function beginChatTransaction(id: string): Promise<void> {
    const target = await transactionPath(id);
    const directory = path.dirname(target);
    const handle = await fs.open(target, "wx", 0o600);
    try {
      await handle.writeFile("1\n", "utf8");
      recordDiagnosticCounter("filesystem:write", { bytesIn: 2 });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryDurably(directory);
  }

  async function clearChatTransaction(id: string): Promise<void> {
    const target = await transactionPath(id);
    try {
      await fs.rm(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await syncDirectoryDurably(path.dirname(target));
  }

  async function recoverIndex(
    quarantineExisting: boolean,
    seed: readonly ChatMeta[] = [],
  ): Promise<ChatMeta[]> {
    const target = await indexPath();
    const directory = path.dirname(target);
    await removeCrashLeftStages(directory);

    const recovered = new Map<string, ChatMeta>();
    // A schema-valid index entry is only a recovery-order hint. Reconstruct it
    // from the exact same-ID payload so missing or mismatched seed entries can
    // never survive as metadata ghosts.
    for (const meta of seed) {
      const chat = await readChat(meta.id);
      if (!chat || chat.id !== meta.id) continue;
      const recoveredMeta = metaOf(chat);
      if (isValidMeta(recoveredMeta)) recovered.set(recoveredMeta.id, recoveredMeta);
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.name === INDEX ||
        entry.name.startsWith(".") ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }
      const id = entry.name.slice(0, -".json".length);
      if (
        id.length === 0 ||
        id.length > 160 ||
        id.normalize("NFKC") !== id ||
        !SAFE_CHAT_ID.test(id)
      ) {
        continue;
      }
      const chat = await readChat(id);
      if (!chat || chat.id !== id) continue;
      const meta = metaOf(chat);
      if (isValidMeta(meta)) recovered.set(meta.id, meta);
    }
    const resolved = await Promise.all(
      [...recovered.values()].map(async (meta) => {
        const providerId = await resolveProviderId(meta.providerId);
        return providerId === meta.providerId ? meta : { ...meta, providerId };
      }),
    );
    if (quarantineExisting) {
      const quarantine = path.join(directory, `.${path.basename(target)}.${randomUUID()}.corrupt`);
      try {
        await fs.rename(target, quarantine);
        await syncDirectoryDurably(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await writeIndex(resolved);
    return resolved;
  }

  async function readIndex(): Promise<ChatMeta[]> {
    const target = await indexPath();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(target)) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return recoverIndex(false);
      if (error instanceof SyntaxError) return recoverIndex(true);
      throw error;
    }
    if (!Array.isArray(parsed)) return recoverIndex(true);
    const valid = parsed.filter(isValidMeta);
    if (valid.length !== parsed.length) return recoverIndex(true, valid);

    const canonical = new Map<string, ChatMeta>();
    // Schema validity is not existence or ownership. Bind every entry to its
    // exact same-ID payload and derive all list metadata from that validated
    // payload so a valid-looking stale index cannot expose a ghost title or
    // workspace.
    for (const indexed of valid) {
      const chat = await readChat(indexed.id);
      if (!chat || chat.id !== indexed.id) continue;
      const metadata = metaOf(chat);
      if (isValidMeta(metadata)) canonical.set(metadata.id, metadata);
    }
    const resolved = [...canonical.values()];
    if (JSON.stringify(resolved) !== JSON.stringify(valid)) {
      // Operational payload errors escape before this point. A transient EIO
      // therefore leaves the valid index intact and retryable, without
      // quarantining it as corrupt.
      await writeIndex(resolved);
    }
    return resolved;
  }

  async function removeFromIndexDurably(id: string): Promise<void> {
    const next = (await readIndex()).filter((entry) => entry.id !== id);
    await writeIndexDurably(next, "chat-delete");
  }

  async function readChat(id: string): Promise<Chat | null> {
    let data: string;
    try {
      data = await readFile(await chatPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    const messages = (parsed as { messages?: unknown } | null)?.messages;
    if (
      !isValidMeta(parsed) ||
      parsed.id !== id ||
      !Array.isArray(messages) ||
      !messages.every(
        (message) => message !== null && typeof message === "object" && !Array.isArray(message),
      )
    ) {
      return null;
    }
    const chat = parsed as unknown as Chat;
    const providerId = await resolveProviderId(chat.providerId);
    const migratedProvider = providerId !== chat.providerId;
    if (migratedProvider) chat.providerId = providerId;
    chat.messages = chat.messages.map((message) => ({
      ...message,
      reasoning:
        message.role === "assistant" &&
        typeof message.reasoning === "string" &&
        message.reasoning.trim()
          ? message.reasoning
          : undefined,
      timeline:
        message.role === "assistant" ? parseGenerationTimeline(message.timeline) : undefined,
      subagents:
        message.role === "assistant"
          ? parseSubagentMessageReferenceV1(message.subagents)
          : undefined,
    }));
    if (migratedProvider) await writeChat(chat).catch(() => undefined);
    return chat;
  }

  async function writeChat(chat: Chat, beforeRename: () => void = () => undefined): Promise<void> {
    const target = await chatPath(chat.id);
    const directory = path.dirname(target);
    await removeCrashLeftStages(directory);
    const staged = path.join(directory, `.${path.basename(target)}.${randomUUID()}.chat-write.tmp`);
    const serialized = JSON.stringify(chat, null, 2);
    try {
      await fs.writeFile(staged, serialized, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      recordDiagnosticCounter("filesystem:write", {
        bytesIn: Buffer.byteLength(serialized, "utf8"),
      });
      await syncFile(staged);
      beforeRename();
      await fs.rename(staged, target);
      await syncDirectoryDurably(directory);
    } finally {
      await removeStagedFileDurably(staged, directory);
    }
  }

  function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function metaOf(chat: Chat): ChatMeta {
    return {
      id: chat.id,
      title: chat.title,
      workspaceId: chat.workspaceId ?? DEFAULT_WORKSPACE_ID,
      providerId: chat.providerId,
      model: chat.model,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  async function updateMeta(chat: Chat): Promise<void> {
    const index = await readIndex();
    const idx = index.findIndex((entry) => entry.id === chat.id);
    if (idx >= 0) index[idx] = metaOf(chat);
    else index.push(metaOf(chat));
    await writeIndex(index);
  }

  async function writeChatAndMeta(chat: Chat): Promise<void> {
    await beginChatTransaction(chat.id);
    await writeChat(chat);
    await updateMeta(chat);
    await clearChatTransaction(chat.id);
  }

  async function reconcileChatTransactions(): Promise<void> {
    const directory = await resolveChatsDir();
    const transactionIds: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const match = CHAT_TRANSACTION.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      const id = match[1]!;
      // Re-run the canonical identifier validation before using a directory
      // entry as either a payload or cleanup target.
      await chatPath(id);
      transactionIds.push(id);
    }
    if (transactionIds.length === 0) return;

    const index = await readIndex();
    let changed = false;
    for (const id of transactionIds) {
      const chat = await readChat(id);
      const indexPosition = index.findIndex((entry) => entry.id === id);
      if (!chat || chat.id !== id) {
        if (indexPosition >= 0) {
          index.splice(indexPosition, 1);
          changed = true;
        }
        continue;
      }
      const nextMeta = metaOf(chat);
      if (indexPosition < 0 || JSON.stringify(index[indexPosition]) !== JSON.stringify(nextMeta)) {
        if (indexPosition < 0) index.push(nextMeta);
        else index[indexPosition] = nextMeta;
        changed = true;
      }
    }
    if (changed) await writeIndex(index);
    for (const id of transactionIds) await clearChatTransaction(id);
  }

  return {
    /** List chats, newest first. Legacy chats without a workspace fall under the default one. */
    async list(workspaceId?: string): Promise<ChatMeta[]> {
      return serialized(async () => {
        const index = (await readIndex()).map((meta) => ({
          ...meta,
          workspaceId: meta.workspaceId ?? DEFAULT_WORKSPACE_ID,
        }));
        const filtered = workspaceId
          ? index.filter((meta) => meta.workspaceId === workspaceId)
          : index;
        return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
      });
    },

    async get(id: string): Promise<Chat | null> {
      return serialized(() => readChat(id));
    },

    async create(input: {
      title?: string;
      workspaceId?: string;
      providerId?: string;
      model?: string;
    }): Promise<Chat> {
      return serialized(async () => {
        const now = Date.now();
        const chat: Chat = {
          id: newId(),
          title: input.title?.trim() || DEFAULT_CHAT_TITLE,
          workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
          providerId: await resolveProviderId(input.providerId),
          model: input.model,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    async rename(id: string, title: string): Promise<void> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        chat.title = title.trim() || chat.title;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
      });
    },

    /** Apply an asynchronous rename only when no newer rename won the race. */
    async replaceTitleIfUnchanged(
      id: string,
      expectedTitle: string,
      title: string,
    ): Promise<Chat | null> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat || chat.title !== expectedTitle) return null;
        const nextTitle = title.trim();
        if (!nextTitle || nextTitle === chat.title) return null;
        chat.title = nextTitle;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /** Move only an untouched new chat so its workspace can be chosen from the composer. */
    async moveEmptyChatToWorkspace(id: string, workspaceId: string): Promise<Chat> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        if (chat.messages.length > 0) {
          throw new Error("Only a new chat can change workspaces.");
        }
        chat.workspaceId = workspaceId;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /** Persist the chat-local Computer Use opt-in without reordering conversation history. */
    async setComputerUseEnabled(
      id: string,
      enabled: boolean,
      isCurrent: () => boolean = () => true,
    ): Promise<Chat> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        if (!isCurrent()) throw new Error("The renderer document is no longer active.");
        chat.computerUseEnabled = enabled;
        await writeChat(chat, () => {
          // No await occurs between this ownership check and invoking the
          // atomic rename, so a replaced document cannot commit the staged opt-in.
          if (!isCurrent()) throw new Error("The renderer document is no longer active.");
        });
        return chat;
      });
    },

    async remove(id: string): Promise<void> {
      return serialized(async () => {
        const payload = await chatPath(id);
        await removeCrashLeftStages(path.dirname(payload));
        let removedPayload = false;
        try {
          await fs.rm(payload);
          removedPayload = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (removedPayload) await syncDirectoryDurably(path.dirname(payload));
        await removeFromIndexDurably(id);
      });
    },

    async appendMessage(
      id: string,
      message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
      meta?: {
        providerId?: string;
        model?: string;
        autoTitle?: boolean;
        expectedWorkspaceId?: string;
      },
    ): Promise<Chat> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        if (
          meta?.expectedWorkspaceId !== undefined &&
          (chat.workspaceId ?? DEFAULT_WORKSPACE_ID) !== meta.expectedWorkspaceId
        ) {
          throw new Error("The chat workspace changed before the message could be saved.");
        }
        const full: ChatMessage = {
          id: message.id ?? newId(),
          role: message.role,
          content: message.content,
          model: message.model,
          reasoning:
            message.role === "assistant" &&
            typeof message.reasoning === "string" &&
            message.reasoning.trim()
              ? message.reasoning
              : undefined,
          attachments: message.attachments,
          timeline:
            message.role === "assistant" ? parseGenerationTimeline(message.timeline) : undefined,
          subagents:
            message.role === "assistant"
              ? parseSubagentMessageReferenceV1(message.subagents)
              : undefined,
          createdAt: message.createdAt ?? Date.now(),
        };
        const isFirstUserMessage =
          full.role === "user" && !chat.messages.some((entry) => entry.role === "user");
        chat.messages.push(full);
        chat.updatedAt = Date.now();
        if (meta?.providerId) chat.providerId = meta.providerId;
        if (meta?.model) chat.model = meta.model;
        if (meta?.autoTitle && isFirstUserMessage && isDefaultChatTitle(chat.title)) {
          chat.title = deriveChatTitleSeed(full);
        }
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /** Replace only the untouched first-message seed, preserving any manual rename. */
    async replaceAutoTitle(id: string, expectedSeed: string, title: string): Promise<Chat | null> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat || !canReplaceGeneratedChatTitle(chat.title, expectedSeed)) return null;
        const nextTitle = title.trim();
        if (!nextTitle || nextTitle === chat.title) return null;
        chat.title = nextTitle;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
        return chat;
      });
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
