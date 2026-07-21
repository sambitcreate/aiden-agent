import {
  ProviderAuthRequestError,
  type ProviderAuthOwner,
} from "./provider-auth-flow-core.js";

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

function isCurrentMainFrame(
  sender: Electron.WebContents,
  frame: Electron.WebFrameMain,
): boolean {
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

/** Bind an interactive flow to the exact renderer document that invoked it. */
export function providerAuthOwner(event: Electron.IpcMainInvokeEvent): ProviderAuthOwner {
  const sender = event.sender;
  const frame = event.senderFrame;
  if (
    !frame ||
    event.processId !== frame.processId ||
    event.frameId !== frame.routingId ||
    !isCurrentMainFrame(sender, frame)
  ) {
    throw new ProviderAuthRequestError(
      "Provider authentication must start from the active application document.",
    );
  }

  return {
    id: sender.id,
    documentId: frameId(frame),
    isDestroyed: () => !isCurrentMainFrame(sender, frame),
    send: (channel, payload) => {
      if (!isCurrentMainFrame(sender, frame)) {
        throw new Error("Provider authentication document is no longer active.");
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
      // Unlike did-start-navigation, this fires only after a main-frame
      // navigation commits. Prevented external links therefore keep auth alive.
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
