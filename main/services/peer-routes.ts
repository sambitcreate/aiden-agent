import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { validatePeerTrust, type PeerTrust } from "./peer-transport.js";

export interface PeerRoute extends PeerTrust {
  id: string;
  kind: "lan" | "tailscale";
  origin: "paired" | "learned";
  addresses?: string[];
}

export const peerRouteId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 24);

export function peerRoute(trust: PeerTrust, origin: PeerRoute["origin"]): PeerRoute {
  const checked = validatePeerTrust({ endpoint: trust.endpoint, serverSpkiSha256: trust.serverSpkiSha256,
    ...(trust.caCertificateDerBase64 === undefined ? {} : { caCertificateDerBase64: trust.caCertificateDerBase64 }) });
  const hostname = new URL(checked.endpoint).hostname;
  const kind = /\.local\.?$/iu.test(hostname) ? "lan" : "tailscale";
  return { ...checked, id: peerRouteId(checked.endpoint), kind, origin };
}

/** Only private IPv4 hints are accepted; TLS still uses the canonical hostname. */
export function privatePeerAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

export function peerLanInterfaceAddresses(interfaces: Record<string, ReadonlyArray<{ address: string; internal: boolean; family: string }> | undefined>): string[] {
  return [...new Set(Object.entries(interfaces)
    .filter(([name]) => !/^(?:lo\d*|utun\d*|tun\d*|tap\d*|bridge.*|br-.*|docker.*|veth.*|vbox.*|vmnet.*|tailscale.*|zt.*)$/iu.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4" && privatePeerAddress(entry.address))
    .map((entry) => entry.address))].slice(0, 8);
}

/** Authenticated advertisements carry route-specific CA and pin; never ambient trust. */
export function parsePeerRoutes(value: unknown): PeerRoute[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("Invalid peer routes.");
  const routes = value.map((raw) => {
    if (typeof raw !== "object" || raw === null) throw new Error("Invalid peer route.");
    const record = raw as Record<string, unknown>;
    const route = peerRoute(record as unknown as PeerTrust, "learned");
    const hostname = new URL(route.endpoint).hostname;
    if (route.kind === "lan" ? !route.caCertificateDerBase64 : !hostname.endsWith(".ts.net") || route.caCertificateDerBase64 !== undefined)
      throw new Error("Invalid peer route trust.");
    if (record.addresses !== undefined) {
      if (route.kind !== "lan" || !Array.isArray(record.addresses) || record.addresses.length > 8 || record.addresses.some((address) => typeof address !== "string" || !privatePeerAddress(address)))
        throw new Error("Invalid peer route addresses.");
      route.addresses = [...new Set(record.addresses as string[])];
    }
    return route;
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length) throw new Error("Duplicate peer route.");
  return routes;
}
