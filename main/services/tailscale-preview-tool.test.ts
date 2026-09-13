import assert from "node:assert/strict";
import test from "node:test";
import { canUseTailscalePreviewTool, createTailscalePreviewTool, type TailscalePreviewPort } from "./tailscale-preview-tool.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import { APPROVAL_TOOL_NAMES, summarizeToolCall } from "./coding-tools.js";

test("preview eligibility permits native foreground chat but excludes ambient authority", () => {
  const input = { workspaceId: "w", folderPath: "/workspace", permission: "full", assistantMode: false, bot: false, usageSource: "chat" };
  assert.equal(canUseTailscalePreviewTool(input), true);
  assert.equal(canUseTailscalePreviewTool({ ...input, permission: "ask" }), true);
  for (const override of [{ permission: "none" }, { permission: "read-only" }, { assistantMode: true }, { bot: true }, { workspaceId: "" }, { folderPath: "" }, { usageSource: "scheduled" }, { usageSource: "subagent" }, { usageSource: undefined }]) {
    assert.equal(canUseTailscalePreviewTool({ ...input, ...override }), false);
  }
});

function harness() {
  const abort = new AbortController();
  const calls: unknown[] = [];
  let current = true;
  let onLoad = () => {};
  let onEffect = () => {};
  const port: TailscalePreviewPort = {
    open: async (workspaceId, input, guard) => { onEffect(); await guard(); calls.push({ workspaceId, ...input }); return { id: "preview", url: "http://host.tail.ts.net:3000", status: "active" }; },
    list: async (workspaceId) => { calls.push({ workspaceId }); return []; },
    stop: async (workspaceId, input, guard) => { onEffect(); await guard(); calls.push({ workspaceId, ...input }); return { stopped: true }; },
  };
  const tool = createTailscalePreviewTool({ workspaceId: "workspace", signal: abort.signal,
    revalidate: async () => { if (!current) throw new Error("revoked"); },
    service: async () => { onLoad(); return port; },
  });
  return { tool, abort, calls, revoke: () => { current = false; }, load: (fn: () => void) => { onLoad = fn; }, effect: (fn: () => void) => { onEffect = fn; }, call: (args: Record<string, unknown>, signal?: AbortSignal) => tool.execute("call", args, signal) };
}

test("returns native HTTP URL and pins all operations to one workspace", async () => {
  const h = harness();
  const result = await h.call({ action: "open", localPort: 3000, exposedPort: 8080 });
  assert.match(JSON.stringify(result.content), /http:\/\/host.tail.ts.net:3000/);
  await h.call({ action: "list" });
  await h.call({ action: "stop", id: "preview" });
  assert.deepEqual(h.calls, [{ workspaceId: "workspace", localPort: 3000, exposedPort: 8080 }, { workspaceId: "workspace" }, { workspaceId: "workspace", id: "preview" }]);
  assert.equal(piRuntimeReplayPolicy(h.tool), "never");
  assert.equal(APPROVAL_TOOL_NAMES.has(h.tool.name), true);
  assert.match(summarizeToolCall(h.tool.name, { action: "open", localPort: 3000, exposedPort: 8080 }), /localhost:3000.*HTTP.*8080/);
});

test("rejects invalid ports, arbitrary targets and conflicting action fields before service access", async () => {
  for (const args of [{ action: "open" }, { action: "open", localPort: 443 }, { action: "open", localPort: 65536 }, { action: "open", localPort: 3000.5 }, { action: "open", localPort: 3000, target: "http://elsewhere" }, { action: "list", localPort: 3000 }, { action: "stop" }, { action: "stop", id: "preview", exposedPort: 3000 }]) {
    const h = harness();
    await assert.rejects(h.call(args), JSON.stringify(args));
    assert.deepEqual(h.calls, []);
  }
});

test("revocation and both cancellation signals block effects across awaits", async () => {
  for (const boundary of ["before", "factory", "effect"]) {
    const h = harness();
    if (boundary === "before") h.revoke();
    if (boundary === "factory") h.load(h.revoke);
    if (boundary === "effect") h.effect(h.revoke);
    await assert.rejects(h.call({ action: "open", localPort: 3000 }), /revoked/);
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  h.load(() => h.abort.abort());
  await assert.rejects(h.call({ action: "open", localPort: 3000 }));
  const h2 = harness();
  await assert.rejects(h2.call({ action: "stop", id: "preview" }, AbortSignal.abort()));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h2.calls, []);
});
