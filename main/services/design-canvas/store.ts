// Workspace design canvas documents: `<root>/<workspaceId>.json`, one atomic
// file per workspace, shared by every chat of that workspace. Every read and
// write for a workspace runs on that workspace's promise chain, so a
// compare-and-swap save and an Aiden-side `update` never interleave.
//
// `DesignChatCanvases` is the door most callers use: it takes a chat id,
// finds the chat's workspace, and reports which workspace it used, so the
// broadcast that follows names the same one.
//
// Canvases from before v3 were one file per chat. They are not migrated: the
// first access of a store with no `.layout-v3` marker removes everything in
// the folder, then writes the marker.

import * as fs from "node:fs/promises";
import path from "node:path";
import {
  deletedClaims,
  mergeSavedChatPages,
  type DeletedPage,
} from "../../../renderer/shared/design-canvas/chat-pages.js";
import {
  emptyDesignCanvas,
  isDesignChatId,
  parseDesignCanvas,
  withRemovedPagePaths,
  type DesignCanvas,
} from "../../../renderer/shared/design-canvas/schema.js";
import { isWorkspaceArtifactWorkspaceId } from "../../../renderer/shared/workspace-artifacts.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const DESIGN_CANVAS_UPDATED_CHANNEL = "designCanvas:updated";

/**
 * Broadcast on `designCanvas:updated` after a save or an Aiden edit lands on
 * a workspace's canvas; every canvas open on that workspace fetches it again.
 * `chatId` is the chat whose action made the change. `aidenTurn` names the
 * reply whose change it was, so that chat's canvas can undo all of one reply's
 * canvas changes as one step. `step` marks a change the person made through
 * main (a Send to canvas that placed a frame): that chat's canvas makes it an
 * undo step of its own, so Cmd+Z takes it back. Another chat's canvas takes
 * the change in without making it a step.
 */
export type DesignCanvasUpdated = {
  workspaceId: string;
  chatId: string;
  revision: number;
  aidenTurn?: string;
  step?: string;
};

/** Written once the folder holds only v3 workspace canvases. */
export const DESIGN_CANVAS_LAYOUT_MARKER = ".layout-v3";

/**
 * A save's answer. `moved` means the canvas being saved belongs to a workspace
 * the chat has left: nothing was written, the edits are not to be retried, and
 * `workspaceId` names the workspace the chat is in now. `chatPages` and
 * `namedFor` (page id to chat id) come back only when the store's merge
 * changed what was sent: they are what was stored.
 */
export type DesignCanvasSaveResult =
  | { ok: true; revision: number; chatPages?: Record<string, string>; namedFor?: Record<string, string> }
  | { ok: false; reason: "conflict"; doc: DesignCanvas }
  | { ok: false; reason: "moved"; workspaceId: string }
  | { ok: false; reason: "invalid"; issues: string[] };

/** A canvas holds at most 4 000 frames and 2 000 comments; anything past 16 MiB is not ours. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** Deleted pages with claims or a `namedFor` remembered per workspace; the oldest go first. */
const DELETED_PAGES_LIMIT = 200;

/** The chat is gone, or its workspace has no record: it has no canvas to read or write. */
export class DesignCanvasUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignCanvasUnavailableError";
  }
}

/** Same alphabet and bound as the chat store's file names. */
export function assertDesignCanvasChatId(chatId: unknown): asserts chatId is string {
  if (!isDesignChatId(chatId)) throw new Error("Invalid chat id.");
}

/** A workspace id as workspace records and their artifacts use them. */
export function assertDesignCanvasWorkspaceId(workspaceId: unknown): asserts workspaceId is string {
  if (!isWorkspaceArtifactWorkspaceId(workspaceId)) throw new Error("Invalid workspace id.");
}

export class DesignCanvasStore {
  private readonly root: () => string;
  private readonly writeJson: typeof writeJsonAtomic;
  private readonly maxDocumentBytes: number;
  private readonly chains = new Map<string, Promise<unknown>>();
  /**
   * Per workspace, the deleted pages that had claims or a `namedFor`, and
   * where each chat on one went, so an undo that brings a page back brings
   * back its claims (`mergeSavedChatPages`). Memory only: main and the
   * renderer's undo history restart together.
   */
  private readonly deletedPages = new Map<string, Map<string, DeletedPage>>();
  /** The one-time clear of pre-v3 files; shared by every workspace's first call. */
  private layout: Promise<void> | null = null;

