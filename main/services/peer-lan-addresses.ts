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
 * This resolver book is memory-only. The encrypted paired-host registry can
 * restore authenticated hints after restart; discovery also supplies hints.
 */
export class PeerLanAddresses {
  private readonly addresses = new Map<string, string[]>();

  constructor(private readonly resolve: LookupFunction = dns.lookup) {}

  remember(instanceId: string, address: string): void {
    this.rememberAll(instanceId, [address]);
  }

  rememberAll(instanceId: string, addresses: readonly string[]): void {
    const valid = [...new Set(addresses.filter(isIPv4))].slice(0, 8);
    if (valid.length === 0) return;
    this.addresses.delete(instanceId);
    this.addresses.set(instanceId, valid);
    for (const oldest of this.addresses.keys()) {
      if (this.addresses.size <= MAX_PEER_LAN_ADDRESSES) break;
      this.addresses.delete(oldest);
    }
  }

  address(instanceId: string): string | undefined {
    return this.addresses.get(instanceId)?.[0];
  }

  forget(instanceId: string): void {
    this.addresses.delete(instanceId);
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
        if (options.all) callback(null, remembered.map((address) => ({ address, family: 4 })));
        else callback(null, remembered[0]!, 4);
      });
    };
  }
}

/** The process-wide book shared by discovery and paired-host connections. */
export const peerLanAddresses = new PeerLanAddresses();
