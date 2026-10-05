import assert from "node:assert/strict";
import test from "node:test";
import type {
  PeerDiscoveryState,
  PeerPairingProgress,
  PeerPairingResult,
} from "../../renderer/shared/peer-host.js";
import { PeerBootstrapTransport } from "../services/peer-bootstrap-transport.js";
import { PeerDiscovery } from "../services/peer-discovery.js";
import {
  PeerHostRegistry,
  type PeerPairingTarget,
  type StoredPeerHost,
} from "../services/peer-host-registry.js";
import { startPeerTestHost, type PeerTestHost } from "../services/peer-pairing-test-host.js";
import { PeerTransport } from "../services/peer-transport.js";
import {
  peerSetupAddress,
  registerPeerPairingHandlers,
  type PeerPairingDiscovery,
  type PeerPairingOwner,
} from "./peer-pairing.js";

/** One renderer main-frame document; `navigate` invalidates it like a reload. */
class FakeDocument implements PeerPairingOwner {
  readonly received: { channel: string; payload: PeerPairingProgress }[] = [];
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  constructor(readonly key: string) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(channel: "remote:peer-pairing-progress", payload: PeerPairingProgress): void {
    this.received.push({ channel, payload });
  }
  navigate(): void {
    this.destroyed = true;
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener);
      listener();
    }
  }
}

type FakeEvent = { document: FakeDocument | null };

function registryFor(host: PeerTestHost) {
  let saved: StoredPeerHost[] = [];
  const registry = new PeerHostRegistry({
    storage: {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    localInstanceId: async () => "install_self",
    deviceName: "Travel MacBook",
    clientVersion: "0.60.0",
    platform: "mac",
    client: (trust) =>
      new PeerTransport({
        endpoint: trust.endpoint,
        serverSpkiSha256: trust.serverSpkiSha256,
        caCertificateDerBase64: trust.caCertificateDerBase64 ?? host.caDerBase64,
      }),
    bootstrap: (session) => new PeerBootstrapTransport({ ...session, ca: host.caPem }),
  });
  return { registry, saved: () => saved };
}

/** Discovery that already found the given devices. */
function foundDevices(targets: PeerPairingTarget[]): PeerPairingDiscovery {
  return {
    start: () => undefined,
    stop: () => undefined,
    refresh: () => undefined,
    target: (id) => targets.find((target) => target.instanceId === id),
    state: async (): Promise<PeerDiscoveryState> => ({ scanning: false, devices: [] }),
  };
}

function setup(options: {
  discovery: PeerPairingDiscovery;
  registry?: ReturnType<typeof registryFor>["registry"];
}) {
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  const reconnected: string[] = [];
  registerPeerPairingHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => {
      if (!event.document) throw new Error("Pairing requires an active application document.");
      return event.document;
    },
    discovery: () => options.discovery,
    registry: () => options.registry ?? assert.fail("no registry expected"),
    reconnectRepaired: async (hostId) => {
      reconnected.push(hostId);
    },
  });
  const invoke = (channel: string, document: FakeDocument | null, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    return Promise.resolve().then(() => handler({ document }, ...args));
  };
  return { invoke, reconnected };
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

test("typed setup addresses normalize to the endpoint a host seals", () => {
  const cases: [unknown, string | undefined][] = [
    ["studio.local:7319", "https://studio.local:7319/api/aiden/v1"],
    ["  HTTPS://Studio.tail0.ts.net/ ", "https://studio.tail0.ts.net/api/aiden/v1"],
    ["https://studio.tail0.ts.net:443/api/aiden/v1", "https://studio.tail0.ts.net/api/aiden/v1"],
    ["192.168.1.20:7319/api/aiden/v1/", "https://192.168.1.20:7319/api/aiden/v1"],
    ["http://studio.local:7319", undefined],
    ["ftp://studio.local", undefined],
    ["user@studio.local", undefined],
    ["studio.local/elsewhere", undefined],
    ["studio.local?x=1", undefined],
    ["studio local", undefined],
    ["", undefined],
    [42, undefined],
    ["a".repeat(301), undefined],
  ];
  for (const [input, expected] of cases) assert.equal(peerSetupAddress(input), expected, String(input));
});

