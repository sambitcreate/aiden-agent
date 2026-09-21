import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type {
  GitCreatedWorktree,
  GitDeleteWorktreeResult,
  ManagedWorktreeDeletionLifecycle,
  ManagedWorktreeDirtyState,
  ManagedWorktreeSnapshotCapture,
} from "./git.js";
import { GitManagedWorktreeDeleteError } from "./git.js";
import {
  commitManagedWorktreeCreation,
  ManagedWorktreeCreationError,
} from "./managed-worktree-creation-core.js";
import { removeManagedWorkspace } from "./managed-worktree-removal-core.js";
import { restoreManagedWorktreeSnapshot } from "./managed-worktree-restore.js";
import {
  captureProvisionedFile,
  persistManagedWorktreeSnapshot,
  type ProvisionedFileSnapshot,
  requireReadyManagedWorktreeSnapshot,
  updateManagedWorktreeSnapshotState,
} from "./managed-worktree-snapshot.js";
import type { Workspace, ManagedWorktree } from "./types.js";
import type { WorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";
import { withWorkspaceScheduleRestoration } from "./workspace-schedule-restoration.js";

export interface WorkspaceWorktreeApplicationDependencies {
  environment: Pick<WorkspaceEnvironmentApplicationService, "resolve" | "run" | "runRecord">;
  ensureWorktreeRoot(): Promise<string>;
  ensureSnapshotRoot(): Promise<string>;
  createWorktree(
    folderPath: string,
    root: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree>;
  rollbackWorktree(
    folderPath: string,
    created: GitCreatedWorktree,
    options?: { provisionedIgnored?: readonly string[] },
  ): Promise<void>;
  deleteManagedWorktree(
    managed: ManagedWorktree,
    signal: AbortSignal,
    lifecycle?: ManagedWorktreeDeletionLifecycle,
  ): Promise<GitDeleteWorktreeResult>;
  managedWorktreeDeletionPending(managed: ManagedWorktree): Promise<boolean>;
  managedWorktreeRegistered(managed: ManagedWorktree): Promise<boolean>;
  managedWorktreeUsable(managed: ManagedWorktree): Promise<boolean>;
  finalizeManagedWorktreeDeletion(managed: ManagedWorktree): Promise<void>;
  workspacePathExists(worktreePath: string): Promise<boolean>;
  checkoutBytes(folderPath: string): Promise<number>;
  checkCreateCapacity(worktreeRoot: string, estimatedBytes: number): Promise<unknown>;
  checkSnapshotCapacity(snapshotRoot: string, estimatedBytes: number): Promise<unknown>;
  provisionIncludedFiles(options: {
    sourceRoot: string;
    worktreePath: string;
    signal?: AbortSignal;
    onProvisioned?(relativePath: string): void;
  }): Promise<string[]>;
  repositoryPaths(folderPath: string): Promise<{ topLevel: string; commonDir: string }>;
  dirtyState(repositoryPath: string, worktreePath: string): Promise<ManagedWorktreeDirtyState>;
  expandIgnoredPaths(
    repositoryPath: string,
    worktreePath: string,
    ignoredPaths: readonly string[],
  ): Promise<string[] | undefined>;
  snapshotContentBytes(repositoryPath: string, worktreePath: string): Promise<number>;
  captureWorktreeSnapshot(
    repositoryPath: string,
    worktreePath: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeSnapshotCapture>;
  snapshotRefCommit(repositoryPath: string, snapshotId: string): Promise<string | undefined>;
  /** Remove a published snapshot ref while it still points at `expectedCommit`. */
  deleteSnapshotRef(
    repositoryPath: string,
    snapshotId: string,
    expectedCommit: string,
  ): Promise<boolean>;
  restoreManagedCheckout(
    repositoryPath: string,
    root: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
    workspaceSubpath: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree>;
  applyWorktreeSnapshot(
    worktreePath: string,
    snapshotCommit: string,
    signal?: AbortSignal,
  ): Promise<void>;
  resumeManagedCheckout(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
    workspaceSubpath: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree>;
  saveWorkspace(workspace: Workspace): Promise<Workspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
  beginWorkspaceMutation(workspaceId: string): () => void;
  workspaceIsChanging(workspaceId: string): boolean;
  cancelWorkspaceOperations(workspaceId: string, exceptSignal: AbortSignal): Promise<void>;
  closeWorkspaceTerminals(workspaceId: string): void;
  cancelWorkspaceGeneration(workspaceId: string): Promise<void>;
  cancelWorkspaceSchedules(workspaceId: string): Promise<void>;
  resumeWorkspaceSchedules(workspaceId: string): Promise<void>;
  createWorkspaceId(): string;
  now(): number;
  notifyChanged(): void;
  logError(area: string, message: string, error: unknown): void;
}

function displayName(source: Workspace, branch: string, requested?: string): string {
  const trimmed = requested?.trim();
  if (trimmed) return [...trimmed].slice(0, 120).join("");
  const base = path.basename(source.folderPath ?? source.name);
  return [...`${base} · ${branch}`].slice(0, 120).join("");
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

class ManagedWorktreeSnapshotCleanupError extends Error {
  declare readonly cause: unknown;
  constructor(cause: unknown) {
    super("A failed managed worktree snapshot left artifacts requiring review; deletion was stopped.");
    this.name = "ManagedWorktreeSnapshotCleanupError";
    this.cause = cause;
  }
}

/**
 * Shared renderer/remote orchestration for Aiden-owned Git worktrees. All
 * filesystem and Git-admin identity is reloaded from persisted Mac state.
 */
export function createWorkspaceWorktreeApplicationService(
  dependencies: WorkspaceWorktreeApplicationDependencies,
) {
  // Restore journals live inside the snapshot directory, so concurrent
  // restores of the same snapshot are serialized here per process.
  const restoreLocks = new Map<string, Promise<Workspace>>();

  const create = async (
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    branch: string,
    requestedName?: string,
  ): Promise<Workspace> => dependencies.environment.run(
    owner,
    sourceWorkspaceId,
    async (resolved, signal) => {
      const worktreeRoot = await dependencies.ensureWorktreeRoot();
      // Free-space admission before mkdir + `git worktree add` can mutate the
      // filesystem or the repository.
      const estimatedBytes = await dependencies.checkoutBytes(resolved.folderPath);
      await dependencies.checkCreateCapacity(worktreeRoot, estimatedBytes);
      const worktree = await dependencies.createWorktree(
        resolved.folderPath,
        worktreeRoot,
        branch,
        signal,
      );
      const provisionedFiles: string[] = [];
      try {
        const sourceRoot = (await dependencies.repositoryPaths(resolved.folderPath)).topLevel;
        await dependencies.provisionIncludedFiles({
          sourceRoot,
          worktreePath: worktree.path,
          signal,
          onProvisioned: (relativePath) => provisionedFiles.push(relativePath),
        });
      } catch (error) {
        await dependencies
          .rollbackWorktree(resolved.folderPath, worktree, {
            provisionedIgnored: provisionedFiles,
          })
          .catch((rollbackError) => {
            dependencies.logError(
              "git",
              "Aiden could not fully roll back a managed worktree after provisioning failed.",
              rollbackError,
            );
          });
        throw error;
      }
      const now = dependencies.now();
      const workspace: Workspace = {
        id: dependencies.createWorkspaceId(),
        name: displayName(resolved.workspace, branch, requestedName),
        folderPath: worktree.workspacePath,
        permission: resolved.workspace.permission,
        managedWorktree: {
          repositoryPath: worktree.repositoryPath,
          worktreePath: worktree.path,
          branch,
          worktreeGitDir: worktree.worktreeGitDir,
          ownershipToken: worktree.ownershipToken,
          worktreeDevice: worktree.worktreeDevice,
          worktreeInode: worktree.worktreeInode,
          createdFromHead: worktree.createdFromHead,
          provisionedFiles,
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const saved = await commitManagedWorktreeCreation({
          validateBeforeSave: async () => {
            const latest = await dependencies.environment.resolve(sourceWorkspaceId, true);
            if (
              !latest ||
              signal.aborted ||
              latest.folderPath !== resolved.folderPath ||
              latest.workspace.permission !== resolved.workspace.permission
            ) {
              throw new Error("The source workspace changed while Aiden was creating the worktree.");
            }
          },
          saveWorkspace: () => dependencies.saveWorkspace(workspace),
          validateAfterSave: () => {
            if (signal.aborted || dependencies.workspaceIsChanging(sourceWorkspaceId)) {
              throw new Error("The source workspace changed while Aiden was saving the worktree.");
            }
          },
          removeWorkspaceRecord: (savedWorkspace) => dependencies.removeWorkspace(savedWorkspace.id),
          rollbackWorktree: () =>
            dependencies.rollbackWorktree(resolved.folderPath, worktree, {
              provisionedIgnored: provisionedFiles,
            }),
        });
        dependencies.notifyChanged();
        return saved;
      } catch (error) {
        if (error instanceof ManagedWorktreeCreationError) {
          dependencies.logError("git", error.logMessage, error.errors);
        }
        throw error;
      }
    },
  );

  const remove = async (
    owner: WorkspaceOperationDocumentOwner,
    workspaceId: string,
    validateWorkspace: (workspace: Workspace) => void = () => undefined,
    options?: { force?: boolean },
  ): Promise<GitDeleteWorktreeResult> => dependencies.environment.runRecord(
    owner,
    workspaceId,
    async (workspace, signal) => {
      validateWorkspace(workspace);
      const managed = workspace.managedWorktree;
      if (!managed) throw new Error("This workspace is not an Aiden-managed worktree.");
      const finishMutation = dependencies.beginWorkspaceMutation(workspaceId);
      try {
        await dependencies.cancelWorkspaceOperations(workspaceId, signal);
        const result = await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: workspace.permission !== "none",
            resume: () => dependencies.resumeWorkspaceSchedules(workspaceId),
            onResumeError: (error) => dependencies.logError(
              "schedule",
              "Could not restore scheduled tasks after managed worktree deletion failed.",
              error,
            ),
          },
          async ({ keepPaused }) => {
            dependencies.closeWorkspaceTerminals(workspaceId);
            await dependencies.cancelWorkspaceGeneration(workspaceId);
            await dependencies.cancelWorkspaceSchedules(workspaceId);

            // Deletion policy classification. This advisory read happens before
            // any mutation; the Git layer re-verifies everything at the
            // quarantine and authorization boundaries.
            const provisionedIgnored = managed.provisionedFiles ?? [];
            const provisionedSet = new Set(provisionedIgnored);
            const dirty = await dependencies.dirtyState(
              managed.repositoryPath,
              managed.worktreePath,
            );
            // Status collapses ignored directories to `dir/` records while the
            // allowlist names provisioned files — expand to file granularity.
            // An explicit force skips recoverability classification entirely (the
            // Git layer does the same for its own policy), so a confirmed
            // destructive removal must not be blocked here by an advisory scan
            // that a large ignored tree can push past Git's output-buffer cap.
            let unknownIgnored = dirty.ignored > dirty.ignoredPaths.length;
            if (!unknownIgnored && options?.force !== true) {
              const expanded = await dependencies.expandIgnoredPaths(
                managed.repositoryPath,
                managed.worktreePath,
                dirty.ignoredPaths,
              );
              unknownIgnored =
                expanded === undefined ||
                expanded.some((entry) => !provisionedSet.has(entry));
            }
            const needsSnapshot = dirty.uncommitted > 0 || dirty.ignored > 0;

            const snapshotWorktree = async () => {
              const snapshotRoot = await dependencies.ensureSnapshotRoot();
              const snapshotId = randomUUID();
              const snapshotDir = path.join(snapshotRoot, snapshotId);
              const provisioned: ProvisionedFileSnapshot[] = [];
              let blobBytes = 64 * 1024;
              for (const relativePath of provisionedIgnored) {
                try {
                  blobBytes += (await fs.lstat(
                    path.join(managed.worktreePath, relativePath),
                  )).size;
                } catch {
                  // A provisioned file the user already removed needs no blob.
                }
              }
              // The snapshot writes to three filesystems: content-addressed
              // blobs in the snapshot dir, loose objects in the repository's
              // Git dir, and an isolated index in the OS temp dir. Admit only
              // when each volume can hold its share. Git objects go to the
              // repository's common directory, which can sit on a different
              // volume than the checkout, so admit against the object store's
              // own filesystem instead of `repositoryPath`.
              const [{ commonDir }, [objectBytes, indexBytes]] = await Promise.all([
                dependencies.repositoryPaths(managed.repositoryPath),
                Promise.all([
                  dependencies.snapshotContentBytes(
                    managed.repositoryPath,
                    managed.worktreePath,
                  ),
                  managed.worktreeGitDir === undefined
                    ? Promise.resolve(64 * 1024)
                    : fs
                        .lstat(path.join(managed.worktreeGitDir, "index"))
                        .then((stat) => stat.size)
                        .catch(() => 64 * 1024),
                ]),
              ]);
              await Promise.all([
                dependencies.checkSnapshotCapacity(snapshotRoot, blobBytes),
                dependencies.checkSnapshotCapacity(commonDir, objectBytes),
                dependencies.checkSnapshotCapacity(
                  os.tmpdir(),
                  indexBytes + 64 * 1024,
                ),
              ]);
              await fs.mkdir(path.join(snapshotDir, "files"), {
                recursive: true,
                mode: 0o700,
              });
              for (const relativePath of provisionedIgnored) {
                if (!(await fileExists(path.join(managed.worktreePath, relativePath)))) continue;
                provisioned.push(
                  await captureProvisionedFile(
                    snapshotDir,
                    managed.worktreePath,
                    relativePath,
                    {
                      path: managed.worktreePath,
                      device: String(managed.worktreeDevice),
                      inode: String(managed.worktreeInode),
                    },
                  ),
                );
              }
              const capture = await dependencies.captureWorktreeSnapshot(
                managed.repositoryPath,
                managed.worktreePath,
                snapshotId,
                signal,
              );
              const relativeWorkspace = workspace.folderPath
                ? path.relative(managed.worktreePath, workspace.folderPath)
                : "";
              const workspaceSubpath =
                relativeWorkspace === ".." ||
                relativeWorkspace.startsWith("../") ||
                path.isAbsolute(relativeWorkspace)
                  ? ""
                  : relativeWorkspace;
              try {
                await persistManagedWorktreeSnapshot(snapshotRoot, {
                  id: snapshotId,
                  workspaceId,
                  repositoryPath: managed.repositoryPath,
                  worktreePath: managed.worktreePath,
                  workspaceSubpath,
                  branch: managed.branch,
                  originalHead: capture.head,
                  snapshotRef: capture.ref,
                  snapshotCommit: capture.commit,
                  snapshotTree: capture.tree,
                  createdAt: dependencies.now(),
                  provisionedFiles: provisioned,
                  state: "ready",
                });
              } catch (error) {
                // A snapshot without its manifest is unusable, so a failed
                // publication must not leak the synthetic ref and private
                // blobs this attempt already wrote.
                let refDeleted = false;
                try {
                  refDeleted = await dependencies.deleteSnapshotRef(
                    managed.repositoryPath,
                    snapshotId,
                    capture.commit,
                  );
                } catch (cleanupError) {
                  throw new ManagedWorktreeSnapshotCleanupError(cleanupError);
                }
                if (!refDeleted) throw new ManagedWorktreeSnapshotCleanupError(error);
                try {
                  await fs.rm(path.join(snapshotRoot, snapshotId), { recursive: true });
                } catch (cleanupError) {
                  throw new ManagedWorktreeSnapshotCleanupError(cleanupError);
                }
                throw error;
              }
              return {
                id: snapshotId,
                ref: capture.ref,
                commit: capture.commit,
                tree: capture.tree,
              };
            };

            let lifecycle: ManagedWorktreeDeletionLifecycle | undefined;
            if (options?.force === true) {
              lifecycle = { force: true, provisionedIgnored };
              if (needsSnapshot) {
                // Force still preserves what it can — a successful snapshot
                // keeps the deletion restorable — but a failed snapshot must
                // not block an explicitly confirmed destructive removal.
                try {
                  lifecycle.snapshot = await snapshotWorktree();
                } catch (error) {
                  if (error instanceof ManagedWorktreeSnapshotCleanupError) throw error;
                  dependencies.logError(
                    "git",
                    "A forced managed worktree deletion could not preserve a snapshot.",
                    error,
                  );
                }
              }
            } else {
              if (unknownIgnored) {
                throw new Error(
                  "This managed worktree contains ignored files Aiden did not provision. Remove them or confirm a force deletion.",
                );
              }
              if (needsSnapshot) {
                lifecycle = {
                  snapshot: await snapshotWorktree(),
                  provisionedIgnored,
                };
              }
            }

            const deletion = await removeManagedWorkspace({
              deleteWorktree: () => dependencies.deleteManagedWorktree(managed, signal, lifecycle),
              destructiveMutationAttempted: (error) =>
                error instanceof GitManagedWorktreeDeleteError
                  ? error.destructiveMutationAttempted
                  : undefined,
              deletionPending: () => dependencies.managedWorktreeDeletionPending(managed),
              workspacePathExists: () => dependencies.workspacePathExists(managed.worktreePath),
              worktreeRegistered: () => dependencies.managedWorktreeRegistered(managed),
              worktreeUsable: () => dependencies.managedWorktreeUsable(managed),
              onDestructiveBoundary: keepPaused,
              removeWorkspaceRecord: () => dependencies.removeWorkspace(workspaceId),
              reconciledResult: () => ({ branchDeleted: false }),
            });
            if (managed.worktreeGitDir && managed.ownershipToken) {
              await dependencies.finalizeManagedWorktreeDeletion(managed);
            }
            return deletion;
          },
        );
        dependencies.notifyChanged();
        return result;
      } finally {
        finishMutation();
      }
    },
  );

  const restore = async (
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    snapshotId: string,
    requestedName?: string,
  ): Promise<Workspace> => {
    const operation = dependencies.environment.run(
      owner,
      sourceWorkspaceId,
      async (resolved, signal) => {
        // Every caller completes ownership and workspace admission before any
        // shared state is consulted. A concurrent restore of the same snapshot
        // is serialized, not shared: this caller waits for the in-flight
        // attempt, then runs its own journal-convergent restore.
        const pending = restoreLocks.get(snapshotId);
        if (pending !== undefined) {
          await pending.catch(() => undefined);
        }
        const snapshotRoot = await dependencies.ensureSnapshotRoot();
        const snapshot = await requireReadyManagedWorktreeSnapshot(snapshotRoot, snapshotId);
        const [initiator, target] = await Promise.all([
          dependencies.repositoryPaths(resolved.folderPath),
          dependencies.repositoryPaths(snapshot.repositoryPath),
        ]);
        // A restore may only be initiated from a checkout of the repository the
        // snapshot belongs to — never across repositories.
        if (initiator.commonDir !== target.commonDir) {
          throw new Error("That snapshot belongs to a different repository.");
        }
        const result = await restoreManagedWorktreeSnapshot(
          {
            ensureWorktreeRoot: dependencies.ensureWorktreeRoot,
            snapshotRoot: dependencies.ensureSnapshotRoot,
            repositoryPaths: dependencies.repositoryPaths,
            snapshotCommit: dependencies.snapshotRefCommit,
            restoreCheckout: dependencies.restoreManagedCheckout,
            resumeCheckout: dependencies.resumeManagedCheckout,
            applySnapshot: dependencies.applyWorktreeSnapshot,
            managedWorktreeUsable: (repositoryPath, worktreePath, branch, gitDir, token, device, inode) =>
              dependencies.managedWorktreeUsable({
                repositoryPath,
                worktreePath,
                branch,
                worktreeGitDir: gitDir,
                ownershipToken: token,
                worktreeDevice: device,
                worktreeInode: inode,
                createdFromHead: snapshot.originalHead,
              }),
            createWorkspaceId: dependencies.createWorkspaceId,
            signal,
          },
          snapshotId,
        );
        const now = dependencies.now();
        const workspace: Workspace = {
          id: result.workspaceId,
          name: displayName(resolved.workspace, snapshot.branch, requestedName),
          folderPath: result.worktree.workspacePath,
          permission: resolved.workspace.permission,
          managedWorktree: {
            repositoryPath: result.worktree.repositoryPath,
            worktreePath: result.worktree.path,
            branch: snapshot.branch,
            worktreeGitDir: result.worktree.worktreeGitDir,
            ownershipToken: result.worktree.ownershipToken,
            worktreeDevice: result.worktree.worktreeDevice,
            worktreeInode: result.worktree.worktreeInode,
            createdFromHead: result.worktree.createdFromHead,
            provisionedFiles: result.snapshot.provisionedFiles.map((file) => file.relativePath),
          },
          createdAt: now,
          updatedAt: now,
        };
        // Upsert by id: a crash after the save is replayed by the restore
        // journal's stable workspaceId, so a retried restore never duplicates.
        const saved = await dependencies.saveWorkspace(workspace);
        await updateManagedWorktreeSnapshotState(snapshotRoot, result.snapshot, "ready");
        // The journal stays at "complete" — it is the convergence marker a
        // retried restore needs to return the already-saved workspace instead
        // of attaching the recorded branch to a new path.
        dependencies.notifyChanged();
        return saved;
      },
    );
    restoreLocks.set(snapshotId, operation);
    try {
      return await operation;
    } finally {
      if (restoreLocks.get(snapshotId) === operation) {
        restoreLocks.delete(snapshotId);
      }
    }
  };

  return { create, remove, restore };
}

export type WorkspaceWorktreeApplicationService = ReturnType<
  typeof createWorkspaceWorktreeApplicationService
>;
