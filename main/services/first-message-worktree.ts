// Create the managed worktree a draft asked for, at most once per draft.
//
// The draft id is the idempotency key. A key's attempts run one at a time, so a
// double send or a retry waits for the earlier attempt and then reuses its
// worktree. Before Git creates anything, the attempt is recorded on disk as
// `pending` with the identity its worktree will carry: the workspace id it will
// be saved under and the ownership token written into its Git registration.
// Once the workspace is saved the record becomes `ready`. A later attempt only
// ever adopts a workspace with exactly that id and token, and rolls back a
// registration with that token that was never saved (an interrupted attempt),
// so it can neither take over a worktree it did not create nor leave a second
// one behind.

import * as fs from "node:fs/promises";
import { writeJsonAtomic } from "./durable-fs.js";
import type { Workspace } from "./types.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";
import type {
  WorktreeFromBaseAttempt,
  WorktreeFromBaseRequest,
  WorktreeFromBaseResult,
} from "./workspace-worktree-application-service.js";
import type {
  FirstMessageWorktreeBaseSource,
  FirstMessageWorktreeInfo,
  FirstMessageWorktreePhase,
  FirstMessageWorktreeProgress,
  FirstMessageWorktreeRequest,
} from "../../renderer/shared/worktree-on-send.js";

export interface FirstMessageWorktreeRecord {
  key: string;
  sourceWorkspaceId: string;
  /**
   * `pending`: Git may be creating it. `failed`: the attempt failed; kept so
   * a registration it could not roll back is cleaned up next time. `ready`:
   * saved as `workspaceId`.
   */
  state: "pending" | "failed" | "ready";
  /** The settings the draft sent, to detect a retry with different ones. */
  baseRef: string;
  fromOrigin: boolean;
  requestedBranchName?: string;
  branch: string;
  workspaceId: string;
  ownershipToken: string;
  baseCommit: string;
  startPoint: string;
  baseSource: FirstMessageWorktreeBaseSource;
  updatedAt: number;
}

export interface FirstMessageWorktreeLedger {
  get(key: string): Promise<FirstMessageWorktreeRecord | undefined>;
  /** Durable before it resolves. */
  put(record: FirstMessageWorktreeRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

const LEDGER_VERSION = 2;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is FirstMessageWorktreeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.sourceWorkspaceId === "string" &&
    (record.state === "pending" || record.state === "failed" || record.state === "ready") &&
    typeof record.baseRef === "string" &&
    typeof record.fromOrigin === "boolean" &&
    (record.requestedBranchName === undefined || typeof record.requestedBranchName === "string") &&
    typeof record.branch === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.ownershipToken === "string" &&
    typeof record.baseCommit === "string" &&
    typeof record.startPoint === "string" &&
    (record.baseSource === "local" || record.baseSource === "fetched" || record.baseSource === "no-upstream") &&
    typeof record.updatedAt === "number"
  );
}

/**
 * A small JSON ledger in userData. Records older than `maxAgeMs`, or beyond
 * the newest `maxRecords`, are dropped on write: a draft is retried within
 * minutes, not months.
 */
export function createFileFirstMessageWorktreeLedger(options: {
  filePath(): Promise<string>;
  now?: () => number;
  maxRecords?: number;
  maxAgeMs?: number;
  logError?(message: string, error: unknown): void;
}): FirstMessageWorktreeLedger {
  const now = options.now ?? Date.now;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let loaded: Promise<Map<string, FirstMessageWorktreeRecord>> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const load = () => {
    loaded ??= (async () => {
      const records = new Map<string, FirstMessageWorktreeRecord>();
      try {
        const parsed = JSON.parse(await fs.readFile(await options.filePath(), "utf8")) as unknown;
        const list = (parsed as { version?: unknown; records?: unknown })?.records;
        if ((parsed as { version?: unknown })?.version === LEDGER_VERSION && Array.isArray(list)) {
          for (const record of list) if (isRecord(record)) records.set(record.key, record);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          options.logError?.("The first-message worktree ledger was unreadable; starting empty.", error);
        }
      }
      return records;
    })();
    return loaded;
  };

  const persist = async (records: Map<string, FirstMessageWorktreeRecord>) => {
    const snapshot = { version: LEDGER_VERSION, records: [...records.values()] };
    const write = writes.then(async () => {
      await writeJsonAtomic(await options.filePath(), snapshot, { mode: 0o600 });
    });
    writes = write.catch(() => undefined);
    await write;
  };

  return {
    async get(key) {
      return (await load()).get(key);
    },
    async put(record) {
      const records = await load();
      records.delete(record.key);
      records.set(record.key, record);
      const cutoff = now() - maxAgeMs;
      for (const [key, value] of records) {
        if (records.size <= maxRecords && value.updatedAt >= cutoff) break;
        if (key !== record.key) records.delete(key);
      }
      await persist(records);
    },
    async delete(key) {
      const records = await load();
      if (records.delete(key)) await persist(records);
    },
  };
}

