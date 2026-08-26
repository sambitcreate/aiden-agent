import { randomBytes } from "node:crypto";
import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenOpaqueHandleError,
  AidenOpaqueHandleStore,
  inspectAidenFilesystemIdentity,
  type AidenOpaqueHandleClaims,
} from "./aiden-remote-opaque-handles.js";
import { projectAidenRemoteWorkspace } from "./aiden-remote-workspaces.js";
import type { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import type { WorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
  type WorkspaceFileDocument,
  type WorkspaceFileEntry,
} from "./workspace-files.js";

const FILE_HANDLE_TTL_MS = 10 * 60_000;
const MAX_DISPLAY_PATH_LENGTH = 4_096;
const MAX_WIRE_FILE_SIZE = 5 * 1_048_576;

export interface AidenRemoteFileEntry {
  id: string;
  displayPath: string;
  name: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  language?: string;
}

export interface AidenRemoteFileIndex {
  snapshotId: string;
  entries: AidenRemoteFileEntry[];
  truncated: boolean;
  maxEntries: 4_000;
  maxDepth: 20;
}

export interface AidenRemoteFileDocument {
  id: string;
  displayPath: string;
  content: string;
  version: string;
  truncated: false;
  warning?: string;
}

function languageFor(entry: WorkspaceFileEntry): string | undefined {
  if (entry.kind !== "file") return undefined;
  const extension = path.extname(entry.name).slice(1).toLowerCase();
  const names: Record<string, string> = {
    c: "C", cc: "C++", cpp: "C++", css: "CSS", go: "Go", h: "C Header",
    html: "HTML", java: "Java", js: "JavaScript", json: "JSON", jsx: "JSX",
    kt: "Kotlin", md: "Markdown", mjs: "JavaScript", py: "Python", rb: "Ruby",
    rs: "Rust", sh: "Shell", swift: "Swift", ts: "TypeScript", tsx: "TSX",
    yaml: "YAML", yml: "YAML",
  };
  return names[extension];
}

function safeDisplayPath(value: string): string {
  if (
    !value ||
    value.length > MAX_DISPLAY_PATH_LENGTH ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => part === "..") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new AidenRemoteServiceError(
      "workspace_unavailable",
      "A workspace file could not be projected safely.",
      409,
    );
  }
  return value;
}

function mapHandleError(error: unknown): never {
  if (!(error instanceof AidenOpaqueHandleError)) throw error;
  const status = error.code === "handle_wrong_device"
    ? 403
    : error.code === "handle_expired"
      ? 410
      : error.code === "handle_capacity"
        ? 429
        : error.code === "root_policy_changed" ||
            error.code === "filesystem_identity_changed" ||
            error.code === "path_outside_root"
          ? 409
          : 400;
  throw new AidenRemoteServiceError(
    error.code,
    error.code === "handle_expired"
      ? "This file link expired. Refresh Files and try again."
      : error.code === "handle_capacity"
        ? "Aiden's file-handle capacity is temporarily full."
        : "This file link is no longer valid. Refresh Files and try again.",
    status,
    error.code === "handle_capacity",
  );
}

function parseWrite(value: unknown): { content: string; expectedVersion: string } {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (
    !record ||
    Object.keys(record).length !== 2 ||
    typeof record.content !== "string" ||
    Buffer.byteLength(record.content, "utf8") > 1_500_000 ||
    typeof record.expectedVersion !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.expectedVersion)
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The file save request is invalid.", 400);
  }
  return { content: record.content, expectedVersion: record.expectedVersion };
}

function projectedDocument(
  fileId: string,
  displayPath: string,
  document: WorkspaceFileDocument,
): AidenRemoteFileDocument {
  return {
    id: fileId,
    displayPath,
    content: document.content,
    version: document.version,
    truncated: false,
    ...(document.warning ? { warning: [...document.warning].slice(0, 500).join("") } : {}),
  };
}

export class AidenRemoteFileService {
  private handleStore: AidenOpaqueHandleStore | undefined;
  private readonly now = (): number => this.options.now?.() ?? Date.now();

  constructor(
    private readonly options: {
      instanceId: string;
      application: Pick<WorkspaceEnvironmentApplicationService, "run">;
      owners: Pick<AidenRemoteWorkspaceOwnerRegistry, "owner">;
      handles?: AidenOpaqueHandleStore;
      now?: () => number;
    },
  ) {}

  private get handles(): AidenOpaqueHandleStore {
    this.handleStore ??= this.options.handles ?? new AidenOpaqueHandleStore({ now: this.now });
    return this.handleStore;
  }

