import type { ManagedWorktreeRootIdentity } from "./managed-worktree-file-io.js";
import { capturePeerProjectRoot, assertPeerProjectRoot, createPeerProjectFile } from "./peer-project-file-io.js";
import { peerProjectGit } from "./peer-project-source.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parsePeerProjectClone, PEER_PROJECT_CLONE_TIMEOUT_MS, type PeerProjectCloneRequest } from "../../renderer/shared/peer-project-clone.js";
import { parseCloneUrl } from "../../renderer/shared/workspace-intake.js";
import type { WorkspaceIntakeService } from "./workspace-intake.js";
import { executeAidenDurableOperation } from "./aiden-remote-durable-operation.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  AidenOperationContractError,
  assertRevision,
} from "./aiden-remote-operation-contract.js";
import type { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { createWorkspaceApplicationService } from "./workspace-application-service.js";
import type { Workspace, WorkspacePermission } from "./types.js";
import { legacyWorkspaceTier, type ApprovalMode } from "../../renderer/shared/approval-mode.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/u;
const PERMISSIONS: readonly WorkspacePermission[] = ["full", "ask", "none"];

export interface AidenRemoteWorkspaceProjection {
  id: string;
  name: string;
  permission: WorkspacePermission;
  memoryEnabled: boolean;
  hasFolder: boolean;
  isManagedWorktree: boolean;
  /** Revision 51: a hidden folder Aiden made for one chat without a workspace. */
  noWorkspace?: true;
  branchName?: string;
  repositoryName?: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

type WorkspaceApplicationService = ReturnType<typeof createWorkspaceApplicationService>;

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum;
}

function safeWorkspaceId(value: string): string {
  if (!WORKSPACE_ID_PATTERN.test(value)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The workspace identifier is invalid.",
      400,
    );
  }
  return value;
}

