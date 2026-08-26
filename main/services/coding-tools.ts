// Filesystem + shell tools that let the Pi agent operate on a workspace folder.
// Every path is resolved against — and confined to — the workspace root, so the
// agent cannot read or write outside the folder the user opened. run_command
// executes with the root as its working directory.
//
// Tool inputs use typebox schemas (pi's AgentTool.parameters), matching tools.ts.

import { spawn } from "node:child_process";
import {
  constants as fsConstants,
  realpathSync,
  statSync,
  type Dir,
  type Dirent,
  type Stats,
} from "node:fs";
import * as fs from "fs/promises";
import * as path from "path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RE2 as RE2Matcher } from "re2-wasm";
import { containsHighConfidenceSecretIncludingEncodings } from "./subagents/safe-text.js";
import { trackDiagnosticChild } from "./performance-child.js";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";

const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_SCAN_ENTRIES = 10_000;
const MAX_GLOB_MATCHES = 500;
const MAX_GLOB_ENTRIES = 10_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_ENTRIES = 10_000;
const MAX_GREP_BYTES = 10 * 1024 * 1024;
const MAX_GREP_DURATION_MS = 5_000;
const MAX_SEARCH_PATTERN_CHARS = 1_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache"]);
let re2Constructor: typeof import("re2-wasm").RE2 | undefined;

