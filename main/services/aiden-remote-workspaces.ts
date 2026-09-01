import { createHash } from "node:crypto";
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

export function projectAidenRemoteWorkspace(
  workspace: Workspace,
): AidenRemoteWorkspaceProjection {
  return {
    id: workspace.id,
    name: workspace.name,
    permission: workspace.permission,
    memoryEnabled: workspace.memoryEnabled !== false,
    hasFolder: Boolean(workspace.folderPath),
    isManagedWorktree: Boolean(workspace.managedWorktree),
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
  | { mode: "selected-folder"; selection: string; name?: string } {
  const record = ownRecord(value);
  if (!record || typeof record.mode !== "string") {
    throw new AidenRemoteServiceError("invalid_request", "The workspace creation request is invalid.", 400);
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
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!this.options.persistIdempotency) {
      return this.idempotency.execute(scope, input, action);
    }
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const durableAdmission = new Promise<void>((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    const pending = this.idempotency.execute(scope, input, async () => {
      await durableAdmission;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      release();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      throw new AidenRemoteServiceError(
        "internal_error",
        "Aiden could not durably prepare this workspace request.",
        500,
      );
    }
    let result: T;
    let actionError: unknown;
    let actionFailed = false;
    try {
      result = await pending;
    } catch (error) {
      actionFailed = true;
      actionError = error;
    }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError(
        "idempotency_in_flight",
        "The workspace change may have completed, but Aiden could not durably record its outcome.",
        409,
      );
    }
    if (actionFailed) throw actionError;
    return result!;
  }

  async list(): Promise<{ workspaces: AidenRemoteWorkspaceProjection[] }> {
    return {
      workspaces: (await this.options.application.list()).map(projectAidenRemoteWorkspace),
    };
  }

  async get(workspaceId: string): Promise<AidenRemoteWorkspaceProjection> {
    const workspace = await this.options.application.get(safeWorkspaceId(workspaceId));
    if (!workspace) {
      throw new AidenRemoteServiceError("not_found", "This Aiden workspace no longer exists.", 404);
    }
    return projectAidenRemoteWorkspace(workspace);
  }

  async create(
    deviceId: string,
    idempotencyKey: string,
    input: unknown,
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
          if (parsed.mode === "folderless") {
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
          return projectAidenRemoteWorkspace(workspace);
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
    return projectAidenRemoteWorkspace(updated);
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
