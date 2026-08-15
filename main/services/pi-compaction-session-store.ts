import { chmod } from "node:fs/promises";
import path from "node:path";
import {
  JsonlSessionRepo,
  type AgentMessage,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ensureUserDataDir } from "./data-store.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import type { ChatMessage } from "./types.js";

export const AIDEN_CHAT_MESSAGE_MARKER = "aiden.chat-message.v1";
const SESSION_METADATA_KIND = "aiden-chat-compaction-v1";
const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]{1,200}$/u;

interface ChatMessageMarker {
  chatMessageId: string;
}

function markerId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const id = (data as Partial<ChatMessageMarker>).chatMessageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Append visible messages that are not yet represented in Pi's journal.
 * Custom marker entries are ignored by Session.buildContext(), while making
 * crash recovery and repeated generation setup idempotent.
 */
export async function syncChatMessagesToPiSession(
  session: Session,
  messages: readonly ChatMessage[],
  model: Model<Api>,
  supportsImages: boolean,
  contentOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const entries = await session.getBranch();
  const synchronized = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== AIDEN_CHAT_MESSAGE_MARKER) {
        return [];
      }
      const id = markerId(entry.data);
      return id ? [id] : [];
    }),
  );

  for (const message of messages) {
    if (synchronized.has(message.id)) continue;
    await appendPiTransaction(session, async () => {
      await session.appendMessage(
        chatMessageToPiMessage(message, model, supportsImages, contentOverrides.get(message.id)),
      );
      await session.appendCustomEntry(AIDEN_CHAT_MESSAGE_MARKER, {
        chatMessageId: message.id,
      } satisfies ChatMessageMarker);
    });
    synchronized.add(message.id);
  }
}

async function appendPiTransaction<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  const originalLeafId = await session.getLeafId();
  try {
    return await operation();
  } catch (error) {
    try {
      await session.moveTo(originalLeafId);
    } catch (rollbackError) {
      throw new Error(
        `The Pi journal write failed and its partial branch could not be rolled back: ${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }
}

export async function appendPiMessages(
  session: Session,
  messages: readonly AgentMessage[],
  visibleChatMessageId?: string,
): Promise<void> {
  await appendPiTransaction(session, async () => {
    for (const message of messages) await session.appendMessage(message);
    if (visibleChatMessageId) {
      await session.appendCustomEntry(AIDEN_CHAT_MESSAGE_MARKER, {
        chatMessageId: visibleChatMessageId,
      } satisfies ChatMessageMarker);
    }
  });
}

export interface PiCompactionSessionStoreOptions {
  root: () => Promise<string>;
}

/** Durable, private Pi JSONL journals keyed one-to-one with Aiden chats. */
export class PiCompactionSessionStore {
  private repositoryPromise?: Promise<{
    repo: JsonlSessionRepo;
    root: string;
  }>;
  private readonly sessions = new Map<string, Session<JsonlSessionMetadata>>();
  private readonly opening = new Map<string, Promise<Session<JsonlSessionMetadata>>>();

  constructor(private readonly options: PiCompactionSessionStoreOptions) {}

  private async repository(): Promise<{
    repo: JsonlSessionRepo;
    root: string;
  }> {
    this.repositoryPromise ??= (async () => {
      const root = await this.options.root();
      await chmod(root, 0o700);
      return {
        root,
        repo: new JsonlSessionRepo({
          fs: new NodeExecutionEnv({ cwd: root }),
          sessionsRoot: root,
        }),
      };
    })();
    return this.repositoryPromise;
  }

  async openChat(chatId: string): Promise<Session<JsonlSessionMetadata>> {
    if (!SAFE_SESSION_ID.test(chatId)) {
      throw new Error("Invalid chat identity for the Pi compaction journal.");
    }
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const inFlight = this.opening.get(chatId);
    if (inFlight) return inFlight;

    const opening = (async () => {
      const { repo, root } = await this.repository();
      const matches = (await repo.list()).filter(
        (metadata) => metadata.id === chatId && metadata.metadata?.kind === SESSION_METADATA_KIND,
      );
      // Pi lists newest sessions first. If recovery ever leaves duplicates,
      // continue from the newest valid journal instead of reviving stale state.
      const metadata = matches[0];
      const session = metadata
        ? await repo.open(metadata)
        : await repo.create({
            id: chatId,
            cwd: root,
            metadata: { kind: SESSION_METADATA_KIND, chatId },
          });
      const persisted = await session.getMetadata();
      await chmod(path.dirname(persisted.path), 0o700);
      await chmod(persisted.path, 0o600);
      this.sessions.set(chatId, session);
      return session;
    })();
    this.opening.set(chatId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(chatId);
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    if (!SAFE_SESSION_ID.test(chatId)) {
      throw new Error("Invalid chat identity for the Pi compaction journal.");
    }
    await this.opening.get(chatId);
    const { repo } = await this.repository();
    const matches = (await repo.list()).filter(
      (metadata) => metadata.id === chatId && metadata.metadata?.kind === SESSION_METADATA_KIND,
    );
    for (const metadata of matches) await repo.delete(metadata);
    this.sessions.delete(chatId);
  }
}

export const piCompactionSessionStore = new PiCompactionSessionStore({
  root: () => ensureUserDataDir("pi-compaction-sessions"),
});
