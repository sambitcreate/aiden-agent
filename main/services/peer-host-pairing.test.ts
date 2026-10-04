import assert from "node:assert/strict";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import test from "node:test";
import type { PeerDiscoveryState } from "../../renderer/shared/peer-host.js";
import { PeerBootstrapTransport } from "./peer-bootstrap-transport.js";
import { PeerDiscovery, type PeerBonjourService } from "./peer-discovery.js";
import { PeerHostRegistry, type StoredPeerHost } from "./peer-host-registry.js";
import { PeerLanAddresses } from "./peer-lan-addresses.js";
import { PeerPairingOutcomeError, type PeerPairingFailure } from "./peer-pairing-client.js";
import { startPeerTestHost, type PeerTestHost } from "./peer-pairing-test-host.js";
import { PeerTransport, PeerTransportError } from "./peer-transport.js";

function registryFor(
  host: PeerTestHost,
  options: {
    localInstanceId?: string;
    /** Called as each `/server` read starts, with the credential it presents. */
    onServerRead?: (credential: string | undefined) => void;
    /** Refuse to save, as a full disk or a locked keychain does. */
    failSave?: boolean;
  } = {},
) {
  let saved: StoredPeerHost[] = [];
  let repinned = 0;
  const registry = new PeerHostRegistry({
    storage: {
      load: async () => structuredClone(saved),
      save: async (next) => {
        if (options.failSave) throw new Error("The disk is full.");
        saved = structuredClone(next);
      },
    },
    localInstanceId: async () => options.localInstanceId ?? "install_self",
    deviceName: "Travel MacBook",
    clientVersion: "0.60.0",
    platform: "mac",
    // The fixture CA stands in for the system roots of a Tailscale certificate.
    client: (trust) => {
      const transport = new PeerTransport({
        endpoint: trust.endpoint,
        serverSpkiSha256: trust.serverSpkiSha256,
        caCertificateDerBase64: trust.caCertificateDerBase64 ?? host.caDerBase64,
      });
      return {
        json: (input) => {
          if (input.path === "/server") options.onServerRead?.(input.credential);
          return transport.json(input);
        },
        events: (input, onFrame) => transport.events(input, onFrame),
      };
    },
    bootstrap: (session) => new PeerBootstrapTransport({ ...session, ca: host.caPem }),
    repinned: () => {
      repinned += 1;
    },
  });
  return {
    registry,
    saved: () => saved,
    repinned: () => repinned,
  };
}

async function outcome(promise: Promise<unknown>): Promise<PeerPairingFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PeerPairingOutcomeError, String(error));
    return error.outcome;
  }
  assert.fail("expected pairing to end without a host");
}

/** Answer the request on the host once its prompt shows the requester's code. */
function answer(host: PeerTestHost, decision: "allow" | "deny", codes: string[] = []) {
  return (code: string) => {
    codes.push(code);
    const prompt = host.requests.list()[0];
    assert.ok(prompt, "the host shows the request once the code exists");
    assert.equal(prompt.matchCode, code, "both screens show the same code");
    assert.equal(prompt.deviceName, "Travel MacBook");
    void host.requests.respond(prompt.requestId, decision);
  };
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

async function eventuallyAsync(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await check());
}

test("an allowed LAN request saves a host pinned to the key the code covered", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const codes: string[] = [];
  const view = await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    answer(host, "allow", codes),
  );
  assert.match(codes[0] ?? "", /^\d{6}$/u);
  assert.equal(view.id, host.instanceId);
  assert.equal(view.name, "Studio Mac");
  assert.equal(view.state, "connected");
  const [stored] = saved();
  assert.equal(stored?.endpoint, host.lanEndpoint);
  assert.equal(stored?.serverSpkiSha256, host.serverSpkiSha256());
  assert.equal(stored?.caCertificateDerBase64, host.caDerBase64);
  assert.ok(stored?.capabilities.includes("server:read"));

  const server = (await registry.request(host.instanceId, { path: "/server" })) as {
    instanceId: string;
  };
  assert.equal(server.instanceId, host.instanceId);
});

