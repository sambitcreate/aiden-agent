import { randomUUID } from "node:crypto";
import {
  chmod,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  JsonlSessionRepo,
  type AgentMessage,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  cleanupSessionResources,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ensureUserDataDir } from "./data-store.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import type { ChatMessage } from "./types.js";

export const AIDEN_CHAT_MESSAGE_MARKER = "aiden.chat-message.v1";
export const AIDEN_PI_TRANSACTION = "aiden.pi-transaction.v1";
const SESSION_METADATA_KIND = "aiden-chat-compaction-v1";
const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]{1,200}$/u;
const JOURNAL_INDEX_FILE = "aiden-journal-index.json";
const JOURNAL_HEADER_SCAN_BYTES = 65_536;

interface JournalIndex {
  version: 1;
  chats: Record<string, string[]>;
}

interface ChatMessageMarker {
  chatMessageId: string;
}

interface PiTransactionMarker {
  transactionId: string;
  phase: "begin" | "commit";
}

function transactionMarker(data: unknown): PiTransactionMarker | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<PiTransactionMarker>;
  return typeof candidate.transactionId === "string" &&
    candidate.transactionId.length > 0 &&
    (candidate.phase === "begin" || candidate.phase === "commit")
    ? { transactionId: candidate.transactionId, phase: candidate.phase }
    : undefined;
}

function assistantProjection(message: AgentMessage):
  | {
      text: string;
      reasoning: string;
    }
  | undefined {
  if (message.role !== "assistant") return undefined;
  return {
    text: message.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join(""),
    reasoning: message.content
      .filter(
        (
          part,
        ): part is { type: "thinking"; thinking: string; redacted?: boolean } =>
          part.type === "thinking" && part.redacted !== true,
      )
      .map((part) => part.thinking)
      .join("\n\n"),
  };
}

function visibleAssistantAlreadyAtTail(
  tail: AgentMessage | undefined,
  visible: ChatMessage,
  desired: AgentMessage,
): boolean {
  if (visible.role !== "assistant" || !tail) return false;
  const actual = assistantProjection(tail);
  const expected = assistantProjection(desired);
  return (
    actual !== undefined &&
    expected !== undefined &&
    actual.text === expected.text &&
    actual.reasoning === expected.reasoning
  );
}

function markerId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const id = (data as Partial<ChatMessageMarker>).chatMessageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function readJournalPrefix(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(JOURNAL_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      JOURNAL_HEADER_SCAN_BYTES,
      0,
    );
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = prefix.indexOf("\n");
    return newline >= 0 ? prefix.slice(0, newline) : prefix;
  } finally {
    await handle.close();
  }
}

function journalHeaderOwnsChat(headerLine: string, chatId: string): boolean {
  try {
    const header = JSON.parse(headerLine) as {
      type?: unknown;
      version?: unknown;
      id?: unknown;
      metadata?: { kind?: unknown; chatId?: unknown };
    };
    return (
      header.type === "session" &&
      header.version === 3 &&
      header.id === chatId &&
      header.metadata?.kind === SESSION_METADATA_KIND &&
      header.metadata.chatId === chatId
    );
  } catch {
    return false;
  }
}

