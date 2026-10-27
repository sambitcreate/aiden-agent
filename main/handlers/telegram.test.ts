import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

async function harness() {
  type Handler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const calls: unknown[] = [];
  const proof = { code: "synthetic-proof", expiresAt: 300_000 };
  let permission = "none";
  const mocks: Record<string, unknown> = {
    "../platform.js": { ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), broadcast() {} } },
    "../services/config-store.js": { configStore: { getWorkspace: async () => ({ id: "ws", folderPath: "/workspace", permission }), setSettings: async () => {} } },
    "../services/telegram/telegram-service.js": { telegramService: {
      beginPairing: async (profile: string) => { calls.push(["begin", profile]); return proof; },
      cancelPairing: (profile: string) => { calls.push(["cancel", profile]); },
      resetPairing: async () => { calls.push(["reset"]); },
      pairingStatus: () => ({ expiresAt: proof.expiresAt }),
      getActiveSettings: async () => ({ telegramEnabled: true }),
      getStatus: () => ({ status: "polling", queuedCount: 0, recentDiagnostics: [] }),
      hasActiveToken: async () => true,
      listProfiles: async () => [],
      setActiveSettings: async (patch: unknown) => { calls.push(patch); },
      activeProfile: "work",
    } },
  };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./telegram.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: Object.keys(mocks) });
  const module = { exports: {} as typeof import("./telegram.js") };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name.startsWith("node:")) return require(name);
    assert.ok(name in mocks, `Unexpected dependency ${name}`);
    return mocks[name];
  }, module, module.exports);
  module.exports.registerTelegramHandlers();
  return { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args), calls, proof, permission: (value: string) => { permission = value; } };
}

test("pairing proof is returned only by explicit profile-bound begin; status exposes expiry only", async () => {
  const h = await harness();
  assert.deepEqual(await h.invoke("telegram:beginPairing", "work"), h.proof);
  assert.deepEqual(await h.invoke("telegram:cancelPairing", "work"), { cancelled: true });
  assert.deepEqual(h.calls, [["begin", "work"], ["cancel", "work"]]);
  const status = await h.invoke("telegram:get");
  assert.equal(JSON.stringify(status).includes(h.proof.code), false);
  assert.deepEqual((status as { pairing: unknown }).pairing, { expiresAt: h.proof.expiresAt });
});

test("workspace selection rejects No Access and preserves the explicit Ask automation grant", async () => {
  const h = await harness();
  await assert.rejects(Promise.resolve(h.invoke("telegram:setWorkspace", "ws")), /No Access/u);
  assert.deepEqual(h.calls, []);
  h.permission("ask");
  await h.invoke("telegram:setWorkspace", "ws");
  assert.deepEqual(h.calls, [{ telegramWorkspaceId: "ws" }]);
  await h.invoke("telegram:setWorkspace", undefined);
  assert.deepEqual(h.calls[1], { telegramWorkspaceId: undefined });
});
