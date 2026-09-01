import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildProjectedPiV4Context,
  decodeLegacyPiSession,
  projectLegacyPiMigration,
  verifyLegacyPiMigration,
  type LegacyPiEntry,
} from "./pi-legacy-session.js";
import { createCurrentPiSessionRepository } from "./pi-session-repository-port.js";

export const PI_SESSION_MIGRATION_RECEIPT_VERSION = 1 as const;

export interface PiSessionMigrationReceipt {
  version: typeof PI_SESSION_MIGRATION_RECEIPT_VERSION;
  chatId: string;
  oldFormat: string;
  newFormat: string;
  sourceSha256: string;
  promotedPath: string;
  backupPath: string;
  counts: {
    entries: number;
    messages: number;
    compactions: number;
    customEntries: number;
    abandonedEntries: number;
  };
  validation: "passed" | "failed";
  createdAt: string;
}

export interface PiSessionMigrationResult {
  receipt: PiSessionMigrationReceipt;
  receiptPath: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Parse the content-free receipt strictly before it reaches rollout logic. */
export function parsePiSessionMigrationReceipt(value: unknown): PiSessionMigrationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Pi session migration receipt.");
  }
  const receipt = value as Partial<PiSessionMigrationReceipt>;
  const counts = receipt.counts as Partial<PiSessionMigrationReceipt["counts"]> | undefined;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = [
    "backupPath",
    "chatId",
    "counts",
    "createdAt",
    "newFormat",
    "oldFormat",
    "promotedPath",
    "sourceSha256",
    "validation",
    "version",
  ].sort();
  const countKeys = counts ? Object.keys(counts).sort() : [];
  const expectedCountKeys = [
    "abandonedEntries",
    "compactions",
    "customEntries",
    "entries",
    "messages",
  ].sort();
  const promotedPath = typeof receipt.promotedPath === "string" ? receipt.promotedPath : "";
  const backupPath = typeof receipt.backupPath === "string" ? receipt.backupPath : "";
  const categorizedEntries = counts
    ? Number(counts.messages) + Number(counts.compactions) + Number(counts.customEntries)
    : Number.POSITIVE_INFINITY;
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    JSON.stringify(countKeys) !== JSON.stringify(expectedCountKeys) ||
    receipt.version !== PI_SESSION_MIGRATION_RECEIPT_VERSION ||
    !nonEmpty(receipt.chatId) ||
    receipt.oldFormat !== "pi-session-v3" ||
    receipt.newFormat !== "pi-session-v4" ||
    typeof receipt.sourceSha256 !== "string" ||
    !SHA256.test(receipt.sourceSha256) ||
    !nonEmpty(receipt.promotedPath) ||
    !nonEmpty(receipt.backupPath) ||
    !counts ||
    !count(counts.entries) ||
    !count(counts.messages) ||
    !count(counts.compactions) ||
    !count(counts.customEntries) ||
    !count(counts.abandonedEntries) ||
    categorizedEntries > counts.entries ||
    counts.abandonedEntries > counts.entries ||
    !path.isAbsolute(promotedPath) ||
    !path.isAbsolute(backupPath) ||
    path.resolve(promotedPath) === path.resolve(backupPath) ||
    (receipt.validation !== "passed" && receipt.validation !== "failed") ||
    !nonEmpty(receipt.createdAt) ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    throw new Error("Invalid Pi session migration receipt.");
  }
  return structuredClone(receipt as PiSessionMigrationReceipt);
}

