// Chat history persistence: an index.json of metadata + one file per chat.
//
// Concurrency model:
// - Operations on one chat are serialized by a per-chat lock, so background
//   title generation cannot overlap a message write to the same chat, while
//   writes to different chats proceed independently.
// - index.json is guarded by its own lock. Once verified against payloads, the
//   index is kept in memory and patched one entry at a time, so listing and
//   appending never re-read every transcript.
// - Startup cleanup, transaction reconciliation and full index verification
//   run as exclusive maintenance that waits for in-flight operations to drain.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CHAT_TITLE,
  isDefaultChatTitle,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
} from "./chat-title-policy.js";
import { chatSurface, parseChatOwnerV1, type ChatOwnerV1 } from "../../renderer/shared/chat-visibility.js";
import type { Chat, ChatMessage, ChatMeta } from "./types.js";
import {
  FORK_SUMMARY_HOLD_MESSAGE,
  forkSummaryHoldsSend,
  nextForkTitle,
  parseChatForkLineageV1,
  type ChatForkLineageV1,
  type ChatForkPosition,
  type ChatForkSummaryV1,
} from "../../renderer/shared/chat-copy-contract.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import { parseSubagentMessageReferenceV1 } from "../../renderer/shared/subagent-runs.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import { parseSkillProvenanceV1 } from "../../renderer/shared/slash-commands.js";
import { safeStoredAttachments } from "./attachment-contract.js";
import { parseChatHtmlArtifacts } from "../../renderer/shared/chat-artifacts.js";
import { remappedHtmlArtifactMediaId } from "./generative-ui-artifact-store.js";
import { parseStoredPiAssistantMessage } from "./pi-message-storage.js";
import { parseAssistantTurnStatsV1 } from "../../renderer/shared/assistant-turn-stats.js";
import {
  projectVisibleChatMessage,
  projectVisibleChatMetadata,
} from "./visible-chat-projection.js";
import { MAX_VISIBLE_COPY_MESSAGES } from "../../renderer/shared/chat-copy-contract.js";
import { ChatForkError } from "./chat-fork-error.js";
import { jsonStringBytesBounded } from "./json-representation.js";
import { parseProviderFailureV1 } from "../../renderer/shared/provider-failure.js";
import { providerFailureFromLegacyPiMessage } from "./provider-failure.js";
import { isBoundedBotText } from "../../renderer/shared/bot-capabilities.js";
import {
  chatSummaryRevision,
  isChatSummaryRevision,
  newChatSummaryRevision,
} from "./chat-summary-revision.js";

const INDEX = "index.json";
const DEFAULT_WORKSPACE_ID = "default";
const MAX_VISIBLE_COPY_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_META_PREVIEW_CHARS = 500;
const MAX_CHAT_META_PREVIEW_BYTES = 2_000;
const MAX_SUMMARY_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SUMMARY_INDEX_ENTRIES = 10_000;
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
  /** Told once per unreadable payload that was moved aside with its bytes intact. */
  onQuarantine?: () => void;
}

/** Hidden sibling holding the untouched bytes of a payload that could not be parsed. */
const QUARANTINED_PAYLOAD =
  /^\.[A-Za-z0-9._:-]+\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.corrupt$/u;

/**
 * How a payload read may react to what it finds.
 * - "owner": the caller holds the chat's lock; migrations may be written back
 *   and corrupt payloads are quarantined and dropped from the index.
 * - "exclusive": maintenance with no other operation in flight; same as owner,
 *   except the caller rebuilds the index itself.
 * - "pure": a read that may race other chats' writers; never writes anything.
 */
type ReadPolicy = "owner" | "exclusive" | "pure";

export class ChatCreateReconciliationRequiredError extends Error {
  readonly chatId: string;

  constructor(chatId: string) {
    super("Chat creation could not be reconciled safely.");
    this.name = "ChatCreateReconciliationRequiredError";
    this.chatId = chatId;
  }
}

export function isChatCreateReconciliationRequiredError(
  error: unknown,
): error is ChatCreateReconciliationRequiredError {
  return error instanceof ChatCreateReconciliationRequiredError;
}

