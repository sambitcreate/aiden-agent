import type { BrowserLinkOpening } from "../shared/browser";

export interface LinkModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface LinkRouteInput {
  href: string;
  modifiers: LinkModifiers;
  preference: BrowserLinkOpening;
  browserAvailable: boolean;
  /** data-link-target="external" */
  forceExternal?: boolean;
  /** aiden-ui / restricted Markdown */
  forcePrompt?: boolean;
  /** The active workspace's folder, so absolute paths inside it count as workspace files. */
  workspaceFolder?: string | null;
}

export type LinkRoute =
  | { kind: "browser" | "external"; url: string }
  | { kind: "ask"; url: string; remember: boolean; inApp: boolean }
  /**
   * A local file or folder. `path` is what the Aiden browser opens; `workspacePath`
   * is the same file relative to the workspace folder ("" for the folder itself),
   * or null when it is outside the workspace.
   */
  | { kind: "file"; path: string; preview: boolean; workspacePath: string | null };

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function webUrl(href: string): URL | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

// `name.ext:12` is a file and line, not a URL scheme.
const BARE_FILE_LINE = /^[\w-][\w.-]*\.[a-z\d]+:\d+(?::\d+)?$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const PREVIEW_EXTENSION = /\.(?:html?|pdf)$/i;

/** True for a Markdown link target that names a local file and must survive URL sanitizing. */
export function isLocalFileHref(href: string): boolean {
  return /^file:/i.test(href) || BARE_FILE_LINE.test(href);
}

function decodedPath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function hrefPath(href: string): string | null {
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && url.hostname.toLowerCase() !== "localhost") return null;
      const path = decodedPath(url.pathname);
      // file:///C:/x names the Windows path C:/x.
      return path?.replace(/^\/([a-z]:\/)/i, "$1") ?? null;
    } catch {
      return null;
    }
  }
  if (!BARE_FILE_LINE.test(href) && /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return null;
  const raw = href.split(/[?#]/, 1)[0];
  return raw ? decodedPath(raw) : null;
}

const isAbsolutePath = (path: string) => path.startsWith("/") || /^[a-z]:\//i.test(path);

/**
 * `path` relative to `folder` with `.` and `..` resolved, "" for the folder
 * itself, or null when it leaves the folder.
 */
export function workspaceRelativePath(path: string, folder: string | null | undefined): string | null {
  let rest = path.replace(/\\/g, "/");
  if (isAbsolutePath(rest)) {
    const root = folder?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root || (rest !== root && !rest.startsWith(`${root}/`))) return null;
    rest = rest.slice(root.length);
  }
  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (!segments.pop()) return null;
  }
  return segments.join("/");
}

function fileRoute(href: string, workspaceFolder: string | null | undefined): LinkRoute | null {
  const decoded = hrefPath(href);
  if (!decoded) return null;
  const path = decoded.replace(LINE_SUFFIX, "");
  // `~/x` is the home folder, not a workspace folder named "~".
  const workspacePath = path.startsWith("~") ? null : workspaceRelativePath(path, workspaceFolder);
  // An absolute path outside the workspace with no file extension (an app
  // route such as /settings) is not treated as a file.
  if (workspacePath === null && isAbsolutePath(path) && !/^file:/i.test(href) && !/\.[^/]+$/.test(path)) return null;
  return { kind: "file", path, preview: PREVIEW_EXTENSION.test(path), workspacePath };
}

export function resolveLinkOpen(input: LinkRouteInput): LinkRoute | null {
  const { href, modifiers, preference, browserAvailable } = input;
  if (/^mailto:/i.test(href)) {
    try {
      return { kind: "external", url: new URL(href).href };
    } catch {
      return null;
    }
  }
  const url = webUrl(href);
  if (!url) return browserAvailable ? fileRoute(href, input.workspaceFolder) : null;
  const flip = modifiers.metaKey || modifiers.ctrlKey;
  if (input.forceExternal) return { kind: "external", url: url.href };
  if (input.forcePrompt)
    return flip
      ? { kind: "external", url: url.href }
      : { kind: "ask", url: url.href, remember: false, inApp: browserAvailable };
  if (!browserAvailable) return { kind: "external", url: url.href };
  const base: BrowserLinkOpening = isLoopbackHost(url.hostname) ? "browser" : preference;
  if (flip) return { kind: base === "external" ? "browser" : "external", url: url.href };
  if (base === "ask") return { kind: "ask", url: url.href, remember: true, inApp: true };
  return { kind: base, url: url.href };
}
