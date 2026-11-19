// Production wiring for the hidden export and inspect window's session. No
// logic here: what it allows is decided, and tested, in offline-policy.ts.
// DNS prefetch hints bypass the session's proxy; main/index.ts turns them off
// for the whole app with a Blink setting before ready.

import { session, type Session } from "electron";
import { DESIGN_SCHEME } from "../../../renderer/shared/design-canvas/url.js";
import { GENERATIVE_UI_PROTOCOL_SCHEME } from "../../../renderer/shared/generative-ui.js";
import { generativeUiProtocolResponse } from "../generative-ui-protocol.js";
import { designGrants } from "./main.js";
import {
  DESIGN_OFFLINE_PARTITION,
  DESIGN_OFFLINE_PROXY,
  GENERATIVE_UI_OFFLINE_SANDBOX_POLICY,
  designOfflineMissingFile,
  designOfflineRequestAllowed,
  withDesignOfflineSandbox,
} from "./offline-policy.js";
import { designProtocolHandler } from "./protocol.js";

let offline: { session: Session; ready: Promise<void> } | null = null;

/** Who wants to hear of the missing files each window's page asked for, by web contents id. */
const missingFileWatchers = new Map<number, (url: string) => void>();

/**
 * Calls `onMissing` with each workspace file the page in `webContentsId`
 * asked for and the scheme answered as missing, until the returned function
 * is called.
 */
export function watchDesignOfflineMissingFiles(webContentsId: number, onMissing: (url: string) => void): () => void {
  missingFileWatchers.set(webContentsId, onMissing);
  return () => {
    if (missingFileWatchers.get(webContentsId) === onMissing) missingFileWatchers.delete(webContentsId);
  };
}

/**
 * The in-memory session the hidden window draws in, set up once: the two
 * local schemes served with the sandbox policy added, a proxy no connection
 * reaches, every other request refused, every permission and download
 * refused, and no spellcheck dictionary to fetch. Resolves once the proxy is
 * in place, so no page loads before it is.
 */
export function designOfflineSession(): { session: Session; ready: Promise<void> } {
  if (offline) return offline;
  const target = session.fromPartition(DESIGN_OFFLINE_PARTITION, { cache: false });
  const design = designProtocolHandler({ grants: designGrants });
  target.protocol.handle(DESIGN_SCHEME, async (request) => withDesignOfflineSandbox(await design(request)));
  target.protocol.handle(GENERATIVE_UI_PROTOCOL_SCHEME, async (request) =>
    withDesignOfflineSandbox(await generativeUiProtocolResponse(request), GENERATIVE_UI_OFFLINE_SANDBOX_POLICY),
  );
  target.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !designOfflineRequestAllowed(details.url) }));
  target.webRequest.onCompleted((details) => {
    const watcher = details.webContentsId === undefined ? undefined : missingFileWatchers.get(details.webContentsId);
    const missing = watcher ? designOfflineMissingFile(details) : null;
    if (watcher && missing) watcher(missing);
  });
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  target.on("will-download", (event) => event.preventDefault());
  target.setSpellCheckerEnabled(false);
  offline = { session: target, ready: target.setProxy({ ...DESIGN_OFFLINE_PROXY }) };
  return offline;
}