/** Preserve a valid durable prefix when only the final JSONL write was torn. */
async function repairTornFinalLine(filePath: string): Promise<boolean> {
  const contents = await readFile(filePath, "utf8");
  if (!contents || contents.endsWith("\n")) return false;
  const finalNewline = contents.lastIndexOf("\n");
  if (finalNewline < 0) return false;
  const completePrefix = contents.slice(0, finalNewline + 1);
  try {
    for (const line of completePrefix.split("\n")) {
      if (line.trim()) JSON.parse(line);
    }
  } catch {
    return false;
  }
  const handle = await open(filePath, "r+");
  try {
    await handle.truncate(Buffer.byteLength(completePrefix, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
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
  _supportsImages: boolean,
  contentOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const entries = await session.getBranch();
  const synchronized = new Set(
    entries.flatMap((entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== AIDEN_CHAT_MESSAGE_MARKER
      ) {
        return [];
      }
      const id = markerId(entry.data);
      return id ? [id] : [];
    }),
  );

  for (const message of messages) {
    if (synchronized.has(message.id)) continue;
    const desired = chatMessageToPiMessage(
      message,
      model,
      // Journals are model-neutral. Request-time projection removes images for
      // text-only models, so a later switch to a vision model remains faithful.
      true,
      contentOverrides.get(message.id),
    );
    const context = await session.buildContext();
    const tail = context.messages[context.messages.length - 1];
    await appendPiTransaction(session, async () => {
      // A process may have died after the Pi assistant was committed and the
      // visible chat was saved, but before its marker transaction. Reconcile
      // that exact terminal projection instead of duplicating the answer.
      if (!visibleAssistantAlreadyAtTail(tail, message, desired)) {
        await session.appendMessage(desired);
      }
      await session.appendCustomEntry(AIDEN_CHAT_MESSAGE_MARKER, {
        chatMessageId: message.id,
      } satisfies ChatMessageMarker);
    });
    synchronized.add(message.id);
  }
}

async function appendPiTransaction<T>(
  session: Session,
  operation: () => Promise<T>,
): Promise<T> {
  const originalLeafId = await session.getLeafId();
  const transactionId = randomUUID();
  try {
    await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
      transactionId,
      phase: "begin",
    } satisfies PiTransactionMarker);
    const result = await operation();
    await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
      transactionId,
      phase: "commit",
    } satisfies PiTransactionMarker);
    return result;
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

/** Hold a generation suffix open until its visible assistant is durable. */
export async function beginPiGenerationTurn(session: Session): Promise<string> {
  const transactionId = randomUUID();
  await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
    transactionId,
    phase: "begin",
  } satisfies PiTransactionMarker);
  return transactionId;
}

export async function commitPiGenerationTurn(
  session: Session,
  transactionId: string,
): Promise<void> {
  await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
    transactionId,
    phase: "commit",
  } satisfies PiTransactionMarker);
}

