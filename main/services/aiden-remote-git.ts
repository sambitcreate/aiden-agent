import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenIdempotencyLedger,
  AidenOperationContractError,
  assertRevision,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import type { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import {
  GitServiceError,
  type GitCommitInput,
  type GitComparison,
  type GitComparisonDiffInput,
  type GitDiffInput,
  type GitPushCapability,
  type GitPushInput,
  type GitReview,
  type GitReviewFile,
} from "./git.js";
import type { GitBranches, GitWorktree, Workspace } from "./types.js";
import type { WorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import type { WorkspaceWorktreeApplicationService } from "./workspace-worktree-application-service.js";
import { workspaceRevision } from "./aiden-remote-workspaces.js";

const SNAPSHOT_TTL_MS = 10 * 60_000;
const MAX_SNAPSHOTS = 4_096;
const MAX_FILES = 4_000;
const MAX_DIFF_CHARACTERS = 2_000_000;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/u;

type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface AidenRemoteGitFile {
  id: string;
  displayPath: string;
  status: GitFileStatus;
  staged?: boolean;
  additions?: number;
  deletions?: number;
}

export type AidenRemoteGitProjection =
  | { kind: "review"; branch: string; uncommitted: number; files: AidenRemoteGitFile[] }
  | { kind: "diff"; displayPath: string; diff: string; truncated: boolean }
  | { kind: "branches"; current: string; branches: string[] }
  | { kind: "comparison"; comparisonId: string; base: string; head: string; files: AidenRemoteGitFile[] }
  | { kind: "push-capability"; allowed: boolean; reason?: string; remote?: string; branch?: string }
  | { kind: "worktrees"; worktrees: Array<{ id: string; name: string; branch: string; managed: boolean }> }
  | { kind: "mutation"; message: string; branch?: string; commitId?: string; workspaceId?: string; warning?: string };

export interface AidenRemoteGitResult {
  operationId: string;
  status: "snapshot" | "accepted" | "running" | "succeeded" | "failed" | "conflict";
  snapshotId?: string;
  capability?: { allowed: boolean; reason?: string };
  result?: AidenRemoteGitProjection;
}

interface SnapshotBase {
  deviceId: string;
  workspaceId: string;
  expiresAt: number;
  files: Map<string, string>;
}

type Snapshot = SnapshotBase & (
  | { kind: "review"; expectedSnapshot?: string }
  | { kind: "branches"; digest: string }
  | { kind: "comparison"; comparison: GitComparison }
  | { kind: "push"; capability: GitPushCapability }
);

type SnapshotInput =
  | { kind: "review"; deviceId: string; workspaceId: string; expectedSnapshot?: string }
  | { kind: "branches"; deviceId: string; workspaceId: string; digest: string }
  | { kind: "comparison"; deviceId: string; workspaceId: string; comparison: GitComparison }
  | { kind: "push"; deviceId: string; workspaceId: string; capability: GitPushCapability };

interface GitDependencies {
  review(folderPath: string, signal?: AbortSignal): Promise<GitReview>;
  diff(folderPath: string, input: GitDiffInput, signal?: AbortSignal): Promise<{ path: string; patch: string; truncated: boolean }>;
  branches(folderPath: string, signal?: AbortSignal): Promise<GitBranches>;
  checkout(folderPath: string, name: string, signal?: AbortSignal): Promise<void>;
  createBranch(folderPath: string, name: string, signal?: AbortSignal): Promise<void>;
  commit(folderPath: string, input: GitCommitInput, signal?: AbortSignal): Promise<{ commit: string; branch: string; subject: string; warning?: string }>;
  pushCapability(folderPath: string, signal?: AbortSignal): Promise<GitPushCapability>;
  push(folderPath: string, input: GitPushInput, signal?: AbortSignal): Promise<{ branch: string; commit: string; remote: string; warning?: string }>;
  compare(folderPath: string, targetRef: string, signal?: AbortSignal): Promise<GitComparison>;
  comparisonDiff(folderPath: string, input: GitComparisonDiffInput, signal?: AbortSignal): Promise<{ path: string; patch: string; truncated: boolean }>;
  worktrees(folderPath: string, signal?: AbortSignal): Promise<GitWorktree[]>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function operationId(): string {
  return `op_${randomBytes(24).toString("base64url")}`;
}

function safeDisplayPath(value: string): string {
  if (
    !value ||
    value.length > 4_096 ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => part === "..") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new AidenRemoteServiceError("workspace_unavailable", "A Git path could not be projected safely.", 409);
  }
  return value;
}

function safeString(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function status(value: GitReviewFile["status"]): GitFileStatus {
  return value === "copied" ? "renamed" : value;
}

function branchesDigest(value: GitBranches): string {
  return digest(JSON.stringify({
    isRepo: value.isRepo,
    current: value.current ?? null,
    branches: value.branches,
    remoteBranches: value.remoteBranches,
    uncommitted: value.uncommitted,
    detached: value.detached ?? false,
    unborn: value.unborn ?? false,
  }));
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(record: Record<string, unknown>, required: string[]): boolean {
  return Object.keys(record).length === required.length && required.every(
    (key) => Object.prototype.hasOwnProperty.call(record, key),
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum;
}

function requireConfirmation(record: Record<string, unknown>): void {
  if (record.confirmedForeground !== true) {
    throw new AidenRemoteServiceError(
      "permission_confirmation_required",
      "This Git change requires an explicit foreground confirmation.",
      409,
    );
  }
}

function mapGitError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  if (!(error instanceof GitServiceError)) {
    throw new AidenRemoteServiceError("internal_error", "Aiden could not complete this Git operation.", 500);
  }
  if (error.code === "stale_snapshot" || error.code === "dirty_worktree" || error.code === "conflicted") {
    throw new AidenRemoteServiceError("operation_stale", "The repository changed. Refresh Git and try again.", 409);
  }
  if (error.code === "invalid_input" || error.code === "invalid_ref") {
    throw new AidenRemoteServiceError("invalid_request", "The Git request is invalid.", 400);
  }
  if (error.code === "aborted") {
    throw new AidenRemoteServiceError("operation_stale", "The Git operation was cancelled.", 409, true);
  }
  throw new AidenRemoteServiceError(
    "git_capability_denied",
    error.code === "not_repo"
      ? "This workspace is not a Git repository."
      : "This Git operation is not available for the current workspace state.",
    409,
  );
}

export class AidenRemoteGitService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly idempotency: AidenIdempotencyLedger;
  private readonly now = (): number => this.options.now?.() ?? Date.now();

  constructor(
    private readonly options: {
      application: Pick<WorkspaceEnvironmentApplicationService, "resolve" | "run">;
      owners: Pick<AidenRemoteWorkspaceOwnerRegistry, "owner">;
      git: GitDependencies;
      worktrees?: Pick<WorkspaceWorktreeApplicationService, "create" | "remove">;
      listWorkspaces(): Promise<Workspace[]>;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.snapshots) {
      if (value.expiresAt <= now) this.snapshots.delete(key);
    }
  }

  private issueSnapshot(value: SnapshotInput, files: GitReviewFile[] = []): {
    snapshotId: string;
    projectedFiles: AidenRemoteGitFile[];
  } {
    this.prune();
    if (this.snapshots.size >= MAX_SNAPSHOTS) {
      throw new AidenRemoteServiceError("handle_capacity", "Aiden's Git snapshot capacity is temporarily full.", 429, true);
    }
    const snapshotId = `snap_${randomBytes(32).toString("base64url")}`;
    const mapped = new Map<string, string>();
    const projectedFiles = files.slice(0, MAX_FILES).map((file) => {
      const token = `file_${randomBytes(32).toString("base64url")}`;
      mapped.set(digest(token), file.path);
      return {
        id: token,
        displayPath: safeDisplayPath(file.path),
        status: status(file.status),
        staged: file.staged,
        ...(file.additions === undefined ? {} : { additions: Math.max(0, file.additions) }),
        ...(file.deletions === undefined ? {} : { deletions: Math.max(0, file.deletions) }),
      };
    });
    this.snapshots.set(digest(snapshotId), {
      ...value,
      expiresAt: this.now() + SNAPSHOT_TTL_MS,
      files: mapped,
    } as Snapshot);
    return { snapshotId, projectedFiles };
  }

  private snapshot(
    deviceId: string,
    workspaceId: string,
    snapshotId: string,
    expectedKind: Snapshot["kind"],
  ): Snapshot {
    this.prune();
    if (!/^snap_[A-Za-z0-9_-]{43}$/u.test(snapshotId)) {
      throw new AidenRemoteServiceError("handle_invalid", "This Git snapshot is invalid.", 400);
    }
    const snapshot = this.snapshots.get(digest(snapshotId));
    if (!snapshot) throw new AidenRemoteServiceError("handle_expired", "This Git snapshot expired. Refresh Git and try again.", 410);
    if (snapshot.deviceId !== deviceId) throw new AidenRemoteServiceError("handle_wrong_device", "This Git snapshot belongs to another paired device.", 403);
    if (snapshot.workspaceId !== workspaceId || snapshot.kind !== expectedKind) {
      throw new AidenRemoteServiceError("operation_stale", "This Git snapshot does not match the workspace operation.", 409);
    }
    return snapshot;
  }

  private filePath(snapshot: Snapshot, fileId: string): string {
    if (!/^file_[A-Za-z0-9_-]{43}$/u.test(fileId)) {
      throw new AidenRemoteServiceError("handle_invalid", "This Git file link is invalid.", 400);
    }
    const value = snapshot.files.get(digest(fileId));
    if (!value) throw new AidenRemoteServiceError("operation_stale", "This file is not part of the Git snapshot.", 409);
    return value;
  }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    if (!this.options.persistIdempotency) return this.idempotency.execute(scope, input, action);
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    const pending = this.idempotency.execute(scope, input, async () => {
      await admission;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      release();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      throw new AidenRemoteServiceError("internal_error", "Aiden could not durably prepare this Git operation.", 500);
    }
    let result: T | undefined;
    let failure: unknown;
    try { result = await pending; } catch (error) { failure = error; }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError(
        "idempotency_in_flight",
        "The Git operation may have completed, but Aiden could not durably record its outcome.",
        409,
      );
    }
    if (failure) throw failure;
    return result!;
  }

  private run<T>(
    deviceId: string,
    workspaceId: string,
    operation: (folderPath: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.options.application.run(
      this.options.owners.owner(deviceId),
      workspaceId,
      ({ folderPath }, signal) => operation(folderPath, signal),
    );
  }

  async review(deviceId: string, workspaceId: string): Promise<AidenRemoteGitResult> {
    try {
      const review = await this.run(deviceId, workspaceId, this.options.git.review);
      const issued = this.issueSnapshot(
        { kind: "review", deviceId, workspaceId, expectedSnapshot: review.commit.snapshot },
        review.files,
      );
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: issued.snapshotId,
        capability: {
          allowed: review.commit.allowed,
          ...(review.commit.reason ? { reason: safeString(review.commit.reason, 500) } : {}),
        },
        result: {
          kind: "review",
          branch: safeString(review.branch ?? "HEAD", 500),
          uncommitted: review.summary.fileCount,
          files: issued.projectedFiles,
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async diff(deviceId: string, workspaceId: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["snapshotId", "fileId"]) || !boundedString(record.snapshotId, 128) || !boundedString(record.fileId, 128)) {
      throw new AidenRemoteServiceError("invalid_request", "The Git diff request is invalid.", 400);
    }
    const snapshot = this.snapshot(deviceId, workspaceId, record.snapshotId, "review");
    if (snapshot.kind !== "review" || !snapshot.expectedSnapshot) {
      throw new AidenRemoteServiceError("git_capability_denied", "A diff is unavailable for this review.", 409);
    }
    const displayPath = this.filePath(snapshot, record.fileId);
    try {
      const diff = await this.run(deviceId, workspaceId, (folderPath, signal) =>
        this.options.git.diff(folderPath, { expectedSnapshot: snapshot.expectedSnapshot!, path: displayPath }, signal));
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: record.snapshotId,
        result: {
          kind: "diff",
          displayPath: safeDisplayPath(diff.path),
          diff: [...diff.patch].slice(0, MAX_DIFF_CHARACTERS).join(""),
          truncated: diff.truncated || [...diff.patch].length > MAX_DIFF_CHARACTERS,
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async branches(deviceId: string, workspaceId: string): Promise<AidenRemoteGitResult> {
    try {
      const branches = await this.run(deviceId, workspaceId, this.options.git.branches);
      const issued = this.issueSnapshot({
        kind: "branches",
        deviceId,
        workspaceId,
        digest: branchesDigest(branches),
      });
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: issued.snapshotId,
        capability: {
          allowed: branches.isRepo && !branches.detached,
          ...(!branches.isRepo
            ? { reason: "This workspace is not a Git repository." }
            : branches.detached
              ? { reason: "Checkout is unavailable while HEAD is detached." }
              : {}),
        },
        result: {
          kind: "branches",
          current: safeString(branches.current ?? "HEAD", 500),
          branches: branches.branches.slice(0, 4_000).map((branch) => safeString(branch, 500)),
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async checkout(deviceId: string, workspaceId: string, key: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["branch", "snapshotId", "confirmedForeground"]) || !boundedString(record.branch, 500) || !boundedString(record.snapshotId, 128)) {
      throw new AidenRemoteServiceError("invalid_request", "The branch checkout request is invalid.", 400);
    }
    requireConfirmation(record);
    const snapshot = this.snapshot(deviceId, workspaceId, record.snapshotId, "branches");
    return this.executeIdempotent(
      { deviceId, route: "POST /git/checkout", resourceId: workspaceId, key },
      record,
      async () => {
        try {
          return await this.run(deviceId, workspaceId, async (folderPath, signal) => {
            const current = await this.options.git.branches(folderPath, signal);
            if (snapshot.kind !== "branches" || snapshot.digest !== branchesDigest(current)) {
              throw new AidenRemoteServiceError("operation_stale", "The branch list changed. Refresh Git and try again.", 409);
            }
            await this.options.git.checkout(folderPath, record.branch as string, signal);
            return {
              operationId: operationId(),
              status: "succeeded" as const,
              result: { kind: "mutation" as const, message: "Checked out branch.", branch: record.branch as string },
            };
          });
        } catch (error) { mapGitError(error); }
      },
    );
  }

  async createBranch(deviceId: string, workspaceId: string, key: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["name", "startPoint", "confirmedForeground"]) || !boundedString(record.name, 200) || !boundedString(record.startPoint, 500)) {
      throw new AidenRemoteServiceError("invalid_request", "The branch creation request is invalid.", 400);
    }
    requireConfirmation(record);
    return this.executeIdempotent(
      { deviceId, route: "POST /git/branches", resourceId: workspaceId, key },
      record,
      async () => {
        try {
          return await this.run(deviceId, workspaceId, async (folderPath, signal) => {
            const branches = await this.options.git.branches(folderPath, signal);
            if (record.startPoint !== (branches.current ?? "HEAD")) {
              throw new AidenRemoteServiceError("operation_stale", "The branch start point changed. Refresh Git and try again.", 409);
            }
            await this.options.git.createBranch(folderPath, record.name as string, signal);
            return {
              operationId: operationId(),
              status: "succeeded" as const,
              result: { kind: "mutation" as const, message: "Created and checked out branch.", branch: record.name as string },
            };
          });
        } catch (error) { mapGitError(error); }
      },
    );
  }

  async commit(deviceId: string, workspaceId: string, key: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (
      !record ||
      !exactKeys(record, ["snapshotId", "message", "scope", "confirmedForeground"]) ||
      !boundedString(record.snapshotId, 128) ||
      !boundedString(record.message, 20_000) ||
      (record.scope !== "all-reviewed" && record.scope !== "staged-reviewed")
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The Git commit request is invalid.", 400);
    }
    requireConfirmation(record);
    const snapshot = this.snapshot(deviceId, workspaceId, record.snapshotId, "review");
    if (snapshot.kind !== "review" || !snapshot.expectedSnapshot) {
      throw new AidenRemoteServiceError("git_capability_denied", "Commit is unavailable for this review.", 409);
    }
    return this.executeIdempotent(
      { deviceId, route: "POST /git/commit", resourceId: workspaceId, key },
      record,
      async () => {
        try {
          const result = await this.run(deviceId, workspaceId, (folderPath, signal) =>
            this.options.git.commit(folderPath, {
              expectedSnapshot: snapshot.expectedSnapshot!,
              message: record.message as string,
              mode: record.scope === "all-reviewed" ? "all" : "staged",
            }, signal));
          return {
            operationId: operationId(),
            status: "succeeded" as const,
            result: {
              kind: "mutation" as const,
              message: safeString(result.subject, 500),
              branch: safeString(result.branch, 500),
              commitId: safeString(result.commit, 128),
              ...(result.warning ? { warning: safeString(result.warning, 500) } : {}),
            },
          };
        } catch (error) { mapGitError(error); }
      },
    );
  }

  async pushCapability(deviceId: string, workspaceId: string): Promise<AidenRemoteGitResult> {
    try {
      const capability = await this.run(deviceId, workspaceId, this.options.git.pushCapability);
      const issued = this.issueSnapshot({ kind: "push", deviceId, workspaceId, capability });
      const remote = capability.suggestedRemote;
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: issued.snapshotId,
        capability: {
          allowed: capability.allowed,
          ...(capability.reason ? { reason: safeString(capability.reason, 500) } : {}),
        },
        result: {
          kind: "push-capability",
          allowed: capability.allowed,
          ...(capability.reason ? { reason: safeString(capability.reason, 500) } : {}),
          ...(remote ? { remote: safeString(remote, 200) } : {}),
          ...(capability.destinationBranch ? { branch: safeString(capability.destinationBranch, 500) } : {}),
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async push(deviceId: string, workspaceId: string, key: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["snapshotId", "remote", "branch", "confirmedForeground"]) || !boundedString(record.snapshotId, 128) || !boundedString(record.remote, 200) || !boundedString(record.branch, 500)) {
      throw new AidenRemoteServiceError("invalid_request", "The Git push request is invalid.", 400);
    }
    requireConfirmation(record);
    const snapshot = this.snapshot(deviceId, workspaceId, record.snapshotId, "push");
    if (snapshot.kind !== "push" || !snapshot.capability.allowed) {
      throw new AidenRemoteServiceError("git_capability_denied", "Push is not available for this workspace state.", 409);
    }
    const capability = snapshot.capability;
    if (
      record.remote !== capability.suggestedRemote ||
      record.branch !== capability.destinationBranch ||
      !capability.branch ||
      !capability.expectedHead ||
      !capability.suggestedRemote ||
      !capability.remoteIdentities[capability.suggestedRemote]
    ) {
      throw new AidenRemoteServiceError("operation_stale", "The reviewed push destination changed. Refresh Git and try again.", 409);
    }
    return this.executeIdempotent(
      { deviceId, route: "POST /git/push", resourceId: workspaceId, key },
      record,
      async () => {
        try {
          const input: GitPushInput = {
            destinationBranch: capability.destinationBranch!,
            expectedBranch: capability.branch!,
            expectedHead: capability.expectedHead!,
            expectedRemoteIdentity: capability.remoteIdentities[capability.suggestedRemote!]!,
            remote: capability.suggestedRemote!,
            setUpstream: !capability.upstream,
          };
          const result = await this.run(deviceId, workspaceId, (folderPath, signal) => this.options.git.push(folderPath, input, signal));
          return {
            operationId: operationId(),
            status: "succeeded" as const,
            result: {
              kind: "mutation" as const,
              message: "Pushed reviewed commits.",
              branch: safeString(result.branch, 500),
              commitId: safeString(result.commit, 128),
              ...(result.warning ? { warning: safeString(result.warning, 500) } : {}),
            },
          };
        } catch (error) { mapGitError(error); }
      },
    );
  }

  async compare(deviceId: string, workspaceId: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["baseRef"]) || !boundedString(record.baseRef, 500)) {
      throw new AidenRemoteServiceError("invalid_request", "The Git comparison request is invalid.", 400);
    }
    try {
      const comparison = await this.run(deviceId, workspaceId, (folderPath, signal) => this.options.git.compare(folderPath, record.baseRef as string, signal));
      const issued = this.issueSnapshot(
        { kind: "comparison", deviceId, workspaceId, comparison },
        comparison.files,
      );
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: issued.snapshotId,
        result: {
          kind: "comparison",
          comparisonId: issued.snapshotId,
          base: safeString(comparison.targetLabel, 500),
          head: safeString(comparison.currentBranch ?? "HEAD", 500),
          files: issued.projectedFiles,
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async comparisonDiff(deviceId: string, workspaceId: string, value: unknown): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["comparisonId", "fileId"]) || !boundedString(record.comparisonId, 128) || !boundedString(record.fileId, 128)) {
      throw new AidenRemoteServiceError("invalid_request", "The comparison diff request is invalid.", 400);
    }
    const snapshot = this.snapshot(deviceId, workspaceId, record.comparisonId, "comparison");
    if (snapshot.kind !== "comparison") throw new AidenRemoteServiceError("operation_stale", "This comparison is stale.", 409);
    const displayPath = this.filePath(snapshot, record.fileId);
    const comparison = snapshot.comparison;
    try {
      const diff = await this.run(deviceId, workspaceId, (folderPath, signal) => this.options.git.comparisonDiff(folderPath, {
        expectedHead: comparison.expectedHead,
        expectedTarget: comparison.expectedTarget,
        mergeBase: comparison.mergeBase,
        path: displayPath,
        targetRef: comparison.targetRef,
      }, signal));
      return {
        operationId: operationId(),
        status: "snapshot",
        snapshotId: record.comparisonId,
        result: {
          kind: "diff",
          displayPath: safeDisplayPath(diff.path),
          diff: [...diff.patch].slice(0, MAX_DIFF_CHARACTERS).join(""),
          truncated: diff.truncated || [...diff.patch].length > MAX_DIFF_CHARACTERS,
        },
      };
    } catch (error) { mapGitError(error); }
  }

  async worktrees(deviceId: string, workspaceId: string): Promise<AidenRemoteGitResult> {
    try {
      const [worktrees, registered] = await Promise.all([
        this.run(deviceId, workspaceId, this.options.git.worktrees),
        this.options.listWorkspaces(),
      ]);
      const resolvedWorkspaces = await Promise.all(registered.map(async (workspace) => {
        try {
          const resolved = await this.options.application.resolve(workspace.id, true, true);
          return resolved ? { folderPath: resolved.folderPath, workspace } : undefined;
        } catch {
          return undefined;
        }
      }));
      const projected = worktrees.flatMap((worktree) => {
        const resolved = resolvedWorkspaces.find((candidate) => candidate?.folderPath === worktree.path);
        if (!resolved) return [];
        return [{
          id: resolved.workspace.id,
          name: safeString(resolved.workspace.name, 120),
          branch: safeString(worktree.branch ?? "detached", 500),
          managed: Boolean(resolved.workspace.managedWorktree),
        }];
      });
      return {
        operationId: operationId(),
        status: "snapshot",
        result: { kind: "worktrees", worktrees: projected },
      };
    } catch (error) { mapGitError(error); }
  }

  async createWorktree(
    deviceId: string,
    workspaceId: string,
    key: string,
    value: unknown,
  ): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (
      !record ||
      !exactKeys(record, ["branch", "name", "confirmedForeground"]) ||
      !boundedString(record.branch, 500) ||
      !boundedString(record.name, 120)
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The managed-worktree request is invalid.", 400);
    }
    requireConfirmation(record);
    if (!this.options.worktrees) {
      throw new AidenRemoteServiceError("not_found", "Managed worktrees are unavailable.", 404);
    }
    return this.executeIdempotent(
      { deviceId, route: "POST /git/worktrees", resourceId: workspaceId, key },
      record,
      async () => {
        try {
          const workspace = await this.options.worktrees!.create(
            this.options.owners.owner(deviceId),
            workspaceId,
            record.branch as string,
            record.name as string,
          );
          return {
            operationId: operationId(),
            status: "succeeded" as const,
            result: {
              kind: "mutation" as const,
              message: "Created managed worktree.",
              branch: safeString(workspace.managedWorktree?.branch ?? record.branch as string, 500),
              workspaceId: workspace.id,
            },
          };
        } catch (error) { mapGitError(error); }
      },
    );
  }

  async deleteManagedWorktree(
    deviceId: string,
    workspaceId: string,
    revision: string,
    key: string,
    value: unknown,
  ): Promise<AidenRemoteGitResult> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["confirmedForeground"])) {
      throw new AidenRemoteServiceError("invalid_request", "The managed-worktree deletion request is invalid.", 400);
    }
    requireConfirmation(record);
    if (!this.options.worktrees) {
      throw new AidenRemoteServiceError("not_found", "Managed worktrees are unavailable.", 404);
    }
    return this.executeIdempotent(
      { deviceId, route: "DELETE /git/managed-worktree", resourceId: workspaceId, key },
      { revision, ...record },
      async () => {
        try {
          const result = await this.options.worktrees!.remove(
            this.options.owners.owner(deviceId),
            workspaceId,
            (workspace) => {
              const currentRevision = workspaceRevision(workspace);
              try {
                assertRevision(revision, currentRevision);
              } catch (error) {
                if (error instanceof AidenOperationContractError) {
                  throw new AidenRemoteServiceError(
                    "revision_conflict",
                    "The workspace changed. Refresh it before trying again.",
                    409,
                    false,
                    { currentRevision },
                  );
                }
                throw error;
              }
            },
          );
          return {
            operationId: operationId(),
            status: "succeeded" as const,
            result: {
              kind: "mutation" as const,
              message: result.branchDeleted
                ? "Removed managed worktree and branch."
                : "Removed managed worktree.",
              workspaceId,
            },
          };
        } catch (error) { mapGitError(error); }
      },
    );
  }
}