export class FirstMessageWorktreeError extends Error {
  constructor(
    message: string,
    readonly phase: FirstMessageWorktreePhase | "preparing",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FirstMessageWorktreeError";
  }
}

/** A retry asked for different settings than the worktree this draft already created. */
export class FirstMessageWorktreeSettingsChangedError extends Error {
  constructor(
    readonly worktree: {
      workspaceId: string;
      branch: string;
      baseRef: string;
      startPoint: string;
      fromOrigin: boolean;
      requestedBranchName?: string;
    },
  ) {
    super(
      `This draft already created worktree ${worktree.branch} from ${worktree.startPoint}. ` +
        "Send again with those settings, or start a new chat to use different ones.",
    );
    this.name = "FirstMessageWorktreeSettingsChangedError";
  }
}

export interface FirstMessageWorktreeDependencies {
  ledger: FirstMessageWorktreeLedger;
  createFromBase(
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    request: WorktreeFromBaseRequest,
  ): Promise<WorktreeFromBaseResult>;
  /** Roll back an unsaved registration left by an interrupted attempt. */
  discardInterruptedWorktree(
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    attempt: Pick<WorktreeFromBaseAttempt, "branch" | "ownershipToken" | "baseCommit">,
  ): Promise<unknown>;
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  now?: () => number;
  logError?(message: string, error: unknown): void;
}

function info(record: FirstMessageWorktreeRecord, reused: boolean): FirstMessageWorktreeInfo {
  return {
    workspaceId: record.workspaceId,
    branch: record.branch,
    baseRef: record.baseRef,
    startPoint: record.startPoint,
    baseCommit: record.baseCommit,
    baseSource: record.baseSource,
    reused,
  };
}

function settingsDiffer(record: FirstMessageWorktreeRecord, request: FirstMessageWorktreeRequest): boolean {
  return (
    record.baseRef !== request.baseRef ||
    record.fromOrigin !== request.fromOrigin ||
    record.requestedBranchName !== request.branchName
  );
}

