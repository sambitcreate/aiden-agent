// Shared trusted-sender check for Aiden's privileged auxiliary windows (the
// dictation pill and the Aiden assistant window). A privileged channel must only
// answer the exact window it was created for: the right webContents, its own
// main frame, still sitting on the URL we loaded.

export interface WindowSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

export function isTrustedWindowSender(
  expectedWebContentsId: number | null,
  expectedUrl: string,
  actual: WindowSenderIdentity,
): boolean {
  return (
    expectedWebContentsId !== null &&
    actual.webContentsId === expectedWebContentsId &&
    actual.isMainFrame &&
    actual.frameUrl === expectedUrl
  );
}
