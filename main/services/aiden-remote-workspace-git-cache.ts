import type { GitInfo } from "./types.js";

/** The small Git summary a Remote workspace may carry: no paths, remotes or refs beyond the branch name. */
export interface AidenRemoteWorkspaceGitSummary {
  isRepo: boolean;
  branch?: string;
  uncommitted?: number;
}

/** One background read: the folder's repository root (the folder itself outside a repository) and its status. */
export interface AidenRemoteWorkspaceGitRead {
  root: string;
  info: GitInfo;
}

const BRANCH_MAX_CODE_POINTS = 255;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reduces a Git status read to the Remote summary: whether the folder is a
 * repository, its branch name and its count of uncommitted entries. Nothing
 * else in `GitInfo` (upstream, remotes, default branch) crosses the wire. A
 * detached HEAD has no branch, and a long branch name is cut on a code-point
 * boundary so a surrogate pair is never split.
 */
export function projectAidenRemoteWorkspaceGit(info: GitInfo): AidenRemoteWorkspaceGitSummary | undefined {
  if (typeof info?.isRepo !== "boolean") return undefined;
  if (!info.isRepo) return { isRepo: false };
  const branch = !info.detached && typeof info.branch === "string" && info.branch.length > 0 && !hasControlCharacter(info.branch)
    ? Array.from(info.branch).slice(0, BRANCH_MAX_CODE_POINTS).join("")
    : undefined;
  const uncommitted = Number.isSafeInteger(info.uncommitted) && info.uncommitted! >= 0 ? info.uncommitted : undefined;
  return {
    isRepo: true,
    ...(branch ? { branch } : {}),
    ...(uncommitted !== undefined ? { uncommitted } : {}),
  };
}

export interface AidenRemoteWorkspaceGitCacheOptions {
  /** Reads one folder. It should throw for anything but a clean answer; a throw leaves the folder without a summary. */
  read: (folderPath: string, signal: AbortSignal) => Promise<AidenRemoteWorkspaceGitRead>;
  now?: () => number;
  /** Runs `run` after `ms`, returning a cancel function. Defaults to an unref'd timer. */
  schedule?: (ms: number, run: () => void) => () => void;
  /** How long a summary is served before a background refresh. */
  freshMs?: number;
  /** How long one background read may take before it is abandoned and counted as a failure. */
  readTimeoutMs?: number;
  /** How many background reads may run at once. */
  concurrency?: number;
  /** The longest wait before a folder that keeps failing is read again. */
  backoffMaxMs?: number;
  /** How many repositories and folders are remembered. */
  maxEntries?: number;
  /**
   * How many reads past their deadline may give up their slot while they are
   * still running. Beyond this, a stuck read keeps its slot until it ends.
   */
  maxAbandoned?: number;
}

export const AIDEN_REMOTE_WORKSPACE_GIT_FRESH_MS = 30_000;
export const AIDEN_REMOTE_WORKSPACE_GIT_READ_TIMEOUT_MS = 15_000;
export const AIDEN_REMOTE_WORKSPACE_GIT_CONCURRENCY = 3;
export const AIDEN_REMOTE_WORKSPACE_GIT_BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_MAX_ENTRIES = 1_024;
export const AIDEN_REMOTE_WORKSPACE_GIT_MAX_ABANDONED = 8;

interface Entry {
  summary?: AidenRemoteWorkspaceGitSummary;
  readAt: number;
  /** The folder the entry was last read through. */
  folder: string;
}

/** A folder whose last read failed: it shows no summary and is not read again before `retryAt`. */
interface Failure {
  /** Consecutive failures; the record is dropped after a clean read. */
  failures: number;
  retryAt: number;
}

interface Job {
  key: string;
  folder: string;
}

