import { protocol, session, webContents } from "electron";
import { isPackagedRuntime } from "../../runtime-mode.js";
import { AssetDeliveryGrantRegistry } from "./asset-delivery-core.js";
import {
  authorizeCreateImagesAssetRequest,
  parseCreateImagesAssetProtocolToken,
} from "./asset-protocol-core.js";
import { shouldBlockAidenRendererEgress } from "./renderer-egress-core.js";

export interface CreateImagesAssetProtocolSource {
  response(assetId: string): Promise<Response | undefined>;
}

let schemeRegistered = false;
let protocolInstalled = false;

export interface CreateImagesRequestPolicyObservation {
  kind: "asset" | "renderer-egress";
  url: string;
  allowed: boolean;
  method: string;
  resourceType: string;
  webContentsIdPresent: boolean;
  framePresent: boolean;
  frameIsMain: boolean;
  frameDetached: boolean;
}

const requestObservers = new Set<(value: CreateImagesRequestPolicyObservation) => void>();

export function observeCreateImagesRequestPolicy(
  observer: (value: CreateImagesRequestPolicyObservation) => void,
): () => void {
  requestObservers.add(observer);
  return () => requestObservers.delete(observer);
}

function publishRequestObservation(
  details: Electron.OnBeforeRequestListenerDetails,
  kind: CreateImagesRequestPolicyObservation["kind"],
  allowed: boolean,
): void {
  const observation: CreateImagesRequestPolicyObservation = {
    kind,
    url: details.url,
    allowed,
    method: details.method,
    resourceType: details.resourceType,
    webContentsIdPresent: details.webContentsId !== undefined,
    framePresent: details.frame !== null,
    frameIsMain: details.frame?.parent === null,
    frameDetached: details.frame?.detached ?? true,
  };
  for (const observer of requestObservers) {
    try {
      observer(observation);
    } catch {
      // Observability can never alter the production authorization decision.
    }
  }
}

/** Must run before `app.whenReady()`. It registers no handler or service. */
export function registerCreateImagesAssetScheme(): void {
  if (schemeRegistered) return;
  schemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "aiden-asset",
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: false,
        allowServiceWorkers: false,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

/** Install exact-document authorization and the streaming protocol handler. */
export async function installCreateImagesAssetProtocol(
  grants: AssetDeliveryGrantRegistry,
  source: CreateImagesAssetProtocolSource,
): Promise<void> {
  if (protocolInstalled) return;
  protocolInstalled = true;
  const targetSession = session.defaultSession;

  targetSession.webRequest.onBeforeRequest(
    {
      urls: ["aiden-asset://*/*", "http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
    },
    (details, callback) => {
      if (details.url.startsWith("aiden-asset:")) {
        const allowed = authorizeCreateImagesAssetRequest(
          details,
          (token, webContentsId, documentId) =>
            grants.authorizeProtocolRequest(token, webContentsId, documentId),
        );
        publishRequestObservation(details, "asset", allowed);
        callback({ cancel: !allowed });
        return;
      }
      const rendererUrl =
        details.webContentsId === undefined
          ? undefined
          : webContents.fromId(details.webContentsId)?.getURL();
      const blocked = shouldBlockAidenRendererEgress({
        requestUrl: details.url,
        rendererUrl,
        packaged: isPackagedRuntime(),
      });
      publishRequestObservation(details, "renderer-egress", !blocked);
      callback({ cancel: blocked });
    },
  );

  await targetSession.protocol.handle("aiden-asset", async (request) => {
    const token = parseCreateImagesAssetProtocolToken(request.url);
    const assetId = token ? grants.consumeProtocolRequest(token) : undefined;
    if (!assetId) return new Response("Not found", { status: 404 });
    try {
      const response = await source.response(assetId);
      if (!response || !response.ok || !response.body) {
        return new Response("Not found", { status: 404 });
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      headers.set("Content-Disposition", "inline");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.delete("Set-Cookie");
      return new Response(response.body, { status: 200, headers });
    } catch {
      return new Response("Unavailable", { status: 503 });
    }
  });
}
