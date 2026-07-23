export interface PillSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

export function isTrustedPillSender(
  expectedWebContentsId: number | null,
  expectedUrl: string,
  actual: PillSenderIdentity,
): boolean {
  return (
    expectedWebContentsId !== null &&
    actual.webContentsId === expectedWebContentsId &&
    actual.isMainFrame &&
    actual.frameUrl === expectedUrl
  );
}
