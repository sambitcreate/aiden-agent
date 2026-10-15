import assert from "node:assert/strict";
import test from "node:test";
import { GenerationBoundConnectionCache } from "./generation-bound-connection-cache.js";
import { McpLiveStatusRegistry, recordMcpConnectionLifecycle, type McpLiveStatus } from "./mcp-status-events.js";

function observed() {
  const registry = new McpLiveStatusRegistry();
  const events: McpLiveStatus[] = [];
  registry.subscribe((status) => events.push(status));
  const cache = new GenerationBoundConnectionCache<{ id: number }>({
    onLifecycle: (id, event) => recordMcpConnectionLifecycle(id, event, registry),
  });
  return { registry, events, cache };
}

const noop = async () => undefined;

test("a connection's lifecycle is pushed as connecting, connected, then closed on disconnect", async () => {
  const { registry, events, cache } = observed();
  await cache.getOrConnect("docs", () => ({ id: 1 }), noop, noop);
  registry.inventory("docs", { toolCount: 4, resources: true });
  await cache.disconnect("docs");
  assert.deepEqual(
    events.map(({ state, toolCount, resources }) => ({ state, toolCount, resources })),
    [
      { state: "connecting", toolCount: undefined, resources: undefined },
      { state: "connected", toolCount: undefined, resources: undefined },
      { state: "connected", toolCount: 4, resources: true },
      { state: "closed", toolCount: 4, resources: true },
    ],
  );
});

test("a failed connect reports its error; a transport loss after connecting reports closed", async () => {
  const { registry, cache } = observed();
  await assert.rejects(
    cache.getOrConnect("docs", () => ({ id: 1 }), async () => { throw new Error("401 Unauthorized"); }, noop),
  );
  assert.deepEqual(registry.get("docs"), { serverId: "docs", state: "failed", error: "401 Unauthorized" });

  let lose = () => undefined as void;
  await cache.getOrConnect("docs", () => ({ id: 2 }), async (_value, _current, onClosed) => { lose = onClosed; }, noop);
  assert.equal(registry.get("docs")?.state, "connected");
  lose();
  assert.equal(registry.get("docs")?.state, "closed");
});

test("a superseded attempt is closed, never reported as a failure", async () => {
  const { registry, cache } = observed();
  let release!: () => void;
  const attempt = cache.getOrConnect(
    "docs",
    () => ({ id: 1 }),
    () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error("aborted")); }),
    noop,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const disconnected = cache.disconnect("docs");
  release();
  await assert.rejects(attempt);
  await disconnected;
  assert.equal(registry.get("docs")?.state, "closed");
});

test("a rejected refresh marks the server as needing sign-in until a sign-in succeeds", () => {
  const registry = new McpLiveStatusRegistry();
  const events: McpLiveStatus[] = [];
  registry.subscribe((status) => events.push(status));
  registry.inventory("linear", { toolCount: 2, resources: false });
  registry.authFailure("linear", "invalid-grant");
  registry.authFailure("linear", "invalid-grant");
  assert.equal(registry.needsSignIn("linear"), true);
  assert.equal(registry.get("linear")?.needsSignIn, true);
  // Later lifecycle events keep the flag until it is cleared.
  registry.connecting("linear");
  assert.equal(registry.get("linear")?.needsSignIn, true);
  registry.clearAuthFailure("linear");
  assert.equal(registry.needsSignIn("linear"), false);
  assert.equal(registry.get("linear")?.needsSignIn, undefined);
  assert.deepEqual(events.map((event) => Boolean(event.needsSignIn)), [false, true, true, false]);
});

test("a background sign-in redirect flags only a server that had a stored sign-in", () => {
  const registry = new McpLiveStatusRegistry();
  const events: McpLiveStatus[] = [];
  registry.subscribe((status) => events.push(status));
  // Prewarm of a server never signed in: no "expired or revoked" state.
  registry.backgroundSignInRequired("fresh", { hadStoredSignIn: false });
  assert.equal(registry.needsSignIn("fresh"), false);
  assert.equal(registry.get("fresh"), undefined);
  assert.deepEqual(events, []);
  // Stored tokens that no longer work: Settings must ask to sign in again.
  registry.backgroundSignInRequired("linear", { hadStoredSignIn: true });
  assert.equal(registry.needsSignIn("linear"), true);
  assert.equal(registry.get("linear")?.needsSignIn, true);
});

test("identical updates are not re-sent, errors are capped, and removal is pushed once", () => {
  const registry = new McpLiveStatusRegistry();
  const events: McpLiveStatus[] = [];
  registry.subscribe((status) => events.push(status));
  registry.failed("docs", new Error(`boom ${"x".repeat(1_000)}`));
  registry.failed("docs", new Error(`boom ${"x".repeat(1_000)}`));
  assert.equal(events.length, 1);
  assert.ok(events[0]!.error!.length <= 280);
  registry.forget("docs");
  registry.forget("docs");
  assert.deepEqual(events[events.length - 1], { serverId: "docs", state: "closed", removed: true });
  assert.equal(events.length, 2);
  assert.deepEqual(registry.snapshot(), []);
});

test("a same-count rediscovery with different tools is pushed with a new inventory revision", () => {
  const registry = new McpLiveStatusRegistry();
  const events: McpLiveStatus[] = [];
  registry.subscribe((status) => events.push(status));
  registry.inventory("docs", { toolCount: 1, resources: false, tools: [{ name: "old_tool" }] });
  const first = events[events.length - 1]!.toolsRevision;
  registry.inventory("docs", { toolCount: 1, resources: false, tools: [{ name: "new_tool" }] });
  assert.equal(events.length, 2, "the replacement is pushed although the count is unchanged");
  const second = events[events.length - 1]!.toolsRevision;
  assert.ok(first && second && first !== second);
  assert.deepEqual(registry.tools("docs"), [{ name: "new_tool" }]);

  // Reconnecting keeps the revision; an identical rediscovery is not re-sent.
  registry.connecting("docs");
  assert.equal(events[events.length - 1]!.toolsRevision, second);
  registry.inventory("docs", { toolCount: 1, resources: false, tools: [{ name: "new_tool" }] });
  const pushes = events.length;
  registry.inventory("docs", { toolCount: 1, resources: false, tools: [{ name: "new_tool" }] });
  assert.equal(events.length, pushes);
});