/** Tools whose effects mutate the folder or system — gated behind approval in "ask" mode. */
export const APPROVAL_TOOL_NAMES = new Set(["write_file", "edit_file", "run_command"]);

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function throwIfAborted(signal: AbortSignal | undefined, fallback: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function compileSafeRegex(pattern: string, signal?: AbortSignal): Promise<RE2Matcher> {
  throwIfAborted(signal, "File search cancelled.");
  re2Constructor ??= (await import("re2-wasm")).RE2;
  throwIfAborted(signal, "File search cancelled.");
  return new re2Constructor(pattern, "u");
}

function restrictedGlobToRegex(pattern: string): string {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      let end = index;
      while (pattern[end + 1] === "*") end += 1;
      const isGlobstar = end > index;
      index = end;
      if (isGlobstar && pattern[index + 1] === "/") {
        source += "(?:[^/]+/)*";
        index += 1;
      } else {
        source += isGlobstar ? "[^\\x00]*" : "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  }
  return `${source}$`;
}

async function compileSafeGlob(pattern: string, signal?: AbortSignal): Promise<RE2Matcher> {
  return compileSafeRegex(restrictedGlobToRegex(pattern), signal);
}

/** Resolve a user/agent-supplied path within the root, rejecting lexical escapes. */
function resolveInRoot(root: string, p: string): string {
  const resolved = path.resolve(root, p ?? ".");
  const rel = path.relative(root, resolved);
  if (rel === "") return root;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace folder.`);
  }
  return resolved;
}

function assertRealPathInRoot(root: string, resolved: string, suppliedPath: string): string {
  const rel = path.relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path "${suppliedPath}" resolves outside the workspace folder.`);
  }
  return resolved;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function compareEntryNames(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function retainLexicographicallySmallest(entries: Dirent[], entry: Dirent, limit: number): void {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries[middle];
    if (candidate && compareEntryNames(candidate, entry) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit) return;
  entries.splice(low, 0, entry);
  if (entries.length > limit) entries.pop();
}

interface WorkspaceRootGuard {
  lexical: string;
  canonical: string | null;
  identity: Stats | null;
  testObserver?: {
    beforeDirectoryOpen?(directoryPath: string): void | Promise<void>;
    afterDirectoryOpen?(directoryPath: string): void | Promise<void>;
    beforeEntryAccess?(entryPath: string): void | Promise<void>;
    beforeWriteCommit?(entryPath: string): void | Promise<void>;
  };
}

function createParentWorkspaceRoot(
  root: string,
  testObserver?: WorkspaceRootGuard["testObserver"],
): WorkspaceRootGuard {
  return {
    lexical: path.resolve(root),
    canonical: null,
    identity: null,
    testObserver,
  };
}

function pinWorkspaceRoot(
  root: string,
  testObserver?: WorkspaceRootGuard["testObserver"],
): WorkspaceRootGuard {
  const lexical = path.resolve(root);
  const canonical = realpathSync(lexical);
  const identity = statSync(canonical);
  if (!identity.isDirectory()) throw new Error("The workspace root is not a directory.");
  return { lexical, canonical, identity, testObserver };
}

async function verifyWorkspaceRoot(
  workspace: WorkspaceRootGuard,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal, "Filesystem operation cancelled.");
  let canonical: string;
  let identity: Stats;
  try {
    [canonical, identity] = await Promise.all([
      fs.realpath(workspace.lexical),
      fs.stat(workspace.lexical),
    ]);
  } catch {
    throwIfAborted(signal, "Filesystem operation cancelled.");
    throw new Error("The authorized workspace root changed during this generation.");
  }
  throwIfAborted(signal, "Filesystem operation cancelled.");
  if (workspace.canonical === null || workspace.identity === null) {
    if (!identity.isDirectory()) {
      throw new Error("The workspace root is not a directory.");
    }
    return canonical;
  }
  if (
    canonical !== workspace.canonical ||
    !identity.isDirectory() ||
    !sameFile(identity, workspace.identity)
  ) {
    throw new Error("The authorized workspace root changed during this generation.");
  }
  return workspace.canonical;
}

async function readBoundedVerifiedFile(
  workspace: WorkspaceRootGuard,
  realRoot: string,
  lexicalPath: string,
  suppliedPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  throwIfAborted(signal, "File read cancelled.");
  await verifyWorkspaceRoot(workspace, signal);
  const initialRealPath = await fs.realpath(lexicalPath);
  assertRealPathInRoot(realRoot, initialRealPath, suppliedPath);
  rejectProtectedCredential(realRoot, initialRealPath, suppliedPath, "file");
  const handle = await fs.open(
    lexicalPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    await verifyWorkspaceRoot(workspace, signal);
    const verifiedRealPath = await fs.realpath(lexicalPath);
    assertRealPathInRoot(realRoot, verifiedRealPath, suppliedPath);
    rejectProtectedCredential(realRoot, verifiedRealPath, suppliedPath, "file");
    const [openedStat, verifiedStat] = await Promise.all([
      handle.stat(),
      fs.stat(verifiedRealPath),
    ]);
    if (!openedStat.isFile() || !verifiedStat.isFile()) {
      throw new Error(`Path "${suppliedPath}" is not a regular file.`);
    }
    if (!sameFile(openedStat, verifiedStat)) {
      throw new Error(`Path "${suppliedPath}" changed while it was being opened.`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      throwIfAborted(signal, "File read cancelled.");
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    throwIfAborted(signal, "File read cancelled.");
    await verifyWorkspaceRoot(workspace, signal);
    const bounded = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (containsPrivateKeyMaterial(bounded)) {
      throw new Error(
        "Reading credential files is disabled to keep workspace secrets out of model context.",
      );
    }
    return {
      buffer: bounded,
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

async function openVerifiedDirectory(
  workspace: WorkspaceRootGuard,
  directoryPath: string,
  signal?: AbortSignal,
): Promise<Dir> {
  if (workspace.canonical === null || workspace.identity === null) {
    throw new Error("Verified directory traversal requires a pinned workspace.");
  }
  throwIfAborted(signal, "Directory traversal cancelled.");
  await verifyWorkspaceRoot(workspace, signal);
  await workspace.testObserver?.beforeDirectoryOpen?.(directoryPath);
  throwIfAborted(signal, "Directory traversal cancelled.");
  const lexicalStat = await fs.lstat(directoryPath);
  const isWorkspaceRoot = path.resolve(directoryPath) === workspace.lexical;
  if (lexicalStat.isSymbolicLink() && !isWorkspaceRoot) {
    throw new Error("A directory changed to a symbolic link before it could be opened.");
  }
  const beforeRealPath = await fs.realpath(directoryPath);
  assertRealPathInRoot(workspace.canonical, beforeRealPath, directoryPath);
  const beforeStat = await fs.stat(beforeRealPath);
  if (!beforeStat.isDirectory()) {
    throw new Error("The requested path is not a directory.");
  }
  const directory = await fs.opendir(directoryPath);
  try {
    await workspace.testObserver?.afterDirectoryOpen?.(directoryPath);
    await verifyWorkspaceRoot(workspace, signal);
    const afterRealPath = await fs.realpath(directoryPath);
    assertRealPathInRoot(workspace.canonical, afterRealPath, directoryPath);
    const afterStat = await fs.stat(afterRealPath);
    if (
      beforeRealPath !== afterRealPath ||
      !afterStat.isDirectory() ||
      !sameFile(beforeStat, afterStat)
    ) {
      throw new Error("A directory changed while it was being opened.");
    }
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

/** Resolve an existing path, following symlinks only after checking its target. */
async function resolveExistingInRoot(
  workspace: WorkspaceRootGuard,
  suppliedPath: string,
  signal?: AbortSignal,
): Promise<{ root: string; full: string }> {
  const realRoot = await verifyWorkspaceRoot(workspace, signal);
  const lexical = resolveInRoot(workspace.lexical, suppliedPath);
  const realPath = await fs.realpath(lexical);
  throwIfAborted(signal, "Filesystem operation cancelled.");
  return { root: realRoot, full: assertRealPathInRoot(realRoot, realPath, suppliedPath) };
}

async function nearestExistingAncestor(fullPath: string): Promise<string> {
  let current = fullPath;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Resolve a writable path without letting mkdir/writeFile follow a symlink to
 * somewhere outside the workspace. Existing safe symlinks are canonicalized.
 */
async function resolveWritableInRoot(
  workspace: WorkspaceRootGuard,
  suppliedPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const lexical = resolveInRoot(workspace.lexical, suppliedPath);
  const realRoot = await verifyWorkspaceRoot(workspace, signal);
  const parent = path.dirname(lexical);
  const ancestor = await nearestExistingAncestor(parent);
  throwIfAborted(signal, "File write cancelled.");
  const realAncestor = await fs.realpath(ancestor);
  assertRealPathInRoot(realRoot, realAncestor, suppliedPath);

  await workspace.testObserver?.beforeWriteCommit?.(lexical);
  throwIfAborted(signal, "File write cancelled.");
  await fs.mkdir(parent, { recursive: true });
  throwIfAborted(signal, "File write cancelled.");
  const realParent = await fs.realpath(parent);
  assertRealPathInRoot(realRoot, realParent, suppliedPath);

  try {
    await fs.lstat(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return lexical;
    throw error;
  }

  try {
    const realPath = await fs.realpath(lexical);
    return assertRealPathInRoot(realRoot, realPath, suppliedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Path "${suppliedPath}" is a dangling symbolic link.`);
    }
    throw error;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n… [truncated]";
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function formatBoundedSearchResult(
  lines: readonly string[],
  emptyText: string,
  warnings: readonly string[],
): string {
  const body = lines.length ? lines.join("\n") : emptyText;
  if (warnings.length === 0) return truncate(body, MAX_OUTPUT_CHARS);
  const suffix = `\n${warnings.join("\n")}`;
  if (body.length + suffix.length <= MAX_OUTPUT_CHARS) return `${body}${suffix}`;
  const marker = "\n… [output truncated]";
  const bodyLimit = Math.max(0, MAX_OUTPUT_CHARS - suffix.length - marker.length);
  return `${body.slice(0, bodyLimit)}${marker}${suffix}`;
}

const PROTECTED_CREDENTIAL_FILE_NAMES = new Set([
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "identity",
  "service-account.json",
  "service_account.json",
  ".git-credentials",
  ".gitconfig",
  ".bunfig.toml",
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".sentryclirc",
  ".terraformrc",
  ".vault-token",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
]);
const PROTECTED_CREDENTIAL_FILE_EXTENSIONS = new Set([
  ".asc",
  ".der",
  ".jks",
  ".kdbx",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
  ".ppk",
]);
const PROTECTED_CREDENTIAL_DATA_EXTENSIONS = new Set([
  ".conf",
  ".config",
  ".ini",
  ".json",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);
const CREDENTIAL_WRAPPER_EXTENSIONS = new Set([
  ...PROTECTED_CREDENTIAL_DATA_EXTENSIONS,
  ".backup",
  ".bak",
  ".bz2",
  ".copy",
  ".gz",
  ".old",
  ".orig",
  ".original",
  ".save",
  ".saved",
  ".swp",
  ".temp",
  ".tar",
  ".tgz",
  ".tmp",
  ".7z",
  ".rar",
  ".xz",
  ".zip",
  ".zst",
]);
const PROTECTED_CREDENTIAL_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".bundle",
  ".cargo",
  ".dbt",
  ".docker",
  ".gem",
  ".git",
  ".gnupg",
  ".gradle",
  ".hex",
  ".kube",
  ".m2",
  ".nuget",
  ".password-store",
  ".ssh",
  ".terraform",
  ".terraform.d",
]);
const PROTECTED_CREDENTIAL_PATH_PREFIXES = [
  ".config/gcloud",
  ".config/composer",
  ".config/doctl",
  ".config/gh",
  ".config/heroku",
  ".config/hub",
  ".config/op",
  ".config/pypoetry",
  ".config/rclone",
  ".config/containers",
  ".local/share/keyrings",
] as const;
const SAFE_HIDDEN_DIRECTORY_NAMES = new Set([
  ".changeset",
  ".circleci",
  ".devcontainer",
  ".github",
  ".husky",
  ".storybook",
]);
const SAFE_HIDDEN_FILE_NAMES = new Set([
  ".browserslistrc",
  ".commitlintrc",
  ".dockerignore",
  ".editorconfig",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".lintstagedrc",
  ".markdownlint",
  ".markdownlintignore",
  ".node-version",
  ".npmignore",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  ".python-version",
  ".ruby-version",
  ".swiftlint.yml",
  ".stylelintrc",
  ".tool-versions",
  ".watchmanconfig",
]);
const SAFE_HIDDEN_CONFIG_EXTENSIONS = [".cjs", ".js", ".json", ".mjs", ".yaml", ".yml"] as const;

function isSafeHiddenFileName(segment: string): boolean {
  if (SAFE_HIDDEN_FILE_NAMES.has(segment)) return true;
  const configBases = [
    ".commitlintrc",
    ".eslintrc",
    ".lintstagedrc",
    ".markdownlint",
    ".prettierrc",
    ".stylelintrc",
  ] as const;
  return configBases.some((base) =>
    SAFE_HIDDEN_CONFIG_EXTENSIONS.some((extension) => segment === `${base}${extension}`),
  );
}

function containsCredentialFamily(value: string): boolean {
  const candidate = value
    .normalize("NFKC")
    .replace(/[\p{Z}\p{Pd}\p{Pc}\u00b7\u2022\u2219]+/gu, "_");
  return (
    /(?:^|[._-])(?:auth|oauth|credentials?|creds?|passwords?|secrets?|tokens?)(?:[._-]|$)/u.test(
      candidate,
    ) ||
    /(?:^|[._-])(?:htpasswd|passwd|pw|pwd|shadow)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:key|trust)[._-]?store|keychain|keyring|vault|wallet|logins?|kubeconfig|dockerconfigjson)(?:[._-]|$)/u.test(
      candidate,
    ) ||
    /(?:^|[._-])client[._-]?secret(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])service[._-]?account(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:adc|sp|service[._-]?principal)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:pat|personal[._-]?access[._-]?tokens?)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[-_])(?:gpg|pgp|putty)(?:[-_]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:api|access|auth|bearer|consumer|private|refresh|secret)[._-]?)?(?:keys?|tokens?)(?:[._-]|$)/u.test(
      candidate,
    )
  );
}

function isProtectedCredentialFileName(segment: string): boolean {
  let candidate = segment
    .replace(/~/gu, "")
    .replace(/[._-](?:backup|bak|copy|old|orig|original|save|saved|swp|temp|tmp)(?=[._-]|$)/gu, "");
  for (;;) {
    if (PROTECTED_CREDENTIAL_FILE_NAMES.has(candidate)) return true;
    const extension = path.extname(candidate);
    const stem = extension ? candidate.slice(0, -extension.length) : candidate;
    const credentialFamily = containsCredentialFamily(candidate) || containsCredentialFamily(stem);
    if (
      credentialFamily &&
      (extension.length === 0 ||
        extension === ".pub" ||
        PROTECTED_CREDENTIAL_DATA_EXTENSIONS.has(extension) ||
        !SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS.has(extension))
    ) {
      return true;
    }
    if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?\.pub$/u.test(candidate)) return false;
    if (PROTECTED_CREDENTIAL_FILE_EXTENSIONS.has(extension)) return true;
    if (
      !extension ||
      (!CREDENTIAL_WRAPPER_EXTENSIONS.has(extension) && !/^\.\d{1,14}$/u.test(extension))
    ) {
      return false;
    }
    candidate = stem;
  }
}

function containsPrivateKeyMaterial(buffer: Buffer): boolean {
  const sample = buffer.toString("utf8");
  return (
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(sample) ||
    /"private_key"\s*:\s*"-----BEGIN/u.test(sample) ||
    containsHighConfidenceSecretIncludingEncodings(sample) ||
    /-----BEGIN PGP PRIVATE KEY BLOCK-----/u.test(sample) ||
    /^PuTTY-User-Key-File-[123]:/mu.test(sample) ||
    /---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----/u.test(sample)
  );
}

type ProtectedPathFinalKind = "directory" | "file" | "unknown";

/** Keep common credential-bearing paths out of every model-visible filesystem result. */
function isProtectedCredentialPath(
  relativePath: string,
  finalKind: ProtectedPathFinalKind = "unknown",
): boolean {
  if (containsHighConfidenceSecretIncludingEncodings(relativePath)) return true;
  const rawSegments = relativePath
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (rawSegments.some((segment) => containsHighConfidenceSecretIncludingEncodings(segment))) {
    return true;
  }
  const segments = rawSegments.map((segment) => segment.toLocaleLowerCase("en-US"));
  if (
    segments.some(
      (segment) =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        segment === ".envrc" ||
        segment.startsWith(".envrc.") ||
        isProtectedCredentialFileName(segment) ||
        PROTECTED_CREDENTIAL_DIRECTORY_NAMES.has(segment),
    )
  ) {
    return true;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (!segment.startsWith(".")) continue;
    const isFinalSegment = index === segments.length - 1;
    if (
      SAFE_HIDDEN_DIRECTORY_NAMES.has(segment) &&
      (!isFinalSegment || finalKind === "directory")
    ) {
      continue;
    }
    if (isFinalSegment && finalKind === "file" && isSafeHiddenFileName(segment)) continue;
    return true;
  }
  const normalized = segments.join("/");
  return PROTECTED_CREDENTIAL_PATH_PREFIXES.some((prefix) =>
    `/${normalized}/`.includes(`/${prefix}/`),
  );
}

function rejectProtectedCredential(
  root: string,
  fullPath: string,
  suppliedPath: string,
  finalKind: ProtectedPathFinalKind = "unknown",
): void {
  if (
    isProtectedCredentialPath(suppliedPath, finalKind) ||
    isProtectedCredentialPath(path.relative(root, fullPath), finalKind)
  ) {
    throw new Error(
      "Reading credential files is disabled to keep workspace secrets out of model context.",
    );
  }
}

/** Preserve the parent agent's established narrow `.env*` read/search exclusion. */
function isEnvironmentSecretPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => segment === ".env" || segment.startsWith(".env."));
}

function rejectEnvironmentSecret(root: string, fullPath: string): void {
  if (isEnvironmentSecretPath(path.relative(root, fullPath))) {
    throw new Error(
      "Reading .env files is disabled to keep workspace secrets out of model context.",
    );
  }
}

/** Build a short human summary of a mutating tool call for the approval prompt. */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "write_file":
      return `Create or replace file: ${String(a.path ?? "?")}`;
    case "edit_file":
      return `Edit file: ${String(a.path ?? "?")}`;
    case "run_command":
      return `Run command: ${String(a.command ?? "?")}`;
    default:
      return toolName;
  }
}

function makeSubagentReadFile(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a UTF-8 text file from the workspace folder. Paths are relative to the folder root.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path: string };
      const lexical = resolveInRoot(workspace.lexical, p);
      const realRoot = await verifyWorkspaceRoot(workspace, signal);
      rejectProtectedCredential(realRoot, lexical, p, "file");
      const { buffer, truncated } = await readBoundedVerifiedFile(
        workspace,
        realRoot,
        lexical,
        p,
        MAX_READ_BYTES,
        signal,
      );
      const text = buffer.toString("utf-8");
      return textResult(truncated ? `${text}\n… [truncated]` : text || "[empty file]");
    },
  };
}

function makeParentReadFile(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a UTF-8 text file from the workspace folder. Paths are relative to the folder root.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path: string };
      const { root: realRoot, full } = await resolveExistingInRoot(workspace, p);
      rejectEnvironmentSecret(realRoot, full);
      const buffer = await fs.readFile(full);
      recordDiagnosticCounter("filesystem:read", { bytesOut: buffer.byteLength });
      const text = buffer.subarray(0, MAX_READ_BYTES).toString("utf-8");
      return textResult(
        buffer.length > MAX_READ_BYTES ? `${text}\n… [truncated]` : text || "[empty file]",
      );
    },
  };
}

function makeWriteFile(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "write_file",
    label: "Write File",
    description:
      "Create or overwrite a text file in the workspace folder with the given content. Creates parent directories as needed.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
      content: Type.String({ description: "Full file content to write." }),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { path: p, content } = params as { path: string; content: string };
      const full = await resolveWritableInRoot(workspace, p, signal);
      throwIfAborted(signal, "File write cancelled.");
      await fs.writeFile(full, content, "utf-8");
      recordDiagnosticCounter("filesystem:write", {
        bytesIn: Buffer.byteLength(content, "utf8"),
      });
      return textResult(`Wrote ${content.length} chars to ${p}.`);
    },
  };
}

function makeEditFile(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "edit_file",
    label: "Edit File",
    description:
      "Replace an exact substring in an existing file. old_string must appear exactly once; use enough surrounding context to make it unique.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
      old_string: Type.String({
        description: "Exact text to replace (must be unique in the file).",
      }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const {
        path: p,
        old_string,
        new_string,
      } = params as {
        path: string;
        old_string: string;
        new_string: string;
      };
      const { full } = await resolveExistingInRoot(workspace, p, signal);
      const original = await fs.readFile(full, "utf-8");
      recordDiagnosticCounter("filesystem:read", {
        bytesOut: Buffer.byteLength(original, "utf8"),
      });
      throwIfAborted(signal, "File edit cancelled.");
      const count = original.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${p}.`);
      if (count > 1)
        throw new Error(`old_string is not unique in ${p} (${count} matches). Add more context.`);
      await workspace.testObserver?.beforeWriteCommit?.(full);
      throwIfAborted(signal, "File edit cancelled.");
      const updated = original.replace(old_string, new_string);
      await fs.writeFile(full, updated, "utf-8");
      recordDiagnosticCounter("filesystem:write", {
        bytesIn: Buffer.byteLength(updated, "utf8"),
      });
      return textResult(`Edited ${p}.`);
    },
  };
}

function makeSubagentListDir(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "list_dir",
    label: "List Directory",
    description: "List the entries of a directory in the workspace folder.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory relative to the workspace folder (default root)." }),
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path?: string };
      const { root: realRoot, full } = await resolveExistingInRoot(workspace, p ?? ".", signal);
      rejectProtectedCredential(realRoot, full, p ?? ".", "directory");
      const entries: Dirent[] = [];
      let truncated = false;
      let scanTruncated = false;
      let skippedInputs = false;
      const directory = await openVerifiedDirectory(workspace, full, signal);
      try {
        let scanned = 0;
        for await (const entry of directory) {
          throwIfAborted(signal, "Directory listing cancelled.");
          scanned += 1;
          if (scanned > MAX_LIST_SCAN_ENTRIES) {
            scanTruncated = true;
            break;
          }
          if (scanned > MAX_LIST_ENTRIES) truncated = true;
          retainLexicographicallySmallest(entries, entry, MAX_LIST_ENTRIES);
        }
      } catch (error) {
        throwIfAborted(signal, "Directory listing cancelled.");
        throw error;
      }
      throwIfAborted(signal, "Directory listing cancelled.");
      const lines: string[] = [];
      for (const entry of entries) {
        throwIfAborted(signal, "Directory listing cancelled.");
        const suppliedEntryPath = path.join(p ?? ".", entry.name);
        const entryKind: ProtectedPathFinalKind = entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "unknown";
        if (isProtectedCredentialPath(suppliedEntryPath, entryKind)) {
          skippedInputs = true;
          continue;
        }
        if (entry.isSymbolicLink()) {
          skippedInputs = true;
          continue;
        }
        const entryPath = path.join(full, entry.name);
        try {
          await verifyWorkspaceRoot(workspace, signal);
          const firstRealPath = await fs.realpath(entryPath);
          assertRealPathInRoot(realRoot, firstRealPath, suppliedEntryPath);
          const firstStat = await fs.stat(firstRealPath);
          const firstKind: ProtectedPathFinalKind = firstStat.isDirectory()
            ? "directory"
            : firstStat.isFile()
              ? "file"
              : "unknown";
          rejectProtectedCredential(realRoot, firstRealPath, suppliedEntryPath, firstKind);
          const secondRealPath = await fs.realpath(entryPath);
          assertRealPathInRoot(realRoot, secondRealPath, suppliedEntryPath);
          const secondStat = await fs.stat(secondRealPath);
          const secondKind: ProtectedPathFinalKind = secondStat.isDirectory()
            ? "directory"
            : secondStat.isFile()
              ? "file"
              : "unknown";
          rejectProtectedCredential(realRoot, secondRealPath, suppliedEntryPath, secondKind);
          await verifyWorkspaceRoot(workspace, signal);
          if (firstRealPath !== secondRealPath || !sameFile(firstStat, secondStat)) {
            skippedInputs = true;
            continue;
          }
          if (!secondStat.isDirectory() && !secondStat.isFile()) {
            skippedInputs = true;
            continue;
          }
          lines.push(`${secondStat.isDirectory() ? "dir " : "file"}  ${entry.name}`);
        } catch {
          throwIfAborted(signal, "Directory listing cancelled.");
          await verifyWorkspaceRoot(workspace, signal);
          skippedInputs = true;
        }
      }
      lines.sort();
      const warnings: string[] = [];
      if (truncated) warnings.push(`… [truncated at ${MAX_LIST_ENTRIES} entries]`);
      if (scanTruncated) {
        warnings.push(`… [listing scan stopped after ${MAX_LIST_SCAN_ENTRIES} entries]`);
      }
      if (skippedInputs) {
        warnings.push(
          "… [listing incomplete: linked, changed, unreadable, or non-regular entries skipped]",
        );
      }
      return textResult(formatBoundedSearchResult(lines, "[empty directory]", warnings));
    },
  };
}

function makeParentListDir(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "list_dir",
    label: "List Directory",
    description: "List the entries of a directory in the workspace folder.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory relative to the workspace folder (default root)." }),
      ),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path?: string };
      const { full } = await resolveExistingInRoot(workspace, p ?? ".");
      const entries = await fs.readdir(full, { withFileTypes: true });
      const lines = entries.map(
        (entry) => `${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`,
      );
      lines.sort();
      return textResult(lines.length ? lines.join("\n") : "[empty directory]");
    },
  };
}

