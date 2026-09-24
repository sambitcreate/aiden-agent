import { entryLabel, sessionName } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, open, rename, stat, unlink, writeFile } from "node:fs/promises";
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
export function convertOldPiV4Journal(source: string): { journal: string; header: OldHeader } {
  const physical = source.split("\n");
  const header = parseOldPiV4Header(physical[0] ?? "");
  if (!header) throw new Error("The legacy Pi v4 journal has an invalid header.");
  const complete = physical.slice(1, -1);
  if (!source.endsWith("\n")) {
    const tail = physical[physical.length - 1];
    if (tail) {
      try { JSON.parse(tail); complete.push(tail); } catch { /* Unacknowledged torn tail. */ }
    }
  }
  const ids = new Set<string>();
  const lanes = new Map<string, string | null>();
  const openOperations = new Set<string>();
  const writes: Record<string, unknown>[] = [];
  let nextSeq = 1;
  const append = (write: Record<string, unknown>) => writes.push({ ...write, seq: nextSeq++ });
  // Keep immutable Aiden ownership metadata adjacent to the header. Listing
  // sessions must not read every private transcript merely to find its owner.
  if (header.metadata !== undefined) {
    append({ kind: "value", op: "set", namespace: "aiden", key: "session-metadata", value: header.metadata });
  }
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
      if (typeof id !== "string" || !id || ids.has(id) || !nullableId(entry.parentId) ||
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
    } else if (mutation.kind === "record" && typeof mutation.id === "string" && typeof mutation.type === "string") {
      if (mutation.type === "operation_started") openOperations.add(mutation.id);
      if (mutation.type === "operation_finished" && typeof mutation.runId === "string") openOperations.delete(mutation.runId);
      append({ kind: "value", op: "set", namespace: "aiden.pi-legacy-record", key: mutation.id, value: mutation });
    } else throw new Error("The legacy Pi v4 journal has an invalid mutation.");
  }
  if (openOperations.size) throw new Error("The legacy Pi v4 journal has an unsettled operation.");
  if (!lanes.has("main")) {
    append({ kind: "value", op: "set", namespace: "pi.branch.tip", key: "main", value: null });
  }
  const nextHeader = { v: 4, kind: "header", id: header.id, storageVersion: 1, createdAt: header.createdAt,
    cwd: header.cwd, nextSeq,
    ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
    ...(header.legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath: header.legacyParentSessionPath }) };
  return { header, journal: [nextHeader, ...writes].map((value) => JSON.stringify(value)).join("\n") + "\n" };
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
  try {
    await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
    await chmod(backupPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const backup = await readRegularFile(backupPath);
  if (!backup.equals(source)) throw new Error("The existing Pi 0.84.4 backup differs from the source journal.");
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
