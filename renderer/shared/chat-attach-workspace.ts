// Shared contracts for inspecting scratch files and attaching a No workspace
// or ephemeral chat in-place to a real project workspace.

export interface AttachScratchFileEntry {
  /** POSIX-style path relative to the chat's private scratch folder. */
  relativePath: string;
  sizeBytes: number;
  isDirectory: boolean;
}

export interface InspectAttachFilesResult {
  hasFiles: boolean;
  totalBytes: number;
  truncated: boolean;
  entries: AttachScratchFileEntry[];
}

export type AttachFileAction = "trash" | "copy";

export interface AttachToWorkspaceRequest {
  chatId: string;
  targetWorkspaceId: string;
  fileAction?: AttachFileAction;
}

export interface AttachToWorkspaceResult<ChatRecord = unknown> {
  chat: ChatRecord;
  copiedPaths: string[];
  oldWorkspaceId: string;
}

const ATTACH_KEYS = new Set(["chatId", "targetWorkspaceId", "fileAction"]);

export function parseAttachToWorkspaceRequest(input: unknown): AttachToWorkspaceRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid workspace attach request.");
  }
  const record = input as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (!ATTACH_KEYS.has(key)) throw new Error("Invalid workspace attach fields.");
  }
  if (typeof record.chatId !== "string" || !record.chatId.trim()) {
    throw new Error('Expected a non-empty string for "chatId".');
  }
  if (typeof record.targetWorkspaceId !== "string" || !record.targetWorkspaceId.trim()) {
    throw new Error('Expected a non-empty string for "targetWorkspaceId".');
  }
  let fileAction: AttachFileAction | undefined;
  if (record.fileAction !== undefined) {
    if (record.fileAction !== "trash" && record.fileAction !== "copy") {
      throw new Error('Expected "trash" or "copy" for "fileAction".');
    }
    fileAction = record.fileAction;
  }
  return {
    chatId: record.chatId,
    targetWorkspaceId: record.targetWorkspaceId,
    ...(fileAction ? { fileAction } : {}),
  };
}
