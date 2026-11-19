// Production wiring for the hidden export and inspect window's session. No
// logic here: what it allows is decided, and tested, in offline-policy.ts.

import { session, type Session } from "electron";
import { DESIGN_SCHEME } from "../../../renderer/shared/design-canvas/url.js";
import { GENERATIVE_UI_PROTOCOL_SCHEME } from "../../../renderer/shared/generative-ui.js";
import { generativeUiProtocolResponse } from "../generative-ui-protocol.js";
import { designGrants } from "./main.js";
import {
  DESIGN_OFFLINE_PARTITION,
  DESIGN_OFFLINE_PROXY,
  designOfflineRequestAllowed,
  withDesignOfflineSandbox,
} from "./offline-policy.js";
import { designProtocolHandler } from "./protocol.js";

let offline: { session: Session; ready: Promise<void> } | null = null;

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
    withDesignOfflineSandbox(await generativeUiProtocolResponse(request)),
  );
  target.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !designOfflineRequestAllowed(details.url) }));
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  target.on("will-download", (event) => event.preventDefault());
  target.setSpellCheckerEnabled(false);
  offline = { session: target, ready: target.setProxy({ ...DESIGN_OFFLINE_PROXY }) };
  return offline;
}
