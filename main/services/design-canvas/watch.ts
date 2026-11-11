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
  /** Each queued path → whether only events naming that page queued it. */
  pending: Map<string, boolean>;
  timer: ReturnType<typeof setTimeout> | null;
};

const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** A write of the canvas to one of its pages; `settled` once the file holds it or the write gave up. */
type OwnWrite = { digest: string; settled: Promise<void> };

export class DesignFileWatcher {
  private readonly chats = new Map<string, ChatWatch>();
  private readonly generations = new Map<string, number>();
  /** Per chat, the canvas's latest write to each of its pages. */
  private readonly ownWrites = new Map<string, Map<string, OwnWrite>>();
  private readonly watch: WatchFn;
  private readonly debounceMs: number;

  constructor(
    private readonly deps: {
      onChange(update: DesignFilesChanged): void;
      /** Re-checked before every report; false closes the chat's watchers. */
      allowed?: (chatId: string, root: string) => boolean;
      watch?: WatchFn;
      debounceMs?: number;
    },
  ) {
    this.watch = deps.watch ?? ((folder, options, listener) => fsWatch(folder, options, listener));
    this.debounceMs = deps.debounceMs ?? DESIGN_WATCH_DEBOUNCE_MS;
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
          const page = name === null ? undefined : paths.find((relative) => path.posix.basename(relative) === name);
          this.queue(chatId, generation, page ? [page] : paths, page !== undefined);
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
    this.close(chatId);
  }

  /**
   * The canvas is about to write `content` to one of its pages. Until the page
   * changes to something else, reports of that page holding this content are
   * dropped. A report waits for the write to finish, so it never reads the
   * file between this call and the write. Call the returned function once the
   * write has finished, saying whether the file now holds `content`.
   */
  ownWrite(chatId: string, relativePath: string, content: string): (written: boolean) => void {
    const writes = this.ownWrites.get(chatId) ?? new Map<string, OwnWrite>();
    this.ownWrites.set(chatId, writes);
    const before = writes.get(relativePath);
    let settle = () => {};
    const write: OwnWrite = { digest: digest(content), settled: new Promise<void>((resolve) => (settle = resolve)) };
    writes.set(relativePath, write);
    return (written) => {
      if (!written && this.ownWrites.get(chatId) === writes && writes.get(relativePath) === write) {
        if (before === undefined) writes.delete(relativePath);
        else writes.set(relativePath, before);
      }
      settle();
    };
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

  private queue(chatId: string, generation: number, paths: readonly string[], named: boolean): void {
    const entry = this.chats.get(chatId);
    if (!entry || entry.generation !== generation) return;
    for (const relative of paths) entry.pending.set(relative, (entry.pending.get(relative) ?? true) && named);
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
    // Only a page named by its own events can be the canvas's write; a change
    // beside it (a stylesheet, an image) is reported whatever the page holds.
    const checks = pending.filter(([relative, named]) => named && writes?.has(relative));
    if (checks.length === 0) {
      this.report(chatId, pending.map(([relative]) => relative));
      return;
    }
    void Promise.all(
      pending.map(async ([relative, named]) => {
        const write = named ? await this.settledOwnWrite(chatId, relative) : undefined;
        if (write === undefined) return relative;
        const now = await fsp.readFile(path.join(entry.root, relative)).then(digest, () => null);
        return now === write.digest ? null : relative;
      }),
    ).then((paths) => {
      if (this.chats.get(chatId) !== entry) return;
      this.report(chatId, paths.filter((relative): relative is string => relative !== null));
    });
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
