import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  rebindAidenFileHandleToSavedFile,
  type AidenOpaqueHandleStore,
} from "./aiden-remote-opaque-handles.js";
import {
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFileInstalling,
  type WorkspaceFileDocument,
  type WorkspaceFileEntry,
} from "./workspace-files.js";

export const FILE_HANDLE_TTL_MS = 10 * 60_000;
export const MAX_DISPLAY_PATH_LENGTH = 4_096;
export const MAX_WIRE_FILE_SIZE = 5 * 1_048_576;

export type AidenRemoteFileScope = "bot" | "workspace";

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

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["c", "C"],
  ["cc", "C++"],
  ["cpp", "C++"],
  ["css", "CSS"],
  ["go", "Go"],
  ["h", "C Header"],
  ["html", "HTML"],
  ["java", "Java"],
  ["js", "JavaScript"],
  ["json", "JSON"],
  ["jsx", "JSX"],
  ["kt", "Kotlin"],
  ["md", "Markdown"],
  ["mjs", "JavaScript"],
  ["py", "Python"],
  ["rb", "Ruby"],
  ["rs", "Rust"],
  ["sh", "Shell"],
  ["swift", "Swift"],
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["yaml", "YAML"],
  ["yml", "YAML"],
]);

export function languageFor(entry: WorkspaceFileEntry): string | undefined {
  if (entry.kind !== "file") return undefined;
  const extension = path.extname(entry.name).slice(1).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension);
}

export function safeDisplayPath(value: string, scope: AidenRemoteFileScope): string {
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
      scope === "bot"
        ? "A Bot file could not be projected safely."
        : "A workspace file could not be projected safely.",
      409,
    );
  }
  return value;
}

export function parseWrite(value: unknown): { content: string; expectedVersion: string } {
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

export function projectedDocument(
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

export function projectedFileEntry(
  id: string,
  displayPath: string,
  entry: WorkspaceFileEntry,
): AidenRemoteFileEntry {
  const language = languageFor(entry);
  return {
    id,
    displayPath,
    name: [...entry.name].slice(0, 255).join(""),
    kind: entry.kind,
    ...(entry.size !== undefined && entry.size <= MAX_WIRE_FILE_SIZE
      ? { size: entry.size }
      : {}),
    ...(language ? { language } : {}),
  };
}

export function projectedFileIndex(
  snapshotId: string,
  entries: AidenRemoteFileEntry[],
  truncated: boolean,
): AidenRemoteFileIndex {
  return {
    snapshotId,
    entries,
    truncated,
    maxEntries: 4_000,
    maxDepth: 20,
  };
}

export function mapSnapshotReadError(): never {
  throw new AidenRemoteServiceError(
    "workspace_unavailable",
    "This file cannot currently be read as bounded UTF-8 text.",
    409,
  );
}

export async function readSnapshotFile(input: {
  fileId: string;
  folderPath: string;
  displayPath: string;
  signal: AbortSignal;
  identity: { device: string; inode: string };
}): Promise<AidenRemoteFileDocument> {
  try {
    return projectedDocument(
      input.fileId,
      input.displayPath,
      await readWorkspaceFile(input.folderPath, input.displayPath, input.signal, {
        exclusiveIdentity: input.identity,
      }),
    );
  } catch {
    mapSnapshotReadError();
  }
}

export function mapSnapshotWriteError(error: unknown): never {
  if (error instanceof WorkspaceFileError && error.code === "changed_on_disk") {
    throw new AidenRemoteServiceError(
      "revision_conflict",
      "This file changed on your computer. Reload it before saving.",
      409,
    );
  }
  throw new AidenRemoteServiceError(
    "workspace_unavailable",
    "Aiden could not safely save this file on your computer.",
    409,
  );
}

export async function writeSnapshotFile(input: {
  handles: AidenOpaqueHandleStore;
  fileId: string;
  folderPath: string;
  displayPath: string;
  content: string;
  expectedVersion: string;
  signal: AbortSignal;
}): Promise<AidenRemoteFileDocument> {
  try {
    const { document, installed } = await writeWorkspaceFileInstalling(
      input.folderPath,
      input.displayPath,
      input.content,
      input.expectedVersion,
      input.signal,
    );
    await rebindAidenFileHandleToSavedFile(
      input.handles,
      input.fileId,
      input.folderPath,
      input.displayPath,
      installed,
    );
    return projectedDocument(input.fileId, input.displayPath, document);
  } catch (error) {
    mapSnapshotWriteError(error);
  }
}