function unrefSchedule(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Workspace Git summaries served from memory and refreshed in the background
 * (stale-while-revalidate), so a workspace request never waits on Git.
 *
 * Entries are keyed by repository root, so folders in one repository share a
 * read; a folder whose root is not known yet is keyed by its own path. `peek`
 * answers at once with whatever is cached (nothing before the first read
 * finishes) and queues a refresh when the entry is missing or stale. Refreshes
 * run under a small concurrency limit, one per key at a time, each under its
 * own deadline. A failed or abandoned read clears that folder's summary and
 * backs the folder off, doubling the wait on each further failure; other
 * folders of the same repository keep their summary and are not backed off.
 * A read that outlives its deadline gives up its slot, but its key stays taken
 * until the read really ends, so a folder stuck in the filesystem holds at
 * most one read and never stops other folders from being read.
 */
export class AidenRemoteWorkspaceGitCache {
  private readonly now: () => number;
  private readonly schedule: (ms: number, run: () => void) => () => void;
  private readonly freshMs: number;
  private readonly readTimeoutMs: number;
  private readonly concurrency: number;
  private readonly backoffMaxMs: number;
  private readonly maxEntries: number;
  private readonly roots = new Map<string, string>();
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, Failure>();
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<string>();
  private active = 0;
  /** Reads past their deadline that gave up their slot and haven't ended yet. */
  private abandoned = 0;
  private readonly maxAbandoned: number;

  constructor(private readonly options: AidenRemoteWorkspaceGitCacheOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? unrefSchedule;
    this.freshMs = options.freshMs ?? AIDEN_REMOTE_WORKSPACE_GIT_FRESH_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? AIDEN_REMOTE_WORKSPACE_GIT_READ_TIMEOUT_MS;
    this.concurrency = Math.max(1, options.concurrency ?? AIDEN_REMOTE_WORKSPACE_GIT_CONCURRENCY);
    this.backoffMaxMs = options.backoffMaxMs ?? AIDEN_REMOTE_WORKSPACE_GIT_BACKOFF_MAX_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxAbandoned = Math.max(0, options.maxAbandoned ?? AIDEN_REMOTE_WORKSPACE_GIT_MAX_ABANDONED);
  }

  /** The cached summary for a folder, stale or not; queues a background refresh when one is due. Never waits. */
  peek(folderPath: string): AidenRemoteWorkspaceGitSummary | undefined {
    const key = this.roots.get(folderPath) ?? folderPath;
    const now = this.now();
    const failure = this.failures.get(folderPath);
    if (failure) {
      // The folder shows nothing until a read through it succeeds again.
      if (now >= failure.retryAt) this.enqueue({ key, folder: folderPath });
      return undefined;
    }
    const entry = this.entries.get(key);
    if (!entry || now - entry.readAt >= this.freshMs) {
      this.enqueue({ key, folder: folderPath });
    }
    return entry?.summary;
  }

  private enqueue(job: Job): void {
    if (this.queued.has(job.key) || this.inFlight.has(job.key)) return;
    this.queued.add(job.key);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queued.delete(job.key);
      this.inFlight.add(job.key);
      this.active += 1;
      this.start(job);
    }
  }

  private start(job: Job): void {
    const controller = new AbortController();
    let recorded = false;
    let slotHeld = true;
    let abandoned = false;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      this.active -= 1;
      this.pump();
    };
    const record = (read: AidenRemoteWorkspaceGitRead | undefined) => {
      if (recorded) return;
      recorded = true;
      cancelDeadline();
      if (read) this.recordRead(job, read);
      else this.recordFailure(job);
    };
    const cancelDeadline = this.schedule(this.readTimeoutMs, () => {
      controller.abort();
      record(undefined);
      // A read stuck in an uncancellable filesystem call (a dead network mount)
      // may never settle. It gives up its slot so other folders keep being read,
      // but its key stays taken below, so the folder never has a second read.
      // At most `maxAbandoned` do so at once; past that a stuck read keeps its
      // slot, so stuck reads never exceed `maxAbandoned + concurrency`.
      if (slotHeld && this.abandoned < this.maxAbandoned) {
        this.abandoned += 1;
        abandoned = true;
        releaseSlot();
      }
    });
    let pending: Promise<AidenRemoteWorkspaceGitRead>;
    try {
      pending = Promise.resolve(this.options.read(job.folder, controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    // The key stays taken until the read itself settles, even past its
    // deadline, so reads stuck in the filesystem cannot pile up for one folder.
    void pending
      .then((read) => record(read), () => record(undefined))
      .finally(() => {
        this.inFlight.delete(job.key);
        if (abandoned) this.abandoned -= 1;
        if (slotHeld) releaseSlot();
        else this.pump();
      });
  }

  private recordRead(job: Job, read: AidenRemoteWorkspaceGitRead): void {
    const root = read.root;
    this.remember(this.roots, job.folder, root);
    if (job.key !== root && job.key === job.folder) this.entries.delete(job.key);
    this.failures.delete(job.folder);
    this.remember(this.entries, root, {
      summary: projectAidenRemoteWorkspaceGit(read.info),
      readAt: this.now(),
      folder: job.folder,
    });
  }

  private recordFailure(job: Job): void {
    const now = this.now();
    // Forget which repository the folder was in: it may have moved or gone.
    this.roots.delete(job.folder);
    // The failure is the folder's own, kept apart from the repository's shared
    // entry. A shared entry read through this folder is marked stale rather
    // than overwritten, so another folder of that repository keeps its summary
    // and reads it afresh instead of inheriting this failure and its back-off.
    const shared = this.entries.get(job.key);
    if (shared?.folder === job.folder) shared.readAt = Number.NEGATIVE_INFINITY;
    const failures = (this.failures.get(job.folder)?.failures ?? 0) + 1;
    this.remember(this.failures, job.folder, {
      failures,
      retryAt: now + Math.min(this.backoffMaxMs, this.freshMs * 2 ** failures),
    });
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
