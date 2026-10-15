import assert from "node:assert/strict";
import test from "node:test";
import {
  PeerHostRegistry,
  type StoredPeerHost,
  type PeerClient,
} from "./peer-host-registry.js";
import {
  EncryptedPeerHostStorage,
  type PeerEncryptedDocument,
} from "./peer-host-storage.js";
import { PeerTransportError, peerRequestUrl } from "./peer-transport.js";
import { hostResourceKey } from "../../renderer/shared/peer-host.js";

const trust = {
  endpoint: "https://server.example/api/aiden/v1",
  serverSpkiSha256: `sha256/${Buffer.alloc(32).toString("base64")}`,
};
function saved(id = "host_a"): StoredPeerHost {
  return {
    ...trust,
    id,
    name: "Same name",
    deviceId: "device_a",
    credential: "a".repeat(43),
    enabled: true,
    capabilities: ["chat:read"],
    features: [],
  };
}
function registry(
  hosts: StoredPeerHost[],
  client: PeerClient,
  save = async (_next: StoredPeerHost[]) => {},
) {
  return new PeerHostRegistry({
    storage: { load: async () => hosts, save },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: (trust) => ({
      json: (input) =>
        input.path === "/server"
          ? Promise.resolve({
              protocolVersion: 1,
              instanceId: (trust as StoredPeerHost).id,
              capabilities: ["chat:read"],
              features: [],
            })
          : client.json(input),
      events: (input, onFrame) => client.events(input, onFrame),
    }),
  });
}

test("host identities do not collide and routes cannot escape the fixed API", () => {
  assert.notEqual(
    hostResourceKey({ hostId: "a", resourceId: "same" }),
    hostResourceKey({ hostId: "b", resourceId: "same" }),
  );
  for (const path of [
    "//evil.example",
    "/../../settings",
    "/%2e%2e/secret",
    "/\\evil",
    "/chats#fragment",
  ]) {
    assert.throws(() => peerRequestUrl(trust.endpoint, path));
  }
  assert.equal(
    peerRequestUrl(trust.endpoint, "/chats?cursor=abc").origin,
    "https://server.example",
  );
});

test("disabled peers make no requests; views contain no trust or credential data", async () => {
  let calls = 0;
  const store = registry([{ ...saved(), enabled: false }], {
    json: async () => {
      calls++;
    },
    events: async () => {},
  });
  await assert.rejects(store.request("host_a", { path: "/chats" }));
  assert.equal(calls, 0);
  const [view] = await store.list();
  assert.deepEqual(
    Object.keys(view!).sort(),
    ["id", "name", "enabled", "state", "features", "capabilities", "routes", "hasSuppressedRoutes"].sort(),
  );
});

test("restored peers verify installation identity before any operation", async () => {
  const paths: string[] = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => [saved()], save: async () => {} },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async (input) => {
        paths.push(input.path);
        return {
          protocolVersion: 1,
          instanceId: "replacement",
          capabilities: [],
        };
      },
      events: async () => {
        throw new Error("Unexpected event request");
      },
    }),
  });
  await assert.rejects(
    store.request("host_a", { method: "POST", path: "/chats", body: {} }),
    /identity changed/,
  );
  assert.deepEqual(paths, ["/server"]);
  assert.equal((await store.list())[0]?.state, "unavailable");
});

test("shutdown during initial storage load prevents network admission", async () => {
  let release!: () => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const store = new PeerHostRegistry({
    storage: {
      load: async () => {
        started();
        await pending;
        return [saved()];
      },
      save: async () => {},
    },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async () => {
        calls++;
        return {};
      },
      events: async () => {
        calls++;
      },
    }),
  });
  const request = store.request("host_a", {
    method: "POST",
    path: "/chats",
    body: {},
  });
  const rejected = assert.rejects(request, /closed/);
  await loading;
  store.close();
  release();
  await rejected;
  assert.equal(calls, 0);
});

