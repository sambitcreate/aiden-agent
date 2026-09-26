import type { Session, WebContents } from "electron";

interface BrowserPermissionContext {
  permission: string;
  guestUrl?: string;
  isMainFrame?: boolean;
  requestingUrl?: string;
}

function webOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Guest pages receive no device, clipboard-read or background notification grants. */
export function canGrantBrowserPermission(
  context: BrowserPermissionContext & (
    { kind: "check"; requestingOrigin: string } | { kind: "request" }
  ),
): boolean {
  if (context.permission !== "clipboard-sanitized-write" || context.isMainFrame !== true) return false;
  const origin = webOrigin(context.guestUrl);
  if (!origin || webOrigin(context.requestingUrl) !== origin) return false;
  return context.kind === "request" || webOrigin(context.requestingOrigin) === origin;
}

/** Both Electron paths use the same policy; denied checks can otherwise become requests. */
export function configureBrowserPermissionHandlers(
  browserSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  getOwnedGuestUrl: (contents: WebContents | null) => string | undefined,
): void {
  const ownedUrl = (contents: WebContents | null) => {
    try {
      return getOwnedGuestUrl(contents);
    } catch {
      // A guest can be destroyed while Chromium is checking its permissions.
      return undefined;
    }
  };
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    canGrantBrowserPermission({
      kind: "check", permission, requestingOrigin,
      guestUrl: ownedUrl(contents), isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl,
    }),
  );
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(canGrantBrowserPermission({
      kind: "request", permission,
      guestUrl: ownedUrl(contents), isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl,
    })),
  );
}