test("discovery runs only while some document has the sheet open", async () => {
  let opened = 0;
  let closed = 0;
  let statusReads = 0;
  const discovery = new PeerDiscovery({
    tailscale: async () => {
      statusReads += 1;
      return null;
    },
    bootstrap: () => assert.fail("no candidates to probe"),
    browse: () => {
      opened += 1;
      return () => {
        closed += 1;
      };
    },
    localInstanceId: async () => "install_self",
    pairedIds: async () => [],
    publish: () => undefined,
  });
  const { invoke } = setup({ discovery });
  const first = new FakeDocument("window-1");
  const second = new FakeDocument("window-2");

  await assert.rejects(invoke("remote:peerDiscoveryStart", null), /active application document/u);
  await assert.rejects(invoke("remote:peerDiscoveryRefresh", first), /not open/u);
  assert.equal(opened, 0, "nothing scans before a sheet opens");

  assert.deepEqual(await invoke("remote:peerDiscoveryStart", first), { scanning: true, devices: [] });
  await invoke("remote:peerDiscoveryStart", second);
  assert.equal(opened, 1, "a second sheet joins the open scan");

  await invoke("remote:peerDiscoveryStop", first);
  assert.equal(closed, 0, "another sheet is still open");
  await invoke("remote:peerDiscoveryRefresh", second);
  assert.equal(statusReads, 2);
  assert.deepEqual([opened, closed], [2, 1]);

  second.navigate();
  assert.equal(closed, 2, "a reload closes the last sheet's scan");
  assert.equal(discovery.running, false);
  await assert.rejects(invoke("remote:peerDiscoveryStart", second), /document changed/u);
});

