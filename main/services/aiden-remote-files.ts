import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { lstat, stat } from "node:fs/promises";
import type { Workspace } from "./types.js";
import { readConfinedWorkspaceFile, editConfinedWorkspaceFile, ManagedWorktreeFileIoError,
  type ConfinedWorkspaceFileIdentity } from "./managed-worktree-file-io.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  FILE_HANDLE_TTL_MS,
  languageFor,
  mapSnapshotReadError,
  mapSnapshotWriteError,
  parseWrite,
  projectedFileEntry,
  projectedFileIndex,
  readSnapshotFile,
  safeDisplayPath,
  writeSnapshotFile,
  type AidenRemoteFileDocument,
  type AidenRemoteFileEntry,
  type AidenRemoteFileIndex,
} from "./aiden-remote-file-helpers.js";
import {
  AidenOpaqueHandleError,
  AidenOpaqueHandleStore,
  inspectAidenFilesystemIdentity,
  mapAidenOpaqueHandleError,
  type AidenOpaqueHandleClaims,
} from "./aiden-remote-opaque-handles.js";
import { mapWorkspaceMetadata, WORKSPACE_METADATA_CONCURRENCY } from "./workspace-metadata.js";
import { projectAidenRemoteWorkspace } from "./aiden-remote-workspaces.js";
import type { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import type { WorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import {
  listWorkspaceFiles,
  listWorkspaceDirectory,
  decodeWorkspaceFileText,
  type WorkspaceFileEntry,
} from "./workspace-files.js";

export type {
  AidenRemoteFileDocument,
  AidenRemoteFileEntry,
  AidenRemoteFileIndex,
} from "./aiden-remote-file-helpers.js";

export class AidenRemoteFileService {
  private readonly pages = new Map<string, {
    scope: string;
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

  /**
   * Admits the configured root for one request. Every lazy handle and cursor
   * carries the root identity it was issued under and is refused once that
   * root is replaced, so a folder re-created at the same path (re-clone,
   * restore, remount) lists afresh without reviving any earlier handle.
   */
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
    return { path: folderPath, device: current.dev.toString(), inode: current.ino.toString() };
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
        const listing = `${deviceId}\u0000${workspaceId}`;
        this.handles.supersedeListing(listing);
        const snapshotId = `files_${randomBytes(24).toString("base64url")}`;
        const revision = projectAidenRemoteWorkspace(workspace).revision;
        const entries: AidenRemoteFileEntry[] = [];
        let omitted = false;
        for (let offset = 0; offset < index.entries.length; offset += WORKSPACE_METADATA_CONCURRENCY) {
          // Re-inspect every identity; index metadata is not handle authority.
          // Only metadata runs concurrently. Issue handles in index order after
          // the entire batch settles and cancellation has been checked.
          const inspected = await mapWorkspaceMetadata(
            index.entries.slice(offset, offset + WORKSPACE_METADATA_CONCURRENCY),
            async (entry) => {
              try {
                const displayPath = safeDisplayPath(entry.path, "workspace");
                const claims = await this.claims(
                  deviceId, workspaceId, folderPath, revision, displayPath, snapshotId,
                );
                return { entry, displayPath, claims };
              } catch {
                omitted = true;
                return undefined;
              }
            },
            signal,
          );
          for (const result of inspected) {
            if (!result) continue;
            const { entry, displayPath, claims } = result;
            try {
              entries.push(
                projectedFileEntry(
                  this.handles.issue("file", claims, { listing }),
                  displayPath,
                  entry,
                ),
              );
            } catch (error) {
              if (error instanceof AidenOpaqueHandleError && error.code === "handle_capacity") {
                mapAidenOpaqueHandleError(error, "file");
              }
              omitted = true;
            }
          }
        }
        return projectedFileIndex(snapshotId, entries, index.truncated || omitted);
      },
    ).catch((error: unknown) => {
      if (error instanceof AidenRemoteServiceError) throw error;
      throw new AidenRemoteServiceError(
        "workspace_unavailable",
        "This workspace's files are not currently available on your computer.",
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
    const batch = this.handles.beginBatch([directoryId, cursor]);
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
            this.handles.resolve(directoryId, "file", current, { navigation: true });
            directoryPath = stored.displayPath;
            directoryClaims = stored;
          }
          const directoryIdentity = directoryClaims
            ? { device: directoryClaims.filesystemDevice, inode: directoryClaims.filesystemInode }
            : rootIdentity;
          const lazyScope = `lazy\u0000${deviceId}\u0000${workspaceId}\u0000${rootIdentity.device}:${rootIdentity.inode}\u0000${directoryIdentity.device}:${directoryIdentity.inode}`;
          for (const [key, value] of this.pages) {
            if (value.claims.expiresAt <= this.now()) {
              this.pages.delete(key);
              this.handles.retireGeneration(key);
            }
          }
          let snapshotId: string;
          let offset = 0;
          let snapshot: { claims: AidenOpaqueHandleClaims; entries: WorkspaceFileEntry[]; truncated: boolean };
          let isFreshListing = false;
          if (cursor) {
            const stored = this.handles.claimsFor(cursor, "cur");
            if (stored.workspaceId !== workspaceId || stored.displayPath !== directoryPath) {
              throw new AidenOpaqueHandleError("handle_invalid");
            }
            const current = await this.claims(deviceId, workspaceId, folderPath, revision, directoryPath, stored.snapshotId ?? "");
            current.cursorOffset = stored.cursorOffset;
            current.confinedRootDevice = rootIdentity.device;
            current.confinedRootInode = rootIdentity.inode;
            this.handles.resolve(cursor, "cur", current, { navigation: true });
            snapshotId = stored.snapshotId!;
            const cached = this.pages.get(snapshotId);
            if (!cached || cached.claims.expiresAt <= this.now()) {
              if (cached) {
                this.pages.delete(snapshotId);
                this.handles.retireGeneration(snapshotId);
              }
              throw new AidenOpaqueHandleError("handle_expired");
            }
            snapshot = cached;
            offset = stored.cursorOffset!;
          } else {
            snapshotId = `files_${randomBytes(24).toString("base64url")}`;
            const claims = directoryClaims
              ? { ...directoryClaims, snapshotId, expiresAt: this.now() + FILE_HANDLE_TTL_MS }
              : { ...await this.claims(deviceId, workspaceId, folderPath, revision, directoryPath, snapshotId),
                  canonicalRootPath: rootIdentity.path, canonicalPath: rootIdentity.path,
                  filesystemDevice: rootIdentity.device, filesystemInode: rootIdentity.inode,
                  confinedRootDevice: rootIdentity.device, confinedRootInode: rootIdentity.inode };
            const index = await listWorkspaceDirectory(folderPath, directoryPath, signal, {
              root: rootIdentity,
              directory: directoryIdentity,
            });
            if (signal.aborted) throw new Error("Cancelled");
            for (const [key, value] of this.pages) {
              if (value.scope === lazyScope) {
                this.pages.delete(key);
                this.handles.retireGeneration(key);
              }
            }
            this.handles.supersedeListing(lazyScope);
            snapshot = { claims, entries: index.entries, truncated: index.truncated };
            isFreshListing = true;
          }
          const entries: AidenRemoteFileEntry[] = [];
          let omitted = false;
          for (const entry of snapshot.entries.slice(offset, offset + 200)) {
            if (signal.aborted) throw new Error("Cancelled");
            try {
              const displayPath = safeDisplayPath(entry.path, "workspace");
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
              entries.push({
                id: batch.issue("file", claims, { listing: lazyScope, generation: snapshotId, lazyPage: true }),
                displayPath,
                name: entry.name,
                kind: entry.kind,
                ...(languageFor(entry) ? { language: languageFor(entry) } : {}),
              });
            } catch (error) {
              if (error instanceof AidenOpaqueHandleError && error.code === "handle_capacity") throw error;
              omitted = true;
            }
          }
          const nextOffset = offset + 200;
          const nextCursor = nextOffset < snapshot.entries.length
            ? batch.issue("cur", { ...snapshot.claims, cursorOffset: nextOffset }, { listing: lazyScope, generation: snapshotId, lazyPage: true })
            : undefined;
          const after = await this.assertRoot(workspace, folderPath);
          if (after.device !== rootIdentity.device || after.inode !== rootIdentity.inode) {
            throw new AidenOpaqueHandleError("filesystem_identity_changed");
          }
          if (nextCursor) {
            if (isFreshListing) {
              // Evict the oldest abandoned inventory; its cursor fails closed as expired and its generation is retired.
              if (this.pages.size >= 16) {
                const evicted = this.pages.keys().next().value!;
                this.pages.delete(evicted);
                this.handles.retireGeneration(evicted);
              }
              this.pages.set(snapshotId, { scope: lazyScope, ...snapshot });
            }
          } else {
            // Completed pages do not retain directory inventories in server memory.
            this.pages.delete(snapshotId);
          }
          batch.commit();
          return { snapshotId, entries, truncated: snapshot.truncated || omitted,
            maxEntries: 4_000, maxDepth: 20, directoryPath, ...(nextCursor ? { nextCursor } : {}) };
        },
      );
    } catch (error) {
      if (error instanceof AidenOpaqueHandleError) mapAidenOpaqueHandleError(error, "file");
      if (error instanceof AidenRemoteServiceError) throw error;
      throw new AidenRemoteServiceError("workspace_unavailable", "This folder cannot currently be listed. Refresh Files and try again.", 409);
    } finally {
      batch.dispose();
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
    const release = this.handles.pin(fileId);
    try {
      let stored: AidenOpaqueHandleClaims;
      try {
        stored = this.handles.claimsFor(fileId, "file");
      } catch (error) {
        mapAidenOpaqueHandleError(error, "file");
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
            return await operation({ folderPath, displayPath: stored.displayPath, signal, confinement, claims: stored });
          },
        );
      } catch (error) {
        if (error instanceof AidenOpaqueHandleError) mapAidenOpaqueHandleError(error, "file");
        throw error;
      }
    } finally {
      release();
    }
  }

  read(deviceId: string, workspaceId: string, fileId: string): Promise<AidenRemoteFileDocument> {
    return this.withResolvedFile(deviceId, workspaceId, fileId, async (input) => {
      if (!input.confinement) {
        return readSnapshotFile({
          fileId,
          folderPath: input.folderPath,
          displayPath: input.displayPath,
          signal: input.signal,
          identity: { device: input.claims.filesystemDevice, inode: input.claims.filesystemInode },
        });
      }
      try {
        const buffer = await readConfinedWorkspaceFile(input.confinement, input.displayPath, input.signal);
        return { id: fileId, displayPath: input.displayPath, content: decodeWorkspaceFileText(buffer, input.displayPath),
          version: createHash("sha256").update(buffer).digest("hex"), truncated: false };
      } catch {
        mapSnapshotReadError();
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
      if (!resolved.confinement) {
        return writeSnapshotFile({
          handles: this.handles,
          fileId,
          folderPath: resolved.folderPath,
          displayPath: resolved.displayPath,
          content: input.content,
          expectedVersion: input.expectedVersion,
          signal: resolved.signal,
        });
      }
      try {
        const buffer = Buffer.from(input.content, "utf8");
        decodeWorkspaceFileText(buffer, resolved.displayPath);
        const id = this.handles.issue("file", { ...resolved.claims, expiresAt: this.now() + FILE_HANDLE_TTL_MS }, { protectedDocument: true });
        try {
          const saved = await editConfinedWorkspaceFile(resolved.confinement, resolved.displayPath, buffer, input.expectedVersion, resolved.signal);
          this.handles.updateReservedFileIdentity(id, saved.device, saved.inode);
          return { id, displayPath: resolved.displayPath, content: input.content,
            version: createHash("sha256").update(buffer).digest("hex"), truncated: false,
            warning: `Saved your draft. The previous version remains at ${saved.recoveryName}. Up to 16 recovery copies are retained per folder; review and remove them on your computer when no longer needed.` };
        } catch (error) {
          this.handles.discard(id);
          throw error;
        }
      } catch (error) {
        if (error instanceof ManagedWorktreeFileIoError && error.code === "recovery_limit") {
          throw new AidenRemoteServiceError("workspace_unavailable", "Review and remove unneeded .aiden-recovery files in this folder on your computer before saving again.", 409);
        }
        if (error instanceof ManagedWorktreeFileIoError && ["source_changed", "destination_exists"].includes(error.code)) {
          throw new AidenRemoteServiceError(
            "revision_conflict",
            "This file changed on your computer. Reload it before saving.",
            409,
          );
        }
        mapSnapshotWriteError(error);
      }
    });
  }
}
