import { entryLabel, sessionName } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { constants as fsConstants } from "node:fs";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

interface OldHeader {
  kind: "header";
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  metadata?: Record<string, JsonValue>;
}

/** Retained Pi 0.84.4 operation/usage records, keyed by their original id. */
export const LEGACY_RECORD_NAMESPACE = "aiden.pi-legacy-record";
/** Key prefix of the finish record synthesized for an interrupted legacy operation. */
export const LEGACY_RECOVERY_PREFIX = "pi087-upgrade-recovered-";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy Pi v4 journal record.");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}
function nullableId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseOldPiV4Header(line: string): OldHeader | undefined {
  let candidate: Record<string, unknown>;
  try { candidate = record(JSON.parse(line)); } catch { return undefined; }
  if (candidate.kind !== "header" || candidate.version !== 4 ||
      typeof candidate.id !== "string" || !candidate.id ||
      typeof candidate.cwd !== "string" || !integer(candidate.createdAt) ||
      (candidate.parentSessionId !== undefined && typeof candidate.parentSessionId !== "string") ||
      (candidate.legacyParentSessionPath !== undefined && typeof candidate.legacyParentSessionPath !== "string") ||
      (candidate.metadata !== undefined && (typeof candidate.metadata !== "object" || candidate.metadata === null || Array.isArray(candidate.metadata)))) return undefined;
  return candidate as unknown as OldHeader;
}

/** Convert only complete, validated 0.84.4 v4 mutations into 0.87.1's storage v1 records. */
export function convertOldPiV4Journal(source: string): { journal: string; header: OldHeader; interruptedOperations: string[] } {
  const physical = source.split("\n");
  const header = parseOldPiV4Header(physical[0] ?? "");
  if (!header) throw new Error("The legacy Pi v4 journal has an invalid header.");
  // The old loader accepts a header-only journal and repairs its newline.
  if (physical.length === 1) physical.push("");
  const complete = physical.slice(1, -1);
  if (!source.endsWith("\n")) {
    const tail = physical[physical.length - 1];
    if (tail) {
      try { JSON.parse(tail); complete.push(tail); } catch { /* Unacknowledged torn tail. */ }
    }
  }
  const ids = new Set<string>();
  const lanes = new Map<string, string | null>();
  const writes: Record<string, unknown>[] = [];
  let nextSeq = 1;
  const append = (write: Record<string, unknown>) => writes.push({ ...write, seq: nextSeq++ });
  // Keep immutable Aiden ownership metadata adjacent to the header. Listing
  // sessions must not read every private transcript merely to find its owner.
  if (header.metadata !== undefined) {
    append({ kind: "value", op: "set", namespace: "aiden", key: "session-metadata", value: header.metadata });
  }
  const recordIds = new Set<string>();
  const openOperations = new Map<string, Record<string, unknown>>();
  let previousSeq = 0;
  for (const line of complete) {
    if (!line) throw new Error("The legacy Pi v4 journal has an empty mutation.");
    const mutation = record(JSON.parse(line));
    const seq = mutation.seq;
    if (!integer(seq, 1) || seq <= previousSeq) throw new Error("The legacy Pi v4 journal has invalid sequence order.");
    previousSeq = seq;
    if (mutation.kind === "entry") {
      const { kind: _kind, lane: _lane, ...entry } = mutation;
      const id = entry.id;
      if (typeof id !== "string" || !id || ids.has(id) || recordIds.has(id) || !nullableId(entry.parentId) ||
          (entry.parentId !== null && !ids.has(entry.parentId)) || !integer(entry.timestamp) || typeof entry.type !== "string") {
        throw new Error("The legacy Pi v4 journal has an invalid entry.");
      }
      ids.add(id);
      let converted: Record<string, unknown> = entry;
      if (["model_change", "thinking_level_change", "active_tools_change"].includes(entry.type)) {
        converted = { id, parentId: entry.parentId, seq, timestamp: entry.timestamp, type: "custom",
          customType: `aiden.pi-legacy.${entry.type}`, data: entry };
      } else if (entry.type === "compaction" || entry.type === "branch_summary") {
        converted = { ...entry, fromHook: false };
      } else if (entry.type !== "message" && entry.type !== "custom") {
        throw new Error("The legacy Pi v4 journal has an unsupported entry type.");
      }
      append({ kind: "entry", ...converted });
      if (typeof mutation.lane === "string") {
        lanes.set(mutation.lane, id);
        append({ kind: "value", op: "set", namespace: "pi.branch.tip", key: mutation.lane, value: id });
      }
    } else if (mutation.kind === "lane") {
      if (typeof mutation.lane !== "string" || !nullableId(mutation.leafId) ||
          (mutation.leafId !== null && !ids.has(mutation.leafId))) throw new Error("The legacy Pi v4 journal has an invalid lane.");
      lanes.set(mutation.lane, mutation.leafId);
      append({ kind: "value", op: "set", namespace: "pi.branch.tip", key: mutation.lane, value: mutation.leafId });
    } else if (mutation.kind === "fact") {
      if (mutation.fact === "name") {
        append({ kind: "value", op: mutation.name === undefined ? "delete" : "set",
          namespace: sessionName.namespace, key: sessionName.key, ...(mutation.name === undefined ? {} : { value: mutation.name }) });
      } else if (mutation.fact === "label" && typeof mutation.targetId === "string" && ids.has(mutation.targetId)) {
        const address = entryLabel(mutation.targetId);
        append({ kind: "value", op: mutation.label === undefined ? "delete" : "set",
          namespace: address.namespace, key: address.key, ...(mutation.label === undefined ? {} : { value: mutation.label }) });
      } else throw new Error("The legacy Pi v4 journal has an invalid fact.");
    } else if (mutation.kind === "record" && typeof mutation.id === "string" && mutation.id &&
        typeof mutation.type === "string" && typeof mutation.lane === "string") {
      // Mirror the 0.84.4 loader: ids are unique across entries and records,
      // and a finish closes the open operation it names on its own lane.
      if (ids.has(mutation.id) || recordIds.has(mutation.id)) throw new Error("The legacy Pi v4 journal has a duplicate record id.");
      recordIds.add(mutation.id);
      if (mutation.type === "operation_started") {
        openOperations.set(mutation.id, mutation);
      } else if (mutation.type === "operation_finished" && typeof mutation.runId === "string" &&
          openOperations.get(mutation.runId)?.lane === mutation.lane) {
        openOperations.delete(mutation.runId);
      }
      if (mutation.type === "usage") {
        append({ kind: "usage", id: mutation.id, usage: mutation.usage,
          adjustment: mutation.cause === "adjustment",
          ...(typeof mutation.entryId === "string" ? { entryId: mutation.entryId } : {}),
          ...(mutation.details === undefined ? {} : { details: mutation.details }) });
      }
      // Keep the exact operation history for audit and rollback.
      append({ kind: "value", op: "set", namespace: LEGACY_RECORD_NAMESPACE, key: mutation.id, value: mutation });
    } else throw new Error("The legacy Pi v4 journal has an invalid mutation.");
  }
  // A crash between operation_started and operation_finished is valid v4.
  // Pi 0.87.1 restores operations only from configured-lane values, which a
  // converted branch-only journal never has, so resolve the old operation here
  // instead of leaving an open record nothing reads. Every acknowledged entry
  // and lane move is already in the journal, so the recorded branch tip is the
  // recovered state. The unfinished operation is closed as aborted: work it
  // never acknowledged (for example an uncommitted navigation) is not replayed.
  const interruptedOperations: string[] = [];
  for (const [runId, started] of openOperations) {
    const id = `${LEGACY_RECOVERY_PREFIX}${runId}`;
    if (ids.has(id) || recordIds.has(id)) throw new Error("The legacy Pi v4 journal has a conflicting recovery record.");
    interruptedOperations.push(runId);
    append({ kind: "value", op: "set", namespace: LEGACY_RECORD_NAMESPACE, key: id, value: {
      kind: "record", id, lane: started.lane, type: "operation_finished", timestamp: started.timestamp,
      runId, outcome: "aborted", recoveredBy: "aiden-pi-0.87.1-upgrade",
    } });
  }
  if (!lanes.has("main")) {
    append({ kind: "value", op: "set", namespace: "pi.branch.tip", key: "main", value: null });
  }
  const nextHeader = { v: 4, kind: "header", id: header.id, storageVersion: 1, createdAt: header.createdAt,
    cwd: header.cwd, nextSeq,
    ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
    ...(header.legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath: header.legacyParentSessionPath }) };
  return { header, interruptedOperations, journal: [nextHeader, ...writes].map((value) => JSON.stringify(value)).join("\n") + "\n" };
}

