import type { HostPlatformCapabilities } from "../host-platform-capabilities.js";
import type { AidenRemoteRouterDependencies } from "../aiden-remote-router.js";
import { installComposioCalendarHostTransport } from "./composio-calendar-host-port.js";
import { createComposioCalendarTransport } from "./composio-calendar-transport.js";

let installed = false;

/** Trusted Electron composition after connector acceptance, before Bot work starts.
 * Registration is local and lazy: it opens no connector, credentials or source.
 * Per-source admission and current schema checks still precede every read.
 */
export function installElectronConnectorWatchTransport(supported: boolean): void {
  if (!supported || installed) return;
  installComposioCalendarHostTransport(createComposioCalendarTransport());
  installed = true;
}

/** Electron hosts with Bots offer the same optional routes on Mac and Linux.
 * Unsupported hosts do not even load the service. The CLI omits this composition.
 */
export async function electronConnectorWatchRemotePorts(
  capabilities: Pick<HostPlatformCapabilities, "bots">,
  load: () => Promise<NonNullable<AidenRemoteRouterDependencies["botWatches"]>>,
): Promise<Pick<AidenRemoteRouterDependencies, "botWatches">> {
  return capabilities.bots ? { botWatches: await load() } : {};
}