function makeSubagentGlob(workspace: WorkspaceRootGuard): AgentTool {
  const root = workspace.lexical;
  return {
    name: "glob",
    label: "Find Files",
    description: 'Find files in the workspace folder matching a glob pattern, e.g. "src/**/*.ts".',
    parameters: Type.Object({
      pattern: Type.String({
        maxLength: MAX_SEARCH_PATTERN_CHARS,
        description: "Glob pattern relative to the workspace folder.",
      }),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { pattern } = params as { pattern: string };
      if (typeof pattern !== "string" || pattern.length > MAX_SEARCH_PATTERN_CHARS) {
        throw new Error(`Glob pattern must be at most ${MAX_SEARCH_PATTERN_CHARS} characters.`);
      }
      const matcher = await compileSafeGlob(pattern, signal);
      const matches: string[] = [];
      let matchTruncated = false;
      let traversalTruncated = false;
      let skippedInputs = false;
      let visited = 0;
      throwIfAborted(signal, "File search cancelled.");
      const realRoot = await verifyWorkspaceRoot(workspace, signal);
      throwIfAborted(signal, "File search cancelled.");
      const pendingDirectories = [""];
      let pendingIndex = 0;

      traversal: while (pendingIndex < pendingDirectories.length) {
        const relativeDirectory = pendingDirectories[pendingIndex] ?? "";
        pendingIndex += 1;
        let directory: Dir;
        try {
          directory = await openVerifiedDirectory(
            workspace,
            path.join(root, relativeDirectory),
            signal,
          );
        } catch {
          throwIfAborted(signal, "File search cancelled.");
          await verifyWorkspaceRoot(workspace, signal);
          skippedInputs = true;
          continue;
        }
        const entries: Dirent[] = [];
        const remainingEntryBudget = MAX_GLOB_ENTRIES - visited;
        try {
          for await (const entry of directory) {
            throwIfAborted(signal, "File search cancelled.");
            entries.push(entry);
            if (entries.length > remainingEntryBudget) {
              // Never let filesystem enumeration order choose a bounded
              // subset. Preserve prior deterministic results and omit this
              // entire over-cap directory.
              entries.length = 0;
              traversalTruncated = true;
              break;
            }
          }
        } catch {
          throwIfAborted(signal, "File search cancelled.");
          await verifyWorkspaceRoot(workspace, signal);
          skippedInputs = true;
          continue;
        }
        entries.sort(compareEntryNames);
        for (const entry of entries) {
          throwIfAborted(signal, "File search cancelled.");
          visited += 1;
          if (entry.isSymbolicLink()) {
            skippedInputs = true;
            continue;
          }
          const relativePath = path.join(relativeDirectory, entry.name);
          const globPath = relativePath.split(path.sep).join("/");
          const entryKind: ProtectedPathFinalKind = entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "unknown";
          if (isProtectedCredentialPath(relativePath, entryKind)) {
            skippedInputs = true;
            continue;
          }
          const lexical = resolveInRoot(root, relativePath);
          let realPath: string;
          let verifiedStat: Stats;
          try {
            await workspace.testObserver?.beforeEntryAccess?.(lexical);
            await verifyWorkspaceRoot(workspace, signal);
            realPath = await fs.realpath(lexical);
            assertRealPathInRoot(realRoot, realPath, relativePath);
            verifiedStat = await fs.stat(realPath);
            const verifiedKind: ProtectedPathFinalKind = verifiedStat.isDirectory()
              ? "directory"
              : verifiedStat.isFile()
                ? "file"
                : "unknown";
            rejectProtectedCredential(realRoot, realPath, relativePath, verifiedKind);
            await verifyWorkspaceRoot(workspace, signal);
            if (!verifiedStat.isDirectory() && !verifiedStat.isFile()) {
              skippedInputs = true;
              continue;
            }
          } catch {
            throwIfAborted(signal, "File search cancelled.");
            await verifyWorkspaceRoot(workspace, signal);
            skippedInputs = true;
            continue;
          }
          throwIfAborted(signal, "File search cancelled.");
          if (matcher.test(globPath)) {
            matches.push(globPath);
            if (matches.length > MAX_GLOB_MATCHES) {
              matches.pop();
              matchTruncated = true;
              break traversal;
            }
          }
          if (verifiedStat.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
              skippedInputs = true;
            } else {
              pendingDirectories.push(relativePath);
            }
          }
        }
        if (traversalTruncated) break;
      }
      throwIfAborted(signal, "File search cancelled.");
      matches.sort();
      const warnings: string[] = [];
      if (matchTruncated) warnings.push(`… [truncated at ${MAX_GLOB_MATCHES} matches]`);
      if (traversalTruncated) {
        warnings.push(`… [truncated after ${MAX_GLOB_ENTRIES} entries]`);
      }
      if (skippedInputs) {
        warnings.push(
          "… [search incomplete: linked, protected, ignored, unreadable, or non-regular paths skipped]",
        );
      }
      return textResult(formatBoundedSearchResult(matches, "[no matches]", warnings));
    },
  };
}

