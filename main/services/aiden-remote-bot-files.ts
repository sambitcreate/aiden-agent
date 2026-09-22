import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type {
  AidenRemoteFileDocument,
  AidenRemoteFileEntry,
  AidenRemoteFileIndex,
} from "./aiden-remote-files.js";
import {
  AidenOpaqueHandleError,
  AidenOpaqueHandleStore,
  inspectAidenFilesystemIdentity,
  type AidenOpaqueHandleClaims,
} from "./aiden-remote-opaque-handles.js";
import {
  BotRuntimeAuthorityError,
  type BotRuntimeAuthorityAdmission,
} from "./bot-runtime-authority.js";
import {
  BotArchivedFileReadAuthorityError,
  type BotArchivedFileReadAuthorityPort,
  type BotArchivedFileReadContext,
} from "./bot-archived-file-read-authority.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
  type WorkspaceFileDocument,
  type WorkspaceFileEntry,
} from "./workspace-files.js";
import type { ChatStore } from "./chat-store-core.js";

const FILE_HANDLE_TTL_MS = 10 * 60_000;
const MAX_DISPLAY_PATH_LENGTH = 4_096;
const MAX_WIRE_FILE_SIZE = 5 * 1_048_576;

type BotRuntimeAuthorityPort = {
  admit(input: {
    audienceId: string;
    botId: string;
    chatId: string;
  }): Promise<BotRuntimeAuthorityAdmission>;
};

type BotFileAuthorityContext = Pick<
  BotArchivedFileReadContext,
  | "botId"
  | "chatId"
  | "workspaceId"
  | "workingDirectory"
  | "botPolicy"
  | "chatPolicy"
  | "signal"
  | "revalidateBeforeEffect"
>;

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
      "A Bot file could not be projected safely.",
      409,
    );
  }
  return value;
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

function mapAuthorityError(error: unknown): never {
  if (!(error instanceof BotRuntimeAuthorityError)) throw error;
  if (error.classification === "bot_unavailable" || error.classification === "chat_unavailable") {
    throw new AidenRemoteServiceError(
      "not_found",
      "This Bot conversation is no longer available.",
      404,
    );
  }
  throw new AidenRemoteServiceError(
    "operation_stale",
    "This Bot's file access changed. Refresh the conversation and try again.",
    409,
    true,
  );
}

function mapArchivedAuthorityError(error: unknown): never {
  if (!(error instanceof BotArchivedFileReadAuthorityError)) throw error;
  if (error.classification === "capability_denied") {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "Files are not enabled for this Bot conversation.",
      403,
    );
  }
  throw new AidenRemoteServiceError(
    error.classification === "changed" ? "operation_stale" : "not_found",
    error.classification === "changed"
      ? "This Bot's file access changed. Refresh the conversation and try again."
      : "This Bot conversation is no longer available.",
    error.classification === "changed" ? 409 : 404,
    error.classification === "changed",
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

function requireManagedHome(admission: BotRuntimeAuthorityAdmission): void {
  if (!admission.authority.files.botHome) {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "Files are not enabled for this Bot conversation.",
      403,
    );
  }
}

function authorityPolicyRevision(authority: BotFileAuthorityContext): string {
  return `botfiles_${createHash("sha256")
    .update(JSON.stringify({
      botId: authority.botId,
      chatId: authority.chatId,
      workspaceId: authority.workspaceId,
      botPolicy: authority.botPolicy,
      chatPolicy: authority.chatPolicy,
    }), "utf8")
    .digest("base64url")}`;
}

function authorityRootId(authority: BotFileAuthorityContext): string {
  return `botfiles_${createHash("sha256")
    .update(`${authority.botId}\u0000${authority.chatId}`, "utf8")
    .digest("base64url")}`;
}

/**
 * Remote Bot files are deliberately a separate authority surface from ordinary
 * Workspace files. The managed-home path and Workspace id remain main-only;
 * callers receive only display paths plus device/chat/policy-bound handles.
 */
export class AidenRemoteBotFileService {
  private handleStore: AidenOpaqueHandleStore | undefined;
  private readonly now = (): number => this.options.now?.() ?? Date.now();

  constructor(
    private readonly options: {
      instanceId: string;
      authority: BotRuntimeAuthorityPort;
      archivedRead?: BotArchivedFileReadAuthorityPort;
      chats: Pick<ChatStore, "get">;
      handles?: AidenOpaqueHandleStore;
      now?: () => number;
    },
  ) {}

  private get handles(): AidenOpaqueHandleStore {
    this.handleStore ??= this.options.handles ?? new AidenOpaqueHandleStore({ now: this.now });
    return this.handleStore;
  }

  private activeContext(admission: BotRuntimeAuthorityAdmission): BotFileAuthorityContext {
    return {
      botId: admission.authority.botId,
      chatId: admission.authority.chatId,
      workspaceId: admission.authority.managedHome.workspaceId,
      workingDirectory: admission.authority.workingDirectory,
      botPolicy: admission.authority.botPolicy,
      chatPolicy: admission.authority.chatPolicy,
      signal: admission.signal,
      revalidateBeforeEffect: () => admission.revalidateBeforeEffect(),
    };
  }

