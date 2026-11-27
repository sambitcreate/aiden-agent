import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteFileDocument } from "./aiden-remote-files.js";
import { AidenOpaqueHandleError } from "./aiden-remote-opaque-handles.js";
import type { WorkspaceFileDocument, WorkspaceFileEntry } from "./workspace-files.js";

export const FILE_HANDLE_TTL_MS = 10 * 60_000;
export const MAX_DISPLAY_PATH_LENGTH = 4_096;
export const MAX_WIRE_FILE_SIZE = 5 * 1_048_576;

export function languageFor(entry: WorkspaceFileEntry): string | undefined {
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

export function safeDisplayPath(value: string, message: string): string {
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
    throw new AidenRemoteServiceError("workspace_unavailable", message, 409);
  }
  return value;
}

export function mapHandleError(
  error: unknown,
  copy: { expired: string; capacity: string; invalid: string } = {
    expired: "This file link expired. Refresh Files and try again.",
    capacity: "Aiden's file-handle capacity is temporarily full.",
    invalid: "This file link is no longer valid. Refresh Files and try again.",
  },
): never {
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
      ? copy.expired
      : error.code === "handle_capacity"
        ? copy.capacity
        : copy.invalid,
    status,
    error.code === "handle_capacity",
  );
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
