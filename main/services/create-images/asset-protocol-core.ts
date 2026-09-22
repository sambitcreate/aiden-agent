const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export interface CreateImagesAssetProtocolRequest {
  token: string;
  rendition: "preview" | "preview-128" | "preview-256" | "preview-512" | "original";
}

export function parseCreateImagesAssetProtocolRequest(
  value: string,
): CreateImagesAssetProtocolRequest | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "aiden-asset:" ||
      url.hostname !== "asset" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    const match = /^\/([A-Za-z0-9_-]{32,128})(?:\/(original|preview-(?:128|256|512)))?$/u.exec(
      url.pathname,
    );
    const token = match?.[1];
    if (!token || !GRANT_TOKEN_PATTERN.test(token)) return undefined;
    return {
      token,
      rendition:
        match[2] === "original" ||
        match[2] === "preview-128" ||
        match[2] === "preview-256" ||
        match[2] === "preview-512"
          ? match[2]
          : "preview",
    };
  } catch {
    return undefined;
  }
}

export function parseCreateImagesAssetProtocolToken(value: string): string | undefined {
  return parseCreateImagesAssetProtocolRequest(value)?.token;
}

export function createImagesProtocolDocumentId(frame: {
  processId: number;
  routingId: number;
  frameToken: string;
  parent: unknown;
  detached: boolean;
}): string | undefined {
  if (
    frame.detached ||
    frame.parent !== null ||
    !Number.isInteger(frame.processId) ||
    !Number.isInteger(frame.routingId) ||
    typeof frame.frameToken !== "string" ||
    frame.frameToken.length === 0
  ) {
    return undefined;
  }
  return `${frame.processId}:${frame.routingId}:${frame.frameToken}`;
}

export function authorizeCreateImagesAssetRequest(
  details: {
    url: string;
    method: string;
    resourceType: string;
    webContentsId?: number;
    frame?: {
      processId: number;
      routingId: number;
      frameToken: string;
      parent: unknown;
      detached: boolean;
    } | null;
  },
  authorize: (token: string, webContentsId: number, documentId: string) => boolean,
): boolean {
  const token = parseCreateImagesAssetProtocolToken(details.url);
  const documentId = details.frame ? createImagesProtocolDocumentId(details.frame) : undefined;
  return (
    details.method === "GET" &&
    details.resourceType === "image" &&
    token !== undefined &&
    documentId !== undefined &&
    details.webContentsId !== undefined &&
    authorize(token, details.webContentsId, documentId)
  );
}