test("an allowed Tailscale request saves system trust for the exact name", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.tailscaleEndpoint, route: "tailscale" },
    answer(host, "allow"),
  );
  const [stored] = saved();
  assert.equal(stored?.endpoint, host.tailscaleEndpoint);
  assert.equal(stored?.caCertificateDerBase64, undefined);
  assert.equal(stored?.serverSpkiSha256, host.serverSpkiSha256());
});

test("a denied, closed or self-addressed request saves nothing and says why", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const target = { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" } as const;

  const denied = registryFor(host);
  assert.deepEqual(await outcome(denied.registry.pairWithRequest(target, answer(host, "deny"))), {
    status: "denied",
  });
  assert.deepEqual(denied.saved(), []);

  host.setAccepting(false);
  const closed = registryFor(host);
  assert.deepEqual(
    await outcome(closed.registry.pairWithRequest(target, () => assert.fail("no code"))),
    { status: "closed" },
  );
  host.setAccepting(true);

  const self = registryFor(host, { localInstanceId: host.instanceId });
  const before = host.seen.length;
  const refused = await outcome(self.registry.pairWithRequest(target, () => assert.fail("no code")));
  assert.equal(refused.status, "failed");
  assert.equal(host.seen.length, before, "pairing with this installation sends nothing");
});

test("cancelling while waiting withdraws the request from the other device", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const controller = new AbortController();
  const pairing = registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    () => setTimeout(() => controller.abort(), 20),
    controller.signal,
  );
  assert.deepEqual(await outcome(pairing), { status: "cancelled" });
  await eventually(() => host.requests.list().length === 0);
  assert.ok(host.seen.some((entry) => entry.startsWith("DELETE /api/aiden/v1/pairing/requests/")));
  assert.deepEqual(saved(), []);
});

/** Whether the host still serves a request that presents `credential`. */
async function hostAccepts(host: PeerTestHost, credential: string | undefined) {
  assert.ok(credential, "the client presented the credential it was granted");
  const transport = new PeerTransport({
    endpoint: host.lanEndpoint,
    serverSpkiSha256: host.serverSpkiSha256(),
    caCertificateDerBase64: host.caDerBase64,
  });
  try {
    await transport.json({ path: "/server", credential });
    return true;
  } catch (error) {
    if (error instanceof PeerTransportError && error.code === "authentication_required") return false;
    throw error;
  }
}

test("cancelling while the allowed pairing is being confirmed revokes its credential on the other device", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const controller = new AbortController();
  let granted: string | undefined;
  const { registry, saved } = registryFor(host, {
    onServerRead: (credential) => {
      granted = credential;
      controller.abort();
    },
  });
  const pairing = registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    answer(host, "allow"),
    controller.signal,
  );
  assert.deepEqual(await outcome(pairing), { status: "cancelled" });
  assert.deepEqual(saved(), []);
  assert.deepEqual(await registry.list(), []);
  await eventuallyAsync(async () => !(await hostAccepts(host, granted)));
  assert.deepEqual(
    (await host.devices.listDevices()).filter((device) => device.revokedAt === undefined),
    [],
  );
});

test("a pairing this device cannot save revokes its credential on the other device", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  let granted: string | undefined;
  const { registry, saved } = registryFor(host, {
    failSave: true,
    onServerRead: (credential) => {
      granted = credential;
    },
  });
  const failure = await outcome(
    registry.pairWithRequest(
      { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
      answer(host, "allow"),
    ),
  );
  assert.equal(failure.status, "failed");
  assert.deepEqual(saved(), []);
  assert.deepEqual(await registry.list(), []);
  await eventuallyAsync(async () => !(await hostAccepts(host, granted)));

  // A pairing that does save keeps its credential.
  const { registry: working } = registryFor(host);
  const view = await working.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    answer(host, "allow"),
  );
  assert.equal(view.state, "connected");
  assert.equal(
    (await host.devices.listDevices()).filter((device) => device.revokedAt === undefined).length,
    1,
  );
  assert.deepEqual(await working.request(host.instanceId, { path: "/server" }).then(() => "served"), "served");
});

