import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";

export interface RendererDocumentOwner {
  id: number;
  documentId: string;
  isDestroyed(): boolean;
  send(channel: NotificationChannel, payload: unknown): void;
  onInvalidated(listener: () => void): () => void;
}

interface RendererDocumentState {
  epoch: object;
  listeners: Set<() => void>;
}

const rendererDocumentStates = new WeakMap<Electron.WebContents, RendererDocumentState>();

function reportInvalidationFailure(): void {
  try {
    writeDiagnosticEvent({
      level: "error",
      area: "renderer",
      event: "renderer-invalidation-listener-failed",
      outcome: "failed",
      code: "internal-error",
    });
  } catch {
    // Revocation must not depend on diagnostics being available.
  }
}

function rendererDocumentState(sender: Electron.WebContents): RendererDocumentState {
  const existing = rendererDocumentStates.get(sender);
  if (existing) return existing;

  const state: RendererDocumentState = {
    epoch: {},
    listeners: new Set(),
  };
  const invalidate = (): void => {
    state.epoch = {};
    for (const listener of [...state.listeners]) listener();
  };
  const onDestroyed = (): void => {
    invalidate();
    sender.removeListener("did-navigate", invalidate);
    sender.removeListener("render-process-gone", invalidate);
    rendererDocumentStates.delete(sender);
  };
  sender.on("did-navigate", invalidate);
  sender.on("render-process-gone", invalidate);
  sender.once("destroyed", onDestroyed);
  rendererDocumentStates.set(sender, state);
  return state;
}

function frameId(frame: Electron.WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}:${frame.frameToken}`;
}

function sameFrame(left: Electron.WebFrameMain, right: Electron.WebFrameMain): boolean {
  return (
    left.processId === right.processId &&
    left.routingId === right.routingId &&
    left.frameToken === right.frameToken
  );
}

function isCurrentMainFrame(sender: Electron.WebContents, frame: Electron.WebFrameMain): boolean {
  try {
    return (
      !sender.isDestroyed() &&
      !frame.isDestroyed() &&
      !frame.detached &&
      frame.parent === null &&
      sameFrame(sender.mainFrame, frame)
    );
  } catch {
    return false;
  }
}

/** Capture the exact active main-frame document behind an interactive IPC request. */
export function rendererDocumentOwner(
  event: Electron.IpcMainInvokeEvent,
  invalidRequest: () => Error,
): RendererDocumentOwner {
  const sender = event.sender;
  const frame = event.senderFrame;
  if (
    !frame ||
    event.processId !== frame.processId ||
    event.frameId !== frame.routingId ||
    !isCurrentMainFrame(sender, frame)
  ) {
    throw invalidRequest();
  }

  const documentState = rendererDocumentState(sender);
  const documentEpoch = documentState.epoch;
  const isInvalidated = (): boolean =>
    documentState.epoch !== documentEpoch || !isCurrentMainFrame(sender, frame);

  return {
    id: sender.id,
    documentId: frameId(frame),
    isDestroyed: isInvalidated,
    send: (channel, payload) => {
      if (isInvalidated()) {
        throw new Error("The renderer document is no longer active.");
      }
      frame.send(channel, payload);
    },
    onInvalidated: (listener) => {
      let active = true;
      const invalidate = (): void => {
        if (!active) return;
        active = false;
        documentState.listeners.delete(invalidate);
        try {
          listener();
        } catch {
          reportInvalidationFailure();
        }
      };

      documentState.listeners.add(invalidate);
      if (isInvalidated()) invalidate();

      return () => {
        active = false;
        documentState.listeners.delete(invalidate);
      };
    },
  };
}
