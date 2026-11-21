export interface QuickChatSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

export function isTrustedQuickChatSender(
  expectedWebContentsId: number | null,
  expectedUrl: string,
  actual: QuickChatSenderIdentity,
): boolean {
  return (
    expectedWebContentsId !== null &&
    expectedUrl.length > 0 &&
    actual.webContentsId === expectedWebContentsId &&
    actual.isMainFrame &&
    actual.frameUrl === expectedUrl
  );
}
