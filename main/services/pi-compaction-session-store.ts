import { randomUUID } from "node:crypto";
import { chmod, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { cleanupSessionResources, type Api, type Model } from "@earendil-works/pi-ai";
import { ensureUserDataDir } from "./data-store.js";
import { isDevelopmentRuntime } from "../runtime-mode-core.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import type { PiPersistentSessionMetadata, PiSessionPort } from "./pi-session-port.js";
import {
  createCurrentPiSessionRepository,
  type PiSessionRepositoryPort,
} from "./pi-session-repository-port.js";
import { migratePiSessionJournal } from "./pi-session-migration.js";
import { decodeLegacyPiSession } from "./pi-legacy-session.js";
import {
  piUpgradeBehaviorEnabledAtStartup,
  piUpgradeJournalCreationEligible,
  piUpgradeLegacyMigrationEligible,
  type PiUpgradeRolloutDocument,
} from "./pi-upgrade-rollout.js";
import { piUpgradeRolloutStore } from "./pi-upgrade-rollout-main.js";
import type { DurablePiRuntimeEffect } from "./pi-runtime-effect-core.js";
import type { ChatMessage } from "./types.js";

export const AIDEN_CHAT_MESSAGE_MARKER = "aiden.chat-message.v1";
export const AIDEN_PI_TRANSACTION = "aiden.pi-transaction.v1";
export const AIDEN_EFFECT_RECOVERY_MARKER = "aiden.effect-recovery.v1";
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

interface PiEffectRecoveryMarker {
  effectId: string;
}

function effectRecoveryId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const id = (data as Partial<PiEffectRecoveryMarker>).effectId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(""),
    reasoning: message.content
      .filter(
        (part): part is { type: "thinking"; thinking: string; redacted?: boolean } =>
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
    const { bytesRead } = await handle.read(buffer, 0, JOURNAL_HEADER_SCAN_BYTES, 0);
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

function currentJournalHeaderOwnsChat(headerLine: string, chatId: string): boolean {
  try {
    const header = JSON.parse(headerLine) as {
      kind?: unknown;
      version?: unknown;
      id?: unknown;
      metadata?: { kind?: unknown; chatId?: unknown };
    };
    return (
      header.kind === "header" &&
      header.version === 4 &&
      header.id === chatId &&
      header.metadata?.kind === SESSION_METADATA_KIND &&
      header.metadata.chatId === chatId
    );
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findMigrationJournals(root: string, chatId: string): Promise<string[]> {
  const matches: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(candidate);
      } else if (entry.name.endsWith(".jsonl")) {
        const prefix = await readJournalPrefix(candidate).catch(() => "");
        if (
          journalHeaderOwnsChat(prefix, chatId) ||
          (currentJournalHeaderOwnsChat(prefix, chatId) &&
            ((await fileExists(`${candidate}.v3-backup`)) ||
              (await fileExists(`${candidate}.migration-v1.json`))))
        ) {
          matches.push(candidate);
        }
      }
    }
  }
  return matches;
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
  session: PiSessionPort,
  messages: readonly ChatMessage[],
  model: Model<Api>,
  _supportsImages: boolean,
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
  session: PiSessionPort,
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
export async function beginPiGenerationTurn(session: PiSessionPort): Promise<string> {
  const transactionId = randomUUID();
  await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
    transactionId,
    phase: "begin",
  } satisfies PiTransactionMarker);
  return transactionId;
}

export async function commitPiGenerationTurn(
  session: PiSessionPort,
  transactionId: string,
): Promise<void> {
  await session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
    transactionId,
    phase: "commit",
  } satisfies PiTransactionMarker);
}

