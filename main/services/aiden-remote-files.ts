import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { lstat, stat } from "node:fs/promises";
import type { Workspace } from "./types.js";
import { readConfinedWorkspaceFile, editConfinedWorkspaceFile, ManagedWorktreeFileIoError,
  type ConfinedWorkspaceFileIdentity } from "./managed-worktree-file-io.js";
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
  listWorkspaceDirectory,
  decodeWorkspaceFileText,
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
  directoryPath?: string;
  nextCursor?: string;
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
  private readonly roots = new Map<string, { configuredPath: string; canonicalPath: string; device: string; inode: string }>();
  private readonly pages = new Map<string, {
    claims: AidenOpaqueHandleClaims;
    entries: WorkspaceFileEntry[];
    truncated: boolean;
  }>();
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

  private async assertRoot(workspace: Workspace, folderPath: string): Promise<{ path: string; device: string; inode: string }> {
    if (!workspace.folderPath) throw new AidenOpaqueHandleError("root_policy_changed");
    // macOS system aliases are fixed; all workspace-controlled ancestors must
    // already be canonical. The native helper separately walks without links.
    const configuredPath = path.resolve(workspace.folderPath).replace(/^\/(tmp|var|etc)(?=\/|$)/u, "/private/$1");
    if (configuredPath !== folderPath) throw new AidenOpaqueHandleError("filesystem_identity_changed");
    const configured = await lstat(configuredPath, { bigint: true });
    const current = await stat(folderPath, { bigint: true });
    if (!configured.isDirectory() || configured.isSymbolicLink() ||
        configured.dev !== current.dev || configured.ino !== current.ino) {
      throw new AidenOpaqueHandleError("filesystem_identity_changed");
    }
    const identity = { configuredPath: workspace.folderPath, canonicalPath: folderPath,
      device: current.dev.toString(), inode: current.ino.toString() };
    const previous = this.roots.get(workspace.id);
    if (previous && previous.configuredPath === identity.configuredPath &&
        (previous.canonicalPath !== identity.canonicalPath || previous.device !== identity.device || previous.inode !== identity.inode)) {
      throw new AidenOpaqueHandleError("filesystem_identity_changed");
    }
    if (!previous && this.roots.size >= 1_024) throw new AidenOpaqueHandleError("handle_capacity");
    this.roots.set(workspace.id, identity);
    return { path: identity.canonicalPath, device: identity.device, inode: identity.inode };
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

  async children(
    deviceId: string,
    workspaceId: string,
    directoryId?: string,
    cursor?: string,
  ): Promise<AidenRemoteFileIndex> {
    if (process.platform !== "darwin") throw new AidenRemoteServiceError("not_found", "Lazy workspace files require the Mac directory helper.", 404);
    try {
      return await this.options.application.run(
        this.options.owners.owner(deviceId), workspaceId,
        async ({ folderPath, workspace }, signal) => {
          const rootIdentity = await this.assertRoot(workspace, folderPath);
          const revision = projectAidenRemoteWorkspace(workspace).revision;
          let directoryPath = "";
          let directoryClaims: AidenOpaqueHandleClaims | undefined;
          if (directoryId) {
            const stored = this.handles.claimsFor(directoryId, "file");
            if (stored.workspaceId !== workspaceId || stored.kind !== "directory" || !stored.displayPath) {
              throw new AidenOpaqueHandleError("handle_invalid");
            }
            const current = await this.claims(deviceId, workspaceId, folderPath, revision, stored.displayPath, stored.snapshotId ?? "");
            current.confinedRootDevice = rootIdentity.device;
            current.confinedRootInode = rootIdentity.inode;
            this.handles.resolve(directoryId, "file", current);
            directoryPath = stored.displayPath;
            directoryClaims = stored;
          }
          let snapshotId: string;
          let offset = 0;
          let snapshot: { claims: AidenOpaqueHandleClaims; entries: WorkspaceFileEntry[]; truncated: boolean };
          if (cursor) {
            const stored = this.handles.claimsFor(cursor, "cur");
            if (stored.workspaceId !== workspaceId || stored.displayPath !== directoryPath) {
              throw new AidenOpaqueHandleError("handle_invalid");
            }
            const current = await this.claims(deviceId, workspaceId, folderPath, revision, directoryPath, stored.snapshotId ?? "");
            current.cursorOffset = stored.cursorOffset;
            current.confinedRootDevice = rootIdentity.device;
            current.confinedRootInode = rootIdentity.inode;
            this.handles.resolve(cursor, "cur", current);
            snapshotId = stored.snapshotId!;
            const cached = this.pages.get(snapshotId);
            if (!cached || cached.claims.expiresAt <= this.now()) throw new AidenOpaqueHandleError("handle_expired");
            snapshot = cached;
            offset = stored.cursorOffset!;
          } else {
            for (const [key, value] of this.pages) {
              if (value.claims.expiresAt <= this.now()) this.pages.delete(key);
            }
            // Evict the oldest abandoned inventory; its cursor fails closed as expired.
            if (this.pages.size >= 16) this.pages.delete(this.pages.keys().next().value!);
            snapshotId = `files_${randomBytes(24).toString("base64url")}`;
            const claims = directoryClaims
              ? { ...directoryClaims, snapshotId, expiresAt: this.now() + FILE_HANDLE_TTL_MS }
              : { ...await this.claims(deviceId, workspaceId, folderPath, revision, directoryPath, snapshotId),
                  canonicalRootPath: rootIdentity.path, canonicalPath: rootIdentity.path,
                  filesystemDevice: rootIdentity.device, filesystemInode: rootIdentity.inode,
                  confinedRootDevice: rootIdentity.device, confinedRootInode: rootIdentity.inode };
            const index = await listWorkspaceDirectory(folderPath, directoryPath, signal, {
              root: rootIdentity,
              directory: directoryClaims
                ? { device: directoryClaims.filesystemDevice, inode: directoryClaims.filesystemInode }
                : rootIdentity,
            });
            snapshot = { claims, entries: index.entries, truncated: index.truncated };
            this.pages.set(snapshotId, snapshot);
          }
          const entries: AidenRemoteFileEntry[] = [];
          let omitted = false;
          for (const entry of snapshot.entries.slice(offset, offset + 200)) {
            if (signal.aborted) throw new Error("Cancelled");
            try {
              const displayPath = safeDisplayPath(entry.path);
              if (!entry.filesystemDevice || !entry.filesystemInode) throw new AidenOpaqueHandleError("handle_invalid");
              const claims: AidenOpaqueHandleClaims = {
                instanceId: this.options.instanceId, deviceId, workspaceId, rootId: workspaceId,
                policyRevision: revision, canonicalRootPath: rootIdentity.path,
                canonicalPath: path.join(rootIdentity.path, displayPath),
                filesystemDevice: entry.filesystemDevice, filesystemInode: entry.filesystemInode,
                confinedRootDevice: rootIdentity.device, confinedRootInode: rootIdentity.inode,
                kind: entry.kind === "directory" ? "directory" : "file", displayPath,
                snapshotId, expiresAt: snapshot.claims.expiresAt,
              };
              entries.push({ id: this.handles.issue("file", claims), displayPath, name: entry.name, kind: entry.kind,
                ...(languageFor(entry) ? { language: languageFor(entry) } : {}) });
            } catch (error) {
              if (error instanceof AidenOpaqueHandleError && error.code === "handle_capacity") throw error;
              omitted = true;
            }
          }
          const nextOffset = offset + 200;
          const nextCursor = nextOffset < snapshot.entries.length
            ? this.handles.issue("cur", { ...snapshot.claims, cursorOffset: nextOffset }) : undefined;
          // Completed pages do not retain directory inventories in server memory.
          if (!nextCursor) this.pages.delete(snapshotId);
          await this.assertRoot(workspace, folderPath);
          return { snapshotId, entries, truncated: snapshot.truncated || omitted,
            maxEntries: 4_000, maxDepth: 20, directoryPath, ...(nextCursor ? { nextCursor } : {}) };
        },
      );
    } catch (error) {
      if (error instanceof AidenOpaqueHandleError) mapHandleError(error);
      if (error instanceof AidenRemoteServiceError) throw error;
      throw new AidenRemoteServiceError("workspace_unavailable", "This folder cannot currently be listed. Refresh Files and try again.", 409);
    }
  }

  private async withResolvedFile<T>(
    deviceId: string,
    workspaceId: string,
    fileId: string,
    operation: (
      input: { folderPath: string; displayPath: string; signal: AbortSignal; confinement?: ConfinedWorkspaceFileIdentity; claims: AidenOpaqueHandleClaims },
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
          let confinement: ConfinedWorkspaceFileIdentity | undefined;
          if (stored.confinedRootDevice && stored.confinedRootInode) {
            const root = await this.assertRoot(workspace, folderPath);
            if (root.device !== stored.confinedRootDevice || root.inode !== stored.confinedRootInode || root.path !== stored.canonicalRootPath) {
              throw new AidenOpaqueHandleError("filesystem_identity_changed");
            }
            confinement = { root, file: { device: stored.filesystemDevice, inode: stored.filesystemInode } };
          }
          const current = confinement ? {
            ...stored, instanceId: this.options.instanceId, deviceId, workspaceId,
            policyRevision: projectAidenRemoteWorkspace(workspace).revision,
          } : await this.claims(
            deviceId, workspaceId, folderPath, projectAidenRemoteWorkspace(workspace).revision,
            stored.displayPath, stored.snapshotId ?? "",
          );
          current.expiresAt = stored.expiresAt;
          this.handles.resolve(fileId, "file", current);
          return operation({ folderPath, displayPath: stored.displayPath, signal, confinement, claims: stored });
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
        if (input.confinement) {
          const buffer = await readConfinedWorkspaceFile(input.confinement, input.displayPath, input.signal);
          return { id: fileId, displayPath: input.displayPath, content: decodeWorkspaceFileText(buffer, input.displayPath),
            version: createHash("sha256").update(buffer).digest("hex"), truncated: false };
        }
        return projectedDocument(
          fileId,
          input.displayPath,
          await readWorkspaceFile(input.folderPath, input.displayPath, input.signal, {
            exclusiveIdentity: { device: input.claims.filesystemDevice, inode: input.claims.filesystemInode },
          }),
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
        if (resolved.confinement) {
          const buffer = Buffer.from(input.content, "utf8");
          decodeWorkspaceFileText(buffer, resolved.displayPath);
          const id = this.handles.issue("file", { ...resolved.claims, expiresAt: this.now() + FILE_HANDLE_TTL_MS });
          try {
            const saved = await editConfinedWorkspaceFile(resolved.confinement, resolved.displayPath, buffer, input.expectedVersion, resolved.signal);
            this.handles.updateReservedFileIdentity(id, saved.device, saved.inode);
            return { id, displayPath: resolved.displayPath, content: input.content,
              version: createHash("sha256").update(buffer).digest("hex"), truncated: false,
              warning: `Saved your draft. The previous version remains at ${saved.recoveryName}. Up to 16 recovery copies are retained per folder; review and remove them on the Mac when no longer needed.` };
          } catch (error) {
            this.handles.discard(id);
            throw error;
          }
        }
        const document = await writeWorkspaceFile(
          resolved.folderPath,
          resolved.displayPath,
          input.content,
          input.expectedVersion,
          resolved.signal,
        );
        return projectedDocument(fileId, resolved.displayPath, document);
      } catch (error) {
        if (error instanceof ManagedWorktreeFileIoError && error.code === "recovery_limit") {
          throw new AidenRemoteServiceError("workspace_unavailable", "Review and remove unneeded .aiden-recovery files in this folder on the Mac before saving again.", 409);
        }
        if ((error instanceof WorkspaceFileError && error.code === "changed_on_disk") ||
            (error instanceof ManagedWorktreeFileIoError && ["source_changed", "destination_exists"].includes(error.code))) {
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
