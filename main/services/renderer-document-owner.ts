export interface RendererDocumentOwner {
  id: number;
  documentId: string;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  onInvalidated(listener: () => void): () => void;
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

  return {
    id: sender.id,
    documentId: frameId(frame),
    isDestroyed: () => !isCurrentMainFrame(sender, frame),
    send: (channel, payload) => {
      if (!isCurrentMainFrame(sender, frame)) {
        throw new Error("The renderer document is no longer active.");
      }
      frame.send(channel, payload);
    },
    onInvalidated: (listener) => {
      let active = true;
      const invalidate = (): void => {
        if (!active) return;
        active = false;
        listener();
      };
      const onDestroyed = (): void => invalidate();
      const onRendererGone = (): void => invalidate();
      const onNavigationCommitted = (): void => invalidate();

      sender.once("destroyed", onDestroyed);
      sender.once("render-process-gone", onRendererGone);
      sender.on("did-navigate", onNavigationCommitted);
      if (!isCurrentMainFrame(sender, frame)) invalidate();

      return () => {
        active = false;
        sender.removeListener("destroyed", onDestroyed);
        sender.removeListener("render-process-gone", onRendererGone);
        sender.removeListener("did-navigate", onNavigationCommitted);
      };
    },
  };
}
