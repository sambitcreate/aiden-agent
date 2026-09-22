import assert from "node:assert/strict";
import test from "node:test";
import {
  aidenTailscaleHealthEndpoint,
  aidenTailscaleCanonicalLoopbackPort,
  aidenTailscaleCanonicalLoopbackTargets,
  classifyAidenTailscaleRoute,
  planAidenTailscaleConnect,
  planAidenTailscaleDisconnect,
  type AidenTailscaleStatus,
} from "./aiden-remote-tailscale-route.js";

const target = "http://127.0.0.1:43177/api/aiden/v1";
const status = (proxy?: string, funnel = false): AidenTailscaleStatus => ({
  TCP: { "443": { HTTPS: true } },
  Web: { "aiden-device.example.ts.net:443": { Funnel: funnel, Handlers: { "/other": { Proxy: "http://127.0.0.1:9" }, ...(proxy ? { "/api/aiden/v1": { Proxy: proxy } } : {}) } } },
});

test("Tailscale planning owns only the exact Aiden path and never resets or changes Funnel", () => {
  const before = status();
  const unrelated = JSON.stringify(before);
  const connect = planAidenTailscaleConnect(before, target);
  assert.deepEqual(connect, { action: "set", args: ["serve", "--https=443", "--set-path=/api/aiden/v1", target], ownership: { path: "/api/aiden/v1", target } });
  assert.equal(JSON.stringify(before), unrelated);
  assert.equal(planAidenTailscaleConnect(status(target), target, connect.ownership).action, "noop");
  assert.deepEqual(planAidenTailscaleDisconnect(status(target), target, connect.ownership), { action: "clear", args: ["serve", "--https=443", "--set-path=/api/aiden/v1", "off"] });
  assert.equal(planAidenTailscaleDisconnect(status(), target).action, "noop");
  assert.throws(() => planAidenTailscaleConnect(status(target), target), /tailscale_route_conflict/);
  assert.throws(() => planAidenTailscaleDisconnect(status(target), target), /tailscale_route_conflict/);
  assert.throws(() => planAidenTailscaleConnect(status("http://127.0.0.1:2/api/aiden/v1"), target), /tailscale_route_conflict/);
  assert.throws(() => planAidenTailscaleDisconnect(status("http://127.0.0.1:2/api/aiden/v1"), target), /tailscale_route_conflict/);
  assert.throws(() => planAidenTailscaleConnect(status(undefined, true), target), /tailscale_funnel_conflict/);
  assert.throws(
    () => planAidenTailscaleDisconnect(status(target, true), target, connect.ownership),
    /tailscale_funnel_conflict/u,
  );
  for (const unsafeTarget of [
    "https://127.0.0.1:43177",
    "http://127.0.0.2:43177",
    "http://0.0.0.0:43177",
    "http://127.0.0.1:43177/private",
    "http://127.0.0.1:43177/api/aiden/v1/private",
    "http://user:secret@127.0.0.1:43177",
    "http://aiden.example.test:43177",
  ]) {
    assert.throws(() => planAidenTailscaleConnect(status(), unsafeTarget), /tailscale_target_invalid/);
    assert.throws(() => planAidenTailscaleDisconnect(status(), unsafeTarget), /tailscale_target_invalid/);
  }
  assert.doesNotThrow(() => planAidenTailscaleConnect(status(), "http://[::1]:43177/api/aiden/v1"));
  assert.doesNotThrow(() => planAidenTailscaleConnect(status(), "http://localhost:43177/api/aiden/v1"));
});

test("Tailscale route classification is exact, ownership-aware, and Funnel-safe", () => {
  const ownership = { path: "/api/aiden/v1" as const, target };
  assert.deepEqual(classifyAidenTailscaleRoute(status(), target), { kind: "available" });
  assert.deepEqual(classifyAidenTailscaleRoute(status(target), target, ownership), { kind: "owned", target });
  const missingHttpsListener = status(target);
  delete missingHttpsListener.TCP;
  assert.deepEqual(
    classifyAidenTailscaleRoute(missingHttpsListener, target, ownership),
    { kind: "unrelated_conflict" },
  );
  assert.throws(
    () => planAidenTailscaleConnect(missingHttpsListener, target, ownership, true),
    /tailscale_route_conflict/u,
  );
  assert.deepEqual(classifyAidenTailscaleRoute(status(target), target), { kind: "other_aiden", target });
  assert.deepEqual(
    classifyAidenTailscaleRoute(status("http://127.0.0.1:43179/api/aiden/v1"), target),
    { kind: "other_aiden", target: "http://127.0.0.1:43179/api/aiden/v1" },
  );
  assert.deepEqual(
    classifyAidenTailscaleRoute(status("http://127.0.0.1:43179/private"), target),
    { kind: "unrelated_conflict" },
  );
  assert.deepEqual(classifyAidenTailscaleRoute(status(undefined, true), target), { kind: "funnel_conflict" });
  assert.deepEqual(
    classifyAidenTailscaleRoute(status(target, true), target, ownership),
    { kind: "funnel_conflict" },
  );
});

test("Tailscale health endpoints accept only exact canonical or legacy loopback targets", () => {
  assert.equal(aidenTailscaleHealthEndpoint(target), `${target}/health`);
  assert.equal(
    aidenTailscaleHealthEndpoint("http://localhost:43177"),
    "http://localhost:43177/api/aiden/v1/health",
  );
  assert.throws(
    () => aidenTailscaleHealthEndpoint("http://127.0.0.1:43177/private"),
    /tailscale_target_invalid/u,
  );
});