test("concurrent identity checks retain independent cancellation", async () => {
  const checks: Array<() => void> = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => [saved()], save: async () => {} },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: (input) =>
        input.path === "/server"
          ? new Promise((resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
              checks.push(() =>
                resolve({
                  protocolVersion: 1,
                  instanceId: "host_a",
                  capabilities: [],
                }),
              );
            })
          : Promise.resolve({ ok: true }),
      events: async () => {},
    }),
  });
  const controller = new AbortController();
  const first = store.request("host_a", {
    path: "/chats",
    signal: controller.signal,
  });
  const rejected = assert.rejects(first, /aborted/);
  const second = store.request("host_a", { path: "/chats" });
  for (let i = 0; checks.length < 2 && i < 50; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks.length, 2);
  controller.abort();
  checks[1]!();
  await rejected;
  assert.deepEqual(await second, { ok: true });
});

test("disabling one peer cancels and fences only that peer's late responses", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = registry([saved(), saved("host_b")], {
    json: async () => {
      await pending;
      return { ok: true };
    },
    events: async () => {},
  });
  const a = store.request("host_a", { path: "/chats" });
  const rejection = assert.rejects(a, /superseded/);
  const b = store.request("host_b", { path: "/chats" });
  await store.setEnabled("host_a", false);
  release();
  await rejection;
  assert.deepEqual(await b, { ok: true });
});

test("failed persistence leaves peer enabled and credentials are never published before storage", async () => {
  const store = registry(
    [saved()],
    { json: async () => ({}), events: async () => {} },
    async () => {
      throw new Error("disk full");
    },
  );
  await assert.rejects(store.setEnabled("host_a", false), /disk full/);
  assert.equal((await store.list())[0]!.enabled, true);
});

test("paired-host encrypted store rejects unavailable encryption and corrupt data", async () => {
  let document: PeerEncryptedDocument = { version: 1, ciphertext: null };
  let available = true;
  const store = new EncryptedPeerHostStorage(
    {
      load: async () => document,
      save: async (next) => {
        document = next;
      },
    },
    {
      isEncryptionAvailable: () => available,
      encryptString: (text) =>
        Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x55)),
      decryptString: (bytes) =>
        Buffer.from(Buffer.from(bytes).map((byte) => byte ^ 0x55)).toString(),
    },
  );
  await store.save([saved()]);
  assert.ok(!JSON.stringify(document).includes(saved().credential));
  assert.deepEqual(await store.load(), [saved()]);
  available = false;
  await assert.rejects(store.save([]), /secure storage/);
  await assert.rejects(store.load(), /secure storage/);
  available = true;
  document = { version: 1, ciphertext: "AAAA" };
  await assert.rejects(store.load());
});

test("pairing rejects self before network and authenticates identity before publishing", async () => {
  let calls = 0;
  const store = registry([], {
    json: async () => {
      calls++;
      return {};
    },
    events: async () => {},
  });
  await assert.rejects(
    store.pair({
      ...trust,
      instanceId: "self",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }),
    /current Aiden/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    store.pair({
      ...trust,
      instanceId: "other",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }),
    /identity/,
  );
  assert.deepEqual(await store.list(), []);
});

test("a stalled pairing does not delay disconnecting another host, and cancellation fences persistence", async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const network = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const store = registry(
    [saved()],
    {
      json: async () => {
        entered();
        return network;
      },
      events: async () => {},
    },
    async () => {
      writes++;
    },
  );
  const controller = new AbortController();
  const pairing = store.pair(
    {
      ...trust,
      instanceId: "host_b",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    },
    controller.signal,
  );
  const rejected = assert.rejects(pairing, /cancelled/);
  await started;
  await store.setEnabled("host_a", false);
  assert.equal((await store.list())[0]!.enabled, false);
  controller.abort();
  release({});
  await rejected;
  assert.equal(writes, 1);
  assert.equal((await store.list()).length, 1);
});

test("shutdown rejects future operations and cancels pending pairing", async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const network = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const store = registry([], {
    json: async () => {
      entered();
      return network;
    },
    events: async () => {},
  });
  const pairing = store.pair({
    ...trust,
    instanceId: "other",
    secret: "b".repeat(43),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });
  const rejected = assert.rejects(pairing, /cancelled/);
  await started;
  store.close();
  release({});
  await rejected;
  await assert.rejects(store.list(), /closed/);
});

