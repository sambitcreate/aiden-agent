/** Host-owned Generative UI artifact limits and iframe containment constants. */

export const MAX_HTML_ARTIFACT_BYTES = 512 * 1024;
export const MAX_HTML_ARTIFACT_TITLE_CHARS = 120;
export const MAX_HTML_ARTIFACTS_PER_RESPONSE = 4;
export const MAX_HTML_ARTIFACTS_PER_CHAT = 40;
export const MAX_HTML_ARTIFACT_BYTES_PER_CHAT = 8 * 1024 * 1024;
export const HTML_ARTIFACT_MIME_TYPE = "text/html" as const;

/** Unique-origin guest: scripts allowed, no parent origin, no forms/popups/downloads. */
export const GENERATIVE_UI_IFRAME_SANDBOX = "allow-scripts" as const;

/**
 * Guest document CSP. Network, frames, and forms are denied. Host libraries may
 * load only from the `aiden-genui:` protocol registered by main.
 */
export const GENERATIVE_UI_GUEST_CSP =
  "default-src 'none'; script-src 'unsafe-inline' aiden-genui://chart.js aiden-genui://plotly.js aiden-genui://katex.js; style-src 'unsafe-inline' aiden-genui://katex.css; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src data:; webrtc 'block'";

/** Offline export has inlined libraries, so the custom protocol is not needed. */
export const GENERATIVE_UI_EXPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src data:; webrtc 'block'";

/** Parent may embed aiden-genui preview documents, not arbitrary https frames. */
export const GENERATIVE_UI_PARENT_FRAME_SRC = "'self' aiden-genui:" as const;

export const GENERATIVE_UI_PROTOCOL_SCHEME = "aiden-genui" as const;
export const GENERATIVE_UI_PREVIEW_HOST = "preview" as const;


export const GENERATIVE_UI_HOST_LIBS = ["chart.js", "plotly.js", "katex.js", "katex.css"] as const;

export const GENERATIVE_UI_UNSUPPORTED_DEVICE_COPY =
  "Can't view on this device. View in Aiden Agent." as const;

export function isHtmlArtifactTitle(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HTML_ARTIFACT_TITLE_CHARS) {
    return false;
  }
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function isHtmlArtifactMediaId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  return /^[A-Za-z0-9._:-]+$/u.test(value);
}

export function generativeUiHostLibraryNameFromUrl(urlString: string): (typeof GENERATIVE_UI_HOST_LIBS)[number] | undefined {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${GENERATIVE_UI_PROTOCOL_SCHEME}:`) return undefined;
  if (url.pathname !== "" && url.pathname !== "/") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  let name: string;
  try {
    name = decodeURIComponent(url.hostname || url.pathname.replace(/^\//u, ""));
  } catch {
    return undefined;
  }
  return GENERATIVE_UI_HOST_LIBS.find((item) => item === name);
}

const PREVIEW_TOKEN = /^[A-Fa-f0-9]{64}$/u;

export function generativeUiPreviewTokenFromUrl(urlString: string): string | undefined {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${GENERATIVE_UI_PROTOCOL_SCHEME}:`) return undefined;
  if (url.hostname !== GENERATIVE_UI_PREVIEW_HOST) return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  const token = url.pathname.replace(/^\//u, "");
  if (token.includes("/")) return undefined;
  return PREVIEW_TOKEN.test(token) ? token.toLowerCase() : undefined;
}
