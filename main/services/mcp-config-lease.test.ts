import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateChangedMcpConfigurationLeases,
  McpConfigurationLeaseRegistry,
  withMcpConfigurationPublication,
} from "./mcp-config-lease.js";
import type { McpServer } from "./types.js";

const server = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: "server-1",
  name: "Server",
  enabled: true,
  transport: "http",
  url: "https://example.test/mcp",
  ...overrides,
});

test("MCP configuration leases invalidate synchronously and epochs never revive", () => {
  const registry = new McpConfigurationLeaseRegistry();
  const first = registry.acquire("server-1");
  first.assertCurrent();
  registry.invalidate("server-1");
  assert.equal(first.signal.aborted, true);
  assert.throws(() => first.assertCurrent(), /configuration changed/u);

  const second = registry.acquire("server-1");
  assert.equal(second.epoch, first.epoch + 1);
  second.assertCurrent();
  assert.throws(() => registry.acquire(""), /Invalid MCP server/u);
});

test("abort observers synchronously acquire the already-published replacement epoch", () => {
  const registry = new McpConfigurationLeaseRegistry();
  const first = registry.acquire("server-1");
  let acquiredDuringAbort: ReturnType<typeof registry.acquire> | undefined;
  first.signal.addEventListener("abort", () => {
    acquiredDuringAbort = registry.acquire("server-1");
  });
  registry.invalidate("server-1");
  assert.equal(acquiredDuringAbort?.epoch, first.epoch + 1);
  assert.equal(acquiredDuringAbort?.signal.aborted, false);
  acquiredDuringAbort?.assertCurrent();
});

test("epoch exhaustion is rejected before aborting the current lease", () => {
  const registry = new McpConfigurationLeaseRegistry();
  const controller = new AbortController();
  const entries = (registry as unknown as {
    entries: Map<string, { epoch: number; controller: AbortController }>;
  }).entries;
  entries.set("server-1", { epoch: Number.MAX_SAFE_INTEGER, controller });
  const lease = registry.acquire("server-1");
  assert.throws(() => registry.invalidate("server-1"), /epoch was exhausted/u);
  assert.equal(lease.signal.aborted, false);
  lease.assertCurrent();
});

test("runtime configuration reconciliation invalidates only changed servers", () => {
  const registry = new McpConfigurationLeaseRegistry();
  const unchanged = registry.acquire("server-1");
  const changed = registry.acquire("server-2");
  invalidateChangedMcpConfigurationLeases(
    [server(), server({ id: "server-2", url: "https://old.test/mcp" })],
    [server(), server({ id: "server-2", url: "https://new.test/mcp" })],
    registry,
  );
  unchanged.assertCurrent();
  assert.throws(() => changed.assertCurrent(), /configuration changed/u);
});

test("two-sided publication invalidates a lease acquired while commit awaits", async () => {
  const registry = new McpConfigurationLeaseRegistry();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publication = withMcpConfigurationPublication(
    "server-1",
    () => paused,
    registry,
  );
  const duringCommit = registry.acquire("server-1");
  duringCommit.assertCurrent();
  release();
  await publication;
  assert.equal(duringCommit.signal.aborted, true);
  assert.throws(() => duringCommit.assertCurrent(), /configuration changed/u);
  registry.acquire("server-1").assertCurrent();
});
