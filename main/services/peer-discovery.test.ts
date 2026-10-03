import assert from "node:assert/strict";
import test from "node:test";
import type { PeerDiscoveryState } from "../../renderer/shared/peer-host.js";
import {
  PeerBootstrapTransport,
  type PeerBootstrapClient,
  type PeerBootstrapOptions,
  type PeerBootstrapRequest,
} from "./peer-bootstrap-transport.js";
import {
  PEER_PROBE_CONCURRENCY,
  PEER_PROBE_TIMEOUT_MS,
  PeerDiscovery,
  parseTailscalePeerNames,
  type PeerBonjourService,
  type PeerDiscoveryOptions,
} from "./peer-discovery.js";
import { startPeerTestHost } from "./peer-pairing-test-host.js";

function tailscaleStatus(peers: Record<string, unknown>[]): string {
  return JSON.stringify({
    Self: { DNSName: "this-mac.tail0.ts.net.", OS: "macOS", Online: true },
    Peer: Object.fromEntries(peers.map((peer, index) => [`nodekey:${index}`, peer])),
  });
}

/** Records every published state and resolves waiters when one matches. */
function publications() {
  const states: PeerDiscoveryState[] = [];
  const waiters: { match(state: PeerDiscoveryState): boolean; resolve(state: PeerDiscoveryState): void }[] = [];
  return {
    states,
    publish(state: PeerDiscoveryState) {
      states.push(state);
      for (const waiter of [...waiters])
        if (waiter.match(state)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(state);
        }
    },
    until(match: (state: PeerDiscoveryState) => boolean): Promise<PeerDiscoveryState> {
      const last = states[states.length - 1];
      if (last && match(last)) return Promise.resolve(last);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function discovery(
  overrides: Partial<PeerDiscoveryOptions> & Pick<PeerDiscoveryOptions, "bootstrap" | "publish">,
): PeerDiscovery {
  return new PeerDiscovery({
    tailscale: async () => null,
    browse: () => () => undefined,
    localInstanceId: async () => "this-installation",
    pairedIds: async () => [],
    browseSettleMs: 0,
    ...overrides,
  });
}

const settled = (state: PeerDiscoveryState) => !state.scanning;

test("only online desktop peers from tailscale status become candidates", () => {
  const names = parseTailscalePeerNames(
    tailscaleStatus([
      { DNSName: "Studio.tail0.ts.net.", OS: "macOS", Online: true },
      { DNSName: "build-box.tail0.ts.net.", OS: "linux", Online: true },
      { DNSName: "asleep.tail0.ts.net.", OS: "macOS", Online: false },
      { DNSName: "phone.tail0.ts.net.", OS: "iOS", Online: true },
      { DNSName: "gaming.tail0.ts.net.", OS: "windows", Online: true },
      { DNSName: "bare-name", OS: "linux", Online: true },
      { DNSName: "studio.tail0.ts.net", OS: "macOS", Online: true },
      { OS: "linux", Online: true },
    ]),
  );
  assert.deepEqual(names, ["studio.tail0.ts.net", "build-box.tail0.ts.net"]);
  assert.deepEqual(parseTailscalePeerNames("not json"), []);
  assert.deepEqual(parseTailscalePeerNames(JSON.stringify({ Peer: [] })), []);
  assert.deepEqual(
    parseTailscalePeerNames(" ".repeat(300 * 1_024)),
    [],
    "an oversized status is ignored rather than parsed",
  );
});

test("a desktop reachable over Tailscale and the LAN is listed once, by Tailscale", async (t) => {
  const host = await startPeerTestHost({ displayName: "Studio\u0007 Mac" });
  t.after(() => host.close());
  const probes: PeerBootstrapOptions[] = [];
  const announced: ((service: PeerBonjourService) => void)[] = [];
  let browsing = false;
  const seen = publications();
  const subject = discovery({
    tailscale: async () => ({
      run: async (args) => {
        assert.deepEqual(args, ["status", "--json"]);
        return tailscaleStatus([{ DNSName: "studio.tail0.ts.net.", OS: "macOS", Online: true }]);
      },
    }),
    browse: (onService) => {
      browsing = true;
      announced.push(onService);
      return () => {
        browsing = false;
      };
    },
    // The fixture serves both routes on loopback; discovery's names are mapped onto it.
    bootstrap: (options) => {
      probes.push(options);
      const endpoint = options.endpoint.startsWith("https://studio.tail0.ts.net/")
        ? host.tailscaleEndpoint
        : host.lanEndpoint;
      return new PeerBootstrapTransport({ endpoint, mode: options.mode, ca: host.caPem });
    },
    publish: seen.publish,
  });

  subject.start();
  assert.equal(browsing, true);
  announced[0]!({
    host: "Studio.local.",
    port: 7319,
    addresses: ["fe80::1", "192.168.1.20"],
    txt: { v: "1", instance: host.instanceId },
  });
  const state = await seen.until(
    (next) => settled(next) && next.devices[0]?.route === "tailscale",
  );

  assert.deepEqual(state.devices, [
    {
      id: host.instanceId,
      name: "Studio Mac",
      platform: "mac",
      route: "tailscale",
      pairingRequests: true,
      paired: false,
    },
  ]);
  assert.deepEqual(subject.target(host.instanceId), {
    instanceId: host.instanceId,
    endpoint: "https://studio.tail0.ts.net/api/aiden/v1",
    route: "tailscale",
  });
  assert.ok(
    seen.states.every((published) => !JSON.stringify(published).includes("https://")),
    "addresses stay in the main process",
  );
  const tailscaleProbe = probes.find((probe) => probe.endpoint.includes("tail0"));
  assert.equal(tailscaleProbe?.mode, "webpki");
  for (const probe of probes.filter((entry) => !entry.endpoint.includes("tail0")))
    assert.equal(probe.mode, "unverified");

  subject.stop();
  assert.equal(browsing, false);
  assert.deepEqual(await seen.until((next) => next.devices.length === 0), {
    scanning: false,
    devices: [],
  });
  assert.equal(subject.target(host.instanceId), undefined, "nothing outlives the sheet");
});

test("this installation is never offered and saved devices are marked paired", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const lanService = (port: number): PeerBonjourService => ({
    host: "studio.local",
    port,
    addresses: ["127.0.0.1"],
  });
  const port = Number(new URL(host.lanEndpoint).port);

  const self = publications();
  const asSelf = discovery({
    localInstanceId: async () => host.instanceId,
    browse: (onService) => {
      onService(lanService(port));
      return () => undefined;
    },
    bootstrap: (options) =>
      new PeerBootstrapTransport({ ...options, endpoint: options.endpoint.replace("studio.local", "127.0.0.1") }),
    publish: self.publish,
  });
  asSelf.start();
  const alone = await self.until(settled);
  assert.deepEqual(alone.devices, []);
  assert.ok(host.seen.includes("GET /api/aiden/v1/health"), "the host was probed");
  asSelf.stop();

  const other = publications();
  const asPeer = discovery({
    pairedIds: async () => [host.instanceId],
    browse: (onService) => {
      onService(lanService(port));
      return () => undefined;
    },
    bootstrap: (options) =>
      new PeerBootstrapTransport({ ...options, endpoint: options.endpoint.replace("studio.local", "127.0.0.1") }),
    publish: other.publish,
  });
  asPeer.start();
  const listed = await other.until((next) => settled(next) && next.devices.length === 1);
  assert.equal(listed.devices[0]?.route, "lan");
  assert.equal(listed.devices[0]?.paired, true);
  assert.equal(asPeer.target(host.instanceId)?.endpoint, `https://studio.local:${port}/api/aiden/v1`);
  asPeer.stop();
});

/** A bootstrap client whose health answers are released by the test. */
function heldProbes() {
  const pending: { endpoint: string; request: PeerBootstrapRequest; answer(value: unknown): void; fail(error: Error): void }[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    pending,
    get peak() {
      return peak;
    },
    factory(options: PeerBootstrapOptions): PeerBootstrapClient {
      return {
        observedSpki: undefined,
        json: (request) =>
          new Promise((resolve, reject) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            const done = () => {
              inFlight -= 1;
            };
            request.signal?.addEventListener("abort", () => {
              done();
              reject(new Error("aborted"));
            });
            pending.push({
              endpoint: options.endpoint,
              request,
              answer: (value) => {
                done();
                resolve(value);
              },
              fail: (error) => {
                done();
                reject(error);
              },
            });
          }),
      };
    },
  };
}

const health = (instanceId: unknown, extra: Record<string, unknown> = {}) => ({
  ok: true,
  protocolVersion: 1,
  instanceId,
  displayName: `Desktop ${String(instanceId)}`,
  contractRevision: 19,
  pairingRequests: false,
  ...extra,
});

test("health probes are bounded, time-limited and skip non-Aiden answers", async () => {
  const held = heldProbes();
  const seen = publications();
  const peers = Array.from({ length: 10 }, (_, index) => ({
    DNSName: `desk-${index}.tail0.ts.net.`,
    OS: index % 2 ? "linux" : "macOS",
    Online: true,
  }));
  const subject = discovery({
    tailscale: async () => ({ run: async () => tailscaleStatus(peers) }),
    bootstrap: (options) => held.factory(options),
    publish: seen.publish,
  });
  subject.start();
  await seen.until(() => held.pending.length === PEER_PROBE_CONCURRENCY);
  for (const { request } of held.pending) {
    assert.equal(request.path, "/health?detail=host");
    assert.equal(request.timeoutMs, PEER_PROBE_TIMEOUT_MS);
    assert.equal(request.method ?? "GET", "GET");
    assert.equal(request.credential, undefined);
  }

  let answered = 0;
  const answers: unknown[] = [
    health("desk-a", { pairingRequests: true, platform: "linux" }),
    { ok: true, protocolVersion: 2, instanceId: "desk-b" },
    { ok: true, protocolVersion: 1 },
    "<html>router login</html>",
    health("desk-c"),
    health("desk-a"),
  ];
  while (answered < peers.length) {
    const next = held.pending[answered];
    if (!next) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }
    answered += 1;
    const answer = answers[answered - 1];
    if (answer === undefined) next.fail(new Error("connect ECONNREFUSED"));
    else next.answer(answer);
  }
  const state = await seen.until(settled);

  assert.equal(held.peak, PEER_PROBE_CONCURRENCY);
  assert.deepEqual(
    state.devices.map(({ id, pairingRequests, platform }) => ({ id, pairingRequests, platform })),
    [
      { id: "desk-a", pairingRequests: true, platform: "linux" },
      { id: "desk-c", pairingRequests: false, platform: undefined },
    ],
  );
  subject.stop();
});

