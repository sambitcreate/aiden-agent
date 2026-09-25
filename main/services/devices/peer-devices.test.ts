import assert from "node:assert/strict";
import test from "node:test";
import type { PeerHostView } from "../../../renderer/shared/peer-host.js";
import { PeerTransportError, type PeerRequest } from "../peer-transport.js";
import { createPeerDevices, parsePeerSimulatorListing, type PeerRegistryPort } from "./peer-devices.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const SIMULATOR = { id: UDID, name: "iPhone 17", platform: "ios", version: "iOS 27.0", booted: false, kind: "iphone" };

function host(id: string, enabled = true): PeerHostView {
  return { id, name: `Mac ${id}`, enabled, state: "connected", features: [], capabilities: [] } as PeerHostView;
}

function registry(answer: (id: string, input: Omit<PeerRequest, "credential">) => unknown): PeerRegistryPort & {
  requests: [string, Omit<PeerRequest, "credential">][];
} {
  const requests: [string, Omit<PeerRequest, "credential">][] = [];
  return {
    requests,
    list: async () => [host("a"), host("b", false)],
    request: async (id, input) => {
      requests.push([id, input]);
      return answer(id, input);
    },
    relayTarget: async (id) =>
      id === "a"
        ? { trust: { endpoint: "https://studio.local:47831/aiden/v1/", serverSpkiSha256: "pin" }, credential: "secret" }
        : null,
  };
}

test("listings are parsed fail-closed and hide devices while not sharing", () => {
  assert.deepEqual(parsePeerSimulatorListing({ sharing: true, status: "ready", devices: [SIMULATOR] }), {
    sharing: true,
    status: "ready",
    devices: [{ id: UDID, name: "iPhone 17", version: "iOS 27.0", booted: false, kind: "iphone" }],
  });
  assert.deepEqual(parsePeerSimulatorListing({ sharing: false, status: "ready", devices: [SIMULATOR] }).devices, []);
  for (const invalid of [
    null,
    { sharing: true, status: "exploded", devices: [] },
    { sharing: true, status: "ready", devices: [{ ...SIMULATOR, id: "../x" }] },
    { sharing: true, status: "ready", devices: [{ ...SIMULATOR, platform: "android" }] },
    { sharing: true, status: "ready", devices: Array.from({ length: 257 }, () => SIMULATOR) },
  ]) {
    assert.throws(() => parsePeerSimulatorListing(invalid), PeerTransportError);
  }
  assert.equal(
    parsePeerSimulatorListing({ sharing: true, status: "error", detail: "x".repeat(900), devices: [] }).detail?.length,
    300,
  );
});

test("only enabled paired hosts are offered", async () => {
  const peers = createPeerDevices(registry(() => ({})));
  assert.deepEqual(await peers.hosts(), [{ id: "a", name: "Mac a" }]);
});

test("simulator control is negotiated once per host and a missing feature is not an error", async () => {
  const port = registry((id, input) => {
    if (input.path === "/device/capabilities") {
      if (id === "old") throw new PeerTransportError("request_failed", 400);
      return { capabilities: ["chats:read", "simulators:control"] };
    }
    return { sharing: true, status: "ready", devices: [SIMULATOR] };
  });
  const peers = createPeerDevices(port);
  assert.equal((await peers.list("a"))?.devices.length, 1);
  assert.equal((await peers.list("a"))?.devices.length, 1);
  assert.deepEqual(
    port.requests.filter(([, input]) => input.path === "/device/capabilities"),
    [["a", { method: "POST", path: "/device/capabilities", body: { accepts: ["simulators:control"] } }]],
  );
  assert.equal(await peers.list("old"), null);
});

test("a transport failure is not remembered as an answer", async () => {
  let fail = true;
  const peers = createPeerDevices(
    registry((_id, input) => {
      if (input.path === "/device/capabilities") {
        if (fail) throw new PeerTransportError("unavailable");
        return { capabilities: ["simulators:control"] };
      }
      return { sharing: true, status: "ready", devices: [] };
    }),
  );
  await assert.rejects(peers.list("a"), PeerTransportError);
  fail = false;
  assert.deepEqual(await peers.list("a"), { sharing: true, status: "ready", devices: [] });
});

test("a peer that stops offering simulators is renegotiated on the next refresh", async () => {
  let offered = true;
  const port = registry((_id, input) => {
    if (input.path === "/device/capabilities") return { capabilities: offered ? ["simulators:control"] : [] };
    if (!offered) throw new PeerTransportError("request_failed", 404);
    return { sharing: true, status: "ready", devices: [] };
  });
  const peers = createPeerDevices(port);
  assert.ok(await peers.list("a"));
  offered = false;
  assert.equal(await peers.list("a"), null);
  assert.equal(await peers.list("a"), null);
  assert.equal(port.requests.filter(([, input]) => input.path === "/device/capabilities").length, 2);
});

test("controls send only the device id and validate the answer", async () => {
  const port = registry((_id, input) => {
    if (input.path === "/simulators/open") return { device: { ...SIMULATOR, booted: true } };
    if (input.path === "/simulators/settings" || input.path === "/simulators/action") return { appearance: "dark" };
    return { ok: true };
  });
  const peers = createPeerDevices(port);
  assert.equal((await peers.open("a", UDID)).booted, true);
  await peers.shutdown("a", UDID);
  assert.deepEqual(await peers.settings("a", UDID), { appearance: "dark" });
  await peers.action("a", { hostId: "a", deviceId: UDID, type: "setAppearance", value: "dark" });
  assert.deepEqual(
    port.requests.map(([, input]) => [input.path, input.body, input.timeoutMs]),
    [
      ["/simulators/open", { deviceId: UDID }, 200_000],
      ["/simulators/shutdown", { deviceId: UDID }, 200_000],
      ["/simulators/settings", { deviceId: UDID }, undefined],
      ["/simulators/action", { deviceId: UDID, type: "setAppearance", value: "dark" }, 200_000],
    ],
  );
  const wrong = createPeerDevices(registry(() => ({ device: { ...SIMULATOR, id: "OTHER-ID" } })));
  await assert.rejects(wrong.open("a", UDID), PeerTransportError);
});

test("the relay upstream carries the paired credential and pinned trust", async () => {
  const peers = createPeerDevices(registry(() => ({})));
  const upstream = await peers.upstream("a");
  assert.ok(upstream);
  assert.equal(upstream.origin, "https://studio.local:47831");
  assert.equal(upstream.basePath, "/aiden/v1/simulators/hub");
  assert.deepEqual(upstream.headers, { authorization: "Bearer secret", "aiden-protocol-version": "1" });
  assert.equal(upstream.tls.rejectUnauthorized, true);
  assert.equal(typeof upstream.tls.checkServerIdentity, "function");
  assert.equal(await peers.upstream("b"), null);
  await assert.rejects(peers.screenshot("b", UDID), /disabled or unavailable/u);
});
