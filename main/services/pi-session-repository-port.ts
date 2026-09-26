import {
  MemorySessionRepo,
  JsonlSessionRepo,
  TODO_CONTEXT,
  value,
  type JsonlSessionMetadata,
  type JsonValue,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseOldPiV4Header, upgradeOldPiV4File } from "./pi-session-v4-upgrade.js";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";
import {
  createPiSessionPort,
  type PiPersistentSessionMetadata,
  type PiSessionPort,
} from "./pi-session-port.js";

export interface PiSessionRepositoryPort {
  list(): Promise<PiPersistentSessionMetadata[]>;
  open(metadata: PiPersistentSessionMetadata): Promise<PiSessionPort<PiPersistentSessionMetadata>>;
  create(options: {
    id: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): Promise<PiSessionPort<PiPersistentSessionMetadata>>;
  delete(metadata: PiPersistentSessionMetadata): Promise<void>;
}

const AIDEN_METADATA = value<Record<string, JsonValue>>("aiden", "session-metadata");
const METADATA_SCAN_BYTES = 65_536;

function metadataFromLines(lines: readonly string[]): { legacyV3: boolean; custom?: Record<string, JsonValue> } {
  let header: { type?: string; version?: number } = {};
  try { header = JSON.parse(lines[0] ?? "{}") as typeof header; } catch { /* ignored */ }
  if (header.type === "session" && header.version === 3) return { legacyV3: true };
  let custom: Record<string, JsonValue> | undefined;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    let write: unknown;
    try { write = JSON.parse(line); } catch { continue; }
    const writes = Array.isArray(write) ? write : [write];
    for (const candidate of writes) {
      if (candidate && typeof candidate === "object" && candidate.kind === "value" &&
          candidate.op === "set" && candidate.namespace === AIDEN_METADATA.namespace &&
          candidate.key === AIDEN_METADATA.key &&
          candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value)) {
        custom = candidate.value as Record<string, JsonValue>;
      }
    }
  }
  return { legacyV3: false, ...(custom === undefined ? {} : { custom }) };
}

async function readAidenMetadata(filePath: string): Promise<{ legacyV3: boolean; custom?: Record<string, JsonValue> }> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let size: number;
  let prefix: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Pi session metadata is not a regular file.");
    size = info.size;
    const buffer = Buffer.alloc(METADATA_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const lastNewline = prefix.lastIndexOf(10);
  const complete = lastNewline < 0 ? Buffer.alloc(0) : prefix.subarray(0, lastNewline + 1);
  const scanned = metadataFromLines(decodeUtf8(complete).split("\n"));
  if (scanned.legacyV3 || scanned.custom !== undefined || size <= prefix.length) return scanned;
  // Older converted files can place ownership metadata at the tail. The new
  // converter writes it immediately after the header, so this is a fallback.
  return metadataFromLines(decodeUtf8(await readRegularFile(filePath)).split("\n"));
}

class CurrentPiSessionRepositoryPort implements PiSessionRepositoryPort {
  readonly #repository: JsonlSessionRepo;
  readonly #activeMetadata = new Map<string, PiPersistentSessionMetadata>();
  readonly #activeSessions = new Map<string, Session<JsonlSessionMetadata>>();
  readonly #root: string;
  readonly #pendingCreates = new Set<string>();

