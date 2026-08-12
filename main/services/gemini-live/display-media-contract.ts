import { rendererDocumentOwner, type RendererDocumentOwner } from "../renderer-document-owner.js";

export const GEMINI_LIVE_SYSTEM_PICKER_OPTIONS: Electron.DisplayMediaRequestHandlerOpts = {
  useSystemPicker: true,
};

interface DisplayPermissionDetails {
  isMainFrame: boolean;
  requestingUrl: string;
}

export interface GeminiLiveDisplayMediaBinding {
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
      permission === "display-capture" &&
      details.isMainFrame === true &&
      details.requestingUrl === requestingUrl,
  };
}
