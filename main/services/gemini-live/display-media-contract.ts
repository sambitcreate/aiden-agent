import { rendererDocumentOwner, type RendererDocumentOwner } from "../renderer-document-owner.js";
import { randomUUID } from "node:crypto";

export const GEMINI_LIVE_SYSTEM_PICKER_OPTIONS: Electron.DisplayMediaRequestHandlerOpts = {
  useSystemPicker: true,
};

interface DisplayPermissionDetails {
  isMainFrame: boolean;
  requestingUrl: string;
}

export interface GeminiLiveDisplayMediaBinding {
  readonly bindingId: string;
  readonly documentId: string;
  readonly owner: RendererDocumentOwner;
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
    allowsDisplayRequest: (request) =>
      current() &&
      request.userGesture === true &&
      request.videoRequested === true &&
      request.audioRequested === false &&
      request.frame !== null &&
      liveFrame(request.frame) &&
      sameFrame(request.frame, frame),
    allowsPermissionRequest: (webContents, permission, details) =>
      current() &&
      webContents === sender &&
      (permission === "display-capture" || permission === "media") &&
      details.isMainFrame === true &&
      details.requestingUrl === requestingUrl,
  };
}

interface DisplayMediaGuardSession {
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
 * Installs the display-capture boundary once per Electron session. Every
 * display or microphone permission succeeds only for a currently bound Live
 * document. Every unrelated permission is denied while this temporary guard
 * owns the session policy, and disposal restores Electron's default handlers.
 * The system-picker session never dispatches to the fallback handler; any
 * non-picker dispatch is denied rather than trusted to select a source.
 */
export function installGeminiLiveDisplayMediaGuards(
  electronSession: DisplayMediaGuardSession,
  getBindings: () => readonly GeminiLiveDisplayMediaBinding[],
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
        }),
      );
    },
  );
  electronSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        getBindings().some((binding) =>
          binding.allowsPermissionRequest(webContents, String(permission), {
            isMainFrame: details.isMainFrame === true,
            requestingUrl: details.requestingUrl ?? "",
          }),
        ),
      );
    },
  );
  electronSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      callback({});
    },
    GEMINI_LIVE_SYSTEM_PICKER_OPTIONS,
  );
  return dispose;
}
