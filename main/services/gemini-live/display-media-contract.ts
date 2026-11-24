import { rendererDocumentOwner, type RendererDocumentOwner } from "../renderer-document-owner.js";
import { randomUUID } from "node:crypto";

export const GEMINI_LIVE_SYSTEM_PICKER_OPTIONS: Electron.DisplayMediaRequestHandlerOpts = {
  useSystemPicker: true,
};

interface DisplayPermissionDetails {
  isMainFrame: boolean;
  requestingUrl: string;
  mediaType?: "video" | "audio" | "unknown";
  mediaTypes?: Array<"video" | "audio">;
}

export interface GeminiLiveDisplayMediaBinding {
  readonly bindingId: string;
  readonly documentId: string;
  readonly owner: RendererDocumentOwner;
  /**
   * The screen or window the person chose in Aiden's own picker (Linux on
   * X11), or null where the system picker or desktop portal chooses.
   */
  readonly sourceId: string | null;
  allowsDisplayRequest(request: Electron.DisplayMediaRequestHandlerHandlerRequest): boolean;
  allowsPermissionRequest(
    webContents: Electron.WebContents,
    permission: string,
    details: DisplayPermissionDetails,
  ): boolean;
}

function sameFrame(left: Electron.WebFrameMain, right: Electron.WebFrameMain): boolean {
  return (
    left.processId === right.processId &&
    left.routingId === right.routingId &&
    left.frameToken === right.frameToken
  );
}

function liveFrame(frame: Electron.WebFrameMain): boolean {
  try {
    return !frame.isDestroyed() && !frame.detached && frame.parent === null;
  } catch {
    return false;
  }
}

/**
 * Captures the exact renderer document that initiated Live setup. Electron 43's
 * macOS system picker bypasses setDisplayMediaRequestHandler, so both its
 * display-capture permission path and the non-system-picker handler must check
 * this same owner before admitting capture.
 */
export function bindGeminiLiveDisplayMediaDocument(
  event: Electron.IpcMainInvokeEvent,
  sourceId: string | null = null,
): GeminiLiveDisplayMediaBinding {
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Live screen capture requires the active application document."),
  );
  const sender = event.sender;
  const frame = event.senderFrame;
  if (!frame) throw new Error("Live screen capture requires the active application document.");
  const requestingUrl = frame.url;

  const current = (): boolean => {
    try {
      return (
        !owner.isDestroyed() &&
        !sender.isDestroyed() &&
        liveFrame(frame) &&
        sameFrame(sender.mainFrame, frame)
      );
    } catch {
      return false;
    }
  };

  return {
    bindingId: randomUUID(),
    documentId: owner.documentId,
    owner,
    sourceId,
    allowsDisplayRequest: (request) =>
      current() &&
      request.userGesture === true &&
      request.videoRequested === true &&
      request.audioRequested === false &&
      request.frame !== null &&
      liveFrame(request.frame) &&
      sameFrame(request.frame, frame),
    allowsPermissionRequest: (webContents, permission, details) => {
      const audioOnly =
        details.mediaType === "audio" ||
        (details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio");
      // On Linux, getDisplayMedia asks for "media" with no camera or microphone
      // types; the display handler then decides which screen, if any.
      const displayOnly =
        permission === "media" && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0;
      return (
        current() &&
        webContents === sender &&
        (permission === "display-capture" || (permission === "media" && (audioOnly || displayOnly))) &&
        details.isMainFrame === true &&
        details.requestingUrl === requestingUrl
      );
    },
  };
}

export interface DisplayMediaGuardSession {
  setPermissionCheckHandler(
    handler: ((
      webContents: Electron.WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: Electron.PermissionCheckHandlerHandlerDetails,
    ) => boolean) | null,
  ): void;
  setPermissionRequestHandler(
    handler: ((
      webContents: Electron.WebContents,
      permission: string,
      callback: (permissionGranted: boolean) => void,
      details: Electron.PermissionRequest,
    ) => void) | null,
  ): void;
  setDisplayMediaRequestHandler(
    handler:
      | ((
          request: Electron.DisplayMediaRequestHandlerHandlerRequest,
          callback: (streams: Electron.Streams) => void,
        ) => void)
      | null,
    opts?: Electron.DisplayMediaRequestHandlerOpts,
  ): void;
}

const guardedSessions = new WeakMap<object, () => void>();

/**
 * Picks the capture source for an admitted request where no system picker
 * runs (Linux). Null denies the request.
 */
export type GeminiLiveDisplaySourceResolver = (
  binding: GeminiLiveDisplayMediaBinding,
) => Promise<Electron.DesktopCapturerSource | null>;

/**
 * Installs the display-capture boundary once per Electron session. Every
 * display or microphone permission succeeds only for a currently bound Live
 * document. Every unrelated permission is denied while this temporary guard
 * owns the session policy, and disposal restores Electron's default handlers.
 * The macOS system-picker session never dispatches to the fallback handler.
 * Without a resolver (macOS) any such dispatch is denied; with one (Linux) a
 * bound document's request gets the resolver's source, and anything else is
 * denied.
 */
export function installGeminiLiveDisplayMediaGuards(
  electronSession: DisplayMediaGuardSession,
  getBindings: () => readonly GeminiLiveDisplayMediaBinding[],
  resolveSource?: GeminiLiveDisplaySourceResolver,
): () => void {
  const installed = guardedSessions.get(electronSession);
  if (installed) return installed;
  let active = true;
  const dispose = () => {
    if (!active || guardedSessions.get(electronSession) !== dispose) return;
    active = false;
    guardedSessions.delete(electronSession);
    electronSession.setPermissionCheckHandler(null);
    electronSession.setPermissionRequestHandler(null);
    electronSession.setDisplayMediaRequestHandler(null);
  };
  guardedSessions.set(electronSession, dispose);
  electronSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) => {
      if (!webContents) return false;
      return getBindings().some((binding) =>
        binding.allowsPermissionRequest(webContents, String(permission), {
          isMainFrame: details.isMainFrame === true,
          requestingUrl: details.requestingUrl ?? "",
          mediaType: details.mediaType,
        }),
      );
    },
  );
  electronSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaDetails = details as Electron.MediaAccessPermissionRequest;
      callback(
        getBindings().some((binding) =>
          binding.allowsPermissionRequest(webContents, String(permission), {
            isMainFrame: details.isMainFrame === true,
            requestingUrl: details.requestingUrl ?? "",
            mediaTypes: mediaDetails.mediaTypes,
          }),
        ),
      );
    },
  );
  electronSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // macOS shows its system picker and never dispatches here. Elsewhere a
      // resolver may supply the source, but only for a bound Live document's
      // own request, still bound once the source is known.
      const binding = resolveSource
        ? getBindings().find((candidate) => candidate.allowsDisplayRequest(request))
        : undefined;
      if (!resolveSource || !binding) {
        callback({});
        return;
      }
      resolveSource(binding).then(
        (source) => {
          const stillBound =
            active && getBindings().includes(binding) && binding.allowsDisplayRequest(request);
          callback(source && stillBound ? { video: source } : {});
        },
        () => callback({}),
      );
    },
    GEMINI_LIVE_SYSTEM_PICKER_OPTIONS,
  );
  return dispose;
}