test("a setup code opens the sealed payload for the typed address and pairs over the pinned exchange", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const code = host.openSetupCode("lan");

  assert.deepEqual(
    await outcome(registry.pairWithSetupCode({ endpoint: host.lanEndpoint, code: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ" })),
    { status: "invalid_code" },
  );
  assert.deepEqual(saved(), []);

  const view = await registry.pairWithSetupCode({ endpoint: host.lanEndpoint, code });
  assert.equal(view.id, host.instanceId);
  assert.equal(saved()[0]?.caCertificateDerBase64, host.caDerBase64);

  // The window is single use.
  const again = registryFor(host);
  assert.equal(
    (await outcome(again.registry.pairWithSetupCode({ endpoint: host.lanEndpoint, code }))).status,
    "failed",
  );
});

test("a setup code for a discovered device is bound to its installation, not the address it was found at", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const code = host.openSetupCode("lan");
  // Discovery reached the host under a name other than its canonical endpoint.
  const found = host.lanEndpoint.replace("127.0.0.1", "localhost");

  const typed = registryFor(host);
  assert.deepEqual(
    await outcome(typed.registry.pairWithSetupCode({ endpoint: found, code })),
    { status: "invalid_code" },
    "a typed address must match the payload exactly",
  );
  const other = registryFor(host);
  assert.deepEqual(
    await outcome(
      other.registry.pairWithSetupCode({ endpoint: found, code, instanceId: "someone-else" }),
    ),
    { status: "invalid_code" },
  );
  assert.deepEqual([...typed.saved(), ...other.saved()], []);

  const discovered = registryFor(host);
  const view = await discovered.registry.pairWithSetupCode({
    endpoint: found,
    code,
    instanceId: host.instanceId,
  });
  assert.equal(view.id, host.instanceId);
  assert.equal(discovered.saved()[0]?.endpoint, host.lanEndpoint, "the host's own endpoint is saved");
});

test("a renewed Tailscale key is re-pinned only after the same installation confirms it", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved, repinned } = registryFor(host);
  await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.tailscaleEndpoint, route: "tailscale" },
    answer(host, "allow"),
  );
  const original = saved()[0]!.serverSpkiSha256;

  await host.rotateLeaf();
  assert.notEqual(host.serverSpkiSha256(), original);
  const server = (await registry.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);
  assert.equal(saved()[0]!.serverSpkiSha256, host.serverSpkiSha256());
  assert.equal(repinned(), 1);

  // A certificate from another authority is not WebPKI-valid for the name.
  const renewed = saved()[0]!.serverSpkiSha256;
  await host.impersonate();
  await assert.rejects(
    registry.request(host.instanceId, { path: "/server" }),
    (error: unknown) => error instanceof PeerTransportError && error.code === "identity_changed",
  );
  assert.equal(saved()[0]!.serverSpkiSha256, renewed);
  assert.equal(repinned(), 1);
});

test("a LAN host stays strictly pinned and re-pairing replaces its key but keeps its local name", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved, repinned } = registryFor(host);
  await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    answer(host, "allow"),
  );
  await registry.rename(host.instanceId, "  Studio   upstairs ");
  const original = saved()[0]!;

  await host.rotateLeaf();
  await assert.rejects(
    registry.request(host.instanceId, { path: "/server" }),
    (error: unknown) => error instanceof PeerTransportError && error.code === "identity_changed",
  );
  assert.equal(saved()[0]!.serverSpkiSha256, original.serverSpkiSha256);
  assert.equal(repinned(), 0);

  const view = await registry.pairWithSetupCode(
    { endpoint: host.lanEndpoint, code: host.openSetupCode("lan") },
    undefined,
    { replaceHostId: host.instanceId },
  );
  assert.equal(view.name, "Studio upstairs");
  assert.equal(saved().length, 1);
  assert.equal(saved()[0]!.serverSpkiSha256, host.serverSpkiSha256());
  assert.notEqual(saved()[0]!.credential, original.credential);
  const server = (await registry.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);
});