test("a connection request reports its match code to the requesting document only", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const { invoke, reconnected } = setup({
    discovery: foundDevices([{ instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" }]),
    registry,
  });
  const requester = new FakeDocument("window-1");
  const bystander = new FakeDocument("window-2");

  const unknown = (await invoke("remote:peerPairRequest", requester, "attempt-0001", "gone-device")) as PeerPairingResult;
  assert.deepEqual(unknown, {
    ok: false,
    outcome: { status: "failed", message: "That device is no longer listed. Search again." },
  });
  assert.equal(host.seen.length, 0);

  const pairing = invoke("remote:peerPairRequest", requester, "attempt-0002", host.instanceId) as Promise<PeerPairingResult>;
  await eventually(() => requester.received.length === 1);
  const progress = requester.received[0]!;
  assert.equal(progress.channel, "remote:peer-pairing-progress");
  assert.equal(progress.payload.attemptId, "attempt-0002");
  const prompt = host.requests.list()[0]!;
  assert.equal(progress.payload.matchCode, prompt.matchCode, "both screens show the same code");
  assert.equal(await invoke("remote:peerPairCancel", bystander, "attempt-0002"), false);
  await host.requests.respond(prompt.requestId, "allow");

  const result = await pairing;
  assert.ok(result.ok);
  assert.equal(result.host.id, host.instanceId);
  assert.equal(saved().length, 1);
  assert.deepEqual(bystander.received, []);
  assert.deepEqual(reconnected, [], "a new host is picked up by the supervisor on its own");
  const crossed = JSON.stringify([result, requester.received]);
  assert.ok(!crossed.includes("https://"), "no endpoint reaches the renderer");
  assert.ok(!crossed.includes(saved()[0]!.credential), "no credential reaches the renderer");
  assert.ok(!crossed.includes(saved()[0]!.serverSpkiSha256), "no pin reaches the renderer");
});

test("cancelling, or reloading the requesting document, withdraws the request", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const { invoke } = setup({
    discovery: foundDevices([{ instanceId: host.instanceId, endpoint: host.lanEndpoint, route: "lan" }]),
    registry,
  });
  const page = new FakeDocument("window-1");

  const cancelled = invoke("remote:peerPairRequest", page, "attempt-0001", host.instanceId) as Promise<PeerPairingResult>;
  await eventually(() => page.received.length === 1);
  await assert.rejects(
    invoke("remote:peerPairRequest", page, "attempt-0001", host.instanceId),
    /already running/u,
  );
  assert.equal(await invoke("remote:peerPairCancel", page, "attempt-0001"), true);
  assert.deepEqual(await cancelled, { ok: false, outcome: { status: "cancelled" } });
  await eventually(() => host.requests.list().length === 0);

  const reloaded = invoke("remote:peerPairRequest", page, "attempt-0002", host.instanceId) as Promise<PeerPairingResult>;
  await eventually(() => page.received.length === 2);
  page.navigate();
  assert.deepEqual(await reloaded, { ok: false, outcome: { status: "cancelled" } });
  await eventually(() => host.requests.list().length === 0);
  assert.deepEqual(saved(), []);
});

test("a setup code re-pairs a discovered device in place and resumes its supervision", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const { registry, saved } = registryFor(host);
  const found = host.lanEndpoint.replace("127.0.0.1", "localhost");
  const { invoke, reconnected } = setup({
    discovery: foundDevices([{ instanceId: host.instanceId, endpoint: found, route: "lan" }]),
    registry,
  });
  const page = new FakeDocument("window-1");

  assert.deepEqual(
    await invoke("remote:peerPairSetupCode", page, "attempt-0001", { address: "http://studio.local", code: "x" }),
    { ok: false, outcome: { status: "failed", message: "Enter the address shown on the other device." } },
  );
  const first = (await invoke("remote:peerPairSetupCode", page, "attempt-0002", {
    deviceId: host.instanceId,
    code: host.openSetupCode("lan"),
  })) as PeerPairingResult;
  assert.ok(first.ok, JSON.stringify(first));
  await registry.rename(host.instanceId, "Studio upstairs");
  const credential = saved()[0]!.credential;

  const code = host.openSetupCode("lan");
  assert.deepEqual(
    await invoke(
      "remote:peerPairSetupCode",
      page,
      "attempt-0003",
      { deviceId: host.instanceId, code: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ" },
      host.instanceId,
    ),
    { ok: false, outcome: { status: "invalid_code" } },
  );
  const again = (await invoke(
    "remote:peerPairSetupCode",
    page,
    "attempt-0004",
    { deviceId: host.instanceId, code },
    host.instanceId,
  )) as PeerPairingResult;
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.host.name, "Studio upstairs", "the local name survives a re-pair");
  assert.notEqual(saved()[0]!.credential, credential);
  assert.deepEqual(reconnected, [host.instanceId]);
});

test("pairing links and renames are validated before reaching the registry", async () => {
  const renames: [string, string][] = [];
  const registry = {
    pair: () => assert.fail("an invalid link is not paired"),
    pairWithRequest: () => assert.fail("unused"),
    pairWithSetupCode: () => assert.fail("unused"),
    rename: async (id: string, name: string) => {
      renames.push([id, name]);
      return { id, name, enabled: true, state: "connected" as const, features: [], capabilities: [] };
    },
  } as unknown as ReturnType<typeof registryFor>["registry"];
  const { invoke, reconnected } = setup({ discovery: foundDevices([]), registry });
  const page = new FakeDocument("window-1");

  assert.deepEqual(await invoke("remote:peerPairLink", page, "attempt-0001", "aiden://not-a-pairing"), {
    ok: false,
    outcome: { status: "failed", message: "That pairing link is not valid or has expired." },
  });
  await assert.rejects(invoke("remote:peerPairLink", page, "short", "x"), /Invalid pairing attempt/u);
  await assert.rejects(invoke("remote:peersRename", page, "../host", "Studio"), /Invalid host/u);
  await assert.rejects(invoke("remote:peersRename", page, "host_a", 7), /up to 80/u);
  await invoke("remote:peersRename", page, "host_a", "Studio");
  await assert.rejects(invoke("remote:peersRename", null, "host_a", "Studio"), /active application document/u);
  assert.deepEqual(renames, [["host_a", "Studio"]]);
  assert.deepEqual(reconnected, []);
});
