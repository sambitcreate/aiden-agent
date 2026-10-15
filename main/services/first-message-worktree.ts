// Create the managed worktree a draft asked for, exactly once per draft.
//
// The draft id is the idempotency key. A key's attempts run one at a time, so a
// double send or a retry waits for the earlier attempt and then reuses its
// worktree. The key → worktree mapping is written to disk before Git creates
// anything (as `pending`, with the chosen branch) and again once the worktree
// workspace is saved (`ready`), so even a restart in between cannot lead to a
// second worktree: the pending branch is adopted if its workspace was saved.

import * as fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./durable-fs.js";
import type { Workspace } from "./types.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";
import type {
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
  state: "pending" | "ready";
  branch: string;
  baseRef: string;
  updatedAt: number;
  workspaceId?: string;
  startPoint?: string;
  baseCommit?: string;
  baseSource?: FirstMessageWorktreeBaseSource;
}

export interface FirstMessageWorktreeLedger {
  get(key: string): Promise<FirstMessageWorktreeRecord | undefined>;
  /** Durable before it resolves. */
  put(record: FirstMessageWorktreeRecord): Promise<void>;
}

const LEDGER_VERSION = 1;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is FirstMessageWorktreeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.sourceWorkspaceId === "string" &&
    (record.state === "pending" || record.state === "ready") &&
    typeof record.branch === "string" &&
    typeof record.baseRef === "string" &&
    typeof record.updatedAt === "number" &&
    (record.state === "pending" || typeof record.workspaceId === "string")
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
      const snapshot = { version: LEDGER_VERSION, records: [...records.values()] };
      const write = writes.then(async () => {
        await writeJsonAtomic(await options.filePath(), snapshot, { mode: 0o600 });
      });
      writes = write.catch(() => undefined);
      await write;
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

export interface FirstMessageWorktreeDependencies {
  ledger: FirstMessageWorktreeLedger;
  createFromBase(
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    request: WorktreeFromBaseRequest,
  ): Promise<WorktreeFromBaseResult>;
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  listWorkspaces(): Promise<Workspace[]>;
  now?: () => number;
  logError?(message: string, error: unknown): void;
}

function insideRepository(repositoryPath: string, folderPath: string | undefined): boolean {
  if (!folderPath) return false;
  const relative = path.relative(repositoryPath, folderPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function info(record: FirstMessageWorktreeRecord, reused: boolean): FirstMessageWorktreeInfo {
  return {
    workspaceId: record.workspaceId!,
    branch: record.branch,
    baseRef: record.baseRef,
    startPoint: record.startPoint ?? record.baseRef,
    baseCommit: record.baseCommit ?? "",
    baseSource: record.baseSource ?? "local",
    reused,
  };
}

export function createFirstMessageWorktreeCoordinator(dependencies: FirstMessageWorktreeDependencies) {
  const now = dependencies.now ?? Date.now;
  const attempts = new Map<string, Promise<unknown>>();

  const attempt = async (
    request: FirstMessageWorktreeRequest,
    seed: string,
    owner: WorkspaceOperationDocumentOwner,
    onProgress: (progress: FirstMessageWorktreeProgress) => void,
  ): Promise<FirstMessageWorktreeInfo> => {
    const key = request.idempotencyKey;
    const existing = await dependencies.ledger.get(key);
    if (existing && existing.sourceWorkspaceId !== request.sourceWorkspaceId) {
      throw new FirstMessageWorktreeError(
        "This draft already started a worktree in another workspace.",
        "preparing",
      );
    }
    if (existing?.state === "ready") {
      const workspace = await dependencies.getWorkspace(existing.workspaceId!);
      if (!workspace?.managedWorktree) {
        throw new FirstMessageWorktreeError(
          "The worktree this draft created has been removed.",
          "preparing",
        );
      }
      onProgress({ draftId: key, phase: "ready", branch: existing.branch, startPoint: existing.startPoint });
      return info(existing, true);
    }
    if (existing?.state === "pending") {
      // An earlier attempt chose this branch and stopped before recording the
      // outcome. If its workspace was saved, that is this draft's worktree.
      const source = await dependencies.getWorkspace(request.sourceWorkspaceId);
      const adopted = (await dependencies.listWorkspaces()).find((workspace) =>
        workspace.managedWorktree?.branch === existing.branch &&
        insideRepository(workspace.managedWorktree.repositoryPath, source?.folderPath));
      if (adopted) {
        const ready: FirstMessageWorktreeRecord = {
          ...existing,
          state: "ready",
          workspaceId: adopted.id,
          baseCommit: adopted.managedWorktree?.createdFromHead,
          updatedAt: now(),
        };
        await dependencies.ledger.put(ready);
        onProgress({ draftId: key, phase: "ready", branch: ready.branch, startPoint: ready.startPoint });
        return info(ready, true);
      }
    }

    let phase: FirstMessageWorktreePhase | "preparing" = "preparing";
    let result: WorktreeFromBaseResult;
    try {
      result = await dependencies.createFromBase(owner, request.sourceWorkspaceId, {
        baseRef: request.baseRef,
        fromOrigin: request.fromOrigin,
        ...(request.branchName === undefined
          ? { autoName: { seed } }
          : { branchName: request.branchName }),
        onBranchResolved: (branch) => dependencies.ledger.put({
          key,
          sourceWorkspaceId: request.sourceWorkspaceId,
          state: "pending",
          branch,
          baseRef: request.baseRef,
          updatedAt: now(),
        }),
        onProgress: (progress) => {
          phase = progress.phase;
          onProgress({ draftId: key, ...progress });
        },
      });
    } catch (error) {
      throw new FirstMessageWorktreeError(
        error instanceof Error ? error.message : "Git could not create the worktree.",
        phase,
        error,
      );
    }
    const ready: FirstMessageWorktreeRecord = {
      key,
      sourceWorkspaceId: request.sourceWorkspaceId,
      state: "ready",
      branch: result.branch,
      baseRef: request.baseRef,
      workspaceId: result.workspace.id,
      startPoint: result.startPoint,
      baseCommit: result.baseCommit,
      baseSource: result.baseSource,
      updatedAt: now(),
    };
    try {
      await dependencies.ledger.put(ready);
    } catch (error) {
      // The pending record already names this branch, so a retry adopts the
      // saved workspace instead of creating another worktree.
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

  return { ensure };
}

export type FirstMessageWorktreeCoordinator = ReturnType<typeof createFirstMessageWorktreeCoordinator>;
