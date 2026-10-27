import assert from "node:assert/strict";
import test from "node:test";
import { botHealthStatus } from "../../../renderer/shared/bot-health.js";
import { runBotHealthChecks, type BotHealthCheckDeps } from "./checks.js";

function deps(overrides: Partial<BotHealthCheckDeps> = {}) {
  const calls: string[] = [];
  const base: BotHealthCheckDeps = {
    sessionState: async () => { calls.push("state"); return "idle"; },
    refreshModelBinding: async () => { calls.push("model"); return "current"; },
    providerAuth: async () => { calls.push("auth"); return "ok"; },
    connections: async () => { calls.push("connections"); return { degraded: [] }; },
    computer: async () => { calls.push("computer"); return "none"; },
  };
  return { calls, deps: { ...base, ...overrides } };
}

const options = { trigger: "manual" as const, signal: new AbortController().signal, now: () => 1 };

function statusOf(report: Awaited<ReturnType<typeof runBotHealthChecks>>, id: string) {
  return report.results.find((result) => result.id === id)?.status;
}

test("a stale model fingerprint is repaired, not reported", async () => {
  const { deps: d } = deps({ refreshModelBinding: async () => "repaired" });
  const report = await runBotHealthChecks("bot-1", d, options);
  assert.equal(statusOf(report, "model"), "repaired");
  assert.equal(report.results.some((result) => result.status === "needs_you"), false);
});

test("a signed-out provider stops the network checks after it", async () => {
  const { calls, deps: d } = deps({ providerAuth: async () => { calls.push("auth"); return "signed_out"; } });
  const report = await runBotHealthChecks("bot-1", d, options);
  assert.equal(statusOf(report, "provider_auth"), "needs_you");
  assert.equal(report.results.find((result) => result.id === "provider_auth")?.failure?.kind, "sign_in");
  assert.deepEqual(calls, ["state", "model", "auth"]);
  assert.equal(statusOf(report, "connections"), "skipped");
});

test("a degraded connection names the connection", async () => {
  const { deps: d } = deps({ connections: async () => ({ degraded: [{ id: "c1", label: "Gmail" }] }) });
  const report = await runBotHealthChecks("bot-1", d, options);
  const result = report.results.find((entry) => entry.id === "connections");
  assert.equal(result?.status, "needs_you");
  assert.equal(result?.label, "Gmail needs reconnecting");
});

test("the computer check only reads, and a stale computer needs the person", async () => {
  const { calls, deps: d } = deps({ computer: async () => { calls.push("computer"); return "stale"; } });
  const report = await runBotHealthChecks("bot-1", d, options);
  assert.equal(statusOf(report, "computer"), "needs_you");
  // The deps object has no way to start a VM; only the read port was called.
  assert.equal(calls.filter((call) => call === "computer").length, 1);
});

test("a paused Bot is not checked further", async () => {
  const { calls, deps: d } = deps({ sessionState: async () => "paused" });
  const report = await runBotHealthChecks("bot-1", d, options);
  assert.deepEqual(calls, []);
  assert.ok(report.results.every((result) => result.status === "skipped"));
});

test("an admission error reads as a model that changed", async () => {
  const { deps: d } = deps({ refreshModelBinding: async () => { throw new Error("capability_changed"); } });
  const report = await runBotHealthChecks("bot-1", d, options);
  assert.equal(statusOf(report, "model"), "needs_you");
});

test("botHealthStatus prefers paused, then needs_you", () => {
  assert.equal(botHealthStatus({ paused: true, sessionState: "idle", openIssues: 2 }), "paused");
  assert.equal(botHealthStatus({ paused: false, sessionState: "idle", openIssues: 1 }), "needs_you");
  assert.equal(botHealthStatus({ paused: false, sessionState: "needs_model", openIssues: 0 }), "needs_you");
  assert.equal(botHealthStatus({ paused: false, sessionState: "idle", openIssues: 0 }), "ok");
  assert.equal(botHealthStatus({
    paused: false, sessionState: "idle", openIssues: 0,
    report: { botId: "b", checkedAt: 1, trigger: "manual", results: [{ id: "model", status: "repaired", label: "AI model" }] },
  }), "ok", "a repaired check is not a problem");
});
