import Bonjour from "bonjour-service";
import { app, ipcMain } from "../platform.js";
import { createSystemTailscaleCommandRunner } from "./aiden-remote-tailscale.js";
import { getAidenRemoteRuntime } from "./aiden-remote-service-main.js";
import { createPeerBootstrapTransport } from "./peer-bootstrap-transport.js";
import { PeerDiscovery, type PeerBonjourBrowse } from "./peer-discovery.js";
import { getPeerHostRegistry } from "./peer-host-service-main.js";

let discovery: PeerDiscovery | undefined;

/** Browse `_aiden-agent._tcp` with a private responder that lives only as long as the scan. */
const browseBonjour: PeerBonjourBrowse = (onService) => {
  const bonjour = new Bonjour(undefined, () => undefined);
  const browser = bonjour.find({ type: "aiden-agent", protocol: "tcp" }, onService);
  return () => {
    browser.stop();
    bonjour.destroy();
  };
};

/**
 * Device discovery for the Add device sheet. Created on first use and idle
 * until the sheet starts a scan; kept apart from the registry singleton so
 * the headless CLI never bundles it.
 */
export function getPeerDiscovery(): PeerDiscovery {
  if (discovery) return discovery;
  const registry = getPeerHostRegistry();
  const current = new PeerDiscovery({
    tailscale: () => createSystemTailscaleCommandRunner(),
    bootstrap: createPeerBootstrapTransport,
    browse: browseBonjour,
    localInstanceId: async () =>
      (await (await getAidenRemoteRuntime()).state.snapshot()).instanceId,
    pairedIds: async () => (await registry.list()).map((host) => host.id),
    publish: (state) => ipcMain.broadcast("remote:peer-discovery", state),
  });
  discovery = current;
  app.once("before-quit", () => current.stop(false));
  return current;
}