export function workspaceRevision(workspace: Workspace): string {
  const value = JSON.stringify({
    id: workspace.id,
    name: workspace.name,
    permission: workspace.permission,
    memoryEnabled: workspace.memoryEnabled !== false,
    hasFolder: Boolean(workspace.folderPath),
    managedBranch: workspace.managedWorktree?.branch ?? null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  return `rev_${createHash("sha256").update(value).digest("base64url")}`;
}

function displayNameFromPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const components = value.split(/[\\/]/u).filter(Boolean);
  return components[components.length - 1]?.slice(0, 120);
}

/**
 * A workspace as a Remote client sees it. Phones know only the access tiers,
 * so `permission` is the tier that never reads narrower than what runs under
 * `globalMode` (`legacyWorkspaceTier`). The revision stays the stored one.
 */
export function projectAidenRemoteWorkspace(
  workspace: Workspace,
  globalMode: ApprovalMode = "ask",
): AidenRemoteWorkspaceProjection {
  return {
    id: workspace.id,
    name: workspace.name,
    permission: legacyWorkspaceTier(workspace, globalMode),
    memoryEnabled: workspace.memoryEnabled !== false,
    hasFolder: Boolean(workspace.folderPath),
    isManagedWorktree: Boolean(workspace.managedWorktree),
    ...(workspace.noWorkspace ? { noWorkspace: true as const } : {}),
    ...(workspace.managedWorktree?.branch
      ? { branchName: workspace.managedWorktree.branch.slice(0, 255) }
      : {}),
    ...(displayNameFromPath(workspace.managedWorktree?.repositoryPath)
      ? { repositoryName: displayNameFromPath(workspace.managedWorktree?.repositoryPath)! }
      : {}),
    createdAt: new Date(workspace.createdAt).toISOString(),
    updatedAt: new Date(workspace.updatedAt).toISOString(),
    revision: workspaceRevision(workspace),
  };
}

function parseCreate(value: unknown):
  | { mode: "folderless"; name: string }
  | { mode: "scratch" }
  | { mode: "selected-folder"; selection: string; name?: string }
  | PeerProjectCloneRequest {
  const record = ownRecord(value);
  if (!record || typeof record.mode !== "string") {
    throw new AidenRemoteServiceError("invalid_request", "The workspace creation request is invalid.", 400);
  }
  if (record.mode === "clone") {
    try { return parsePeerProjectClone(record); }
    catch { throw new AidenRemoteServiceError("invalid_request", "The project clone or environment file selection is invalid.", 400); }
  }
  if (record.mode === "folderless") {
    if (!exactKeys(record, ["mode", "name"]) || !boundedString(record.name, 120)) {
      throw new AidenRemoteServiceError("invalid_request", "A folderless workspace requires a valid name.", 400);
    }
    return { mode: "folderless", name: record.name.trim() };
  }
  if (record.mode === "scratch") {
    if (!exactKeys(record, ["mode"])) {
      throw new AidenRemoteServiceError("invalid_request", "The scratch workspace request is invalid.", 400);
    }
    return { mode: "scratch" };
  }
  if (record.mode === "selected-folder") {
    if (
      !exactKeys(record, ["mode", "selection"], ["name"]) ||
      typeof record.selection !== "string" ||
      !/^sel_[A-Za-z0-9_-]{43}$/u.test(record.selection) ||
      (record.name !== undefined && !boundedString(record.name, 120))
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The selected-folder workspace request is invalid.", 400);
    }
    return {
      mode: "selected-folder",
      selection: record.selection,
      ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    };
  }
  throw new AidenRemoteServiceError("invalid_request", "The workspace creation mode is invalid.", 400);
}

function parsePatch(value: unknown): {
  name?: string;
  permission?: WorkspacePermission;
  memoryEnabled?: boolean;
  approvalMode?: "ask";
  clearMacGrants?: true;
} {
  const record = ownRecord(value);
  if (
    !record ||
    !exactKeys(record, ["confirmedForeground"], ["name", "permission", "memoryEnabled"]) ||
    record.confirmedForeground !== true ||
    (record.name === undefined && record.permission === undefined && record.memoryEnabled === undefined) ||
    (record.name !== undefined && !boundedString(record.name, 120)) ||
    (record.permission !== undefined && !PERMISSIONS.includes(record.permission as WorkspacePermission)) ||
    (record.memoryEnabled !== undefined && typeof record.memoryEnabled !== "boolean")
  ) {
    throw new AidenRemoteServiceError(
      "permission_confirmation_required",
      "Workspace changes require an explicit foreground confirmation.",
      409,
    );
  }
  return {
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(record.permission !== undefined
      ? { permission: record.permission as WorkspacePermission }
      : {}),
    // An older client's Ask means Ask: the workspace's own mode becomes Ask
    // and its Mac grants go, which only ever narrows what runs.
    ...(record.permission === "ask" ? { approvalMode: "ask" as const, clearMacGrants: true as const } : {}),
    ...(typeof record.memoryEnabled === "boolean"
      ? { memoryEnabled: record.memoryEnabled }
      : {}),
  };
}

function mapOperationError(error: unknown, currentRevision?: string): never {
  if (!(error instanceof AidenOperationContractError)) throw error;
  const status = error.code === "revision_conflict"
    ? 409
    : error.code === "idempotency_capacity"
      ? 429
      : 409;
  throw new AidenRemoteServiceError(
    error.code,
    error.code === "revision_conflict"
      ? "The workspace changed. Refresh it before trying again."
      : "This workspace request cannot be safely repeated.",
    status,
    error.code === "idempotency_capacity",
    currentRevision ? { currentRevision } : undefined,
  );
}

function requireWorkspaceRevision(expected: string, workspace: Workspace): void {
  const currentRevision = workspaceRevision(workspace);
  try {
    assertRevision(expected, currentRevision);
  } catch (error) {
    mapOperationError(error, currentRevision);
  }
}

export class AidenRemoteWorkspaceService {
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(
    private readonly options: {
      application: Pick<
        WorkspaceApplicationService,
        "list" | "get" | "create" | "createScratch" | "createFromFolder" | "update" | "remove"
      >;
      browser: Pick<
        AidenRemoteWorkspaceBrowserService,
        "consumeSelection" | "revalidateConsumedSelection"
      >;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      notifyChanged?: () => void;
      clone?: WorkspaceIntakeService["clone"];
      /** The global approval mode the projected access tier reads under; Ask when absent. */
      approvalMode?: () => ApprovalMode | Promise<ApprovalMode>;
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  get supportsClone(): boolean { return Boolean(this.options.clone); }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    return executeAidenDurableOperation(
      {
        ledger: this.idempotency,
        persist: this.options.persistIdempotency,
        notPreparedMessage: "Aiden could not durably prepare this workspace request.",
        outcomeUnrecordedMessage: "The workspace change may have completed, but Aiden could not durably record its outcome.",
      },
      scope,
      input,
      action,
    );
  }

  private async globalMode(): Promise<ApprovalMode> {
    return (await this.options.approvalMode?.()) ?? "ask";
  }

  async list(): Promise<{ workspaces: AidenRemoteWorkspaceProjection[] }> {
    const [workspaces, mode] = await Promise.all([this.options.application.list(), this.globalMode()]);
    return { workspaces: workspaces.map((workspace) => projectAidenRemoteWorkspace(workspace, mode)) };
  }

  async get(workspaceId: string): Promise<AidenRemoteWorkspaceProjection> {
    const workspace = await this.options.application.get(safeWorkspaceId(workspaceId));
    if (!workspace) {
      throw new AidenRemoteServiceError("not_found", "This Aiden workspace no longer exists.", 404);
    }
    return projectAidenRemoteWorkspace(workspace, await this.globalMode());
  }

  async create(
    deviceId: string,
    idempotencyKey: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AidenRemoteWorkspaceProjection> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    const parsed = parseCreate(input);
    try {
      return await this.executeIdempotent(
        {
          deviceId,
          route: "POST /workspaces",
          resourceId: "workspace-registry",
          key: idempotencyKey,
        },
        parsed,
        async () => {
          let workspace: Workspace;
          if (parsed.mode === "clone") {
            if (!this.options.clone) throw new AidenRemoteServiceError("not_found", "Project cloning is unavailable on this host.", 404);
            const selection = await this.options.browser.consumeSelection(deviceId, parsed.selection);
            const current = () => this.options.browser.revalidateConsumedSelection(deviceId, selection);
            await current();
            const controller = new AbortController();
            const cancel = () => controller.abort();
            signal?.addEventListener("abort", cancel, { once: true });
            if (signal?.aborted) cancel();
            const deadline = setTimeout(cancel, PEER_PROJECT_CLONE_TIMEOUT_MS);
            deadline.unref?.();
            try {
              const remote = parseCloneUrl(parsed.url);
              if (!remote.ok) throw new AidenRemoteServiceError("invalid_request", "The repository remote is invalid.", 400);
              const destination = path.join(selection.canonicalPath, remote.repoName);
              let child: ManagedWorktreeRootIdentity | undefined;
              const repository = await this.options.clone({ url: remote.url, destination }, {
                cloneId: randomUUID(), signal: controller.signal, onProgress: () => undefined,
                beforePublish: async staged => {
                  const root = await capturePeerProjectRoot(staged);
                  child = { ...root, path: destination };
                  await current();
                  await assertPeerProjectRoot(root);
                  for (const file of parsed.files) {
                    controller.signal.throwIfAborted();
                    try {
                      // A staging-path Git config can differ after the clone is moved.
                      // Require protection under both case-matching modes.
                      for (const ignoreCase of ["false", "true"]) {
                        await peerProjectGit(root.path, ["-c", "core.excludesFile=/dev/null", "-c", `core.ignoreCase=${ignoreCase}`, "check-ignore", "-q", "--", file.name]);
                      }
                    } catch {
                      throw new AidenRemoteServiceError("invalid_request", "The destination repository must ignore each selected environment file.", 400);
                    }
                    await assertPeerProjectRoot(root);
                    await createPeerProjectFile(root, file.name, file.content, controller.signal);
                  }
                  await current();
                },
                beforeRegister: async () => { await current(); },
                registration: {
                  assertCurrent: async identity => {
                    await current();
                    if (!child || identity.canonicalPath !== child.path || identity.filesystemDevice !== child.device || identity.filesystemInode !== child.inode) throw new Error("The cloned project folder changed before registration.");
                    await assertPeerProjectRoot(child);
                  },
                },
              });
              if (!repository.ok) throw new AidenRemoteServiceError("invalid_request", repository.code === "cancelled" ? "Project clone was stopped. Check the host project list before trying again." : repository.code === "register-failed" ? "The repository was cloned, but it could not be registered. Check the destination computer before retrying." : repository.reason, 400);
              workspace = repository.workspace;
            } catch (error) {
              if (error instanceof AidenRemoteServiceError) throw error;
              throw new AidenRemoteServiceError("invalid_request", "The project could not be cloned with the selected environment files. Nothing existing was overwritten. Check the host project list before retrying.", 400);
            } finally {
              clearTimeout(deadline);
              signal?.removeEventListener("abort", cancel);
            }
          } else if (parsed.mode === "folderless") {
            workspace = await this.options.application.create({
              name: parsed.name,
              permission: "ask",
            });
          } else if (parsed.mode === "scratch") {
            workspace = await this.options.application.createScratch();
          } else {
            const selection = await this.options.browser.consumeSelection(
              deviceId,
              parsed.selection,
            );
            try {
              workspace = await this.options.application.createFromFolder(
                selection.canonicalPath,
                parsed.name,
                {
                  assertCurrent: async (identity) => {
                    const current = await this.options.browser.revalidateConsumedSelection(
                      deviceId,
                      selection,
                    );
                    if (
                      identity.canonicalPath !== current.canonicalPath ||
                      identity.filesystemDevice !== current.filesystemDevice ||
                      identity.filesystemInode !== current.filesystemInode
                    ) {
                      throw new AidenRemoteServiceError(
                        "filesystem_identity_changed",
                        "The selected folder changed before Aiden could register it.",
                        409,
                      );
                    }
                  },
                },
              );
            } catch (error) {
              if (error instanceof Error && /already registered/u.test(error.message)) {
                throw new AidenRemoteServiceError(
                  "already_exists",
                  "That folder is already registered as an Aiden workspace.",
                  409,
                );
              }
              throw error;
            }
          }
          this.options.notifyChanged?.();
          return projectAidenRemoteWorkspace(workspace, await this.globalMode());
        },
      );
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      mapOperationError(error);
    }
  }

  async update(
    workspaceId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteWorkspaceProjection> {
    const id = safeWorkspaceId(workspaceId);
    const current = await this.options.application.get(id);
    if (!current) {
      throw new AidenRemoteServiceError("not_found", "This Aiden workspace no longer exists.", 404);
    }
    requireWorkspaceRevision(expectedRevision, current);
    const patch = parsePatch(input);
    const updated = await this.options.application.update(id, patch, {
      assertCurrent: (workspace) => requireWorkspaceRevision(expectedRevision, workspace),
    });
    this.options.notifyChanged?.();
    return projectAidenRemoteWorkspace(updated, await this.globalMode());
  }

  async remove(workspaceId: string, expectedRevision: string): Promise<void> {
    const id = safeWorkspaceId(workspaceId);
    const current = await this.options.application.get(id);
    if (!current) {
      throw new AidenRemoteServiceError("not_found", "This Aiden workspace no longer exists.", 404);
    }
    requireWorkspaceRevision(expectedRevision, current);
    try {
      await this.options.application.remove(id, {
        assertCurrent: (workspace) => requireWorkspaceRevision(expectedRevision, workspace),
      });
    } catch (error) {
      if (error instanceof Error && /managed worktree|Delete worktree/u.test(error.message)) {
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "Managed worktrees must be removed through Aiden's worktree workflow.",
          409,
        );
      }
      throw error;
    }
    this.options.notifyChanged?.();
  }
}
