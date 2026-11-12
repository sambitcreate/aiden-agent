// Watches the workspace files a chat's design canvas shows, so a frame reloads
// when Aiden (or anything else) rewrites its page or the assets beside it.
// One watcher per folder; the paths are re-validated against the workspace on
// every `set`, and nothing outside the workspace root is ever watched.
//
// A page the canvas itself rewrote (the person editing its words) is not
// reported for that write: the canvas already shows those words, or reloads
// the page itself. The file system can report one write more than once, and
// late, so a report for it could otherwise reload the page under the person's
// next edit. A change of the page to anything else is reported as usual.
// An event that names no file could also be a stylesheet or an image beside
// the page. It is put down to the canvas's write only for a few seconds after
// that write, and only while the files beside the page are as they were when
// the write began and none of them was touched shortly before or since;
// otherwise it reports the page. The canvas's write changes only the page
// itself, so a change beside it is usually someone else's. It can also be the
// canvas editing another page in the same folder within those seconds, which
// reloads this page once more than needed.
// The canvas's writes are remembered only for the pages it still watches, so
// a page that stops being watched and comes back reports any change again.

import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import { watch as fsWatch } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { isDesignRelativePath } from "../../../renderer/shared/design-canvas/schema.js";
import { isPathInside } from "../../shared/path-containment.js";

/** The most workspace paths one chat's canvas watches. */
export const DESIGN_WATCH_LIMIT = 50;
/** Quiet period before a burst of writes is reported, in milliseconds. */
export const DESIGN_WATCH_DEBOUNCE_MS = 150;
/**
 * How long after the canvas's own write to a page an event naming no file is
 * still put down to that write, in milliseconds. A late or repeated report of
 * the write arrives well within it; a later unnamed event may be an asset.
 */
export const DESIGN_OWN_WRITE_WINDOW_MS = 3000;
/**
 * The most folder entries looked at beside a page, hidden ones included; past
 * it nothing beside the page counts as unchanged.
 */
export const DESIGN_NEIGHBOURHOOD_LIMIT = 500;

/** The files beside a page: `rows` to compare, and the latest time any of them was modified or changed. */
type Neighbours = { rows: string; latest: number };

const NOTHING_NOTED: Promise<Neighbours | null> = Promise.resolve(null);

export const DESIGN_FILES_CHANGED_CHANNEL = "designCanvas:filesChanged";

/** Broadcast on `designCanvas:filesChanged`. */
export type DesignFilesChanged = { chatId: string; paths: string[] };

type WatchListener = (event: string, filename: string | Buffer | null) => void;
type WatchFn = (
  folder: string,
  options: { recursive: boolean; persistent: boolean },
  listener: WatchListener,
) => Pick<fs.FSWatcher, "close" | "on">;

type ChatWatch = {
  root: string;
  generation: number;
  folders: Array<{ close(): void }>;
  /** Each queued path → what the events that queued it say about it. */
  pending: Map<string, Queued>;
  timer: ReturnType<typeof setTimeout> | null;
};

const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/**
 * Why a page is queued. `beside`: an event named a file next to it (a
 * stylesheet, an image), so it is reported whatever it holds. Otherwise only
 * events naming the page queued it, or also events naming no file, the last
 * of which arrived at `unnamedAt`.
 */
type Queued = { beside: boolean; unnamedAt: number | null };

/**
 * A write of the canvas to one of its pages; `settled` once the file holds it
 * or the write gave up, at `settledAt`. `beside` is what the files beside the
 * page were as the write began, or null when they couldn't all be read.
 */
type OwnWrite = {
  digest: string;
  settled: Promise<void>;
  settledAt: number | null;
  /** Wall-clock time the write began, as file times are kept. */
  startedAt: number;
  /**
   * How far the clock that stamps the page's file times ran behind this
   * Mac's as the write settled, in milliseconds: 0 or less. A network volume
   * stamps files by its own clock.
   */
  fileClockOffset: Promise<number>;
  beside: Promise<Neighbours | null>;
};

export class DesignFileWatcher {
  private readonly chats = new Map<string, ChatWatch>();
  private readonly generations = new Map<string, number>();
  /** Per chat, the canvas's latest write to each of its pages. */
  private readonly ownWrites = new Map<string, Map<string, OwnWrite>>();
  private readonly watch: WatchFn;
  private readonly debounceMs: number;
  private readonly ownWriteWindowMs: number;
  private readonly neighbourLookbackMs: number;
  /** Per chat, how many flushes are reading the canvas's notes of the files beside its pages. */
  private readonly flushing = new Map<string, number>();
  /** Per chat, the timers that let go of its writes' notes once their windows pass. */
  private readonly noteTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  private readonly now: () => number;
  private readonly wallNow: () => number;

