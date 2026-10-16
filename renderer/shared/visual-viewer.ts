/**
 * The phone visual viewer (Remote contract revision 34, `chat-visual-viewer-v1`).
 *
 * The Mac serves one self-contained HTML document per visual; iOS and Android
 * load it into a locked-down web view. The document carries its payload as
 * JSON and talks to the native host only through one message channel. This
 * module is shared by the document builder in main and the viewer page.
 */
import type { ChatUiVisualV1 } from "./aiden-ui/types.js";
import type { AppearanceScheme, ThemePresetId } from "./appearance.js";

export const VISUAL_VIEWER_PAYLOAD_ELEMENT_ID = "aiden-visual-payload" as const;
/** iOS: `window.webkit.messageHandlers.aidenVisual.postMessage(object)`. */
export const VISUAL_VIEWER_IOS_HANDLER = "aidenVisual" as const;
/** Android: `window.AidenVisualBridge.postMessage(jsonString)`. */
export const VISUAL_VIEWER_ANDROID_BRIDGE = "AidenVisualBridge" as const;

/**
 * The viewer page runs only its own inline bundle and frames only its HTML
 * guest's srcdoc. Nothing loads from the network. The guest's own CSP (inside
 * its srcdoc) still applies on top of this one.
 */
export const VISUAL_VIEWER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src about:srcdoc; child-src about:srcdoc; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src data:";

interface VisualViewerPayloadBase {
  version: 1;
  title: string;
  scheme: AppearanceScheme;
  preset: ThemePresetId;
  layout?: "wide";
}

export type VisualViewerPayload =
  | (VisualViewerPayloadBase & {
      kind: "ui";
      visual: ChatUiVisualV1;
      /** The message images the visual shows, as base64 data. */
      attachments: { id: string; mimeType: string; data: string }[];
    })
  | (VisualViewerPayloadBase & {
      kind: "html";
      /** The wrapped guest document (host libraries inlined), framed as srcdoc. */
      guest: string;
    });

/** Messages the page sends to its native host. A closed set: hosts ignore anything else. */
export type VisualViewerNativeMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "openUrl"; url: string };

interface NativeChannels {
  webkit?: { messageHandlers?: Record<string, { postMessage(value: unknown): void } | undefined> };
  AidenVisualBridge?: { postMessage(value: string): void };
}

/**
 * Sends a message to whichever native host loaded the page. Returns false in a
 * plain browser (no channel), so callers can fall back or do nothing.
 */
export function postVisualViewerMessage(message: VisualViewerNativeMessage, target: unknown = globalThis): boolean {
  const channels = target as NativeChannels;
  const ios = channels.webkit?.messageHandlers?.[VISUAL_VIEWER_IOS_HANDLER];
  if (ios) {
    ios.postMessage(message);
    return true;
  }
  const android = channels[VISUAL_VIEWER_ANDROID_BRIDGE];
  if (android) {
    android.postMessage(JSON.stringify(message));
    return true;
  }
  return false;
}

/** The only links a visual may ask its host to open. */
export function isViewerOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