  constructor(root: string) {
    this.#root = root;
    this.#repository = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: root }),
      sessionsRoot: root,
    });
  }

  async list(): Promise<PiPersistentSessionMetadata[]> {
    const listed = await this.#repository.list(undefined, TODO_CONTEXT);
    const current: Array<PiPersistentSessionMetadata | undefined> = await Promise.all(listed.map(async (metadata): Promise<PiPersistentSessionMetadata | undefined> => {
      const active = this.#activeMetadata.get(metadata.path);
      let custom = active?.metadata;
      if (!active) {
        const stored = await readAidenMetadata(metadata.path);
        if (stored.legacyV3) return undefined;
        custom = stored.custom;
      }
      return {
        id: metadata.id,
        createdAt: metadata.createdAt,
        cwd: metadata.cwd,
        path: metadata.path,
        modifiedAt: metadata.modifiedAt,
        sourceFormat: 4 as const,
        storageVersion: metadata.storageVersion,
        ...(metadata.parentSessionId === undefined
          ? {}
          : { parentSessionId: metadata.parentSessionId }),
        ...(metadata.legacyParentSessionPath === undefined
          ? {}
          : { legacyParentSessionPath: metadata.legacyParentSessionPath }),
        ...(custom === undefined ? {} : { metadata: custom }),
      };
    }));
    const old: PiPersistentSessionMetadata[] = [];
    for (const directory of await readdir(this.#root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const directoryPath = path.join(this.#root, directory.name);
      for (const file of await readdir(directoryPath, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const filePath = path.join(directoryPath, file.name);
        const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        let headerLine: string;
        try {
          if (!(await handle.stat()).isFile()) throw new Error("Pi journal discovery found a non-regular file.");
          const buffer = Buffer.alloc(65_536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          headerLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
        } finally {
          await handle.close();
        }
        const header = parseOldPiV4Header(headerLine);
        if (!header) continue;
        const fileInfo = await stat(filePath);
        old.push({
          id: header.id, createdAt: header.createdAt, cwd: header.cwd,
          path: filePath, modifiedAt: fileInfo.mtimeMs, sourceFormat: 4,
          storageVersion: 0,
          ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
          ...(header.legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath: header.legacyParentSessionPath }),
          ...(header.metadata === undefined ? {} : { metadata: header.metadata }),
        });
      }
    }
    return [...current.filter((entry): entry is PiPersistentSessionMetadata => entry !== undefined), ...old]
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async open(
    metadata: PiPersistentSessionMetadata,
  ): Promise<PiSessionPort<PiPersistentSessionMetadata>> {
    if (metadata.storageVersion === 0) await upgradeOldPiV4File(metadata.path);
    const nativeMetadata = { ...metadata, storageVersion: 1 } as JsonlSessionMetadata;
    const session = await this.#repository.open(nativeMetadata, TODO_CONTEXT);
    const storedMetadata = (await session.getValue(AIDEN_METADATA, TODO_CONTEXT))?.value;
    if (!isDeepStrictEqual(storedMetadata, metadata.metadata)) {
      await session.close(TODO_CONTEXT);
      throw new Error("The Pi journal changed immutable session metadata.");
    }
    const promotedMetadata = { ...metadata, storageVersion: 1 };
    this.#activeMetadata.set(metadata.path, promotedMetadata);
    this.#activeSessions.set(metadata.path, session);
    return createPiSessionPort(session, promotedMetadata);
  }

  async create(options: {
    id: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): Promise<PiSessionPort<PiPersistentSessionMetadata>> {
    const custom = JSON.parse(JSON.stringify(options.metadata)) as Record<string, JsonValue>;
    if (this.#pendingCreates.has(options.id)) throw new Error(`Session already exists: ${options.id}`);
    this.#pendingCreates.add(options.id);
    let session: Session<JsonlSessionMetadata>;
    try {
      try {
        session = await this.#repository.create({ ...options }, TODO_CONTEXT);
      } catch (error) {
        // An earlier create may have stopped after Pi claimed the id but
        // before Aiden recorded ownership (a crash, or a failed rollback
        // delete). Reclaim only that exact empty, unowned file, then retry.
        if (!(await this.#reclaimUnownedCreate(options.id, options.cwd))) throw error;
        session = await this.#repository.create({ ...options }, TODO_CONTEXT);
      }
      try {
        await session.setValue(AIDEN_METADATA, custom, TODO_CONTEXT);
      } catch (error) {
        // create() has already published the file and claimed the session id.
        // Release both before the caller retries this chat. If the delete
        // itself fails, the next create() reclaims the orphan above.
        await session.close(TODO_CONTEXT).catch(() => undefined);
        await this.#repository.delete(session.metadata, TODO_CONTEXT).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#pendingCreates.delete(options.id);
    }
    const metadata: PiPersistentSessionMetadata = {
      ...session.metadata,
      cwd: session.metadata.cwd,
      path: session.metadata.path,
      modifiedAt: session.metadata.modifiedAt,
      sourceFormat: 4,
      metadata: custom,
    };
    this.#activeMetadata.set(metadata.path, metadata);
    this.#activeSessions.set(metadata.path, session);
    return createPiSessionPort(session, metadata);
  }

  /** Remove a header-only journal Pi created for this id that Aiden never owned. */
  async #reclaimUnownedCreate(id: string, cwd: string): Promise<boolean> {
    if ([...this.#activeSessions.values()].some((session) => session.metadata.id === id)) return false;
    let reclaimed = false;
    for (const candidate of await this.#repository.list({ cwd }, TODO_CONTEXT)) {
      if (candidate.id !== id || candidate.storageVersion !== 1) continue;
      let bytes: Buffer;
      try {
        bytes = await readRegularFile(candidate.path, METADATA_SCAN_BYTES);
      } catch (error) {
        // Larger than a bare header: never an abandoned create.
        if ((error as NodeJS.ErrnoException).code === "EFBIG") continue;
        throw error;
      }
      const lines = decodeUtf8(bytes).split("\n");
      let header: Record<string, unknown> | undefined;
      try { header = JSON.parse(lines[0] ?? "") as Record<string, unknown>; } catch { continue; }
      if (!isDeepStrictEqual(header, {
        v: 4, kind: "header", id, storageVersion: 1, createdAt: candidate.createdAt, cwd: candidate.cwd,
      }) || lines.slice(1).some((line) => line.trim())) continue;
      await this.#repository.delete(candidate, TODO_CONTEXT);
      reclaimed = true;
    }
    return reclaimed;
  }

  async delete(metadata: PiPersistentSessionMetadata): Promise<void> {
    const backupPath = `${metadata.path}.pi084-backup`;
    let hasOwnedBackup = false;
    try {
      const backup = decodeUtf8(await readRegularFile(backupPath));
      const header = parseOldPiV4Header(backup.split("\n", 1)[0] ?? "");
      if (header?.id !== metadata.id || !isDeepStrictEqual(header.metadata, metadata.metadata)) {
        throw new Error("The Pi 0.84.4 backup does not belong to this session.");
      }
      hasOwnedBackup = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#activeSessions.get(metadata.path)?.close(TODO_CONTEXT);
    if (this.#activeSessions.has(metadata.path) || metadata.storageVersion !== 0) {
      await this.#repository.delete({ ...metadata, storageVersion: 1 } as JsonlSessionMetadata, TODO_CONTEXT);
    } else {
      await unlink(metadata.path);
    }
    if (hasOwnedBackup) await unlink(backupPath);
    this.#activeMetadata.delete(metadata.path);
    this.#activeSessions.delete(metadata.path);
  }
}

export function createCurrentPiSessionRepository(root: string): PiSessionRepositoryPort {
  return new CurrentPiSessionRepositoryPort(root);
}

/** Isolated child-session factory; Pi repository churn stops at this module. */
export async function createInMemoryPiSession(id: string): Promise<PiSessionPort> {
  return createPiSessionPort(await new MemorySessionRepo().create({ id }, TODO_CONTEXT));
}

/** Narrow compatibility fixture for callers that need to wrap a native Pi session. */
export class InMemorySessionRepo {
  readonly #repo = new MemorySessionRepo();
  create(options: { id: string }) {
    return this.#repo.create(options, TODO_CONTEXT);
  }
}
