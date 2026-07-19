// Chat history persistence: an index.json of metadata + one file per chat.
// Every read-modify-write operation is serialized because all chats share the
// same index file and background title generation can overlap message writes.

import * as fs from "fs/promises";
import * as path from "path";
import {
  DEFAULT_CHAT_TITLE,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
} from "./chat-title-policy.js";
import type { Chat, ChatMessage, ChatMeta } from "./types.js";

const INDEX = "index.json";
const DEFAULT_WORKSPACE_ID = "default";

export function createChatStore(resolveChatsDir: () => Promise<string>) {
  let operationTail: Promise<void> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
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
    return path.join(await resolveChatsDir(), `${id}.json`);
  }

  async function readIndex(): Promise<ChatMeta[]> {
    try {
      const data = await fs.readFile(await indexPath(), "utf-8");
      return JSON.parse(data) as ChatMeta[];
    } catch {
      return [];
    }
  }

  async function writeIndex(index: ChatMeta[]): Promise<void> {
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    await fs.writeFile(await indexPath(), JSON.stringify(index, null, 2), "utf-8");
  }

  async function readChat(id: string): Promise<Chat | null> {
    try {
      const data = await fs.readFile(await chatPath(id), "utf-8");
      return JSON.parse(data) as Chat;
    } catch {
      return null;
    }
  }

  async function writeChat(chat: Chat): Promise<void> {
    await fs.writeFile(await chatPath(chat.id), JSON.stringify(chat, null, 2), "utf-8");
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
          providerId: input.providerId,
          model: input.model,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        await writeChat(chat);
        const index = await readIndex();
        index.push(metaOf(chat));
        await writeIndex(index);
        return chat;
      });
    },

    async rename(id: string, title: string): Promise<void> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        chat.title = title.trim() || chat.title;
        chat.updatedAt = Date.now();
        await writeChat(chat);
        await updateMeta(chat);
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
        await writeChat(chat);
        await updateMeta(chat);
        return chat;
      });
    },

    async remove(id: string): Promise<void> {
      return serialized(async () => {
        try {
          await fs.rm(await chatPath(id));
        } catch {
          // Already gone — fine.
        }
        const index = (await readIndex()).filter((meta) => meta.id !== id);
        await writeIndex(index);
      });
    },

    async appendMessage(
      id: string,
      message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
      meta?: { providerId?: string; model?: string; autoTitle?: boolean },
    ): Promise<Chat> {
      return serialized(async () => {
        const chat = await readChat(id);
        if (!chat) throw new Error(`Chat ${id} not found`);
        const full: ChatMessage = {
          id: message.id ?? newId(),
          role: message.role,
          content: message.content,
          model: message.model,
          attachments: message.attachments,
          createdAt: message.createdAt ?? Date.now(),
        };
        const isFirstUserMessage =
          full.role === "user" && !chat.messages.some((entry) => entry.role === "user");
        chat.messages.push(full);
        chat.updatedAt = Date.now();
        if (meta?.providerId) chat.providerId = meta.providerId;
        if (meta?.model) chat.model = meta.model;
        if (
          meta?.autoTitle &&
          isFirstUserMessage &&
          chat.title.trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase()
        ) {
          chat.title = deriveChatTitleSeed(full);
        }
        await writeChat(chat);
        await updateMeta(chat);
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
        await writeChat(chat);
        await updateMeta(chat);
        return chat;
      });
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