  constructor(
    private readonly deps: {
      onChange(update: DesignFilesChanged): void;
      /** Re-checked before every report; false closes the chat's watchers. */
      allowed?: (chatId: string, root: string) => boolean;
      watch?: WatchFn;
      debounceMs?: number;
      ownWriteWindowMs?: number;
      /** A monotonic clock in milliseconds. */
      now?: () => number;
      /** Wall-clock time in milliseconds, as file times are kept. */
      wallNow?: () => number;
      /**
       * How long before the canvas's write began a neighbour modified or
       * changed then still counts as touched since; by default the
       * own-write window, so a change made just before the edit and
       * reported late is caught too.
       */
      neighbourLookbackMs?: number;
      /** Runs while the files beside a page are noted for a write, once they are listed. */
      noting?: () => Promise<void>;
    },
  ) {
    this.watch = deps.watch ?? ((folder, options, listener) => fsWatch(folder, options, listener));
    this.debounceMs = deps.debounceMs ?? DESIGN_WATCH_DEBOUNCE_MS;
    this.ownWriteWindowMs = deps.ownWriteWindowMs ?? DESIGN_OWN_WRITE_WINDOW_MS;
    this.neighbourLookbackMs = deps.neighbourLookbackMs ?? this.ownWriteWindowMs;
    this.now = deps.now ?? (() => performance.now());
    this.wallNow = deps.wallNow ?? (() => Date.now());
  }

  /** Replaces the chat's watched set. An empty list stops watching. */
  async set(chatId: string, root: string, relativePaths: readonly string[]): Promise<void> {
    const generation = (this.generations.get(chatId) ?? 0) + 1;
    this.generations.set(chatId, generation);
    const unique = [...new Set(relativePaths.filter(isDesignRelativePath))].slice(0, DESIGN_WATCH_LIMIT);
    this.forgetUnwatchedWrites(chatId, unique);
    const byFolder = await this.groupByRealFolder(root, unique);
    // A newer `set` (or a `clear`) ran while we checked the disk.
    if (this.generations.get(chatId) !== generation) return;
    this.close(chatId);
    if (!byFolder) return;

    const entry: ChatWatch = { root, generation, folders: [], pending: new Map(), timer: null };
    for (const [folder, { paths, recursive }] of byFolder) {
      try {
        const handle = this.watch(folder, { recursive, persistent: false }, (_event, filename) => {
          const name = filename === null ? null : String(filename);
          // Editors and git churn hidden files; they never change what a frame shows.
          if (name?.split(/[\\/]/u).some((segment) => segment.startsWith("."))) return;
          // A watched page that changed reloads alone; anything else in the folder
          // (a stylesheet, an image, an unnamed event) may feed every page there.
          // An unnamed event may also be one of the pages changing by itself, so
          // each page it queues is checked against the canvas's own write.
          const page = name === null ? undefined : paths.find((relative) => path.posix.basename(relative) === name);
          this.queue(chatId, generation, page ? [page] : paths, page ? "page" : name === null ? "unnamed" : "beside");
        });
        // A folder removed while watched errors once; the frame shows its own missing state.
        handle.on("error", () => handle.close());
        entry.folders.push(handle);
      } catch {
        // The folder vanished between the check and the watch: nothing to watch there.
      }
    }
    if (entry.folders.length > 0) this.chats.set(chatId, entry);
  }

  clear(chatId: string): void {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    this.ownWrites.delete(chatId);
    for (const timer of this.noteTimers.get(chatId) ?? []) clearTimeout(timer);
    this.noteTimers.delete(chatId);
    this.close(chatId);
  }