test("an answered client error keeps the peer connected; auth and transport failures do not", async () => {
  let failure: Error = new PeerTransportError("request_failed", 404);
  const store = registry([saved()], {
    json: async () => {
      throw failure;
    },
    events: async () => {
      throw new Error("Unexpected event request");
    },
  });
  await assert.rejects(store.request("host_a", { method: "GET", path: "/simulators" }), PeerTransportError);
  assert.equal((await store.list())[0]?.state, "connected");
  failure = new PeerTransportError("authentication_required", 403);
  await assert.rejects(store.request("host_a", { method: "GET", path: "/simulators" }), PeerTransportError);
  assert.equal((await store.list())[0]?.state, "unavailable");
  failure = new PeerTransportError("unavailable");
  await assert.rejects(store.request("host_a", { method: "GET", path: "/simulators" }), PeerTransportError);
  assert.equal((await store.list())[0]?.state, "unavailable");
});

test("relay targets exist only for enabled hosts and carry pinned trust", async () => {
  const unused: PeerClient = {
    json: async () => {
      throw new Error("Unexpected request");
    },
    events: async () => {
      throw new Error("Unexpected event request");
    },
  };
  const store = registry([saved(), { ...saved("host_b"), enabled: false }], unused);
  assert.deepEqual(await store.relayTarget("host_a"), {
    trust: { endpoint: trust.endpoint, serverSpkiSha256: trust.serverSpkiSha256 },
    credential: "a".repeat(43),
  });
  assert.equal(await store.relayTarget("host_b"), null);
  assert.equal(await store.relayTarget("missing"), null);
});

function scripted(
  server: Record<string, unknown>,
  respond: (input: { method?: string; path: string; body?: unknown }) => unknown,
) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let hosts = [saved()];
  const store = new PeerHostRegistry({
    storage: {
      load: async () => hosts,
      save: async (next) => {
        hosts = next;
      },
    },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async (input) => {
        requests.push({
          method: input.method ?? "GET",
          path: input.path,
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        if (input.path === "/server")
          return { protocolVersion: 1, instanceId: "host_a", ...server };
        return respond(input);
      },
      events: async () => ({ reason: "eof" as const }),
    }),
  });
  return { store, requests, stored: () => hosts };
}

test("verification persists refreshed grants and negotiates advertised host grants once", async () => {
  const { store, requests, stored } = scripted(
    {
      capabilities: ["chat:read"],
      features: ["host-events-v1", "run-streams-v1", "chat-tasks-v1"],
      // The host knows tasks but does not advertise the grant to this device.
      serverCapabilities: ["chat:read", "host:events", "runs:observe"],
    },
    (input) =>
      input.path === "/device/capabilities"
        ? { capabilities: ["chat:read", "host:events", "runs:observe"] }
        : { ok: true },
  );
  let changes = 0;
  store.onChanged(() => changes++);
  await store.request("host_a", { path: "/chats" });
  assert.deepEqual(
    requests.filter((request) => request.path === "/device/capabilities"),
    [
      {
        method: "POST",
        path: "/device/capabilities",
        body: { accepts: ["host:events", "runs:observe"] },
      },
    ],
  );
  assert.deepEqual(stored()[0]!.capabilities, ["chat:read", "host:events", "runs:observe"]);
  assert.deepEqual(stored()[0]!.features, ["host-events-v1", "run-streams-v1", "chat-tasks-v1"]);
  assert.ok(changes > 0);
  assert.ok((await store.list())[0]!.capabilities.includes("runs:observe"));
  // A reconnect in the same session re-verifies but never re-negotiates.
  await store.connect("host_a");
  assert.equal(
    requests.filter((request) => request.path === "/device/capabilities").length,
    1,
  );
  assert.equal(requests.filter((request) => request.path === "/server").length, 2);
});