test("stopping ends the scan: probes abort, the browse closes and late answers are ignored", async () => {
  const held = heldProbes();
  const seen = publications();
  let runs = 0;
  let browses = 0;
  let closed = 0;
  let announce: ((service: PeerBonjourService) => void) | undefined;
  const subject = discovery({
    tailscale: async () => ({
      run: async () => {
        runs += 1;
        return tailscaleStatus([{ DNSName: "studio.tail0.ts.net.", OS: "macOS", Online: true }]);
      },
    }),
    browse: (onService) => {
      browses += 1;
      announce = onService;
      return () => {
        closed += 1;
      };
    },
    bootstrap: (options) => held.factory(options),
    publish: seen.publish,
  });

  subject.start();
  subject.start();
  await seen.until(() => held.pending.length === 1);
  assert.equal(runs, 1, "a second start joins the open scan");
  const inFlight = held.pending[0]!;
  subject.stop();
  assert.equal(inFlight.request.signal?.aborted, true);
  assert.equal(closed, 1);
  announce!({ host: "late.local", port: 7319, txt: { instance: "late" } });
  assert.equal(held.pending.length, 1, "a service announced after stop is not probed");
  assert.deepEqual(await seen.until(settled), { scanning: false, devices: [] });

  subject.refresh();
  assert.equal(browses, 2);
  await seen.until(() => held.pending.length === 2);
  assert.equal(runs, 2, "refresh reads tailscale status again");
  held.pending[1]!.answer(health("studio"));
  assert.deepEqual(
    (await seen.until((next) => settled(next) && next.devices.length === 1)).devices[0]?.id,
    "studio",
  );
  subject.stop();
});

test("without Tailscale or Bonjour the scan still finishes empty", async () => {
  const seen = publications();
  const subject = discovery({
    tailscale: async () => {
      throw new Error("tailscale is not installed");
    },
    browse: () => {
      throw new Error("multicast is unavailable");
    },
    bootstrap: () => {
      throw new Error("no probe expected");
    },
    publish: seen.publish,
  });
  subject.start();
  assert.deepEqual(await seen.until(settled), { scanning: false, devices: [] });
  subject.stop();
});

test("a LAN service whose .local name fails is probed at its IPv4 address", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const port = Number(new URL(host.lanEndpoint).port);
  const seen = publications();
  const subject = discovery({
    browse: (onService) => {
      onService({ host: "unresolvable.invalid", port, addresses: ["::1", "127.0.0.1"] });
      return () => undefined;
    },
    bootstrap: (options) => new PeerBootstrapTransport(options),
    publish: seen.publish,
  });
  subject.start();
  const state = await seen.until((next) => settled(next) && next.devices.length === 1);
  assert.equal(state.devices[0]?.id, host.instanceId);
  assert.equal(subject.target(host.instanceId)?.endpoint, host.lanEndpoint);
  subject.stop();
});