export interface PiVisibleTurnLease {
  readonly started: boolean;
  commit(
    visibleChatMessageId: string,
    options?: { markerAlreadyPersisted?: boolean },
  ): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Own the Pi side of Aiden's cross-store visible-turn boundary. ChatStore
 * remains a separate durable system, so callers persist it first and then
 * commit this lease; either failure path can idempotently restore the source
 * leaf without knowing Pi transaction mechanics.
 */
export async function beginPiVisibleTurnLease(
  session: PiSessionPort,
  onBeginError?: (error: unknown) => void,
): Promise<PiVisibleTurnLease> {
  let sourceLeafId: string | null | undefined;
  let transactionId: string | undefined;
  try {
    sourceLeafId = await session.getLeafId();
    transactionId = await beginPiGenerationTurn(session);
  } catch (error) {
    try {
      onBeginError?.(error);
    } catch {
      // Diagnostics cannot alter the lease's fail-closed state.
    }
  }
  let closed = false;
  return {
    started: transactionId !== undefined,
    async commit(
      visibleChatMessageId: string,
      options: { markerAlreadyPersisted?: boolean } = {},
    ): Promise<void> {
      if (closed) throw new Error("The Pi visible-turn lease is closed.");
      if (!transactionId) {
        throw new Error("The Pi visible-turn transaction did not start.");
      }
      if (!options.markerAlreadyPersisted) {
        await appendPiMessages(session, [], visibleChatMessageId);
      }
      await commitPiGenerationTurn(session, transactionId);
      closed = true;
    },
    async rollback(): Promise<void> {
      if (closed) return;
      if (sourceLeafId !== undefined) await session.moveTo(sourceLeafId);
      closed = true;
    },
  };
}

async function recoverUncommittedTransaction(session: PiSessionPort): Promise<void> {
  const branch = await session.getBranch();
  const open = new Map<string, string | null>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== AIDEN_PI_TRANSACTION) continue;
    const marker = transactionMarker(entry.data);
    if (!marker) continue;
    if (marker.phase === "begin") open.set(marker.transactionId, entry.parentId);
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
  session: PiSessionPort,
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

/**
 * Install a private, idempotent no-repeat boundary for effects whose tool
 * result may have been rolled out of the Pi branch by crash recovery. Exact
 * arguments never enter this message. A later model must inspect state or ask
 * before repeating an operation that may already have happened.
 */
export async function recordPiEffectRecoveryBoundary(
  session: PiSessionPort,
  effects: readonly DurablePiRuntimeEffect[],
): Promise<void> {
  if (effects.length === 0) return;
  const entries = await session.getBranch();
  const recorded = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== AIDEN_EFFECT_RECOVERY_MARKER) return [];
      const id = effectRecoveryId(entry.data);
      return id ? [id] : [];
    }),
  );
  const pending = effects.filter((effect) => !recorded.has(effect.effectId));
  if (pending.length === 0) return;
  const toolNames = [...new Set(pending.map(({ toolName }) => toolName))].slice(0, 20);
  const tools = toolNames.length > 0 ? ` Tools involved: ${toolNames.join(", ")}.` : "";
  const message: AgentMessage = {
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          "Aiden recovery boundary: one or more prior tool calls may have crossed execution before their results were durably committed." +
          tools +
          " Do not repeat these operations automatically. Inspect the current state or ask the user before retrying.",
      },
    ],
    api: "openai-completions",
    provider: "aiden",
    model: "effect-recovery",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  await appendPiTransaction(session, async () => {
    await session.appendMessage(message);
    for (const effect of pending) {
      await session.appendCustomEntry(AIDEN_EFFECT_RECOVERY_MARKER, {
        effectId: effect.effectId,
      } satisfies PiEffectRecoveryMarker);
    }
  });
}

export interface PiCompactionSessionStoreOptions {
  root: () => Promise<string>;
  rollout?: {
    load(): Promise<PiUpgradeRolloutDocument>;
    development: boolean;
    behaviorEnabled: boolean;
  };
}