async function recoverUncommittedTransaction(session: Session): Promise<void> {
  const branch = await session.getBranch();
  const open = new Map<string, string | null>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== AIDEN_PI_TRANSACTION)
      continue;
    const marker = transactionMarker(entry.data);
    if (!marker) continue;
    if (marker.phase === "begin")
      open.set(marker.transactionId, entry.parentId);
    else open.delete(marker.transactionId);
  }
  if (open.size === 0) return;
  // Writes are serialized per Session. The earliest open envelope owns every
  // later suffix record, including any partially appended message batch.
  const earliest = branch.find(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === AIDEN_PI_TRANSACTION &&
      transactionMarker(entry.data)?.phase === "begin" &&
      open.has(transactionMarker(entry.data)?.transactionId ?? ""),
  );
  if (earliest) await session.moveTo(earliest.parentId);
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
  private readonly opening = new Map<
    string,
    Promise<Session<JsonlSessionMetadata>>
  >();
  private indexMutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: PiCompactionSessionStoreOptions) {}

  private async readIndex(root: string): Promise<JournalIndex> {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(root, JOURNAL_INDEX_FILE), "utf8"),
      ) as Partial<JournalIndex>;
      return parsed.version === 1 &&
        parsed.chats &&
        typeof parsed.chats === "object"
        ? { version: 1, chats: parsed.chats as Record<string, string[]> }
        : { version: 1, chats: {} };
    } catch {
      return { version: 1, chats: {} };
    }
  }

  private async mutateIndex(
    root: string,
    mutation: (index: JournalIndex) => void,
  ): Promise<void> {
    const operation = this.indexMutation.then(async () => {
      const index = await this.readIndex(root);
      mutation(index);
      const target = path.join(root, JOURNAL_INDEX_FILE);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    });
    this.indexMutation = operation.catch(() => undefined);
    return operation;
  }

  private async rememberPath(
    root: string,
    chatId: string,
    filePath: string,
  ): Promise<void> {
    const resolvedRoot = `${path.resolve(root)}${path.sep}`;
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      throw new Error("Pi journal metadata escaped its private storage root.");
    }
    await this.mutateIndex(root, (index) => {
      const paths = new Set(index.chats[chatId] ?? []);
      paths.add(resolvedPath);
      index.chats[chatId] = [...paths];
    });
  }

  private async quarantine(
    root: string,
    chatId: string,
    filePath: string,
  ): Promise<void> {
    const quarantined = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    await rename(filePath, quarantined);
    await this.rememberPath(root, chatId, quarantined);
  }

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
        (metadata) =>
          metadata.id === chatId &&
          metadata.metadata?.kind === SESSION_METADATA_KIND,
      );
      // Pi lists newest sessions first. Validate the whole body and quarantine
      // a malformed duplicate before falling back to the next valid journal.
      let session: Session<JsonlSessionMetadata> | undefined;
      for (const metadata of matches) {
        try {
          const candidate = await repo.open(metadata);
          await candidate.getBranch();
          session = candidate;
          break;
        } catch {
          if (await repairTornFinalLine(metadata.path).catch(() => false)) {
            try {
              const repaired = await repo.open(metadata);
              await repaired.getBranch();
              session = repaired;
              break;
            } catch {
              // A complete-but-invalid prefix is not safe to guess at.
            }
          }
          await this.quarantine(root, chatId, metadata.path);
        }
      }
      session ??= await repo.create({
        id: chatId,
        cwd: root,
        metadata: { kind: SESSION_METADATA_KIND, chatId },
      });
      await recoverUncommittedTransaction(session);
      const persisted = await session.getMetadata();
      await chmod(path.dirname(persisted.path), 0o700);
      await chmod(persisted.path, 0o600);
      await this.rememberPath(root, chatId, persisted.path);
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
    const { repo, root } = await this.repository();
    const matches = (await repo.list()).filter(
      (metadata) =>
        metadata.id === chatId &&
        metadata.metadata?.kind === SESSION_METADATA_KIND,
    );
    for (const metadata of matches) await repo.delete(metadata);
    const index = await this.readIndex(root);
    for (const indexedPath of index.chats[chatId] ?? []) {
      const resolved = path.resolve(indexedPath);
      if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
      await unlink(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    // Legacy journals are deleted only when their first JSONL header line has
    // an exact identity. Body text may mention a different chat in tool args.
    const directories = [root];
    while (directories.length > 0) {
      const directory = directories.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(candidate);
          continue;
        }
        if (!entry.name.includes(".jsonl")) continue;
        const prefix = await readJournalPrefix(candidate).catch(() => "");
        if (journalHeaderOwnsChat(prefix, chatId)) {
          await unlink(candidate);
        }
      }
    }
    await this.mutateIndex(root, (next) => {
      delete next.chats[chatId];
    });
    cleanupSessionResources(chatId);
    this.sessions.delete(chatId);
  }

  /** Remove indexed journals whose visible chat no longer exists. */
  async reconcileChats(validChatIds: ReadonlySet<string>): Promise<void> {
    const { repo, root } = await this.repository();
    const indexed = await this.readIndex(root);
    const discovered = await repo.list();
    const candidates = new Set([
      ...Object.keys(indexed.chats),
      ...discovered
        .filter((metadata) => metadata.metadata?.kind === SESSION_METADATA_KIND)
        .map((metadata) => metadata.id),
    ]);
    for (const chatId of candidates) {
      if (SAFE_SESSION_ID.test(chatId) && !validChatIds.has(chatId)) {
        await this.deleteChat(chatId);
      }
    }
  }
}

export const piCompactionSessionStore = new PiCompactionSessionStore({
  root: () => ensureUserDataDir("pi-compaction-sessions"),
});