test("an older host without negotiation keeps its grants and still serves requests", async () => {
  const { store, stored } = scripted(
    { capabilities: ["chat:read"], features: ["host-events-v1"] },
    (input) => {
      if (input.path === "/device/capabilities")
        throw new PeerTransportError("request_failed", 404);
      return { ok: true };
    },
  );
  assert.deepEqual(await store.request("host_a", { path: "/chats" }), { ok: true });
  assert.deepEqual(stored()[0]!.capabilities, ["chat:read"]);
  assert.equal((await store.list())[0]?.state, "connected");
});

test("identity and protocol mismatches surface as typed blocking failures", async () => {
  for (const [server, code] of [
    [{ protocolVersion: 1, instanceId: "replacement", capabilities: [] }, "identity_changed"],
    [{ protocolVersion: 2, instanceId: "host_a", capabilities: [] }, "unsupported_protocol"],
  ] as const) {
    const store = new PeerHostRegistry({
      storage: { load: async () => [saved()], save: async () => {} },
      localInstanceId: async () => "self",
      deviceName: "Desktop",
      clientVersion: "1",
      platform: "mac",
      client: () => ({
        json: async () => server,
        events: async () => {},
      }),
    });
    await assert.rejects(
      store.connect("host_a"),
      (error: unknown) => error instanceof PeerTransportError && error.code === code,
    );
  }
});

test("streams have their own budget so live runs cannot starve unary operations", async () => {
  const held: (() => void)[] = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => [saved()], save: async () => {} },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async (input) =>
        input.path === "/server"
          ? { protocolVersion: 1, instanceId: "host_a", capabilities: ["chat:read"] }
          : new Promise((resolve) => held.push(() => resolve({ ok: true }))),
      events: () =>
        new Promise((resolve) => held.push(() => resolve({ reason: "eof" }))),
    }),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const stream = () =>
    store.request("host_a", { path: "/host/events" }, () => {}, { partition: "stream" });
  const streams = Array.from({ length: 17 }, stream);
  await settle();
  await assert.rejects(stream(), /Too many pending/);
  const unary = Array.from({ length: 8 }, () => store.request("host_a", { path: "/chats" }));
  await settle();
  await assert.rejects(store.request("host_a", { path: "/chats" }), /Too many pending/);
  for (const release of held.splice(0)) release();
  assert.deepEqual(await Promise.all(streams), Array(17).fill({ reason: "eof" }));
  assert.deepEqual(await Promise.all(unary), Array(8).fill({ ok: true }));
});