test("canonical route inspection returns only an exact loopback Aiden target port", () => {
  assert.equal(aidenTailscaleCanonicalLoopbackPort(status(target)), 43_177);
  assert.equal(
    aidenTailscaleCanonicalLoopbackPort(status("http://127.0.0.1:43177")),
    43_177,
  );
  assert.equal(aidenTailscaleCanonicalLoopbackPort(status()), undefined);
  assert.equal(
    aidenTailscaleCanonicalLoopbackPort(status("http://127.0.0.1:43177/private")),
    undefined,
  );
  assert.deepEqual(
    aidenTailscaleCanonicalLoopbackTargets({
      Web: {
        "malformed authority": {
          Handlers: { "/api/aiden/v1": { Proxy: target } },
        },
        "second.example.ts.net:443": {
          Handlers: { "/api/aiden/v1": { Proxy: "http://localhost:43179" } },
        },
      },
    }),
    [
      { target, port: 43_177 },
      { target: "http://localhost:43179", port: 43_179 },
    ],
  );
});

test("Tailscale permits origin-only legacy targets for exact owned cleanup but never for connect", () => {
  const legacyTarget = "http://127.0.0.1:43177";
  const ownership = { path: "/api/aiden/v1" as const, target: legacyTarget };
  assert.throws(
    () => planAidenTailscaleConnect(status(), legacyTarget),
    /tailscale_target_invalid/,
  );
  assert.deepEqual(
    planAidenTailscaleDisconnect(status(legacyTarget), legacyTarget, ownership),
    { action: "clear", args: ["serve", "--https=443", "--set-path=/api/aiden/v1", "off"] },
  );
});

test("Tailscale rejects raw and encoded path/query/fragment aliases before URL normalization", () => {
  for (const unsafeTarget of [
    `${target}/./`,
    `${target}/../`,
    `${target}/a/../`,
    `${target}/%2e/`,
    `${target}/%2e%2e/`,
    `${target}/%2E%2E/`,
    `${target}//`,
    `${target}?`,
    `${target}#`,
    `${target}/?`,
    `${target}/#`,
    `${target}?probe=1`,
    `${target}#probe`,
    "http://127.0.0.1:0/api/aiden/v1",
    "http://127.0.0.1:00001/api/aiden/v1",
    "http://127.0.0.1:65536/api/aiden/v1",
  ]) {
    assert.throws(() => planAidenTailscaleConnect(status(), unsafeTarget), /tailscale_target_invalid/);
    assert.throws(() => planAidenTailscaleDisconnect(status(), unsafeTarget), /tailscale_target_invalid/);
  }
});

test("Tailscale connect requires explicit TCP HTTPS capability while owned disconnect remains safe", () => {
  const withoutCapability: AidenTailscaleStatus = { Web: status(target).Web };
  const disabledCapability: AidenTailscaleStatus = { ...status(target), TCP: { "443": { HTTPS: false } } };
  for (const unavailable of [withoutCapability, disabledCapability]) {
    assert.throws(() => planAidenTailscaleConnect(unavailable, target), /tailscale_https_unavailable/);
    assert.throws(() => planAidenTailscaleConnect(unavailable, target, { path: "/api/aiden/v1", target }), /tailscale_https_unavailable/);
    assert.deepEqual(
      planAidenTailscaleDisconnect(unavailable, target, { path: "/api/aiden/v1", target }),
      { action: "clear", args: ["serve", "--https=443", "--set-path=/api/aiden/v1", "off"] },
    );
  }
  assert.deepEqual(
    planAidenTailscaleConnect({}, target, undefined, true),
    {
      action: "set",
      args: ["serve", "--https=443", "--set-path=/api/aiden/v1", target],
      ownership: { path: "/api/aiden/v1", target },
    },
  );
  assert.throws(
    () => planAidenTailscaleConnect(disabledCapability, target, undefined, true),
    /tailscale_https_unavailable/,
  );
});

test("Tailscale rejects malformed and noncanonical Web listener authorities", () => {
  for (const authority of [
    "aiden-device.example.ts.net:0443",
    "aiden-device.example.ts.net:+443",
    "aiden-device.example.ts.net:443 ",
    "aiden-device.example.ts.net",
    "aiden-device.example.ts.net:not-a-port",
    "aiden-device.example.ts.net:0",
    "[aiden-device.example.ts.net]:443",
  ]) {
    const malformedStatus: AidenTailscaleStatus = {
      TCP: { "443": { HTTPS: true } },
      Web: { [authority]: { Handlers: {} } },
    };
    assert.throws(() => planAidenTailscaleConnect(malformedStatus, target), /tailscale_route_conflict/);
    assert.throws(
      () => planAidenTailscaleDisconnect(malformedStatus, target, { path: "/api/aiden/v1", target }),
      /tailscale_route_conflict/,
    );
  }
});

test("Tailscale rejects multiple canonical HTTPS listeners instead of selecting one", () => {
  const multipleListeners: AidenTailscaleStatus = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "aiden-device.example.ts.net:443": { Handlers: {} },
      "other-device.example.ts.net:443": { Handlers: {} },
    },
  };
  assert.throws(() => planAidenTailscaleConnect(multipleListeners, target), /tailscale_route_conflict/);
  assert.throws(
    () => planAidenTailscaleDisconnect(multipleListeners, target, { path: "/api/aiden/v1", target }),
    /tailscale_route_conflict/,
  );
});
