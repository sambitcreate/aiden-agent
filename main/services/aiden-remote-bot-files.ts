import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { mapWorkspaceMetadata } from "./workspace-metadata.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  FILE_HANDLE_TTL_MS,
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
import {
  BotRuntimeAuthorityError,
  type BotRuntimeAuthorityAdmission,
} from "./bot-runtime-authority.js";
import { listWorkspaceFiles } from "./workspace-files.js";
import type { ChatStore } from "./chat-store-core.js";

type BotRuntimeAuthorityPort = {
  admit(input: {
    audienceId: string;
    botId: string;
    chatId: string;
  }): Promise<BotRuntimeAuthorityAdmission>;
};

type BotFileAuthorityContext = {
  botId: string;
  chatId: string;
  workspaceId: string;
  workingDirectory: string;
  botPolicy: Readonly<{ revision: string; epoch: string }>;
  chatPolicy: Readonly<{ revision: string; epoch: string }>;
  signal: AbortSignal;
  revalidateBeforeEffect(): Promise<void>;
};

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
      /**
       * The audience Bot authority is admitted for: the Mac owner, as the Bot
       * session that writes these files runs. A paired device never accepts
       * its own Full Access notice, so admitting as the device would deny
       * every device paired after that notice was retired. The device stays
       * bound to every handle it receives.
       */
      botAudienceId: string;
      authority: BotRuntimeAuthorityPort;
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
    botId: string,
    chatId: string,
    action: (authority: BotFileAuthorityContext) => Promise<Result>,
  ): Promise<Result> {
    let admission: BotRuntimeAuthorityAdmission | undefined;
    try {
      admission = await this.options.authority.admit({
        audienceId: this.options.botAudienceId,
        botId,
        chatId,
      });
      requireManagedHome(admission);
      return await action(this.activeContext(admission));
    } catch (error) {
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
    return this.withAuthority(botId, chatId, async (authority) => {
      try {
        await authority.revalidateBeforeEffect();
        const index = await listWorkspaceFiles(authority.workingDirectory, authority.signal);
        const listing = `${deviceId}\u0000${chatId}`;
        this.handles.supersedeListing(listing);
        const snapshotId = `files_${randomBytes(24).toString("base64url")}`;
        const entries: AidenRemoteFileEntry[] = [];
        let omitted = false;
        for (const entry of index.entries) {
          // Bot policy revalidation stays serial and runs only after admission.
          // Share the same budget as workspace/Gemini/legacy file listings.
          const [inspected] = await mapWorkspaceMetadata([entry], async () => {
            try {
              const displayPath = safeDisplayPath(entry.path, "bot");
              await authority.revalidateBeforeEffect();
              const claims = await this.claims(deviceId, authority, displayPath, snapshotId);
              return { displayPath, claims };
            } catch (error) {
              if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
              return undefined;
            }
          }, authority.signal);
          if (!inspected) {
            omitted = true;
            continue;
          }
          const { displayPath, claims } = inspected;
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
            if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
            omitted = true;
          }
        }
        return projectedFileIndex(snapshotId, entries, index.truncated || omitted);
      } catch (caught) {
        const error = authority.signal.aborted && authority.signal.reason instanceof Error
          ? authority.signal.reason : caught;
        if (error instanceof AidenRemoteServiceError) throw error;
        if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
        throw new AidenRemoteServiceError(
          "workspace_unavailable",
          "This Bot's files are not currently available on your computer.",
          409,
        );
      }
    });
  }

  private async withResolvedFile<T>(
    deviceId: string,
    chatId: string,
    fileId: string,
    operation: (input: {
      folderPath: string;
      displayPath: string;
      signal: AbortSignal;
      identity: { device: string; inode: string };
    }) => Promise<T>,
  ): Promise<T> {
    const release = this.handles.pin(fileId);
    try {
      let stored: AidenOpaqueHandleClaims;
      try {
        stored = this.handles.claimsFor(fileId, "file");
      } catch (error) {
        mapAidenOpaqueHandleError(error, "file");
      }
      const botId = await this.botIdForChat(chatId);
      return await this.withAuthority(botId, chatId, async (authority) => {
        try {
          if (!stored.displayPath) throw new AidenOpaqueHandleError("handle_invalid");
          const displayPath = safeDisplayPath(stored.displayPath, "bot");
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
            identity: { device: current.filesystemDevice, inode: current.filesystemInode },
          });
        } catch (error) {
          if (error instanceof AidenOpaqueHandleError) mapAidenOpaqueHandleError(error, "file");
          if (error instanceof BotRuntimeAuthorityError) mapAuthorityError(error);
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  read(
    deviceId: string,
    chatId: string,
    fileId: string,
  ): Promise<AidenRemoteFileDocument> {
    return this.withResolvedFile(deviceId, chatId, fileId, (input) =>
      readSnapshotFile({
        fileId,
        folderPath: input.folderPath,
        displayPath: input.displayPath,
        signal: input.signal,
        identity: input.identity,
      }),
    );
  }

  write(
    deviceId: string,
    chatId: string,
    fileId: string,
    value: unknown,
  ): Promise<AidenRemoteFileDocument> {
    const input = parseWrite(value);
    return this.withResolvedFile(deviceId, chatId, fileId, (resolved) =>
      writeSnapshotFile({
        handles: this.handles,
        fileId,
        folderPath: resolved.folderPath,
        displayPath: resolved.displayPath,
        content: input.content,
        expectedVersion: input.expectedVersion,
        signal: resolved.signal,
      }),
    );
  }
}