test("authenticated routes bootstrap LAN trust, fail over, suppress removal and restore preference", async () => {
  const { startPeerTestHost } = await import("./peer-pairing-test-host.js");
  const { peerRoute } = await import("./peer-routes.js");
  const fixture = await startPeerTestHost({ lanHostname: "route-fixture.local" });
  const lan = { endpoint: fixture.lanEndpoint, serverSpkiSha256: fixture.serverSpkiSha256(), caCertificateDerBase64: fixture.caDerBase64, addresses: ["192.168.1.50"] };
  const tailnet = { endpoint: "https://route-fixture.example.ts.net/api/aiden/v1", serverSpkiSha256: trust.serverSpkiSha256 };
  let now = 100_000;
  let stored: StoredPeerHost[] = [{ ...saved(), ...tailnet }];
  let failedLan: "unavailable" | "identity_changed" | "authentication_required" | undefined;
  let advertised = [lan, tailnet];
  const traffic: { endpoint: string; path: string; credential?: string }[] = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => structuredClone(stored), save: async (next) => { stored = structuredClone(next); } },
    localInstanceId: async () => "self", deviceName: "Desktop", clientVersion: "1", platform: "mac", now: () => now,
    client: (routeTrust) => ({
      json: async (request) => {
        traffic.push({ endpoint: routeTrust.endpoint, path: request.path, credential: request.credential });
        if (routeTrust.endpoint === lan.endpoint) {
          assert.equal(routeTrust.caCertificateDerBase64, fixture.caDerBase64, "LAN must carry the CA delivered by the authenticated host");
          if (failedLan) throw new PeerTransportError(failedLan);
        }
        if (request.path === "/server") return { protocolVersion: 1, instanceId: "host_a", capabilities: ["chat:read"], features: ["peer-routes-v1"], peerRoutes: advertised };
        return { reached: routeTrust.endpoint };
      }, events: async () => {},
    }),
  });
  try {
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale");
    assert.equal(stored[0]!.routes?.find((route) => route.kind === "lan")?.caCertificateDerBase64, fixture.caDerBase64);
    assert.equal(await store.preferReachableRoute("host_a"), false, "preference cooldown prevents flapping");
    now += 30_000;
    assert.equal(await store.preferReachableRoute("host_a"), true);
    assert.equal((await store.connect("host_a")).activeRouteKind, "lan");
    assert.deepEqual(await store.request("host_a", { path: "/chats" }), { reached: lan.endpoint });
    failedLan = "unavailable";
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale", "dead active route bypasses preference cooldown");
    failedLan = "identity_changed";
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale", "a bad learned route cannot block a trusted fallback");
    failedLan = "authentication_required";
    const before = traffic.length;
    await assert.rejects(store.connect("host_a"), (error: unknown) => error instanceof PeerTransportError && error.code === "authentication_required");
    assert.equal(traffic.slice(before).some((request) => request.endpoint === tailnet.endpoint), false, "revocation must stop all route attempts");
    failedLan = undefined;
    const routeId = peerRoute(lan, "learned").id;
    await store.removeRoute("host_a", routeId);
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale");
    assert.ok(stored[0]!.suppressedRoutes?.includes(routeId), "refresh cannot re-add a removed learned route");
    assert.equal((await store.list())[0]!.routes?.some((route) => route.id === routeId), false);
    await store.restoreRoutes("host_a");
    assert.equal((await store.connect("host_a")).activeRouteKind, "lan");
    advertised = [tailnet];
    await store.connect("host_a");
    assert.equal((await store.list())[0]!.routes?.length, 2, "an omitted optional observation cannot erase validated route trust");
    assert.equal((await store.connect("host_a")).activeRouteKind, "lan", "the previously learned route remains usable after an incomplete advertisement");
    await store.removeRoute("host_a", routeId);
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale", "explicit removal still suppresses the retained route");
    assert.equal(JSON.stringify(await store.list()).includes("192.168.1.50"), false);
    assert.equal(JSON.stringify(await store.list()).includes(fixture.caDerBase64), false);
  } finally { store.close(); await fixture.close(); }
});

test("route parsing rejects public hints and enforces route-specific trust", async () => {
  const { parsePeerRoutes } = await import("./peer-routes.js");
  const route = { endpoint: "https://route.example.ts.net/api/aiden/v1", serverSpkiSha256: trust.serverSpkiSha256 };
  assert.deepEqual(parsePeerRoutes([route])[0]?.kind, "tailscale");
  for (const candidate of [
    { ...route, endpoint: "http://route.example.ts.net/api/aiden/v1" },
    { ...route, endpoint: "https://8.8.8.8/api/aiden/v1" },
    { ...route, endpoint: "https://route.local/api/aiden/v1" },
    { ...route, addresses: ["8.8.8.8"] },
    { ...route, endpoint: "https://attacker.example/api/aiden/v1" },
  ]) assert.throws(() => parsePeerRoutes([candidate]));
  const injected = parsePeerRoutes([{ ...route, credential: "not-a-route-field", enabled: false }])[0]!;
  assert.equal("credential" in injected, false);
  assert.equal("enabled" in injected, false);
  assert.throws(() => parsePeerRoutes([route, route]));
});

test("saved retry admission rejects an earlier pairing before sending credentials", async () => {
  let calls = 0;
  const store = registry([saved()], { json: async () => { calls++; return {}; }, events: async () => {} });
  try {
    await assert.rejects(store.request("host_a", { method: "POST", path: "/chats/chat-1/turns", idempotencyKey: "saved-key-12345678", body: { message: "Once" } }, undefined, { credentialIdentity: "old-device" }), /earlier pairing/u);
    assert.equal(calls, 0);
    await store.request("host_a", { path: "/chats" }, undefined, { credentialIdentity: "device_a" });
    assert.equal(calls, 1);
  } finally { store.close(); }
});