  private async withAuthority<Result>(
    deviceId: string,
    botId: string,
    chatId: string,
    access: "read" | "write",
    action: (authority: BotFileAuthorityContext) => Promise<Result>,
  ): Promise<Result> {
    let admission: BotRuntimeAuthorityAdmission | undefined;
    try {
      admission = await this.options.authority.admit({ audienceId: deviceId, botId, chatId });
      requireManagedHome(admission);
      return await action(this.activeContext(admission));
    } catch (error) {
      if (
        error instanceof BotRuntimeAuthorityError &&
        error.classification === "bot_unavailable" &&
        this.options.archivedRead
      ) {
        try {
          return await this.options.archivedRead.run({ botId, chatId }, async (authority) => {
            if (access === "write") {
              throw new AidenRemoteServiceError(
                "bot_archived",
                "Restore this Bot before changing its files.",
                409,
              );
            }
            return action(authority);
          });
        } catch (archivedError) {
          if (archivedError instanceof AidenRemoteServiceError) throw archivedError;
          return mapArchivedAuthorityError(archivedError);
        }
      }
      if (error instanceof AidenRemoteServiceError) throw error;
      return mapAuthorityError(error);
    } finally {
      admission?.release();
    }
  }

  private async botIdForChat(chatId: string): Promise<string> {
    const chat = await this.options.chats.get(chatId);
    if (!chat?.botId) {
      throw new AidenRemoteServiceError(
        "not_found",
        "This Bot conversation is no longer available.",
        404,
      );
    }
    return chat.botId;
  }

  private async claims(
    deviceId: string,
    authority: BotFileAuthorityContext,
    displayPath: string,
    snapshotId: string,
    expiresAt = this.now() + FILE_HANDLE_TTL_MS,
  ): Promise<AidenOpaqueHandleClaims> {
    const identity = await inspectAidenFilesystemIdentity(
      authority.workingDirectory,
      path.join(authority.workingDirectory, displayPath),
    );
    return {
      instanceId: this.options.instanceId,
      deviceId,
      workspaceId: authority.workspaceId,
      rootId: authorityRootId(authority),
      policyRevision: authorityPolicyRevision(authority),
      ...identity,
      displayPath,
      snapshotId,
      expiresAt,
    };
  }

  async list(deviceId: string, chatId: string): Promise<AidenRemoteFileIndex> {
    const botId = await this.botIdForChat(chatId);
    return this.withAuthority(deviceId, botId, chatId, "read", async (authority) => {
      try {
        await authority.revalidateBeforeEffect();
        const index = await listWorkspaceFiles(authority.workingDirectory, authority.signal);
        const snapshotId = `files_${randomBytes(24).toString("base64url")}`;
        const entries: AidenRemoteFileEntry[] = [];
        let omitted = false;
        for (const entry of index.entries) {
          if (authority.signal.aborted) {
            throw authority.signal.reason instanceof Error
              ? authority.signal.reason
              : new Error("Bot access changed while files were loading.");
          }
          try {
            const displayPath = safeDisplayPath(entry.path);
            await authority.revalidateBeforeEffect();
            const claims = await this.claims(deviceId, authority, displayPath, snapshotId);
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
            if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
            if (error instanceof BotArchivedFileReadAuthorityError) {
              mapArchivedAuthorityError(error);
            }
            omitted = true;
          }
        }
        return {
          snapshotId,
          entries,
          truncated: index.truncated || omitted,
          maxEntries: 4_000,
          maxDepth: 20,
        };
      } catch (error) {
        if (error instanceof AidenRemoteServiceError) throw error;
        if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
        if (error instanceof BotArchivedFileReadAuthorityError) mapArchivedAuthorityError(error);
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "This Bot's files are not currently available on the Mac.",
          409,
        );
      }
    });
  }

  private async withResolvedFile<T>(
    deviceId: string,
    chatId: string,
    fileId: string,
    access: "read" | "write",
    operation: (input: {
      folderPath: string;
      displayPath: string;
      signal: AbortSignal;
    }) => Promise<T>,
  ): Promise<T> {
    let stored: AidenOpaqueHandleClaims;
    try {
      stored = this.handles.claimsFor(fileId, "file");
    } catch (error) {
      mapHandleError(error);
    }
    const botId = await this.botIdForChat(chatId);
    return this.withAuthority(deviceId, botId, chatId, access, async (authority) => {
      try {
        if (!stored.displayPath) throw new AidenOpaqueHandleError("handle_invalid");
        const displayPath = safeDisplayPath(stored.displayPath);
        await authority.revalidateBeforeEffect();
        const current = await this.claims(
          deviceId,
          authority,
          displayPath,
          stored.snapshotId ?? "",
          stored.expiresAt,
        );
        this.handles.resolve(fileId, "file", current);
        await authority.revalidateBeforeEffect();
        return await operation({
          folderPath: authority.workingDirectory,
          displayPath,
          signal: authority.signal,
        });
      } catch (error) {
        if (error instanceof AidenOpaqueHandleError) mapHandleError(error);
        if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
        if (error instanceof BotArchivedFileReadAuthorityError) mapArchivedAuthorityError(error);
        throw error;
      }
    });
  }

  read(
    deviceId: string,
    chatId: string,
    fileId: string,
  ): Promise<AidenRemoteFileDocument> {
    return this.withResolvedFile(deviceId, chatId, fileId, "read", async (input) => {
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
    chatId: string,
    fileId: string,
    value: unknown,
  ): Promise<AidenRemoteFileDocument> {
    const input = parseWrite(value);
    return this.withResolvedFile(deviceId, chatId, fileId, "write", async (resolved) => {
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
            "This file changed on the Mac. Reload it before saving.",
            409,
          );
        }
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "Aiden could not safely save this file on the Mac.",
          409,
        );
      }
    });
  }
}