  constructor(options: {
    root: () => string;
    writeJson?: typeof writeJsonAtomic;
    maxDocumentBytes?: number;
  }) {
    this.root = options.root;
    this.writeJson = options.writeJson ?? writeJsonAtomic;
    this.maxDocumentBytes = options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
  }

  /** The workspace's canvas, or `emptyDesignCanvas()` when it has none or its file is unreadable. */
  async get(workspaceId: string): Promise<DesignCanvas> {
    assertDesignCanvasWorkspaceId(workspaceId);
    return this.serialize(workspaceId, () => this.read(workspaceId));
  }

  /**
   * Stores `doc` as `baseRevision + 1` only if `baseRevision` is still the
   * stored revision. `undone` names pages the person's undo took off, which
   * are not remembered as removed, so Aiden writing one again shows it again.
   * `beforeWrite` runs on the workspace's chain just before the file is
   * written, as for `update`; throwing there writes nothing.
   *
   * Chats' own pages are main's: the save's `chatPages` and `namedFor` are
   * merged with the stored ones (`mergeSavedChatPages`). A save never adds or
   * moves a claim, except to give back a claim on a page it brings back that
   * this store recorded when the page was deleted, while the chat is still
   * where that delete moved it. The record changes only once the write lands.
   */
  async save(
    workspaceId: string,
    doc: DesignCanvas,
    baseRevision: number,
    options: {
      undone?: readonly string[];
      beforeWrite?: () => Promise<void> | void;
      /**
       * Which of these chats are live in this workspace. Asked on the chain,
       * only for the chats a page this save brings back was made for, as the
       * delete record has it; a brought-back page keeps `namedFor` only for a
       * live chat. Left out, every chat counts as live.
       */
      chatsLive?: (chatIds: string[]) => Promise<ReadonlySet<string>>;
    } = {},
  ): Promise<DesignCanvasSaveResult> {
    assertDesignCanvasWorkspaceId(workspaceId);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new Error("Invalid canvas revision.");
    }
    const parsed = parseDesignCanvas(isRecord(doc) ? { ...doc, revision: baseRevision } : doc);
    if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues };
    const tooLarge = (): DesignCanvasSaveResult => ({
      ok: false,
      reason: "invalid",
      issues: ["The canvas is too large to save."],
    });
    if (this.tooLarge(parsed.doc)) return tooLarge();
    return this.serialize(workspaceId, async () => {
      const current = await this.read(workspaceId);
      if (current.revision !== baseRevision) return { ok: false, reason: "conflict", doc: current };
      const revision = baseRevision + 1;
      const deleted = this.deletedOf(workspaceId);
      const isLive = await this.livenessFor(current, parsed.doc, deleted, options.chatsLive);
      const merged = mergeSavedChatPages(current, parsed.doc, deleted, isLive);
      // A save comes from the person's canvas: a page they took off is remembered,
      // unless it was their undo that took it off.
      const doc = withRemovedPagePaths(current, { ...merged.doc, revision }, true, new Set(options.undone ?? []));
      // The pages remembered as taken off count too: what is written must read back.
      if (this.tooLarge(doc)) return tooLarge();
      await options.beforeWrite?.();
      await this.write(workspaceId, doc);
      this.forgetRestored(workspaceId, merged.restored);
      this.remember(workspaceId, removedPageIds(current, doc), merged.deletedNow);
      if (!merged.changed) return { ok: true, revision };
      const namedFor = Object.fromEntries(
        doc.pages.flatMap((page) => (page.namedFor !== undefined ? [[page.id, page.namedFor]] : [])),
      );
      return { ok: true, revision, chatPages: { ...doc.chatPages }, namedFor };
    });
  }

  /**
   * Applies `mutate` to the latest canvas and stores the result at the next
   * revision. `beforeWrite` runs on the workspace's chain just before the file is
   * written, so a check that may change while the update waits (design mode
   * still on, say) is made as late as possible; throwing there writes nothing.
   */
  async update(
    workspaceId: string,
    mutate: (doc: DesignCanvas) => DesignCanvas,
    options: { beforeWrite?: () => Promise<void> | void } = {},
  ): Promise<DesignCanvas> {
    assertDesignCanvasWorkspaceId(workspaceId);
    return this.serialize(workspaceId, async () => {
      const current = await this.read(workspaceId);
      const next = mutate(structuredClone(current));
      const revision = current.revision + 1;
      const parsed = parseDesignCanvas(isRecord(next) ? { ...next, revision } : next);
      if (!parsed.ok) throw new Error(`The canvas update is invalid: ${parsed.issues.join(" ")}`);
      // An update comes from Aiden or the app itself: a page shown again is forgotten, but no removal is noted.
      const doc = withRemovedPagePaths(current, parsed.doc, false);
      if (this.tooLarge(doc)) throw new Error("The canvas is too large to save.");
      await options.beforeWrite?.();
      await this.write(workspaceId, doc);
      this.remember(workspaceId, removedPageIds(current, doc), deletedClaims(current, doc));
      return doc;
    });
  }

  /** Removes the workspace's canvas file and any copies set aside as corrupt. Missing is fine. */
  async delete(workspaceId: string): Promise<void> {
    assertDesignCanvasWorkspaceId(workspaceId);
    return this.serialize(workspaceId, async () => {
      await fs.rm(this.file(workspaceId), { force: true });
      const prefix = `${workspaceId}.json.corrupt-`;
      const names = await fs.readdir(this.root()).catch((error: unknown) => {
        if (isMissing(error)) return [] as string[];
        throw error;
      });
      for (const name of names) {
        if (name.startsWith(prefix)) await fs.rm(path.join(this.root(), name), { force: true });
      }
      // Only once the files are gone: a delete that fails leaves the canvas, so undo still needs the record.
      this.deletedPages.delete(workspaceId);
    });
  }

  /**
   * Liveness for the chats whose page `saved` brings back with the
   * `namedFor` the delete record holds: usually none, so nothing is asked.
   */
  private async livenessFor(
    current: DesignCanvas,
    saved: DesignCanvas,
    deleted: ReadonlyMap<string, DeletedPage>,
    chatsLive: ((chatIds: string[]) => Promise<ReadonlySet<string>>) | undefined,
  ): Promise<((chatId: string) => boolean) | undefined> {
    if (!chatsLive) return undefined;
    const stored = new Set(current.pages.map((page) => page.id));
    const asked = new Set<string>();
    for (const page of saved.pages) {
      if (stored.has(page.id) || page.namedFor === undefined) continue;
      if (deleted.get(page.id)?.namedFor === page.namedFor) asked.add(page.namedFor);
    }
    if (asked.size === 0) return undefined;
    const live = await chatsLive([...asked]);
    return (chatId) => !asked.has(chatId) || live.has(chatId);
  }

  private deletedOf(workspaceId: string): ReadonlyMap<string, DeletedPage> {
    return this.deletedPages.get(workspaceId) ?? new Map();
  }

  /**
   * Records pages a write deleted. Every page it removed forgets what an older
   * delete of that id recorded, even when this delete had nothing to record.
   */
  private remember(workspaceId: string, removed: readonly string[], deleted: ReadonlyMap<string, DeletedPage>): void {
    let record = this.deletedPages.get(workspaceId);
    if (record) for (const pageId of removed) record.delete(pageId);
    if (deleted.size === 0) {
      if (record?.size === 0) this.deletedPages.delete(workspaceId);
      return;
    }
    if (!record) this.deletedPages.set(workspaceId, (record = new Map()));
    for (const [pageId, entry] of deleted) {
      record.delete(pageId);
      record.set(pageId, entry);
    }
    for (const pageId of record.keys()) {
      if (record.size <= DELETED_PAGES_LIMIT) break;
      record.delete(pageId);
    }
  }

  /** Takes what a save gave back out of the record, so a later undo acts on the newest delete only. */
  private forgetRestored(workspaceId: string, restored: ReadonlyMap<string, DeletedPage>): void {
    const record = this.deletedPages.get(workspaceId);
    if (!record) return;
    for (const [pageId, given] of restored) {
      const entry = record.get(pageId);
      if (!entry) continue;
      for (const chatId of given.claims.keys()) entry.claims.delete(chatId);
      if (given.namedFor !== undefined && entry.namedFor === given.namedFor) delete entry.namedFor;
      if (entry.claims.size === 0 && entry.namedFor === undefined) record.delete(pageId);
    }
    if (record.size === 0) this.deletedPages.delete(workspaceId);
  }

  private file(workspaceId: string): string {
    return path.join(this.root(), `${workspaceId}.json`);
  }

  private async read(workspaceId: string): Promise<DesignCanvas> {
    let text: string;
    try {
      const file = this.file(workspaceId);
      const stat = await fs.stat(file);
      if (!stat.isFile()) return emptyDesignCanvas();
      if (stat.size > this.maxDocumentBytes) return this.setAside(workspaceId);
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return emptyDesignCanvas();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.setAside(workspaceId);
    }
    const parsed = parseDesignCanvas(value);
    return parsed.ok ? parsed.doc : this.setAside(workspaceId);
  }

  /**
   * Moves an unreadable canvas to `<workspaceId>.json.corrupt-<ms>` so the next
   * save starts a fresh canvas without destroying what was there. Runs on the
   * workspace's chain, so the file it moves is the one it just read.
   */
  private async setAside(workspaceId: string): Promise<DesignCanvas> {
    const file = this.file(workspaceId);
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    return emptyDesignCanvas();
  }

  /** A document the read cap would turn back into an empty canvas is never written. */
  private tooLarge(doc: DesignCanvas): boolean {
    return Buffer.byteLength(JSON.stringify(doc), "utf8") > this.maxDocumentBytes;
  }

  private write(workspaceId: string, doc: DesignCanvas): Promise<void> {
    return this.writeJson(this.file(workspaceId), doc, { mode: 0o600, mkdirMode: 0o700 });
  }

  /**
   * Clears the folder of anything written before v3 (per-chat canvases and
   * their corrupt copies) the first time this store is used, unless the
   * marker says it already holds only v3 canvases. One promise for the
   * store, so first calls on different workspaces share one clear; a failed
   * clear is tried again by the next call.
   */
  private ensureLayout(): Promise<void> {
    this.layout ??= this.clearOldLayout().catch((error: unknown) => {
      this.layout = null;
      throw error;
    });
    return this.layout;
  }

  private async clearOldLayout(): Promise<void> {
    const root = this.root();
    const marker = path.join(root, DESIGN_CANVAS_LAYOUT_MARKER);
    try {
      await fs.stat(marker);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const names = await fs.readdir(root).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    for (const name of names) await fs.rm(path.join(root, name), { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(marker, "", { mode: 0o600 });
  }

  private serialize<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const work = async () => {
      await this.ensureLayout();
      return task();
    };
    const previous = this.chains.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.chains.set(workspaceId, tail);
    void tail.then(() => {
      if (this.chains.get(workspaceId) === tail) this.chains.delete(workspaceId);
    });
    return run;
  }
}

/** The ids of the pages `before` has and `after` does not. */
function removedPageIds(before: DesignCanvas, after: DesignCanvas): string[] {
  const kept = new Set(after.pages.map((page) => page.id));
  return before.pages.filter((page) => !kept.has(page.id)).map((page) => page.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A store call through a chat: the result, and the workspace whose canvas it used. */
export type DesignChatCanvasRead = { doc: DesignCanvas; workspaceId: string };
export type DesignChatCanvasSave = { result: DesignCanvasSaveResult; workspaceId: string };

/**
 * The workspace canvas store seen through chats. Each call finds the chat's
 * workspace once (or takes the one the caller already resolved from the chat
 * it checked) and returns it, so whatever the caller does next (broadcast,
 * focus) names the same workspace even if the chat moves meanwhile.
 */
export class DesignChatCanvases {
  private readonly store: Pick<DesignCanvasStore, "get" | "save" | "update">;
  private readonly resolveWorkspace: (chatId: string) => Promise<string | null>;
  private readonly workspaceExists: ((workspaceId: string) => Promise<boolean>) | undefined;
  private readonly chatIsLive: ((chatId: string, workspaceId: string) => Promise<boolean>) | undefined;

  constructor(options: {
    store: Pick<DesignCanvasStore, "get" | "save" | "update">;
    workspaceIdOf(chatId: string): Promise<string | null>;
    /**
     * Whether the workspace still has its record. A removed workspace's canvas
     * is refused. Writes ask on the workspace's chain, just before the file is
     * written: removal deletes the record before it queues the file's delete
     * on that chain, so a write queued before the delete is deleted with it,
     * and one queued after finds the record gone and writes nothing.
     */
    workspaceExists?(workspaceId: string): Promise<boolean>;
    /**
     * Whether the chat still exists and is in that workspace. A save asks it,
     * on the workspace's chain, only for the chats a page it brings back was
     * made for, so that page follows only a live chat. Left out, every chat
     * counts as live.
     */
    chatIsLive?(chatId: string, workspaceId: string): Promise<boolean>;
  }) {
    this.store = options.store;
    this.resolveWorkspace = options.workspaceIdOf;
    this.workspaceExists = options.workspaceExists;
    this.chatIsLive = options.chatIsLive;
  }

  /** The chat's workspace id, or null when the chat is gone. */
  async workspaceIdOf(chatId: string): Promise<string | null> {
    assertDesignCanvasChatId(chatId);
    return this.resolveWorkspace(chatId);
  }

  async get(chatId: string, options: { workspaceId?: string } = {}): Promise<DesignChatCanvasRead> {
    const workspaceId = await this.workspaceFor(chatId, options.workspaceId);
    return { doc: await this.store.get(workspaceId), workspaceId };
  }

  async save(
    chatId: string,
    doc: DesignCanvas,
    baseRevision: number,
    options: { undone?: readonly string[]; workspaceId?: string } = {},
  ): Promise<DesignChatCanvasSave> {
    const workspaceId = await this.workspaceFor(chatId, options.workspaceId);
    const ask = this.chatIsLive;
    const result = await this.store.save(workspaceId, doc, baseRevision, {
      ...(options.undone ? { undone: options.undone } : {}),
      beforeWrite: () => this.assertWorkspaceExists(workspaceId),
      ...(ask
        ? {
            chatsLive: async (chatIds: string[]) => {
              const live = await Promise.all(chatIds.map((id) => ask(id, workspaceId)));
              return new Set(chatIds.filter((_, index) => live[index]));
            },
          }
        : {}),
    });
    return { result, workspaceId };
  }

  async update(
    chatId: string,
    mutate: (doc: DesignCanvas) => DesignCanvas,
    options: { beforeWrite?: () => Promise<void> | void; workspaceId?: string } = {},
  ): Promise<DesignChatCanvasRead> {
    const workspaceId = await this.workspaceFor(chatId, options.workspaceId);
    const beforeWrite = options.beforeWrite;
    const doc = await this.store.update(workspaceId, mutate, {
      beforeWrite: async () => {
        await this.assertWorkspaceExists(workspaceId);
        await beforeWrite?.();
      },
    });
    return { doc, workspaceId };
  }

  private async workspaceFor(chatId: string, given: string | undefined): Promise<string> {
    assertDesignCanvasChatId(chatId);
    let workspaceId: string;
    if (given !== undefined) {
      assertDesignCanvasWorkspaceId(given);
      workspaceId = given;
    } else {
      const resolved = await this.resolveWorkspace(chatId);
      if (resolved === null) throw new DesignCanvasUnavailableError("This chat is no longer available.");
      workspaceId = resolved;
    }
    // Asked again on the chain before a write; this early answer only spares the wait.
    await this.assertWorkspaceExists(workspaceId);
    return workspaceId;
  }

  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    if (this.workspaceExists && !(await this.workspaceExists(workspaceId))) {
      throw new DesignCanvasUnavailableError("This workspace is no longer available.");
    }
  }
}