  private async claims(
    deviceId: string,
    workspaceId: string,
    folderPath: string,
    workspaceRevision: string,
    displayPath: string,
    snapshotId: string,
  ): Promise<AidenOpaqueHandleClaims> {
    const identity = await inspectAidenFilesystemIdentity(
      folderPath,
      path.join(folderPath, displayPath),
    );
    return {
      instanceId: this.options.instanceId,
      deviceId,
      workspaceId,
      rootId: workspaceId,
      policyRevision: workspaceRevision,
      ...identity,
      displayPath,
      snapshotId,
      expiresAt: this.now() + FILE_HANDLE_TTL_MS,
    };
  }

  async list(deviceId: string, workspaceId: string): Promise<AidenRemoteFileIndex> {
    return this.options.application.run(
      this.options.owners.owner(deviceId),
      workspaceId,
      async ({ folderPath, workspace }, signal) => {
        const index = await listWorkspaceFiles(folderPath, signal);
        const snapshotId = `files_${randomBytes(24).toString("base64url")}`;
        const revision = projectAidenRemoteWorkspace(workspace).revision;
        const entries: AidenRemoteFileEntry[] = [];
        let omitted = false;
        for (const entry of index.entries) {
          if (signal.aborted) throw new Error("The workspace operation was cancelled.");
          try {
            const displayPath = safeDisplayPath(entry.path);
            const claims = await this.claims(
              deviceId,
              workspaceId,
              folderPath,
              revision,
              displayPath,
              snapshotId,
            );
            entries.push({
              id: this.handles.issue("file", claims),
              displayPath,
              name: [...entry.name].slice(0, 255).join(""),
              kind: entry.kind,
              ...(entry.size !== undefined && entry.size <= MAX_WIRE_FILE_SIZE
                ? { size: entry.size }
                : {}),
              ...(languageFor(entry) ? { language: languageFor(entry)! } : {}),
            });
          } catch (error) {
            if (error instanceof AidenOpaqueHandleError && error.code === "handle_capacity") {
              mapHandleError(error);
            }
            omitted = true;
          }
        }
        const projection: AidenRemoteFileIndex = {
          snapshotId,
          entries,
          truncated: index.truncated || omitted,
          maxEntries: 4_000,
          maxDepth: 20,
        };
        return projection;
      },
    ).catch((error: unknown) => {
      if (error instanceof AidenRemoteServiceError) throw error;
      throw new AidenRemoteServiceError(
        "workspace_unavailable",
        "This workspace's files are not currently available on the desktop.",
        409,
      );
    });
  }

  private async withResolvedFile<T>(
    deviceId: string,
    workspaceId: string,
    fileId: string,
    operation: (
      input: { folderPath: string; displayPath: string; signal: AbortSignal },
    ) => Promise<T>,
  ): Promise<T> {
    let stored: AidenOpaqueHandleClaims;
    try {
      stored = this.handles.claimsFor(fileId, "file");
    } catch (error) {
      mapHandleError(error);
    }
    try {
      return await this.options.application.run(
        this.options.owners.owner(deviceId),
        workspaceId,
        async ({ folderPath, workspace }, signal) => {
          if (!stored.displayPath || stored.workspaceId !== workspaceId) {
            throw new AidenOpaqueHandleError("handle_wrong_device");
          }
          const current = await this.claims(
            deviceId,
            workspaceId,
            folderPath,
            projectAidenRemoteWorkspace(workspace).revision,
            stored.displayPath,
            stored.snapshotId ?? "",
          );
          current.expiresAt = stored.expiresAt;
          this.handles.resolve(fileId, "file", current);
          return operation({ folderPath, displayPath: stored.displayPath, signal });
        },
      );
    } catch (error) {
      if (error instanceof AidenOpaqueHandleError) mapHandleError(error);
      throw error;
    }
  }

  read(deviceId: string, workspaceId: string, fileId: string): Promise<AidenRemoteFileDocument> {
    return this.withResolvedFile(deviceId, workspaceId, fileId, async (input) => {
      try {
        return projectedDocument(
          fileId,
          input.displayPath,
          await readWorkspaceFile(input.folderPath, input.displayPath, input.signal),
        );
      } catch {
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "This file cannot currently be read as bounded UTF-8 text.",
          409,
        );
      }
    });
  }

  write(
    deviceId: string,
    workspaceId: string,
    fileId: string,
    value: unknown,
  ): Promise<AidenRemoteFileDocument> {
    const input = parseWrite(value);
    return this.withResolvedFile(deviceId, workspaceId, fileId, async (resolved) => {
      try {
        const document = await writeWorkspaceFile(
          resolved.folderPath,
          resolved.displayPath,
          input.content,
          input.expectedVersion,
          resolved.signal,
        );
        return projectedDocument(fileId, resolved.displayPath, document);
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.code === "changed_on_disk") {
          throw new AidenRemoteServiceError(
            "revision_conflict",
            "This file changed on the desktop. Reload it before saving.",
            409,
          );
        }
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "Aiden could not safely save this file on the desktop.",
          409,
        );
      }
    });
  }
}
