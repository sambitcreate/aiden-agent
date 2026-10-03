import assert from "node:assert/strict";
import test from "node:test";
import { PeerBootstrapTransport } from "./peer-bootstrap-transport.js";
import { PeerHostRegistry, type StoredPeerHost } from "./peer-host-registry.js";
import { PeerPairingOutcomeError, type PeerPairingFailure } from "./peer-pairing-client.js";
import { startPeerTestHost, type PeerTestHost } from "./peer-pairing-test-host.js";
import { PeerTransport, PeerTransportError } from "./peer-transport.js";

function registryFor(host: PeerTestHost, options: { localInstanceId?: string } = {}) {
  let saved: StoredPeerHost[] = [];
  let repinned = 0;
  const registry = new PeerHostRegistry({
    storage: {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    localInstanceId: async () => options.localInstanceId ?? "install_self",
    deviceName: "Travel MacBook",
    clientVersion: "0.60.0",
    platform: "mac",
    // The fixture CA stands in for the system roots of a Tailscale certificate.
    client: (trust) =>
      new PeerTransport({
        endpoint: trust.endpoint,
        serverSpkiSha256: trust.serverSpkiSha256,
        caCertificateDerBase64: trust.caCertificateDerBase64 ?? host.caDerBase64,
      }),
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
