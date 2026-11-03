import { parseCloneUrl } from "./workspace-intake.js";

export const PEER_PROJECT_CLONE_FEATURE = "workspace-clone-v1";
export const PEER_PROJECT_FILE_MAX_BYTES = 128 * 1024;
export const PEER_PROJECT_FILES_MAX_BYTES = 512 * 1024;
export const PEER_PROJECT_FILES_MAX_COUNT = 16;
/** Stays inside the folder browser selection's two-minute validity window. */
export const PEER_PROJECT_CLONE_TIMEOUT_MS = 90_000;

export interface PeerProjectFile { name: string; content: string }
export interface PeerProjectSource {
  name: string;
  url: string;
  repositoryName: string;
  files: Array<{ name: string; bytes: number }>;
}
export interface PeerProjectCloneRequest {
  mode: "clone";
  selection: string;
  url: string;
  files: PeerProjectFile[];
}

/** Root-level environment files only. No arbitrary files, folders or Git metadata. */
export function isPeerProjectEnvironmentFile(name: unknown): name is string {
  return typeof name === "string" && name.length <= 80 && /^\.(?:env|dev\.vars)(?:\.[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/u.test(name);
}

export function parsePeerProjectClone(value: unknown): PeerProjectCloneRequest {
  const row = value as Partial<PeerProjectCloneRequest> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.mode !== "clone" ||
    Object.keys(row).some(key => !["mode", "selection", "url", "files"].includes(key)) ||
    typeof row.selection !== "string" || !/^sel_[A-Za-z0-9_-]{43}$/u.test(row.selection) ||
    !Array.isArray(row.files) || row.files.length > PEER_PROJECT_FILES_MAX_COUNT) throw new Error("Invalid project clone request.");
  const parsed = parseCloneUrl(row.url);
  if (!parsed.ok) throw new Error("Choose a repository with a credential-free HTTPS or SSH remote.");
  const names = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  const files = row.files.map(file => {
    if (!file || typeof file !== "object" || Object.keys(file).some(key => key !== "name" && key !== "content") ||
      !isPeerProjectEnvironmentFile(file.name) || names.has(file.name.toLowerCase()) || typeof file.content !== "string" || file.content.includes("\0")) throw new Error("Invalid environment file transfer.");
    const size = encoder.encode(file.content).byteLength;
    bytes += size;
    if (size > PEER_PROJECT_FILE_MAX_BYTES || bytes > PEER_PROJECT_FILES_MAX_BYTES) throw new Error("The selected environment files exceed the transfer limit.");
    names.add(file.name.toLowerCase());
    return { name: file.name, content: file.content };
  });
  return { mode: "clone", selection: row.selection, url: parsed.url, files };
}