export function createChatStore(
  resolveChatsDir: () => Promise<string>,
  resolveProviderId: (
    providerId: string | undefined,
  ) => Promise<string | undefined> = async (providerId) =>
    migrateLegacyPiProviderId(providerId),
  durability: ChatStoreDurability = {},
) {
  const indexListeners = new Set<() => void>();
  const syncDirectory = durability.syncDirectory ?? syncPath;
  const syncFile = durability.syncFile ?? syncPath;
  const readFile =
    durability.readFile ?? ((target: string) => fs.readFile(target, "utf-8"));
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

  // --- Locks -------------------------------------------------------------
  const lockTails = new Map<string, Promise<void>>();
  const INDEX_LOCK = "\u0000index";

  async function acquire(key: string): Promise<() => void> {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    lockTails.set(key, tail);
    await previous;
    return () => {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    };
  }

  async function withLocks<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
    onAcquired?: () => void,
  ): Promise<T> {
    // A stable acquisition order keeps multi-chat operations deadlock-free.
    const releases: Array<() => void> = [];
    try {
      for (const key of [...new Set(keys)].sort()) releases.push(await acquire(key));
      onAcquired?.();
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    return withLocks([INDEX_LOCK], operation);
  }

  // --- Verified in-memory index ------------------------------------------
  let memo: ChatMeta[] | null = null;
  let memoStamp: string | null = null;

  function invalidateIndexMemo(): void {
    memo = null;
    memoStamp = null;
  }

  async function currentIndexStamp(): Promise<string | null> {
    try {
      const stat = await fs.stat(await indexPath(), { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // --- Shared operations and exclusive maintenance ------------------------
  let initialized = false;
  let reconcileNeeded = false;
  let exclusive = false;
  let activeShared = 0;
  let drainWaiters: Array<() => void> = [];
  let maintenance: Promise<void> | null = null;

  function maintenanceNeeded(needsIndex: boolean): boolean {
    return (
      !initialized ||
      reconcileNeeded ||
      pendingDirectorySync !== undefined ||
      (needsIndex && memo === null)
    );
  }

  async function drained(): Promise<void> {
    if (activeShared === 0) return;
    await new Promise<void>((resolve) => drainWaiters.push(resolve));
  }

  async function runMaintenance(needsIndex: boolean): Promise<void> {
    await drained();
    exclusive = true;
    try {
      await retryPendingDirectorySync();
      if (!initialized) {
        // Only crash leftovers can exist before this process has written, and
        // nothing else is writing now, so no live writer's stage is touched.
        await removeCrashLeftStages(await resolveChatsDir());
      }
      if (!initialized || reconcileNeeded) {
        await reconcileChatTransactions();
      }
      initialized = true;
      reconcileNeeded = false;
      if (needsIndex && memo === null) await readIndex("exclusive");
    } finally {
      exclusive = false;
    }
  }

  async function enterShared(needsIndex: boolean, maintain = true): Promise<void> {
    let stampChecked = false;
    let maintained = false;
    for (;;) {
      if (maintenance) {
        // Whoever started maintenance reports its failure; others re-evaluate.
        await maintenance.catch(() => undefined);
        continue;
      }
      if (maintain && !maintained && maintenanceNeeded(needsIndex)) {
        const run = runMaintenance(needsIndex);
        const tracked = run.then(
          () => {
            maintenance = null;
          },
          (error: unknown) => {
            maintenance = null;
            throw error;
          },
        );
        maintenance = tracked;
        await tracked;
        maintained = true;
        continue;
      }
      if (maintain && needsIndex && memo !== null && !stampChecked) {
        // Detect an index.json changed behind this process's back.
        stampChecked = true;
        const stamp = await currentIndexStamp().catch(() => "unreadable");
        if (memo !== null && stamp !== memoStamp) {
          invalidateIndexMemo();
          maintained = false;
        }
        continue;
      }
      activeShared += 1;
      return;
    }
  }

  function leaveShared(): void {
    activeShared -= 1;
    if (activeShared === 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  // enterShared() awaits file I/O whose completions are not FIFO, so without an
  // admission queue a later call on a chat could take that chat's lock first.
  const admissionTails = new Map<string, Promise<void>>();

  async function shared<T>(
    chatIds: readonly string[],
    needsIndex: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(chatIds)];
    const prior = keys.map((key) => admissionTails.get(key));
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    for (const key of keys) admissionTails.set(key, admitted);
    const finishAdmission = () => {
      admit();
      for (const key of keys) {
        if (admissionTails.get(key) === admitted) admissionTails.delete(key);
      }
    };
    try {
      await Promise.all(prior);
      await enterShared(needsIndex);
    } catch (error) {
      finishAdmission();
      throw error;
    }
    try {
      return await withLocks(chatIds, operation, finishAdmission);
    } finally {
      finishAdmission();
      leaveShared();
    }
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
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
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
      (meta.workspaceId === undefined ||
        typeof meta.workspaceId === "string") &&
      (meta.botId === undefined ||
        (typeof meta.botId === "string" &&
          meta.botId.length > 0 &&
          meta.botId.length <= 160 &&
          meta.botId.normalize("NFKC") === meta.botId &&
          SAFE_CHAT_ID.test(meta.botId))) &&
      (meta.owner === undefined ||
        (parseChatOwnerV1(meta.owner) !== undefined && meta.botId === undefined)) &&
      (meta.providerId === undefined || typeof meta.providerId === "string") &&
      (meta.model === undefined || typeof meta.model === "string") &&
      (meta.preview === undefined ||
        (typeof meta.preview === "string" &&
          Array.from(meta.preview).length <= MAX_CHAT_META_PREVIEW_CHARS &&
          Buffer.byteLength(meta.preview, "utf8") <= MAX_CHAT_META_PREVIEW_BYTES)) &&
      (meta.summaryRevision === undefined ||
        isChatSummaryRevision(meta.summaryRevision)) &&
      (meta.lastAssistantSequence === undefined ||
        (typeof meta.lastAssistantSequence === "number" &&
          Number.isSafeInteger(meta.lastAssistantSequence) && meta.lastAssistantSequence >= 0)) &&
      (meta.lastAssistantAt === undefined ||
        (typeof meta.lastAssistantAt === "number" &&
          Number.isSafeInteger(meta.lastAssistantAt) &&
          meta.lastAssistantAt >= 0)) &&
      (meta.forkedFrom === undefined || parseChatForkLineageV1(meta.forkedFrom) !== undefined)
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

  async function removeStagedFileDurably(
    staged: string,
    directory: string,
  ): Promise<void> {
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
    const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
    const staged = path.join(
      directory,
      `.${path.basename(target)}.${randomUUID()}.${purpose}.tmp`,
    );
    // Whatever happens below, the previous memo no longer describes the file.
    invalidateIndexMemo();
    try {
      await fs.writeFile(staged, JSON.stringify(sorted), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      await syncFile(staged);
      await fs.rename(staged, target);
      await syncDirectoryDurably(directory);
    } finally {
      await removeStagedFileDurably(staged, directory);
    }
    memo = sorted;
    memoStamp = await currentIndexStamp();
    for (const listener of [...indexListeners]) {
      try {
        listener();
      } catch {
        // Observers are best-effort signals; the durable write already succeeded.
      }
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
    policy: ReadPolicy,
    quarantineExisting: boolean,
    seed: readonly ChatMeta[] = [],
  ): Promise<ChatMeta[]> {
    const target = await indexPath();
    const directory = path.dirname(target);

    const recovered = new Map<string, ChatMeta>();
    // A schema-valid index entry is only a recovery-order hint. Reconstruct it
    // from the exact same-ID payload so missing or mismatched seed entries can
    // never survive as metadata ghosts.
    for (const meta of seed) {
      const chat = await readChat(meta.id, policy);
      if (!chat || chat.id !== meta.id) continue;
      const recoveredMeta = metaOf(chat);
      if (isValidMeta(recoveredMeta))
        recovered.set(recoveredMeta.id, recoveredMeta);
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
      const chat = await readChat(id, policy);
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
      const quarantine = path.join(
        directory,
        `.${path.basename(target)}.${randomUUID()}.corrupt`,
      );
      try {
        await fs.rename(target, quarantine);
        await syncDirectoryDurably(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!quarantineExisting && resolved.length === 0) {
      // A fresh store: there is nothing to persist until the first chat lands.
      memo = [];
      memoStamp = await currentIndexStamp();
      return [];
    }
    await writeIndex(resolved);
    return resolved;
  }

  /**
   * Full verification: bind every index entry to its payload. Runs only when
   * no verified in-memory index exists (startup, external edits, failures).
   */
  async function readIndex(policy: ReadPolicy): Promise<ChatMeta[]> {
    const target = await indexPath();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(target)) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return recoverIndex(policy, false);
      if (error instanceof SyntaxError) return recoverIndex(policy, true);
      throw error;
    }
    if (!Array.isArray(parsed)) return recoverIndex(policy, true);
    const valid = parsed.filter(isValidMeta);
    if (valid.length !== parsed.length) return recoverIndex(policy, true, valid);

    const canonical = new Map<string, ChatMeta>();
    // Schema validity is not existence or ownership. Bind every entry to its
    // exact same-ID payload and derive all list metadata from that validated
    // payload so a valid-looking stale index cannot expose a ghost title or
    // workspace.
    for (const indexed of valid) {
      const chat = await readChat(indexed.id, policy);
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
    } else {
      memo = [...resolved];
      memoStamp = await currentIndexStamp();
    }
    return resolved.map((meta) => ({ ...meta }));
  }

  /** The verified index. Callers hold the index lock or run exclusively. */
  async function loadIndex(): Promise<ChatMeta[]> {
    if (memo) return memo.map((meta) => ({ ...meta }));
    return readIndex(exclusive ? "exclusive" : "pure");
  }

  /**
   * Read the metadata projection directly. Unlike readIndex(), this deliberately
   * does not bind rows back to payload files: summary consumers must never turn
   * a list operation into N transcript reads. Normal mutations and the durable
   * transaction journal remain responsible for keeping the index authoritative.
   */
  async function readSummaryIndex(): Promise<ChatMeta[]> {
    const target = await indexPath();
    let source: string;
    try {
      source = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const directory = path.dirname(target);
        let entries: Array<{
          isFile(): boolean;
          isSymbolicLink(): boolean;
          name: string;
        }>;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (directoryError) {
          if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw directoryError;
        }
        const hasUnindexedChatState = entries.some((entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          (CHAT_TRANSACTION.test(entry.name) ||
            (entry.name !== INDEX && !entry.name.startsWith(".") && entry.name.endsWith(".json"))),
        );
        if (!hasUnindexedChatState) return [];
        throw new Error("The chat summary index is unavailable.");
      }
      throw error;
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SUMMARY_INDEX_BYTES) {
      throw new Error("The chat summary index is too large.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error("The chat summary index is unavailable.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_SUMMARY_INDEX_ENTRIES ||
      !parsed.every(isValidMeta)
    ) {
      throw new Error("The chat summary index is unavailable.");
    }
    const ids = new Set<string>();
    for (const entry of parsed) {
      if (ids.has(entry.id)) throw new Error("The chat summary index is unavailable.");
      ids.add(entry.id);
    }
    const migrated = parsed.map((entry) => ({
      ...entry,
      workspaceId: entry.workspaceId ?? DEFAULT_WORKSPACE_ID,
      summaryRevision: chatSummaryRevision(entry),
    }));
    // A bounded, metadata-only legacy migration. It enriches old rows without
    // opening payload files and makes subsequent summary reads constant-work.
    if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
      await writeIndex(migrated);
      // These rows were not bound to payloads; verify before trusting them.
      invalidateIndexMemo();
    }
    return migrated;
  }

  async function removeFromIndexDurably(id: string): Promise<void> {
    await withIndexLock(async () => {
      const next = (await loadIndex()).filter((entry) => entry.id !== id);
      await writeIndexDurably(next, "chat-delete");
    });
  }

  async function quarantinePayload(id: string, policy: ReadPolicy): Promise<void> {
    const payload = await chatPath(id);
    const directory = path.dirname(payload);
    const quarantine = path.join(
      directory,
      `.${path.basename(payload)}.${randomUUID()}.corrupt`,
    );
    try {
      await fs.rename(payload, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await syncDirectoryDurably(directory);
    durability.onQuarantine?.();
    if (policy === "owner") {
      await withIndexLock(async () => {
        const index = await loadIndex();
        const next = index.filter((entry) => entry.id !== id);
        if (next.length !== index.length) await writeIndex(next);
      });
    }
  }

  async function countQuarantinedPayloads(): Promise<number> {
    try {
      const entries = await fs.readdir(await resolveChatsDir());
      return entries.filter((name) => QUARANTINED_PAYLOAD.test(name)).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  /** Whether an earlier read set aside unreadable bytes for this chat ID. */
  async function hasQuarantinedPayload(id: string): Promise<boolean> {
    const prefix = `.${path.basename(await chatPath(id))}.`;
    try {
      const entries = await fs.readdir(await resolveChatsDir());
      return entries.some((name) => name.startsWith(prefix) && QUARANTINED_PAYLOAD.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function readChat(id: string, policy: ReadPolicy): Promise<Chat | null> {
    let data: string;
    try {
      data = await readFile(await chatPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // An unreadable payload means the verified index may be wrong too; the
      // next index read re-verifies against disk and surfaces the failure.
      if (policy === "owner") invalidateIndexMemo();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Torn or garbled bytes: move them aside intact rather than leaving a
      // file a later same-ID write could replace.
      if (policy !== "pure") await quarantinePayload(id, policy);
      return null;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "forkedFrom")
    ) {
      // Lineage is display-only provenance: a damaged value is dropped rather
      // than hiding the whole transcript.
      const record = parsed as Record<string, unknown>;
      const lineage = parseChatForkLineageV1(record.forkedFrom);
      if (lineage) record.forkedFrom = lineage;
      else delete record.forkedFrom;
    }
    const messages = (parsed as { messages?: unknown } | null)?.messages;
    if (
      policy !== "pure" &&
      (parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Array.isArray(messages))
    ) {
      await quarantinePayload(id, policy);
      return null;
    }
    if (
      !isValidMeta(parsed) ||
      parsed.id !== id ||
      !Array.isArray(messages) ||
      !messages.every(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          !Array.isArray(message),
      )
    ) {
      return null;
    }
    const chat = parsed as unknown as Chat;
    const providerId = await resolveProviderId(chat.providerId);
    const migratedProvider = providerId !== chat.providerId;
    if (migratedProvider) chat.providerId = providerId;
    let privacyMigrationRequired = false;
    chat.messages = chat.messages.map((message) => {
      const assistant = message.role === "assistant";
      const providerFailure = assistant
        ? parseProviderFailureV1(message.providerFailure) ??
          providerFailureFromLegacyPiMessage(message.pi)
        : undefined;
      if (assistant) {
        const pi =
          message.pi && typeof message.pi === "object" && !Array.isArray(message.pi)
            ? (message.pi as unknown as Record<string, unknown>)
            : undefined;
        if (
          pi &&
          (Object.prototype.hasOwnProperty.call(pi, "diagnostics") ||
            Object.prototype.hasOwnProperty.call(pi, "errorMessage"))
        ) {
          privacyMigrationRequired = true;
        }
        if (
          JSON.stringify(message.providerFailure) !==
          JSON.stringify(providerFailure)
        ) {
          privacyMigrationRequired = true;
        }
      }
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        model: message.model,
        attachments: safeStoredAttachments(message.attachments),
        htmlArtifacts: assistant
          ? parseChatHtmlArtifacts(message.htmlArtifacts)
          : undefined,
        reasoning:
          assistant &&
          typeof message.reasoning === "string" &&
          message.reasoning.trim()
            ? message.reasoning
            : undefined,
        pi: assistant
          ? parseStoredPiAssistantMessage(message.pi)
          : undefined,
        providerFailure,
        timeline: assistant
          ? parseGenerationTimeline(message.timeline, message.content.length)
          : undefined,
        turnStats: assistant
          ? parseAssistantTurnStatsV1(message.turnStats)
          : undefined,
        subagents: assistant
          ? parseSubagentMessageReferenceV1(message.subagents)
          : undefined,
        skill:
          message.role === "user"
            ? parseSkillProvenanceV1(message.skill)
            : undefined,
      };
    });
    if (policy !== "pure") {
      if (privacyMigrationRequired) await writeChat(chat);
      else if (migratedProvider) await writeChat(chat).catch(() => undefined);
    }
    return chat;
  }

  async function writeChat(
    chat: Chat,
    beforeRename: () => void = () => undefined,
  ): Promise<void> {
    const target = await chatPath(chat.id);
    const directory = path.dirname(target);
    const staged = path.join(
      directory,
      `.${path.basename(target)}.${randomUUID()}.chat-write.tmp`,
    );
    try {
      // Compact JSON: indentation roughly doubled base64-heavy payloads.
      // Older indented files still parse.
      await fs.writeFile(staged, JSON.stringify(chat), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
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
    const preview = [...chat.messages]
      .reverse()
      .find((message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.content.trim().length > 0,
      )?.content;
    const lastAssistantReverseIndex = [...chat.messages]
      .reverse()
      .findIndex((message) =>
        message.role === "assistant" &&
        (message.content.trim().length > 0 ||
          (message.attachments?.length ?? 0) > 0 ||
          (message.htmlArtifacts?.length ?? 0) > 0) &&
        Number.isSafeInteger(message.createdAt) &&
        message.createdAt >= 0,
      );
    const lastAssistantSequence = lastAssistantReverseIndex < 0
      ? -1
      : chat.messages.length - 1 - lastAssistantReverseIndex;
    const lastAssistantAt = chat.messages[lastAssistantSequence]?.createdAt;
    const boundedPreview = preview === undefined
      ? undefined
      : Array.from(preview).slice(0, MAX_CHAT_META_PREVIEW_CHARS).join("");
    return {
      id: chat.id,
      title: chat.title,
      workspaceId: chat.workspaceId ?? DEFAULT_WORKSPACE_ID,
      ...(chat.botId ? { botId: chat.botId } : {}),
      ...(chat.owner ? { owner: chat.owner } : {}),
      providerId: chat.providerId,
      model: chat.model,
      ...(boundedPreview ? { preview: boundedPreview } : {}),
      summaryRevision: chatSummaryRevision(chat),
      ...(lastAssistantAt !== undefined ? { lastAssistantAt, lastAssistantSequence } : {}),
      ...(chat.forkedFrom ? { forkedFrom: indexedForkLineage(chat.forkedFrom) } : {}),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  /** The index keeps a summary's state, not its text; only the transcript needs that. */
  function indexedForkLineage(lineage: ChatForkLineageV1): ChatForkLineageV1 {
    if (!lineage.summary) return lineage;
    const { state, afterMessageId } = lineage.summary;
    return { ...lineage, summary: { state, afterMessageId } };
  }

  /** Patch only this chat's entry; never re-read other transcripts. */
  async function updateMeta(chat: Chat): Promise<void> {
    await withIndexLock(async () => {
      const index = await loadIndex();
      const idx = index.findIndex((entry) => entry.id === chat.id);
      if (idx >= 0) index[idx] = metaOf(chat);
      else index.push(metaOf(chat));
      await writeIndex(index);
    });
  }

  async function writeChatAndMeta(
    chat: Chat,
    beforeRename: () => void = () => undefined,
  ): Promise<void> {
    chat.summaryRevision = newChatSummaryRevision();
    await beginChatTransaction(chat.id);
    try {
      await writeChat(chat, beforeRename);
      await updateMeta(chat);
      await clearChatTransaction(chat.id);
    } catch (error) {
      // A marker may remain; reconcile it before the next operation.
      reconcileNeeded = true;
      throw error;
    }
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

    const index = await loadIndex();
    let changed = false;
    for (const id of transactionIds) {
      const chat = await readChat(id, "exclusive");
      const indexPosition = index.findIndex((entry) => entry.id === id);
      if (!chat || chat.id !== id) {
        if (indexPosition >= 0) {
          index.splice(indexPosition, 1);
          changed = true;
        }
        continue;
      }
      const nextMeta = metaOf(chat);
      if (
        indexPosition < 0 ||
        JSON.stringify(index[indexPosition]) !== JSON.stringify(nextMeta)
      ) {
        if (indexPosition < 0) index.push(nextMeta);
        else index[indexPosition] = nextMeta;
        changed = true;
      }
    }
    if (changed) await writeIndex(index);
    for (const id of transactionIds) await clearChatTransaction(id);
  }

  async function installNewChat(
    chat: Chat,
    assertCurrent?: () => void,
  ): Promise<Chat> {
    try {
      await writeChatAndMeta(chat, () => assertCurrent?.());
      return chat;
    } catch (createError) {
      let installed: Chat | null;
      try {
        installed = await readChat(chat.id, "owner");
      } catch {
        throw new ChatCreateReconciliationRequiredError(chat.id);
      }
      if (!installed) {
        try {
          await clearChatTransaction(chat.id);
        } catch {
          throw new ChatCreateReconciliationRequiredError(chat.id);
        }
        throw createError;
      }
      try {
        await updateMeta(installed);
        await clearChatTransaction(installed.id);
        return installed;
      } catch {
        throw new ChatCreateReconciliationRequiredError(chat.id);
      }
    }
  }

  return {
    /**
     * Observe committed summary-index writes (save, delete, metadata). Lets the
     * Remote host feed refresh without reading or scanning transcripts.
     */
    onIndexChanged(listener: () => void): () => void {
      indexListeners.add(listener);
      return () => indexListeners.delete(listener);
    },

    /** List chats, newest first. Legacy chats without a workspace fall under the default one. */
    async list(workspaceId?: string): Promise<ChatMeta[]> {
      return shared([], true, () => withIndexLock(async () => {
        const index = (await loadIndex()).map((meta) => ({
          ...meta,
          workspaceId: meta.workspaceId ?? DEFAULT_WORKSPACE_ID,
        }));
        const filtered = workspaceId
          ? index.filter((meta) => meta.workspaceId === workspaceId)
          : index;
        return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
      }));
    },

    /** Chats that may appear in chat listings: ordinary and Assistant chats, never Bot or feature-owned. */
    async listRegular(workspaceId?: string): Promise<ChatMeta[]> {
      return (await this.list(workspaceId)).filter((chat) => {
        const surface = chatSurface(chat);
        return surface === "regular" || surface === "assistant";
      });
    },

    /** Transcript-free metadata read for bounded Remote summary pages. */
    async listSummaryMetadata(): Promise<ChatMeta[]> {
      // Deliberately skips transaction reconciliation and payload binding.
      await enterShared(false, false);
      try {
        return await withIndexLock(async () => {
          await retryPendingDirectorySync();
          return readSummaryIndex();
        });
      } finally {
        leaveShared();
      }
    },

    async listByBot(botId: string): Promise<ChatMeta[]> {
      return (await this.list()).filter((chat) => chat.botId === botId);
    },

    /** Unreadable payloads moved aside (bytes intact) in the chats directory. */
    async quarantinedPayloadCount(): Promise<number> {
      return countQuarantinedPayloads();
    },

    async get(id: string): Promise<Chat | null> {
      return shared([id], false, () => readChat(id, "owner"));
    },

    /** Install the first user message and sidebar metadata as one recoverable transaction. */
    async createWithFirstMessage(input: {
      id: string;
      title?: string;
      workspaceId: string;
      providerId?: string;
      model?: string;
      computerUseEnabled: boolean;
      turnId: string;
      fingerprint: string;
      message: Pick<ChatMessage, "id" | "content" | "attachments" | "skill" | "model">;
      assertCurrent: () => void;
    }): Promise<Chat> {
      return shared([input.id], true, async () => {
        input.assertCurrent();
        // "pure": a corrupt payload at a colliding draft ID must stay in place
        // so the guard below rejects the collision instead of quarantining it.
        const existing = await readChat(input.id, "pure");
        if (existing) {
          if (existing.firstMessageCommit?.turnId !== input.turnId ||
              existing.firstMessageCommit.fingerprint !== input.fingerprint) {
            throw new Error("This draft identifier has already been used for a different message.");
          }
          return existing;
        }
        // readChat returns null for malformed payloads as well as missing
        // files. Never replace an unreadable existing conversation on an ID
        // collision; only a genuinely absent path may receive a new draft.
        try {
          await fs.lstat(await chatPath(input.id));
          throw new Error("This draft identifier belongs to an unreadable existing chat.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // The same holds once a read has quarantined that payload: its bytes
        // still belong to the earlier conversation, not to a new draft.
        if (await hasQuarantinedPayload(input.id)) {
          throw new Error("This draft identifier belongs to an unreadable existing chat.");
        }
        if (!input.message.content.trim() && !input.message.attachments?.length) {
          throw new Error("Add a message or attachment before sending.");
        }
        const now = Date.now();
        const message: ChatMessage = {
          id: input.message.id,
          role: "user",
          content: input.message.content,
          model: input.message.model,
          attachments: safeStoredAttachments(input.message.attachments),
          skill: parseSkillProvenanceV1(input.message.skill),
          createdAt: now,
        };
        const chat: Chat = {
          id: input.id,
          workspaceId: input.workspaceId,
          providerId: await resolveProviderId(input.providerId),
          model: input.model,
          computerUseEnabled: input.computerUseEnabled,
          title: input.title?.trim() || deriveChatTitleSeed(message),
          createdAt: now,
          updatedAt: now,
          messages: [message],
          firstMessageCommit: { turnId: input.turnId, fingerprint: input.fingerprint },
        };
        return installNewChat(chat, input.assertCurrent);
      });
    },

    async create(input: {
      id?: string;
      title?: string;
      workspaceId?: string;
      botId?: string;
      owner?: ChatOwnerV1;
      providerId?: string;
      model?: string;
      /** Main-owned Bot greeting copied once into the new durable conversation. */
      initialAssistantMessage?: string;
      assertCurrent?: () => void;
    }): Promise<Chat> {
      const id = input.id ?? newId();
      return shared([id], true, async () => {
        input.assertCurrent?.();
        const owner = input.owner === undefined ? undefined : parseChatOwnerV1(input.owner);
        if (input.owner !== undefined && (owner === undefined || input.botId !== undefined)) {
          throw new Error("Invalid chat owner.");
        }
        if (
          input.initialAssistantMessage !== undefined &&
          !isBoundedBotText(input.initialAssistantMessage, 2_000)
        ) {
          throw new Error("Invalid initial Bot greeting.");
        }
        const now = Date.now();
        const openingGreeting = input.initialAssistantMessage?.trim();
        const chat: Chat = {
          id,
          title: input.title?.trim() || DEFAULT_CHAT_TITLE,
          workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
          ...(input.botId ? { botId: input.botId } : {}),
          ...(owner ? { owner } : {}),
          providerId: await resolveProviderId(input.providerId),
          model: input.model,
          createdAt: now,
          updatedAt: now,
          messages: openingGreeting
            ? [{
                id: randomUUID(),
                role: "assistant",
                content: openingGreeting,
                createdAt: now,
              }]
            : [],
        };
        return installNewChat(chat, input.assertCurrent);
      });
    },

    /** Copy only visible linear history; private runtime fields never enter the new payload. */
    async copyVisibleHistory(input: {
      sourceChatId: string;
      /** Main-owned target identity used by recoverable Bot-copy workflows. */
      targetChatId?: string;
      /** Main-owned destination for copies that move legacy Bot history into its hidden home. */
      targetWorkspaceId?: string;
      expectedWorkspaceId?: string;
      /** Legacy cut used by Bot copies: through a settled assistant reply, without lineage. */
      throughAssistantMessageId?: string;
      /** Fork cut that records `forkedFrom` lineage on the new chat. */
      forkAt?: { messageId: string; position: ChatForkPosition };
      /** Start the fork with a pending summary of the source after the cut. */
      forkSummary?: { instructions?: string };
      assertCurrent?: () => void;
      /** Check the source under the copy lock, for example against a client's revision. */
      assertSource?: (source: Chat) => void;
      /**
       * Prepare dependent durable records before this chat becomes visible.
       * `sourceMessageIds[i]` is the source message copied into `chat.messages[i]`.
       */
      beforeInstall?: (
        chat: Chat,
        sourceMessageIds: readonly string[],
      ) => void | Promise<void>;
    }): Promise<Chat> {
      const newChatId = input.targetChatId ?? randomUUID();
      return shared([input.sourceChatId, newChatId], true, async () => {
        input.assertCurrent?.();
        const source = await readChat(input.sourceChatId, "owner");
        if (!source) throw new ChatForkError("not_found", `Chat ${input.sourceChatId} not found`);
        if (source.owner !== undefined) {
          throw new ChatForkError(
            "ineligible",
            "This chat belongs to another Aiden feature and cannot be copied.",
          );
        }
        input.assertSource?.(source);
        if (
          input.expectedWorkspaceId !== undefined &&
          (source.workspaceId ?? DEFAULT_WORKSPACE_ID) !==
            input.expectedWorkspaceId
        ) {
          throw new Error(
            "The chat workspace changed before it could be copied.",
          );
        }

        const cut =
          input.forkAt ??
          (input.throughAssistantMessageId !== undefined
            ? { messageId: input.throughAssistantMessageId, position: "after" as const }
            : undefined);
        // Inclusive index of the last copied message.
        let throughIndex = source.messages.length - 1;
        if (cut?.position === "after") {
          throughIndex = source.messages.findIndex(
            (message) => message.id === cut.messageId && message.role === "assistant",
          );
          if (throughIndex < 0) {
            throw new ChatForkError(
              source.messages.some((message) => message.id === cut.messageId)
                ? "ineligible"
                : "message_not_found",
              "Choose a completed assistant turn to fork from.",
            );
          }
        } else if (cut?.position === "before") {
          const userIndex = source.messages.findIndex(
            (message) => message.id === cut.messageId && message.role === "user",
          );
          if (userIndex < 0) {
            throw new ChatForkError(
              source.messages.some((message) => message.id === cut.messageId)
                ? "ineligible"
                : "message_not_found",
              "Choose one of your messages to edit in a fork.",
            );
          }
          throughIndex = userIndex - 1;
        }
        if (cut) {
          let hasVisibleUser = false;
          for (let index = 0; index <= throughIndex; index += 1) {
            if (source.messages[index]?.role === "user") {
              hasVisibleUser = true;
              break;
            }
          }
          if (!hasVisibleUser) {
            throw new ChatForkError(
              "ineligible",
              cut.position === "before"
                ? "Nothing comes before the first message to fork."
                : "The selected turn has no user message to copy.",
            );
          }
        }

        if (input.forkSummary && (!input.forkAt || source.botId)) {
          throw new ChatForkError("ineligible", "Only a fork can carry a summary.");
        }
        if (input.forkSummary && throughIndex >= source.messages.length - 1) {
          throw new ChatForkError("ineligible", "Nothing happened after this point to summarize.");
        }

        const copiedMessages: ChatMessage[] = [];
        const sourceMessageIds: string[] = [];
        let chargedBytes = 0;
        const charge = (value: string | undefined) => {
          if (value === undefined) return;
          const remaining = MAX_VISIBLE_COPY_BYTES - chargedBytes;
          if (value.length > remaining) {
            throw new ChatForkError("too_large", "This chat is too large to copy safely.");
          }
          chargedBytes += jsonStringBytesBounded(value, remaining);
          if (chargedBytes > MAX_VISIBLE_COPY_BYTES) {
            throw new ChatForkError("too_large", "This chat is too large to copy safely.");
          }
        };
        const metadata = projectVisibleChatMetadata(source);
        let title: string;
        if (cut) {
          const destinationWorkspaceId =
            input.targetWorkspaceId ?? metadata.workspaceId ?? DEFAULT_WORKSPACE_ID;
          const siblings = (await withIndexLock(() => loadIndex())).filter(
            (entry) => (entry.workspaceId ?? DEFAULT_WORKSPACE_ID) === destinationWorkspaceId,
          );
          title = nextForkTitle(metadata.title, siblings.map((entry) => entry.title));
        } else {
          const suffix = " (copy)";
          const maximumBaseLength = Math.max(1, 120 - suffix.length);
          title = `${Array.from(
            metadata.title.slice(0, maximumBaseLength * 2),
          )
            .slice(0, maximumBaseLength)
            .join("")}${suffix}`;
        }
        chargedBytes += 1_024;
        charge(title);
        charge(input.targetWorkspaceId ?? metadata.workspaceId);
        charge(metadata.providerId);
        charge(metadata.model);
        for (let index = 0; index <= throughIndex; index += 1) {
          const sourceMessage = source.messages[index];
          const message = projectVisibleChatMessage(sourceMessage);
          if (!message) continue;
          if (copiedMessages.length >= MAX_VISIBLE_COPY_MESSAGES) {
            throw new ChatForkError("too_large", "This chat has too many messages to copy safely.");
          }
          chargedBytes += 512;
          charge(message.content);
          charge(message.model);
          charge(message.skill?.name);
          for (const attachment of message.attachments ?? []) {
            chargedBytes += 256;
            charge(attachment.id);
            charge(attachment.name);
            charge(attachment.mimeType);
            charge(
              attachment.kind === "image" ? attachment.data : attachment.text,
            );
          }
          for (const artifact of message.htmlArtifacts ?? []) {
            chargedBytes += 128;
            charge(artifact.title);
            charge(artifact.mediaId);
          }
          if (chargedBytes > MAX_VISIBLE_COPY_BYTES) {
            throw new ChatForkError("too_large", "This chat is too large to copy safely.");
          }
          sourceMessageIds.push(message.id);
          copiedMessages.push({
            id: randomUUID(),
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            model: message.model,
            attachments: safeStoredAttachments(message.attachments),
            htmlArtifacts:
              message.role === "assistant"
                ? (message.htmlArtifacts ?? []).map((artifact) => {
                    const mediaId = remappedHtmlArtifactMediaId(newChatId, artifact.mediaId);
                    return { ...artifact, mediaId };
                  })
                : undefined,
            skill:
              message.role === "user"
                ? parseSkillProvenanceV1(message.skill)
                : undefined,
            providerFailure:
              message.role === "assistant"
                ? parseProviderFailureV1(message.providerFailure)
                : undefined,
          });
        }
        const now = Date.now();
        const copied: Chat = {
          id: newChatId,
          title,
          workspaceId:
            input.targetWorkspaceId ?? metadata.workspaceId ?? DEFAULT_WORKSPACE_ID,
          botId: source.botId,
          providerId: metadata.providerId,
          model: metadata.model,
          ...(input.forkAt && !source.botId
            ? {
                forkedFrom: {
                  chatId: source.id,
                  messageId: input.forkAt.messageId,
                  position: input.forkAt.position,
                  at: now,
                  ...(input.forkSummary
                    ? {
                        summary: {
                          state: "pending" as const,
                          afterMessageId: copiedMessages[copiedMessages.length - 1]!.id,
                          ...(input.forkSummary.instructions
                            ? { instructions: input.forkSummary.instructions }
                            : {}),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          createdAt: now,
          updatedAt: now,
          messages: copiedMessages,
        };
        await input.beforeInstall?.(copied, sourceMessageIds);
        return installNewChat(copied, input.assertCurrent);
      });
    },

    async rename(
      id: string,
      title: string,
      assertCurrent: (chat: Chat) => void | Promise<void> = () => undefined,
    ): Promise<Chat> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) throw new Error(`Chat ${id} not found`);
        await assertCurrent(chat);
        chat.title = title.trim() || chat.title;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /**
     * Move a fork's summary through its lifecycle. `next` sees the current
     * summary and returns the replacement, `undefined` to drop it, or `null`
     * to leave the chat untouched (returned as null). Not a user edit, so
     * `updatedAt` and the sidebar order stay put.
     */
    async updateForkSummary(
      id: string,
      next: (summary: ChatForkSummaryV1 | undefined, chat: Chat) => ChatForkSummaryV1 | undefined | null,
    ): Promise<Chat | null> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat?.forkedFrom) return null;
        const summary = next(chat.forkedFrom.summary, chat);
        if (summary === null) return null;
        const { summary: _previous, ...lineage } = chat.forkedFrom;
        chat.forkedFrom = summary ? { ...lineage, summary } : lineage;
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /** Apply an asynchronous rename only when no newer rename won the race. */
    async replaceTitleIfUnchanged(
      id: string,
      expectedTitle: string,
      title: string,
    ): Promise<Chat | null> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
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
    async moveEmptyChatToWorkspace(
      id: string,
      workspaceId: string,
      assertCurrent: (chat: Chat) => void | Promise<void> = () => undefined,
    ): Promise<Chat> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) throw new Error(`Chat ${id} not found`);
        await assertCurrent(chat);
        if (chat.messages.length > 0) {
          throw new Error("Only a new chat can change workspaces.");
        }
        chat.workspaceId = workspaceId;
        chat.updatedAt = Date.now();
        await writeChatAndMeta(chat);
        return chat;
      });
    },

    /**
     * Change the durable provider/model authority for an existing Bot chat
     * without rewriting or reordering its conversation history.
     */
    async setBotModelSelection(
      id: string,
      providerId: string,
      model: string,
      assertCurrent: (chat: Chat) => void | Promise<void> = () => undefined,
    ): Promise<Chat> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) throw new Error(`Chat ${id} not found`);
        await assertCurrent(chat);
        if (!chat.botId) throw new Error("Only a Bot chat can change its Bot model authority.");
        const resolvedProviderId = await resolveProviderId(providerId);
        if (!resolvedProviderId || !model.trim()) {
          throw new Error("A Bot model selection requires a provider and model.");
        }
        if (chat.providerId === resolvedProviderId && chat.model === model) return chat;
        chat.providerId = resolvedProviderId;
        chat.model = model;
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
      return shared([id], false, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) throw new Error(`Chat ${id} not found`);
        if (!isCurrent())
          throw new Error("The renderer document is no longer active.");
        chat.computerUseEnabled = enabled;
        await writeChat(chat, () => {
          // No await occurs between this ownership check and invoking the
          // atomic rename, so a replaced document cannot commit the staged opt-in.
          if (!isCurrent())
            throw new Error("The renderer document is no longer active.");
        });
        return chat;
      });
    },

    /**
     * Empty a chat's transcript in place, keeping its identity, title, owner
     * and model. Returns false when the chat is missing or already empty.
     */
    async clearMessages(
      id: string,
      assertCurrent: (chat: Chat) => void | Promise<void> = () => undefined,
    ): Promise<boolean> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) return false;
        await assertCurrent(chat);
        if (chat.messages.length === 0 && chat.forkedFrom === undefined) return false;
        chat.messages = [];
        delete chat.forkedFrom;
        await writeChatAndMeta(chat);
        return true;
      });
    },

    async remove(
      id: string,
      assertCurrent?: (chat: Chat | null) => void | Promise<void>,
    ): Promise<void> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (assertCurrent) await assertCurrent(chat);
        const payload = await chatPath(id);
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
      message: Omit<ChatMessage, "id" | "createdAt"> & {
        id?: string;
        createdAt?: number;
      },
      meta?: {
        providerId?: string;
        model?: string;
        autoTitle?: boolean;
        expectedWorkspaceId?: string;
        isCurrent?: () => boolean;
      },
    ): Promise<Chat> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat) throw new Error(`Chat ${id} not found`);
        if (meta?.isCurrent && !meta.isCurrent()) {
          throw new Error("The renderer document is no longer active.");
        }
        if (
          meta?.expectedWorkspaceId !== undefined &&
          (chat.workspaceId ?? DEFAULT_WORKSPACE_ID) !==
            meta.expectedWorkspaceId
        ) {
          throw new Error(
            "The chat workspace changed before the message could be saved.",
          );
        }
        if (message.role === "user" && forkSummaryHoldsSend(chat.forkedFrom)) {
          throw new Error(FORK_SUMMARY_HOLD_MESSAGE);
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
          pi:
            message.role === "assistant"
              ? parseStoredPiAssistantMessage(message.pi)
              : undefined,
          providerFailure:
            message.role === "assistant"
              ? parseProviderFailureV1(message.providerFailure)
              : undefined,
          attachments: safeStoredAttachments(message.attachments),
          htmlArtifacts:
            message.role === "assistant"
              ? parseChatHtmlArtifacts(message.htmlArtifacts)
              : undefined,
          skill:
            message.role === "user"
              ? parseSkillProvenanceV1(message.skill)
              : undefined,
          timeline:
            message.role === "assistant"
              ? parseGenerationTimeline(message.timeline, message.content.length)
              : undefined,
          turnStats:
            message.role === "assistant"
              ? parseAssistantTurnStatsV1(message.turnStats)
              : undefined,
          subagents:
            message.role === "assistant"
              ? parseSubagentMessageReferenceV1(message.subagents)
              : undefined,
          createdAt: message.createdAt ?? Date.now(),
        };
        const isFirstUserMessage =
          full.role === "user" &&
          !chat.messages.some((entry) => entry.role === "user");
        chat.messages.push(full);
        chat.updatedAt = Date.now();
        if (meta?.providerId) chat.providerId = meta.providerId;
        if (meta?.model) chat.model = meta.model;
        if (
          meta?.autoTitle &&
          isFirstUserMessage &&
          isDefaultChatTitle(chat.title)
        ) {
          chat.title = deriveChatTitleSeed(full);
        }
        await writeChatAndMeta(chat, () => {
          if (meta?.isCurrent && !meta.isCurrent()) {
            throw new Error("The renderer document is no longer active.");
          }
        });
        return chat;
      });
    },

    /** Replace only the untouched first-message seed, preserving any manual rename. */
    async replaceAutoTitle(
      id: string,
      expectedSeed: string,
      title: string,
    ): Promise<Chat | null> {
      return shared([id], true, async () => {
        const chat = await readChat(id, "owner");
        if (!chat || !canReplaceGeneratedChatTitle(chat.title, expectedSeed))
          return null;
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
