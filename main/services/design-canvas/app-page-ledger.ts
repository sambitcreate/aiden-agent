// The page-file ledger (design mode v2 Phase 3c, S97): what the person's
// Duplicate page as variant wrote and what their Move page file to Trash
// took, so the canvas's own undo and redo can put the file back or take it
// away again. Memory only, per workspace, newest 16 kept; one record per
// file. It acts only on a signal it can read exactly in a committed save
// (a frame gone with its route in that save's `undoneRoutes`, or a frame
// back), only inside the file's lock, and only while `canAct` still holds.
// Anything else forgets the record and leaves the file alone.

import { createHash } from "node:crypto";
import path from "node:path";
import { appRouteKey, type DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";

/** At most this many records per workspace; the oldest goes first. */
export const PAGE_LEDGER_LIMIT = 16;

/** What a ledger action did, for the chat whose change it followed. Broadcast on `designCanvas:pageFile`. */
export type PageFileOutcome =
  | { chatId: string; file: string; done: "trash" | "restore" }
  | { chatId: string; file: string; failed: "trash" | "restore"; reason: "changed" | "exists" | "io" };

type RecordBase = {
  chatId: string;
  workspaceId: string;
  /** The workspace folder's real path when recorded; a later action needs the same. */
  workspaceRoot: string;
  appRoot: string;
  /** The frame's route, as the frame holds it (its query kept). */
  route: string;
  /** Workspace-relative, as `workspaceRelPath` gives it. */
  file: string;
  bytes: Buffer;
  mode: number;
  digest: string;
};

/** Duplicate page as variant's copy. `newFolder` is set when the copy needed its folder made, so a trash may remove it once empty. */
export type PageCopyRecord = RecordBase & { kind: "copy"; frameId: string; state: "present" | "trashed"; newFolder?: true };
/** Move page file to Trash's file, and every frame of its route it removed. */
export type PageTrashRecord = RecordBase & { kind: "trash"; frameIds: string[]; state: "trashed" | "restored" };
export type PageLedgerRecord = PageCopyRecord | PageTrashRecord;

type ReadResult = { ok: true; bytes: Buffer; mode: number } | { ok: false; reason: "too-large" | "not-regular" | "missing" | "io" };
type TargetResult = { ok: true; absolute: string; createdFolder?: string } | { ok: false; reason: string };
type WriteResult = { ok: true; absolute: string; createdFolder?: string } | { ok: false; reason: "exists" | "outside" | "link" | "io" };

export type PageLedgerDeps = {
  /** The handler's per-file lock, keyed on `path.resolve(workspaceRoot, file)`. */
  lock<T>(absolute: string, task: () => Promise<T>): Promise<T>;
  /** Whether the chat may still touch files in that workspace folder: design mode, the same real path, a writable permission. */
  canAct(chatId: string, workspaceId: string, workspaceRoot: string): Promise<boolean>;
  /** `confinedTarget`, without creating. */
  target(workspaceRoot: string, file: string): Promise<TargetResult>;
  /** `readRegularFileBytes`. */
  read(absolute: string): Promise<ReadResult>;
  /** Moves a file to the Trash. */
  trash(absolute: string): Promise<void>;
  /** `writeConfinedFile` with `wx`. */
  write(workspaceRoot: string, file: string, bytes: Buffer, mode: number, create: boolean): Promise<WriteResult>;
  /** Removes `dir` only when it is empty. */
  removeEmptyFolder(dir: string): Promise<void>;
  notify(outcome: PageFileOutcome): void;
};

export const pageDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export class PageFileLedger {
  private readonly records = new Map<string, PageLedgerRecord[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: PageLedgerDeps) {}

  /** Keeps `record`, replacing any older record of the same workspace and file. */
  record(record: PageLedgerRecord): void {
    const kept = (this.records.get(record.workspaceId) ?? []).filter((entry) => entry.file !== record.file);
    kept.push(record);
    this.records.set(record.workspaceId, kept.slice(-PAGE_LEDGER_LIMIT));
  }

  /** The records kept for a workspace, oldest first (tests and diagnostics). */
  list(workspaceId: string): readonly PageLedgerRecord[] {
    return this.records.get(workspaceId) ?? [];
  }

  /**
   * Reads one committed save of `chatId` against that chat's records, on the
   * workspace's own queue, in the order saves committed. Never rejects.
   */
  reconcile(workspaceId: string, chatId: string, doc: DesignCanvas, undoneRoutes: readonly string[]): Promise<void> {
    const before = this.queues.get(workspaceId) ?? Promise.resolve();
    const run = before.then(() => this.apply(workspaceId, chatId, doc, new Set(undoneRoutes))).catch(() => undefined);
    this.queues.set(workspaceId, run);
    void run.then(() => {
      if (this.queues.get(workspaceId) === run) this.queues.delete(workspaceId);
    });
    return run;
  }

  private drop(record: PageLedgerRecord): void {
    const kept = (this.records.get(record.workspaceId) ?? []).filter((entry) => entry !== record);
    if (kept.length > 0) this.records.set(record.workspaceId, kept);
    else this.records.delete(record.workspaceId);
  }

  private replace(record: PageLedgerRecord, next: PageLedgerRecord): void {
    const list = this.records.get(record.workspaceId);
    if (!list) return;
    const index = list.indexOf(record);
    if (index >= 0) list[index] = next;
  }

  private async apply(workspaceId: string, chatId: string, doc: DesignCanvas, undone: ReadonlySet<string>): Promise<void> {
    const ids = new Set(doc.frames.map((frame) => frame.id));
    for (const record of [...(this.records.get(workspaceId) ?? [])]) {
      if (record.chatId !== chatId) continue;
      if (record.kind === "copy") {
        const present = ids.has(record.frameId);
        if (record.state === "present" && !present) {
          // Only the person's undo of the placement takes the copy away; their own removal keeps it.
          if (undone.has(appRouteKey(record.appRoot, record.route))) await this.trashCopy(record);
          else this.drop(record);
        } else if (record.state === "trashed" && present) {
          await this.writeBack(record);
        }
      } else {
        const back = record.frameIds.some((id) => ids.has(id));
        if (record.state === "trashed" && back) await this.writeBack(record);
        // A redo of the Trash removes the frames again but never trashes the file again (S96).
        else if (record.state === "restored" && !back) this.drop(record);
      }
    }
  }

  private absolute(record: PageLedgerRecord): string {
    return path.resolve(record.workspaceRoot, record.file);
  }

  /**
   * Inside the file's lock: the gate, then (for a file that should be there)
   * the confined target, then `act`. A refused gate or target forgets the
   * record. A write confines itself, since its folder may need making again.
   */
  private async locked(record: PageLedgerRecord, existing: boolean, act: (absolute: string) => Promise<void>): Promise<void> {
    await this.deps.lock(this.absolute(record), async () => {
      if (!(await this.deps.canAct(record.chatId, record.workspaceId, record.workspaceRoot).catch(() => false))) {
        this.drop(record);
        return;
      }
      if (!existing) {
        await act(this.absolute(record));
        return;
      }
      const target = await this.deps.target(record.workspaceRoot, record.file).catch(() => ({ ok: false as const, reason: "io" }));
      if (!target.ok || target.absolute !== this.absolute(record)) {
        this.drop(record);
        return;
      }
      await act(target.absolute);
    });
  }

  private fail(record: PageLedgerRecord, failed: "trash" | "restore", reason: "changed" | "exists" | "io"): void {
    this.drop(record);
    this.deps.notify({ chatId: record.chatId, file: record.file, failed, reason });
  }

  private trashCopy(record: PageCopyRecord): Promise<void> {
    return this.locked(record, true, async (absolute) => {
      const read = await this.deps.read(absolute).catch((): ReadResult => ({ ok: false, reason: "io" }));
      if (!read.ok) {
        // Already gone: nothing to take away. Anything else unreadable is a change.
        if (read.reason === "missing") this.drop(record);
        else this.fail(record, "trash", read.reason === "io" ? "io" : "changed");
        return;
      }
      if (pageDigest(read.bytes) !== record.digest) {
        this.fail(record, "trash", "changed");
        return;
      }
      try {
        await this.deps.trash(absolute);
      } catch {
        this.fail(record, "trash", "io");
        return;
      }
      if (record.newFolder) await this.deps.removeEmptyFolder(path.dirname(absolute)).catch(() => undefined);
      this.replace(record, { ...record, state: "trashed" });
      this.deps.notify({ chatId: record.chatId, file: record.file, done: "trash" });
    });
  }

  private writeBack(record: PageLedgerRecord): Promise<void> {
    return this.locked(record, false, async () => {
      const create = record.kind === "copy" && record.newFolder === true;
      const written = await this.deps
        .write(record.workspaceRoot, record.file, record.bytes, record.mode, create)
        .catch((): WriteResult => ({ ok: false, reason: "io" }));
      if (!written.ok) {
        this.fail(record, "restore", written.reason === "exists" ? "exists" : "io");
        return;
      }
      this.replace(record, record.kind === "copy" ? { ...record, state: "present" } : { ...record, state: "restored" });
      this.deps.notify({ chatId: record.chatId, file: record.file, done: "restore" });
    });
  }
}
