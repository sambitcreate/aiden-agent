import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpProviderAuthHandler } from "./mcp-provider-auth.js";
import { mcpProviderGrantBinding } from "../services/mcp-provider-auth-core.js";

const server = { id: "docs", name: "Docs", transport: "http", url: "https://tools.test/mcp", enabled: true, authProvider: "openai" };

test("provider consent IPC requires a live trusted document and returns only approval status", async () => {
  const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
  let destroyed = false;
  let grant: string | null = null;
  registerMcpProviderAuthHandler<string>({
    handle: (name, handler) => { handlers.set(name, handler); },
    owner(event) { if (event !== "settings") throw new Error("Untrusted document"); return { isDestroyed: () => destroyed }; },
    async publish(parsed, allowed, isCurrent) { assert.equal(isCurrent(), true); grant = allowed ? mcpProviderGrantBinding(parsed) : null; },
  });
  const invoke = handlers.get("mcp:providerAuth")!;
  await assert.rejects(Promise.resolve().then(() => invoke("foreign", server, true)), /Untrusted/u);
  await assert.rejects(Promise.resolve().then(() => invoke("settings", server, "true")), /Choose whether/u);
  await assert.rejects(Promise.resolve().then(() => invoke("settings", { ...server, headers: { Authorization: "secret" } }, true)), /without OAuth/u);
  assert.equal(grant, null);
  assert.deepEqual(await invoke("settings", server, true), { authorized: true });
  assert.ok(grant);
  assert.deepEqual(await invoke("settings", server, false), { authorized: false });
  assert.equal(grant, null);
  destroyed = true;
  await assert.rejects(Promise.resolve().then(() => invoke("settings", server, true)), /active application/u);
  assert.equal(grant, null);
});
