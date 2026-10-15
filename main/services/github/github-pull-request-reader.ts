// Pull request reads that share work: identical reads in flight are answered
// once, reads issued within a short window travel in one GraphQL document
// (up to 25 per host), and answers are cached briefly by how fast they can
// change. Failures are never cached.

import type { GitHubApi } from "./github-api.js";
import {
  buildPullRequestDocument,
  pullRequestEntryKey,
  pullRequestEntryResults,
  type PullRequestEntryReader,
  type PullRequestEntryResult,
  type PullRequestQueryEntry,
  type PullRequestReadOptions,
} from "./github-pull-request-graphql.js";

const MINUTE = 60_000;
const DEFAULT_WINDOW_MS = 15;
const DEFAULT_MAX_ENTRIES = 25;
const DEFAULT_MAX_DOCUMENTS = 4;

type OkResult = Extract<PullRequestEntryResult, { kind: "ok" }>;

/** How long an answer stays fresh: settled states change slowly, running checks quickly. */
export function pullRequestCacheTtl(entry: PullRequestQueryEntry, result: OkResult): number {
  const open = result.pullRequests.filter((pullRequest) => pullRequest.state === "open");
  const checksRunning = open.some((pullRequest) => pullRequest.checksState === "pending");
  switch (entry.kind) {
    case "repository":
      return 30 * MINUTE;
    case "number":
      if (open.length === 0) return 10 * MINUTE;
      return checksRunning ? 15_000 : MINUTE;
    case "head":
      return checksRunning ? MINUTE : 4 * MINUTE;
    case "list":
      return MINUTE;
  }
}

interface QueuedRead {
  host: string;
  entry: PullRequestQueryEntry;
  key: string;
  operation: string;
  interactive: boolean;
  settle: (result: PullRequestEntryResult) => void;
}

export interface PullRequestReaderOptions {
  api: Pick<GitHubApi, "graphql">;
  now?: () => number;
  windowMs?: number;
  maxEntries?: number;
  maxDocuments?: number;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class BatchedPullRequestReader implements PullRequestEntryReader {
  private readonly api: Pick<GitHubApi, "graphql">;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly maxDocuments: number;
  private readonly cache = new Map<string, { result: OkResult; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<PullRequestEntryResult>>();
  private readonly queued = new Map<string, QueuedRead>();
  private flushScheduled = false;
  private activeDocuments = 0;
  private readonly waitingDocuments: Array<() => void> = [];

  constructor(options: PullRequestReaderOptions) {
    this.api = options.api;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  }

  read(host: string, entry: PullRequestQueryEntry, options: PullRequestReadOptions): Promise<PullRequestEntryResult> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const key = `${pullRequestEntryKey(host, entry)}${options.version ? `|${options.version}` : ""}`;
    const interactive = options.interactive === true;
    if (!interactive && !options.fresh) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.result);
    }
    let pending = this.inflight.get(key);
    if (pending) {
      const queued = this.queued.get(key);
      if (queued && interactive) queued.interactive = true;
    } else {
      pending = new Promise<PullRequestEntryResult>((settle) => {
        this.queued.set(key, { host, entry, key, operation: options.operation, interactive, settle });
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setTimeout(() => this.flush(), this.windowMs);
      }
    }
    return abortable(pending, options.signal);
  }

  private flush(): void {
    this.flushScheduled = false;
    const byHost = new Map<string, QueuedRead[]>();
    for (const read of this.queued.values()) byHost.set(read.host, [...(byHost.get(read.host) ?? []), read]);
    this.queued.clear();
    for (const [host, reads] of byHost) {
      for (let start = 0; start < reads.length; start += this.maxEntries) {
        void this.send(host, reads.slice(start, start + this.maxEntries));
      }
    }
  }

  private async send(host: string, reads: QueuedRead[]): Promise<void> {
    const release = await this.acquireDocument();
    // Reads that differ only in version or freshness ask GitHub the same question.
    const entryKeys = reads.map((read) => pullRequestEntryKey(host, read.entry));
    const unique = [...new Set(entryKeys)];
    const entries = unique.map((entryKey) => reads[entryKeys.indexOf(entryKey)]!.entry);
    let results: PullRequestEntryResult[];
    let splitFailedBatch = false;
    try {
      const document = buildPullRequestDocument(entries);
      const result = await this.api.graphql({
        host,
        operation: reads.length === 1 ? reads[0]!.operation : "pr.batch",
        interactive: reads.some((read) => read.interactive),
        ...document,
      });
      // A document-level GraphQL error names no alias; retry entries alone so
      // one bad read cannot fail its neighbours.
      splitFailedBatch = result.kind === "failed" && result.status === 200 && entries.length > 1;
      const answers = splitFailedBatch ? [] : pullRequestEntryResults(host, entries, result);
      results = entryKeys.map((entryKey) => answers[unique.indexOf(entryKey)]!);
    } catch {
      results = reads.map(() => ({ kind: "failed", message: "Aiden could not read pull requests from GitHub." }));
    } finally {
      release();
    }
    if (splitFailedBatch) {
      await Promise.all(reads.map((read) => this.send(host, [read])));
      return;
    }
    reads.forEach((read, index) => {
      const result = results[index]!;
      if (result.kind === "ok") {
        this.cache.set(read.key, { result, expiresAt: this.now() + pullRequestCacheTtl(read.entry, result) });
      } else {
        this.cache.delete(read.key);
      }
      read.settle(result);
    });
    this.prune();
  }

  private async acquireDocument(): Promise<() => void> {
    if (this.activeDocuments >= this.maxDocuments) {
      await new Promise<void>((resolve) => this.waitingDocuments.push(resolve));
    } else {
      this.activeDocuments += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waitingDocuments.shift();
      if (next) next();
      else this.activeDocuments -= 1;
    };
  }

  private prune(): void {
    if (this.cache.size < 500) return;
    const now = this.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
  }
}