test("names are bounded by Unicode characters, as the host counts them", async (t) => {
  // 80 characters outside the Basic Multilingual Plane are 160 UTF-16 units.
  const wide = "\u{1F5A5}".repeat(80);
  const host = await startPeerTestHost({ displayName: wide });
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const view = await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" },
    answer(host, "allow"),
  );
  assert.equal(view.name, wide);
  assert.equal(saved()[0]?.name, wide);

  // A local name may keep the joiners inside an emoji; 81 characters is too long.
  const coder = "\u{1F469}‍\u{1F4BB}";
  assert.equal((await registry.rename(host.instanceId, `${coder} desk`)).name, `${coder} desk`);
  await assert.rejects(registry.rename(host.instanceId, "\u{1F5A5}".repeat(81)), /up to 80 characters/u);
  assert.deepEqual(
    (await registry.list()).map((entry) => entry.name),
    [`${coder} desk`],
  );
});

/** A system resolver without mDNS: every `.local` name is unknown. */
const withoutMdns: LookupFunction = (hostname, options, callback) => {
  if (/\.local\.?$/iu.test(hostname)) {
    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 0);
    return;
  }
  dns.lookup(hostname, options, callback);
};

/** A registry on a controller whose system resolver cannot reach `.local` names. */
function registryWithoutMdns(saved: { hosts: StoredPeerHost[] }) {
  return new PeerHostRegistry({
    storage: {
      load: async () => structuredClone(saved.hosts),
      save: async (next) => {
        saved.hosts = structuredClone(next);
      },
    },
    localInstanceId: async () => "install_self",
    deviceName: "Travel MacBook",
    clientVersion: "0.60.0",
    platform: "mac",
    lanAddresses: new PeerLanAddresses(withoutMdns),
  });
}

test("a LAN host found at its Bonjour address stays reachable under its unresolvable .local name", async (t) => {
  const host = await startPeerTestHost({ lanHostname: "studio-mac.local" });
  t.after(() => host.close());
  assert.notEqual(host.lanEndpoint, host.lanAddressEndpoint);
  const saved = { hosts: [] as StoredPeerHost[] };
  const registry = registryWithoutMdns(saved);

  // A connection request to the address discovery fell back to.
  const view = await registry.pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanAddressEndpoint, route: "lan" },
    answer(host, "allow"),
  );
  assert.equal(view.state, "connected");
  assert.equal(saved.hosts[0]?.endpoint, host.lanEndpoint, "the host's canonical endpoint is saved");
  const server = (await registry.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);
});

test("a setup code for a discovered device pairs through the address it was found at", async (t) => {
  const host = await startPeerTestHost({ lanHostname: "studio-mac.local" });
  t.after(() => host.close());
  const saved = { hosts: [] as StoredPeerHost[] };
  const registry = registryWithoutMdns(saved);
  const view = await registry.pairWithSetupCode({
    endpoint: host.lanAddressEndpoint,
    code: host.openSetupCode("lan"),
    instanceId: host.instanceId,
  });
  assert.equal(view.id, host.instanceId);
  assert.equal(saved.hosts[0]?.endpoint, host.lanEndpoint);
  const server = (await registry.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);
});