function timestamp(value: string, subject: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The legacy Pi journal has an invalid ${subject} timestamp.`);
  }
  return parsed;
}

function sourceHash(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function durableWrite(filePath: string, contents: string | Buffer): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function durableCopy(
  source: string,
  destination: string,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  await copyFile(source, destination, options.exclusive ? fsConstants.COPYFILE_EXCL : 0);
  await chmod(destination, 0o600);
  const handle = await open(destination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(destination));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readValidBackup(
  backupPath: string,
  expectedSha256?: string,
): Promise<Buffer<ArrayBuffer>> {
  const info = await lstat(backupPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("The Pi v3 rollback backup is not a private regular file.");
  }
  const contents = await readFile(backupPath);
  if (expectedSha256 !== undefined && sourceHash(contents) !== expectedSha256) {
    throw new Error("The Pi v3 rollback backup no longer matches its receipt.");
  }
  decodeLegacyPiSession(contents.toString("utf8"));
  return contents;
}

function customMessage(entry: LegacyPiEntry): AgentMessage {
  return {
    role: "custom",
    customType: entry.customType as string,
    content: entry.content as AgentMessage & never,
    display: entry.display as boolean,
    ...(entry.details === undefined ? {} : { details: entry.details }),
    timestamp: timestamp(entry.timestamp, `entry ${entry.id}`),
  } as AgentMessage;
}

function encodeV4Journal(contents: string): {
  journal: string;
  receiptCounts: PiSessionMigrationReceipt["counts"];
  createdAt: number;
  cwd: string;
  metadata?: Record<string, unknown>;
  parentSessionPath?: string;
  leafId: string | null;
} {
  const legacy = decodeLegacyPiSession(contents);
  if (legacy.tornFinalLine) {
    // The decoder has already proved that the complete prefix is valid. The
    // exact original bytes remain in the v3 backup for rollback evidence.
  }
  const verification = verifyLegacyPiMigration(contents);
  const projection = projectLegacyPiMigration(legacy);
  const mutations: Array<Record<string, unknown>> = [];
  let seq = 1;
  const retainedIds = new Set(
    projection.entries
      .filter((entry) => !["leaf", "label", "session_info"].includes(entry.type))
      .map((entry) => entry.id),
  );
  for (const entry of projection.entries) {
    if (entry.type === "leaf") continue;
    if (entry.type === "label") {
      if (!retainedIds.has(entry.targetId as string)) {
        throw new Error("The legacy Pi journal label points at an omitted entry.");
      }
      mutations.push({
        kind: "fact",
        seq: seq++,
        fact: "label",
        targetId: entry.targetId,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      });
      continue;
    }
    if (entry.type === "session_info") {
      mutations.push({
        kind: "fact",
        seq: seq++,
        fact: "name",
        ...(entry.name === undefined ? {} : { name: entry.name }),
      });
      continue;
    }
    const { timestamp: legacyTimestamp, ...fields } = entry;
    const converted =
      entry.type === "custom_message"
        ? {
            type: "message",
            id: entry.id,
            parentId: entry.parentId,
            message: customMessage(entry),
          }
        : fields;
    mutations.push({
      kind: "entry",
      seq: seq++,
      ...structuredClone(converted),
      timestamp: timestamp(legacyTimestamp, `entry ${entry.id}`),
    });
  }
  if (legacy.leafId !== null && !retainedIds.has(legacy.leafId)) {
    throw new Error("The legacy Pi journal active leaf cannot be represented in v4.");
  }
  mutations.push({ kind: "lane", seq: seq++, lane: "main", leafId: legacy.leafId });

  // Record a closed navigation operation so recovery can distinguish a fully
  // promoted v4 journal from one staged before lane publication.
  const operationId = `migration-${randomUUID()}`;
  mutations.push({
    kind: "record",
    seq: seq++,
    id: operationId,
    lane: "main",
    type: "operation_started",
    timestamp: Date.now(),
    sourceLeafId: legacy.leafId,
    intent: { kind: "navigation", targetId: legacy.leafId, summarize: false },
  });
  mutations.push({
    kind: "record",
    seq: seq++,
    id: `migration-finished-${randomUUID()}`,
    lane: "main",
    type: "operation_finished",
    timestamp: Date.now(),
    runId: operationId,
    outcome: "completed",
  });

  const header = {
    kind: "header",
    version: 4,
    id: legacy.header.id,
    createdAt: timestamp(legacy.header.timestamp, "session"),
    cwd: legacy.header.cwd,
    ...(legacy.header.parentSession === undefined
      ? {}
      : { legacyParentSessionPath: legacy.header.parentSession }),
    ...(legacy.header.metadata === undefined ? {} : { metadata: legacy.header.metadata }),
  };
  return {
    journal: [header, ...mutations].map((value) => JSON.stringify(value)).join("\n") + "\n",
    receiptCounts: {
      entries: verification.entryCount,
      messages: verification.messageCount,
      compactions: verification.compactionCount,
      customEntries: legacy.entries.filter(
        (entry) => entry.type === "custom" || entry.type === "custom_message",
      ).length,
      abandonedEntries: verification.abandonedEntryCount,
    },
    createdAt: header.createdAt,
    cwd: header.cwd,
    ...(legacy.header.metadata === undefined ? {} : { metadata: legacy.header.metadata }),
    ...(legacy.header.parentSession === undefined
      ? {}
      : { parentSessionPath: legacy.header.parentSession }),
    leafId: legacy.leafId,
  };
}

async function validateStagedJournal(
  stagedPath: string,
  chatId: string,
  projection: ReturnType<typeof projectLegacyPiMigration>,
  details: ReturnType<typeof encodeV4Journal>,
): Promise<void> {
  const repository = createCurrentPiSessionRepository(path.dirname(path.dirname(stagedPath)));
  const session = await repository.open({
    id: chatId,
    createdAt: details.createdAt,
    cwd: details.cwd,
    path: stagedPath,
    modifiedAt: (await stat(stagedPath)).mtimeMs,
    sourceFormat: 4,
    ...(details.parentSessionPath === undefined
      ? {}
      : { legacyParentSessionPath: details.parentSessionPath }),
    ...(details.metadata === undefined ? {} : { metadata: details.metadata }),
  });
  const [actualContext, actualEntries, actualLeaf, actualMetadata] = await Promise.all([
    session.buildContext(),
    session.getEntries(),
    session.getLeafId(),
    session.getMetadata(),
  ]);
  const expected = buildProjectedPiV4Context(projection.entries, details.leafId);
  if (JSON.stringify(actualContext) !== JSON.stringify(expected)) {
    throw new Error("The staged Pi v4 journal changes provider context.");
  }
  const expectedEntries = projection.entries.filter(
    (entry) => !["leaf", "label", "session_info"].includes(entry.type),
  ).length;
  if (actualEntries.length !== expectedEntries || actualLeaf !== details.leafId) {
    throw new Error("The staged Pi v4 journal failed entry or lane validation.");
  }
  if (
    actualMetadata.id !== chatId ||
    actualMetadata.createdAt !== details.createdAt ||
    actualMetadata.cwd !== details.cwd ||
    actualMetadata.legacyParentSessionPath !== details.parentSessionPath ||
    actualMetadata.parentSessionId !== undefined ||
    !isDeepStrictEqual(actualMetadata.metadata, details.metadata)
  ) {
    throw new Error("The staged Pi v4 journal changed immutable session metadata.");
  }
}

function migrationPaths(sourcePath: string): {
  backupPath: string;
  receiptPath: string;
} {
  return {
    backupPath: `${sourcePath}.v3-backup`,
    receiptPath: `${sourcePath}.migration-v1.json`,
  };
}

async function readReceipt(receiptPath: string): Promise<PiSessionMigrationReceipt | undefined> {
  try {
    return parsePiSessionMigrationReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomically promote one exact v3 journal, leaving an owner-only rollback copy. */
export async function migratePiSessionJournal(
  sourcePath: string,
  expectedChatId: string,
): Promise<PiSessionMigrationResult> {
  const resolvedSource = path.resolve(sourcePath);
  const { backupPath, receiptPath } = migrationPaths(resolvedSource);
  const existingReceipt = await readReceipt(receiptPath);
  if (existingReceipt) {
    if (
      existingReceipt.validation !== "passed" ||
      existingReceipt.chatId !== expectedChatId ||
      path.resolve(existingReceipt.promotedPath) !== resolvedSource ||
      path.resolve(existingReceipt.backupPath) !== backupPath
    ) {
      throw new Error("The Pi migration receipt does not own this chat journal.");
    }
    const backup = await readValidBackup(backupPath, existingReceipt.sourceSha256);
    const legacy = decodeLegacyPiSession(backup.toString("utf8"));
    if (legacy.header.id !== expectedChatId) {
      throw new Error("The Pi migration backup does not own the requested chat.");
    }
    const details = encodeV4Journal(backup.toString("utf8"));
    await validateStagedJournal(
      resolvedSource,
      expectedChatId,
      projectLegacyPiMigration(legacy),
      details,
    );
    return { receipt: existingReceipt, receiptPath };
  }

  const current = await readFile(resolvedSource);
  const firstLine = current.toString("utf8").split("\n", 1)[0] ?? "";
  let header: { kind?: unknown; version?: unknown } = {};
  try {
    header = JSON.parse(firstLine) as typeof header;
  } catch {
    // The independent decoder below provides the closed diagnostic.
  }
  let legacyBytes = current;
  if (header.kind === "header" && header.version === 4) {
    legacyBytes = await readValidBackup(backupPath);
  }
  const contents = legacyBytes.toString("utf8");
  const legacy = decodeLegacyPiSession(contents);
  if (legacy.header.id !== expectedChatId) {
    throw new Error("The legacy Pi journal does not own the requested chat.");
  }
  const details = encodeV4Journal(contents);
  const projection = projectLegacyPiMigration(legacy);
  if (header.kind === "header" && header.version === 4) {
    await validateStagedJournal(
      resolvedSource,
      expectedChatId,
      projection,
      details,
    );
    const receipt: PiSessionMigrationReceipt = {
      version: PI_SESSION_MIGRATION_RECEIPT_VERSION,
      chatId: expectedChatId,
      oldFormat: "pi-session-v3",
      newFormat: "pi-session-v4",
      sourceSha256: sourceHash(legacyBytes),
      promotedPath: resolvedSource,
      backupPath,
      counts: details.receiptCounts,
      validation: "passed",
      createdAt: new Date().toISOString(),
    };
    parsePiSessionMigrationReceipt(receipt);
    await durableWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
    return { receipt, receiptPath };
  }
  const stagedPath = `${resolvedSource}.${randomUUID()}.v4.tmp`;
  try {
    let existingBackup: Buffer | undefined;
    try {
      existingBackup = await readValidBackup(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableCopy(resolvedSource, backupPath);
    }
    if (existingBackup && sourceHash(legacyBytes) !== sourceHash(existingBackup)) {
      throw new Error("The existing Pi v3 backup does not match the migration source.");
    }
    await durableWrite(stagedPath, details.journal);
    await validateStagedJournal(stagedPath, expectedChatId, projection, details);
    await rename(stagedPath, resolvedSource);
    await chmod(resolvedSource, 0o600);
    await syncDirectory(path.dirname(resolvedSource));
    const receipt: PiSessionMigrationReceipt = {
      version: PI_SESSION_MIGRATION_RECEIPT_VERSION,
      chatId: expectedChatId,
      oldFormat: "pi-session-v3",
      newFormat: "pi-session-v4",
      sourceSha256: sourceHash(legacyBytes),
      promotedPath: resolvedSource,
      backupPath,
      counts: details.receiptCounts,
      validation: "passed",
      createdAt: new Date().toISOString(),
    };
    parsePiSessionMigrationReceipt(receipt);
    await durableWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
    return { receipt, receiptPath };
  } finally {
    await unlink(stagedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Restore the exact v3 bytes while retaining an owner-only v4 rollback artifact. */
export async function rollbackPiSessionMigration(
  receiptValue: PiSessionMigrationReceipt,
): Promise<string> {
  const receipt = parsePiSessionMigrationReceipt(receiptValue);
  if (receipt.validation !== "passed") throw new Error("The Pi migration did not pass validation.");
  const backup = await readValidBackup(receipt.backupPath, receipt.sourceSha256);
  const legacy = decodeLegacyPiSession(backup.toString("utf8"));
  if (legacy.header.id !== receipt.chatId) {
    throw new Error("The Pi migration backup does not own the receipt chat.");
  }
  const details = encodeV4Journal(backup.toString("utf8"));
  const projection = projectLegacyPiMigration(legacy);
  const rollbackArtifact = `${receipt.promotedPath}.v4-rollback`;
  const promoted = await readFile(receipt.promotedPath);
  let promotedHeader: { kind?: unknown; version?: unknown } = {};
  try {
    promotedHeader = JSON.parse(
      promoted.toString("utf8").split("\n", 1)[0] ?? "",
    ) as typeof promotedHeader;
  } catch {
    // The v4 validator below provides the closed diagnostic.
  }
  if (promotedHeader.kind !== "header" || promotedHeader.version !== 4) {
    if (sourceHash(promoted) !== receipt.sourceSha256) {
      throw new Error("The Pi rollback target is neither the promoted v4 journal nor its v3 source.");
    }
    await validateStagedJournal(
      rollbackArtifact,
      receipt.chatId,
      projection,
      details,
    );
    return rollbackArtifact;
  }
  await validateStagedJournal(
    receipt.promotedPath,
    receipt.chatId,
    projection,
    details,
  );
  try {
    await durableCopy(receipt.promotedPath, rollbackArtifact, { exclusive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await validateStagedJournal(
      rollbackArtifact,
      receipt.chatId,
      projection,
      details,
    );
  }
  const stagedPath = `${receipt.promotedPath}.${randomUUID()}.rollback.tmp`;
  try {
    await durableWrite(stagedPath, backup);
    decodeLegacyPiSession(backup.toString("utf8"));
    await rename(stagedPath, receipt.promotedPath);
    await chmod(receipt.promotedPath, 0o600);
    await syncDirectory(path.dirname(receipt.promotedPath));
    await unlink(migrationPaths(receipt.promotedPath).receiptPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await syncDirectory(path.dirname(receipt.promotedPath));
  } finally {
    await unlink(stagedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return rollbackArtifact;
}