export function createFirstMessageWorktreeCoordinator(dependencies: FirstMessageWorktreeDependencies) {
  const now = dependencies.now ?? Date.now;
  const attempts = new Map<string, Promise<unknown>>();

  /** The saved workspace this record's attempt created, matched by id and ownership token. */
  const savedWorkspace = async (record: FirstMessageWorktreeRecord) => {
    const workspace = await dependencies.getWorkspace(record.workspaceId);
    const managed = workspace?.managedWorktree;
    return managed && managed.branch === record.branch && managed.ownershipToken === record.ownershipToken
      ? workspace
      : undefined;
  };

  const reuse = (
    record: FirstMessageWorktreeRecord,
    request: FirstMessageWorktreeRequest,
    onProgress: (progress: FirstMessageWorktreeProgress) => void,
  ): FirstMessageWorktreeInfo => {
    if (record.sourceWorkspaceId !== request.sourceWorkspaceId) {
      throw new FirstMessageWorktreeError(
        "This draft already created a worktree in another workspace.",
        "preparing",
      );
    }
    if (settingsDiffer(record, request)) {
      throw new FirstMessageWorktreeSettingsChangedError(record);
    }
    onProgress({ draftId: record.key, phase: "ready", branch: record.branch, startPoint: record.startPoint });
    return info(record, true);
  };

  const attempt = async (
    request: FirstMessageWorktreeRequest,
    seed: string,
    owner: WorkspaceOperationDocumentOwner,
    onProgress: (progress: FirstMessageWorktreeProgress) => void,
  ): Promise<FirstMessageWorktreeInfo> => {
    const key = request.idempotencyKey;
    const existing = await dependencies.ledger.get(key);
    if (existing) {
      if (await savedWorkspace(existing)) {
        // `pending` here means the workspace was saved but the attempt
        // stopped before recording it: this draft's worktree after all.
        if (existing.state !== "ready") {
          const ready = { ...existing, state: "ready" as const, updatedAt: now() };
          await dependencies.ledger.put(ready);
          return reuse(ready, request, onProgress);
        }
        return reuse(existing, request, onProgress);
      }
      if (existing.state !== "ready") {
        // An attempt that never saved its workspace may have left its Git
        // registration behind. Only one carrying its token is touched.
        try {
          await dependencies.discardInterruptedWorktree(owner, existing.sourceWorkspaceId, existing);
        } catch (error) {
          dependencies.logError?.("Could not roll back an interrupted first-message worktree.", error);
        }
      }
      // A ready worktree whose workspace was removed, or an attempt that
      // created nothing: start over.
      await dependencies.ledger.delete(key);
    }

    let phase: FirstMessageWorktreePhase | "preparing" = "preparing";
    let pending: FirstMessageWorktreeRecord | undefined;
    let result: WorktreeFromBaseResult;
    try {
      result = await dependencies.createFromBase(owner, request.sourceWorkspaceId, {
        baseRef: request.baseRef,
        fromOrigin: request.fromOrigin,
        ...(request.branchName === undefined
          ? { autoName: { seed } }
          : { branchName: request.branchName }),
        onBranchResolved: async (resolved) => {
          pending = {
            key,
            sourceWorkspaceId: request.sourceWorkspaceId,
            state: "pending",
            baseRef: request.baseRef,
            fromOrigin: request.fromOrigin,
            ...(request.branchName === undefined ? {} : { requestedBranchName: request.branchName }),
            ...resolved,
            updatedAt: now(),
          };
          await dependencies.ledger.put(pending);
        },
        onProgress: (progress) => {
          phase = progress.phase;
          onProgress({ draftId: key, ...progress });
        },
      });
    } catch (error) {
      if (pending) {
        const failed: FirstMessageWorktreeRecord = { ...pending, state: "failed", updatedAt: now() };
        await dependencies.ledger.put(failed).catch((ledgerError: unknown) => {
          dependencies.logError?.("Could not record a failed first-message worktree.", ledgerError);
        });
      }
      throw new FirstMessageWorktreeError(
        error instanceof Error ? error.message : "Git could not create the worktree.",
        phase,
        error,
      );
    }
    const ready: FirstMessageWorktreeRecord = {
      ...pending!,
      state: "ready",
      branch: result.branch,
      workspaceId: result.workspace.id,
      startPoint: result.startPoint,
      baseCommit: result.baseCommit,
      baseSource: result.baseSource,
      updatedAt: now(),
    };
    try {
      await dependencies.ledger.put(ready);
    } catch (error) {
      // The pending record already names this workspace id and token, so a
      // retry adopts the saved workspace instead of creating another.
      dependencies.logError?.("Could not record a created first-message worktree.", error);
    }
    onProgress({ draftId: key, phase: "ready", branch: ready.branch, startPoint: ready.startPoint });
    return info(ready, false);
  };

  /**
   * Return this draft's worktree, creating it if no earlier attempt did.
   * Attempts for one key never overlap.
   */
  const ensure = async (
    request: FirstMessageWorktreeRequest,
    seed: string,
    owner: WorkspaceOperationDocumentOwner,
    onProgress: (progress: FirstMessageWorktreeProgress) => void = () => undefined,
  ): Promise<FirstMessageWorktreeInfo> => {
    const key = request.idempotencyKey;
    const previous = attempts.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => attempt(request, seed, owner, onProgress));
    attempts.set(key, current);
    try {
      return await current;
    } finally {
      if (attempts.get(key) === current) attempts.delete(key);
    }
  };

  /** The ledger's record for a key: which worktree an earlier attempt made, if any. */
  const record = (key: string): Promise<FirstMessageWorktreeRecord | undefined> => dependencies.ledger.get(key);

  return { ensure, record };
}

export type FirstMessageWorktreeCoordinator = ReturnType<typeof createFirstMessageWorktreeCoordinator>;