test("after a restart, a paired LAN host is reachable again once discovery reports its address with the pinned key", async (t) => {
  const host = await startPeerTestHost({ lanHostname: "studio-mac.local" });
  t.after(() => host.close());
  const saved = { hosts: [] as StoredPeerHost[] };
  await registryWithoutMdns(saved).pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanAddressEndpoint, route: "lan" },
    answer(host, "allow"),
  );

  // A new process remembers no address.
  const restarted = registryWithoutMdns(saved);
  const unreachable = () =>
    assert.rejects(
      restarted.request(host.instanceId, { path: "/server" }),
      (error: unknown) => error instanceof PeerTransportError && error.code === "unavailable",
    );
  await unreachable();

  // An answer under another key, or for another installation, is not kept.
  const address = new URL(host.lanAddressEndpoint).hostname;
  await restarted.rememberLanAddress(host.instanceId, address, `sha256/${"A".repeat(43)}=`);
  await restarted.rememberLanAddress("someone-else", address, host.serverSpkiSha256());
  await unreachable();

  const pinned = host.serverSpkiSha256();
  await restarted.rememberLanAddress(host.instanceId, address, pinned);
  const server = (await restarted.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);

  // The address only changes where a connection goes: TLS still checks the
  // name, the private CA and the pinned key.
  await host.impersonate();
  const impersonated = registryWithoutMdns(saved);
  await impersonated.rememberLanAddress(host.instanceId, address, pinned);
  await assert.rejects(
    impersonated.request(host.instanceId, { path: "/server" }),
    (error: unknown) => error instanceof PeerTransportError && error.code === "identity_changed",
  );
});

test("after a restart, discovery recovers a LAN host's address even when Tailscale reached it first", async (t) => {
  const host = await startPeerTestHost({ lanHostname: "studio-mac.local" });
  t.after(() => host.close());
  const saved = { hosts: [] as StoredPeerHost[] };
  await registryWithoutMdns(saved).pairWithRequest(
    { instanceId: host.instanceId, endpoint: host.lanAddressEndpoint, route: "lan" },
    answer(host, "allow"),
  );
  const restarted = registryWithoutMdns(saved);
  await assert.rejects(
    restarted.request(host.instanceId, { path: "/server" }),
    (error: unknown) => error instanceof PeerTransportError && error.code === "unavailable",
  );

  let announce: ((service: PeerBonjourService) => void) | undefined;
  const reports: Promise<void>[] = [];
  let state: PeerDiscoveryState = { scanning: true, devices: [] };
  const discovery = new PeerDiscovery({
    tailscale: async () => ({
      run: async () =>
        JSON.stringify({
          Peer: { node: { DNSName: "studio.tail0.ts.net.", OS: "macOS", Online: true } },
        }),
    }),
    browse: (onService) => {
      announce = onService;
      return () => undefined;
    },
    // The Tailscale name maps onto the fixture; `.local` names do not resolve here.
    bootstrap: (options) => {
      const { hostname } = new URL(options.endpoint);
      if (hostname.endsWith(".local"))
        return {
          observedSpki: undefined,
          json: async () => {
            throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
          },
        };
      return new PeerBootstrapTransport({
        ...options,
        endpoint: hostname === "studio.tail0.ts.net" ? host.tailscaleEndpoint : options.endpoint,
        ca: host.caPem,
      });
    },
    localInstanceId: async () => "install_self",
    pairedIds: async () => (await restarted.list()).map((entry) => entry.id),
    publish: (next) => {
      state = next;
    },
    lanAddress: (id, address, spki) => {
      reports.push(restarted.rememberLanAddress(id, address, spki));
    },
    browseSettleMs: 0,
  });
  t.after(() => discovery.stop());
  discovery.start();
  await eventually(() => state.devices[0]?.route === "tailscale");

  // Its Bonjour answer arrives second, with the usual instance TXT field.
  announce?.({
    host: "studio-mac.local",
    port: Number(new URL(host.lanAddressEndpoint).port),
    addresses: ["127.0.0.1"],
    txt: { instance: host.instanceId },
  });
  await eventually(() => reports.length > 0);
  await Promise.all(reports);
  const server = (await restarted.request(host.instanceId, { path: "/server" })) as { instanceId: string };
  assert.equal(server.instanceId, host.instanceId);
  await eventually(() => !state.scanning);
  assert.equal(state.devices.length, 1);
  assert.equal(discovery.target(host.instanceId)?.route, "tailscale", "Tailscale stays the pairing route");
});