  /**
   * The canvas is about to write `content` to one of its pages. Until the page
   * changes to something else, reports of that page holding this content are
   * dropped: events naming the page, and for `DESIGN_OWN_WRITE_WINDOW_MS`
   * after the write, events naming no file. A report waits for the write to
   * finish, so it never reads the file between this call and the write. Call
   * the returned function once the write has finished, saying whether the
   * file now holds `content`.
   */
  ownWrite(chatId: string, relativePath: string, content: string): (written: boolean) => void {
    const writes = this.ownWrites.get(chatId) ?? new Map<string, OwnWrite>();
    this.ownWrites.set(chatId, writes);
    const before = writes.get(relativePath);
    let settle = () => {};
    const root = this.chats.get(chatId)?.root;
    const write: OwnWrite = {
      digest: digest(content),
      settled: new Promise<void>((resolve) => (settle = resolve)),
      settledAt: null,
      startedAt: this.wallNow(),
      fileClockOffset: Promise.resolve(0),
      beside: root === undefined ? NOTHING_NOTED : besidePage(root, relativePath, this.deps.noting),
    };
    writes.set(relativePath, write);
    return (written) => {
      if (!written && this.ownWrites.get(chatId) === writes && writes.get(relativePath) === write) {
        if (before === undefined) writes.delete(relativePath);
        else writes.set(relativePath, before);
      }
      // The page was just stamped by the clock that stamps the files beside it.
      if (written && root !== undefined) write.fileClockOffset = fileClockOffset(path.join(root, relativePath), this.wallNow);
      write.settledAt = this.now();
      settle();
      if (write.beside !== NOTHING_NOTED) this.letGoOfNoteAtDeadline(chatId, write);
    };
  }

  /** How many of the chat's latest page writes still keep a note of the files beside their page. */
  heldNotes(chatId: string): number {
    return [...(this.ownWrites.get(chatId)?.values() ?? [])].filter((write) => write.beside !== NOTHING_NOTED).length;
  }