function makeParentGlob(workspace: WorkspaceRootGuard): AgentTool {
  const root = workspace.lexical;
  return {
    name: "glob",
    label: "Find Files",
    description: 'Find files in the workspace folder matching a glob pattern, e.g. "src/**/*.ts".',
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern relative to the workspace folder." }),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { pattern } = params as { pattern: string };
      const matches: string[] = [];
      const realRoot = await verifyWorkspaceRoot(workspace);
      for await (const entry of fs.glob(pattern, { cwd: root })) {
        try {
          const lexical = resolveInRoot(root, entry);
          const realPath = await fs.realpath(lexical);
          assertRealPathInRoot(realRoot, realPath, entry);
          if (
            isEnvironmentSecretPath(entry) ||
            isEnvironmentSecretPath(path.relative(realRoot, realPath))
          ) {
            continue;
          }
        } catch {
          continue;
        }
        matches.push(entry);
        if (matches.length >= 500) break;
      }
      matches.sort();
      return textResult(matches.length ? matches.join("\n") : "[no matches]");
    },
  };
}

interface GrepBudget {
  visited: number;
  bytesRead: number;
  deadline: number;
  exhausted: boolean;
  matchTruncated: boolean;
  bytesExhausted: boolean;
  timedOut: boolean;
  skippedInputs: boolean;
}

