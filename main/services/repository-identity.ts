import path from "node:path";

/**
 * Credential-free repository identity shared by hosts (contract revision 19).
 * Two machines with the same checkout derive the same `canonicalKey`, so a
 * controller can group one repository's workspaces across hosts. Nothing here
 * runs Git or reads the filesystem: inputs come from the Git service's cache.
 */
export interface RepositoryIdentity {
  /** `host/owner/name`, lowercase host, no scheme, port, userinfo, query or `.git`. */
  canonicalKey: string;
  /** POSIX path of the workspace folder inside the repository; `""` at the root. */
  relativePath: string;
}

const MAX_URL_LENGTH = 2_048;
const MAX_KEY_LENGTH = 512;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._~+-]{1,255}$/u;
const NETWORK_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

function canonicalPath(raw: string): string | undefined {
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const last = segments.length - 1;
  segments[last] = segments[last]!.replace(/\.git$/u, "");
  if (
    segments.some((segment) =>
      segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))
  ) {
    return undefined;
  }
  return segments.join("/");
}

/**
 * Canonical key for a remote URL, or undefined for anything that is not a
 * network remote (local paths, `file:`, transport helpers) or does not
 * normalize safely. Credentials never survive: userinfo, query and fragment
 * are discarded rather than parsed.
 */
export function canonicalRepositoryKey(url: string): string | undefined {
  const value = url.trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\s\p{Cc}]/u.test(value)) return undefined;
  if (value.startsWith("/") || value.startsWith(".") || value.startsWith("~")) return undefined;
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\")) return undefined;
  let host: string;
  let rawPath: string;
  if (value.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (!NETWORK_SCHEMES.has(parsed.protocol)) return undefined;
    host = parsed.hostname.toLowerCase();
    try {
      rawPath = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  } else {
    // scp-like `[user@]host:path`. `::` marks a transport helper (`ext::`).
    const match = /^(?:[^@/:]+@)?([^@/:]+):(?!:)(.+)$/u.exec(value);
    if (!match) return undefined;
    host = match[1]!.toLowerCase();
    rawPath = match[2]!;
  }
  if (!HOST.test(host)) return undefined;
  const repositoryPath = canonicalPath(rawPath);
  if (!repositoryPath) return undefined;
  const key = `${host}/${repositoryPath}`;
  return key.length <= MAX_KEY_LENGTH ? key : undefined;
}

/**
 * The workspace folder's path inside its repository, POSIX-separated, `""`
 * at the root. Undefined when the folder is outside the repository.
 */
export function repositoryRelativePath(topLevel: string, folderPath: string): string | undefined {
  const relative = path.relative(topLevel, folderPath);
  if (relative === "") return "";
  if (path.isAbsolute(relative)) return undefined;
  const segments = relative.split(path.sep);
  if (segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
    return undefined;
  }
  return segments.join("/");
}

/** The remote a repository is known by: `origin`, else its only remote. */
export function primaryRemoteUrl(remoteVerbose: string): string | undefined {
  const fetchUrls = new Map<string, string>();
  for (const line of remoteVerbose.split("\n")) {
    const match = /^(\S+)\t(\S+) \(fetch\)$/u.exec(line.trimEnd());
    if (match && !fetchUrls.has(match[1]!)) fetchUrls.set(match[1]!, match[2]!);
  }
  if (fetchUrls.has("origin")) return fetchUrls.get("origin");
  return fetchUrls.size === 1 ? [...fetchUrls.values()][0] : undefined;
}
