import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpProviderAuthHandler, registerProviderKeySharingHandler } from "./mcp-provider-auth.js";
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

test("connector key sharing is set only from the live document, and main's refusal reaches the caller", async () => {
  const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
  let destroyed = false;
  const allowed = new Set<string>();
  registerProviderKeySharingHandler<string>({
    handle: (name, handler) => { handlers.set(name, handler); },
    owner(event) { if (event !== "settings") throw new Error("Untrusted document"); return { isDestroyed: () => destroyed }; },
    async set(providerId, allow, isCurrent) {
      assert.equal(isCurrent(), true);
      if (allow && providerId === "anthropic") throw new Error("Sign-in and subscription credentials are never shared with connectors.");
      if (allow) allowed.add(providerId); else allowed.delete(providerId);
    },
  });
  const invoke = (event: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get("providers:setConnectorKeySharing")!(event, ...args));
  assert.deepEqual(await invoke("settings", "openai", true), { connectorKeySharing: true });
  assert.deepEqual([...allowed], ["openai"]);
  await assert.rejects(invoke("settings", "anthropic", true), /never shared/u);
  await assert.rejects(invoke("settings", "openai", "yes"), /Choose whether/u);
  await assert.rejects(invoke("settings", "", true), /Choose a provider/u);
  await assert.rejects(invoke("foreign", "groq", true), /Untrusted/u);
  assert.deepEqual(await invoke("settings", "openai", false), { connectorKeySharing: false });
  assert.equal(allowed.size, 0);
});