function grepDeadlineReached(budget: GrepBudget, signal?: AbortSignal): boolean {
  throwIfAborted(signal, "File search cancelled.");
  if (Date.now() < budget.deadline) return false;
  budget.timedOut = true;
  return true;
}

async function grepSubagentDir(
  dir: string,
  workspace: WorkspaceRootGuard,
  root: string,
  re: RE2Matcher,
  out: string[],
  budget: GrepBudget,
  signal?: AbortSignal,
): Promise<void> {
  if (budget.matchTruncated || budget.exhausted || budget.bytesExhausted || budget.timedOut) {
    return;
  }
  throwIfAborted(signal, "File search cancelled.");
  const entries: Dirent[] = [];
  let directory: Dir;
  try {
    directory = await openVerifiedDirectory(workspace, dir, signal);
  } catch {
    throwIfAborted(signal, "File search cancelled.");
    await verifyWorkspaceRoot(workspace, signal);
    budget.skippedInputs = true;
    return;
  }
  try {
    const remainingEntryBudget = MAX_GREP_ENTRIES - budget.visited;
    for await (const entry of directory) {
      if (grepDeadlineReached(budget, signal)) break;
      entries.push(entry);
      if (entries.length > remainingEntryBudget) {
        // Preserve prior deterministic results instead of retaining whichever
        // names the filesystem happened to enumerate first.
        entries.length = 0;
        budget.exhausted = true;
        break;
      }
    }
  } catch {
    throwIfAborted(signal, "File search cancelled.");
    await verifyWorkspaceRoot(workspace, signal);
    budget.skippedInputs = true;
    return;
  }
  entries.sort(compareEntryNames);
  for (const entry of entries) {
    if (grepDeadlineReached(budget, signal)) return;
    if (budget.matchTruncated || budget.bytesExhausted) return;
    budget.visited += 1;
    if (entry.isSymbolicLink()) {
      budget.skippedInputs = true;
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    const entryKind: ProtectedPathFinalKind = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : "unknown";
    if (isProtectedCredentialPath(rel, entryKind)) {
      budget.skippedInputs = true;
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        budget.skippedInputs = true;
        continue;
      }
      await grepSubagentDir(full, workspace, root, re, out, budget, signal);
      continue;
    }
    if (!entry.isFile()) {
      budget.skippedInputs = true;
      continue;
    }
    const remainingBytes = MAX_GREP_BYTES - budget.bytesRead;
    if (remainingBytes <= 0) {
      budget.bytesExhausted = true;
      return;
    }
    const perFileLimit = Math.min(512_000, remainingBytes);
    let content: string;
    try {
      await workspace.testObserver?.beforeEntryAccess?.(full);
      const read = await readBoundedVerifiedFile(workspace, root, full, rel, perFileLimit, signal);
      budget.bytesRead += read.buffer.length;
      if (read.truncated) {
        if (perFileLimit < 512_000) budget.bytesExhausted = true;
        else budget.skippedInputs = true;
        continue;
      }
      content = read.buffer.toString("utf-8");
    } catch {
      throwIfAborted(signal, "File search cancelled.");
      await verifyWorkspaceRoot(workspace, signal);
      budget.skippedInputs = true;
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i % 128 === 0 && grepDeadlineReached(budget, signal)) return;
      if (re.test(lines[i])) {
        if (out.length >= MAX_GREP_MATCHES) {
          budget.matchTruncated = true;
          return;
        }
        const resultLine = `${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`;
        if (containsHighConfidenceSecretIncludingEncodings(resultLine)) {
          budget.skippedInputs = true;
          continue;
        }
        out.push(resultLine);
      }
    }
  }
}

