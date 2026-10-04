import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import test from "node:test";
import { MAX_PEER_LAN_ADDRESSES, PeerLanAddresses } from "./peer-lan-addresses.js";

/** A system resolver that knows only the names it is given. */
function resolver(known: Record<string, string>): LookupFunction {
  return (hostname, options, callback) => {
    const address = known[hostname];
    if (address === undefined) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

function resolve(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions = {},
): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[] }> {
  return new Promise((done) =>
    lookup(hostname, options, (error, address) => done({ error, address })),
  );
}

test("a .local name the system cannot resolve reaches the address remembered for that installation", async () => {
  const book = new PeerLanAddresses(resolver({ "known.local": "10.0.0.2", "example.com": "93.184.216.34" }));
  book.remember("install_studio", "192.168.1.20");
  const studio = book.lookupFor("install_studio");

  assert.deepEqual(await resolve(studio, "studio-mac.local"), { error: null, address: "192.168.1.20" });
  assert.deepEqual(await resolve(studio, "studio-mac.local.", { all: true }), {
    error: null,
    address: [{ address: "192.168.1.20", family: 4 }],
  });
  // The system's answer wins whenever it has one.
  assert.deepEqual(await resolve(studio, "known.local"), { error: null, address: "10.0.0.2" });
  // Other names, IPv6-only lookups and other installations are not redirected.
  assert.equal((await resolve(studio, "studio.example")).error?.code, "ENOTFOUND");
  assert.equal((await resolve(studio, "studio-mac.local", { family: 6 })).error?.code, "ENOTFOUND");
  assert.equal((await resolve(book.lookupFor("install_other"), "studio-mac.local")).error?.code, "ENOTFOUND");
});

test("only IPv4 addresses are kept, the latest per installation, for a bounded number of installations", () => {
  const book = new PeerLanAddresses(resolver({}));
  book.remember("install_a", "fe80::1");
  book.remember("install_a", "studio-mac.local");
  assert.equal(book.address("install_a"), undefined);

  book.remember("install_a", "192.168.1.20");
  book.remember("install_a", "192.168.1.21");
  assert.equal(book.address("install_a"), "192.168.1.21");

  for (let index = 0; index < MAX_PEER_LAN_ADDRESSES; index += 1)
    book.remember(`install_${index}`, "10.0.0.1");
  assert.equal(book.address("install_a"), undefined, "the oldest installation is dropped");
  assert.equal(book.address(`install_${MAX_PEER_LAN_ADDRESSES - 1}`), "10.0.0.1");
});