/**
 * Create the rollback copy owner-only from its first byte, or adopt an exact
 * copy left by an interrupted earlier attempt after restricting it too. The
 * descriptor is checked and chmodded directly so a swapped path cannot redirect
 * either step.
 */
async function writePrivateBackup(backupPath: string, source: Buffer): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(backupPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (handle) {
    try {
      await handle.writeFile(source);
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return;
  }
  const existing = await open(backupPath, fsConstants.O_RDONLY | noFollow);
  try {
    if (!(await existing.stat()).isFile()) throw new Error("The existing Pi 0.84.4 backup is not a regular file.");
    await existing.chmod(0o600);
    if (!(await existing.readFile()).equals(source)) {
      throw new Error("The existing Pi 0.84.4 backup differs from the source journal.");
    }
  } finally {
    await existing.close();
  }
}

/** Keep exact old bytes for rollback and atomically publish the validated new storage format. */
export async function upgradeOldPiV4File(filePath: string): Promise<void> {
  const source = await readRegularFile(filePath);
  const decoded = decodeUtf8(source);
  const firstLine = decoded.split("\n", 1)[0] ?? "";
  if (!parseOldPiV4Header(firstLine)) return;
  const { journal, header } = convertOldPiV4Journal(decoded);
  const backupPath = `${filePath}.pi084-backup`;
  const stagedPath = `${filePath}.${randomUUID()}.pi087.tmp`;
  await writePrivateBackup(backupPath, source);
  try {
    await writeFile(stagedPath, journal, { mode: 0o600, flag: "wx" });
    const repository = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: path.dirname(filePath) }),
      sessionsRoot: path.dirname(path.dirname(filePath)),
    });
    const fileInfo = await stat(stagedPath);
    const session = await repository.open({
      id: header.id, createdAt: header.createdAt, cwd: header.cwd,
      path: stagedPath, modifiedAt: fileInfo.mtimeMs, storageVersion: 1,
      ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
      ...(header.legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath: header.legacyParentSessionPath }),
    }, TODO_CONTEXT);
    await session.close(TODO_CONTEXT);
    const current = await readRegularFile(filePath);
    if (!current.equals(source)) throw new Error("The Pi journal changed during upgrade.");
    await rename(stagedPath, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(stagedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
