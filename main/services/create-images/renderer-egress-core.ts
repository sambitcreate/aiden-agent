const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function parsed(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function isAidenMainRendererUrl(value: string): boolean {
  const url = parsed(value);
  if (!url) return false;
  if (url.protocol === "file:") return url.pathname.endsWith("/main-window.html");
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.pathname.endsWith("/main-window.html")
  );
}

/** Main-window web content has no direct production network capability. */
export function shouldBlockAidenRendererEgress(input: {
  requestUrl: string;
  rendererUrl: string | undefined;
  packaged: boolean;
}): boolean {
  const request = parsed(input.requestUrl);
  if (!request || !REMOTE_PROTOCOLS.has(request.protocol) || !input.rendererUrl) return false;
  if (!isAidenMainRendererUrl(input.rendererUrl)) return false;
  if (input.packaged) return true;
  return request.hostname !== "127.0.0.1" && request.hostname !== "localhost";
}
