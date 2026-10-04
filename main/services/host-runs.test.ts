import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import * as registryModule from "./host-run-registry.js";
import { HostRunRegistry, type HostRunEvent } from "./host-run-registry.js";

type HostRunsModule = typeof import("./host-runs.js");

// Load the wiring module with the Electron-backed platform replaced by a
// recording logger, and the real registry module beside it.
const serviceCode = transformSync(
  readFileSync(new URL("./host-runs.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs" },
).code;

function loadHostRuns() {
  const warnings: unknown[][] = [];
  const module = { exports: {} as HostRunsModule };
  new Function("require", "module", "exports", serviceCode)(
    (specifier: string) => {
      if (specifier === "../platform.js") {
        return { logger: { warn: (...args: unknown[]) => warnings.push(args) } };
      }
      if (specifier === "./host-run-registry.js") return registryModule;
      throw new Error(`Unexpected import ${specifier}`);
    },
    module,
    module.exports,
  );
  return { hostRuns: module.exports, warnings };
}

function eventTypes(registry: HostRunRegistry, runId: string): string[] {
  const read = registry.read(runId, 0);
  assert.equal(read.kind, "events");
  return read.events.map((event: HostRunEvent) => event.type);
}

test("hostRunOriginFor separates paired devices, renderer windows and headless owners", () => {
  const { hostRuns } = loadHostRuns();
  assert.equal(hostRuns.hostRunOriginFor({ kind: "remote", id: 0 }), "remote");
  assert.equal(hostRuns.hostRunOriginFor({ id: 7 }), "renderer");
  assert.equal(hostRuns.hostRunOriginFor({ id: 0 }), "headless");
});

test("the recorders journal a renderer run from begin through settle", () => {
  const { hostRuns, warnings } = loadHostRuns();
  let now = 1_000;
  const registry = new HostRunRegistry({ now: () => now });
  const owner = { id: 3 };

  hostRuns.recordRunBegin(registry, "stream-1", "chat-1", owner);
  assert.deepEqual(
    {
      origin: registry.summary("stream-1")?.origin,
      state: registry.summary("stream-1")?.state,
      chat: registry.currentRunForChat("chat-1")?.runId,
    },
    { origin: "renderer", state: "working", chat: "stream-1" },
  );

  now += 10;
  hostRuns.recordRunNotification(registry, "stream-1", "chat:delta", { streamId: "stream-1", delta: "Hi" });
  hostRuns.recordRunNotification(registry, "stream-1", "chat:approval", {
    approvalId: "approval-1",
    streamId: "stream-1",
    summary: "Run the tests",
    toolCallId: "call-1",
    toolName: "run_command",
  });
  assert.equal(registry.summary("stream-1")?.state, "needs_approval");
  assert.deepEqual(registry.summary("stream-1")?.pendingApprovalIds, ["approval-1"]);

  hostRuns.recordRunAttentionResolved(registry, "approval-1");
  assert.equal(registry.summary("stream-1")?.state, "working");
  assert.deepEqual(registry.summary("stream-1")?.pendingApprovalIds, []);

  hostRuns.recordRunNotification(registry, "stream-1", "chat:done", { streamId: "stream-1", content: "Hi" });
  const beforeSettle = registry.summary("stream-1")?.lastSequence;
  hostRuns.recordRunSettled(registry, "stream-1");

  const summary = registry.summary("stream-1");
  assert.equal(summary?.state, "done");
  assert.equal(summary?.lastSequence, beforeSettle, "settle after an outcome appends nothing");
  assert.deepEqual(eventTypes(registry, "stream-1"), [
    "run_started",
    "text_delta",
    "approval_required",
    "approval_resolved",
    "done",
  ]);
  assert.deepEqual(warnings, []);
});

test("settling a run that never reported an outcome ends it failed", () => {
  const { hostRuns } = loadHostRuns();
  const registry = new HostRunRegistry({ now: () => 1_000 });

  hostRuns.recordRunBegin(registry, "stream-2", "chat-2", { kind: "remote", id: 0 });
  hostRuns.recordRunSettled(registry, "stream-2");

  const summary = registry.summary("stream-2");
  assert.equal(summary?.origin, "remote");
  assert.equal(summary?.state, "failed");
  const read = registry.read("stream-2", 1);
  assert.equal(read.kind, "events");
  assert.deepEqual(
    read.events.map((event) => ({ type: event.type, terminal: event.terminal, code: event.payload.code })),
    [{ type: "error", terminal: true, code: "run_ended_without_outcome" }],
  );
});

test("a faulty journal is logged and never thrown into the generation", () => {
  const { hostRuns, warnings } = loadHostRuns();
  const fault = () => {
    throw new Error("journal fault");
  };
  const broken = {
    begin: fault,
    publish: fault,
    resolveAttention: fault,
    settle: fault,
  } as unknown as HostRunRegistry;

  hostRuns.recordRunBegin(broken, "stream-3", "chat-3", { id: 0 });
  hostRuns.recordRunNotification(broken, "stream-3", "chat:delta", { delta: "x" });
  hostRuns.recordRunAttentionResolved(broken, "approval-3");
  hostRuns.recordRunSettled(broken, "stream-3");

  assert.equal(warnings.length, 4);
  for (const warning of warnings) assert.equal(warning[0], "remote");
});
