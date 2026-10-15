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
}

export type LinkRoute =
  | { kind: "browser" | "external"; url: string }
  | { kind: "ask"; url: string; remember: boolean; inApp: boolean }
  | { kind: "file"; path: string };

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

function filePath(href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return null;
  const path = href.split(/[?#]/, 1)[0];
  if (!/\.(?:html?|pdf)$/i.test(path)) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
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
  if (!url) {
    const path = browserAvailable ? filePath(href) : null;
    return path ? { kind: "file", path } : null;
  }
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
