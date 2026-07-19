// Chat history persistence: an index.json of metadata + one file per chat.

import * as fs from "fs/promises";
import * as path from "path";
import { ensureUserDataDir } from "./data-store.js";
import type { Chat, ChatMessage, ChatMeta } from "./types.js";

const DIR = "chats";
const INDEX = "index.json";

async function chatsDir(): Promise<string> {
  return ensureUserDataDir(DIR);
}

async function indexPath(): Promise<string> {
  return path.join(await chatsDir(), INDEX);
}

async function chatPath(id: string): Promise<string> {
  return path.join(await chatsDir(), `${id}.json`);
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

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_WORKSPACE_ID = "default";

export const chatStore = {
  /** List chats, newest first. Legacy chats without a workspace fall under the default one. */
  async list(workspaceId?: string): Promise<ChatMeta[]> {
    const index = (await readIndex()).map((m) => ({
      ...m,
      workspaceId: m.workspaceId ?? DEFAULT_WORKSPACE_ID,
    }));
    const filtered = workspaceId ? index.filter((m) => m.workspaceId === workspaceId) : index;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async get(id: string): Promise<Chat | null> {
    try {
      const data = await fs.readFile(await chatPath(id), "utf-8");
      return JSON.parse(data) as Chat;
    } catch {
      return null;
    }
  },

  async create(input: {
    title?: string;
    workspaceId?: string;
    providerId?: string;
    model?: string;
  }): Promise<Chat> {
    const now = Date.now();
    const chat: Chat = {
      id: newId(),
      title: input.title?.trim() || "New chat",
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      providerId: input.providerId,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await fs.writeFile(await chatPath(chat.id), JSON.stringify(chat, null, 2), "utf-8");
    const index = await readIndex();
    index.push(metaOf(chat));
    await writeIndex(index);
    return chat;
  },

  async rename(id: string, title: string): Promise<void> {
    const chat = await this.get(id);
    if (!chat) throw new Error(`Chat ${id} not found`);
    chat.title = title.trim() || chat.title;
    chat.updatedAt = Date.now();
    await fs.writeFile(await chatPath(id), JSON.stringify(chat, null, 2), "utf-8");
    await updateMeta(chat);
  },

  async remove(id: string): Promise<void> {
    try {
      await fs.rm(await chatPath(id));
    } catch {
      // Already gone — fine.
    }
    const index = (await readIndex()).filter((m) => m.id !== id);
    await writeIndex(index);
  },

  async appendMessage(
    id: string,
    message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
    meta?: { providerId?: string; model?: string; autoTitle?: boolean },
  ): Promise<Chat> {
    const chat = await this.get(id);
    if (!chat) throw new Error(`Chat ${id} not found`);
    const full: ChatMessage = {
      id: message.id ?? newId(),
      role: message.role,
      content: message.content,
      model: message.model,
      attachments: message.attachments,
      createdAt: message.createdAt ?? Date.now(),
    };
    chat.messages.push(full);
    chat.updatedAt = Date.now();
    if (meta?.providerId) chat.providerId = meta.providerId;
    if (meta?.model) chat.model = meta.model;
    // Auto-title from the first user message.
    if (meta?.autoTitle && (chat.title === "New Chat" || chat.title === "New chat") && full.role === "user") {
      chat.title = deriveTitle(full.content);
    }
    await fs.writeFile(await chatPath(id), JSON.stringify(chat, null, 2), "utf-8");
    await updateMeta(chat);
    return chat;
  },
};

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
  const idx = index.findIndex((m) => m.id === chat.id);
  if (idx >= 0) index[idx] = metaOf(chat);
  else index.push(metaOf(chat));
  await writeIndex(index);
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean || "New chat";
}