test("LAN-paired peers learn system-trusted Tailscale and safely renew only that route's pin", async () => {
  const { startPeerTestHost } = await import("./peer-pairing-test-host.js");
  const fixture = await startPeerTestHost({ lanHostname: "lan-first.local" });
  const lan = { endpoint: fixture.lanEndpoint, serverSpkiSha256: fixture.serverSpkiSha256(), caCertificateDerBase64: fixture.caDerBase64 };
  const tailnet = { endpoint: "https://lan-first.example.ts.net/api/aiden/v1", serverSpkiSha256: trust.serverSpkiSha256 };
  const renewedPin = `sha256/${Buffer.alloc(32, 9).toString("base64")}`;
  let stored = [{ ...saved(), ...lan }];
  let lanOffline = false;
  let renew = false;
  const store = new PeerHostRegistry({
    storage: { load: async () => structuredClone(stored), save: async (next) => { stored = structuredClone(next) as typeof stored; } },
    localInstanceId: async () => "self", deviceName: "Desktop", clientVersion: "1", platform: "mac",
    bootstrap: ({ endpoint, mode }) => {
      assert.equal(endpoint, tailnet.endpoint);
      assert.equal(mode, "webpki");
      return { observedSpki: renewedPin, json: async () => ({ protocolVersion: 1, instanceId: "host_a" }) };
    },
    client: (routeTrust) => ({
      json: async (request) => {
        if (routeTrust.endpoint === lan.endpoint && lanOffline) throw new PeerTransportError("unavailable");
        if (routeTrust.endpoint === tailnet.endpoint) {
          assert.equal(routeTrust.caCertificateDerBase64, undefined, "the LAN CA must not contaminate system trust");
          if (renew && routeTrust.serverSpkiSha256 !== renewedPin) throw new PeerTransportError("identity_changed");
        }
        return request.path === "/server"
          ? { protocolVersion: 1, instanceId: "host_a", capabilities: ["chat:read"], features: ["peer-routes-v1"], peerRoutes: [lan, { ...tailnet, serverSpkiSha256: renew ? renewedPin : tailnet.serverSpkiSha256 }] }
          : { endpoint: routeTrust.endpoint };
      }, events: async () => {},
    }),
  });
  try {
    assert.equal((await store.connect("host_a")).activeRouteKind, "lan");
    lanOffline = true;
    renew = true;
    assert.equal((await store.connect("host_a")).activeRouteKind, "tailscale");
    assert.deepEqual(await store.request("host_a", { path: "/chats" }), { endpoint: tailnet.endpoint });
    assert.equal((await store.relayTarget("host_a"))?.trust.serverSpkiSha256, renewedPin);
    assert.equal(stored[0]!.caCertificateDerBase64, fixture.caDerBase64, "renewing the alternate must retain the paired LAN trust");
    const { parseStoredPeerHosts } = await import("./peer-host-registry.js");
    const restored = parseStoredPeerHosts(stored);
    assert.equal(restored[0]!.routes?.find((route) => route.endpoint === tailnet.endpoint)?.serverSpkiSha256, renewedPin);
  } finally { store.close(); await fixture.close(); }
});

test("route advertisements exclude loopback, virtual bridges, tunnels and public interfaces", async () => {
  const { peerLanInterfaceAddresses } = await import("./peer-routes.js");
  const entry = (address: string, internal = false, family = "IPv4") => ({ address, internal, family });
  assert.deepEqual(peerLanInterfaceAddresses({
    en0: [entry("192.168.1.7"), entry("fe80::123", false, "IPv6")],
    eth0: [entry("10.1.0.2"), entry("192.168.1.7")],
    lo0: [entry("127.0.0.1", true)],
    bridge100: [entry("192.168.64.1")],
    docker0: [entry("172.17.0.1")],
    utun3: [entry("10.20.0.4")],
    tailscale0: [entry("100.64.0.1")],
    en1: [entry("203.0.113.4")],
  }), ["192.168.1.7", "10.1.0.2"]);
});