/** Durable, private Pi JSONL journals keyed one-to-one with Aiden chats. */
export class PiCompactionSessionStore {
  private repositoryPromise?: Promise<{
    repo: PiSessionRepositoryPort;
    root: string;
  }>;
  private readonly sessions = new Map<string, PiSessionPort<PiPersistentSessionMetadata>>();
  private readonly opening = new Map<
    string,
    Promise<PiSessionPort<PiPersistentSessionMetadata>>
  >();
  private readonly quarantined = new Map<string, Promise<void>>();
  private indexMutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: PiCompactionSessionStoreOptions) {}

  /**
   * Prevent a chat journal from being reused while a non-abortable storage
   * operation is still settling. The quarantine is removed only after the
   * caller's recovery completes successfully; a failed recovery remains
   * fail-closed until process restart can run normal journal recovery.
   */
  quarantineChatUntilRecovered(chatId: string, recovery: Promise<void>): void {
    if (!SAFE_SESSION_ID.test(chatId)) {
      throw new Error("Invalid chat identity for the Pi compaction journal.");
    }
    let guarded: Promise<void>;
    guarded = recovery.then(() => {
      if (this.quarantined.get(chatId) === guarded) {
        this.quarantined.delete(chatId);
      }
    });
    this.quarantined.set(chatId, guarded);
    void guarded.catch(() => undefined);
  }

  private assertNotQuarantined(chatId: string): void {
    if (this.quarantined.has(chatId)) {
      throw new Error("The Pi journal is waiting for an indeterminate write to recover.");
    }
  }

  private async readIndex(root: string): Promise<JournalIndex> {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(root, JOURNAL_INDEX_FILE), "utf8"),
      ) as Partial<JournalIndex>;
      return parsed.version === 1 && parsed.chats && typeof parsed.chats === "object"
        ? { version: 1, chats: parsed.chats as Record<string, string[]> }
        : { version: 1, chats: {} };
    } catch {
      return { version: 1, chats: {} };
    }
  }

  private async mutateIndex(root: string, mutation: (index: JournalIndex) => void): Promise<void> {
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

  private async rememberPath(root: string, chatId: string, filePath: string): Promise<void> {
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

  private async quarantine(root: string, chatId: string, filePath: string): Promise<void> {
    const quarantined = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    await rename(filePath, quarantined);
    await this.rememberPath(root, chatId, quarantined);
  }

  private async repository(): Promise<{
    repo: PiSessionRepositoryPort;
    root: string;
  }> {
    this.repositoryPromise ??= (async () => {
      const root = await this.options.root();
      await chmod(root, 0o700);
      return {
        root,
        repo: createCurrentPiSessionRepository(root),
      };
    })();
    return this.repositoryPromise;
  }

  async openChat(
    chatId: string,
    chat?: { createdAt: number },
  ): Promise<PiSessionPort<PiPersistentSessionMetadata>> {
    if (!SAFE_SESSION_ID.test(chatId)) {
      throw new Error("Invalid chat identity for the Pi compaction journal.");
    }
    this.assertNotQuarantined(chatId);
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const inFlight = this.opening.get(chatId);
    if (inFlight) return inFlight;

    const opening = (async () => {
      const { repo, root } = await this.repository();
      const rollout = await this.options.rollout?.load();
      const rolloutOptions = this.options.rollout && {
        development: this.options.rollout.development,
        behaviorEnabled: this.options.rollout.behaviorEnabled,
      };
      const migrationFailures: Array<{ path: string; error: unknown }> = [];
      const deferredMigrations: string[] = [];
      const migrationPaths = await findMigrationJournals(root, chatId);
      for (const migrationPath of migrationPaths) {
        try {
          if (rollout && rolloutOptions) {
            const header = await readJournalPrefix(migrationPath);
            const legacySource = journalHeaderOwnsChat(header, chatId)
              ? migrationPath
              : `${migrationPath}.v3-backup`;
            const legacy = decodeLegacyPiSession(await readFile(legacySource, "utf8"));
            if (!piUpgradeLegacyMigrationEligible(rollout, legacy.entries.length, rolloutOptions)) {
              deferredMigrations.push(migrationPath);
              continue;
            }
          }
          const migration = await migratePiSessionJournal(migrationPath, chatId);
          await this.rememberPath(root, chatId, migration.receipt.backupPath);
          await this.rememberPath(root, chatId, migration.receiptPath);
        } catch (error) {
          migrationFailures.push({ path: migrationPath, error });
        }
      }
      const failedPaths = new Set(migrationFailures.map((failure) => path.resolve(failure.path)));
      const matches = (await repo.list()).filter(
        (metadata) =>
          metadata.id === chatId &&
          metadata.metadata?.kind === SESSION_METADATA_KIND &&
          !failedPaths.has(path.resolve(metadata.path)),
      );
      // Pi lists newest sessions first. Validate the whole body and quarantine
      // a malformed duplicate before falling back to the next valid journal.
      let session: PiSessionPort<PiPersistentSessionMetadata> | undefined;
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
      if (session) {
        for (const failure of migrationFailures) {
          await this.quarantine(root, chatId, failure.path);
        }
      } else if (migrationFailures[0]) {
        throw migrationFailures[0].error;
      }
      if (!session && deferredMigrations.length > 0) {
        throw new Error("This legacy Pi journal is outside the active device rollout stage; its v3 bytes remain unchanged.");
      }
      if (
        !session && rollout && rolloutOptions &&
        !piUpgradeJournalCreationEligible(rollout, chat?.createdAt, rolloutOptions)
      ) {
        throw new Error("Pi v4 journal creation is outside the active device rollout stage.");
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
    this.assertNotQuarantined(chatId);
    await this.opening.get(chatId);
    const { repo, root } = await this.repository();
    const matches = (await repo.list()).filter(
      (metadata) => metadata.id === chatId && metadata.metadata?.kind === SESSION_METADATA_KIND,
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
  rollout: {
    load: () => piUpgradeRolloutStore.load(),
    development: isDevelopmentRuntime(process.env, Boolean(process.versions.electron)),
    behaviorEnabled: piUpgradeBehaviorEnabledAtStartup,
  },
});
