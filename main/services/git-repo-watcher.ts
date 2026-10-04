// Pushes repository-state invalidations to the renderer so Git display reads do
// not need fast polling. Only Git metadata is observed (HEAD, index, refs,
// packed-refs), never the working tree, and a workspace is watched only after a
// display read asked for it and until it goes unread for the idle window.

import { watch as fsWatch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GitWatchTargets {
  /** Per-worktree administrative directory (HEAD, index). */
  gitDir: string;
  /** Shared directory (refs, packed-refs); equals gitDir outside linked worktrees. */
  commonDir: string;
}

type Watch = (
  target: string,
  options: { persistent: false; recursive?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => Pick<FSWatcher, "close" | "on">;

export interface GitRepoWatcherOptions {
  notify(workspaceId: string, generation: number): void;
  debounceMs?: number;
  idleMs?: number;
  watch?: Watch;
  resolveTargets?: (folderPath: string) => Promise<GitWatchTargets | undefined>;
  now?: () => number;
}

const ADMIN_FILES = new Set(["HEAD", "index", "packed-refs", "ORIG_HEAD", "MERGE_HEAD", "FETCH_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]);
const SHARED_FILES = new Set(["packed-refs"]);

async function readGitDirPointer(dotGit: string): Promise<string | undefined> {
  const text = await fs.readFile(dotGit, "utf8").catch(() => "");
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  return target ? path.resolve(path.dirname(dotGit), target) : undefined;
}

/** Finds the Git directories for a folder the way Git discovery would, following `.git` files and commondir. */
export async function resolveGitWatchTargets(folderPath: string): Promise<GitWatchTargets | undefined> {
  let dir = path.resolve(folderPath);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    const stat = await fs.stat(dotGit).catch(() => undefined);
    const gitDir = stat?.isDirectory() ? dotGit : stat?.isFile() ? await readGitDirPointer(dotGit) : undefined;
    if (gitDir) {
      const common = (await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
      return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface Entry {
  folderPath: string;
  lastRead: number;
  watchers: Pick<FSWatcher, "close">[];
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export class GitRepoWatcher {
  private readonly entries = new Map<string, Entry>();
  // Kept across watcher restarts so a workspace's generation never goes backwards.
  private readonly generations = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly watch: Watch;
  private readonly resolveTargets: (folderPath: string) => Promise<GitWatchTargets | undefined>;
  private readonly now: () => number;
  private sweep?: ReturnType<typeof setInterval>;

  constructor(private readonly options: GitRepoWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 250;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.watch = options.watch ?? (fsWatch as unknown as Watch);
    this.resolveTargets = options.resolveTargets ?? resolveGitWatchTargets;
    this.now = options.now ?? Date.now;
  }

  /** Records a display read; starts watching the workspace's repository if needed. */
  async observe(workspaceId: string, folderPath: string): Promise<void> {
    const existing = this.entries.get(workspaceId);
    if (existing && existing.folderPath === folderPath) {
      existing.lastRead = this.now();
      return;
    }
    if (existing) this.close(workspaceId);
    const entry: Entry = { folderPath, lastRead: this.now(), watchers: [], closed: false };
    this.entries.set(workspaceId, entry);
    this.ensureSweep();
    const targets = await this.resolveTargets(folderPath).catch(() => undefined);
    if (entry.closed || !targets) return;
    const onEvent = (names: ReadonlySet<string> | undefined) => (_event: string, filename: string | Buffer | null) => {
      const name = filename == null ? undefined : path.basename(filename.toString());
      if (names && name !== undefined && !names.has(name)) return;
      this.schedule(workspaceId, entry);
    };
    const add = (target: string, names: ReadonlySet<string> | undefined, recursive = false): boolean => {
      try {
        const watcher = this.watch(target, { persistent: false, ...(recursive ? { recursive: true } : {}) }, onEvent(names));
        watcher.on("error", () => {
          // A deleted or replaced Git dir: drop the entry so the next read re-resolves.
          if (this.entries.get(workspaceId) === entry) this.close(workspaceId);
          this.schedule(workspaceId, entry, true);
        });
        entry.watchers.push(watcher);
        return true;
      } catch {
        return false;
      }
    };
    add(targets.gitDir, ADMIN_FILES);
    if (targets.commonDir !== targets.gitDir) add(targets.commonDir, SHARED_FILES);
    const refs = path.join(targets.commonDir, "refs");
    if (!add(refs, undefined, true)) {
      // Hosts without recursive fs.watch still see local branch updates.
      add(path.join(refs, "heads"), undefined);
    }
  }

  generation(workspaceId: string): number {
    return this.generations.get(workspaceId) ?? 0;
  }

  get watchedWorkspaceCount(): number {
    return this.entries.size;
  }

  /** Closes watchers that have not been read for the idle window. */
  evictIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [workspaceId, entry] of this.entries) {
      if (entry.lastRead <= cutoff) this.close(workspaceId);
    }
    if (this.entries.size === 0 && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
  }

  close(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    for (const watcher of entry.watchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
  }

  dispose(): void {
    for (const workspaceId of [...this.entries.keys()]) this.close(workspaceId);
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
  }

  private schedule(workspaceId: string, entry: Entry, force = false): void {
    if (entry.closed && !force) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const generation = this.generation(workspaceId) + 1;
      this.generations.set(workspaceId, generation);
      this.options.notify(workspaceId, generation);
    }, this.debounceMs);
    entry.timer.unref?.();
  }

  private ensureSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.evictIdle(), Math.max(1_000, Math.floor(this.idleMs / 2)));
    this.sweep.unref?.();
  }
}
