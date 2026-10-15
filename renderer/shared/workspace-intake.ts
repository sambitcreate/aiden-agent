// Contract for adding a workspace from a typed path or a cloned repository.
//
// Shared by main (which validates everything again) and the renderer workspace
// menu. Kept free of Node and Electron imports so both sides can use it.

/** Why a typed path cannot be opened. `reason` is the user-facing sentence. */
export type WorkspacePathInvalidCode =
  | "empty"
  | "too-long"
  | "invalid-characters"
  | "unsupported-prefix"
  | "no-relative-base"
  | "not-a-folder"
  | "parent-missing"
  | "parent-not-a-folder"
  | "permission-denied"
  | "unreadable";

/** Read-only answer to "what would opening this path do?". Nothing is created. */
export type WorkspacePathInspection =
  | { kind: "existing-workspace"; workspaceId: string; path: string }
  | { kind: "folder"; path: string; isGitRepo: boolean }
  | { kind: "creatable"; path: string }
  | { kind: "invalid"; code: WorkspacePathInvalidCode; reason: string };

export type WorkspaceOpenPathFailureCode =
  | WorkspacePathInvalidCode
  | "missing"
  | "create-failed"
  | "register-failed";

export type WorkspaceOpenPathResult<W> =
  | { ok: true; workspace: W; created: boolean; existing: boolean }
  | { ok: false; code: WorkspaceOpenPathFailureCode; reason: string };

export type WorkspaceCloneFailureCode =
  | "invalid-url"
  | "invalid-destination"
  | "destination-exists"
  | "busy"
  | "cancelled"
  | "timeout"
  | "auth-failed"
  | "host-key"
  | "not-found"
  | "network"
  | "git-unavailable"
  | "failed"
  | "register-failed";

export type WorkspaceClonePreview =
  | { ok: true; url: string; repoName: string; destination: string }
  | { ok: false; code: "invalid-url"; reason: string };

/** One clone progress line, sent only to the document that started the clone. */
export interface WorkspaceCloneProgress {
  cloneId: string;
  /** Git's phase label, e.g. "Receiving objects". */
  phase: string;
  /** 0–100 when Git reports a percentage for the phase. */
  percent?: number;
}

export type WorkspaceCloneResult<W> =
  | { ok: true; workspace: W; destination: string }
  | {
      ok: false;
      code: WorkspaceCloneFailureCode;
      reason: string;
      /** Last line Git printed, with credentials and the home folder redacted. */
      detail?: string;
      /** Set when the repository is on disk but could not be registered. */
      destination?: string;
    };

export const WORKSPACE_CLONE_URL_MAX_LENGTH = 2_048;
const CLONE_ID = /^[A-Za-z0-9_-]{8,64}$/u;

/** Validate a renderer-chosen clone id used to route progress and cancel. */
export function workspaceCloneId(value: unknown): string {
  if (typeof value !== "string" || !CLONE_ID.test(value)) {
    throw new Error("Invalid clone identifier.");
  }
  return value;
}

export type ParsedCloneUrl =
  | { ok: true; url: string; repoName: string }
  | { ok: false; reason: string };

const INVALID_URL = "Enter an https:// or SSH repository URL, or owner/repo for GitHub.";
const REPO_NAME = /^[A-Za-z0-9._-]+$/u;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([^:/\s]+):(.+)$/u;
const SCP_PATH = /^[A-Za-z0-9._~/-]+$/u;

/**
 * The repository name becomes the default destination folder, so it must be a
 * plain visible name. Leading dots are refused: `x/.git.git` would otherwise
 * name `.git` (or `.GIT` on a case-insensitive disk) and turn the clone base
 * itself into a repository with the remote's config.
 */
export function safeRepoName(value: string): string | undefined {
  const name = value.replace(/\.git$/iu, "");
  if (!name || name.startsWith(".") || !REPO_NAME.test(name)) return undefined;
  return name;
}

function repoNameFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? safeRepoName(last) : undefined;
}

function hasUnsafePathSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === ".." || segment.startsWith("-"));
}

/**
 * Accept only network clone sources the user typed: `https://host/path`,
 * `ssh://[user@]host[:port]/path`, `user@host:path`, or GitHub `owner/repo`.
 * Local paths, `file://`, `ext::`/`fd::` transports, plain http, embedded
 * credentials and option-looking values are rejected before Git sees them.
 */
export function parseCloneUrl(value: unknown): ParsedCloneUrl {
  if (typeof value !== "string") return { ok: false, reason: INVALID_URL };
  const typed = value.trim();
  if (!typed) return { ok: false, reason: "Enter a repository URL." };
  if (typed.length > WORKSPACE_CLONE_URL_MAX_LENGTH) {
    return { ok: false, reason: "That repository URL is too long." };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/u.test(typed)) {
    return { ok: false, reason: "Repository URLs cannot contain spaces or control characters." };
  }
  if (typed.startsWith("-")) return { ok: false, reason: INVALID_URL };
  if (typed.includes("::")) return { ok: false, reason: INVALID_URL };

  const shorthand = /^([^/]+)\/([^/]+)$/u.exec(typed);
  if (shorthand && !typed.includes(":") && !typed.includes("@")) {
    const [, owner, rawRepo] = shorthand;
    const repo = safeRepoName(rawRepo);
    if (!GITHUB_OWNER.test(owner) || !repo) return { ok: false, reason: INVALID_URL };
    return { ok: true, url: `https://github.com/${owner}/${repo}.git`, repoName: repo };
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(typed)?.[1]?.toLowerCase();
  if (scheme === "https" || scheme === "ssh") {
    let url: URL;
    try {
      url = new URL(typed);
    } catch {
      return { ok: false, reason: INVALID_URL };
    }
    if (url.search || url.hash) return { ok: false, reason: INVALID_URL };
    if (!url.hostname || url.hostname.startsWith("-")) return { ok: false, reason: INVALID_URL };
    if (!HOST.test(url.hostname) && !/^\[[0-9a-f:.]+\]$/iu.test(url.hostname)) {
      return { ok: false, reason: INVALID_URL };
    }
    if (scheme === "https" && (url.username || url.password)) {
      return {
        ok: false,
        reason: "Remove the credentials from the URL. Git uses your saved credentials.",
      };
    }
    if (scheme === "ssh" && (url.password || url.username.startsWith("-"))) {
      return { ok: false, reason: INVALID_URL };
    }
    if (hasUnsafePathSegment(url.pathname)) return { ok: false, reason: INVALID_URL };
    const repoName = repoNameFromPath(url.pathname);
    if (!repoName) return { ok: false, reason: INVALID_URL };
    return { ok: true, url: url.toString(), repoName };
  }
  if (scheme) return { ok: false, reason: INVALID_URL };

  const scp = SCP_LIKE.exec(typed);
  if (scp) {
    const [, , host, repoPath] = scp;
    if (host.startsWith("-") || !HOST.test(host)) return { ok: false, reason: INVALID_URL };
    if (!SCP_PATH.test(repoPath) || hasUnsafePathSegment(repoPath)) {
      return { ok: false, reason: INVALID_URL };
    }
    const repoName = repoNameFromPath(repoPath);
    if (!repoName) return { ok: false, reason: INVALID_URL };
    return { ok: true, url: typed, repoName };
  }
  return { ok: false, reason: INVALID_URL };
}