function makeSubagentGrep(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "grep",
    label: "Search Files",
    description:
      "Search the workspace folder for lines matching a regular expression. Returns file:line: match, capped at 200 hits.",
    parameters: Type.Object({
      pattern: Type.String({
        maxLength: MAX_SEARCH_PATTERN_CHARS,
        description: "RE2 regular expression to search for.",
      }),
      path: Type.Optional(
        Type.String({ description: "Subdirectory to limit the search to (default root)." }),
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { pattern, path: p } = params as { pattern: string; path?: string };
      throwIfAborted(signal, "File search cancelled.");
      if (typeof pattern !== "string" || pattern.length > MAX_SEARCH_PATTERN_CHARS) {
        throw new Error(`Search pattern must be at most ${MAX_SEARCH_PATTERN_CHARS} characters.`);
      }
      let re: RE2Matcher;
      try {
        re = await compileSafeRegex(pattern, signal);
      } catch (e) {
        throwIfAborted(signal, "File search cancelled.");
        throw new Error(
          `Invalid RE2 regular expression: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const { root: realRoot, full: start } = await resolveExistingInRoot(
        workspace,
        p ?? ".",
        signal,
      );
      rejectProtectedCredential(realRoot, start, p ?? ".", "directory");
      const out: string[] = [];
      const budget: GrepBudget = {
        visited: 0,
        bytesRead: 0,
        deadline: Date.now() + MAX_GREP_DURATION_MS,
        exhausted: false,
        matchTruncated: false,
        bytesExhausted: false,
        timedOut: false,
        skippedInputs: false,
      };
      await grepSubagentDir(start, workspace, realRoot, re, out, budget, signal);
      throwIfAborted(signal, "File search cancelled.");
      const warnings: string[] = [];
      if (budget.matchTruncated) {
        warnings.push(`… [truncated at ${MAX_GREP_MATCHES} matches]`);
      }
      if (budget.exhausted) {
        warnings.push(`… [truncated after ${MAX_GREP_ENTRIES} entries]`);
      }
      if (budget.bytesExhausted) {
        warnings.push(`… [truncated after ${MAX_GREP_BYTES} bytes]`);
      }
      if (budget.timedOut) {
        warnings.push(`… [truncated after ${MAX_GREP_DURATION_MS} ms]`);
      }
      if (budget.skippedInputs) {
        warnings.push(
          "… [search incomplete: hidden, linked, oversized, unreadable, or non-regular paths skipped]",
        );
      }
      return textResult(formatBoundedSearchResult(out, "[no matches]", warnings));
    },
  };
}

async function grepParentDir(
  dir: string,
  root: string,
  regex: RegExp,
  out: string[],
): Promise<void> {
  if (out.length >= MAX_GREP_MATCHES) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_GREP_MATCHES) return;
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await grepParentDir(full, root, regex, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat: Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > 512_000) continue;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
      recordDiagnosticCounter("filesystem:read", {
        bytesOut: Buffer.byteLength(content, "utf8"),
      });
    } catch {
      continue;
    }
    const relativePath = path.relative(root, full);
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index] ?? "")) {
        out.push(`${relativePath}:${index + 1}: ${(lines[index] ?? "").trim().slice(0, 200)}`);
        if (out.length >= MAX_GREP_MATCHES) return;
      }
    }
  }
}

function makeParentGrep(workspace: WorkspaceRootGuard): AgentTool {
  return {
    name: "grep",
    label: "Search Files",
    description:
      "Search the workspace folder for lines matching a regular expression. Returns file:line: match, capped at 200 hits.",
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regular expression to search for." }),
      path: Type.Optional(
        Type.String({ description: "Subdirectory to limit the search to (default root)." }),
      ),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { pattern, path: p } = params as { pattern: string; path?: string };
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const { root: realRoot, full: start } = await resolveExistingInRoot(workspace, p ?? ".");
      const out: string[] = [];
      await grepParentDir(start, realRoot, regex, out);
      return textResult(out.length ? out.join("\n") : "[no matches]");
    },
  };
}

function makeRunCommand(workspace: WorkspaceRootGuard): AgentTool {
  const root = workspace.lexical;
  return {
    name: "run_command",
    label: "Run Command",
    description:
      "Run a shell command with the workspace folder as the working directory. Returns combined stdout/stderr (capped). Use for builds, tests, git, package managers, etc.",
    // `description` is what the activity feed shows; the command itself is
    // never written to the timeline or to chat history.
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to run." }),
      description: Type.Optional(
        Type.String({
          description:
            'A short present-tense description of what the command does, in 5-10 words, e.g. "Run the unit test suite".',
        }),
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      const { command } = params as { command: string };
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Command cancelled.");
      }
      await verifyWorkspaceRoot(workspace, signal);
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
        outputLimitExceeded: boolean;
        aborted: boolean;
      }>((resolve, reject) => {
        const child = spawn(command, {
          cwd: root,
          detached: process.platform !== "win32",
          env: process.env,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        trackDiagnosticChild("coding-tool", child);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let timedOut = false;
        let outputLimitExceeded = false;
        let aborted = false;
        let settled = false;
        let terminationRequested = false;
        let forceKill: ReturnType<typeof setTimeout> | undefined;

        const signalProcess = (processSignal: NodeJS.Signals) => {
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, processSignal);
              return;
            } catch {
              // The process group may have exited; fall back to the child handle.
            }
          }
          child.kill(processSignal);
        };
        const terminate = () => {
          if (terminationRequested) return;
          terminationRequested = true;
          signalProcess("SIGTERM");
          forceKill = setTimeout(() => {
            if (!settled) signalProcess("SIGKILL");
          }, 1_000);
          forceKill.unref?.();
        };
        const abort = () => {
          aborted = true;
          terminate();
        };
        const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - bytes);
          if (remaining > 0) target.push(value.subarray(0, remaining));
          bytes += value.length;
          if (bytes > MAX_COMMAND_OUTPUT_BYTES && !outputLimitExceeded) {
            outputLimitExceeded = true;
            terminate();
          }
        };
        child.stdout.on("data", capture(stdout));
        child.stderr.on("data", capture(stderr));
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(forceKill);
          signal?.removeEventListener("abort", abort);
          reject(error);
        });
        child.once("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(forceKill);
          signal?.removeEventListener("abort", abort);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf-8"),
            stderr: Buffer.concat(stderr).toString("utf-8"),
            exitCode,
            timedOut,
            outputLimitExceeded,
            aborted,
          });
        });
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => {
          timedOut = true;
          terminate();
        }, COMMAND_TIMEOUT_MS);
        timeout.unref?.();
      });
      if (result.aborted) {
        throw signal?.reason instanceof Error ? signal.reason : new Error("Command cancelled.");
      }
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded) {
        return textResult(truncate(combined || "[no output]", MAX_OUTPUT_CHARS));
      }
      const reason = result.timedOut
        ? "Command timed out."
        : result.outputLimitExceeded
          ? "Command exceeded the output limit."
          : `Command exited with error (code ${result.exitCode ?? "?"}).`;
      return textResult(truncate(`${reason}${combined ? `\n${combined}` : ""}`, MAX_OUTPUT_CHARS));
    },
  };
}

/** All folder-scoped tools for a workspace root, in a sensible ordering. */
export function buildCodingTools(
  root: string,
  /** Test-only scheduling seam for deterministic cancellation regressions. */
  testObserver?: WorkspaceRootGuard["testObserver"],
): AgentTool[] {
  const workspace = createParentWorkspaceRoot(root, testObserver);
  return [
    makeParentReadFile(workspace),
    makeParentListDir(workspace),
    makeParentGlob(workspace),
    makeParentGrep(workspace),
    makeEditFile(workspace),
    makeWriteFile(workspace),
    makeRunCommand(workspace),
  ];
}

/**
 * Positive V1 child builder. Only known read/search factories are reachable,
 * and excluded tool objects are never constructed.
 */
export function buildSubagentCodingTools(
  root: string,
  allowed: readonly ("read_file" | "list_dir" | "glob" | "grep")[],
  /** Test-only scheduling seam for deterministic path-replacement regressions. */
  testObserver?: WorkspaceRootGuard["testObserver"],
): AgentTool[] {
  const workspace = pinWorkspaceRoot(root, testObserver);
  const permitted = new Set(allowed);
  const tools: AgentTool[] = [];
  if (permitted.has("read_file")) tools.push(makeSubagentReadFile(workspace));
  if (permitted.has("list_dir")) tools.push(makeSubagentListDir(workspace));
  if (permitted.has("glob")) tools.push(makeSubagentGlob(workspace));
  if (permitted.has("grep")) tools.push(makeSubagentGrep(workspace));
  return tools.map((tool) => {
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        try {
          return await execute(toolCallId, params, signal, onUpdate);
        } catch (error) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("Subagent workspace operation cancelled.");
          }
          if (
            typeof (error as NodeJS.ErrnoException | undefined)?.code === "string" ||
            (error instanceof Error &&
              (error.message.includes(workspace.lexical) ||
                (workspace.canonical !== null && error.message.includes(workspace.canonical))))
          ) {
            throw new Error("The requested workspace operation could not be completed safely.");
          }
          throw error;
        }
      },
    };
  });
}