  /**
   * Lets go of a write's note of the files beside its page once its window
   * has passed, without waiting for another event's report. An event still
   * queued from inside the window, or a report reading the note, keeps it,
   * and that report lets go of it.
   */
  private letGoOfNoteAtDeadline(chatId: string, write: OwnWrite): void {
    if (write.settledAt === null) return;
    const until = write.settledAt + this.ownWriteWindowMs;
    const timers = this.noteTimers.get(chatId) ?? new Set<ReturnType<typeof setTimeout>>();
    this.noteTimers.set(chatId, timers);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (timers.size === 0 && this.noteTimers.get(chatId) === timers) this.noteTimers.delete(chatId);
      this.forgetStaleNotes(chatId);
      // A timer may run a moment before the clock the window is measured on reaches its end.
      const current = [...(this.ownWrites.get(chatId)?.values() ?? [])].includes(write);
      if (current && write.beside !== NOTHING_NOTED && this.now() <= until) this.letGoOfNoteAtDeadline(chatId, write);
    }, Math.max(0, until - this.now()) + 1);
    timer.unref?.();
    timers.add(timer);
  }

  /** Resolves once the files beside the page of the canvas's latest write to it have been noted. */
  async noted(chatId: string, relativePath: string): Promise<void> {
    await this.ownWrites.get(chatId)?.get(relativePath)?.beside;
  }

  /**
   * Drops the canvas's writes to pages outside `watched`. Nothing reports such
   * a page while it is not watched, and a frame that shows it again loads it
   * from disk, so an old write must not hide its next change.
   */
  private forgetUnwatchedWrites(chatId: string, watched: readonly string[]): void {
    const writes = this.ownWrites.get(chatId);
    if (!writes) return;
    for (const relative of [...writes.keys()]) if (!watched.includes(relative)) writes.delete(relative);
    if (writes.size === 0) this.ownWrites.delete(chatId);
  }

  /** The canvas's settled latest write to a page, waiting out one in progress. */
  private async settledOwnWrite(chatId: string, relativePath: string): Promise<OwnWrite | undefined> {
    let write = this.ownWrites.get(chatId)?.get(relativePath);
    while (write) {
      await write.settled;
      const latest = this.ownWrites.get(chatId)?.get(relativePath);
      if (latest === write) return write;
      write = latest;
    }
    return undefined;
  }

  clearAll(): void {
    for (const chatId of [...this.chats.keys()]) this.clear(chatId);
  }

  /** Real folder → the watched paths inside it, or null when the root itself is gone. */
  private async groupByRealFolder(
    root: string,
    paths: readonly string[],
  ): Promise<Map<string, { paths: string[]; recursive: boolean }> | null> {
    if (paths.length === 0) return null;
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      return null;
    }
    const byFolder = new Map<string, { paths: string[]; recursive: boolean }>();
    for (const relative of paths) {
      let folder: string;
      try {
        folder = await fsp.realpath(path.join(realRoot, path.posix.dirname(relative)));
      } catch {
        continue;
      }
      if (!isPathInside(realRoot, folder, { allowRoot: true })) continue;
      // The workspace root itself is watched shallowly: a recursive watch there
      // would follow node_modules, build output and every other folder.
      const recursive = folder !== realRoot;
      const group = byFolder.get(folder) ?? { paths: [], recursive };
      group.paths.push(relative);
      byFolder.set(folder, group);
    }
    return byFolder.size > 0 ? byFolder : null;
  }

  private queue(chatId: string, generation: number, paths: readonly string[], kind: "page" | "unnamed" | "beside"): void {
    const entry = this.chats.get(chatId);
    if (!entry || entry.generation !== generation) return;
    const at = kind === "unnamed" ? this.now() : null;
    for (const relative of paths) {
      const queued = entry.pending.get(relative) ?? { beside: false, unnamedAt: null };
      entry.pending.set(relative, { beside: queued.beside || kind === "beside", unnamedAt: at ?? queued.unnamedAt });
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flush(chatId, entry), this.debounceMs);
  }

  private flush(chatId: string, entry: ChatWatch): void {
    entry.timer = null;
    if (this.chats.get(chatId) !== entry) return;
    if (this.deps.allowed && !this.deps.allowed(chatId, entry.root)) {
      this.clear(chatId);
      return;
    }
    const pending = [...entry.pending];
    entry.pending.clear();
    const writes = this.ownWrites.get(chatId);
    // Only a page whose own change could explain its events can be the
    // canvas's write; a change beside it (a stylesheet, an image) is reported
    // whatever the page holds, and so is an event naming no file once the
    // canvas's write is a few seconds old. A page the canvas never wrote, one
    // that no longer holds the canvas's bytes, or one that can't be read is
    // reported.
    const checks = pending.filter(([relative, queued]) => !queued.beside && writes?.has(relative));
    if (checks.length === 0) {
      this.report(chatId, pending.map(([relative]) => relative));
      this.forgetStaleNotes(chatId);
      return;
    }
    this.flushing.set(chatId, (this.flushing.get(chatId) ?? 0) + 1);
    void Promise.all(
      pending.map(async ([relative, queued]) => {
        const write = queued.beside ? undefined : await this.settledOwnWrite(chatId, relative);
        if (write === undefined) return relative;
        const { unnamedAt } = queued;
        if (unnamedAt !== null && unnamedAt > (write.settledAt ?? 0) + this.ownWriteWindowMs) return relative;
        const now = await fsp.readFile(path.join(entry.root, relative)).then(digest, () => null);
        if (now !== write.digest) return relative;
        if (unnamedAt === null) return null;
        // An event naming no file may be a stylesheet or an image beside the
        // page. The canvas never writes those, so one touched since shortly
        // before its write began is someone else's change, even one the
        // noting walk took in.
        const [then, beside, offset] = await Promise.all([write.beside, besidePage(entry.root, relative), write.fileClockOffset]);
        if (then === null || beside === null || beside.rows !== then.rows) return relative;
        // The files' times and the write's start are compared on the files' clock.
        return beside.latest < write.startedAt + offset - this.neighbourLookbackMs ? null : relative;
      }),
    )
      .then((paths) => {
        if (this.chats.get(chatId) !== entry) return;
        this.report(chatId, paths.filter((relative): relative is string => relative !== null));
      })
      .finally(() => {
        const left = (this.flushing.get(chatId) ?? 1) - 1;
        if (left > 0) this.flushing.set(chatId, left);
        else this.flushing.delete(chatId);
        this.forgetStaleNotes(chatId);
      });
  }

  /**
   * Drops the notes of the files beside the canvas's pages once nothing can
   * use them: the write's window has passed, no flush is reading them, and
   * no event still queued for the page arrived inside the window. A later
   * event arrives after the window and is reported without one.
   */
  private forgetStaleNotes(chatId: string): void {
    if (this.flushing.has(chatId)) return;
    const writes = this.ownWrites.get(chatId);
    if (!writes) return;
    const now = this.now();
    const pending = this.chats.get(chatId)?.pending;
    for (const [relative, write] of writes) {
      if (write.settledAt === null || write.beside === NOTHING_NOTED) continue;
      const until = write.settledAt + this.ownWriteWindowMs;
      if (now <= until) continue;
      const unnamedAt = pending?.get(relative)?.unnamedAt ?? null;
      if (unnamedAt !== null && unnamedAt <= until) continue;
      write.beside = NOTHING_NOTED;
    }
  }

  private report(chatId: string, paths: string[]): void {
    if (paths.length === 0) return;
    // The page reloads with whatever it holds now, so an earlier write of the canvas no longer matters.
    const writes = this.ownWrites.get(chatId);
    for (const relative of paths) writes?.delete(relative);
    this.deps.onChange({ chatId, paths });
  }

  private close(chatId: string): void {
    const entry = this.chats.get(chatId);
    if (!entry) return;
    this.chats.delete(chatId);
    if (entry.timer) clearTimeout(entry.timer);
    for (const handle of entry.folders) handle.close();
  }
}

