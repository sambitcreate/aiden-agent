import dns from "node:dns";
import { isIPv4, type LookupFunction } from "node:net";

/** Installations whose Bonjour address is kept at once. */
export const MAX_PEER_LAN_ADDRESSES = 64;

/**
 * The IPv4 address Bonjour reported for a LAN host, by installation id.
 *
 * A host seals its canonical `https://<name>.local:<port>` endpoint into a
 * grant, and that name is what TLS verifies. A controller without system
 * mDNS cannot resolve it, although discovery reached the host through the
 * address Bonjour gave. `lookupFor` lets such a connection reach that
 * address while TLS still checks the `.local` name, the private CA and the
 * SPKI pin, so a wrong or stale address can only fail.
 *
 * Addresses live in memory only. After a restart one is learned again the
 * next time discovery runs.
 */
export class PeerLanAddresses {
  private readonly addresses = new Map<string, string>();

  constructor(private readonly resolve: LookupFunction = dns.lookup) {}

  remember(instanceId: string, address: string): void {
    if (!isIPv4(address)) return;
    this.addresses.delete(instanceId);
    this.addresses.set(instanceId, address);
    for (const oldest of this.addresses.keys()) {
      if (this.addresses.size <= MAX_PEER_LAN_ADDRESSES) break;
      this.addresses.delete(oldest);
    }
  }

  address(instanceId: string): string | undefined {
    return this.addresses.get(instanceId);
  }

  /**
   * Resolve through the system first. Only when it cannot resolve a `.local`
   * name does the connection use the address remembered for this
   * installation.
   */
  lookupFor(instanceId: string): LookupFunction {
    return (hostname, options, callback) => {
      this.resolve(hostname, options, (error, address, family) => {
        const remembered = this.addresses.get(instanceId);
        if (
          !error ||
          remembered === undefined ||
          options.family === 6 ||
          !/\.local\.?$/iu.test(hostname)
        ) {
          callback(error, address, family);
          return;
        }
        if (options.all) callback(null, [{ address: remembered, family: 4 }]);
        else callback(null, remembered, 4);
      });
    };
  }
}

/** The process-wide book shared by discovery and paired-host connections. */
export const peerLanAddresses = new PeerLanAddresses();
