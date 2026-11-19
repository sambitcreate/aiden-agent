// What the hidden export and inspect window's own session lets a page reach.
// Pure, so the tests read the decisions directly; offline-session.ts applies
// them to an Electron session.
//
// The aiden-design and aiden-genui policies already allow no network, but a
// CSP does not cover everything a page can do: Electron 43 does not know the
// `webrtc` directive, so an RTCPeerConnection could still send STUN packets.
// The window therefore draws in a session of its own that has no route out.

import { DESIGN_SCHEME } from "../../../renderer/shared/design-canvas/url.js";
import { GENERATIVE_UI_PROTOCOL_SCHEME } from "../../../renderer/shared/generative-ui.js";

/** In memory only: no `persist:` prefix, so nothing it stores outlives the run. */
export const DESIGN_OFFLINE_PARTITION = "aiden-design-offline";

/**
 * Every proxied connection goes to port 0, which no connection can reach, and
 * loopback is proxied too (Chromium would otherwise go direct to it). The
 * custom schemes are answered in-process and never meet the proxy. With the
 * WebRTC policy `disable_non_proxied_udp`, WebRTC may only use TCP through this
 * proxy, so it has no way out at all.
 */
export const DESIGN_OFFLINE_PROXY = {
  mode: "fixed_servers",
  proxyRules: "http://127.0.0.1:0",
  proxyBypassRules: "<-loopback>",
} as const;

/**
 * Added to every response the session serves, beside the scheme's own policy.
 * The page keeps its origin and scripts, but cannot open alert, confirm,
 * prompt or print (no `allow-modals`), popups, forms, downloads or the top
 * window's address, so nothing it does can show or wait for a dialog.
 */
export const DESIGN_OFFLINE_SANDBOX_POLICY = "sandbox allow-scripts allow-same-origin";

const ALLOWED_SCHEMES = new Set([`${DESIGN_SCHEME}:`, `${GENERATIVE_UI_PROTOCOL_SCHEME}:`, "data:", "about:"]);

/** Whether the window may make this request: only Aiden's own local schemes, inline data and blobs made from them. */
export function designOfflineRequestAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "blob:") {
    // A blob's address names the origin that made it.
    return designOfflineRequestAllowed(url.slice("blob:".length));
  }
  if (parsed.protocol === "about:") return parsed.pathname === "blank" || parsed.pathname === "srcdoc";
  return ALLOWED_SCHEMES.has(parsed.protocol);
}

/** The same response with the offline sandbox policy added beside its own. */
export function withDesignOfflineSandbox(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append("content-security-policy", DESIGN_OFFLINE_SANDBOX_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Chromium's own notes about the window rather than about the page: a dialog
 * the sandbox kept from opening, and the `webrtc` directive Electron 43 does
 * not know. The page's author can't act on them, so inspect drops them.
 */
export function isDesignOfflineNotice(message: string): boolean {
  return (
    /^Ignored call to '[^']*'\. The document is sandboxed/u.test(message) ||
    message.startsWith("Unrecognized Content-Security-Policy directive 'webrtc'")
  );
}

/**
 * A workspace file the page asked for that its scheme answered as missing,
 * or null. Chromium logs nothing for a missing script or a module's missing
 * import, so inspect reads the session's answers instead. The page's own
 * address is left out: a page that is not there fails the inspect itself.
 */
export function designOfflineMissingFile(details: { url: string; statusCode: number; resourceType: string }): string | null {
  if (details.statusCode < 400 || details.resourceType === "mainFrame") return null;
  return details.url.startsWith(`${DESIGN_SCHEME}://`) ? details.url : null;
}
