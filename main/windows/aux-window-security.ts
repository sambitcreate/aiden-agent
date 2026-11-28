export interface AuxSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

export function isTrustedAuxSender(
  expectedWebContentsId: number | null,
  expectedUrl: string,
  actual: AuxSenderIdentity,
): boolean {
  return (
    expectedWebContentsId !== null &&
    expectedUrl.length > 0 &&
    actual.webContentsId === expectedWebContentsId &&
    actual.isMainFrame &&
    actual.frameUrl === expectedUrl
  );
}