/**
 * The files beside a page, as the watcher sees them: every file in the page's
 * folder (and below it, unless that is the workspace root) except the page,
 * each with its size, inode, and modification and change times. A symbolic
 * link is never walked into, and is noted by its own times and its target's,
 * since a page loads what it points at. Hidden entries are counted but never
 * entered: the watcher ignores them. Null, so nothing beside the page counts
 * as unchanged, when a folder can't be read, more than
 * `DESIGN_NEIGHBOURHOOD_LIMIT` entries are met (the walk stops early in a
 * large tree), or a link's target is missing, outside the workspace, or a
 * folder: the walk never enters one through a link, so a file inside it
 * could change unseen.
 *
 * The walk is not atomic: a file changed while it runs may be noted either
 * way, which is why a report also compares the files' times with when the
 * canvas's write began.
 */
async function besidePage(root: string, relativePath: string, noting?: () => Promise<void>): Promise<Neighbours | null> {
  const folder = path.join(root, path.posix.dirname(relativePath));
  const page = path.join(root, relativePath);
  const recursive = path.posix.dirname(relativePath) !== ".";
  const files: string[] = [];
  const folders = [folder];
  let seen = 0;
  try {
    for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
      const listing = await fsp.opendir(next);
      for await (const item of listing) {
        seen += 1;
        if (seen > DESIGN_NEIGHBOURHOOD_LIMIT) return null;
        if (item.name.startsWith(".")) continue;
        const entry = path.join(next, item.name);
        if (item.isDirectory()) {
          if (recursive) folders.push(entry);
        } else if ((item.isFile() || item.isSymbolicLink()) && entry !== page) {
          files.push(entry);
        }
      }
    }
  } catch {
    return null;
  }
  await noting?.();
  const realRoot = await fsp.realpath(root).catch(() => null);
  if (realRoot === null) return null;
  let latest = 0;
  const times = (stats: { size: number; ino: number; mtimeMs: number; ctimeMs: number }) => {
    latest = Math.max(latest, stats.mtimeMs, stats.ctimeMs);
    return `${stats.size}\0${stats.ino}\0${stats.mtimeMs}\0${stats.ctimeMs}`;
  };
  /** One neighbour's row; null when its link's target can't be shown unchanged. */
  const note = async (file: string): Promise<string | null> => {
    const name = path.relative(folder, file);
    const own = await fsp.lstat(file).catch(() => null);
    if (own === null) return `${name}\0gone`;
    if (!own.isSymbolicLink()) return `${name}\0${times(own)}`;
    const target = await fsp.realpath(file).catch(() => null);
    if (target === null || !isPathInside(realRoot, target, { allowRoot: true })) return null;
    const pointed = await fsp.stat(target).catch(() => null);
    // A linked folder is never walked, so a file inside it could change with neither row changing.
    if (pointed === null || pointed.isDirectory()) return null;
    return `${name}\0${times(own)}\0${target}\0${times(pointed)}`;
  };
  const rows = await Promise.all(files.map(note));
  if (rows.some((row) => row === null)) return null;
  return { rows: rows.sort().join("\n"), latest };
}

/**
 * How far the clock that stamps `file` runs behind this Mac's, from the time
 * it was just stamped: 0 or less, and 0 when it can't be read. A clock that
 * runs ahead needs nothing: the files beside the page then look newer, so
 * more of them count as touched since the write began.
 */
async function fileClockOffset(file: string, wallNow: () => number): Promise<number> {
  const stats = await fsp.stat(file).catch(() => null);
  return stats === null ? 0 : Math.min(0, Math.max(stats.mtimeMs, stats.ctimeMs) - wallNow());
}
