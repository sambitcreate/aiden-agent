import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateAidenRemoteTlsIdentity } from "../aiden-remote-tls-identity.js";
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
    devices: [{ id: UDID, name: "iPhone 17", platform: "ios", version: "iOS 27.0", booted: false, kind: "iphone" }],
  });
  // A paired Mac's Android emulators carry their platform; stopped ones go by AVD name.
  const avd = { ...SIMULATOR, id: "Pixel_9_API_35", name: "Pixel 9", platform: "android", version: "Android 15.0", kind: "other" };
  assert.deepEqual(parsePeerSimulatorListing({ sharing: true, status: "ready", devices: [avd] }).devices, [
    { id: "Pixel_9_API_35", name: "Pixel 9", platform: "android", version: "Android 15.0", booted: false, kind: "other" },
  ]);
  assert.deepEqual(parsePeerSimulatorListing({ sharing: false, status: "ready", devices: [SIMULATOR] }).devices, []);
  for (const invalid of [
    null,
    { sharing: true, status: "exploded", devices: [] },
    { sharing: true, status: "ready", devices: [{ ...SIMULATOR, id: "../x" }] },
    { sharing: true, status: "ready", devices: [{ ...SIMULATOR, platform: "watchos" }] },
    { sharing: true, status: "ready", devices: [{ ...SIMULATOR, id: "-s" }] },
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
  // "Not offered" is never remembered, so turning the feature back on is found without a restart.
  offered = true;
  assert.ok(await peers.list("a"));
  assert.equal(port.requests.filter(([, input]) => input.path === "/device/capabilities").length, 3);
});

test("a Mac that answered not found is asked again after it upgrades", async () => {
  let upgraded = false;
  const peers = createPeerDevices(
    registry((_id, input) => {
      if (input.path === "/device/capabilities") {
        if (!upgraded) throw new PeerTransportError("request_failed", 404);
        return { capabilities: ["simulators:control"] };
      }
      return { sharing: true, status: "ready", devices: [] };
    }),
  );
  assert.equal(await peers.list("a"), null);
  upgraded = true;
  assert.deepEqual(await peers.list("a"), { sharing: true, status: "ready", devices: [] });
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
      ["/simulators/open", { deviceId: UDID }, 220_000],
      ["/simulators/shutdown", { deviceId: UDID }, 220_000],
      ["/simulators/settings", { deviceId: UDID }, undefined],
      ["/simulators/action", { deviceId: UDID, type: "setAppearance", value: "dark" }, 220_000],
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
  await assert.rejects(peers.screenshot("b", UDID, "ios"), /disabled or unavailable/u);
});

test("screenshots come from serve-sim for iOS and from serve-emu's GET for Android, over pinned TLS", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-peer-shot-"));
  const identity = await loadOrCreateAidenRemoteTlsIdentity({ directory });
  const seen: { method: string; url: string; body: string; auth?: string }[] = [];
  const relay = createHttpsServer({ key: identity.privateKey, cert: identity.certificateChain }, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({ method: request.method!, url: request.url!, body, auth: request.headers.authorization });
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const trust = {
    endpoint: `https://127.0.0.1:${address.port}/aiden/v1/`,
    serverSpkiSha256: identity.serverSpkiSha256,
    caCertificateDerBase64: new X509Certificate(identity.caCertificate).raw.toString("base64"),
  };
  const peers = createPeerDevices({
    list: async () => [host("a")],
    request: async () => ({}),
    relayTarget: async () => ({ trust, credential: "secret" }),
  });
  try {
    assert.deepEqual([...(await peers.screenshot("a", UDID, "ios"))], [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual([...(await peers.screenshot("a", "emulator-5554", "android"))], [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual(seen, [
      { method: "POST", url: "/aiden/v1/simulators/hub/vendor/serve-sim/api/screenshot", body: JSON.stringify({ udid: UDID }), auth: "Bearer secret" },
      { method: "GET", url: "/aiden/v1/simulators/hub/vendor/serve-emu/api/screenshot?device=emulator-5554", body: "", auth: "Bearer secret" },
    ]);
  } finally {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a paired Mac's AVD accepts the emulator serial it boots under", async () => {
  const peers = createPeerDevices(
    registry((_id, input) =>
      input.path === "/simulators/open"
        ? { device: { id: "emulator-5554", name: "Pixel 9", platform: "android", version: "Android 15.0", booted: true, kind: "other" } }
        : { device: { ...SIMULATOR, id: "99999999-2222-3333-4444-555555555555" } },
    ),
  );
  assert.equal((await peers.open("a", "Pixel_9_API_35")).id, "emulator-5554");
  // Any other Android id is not a serial an AVD boots under.
  const renamed = createPeerDevices(
    registry(() => ({
      device: { id: "Pixel_Tablet_API_36", name: "Pixel Tablet", platform: "android", version: "Android 16.0", booted: true, kind: "other" },
    })),
  );
  await assert.rejects(renamed.open("a", "Pixel_9_API_35"), PeerTransportError);
  // An iOS simulator must come back under the UDID that was asked for.
  const ios = createPeerDevices(registry(() => ({ device: { ...SIMULATOR, id: "99999999-2222-3333-4444-555555555555" } })));
  await assert.rejects(ios.open("a", UDID), PeerTransportError);
});
