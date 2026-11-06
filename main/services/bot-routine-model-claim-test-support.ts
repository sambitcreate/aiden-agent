// Synthetic protected authority for scheduler/event process-boundary tests.
// No provider transport, production credential or Electron binding is loaded.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { TestContext } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DataStore } from "./data-store.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import { createBotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import { createBotCapabilityStateCheckpoint, type BotCapabilityBootstrapMarkerState } from "./bot-capability-state-checkpoint.js";
import { buildBotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import { bindBotProviderModel, createBotCapabilityOpaqueIdMint } from "./bot-capability-bindings.js";
import { createBotRoutineModelService } from "./bot-routine-models.js";

export async function openProtectedRoutineClaims(root: string, botId: string, routineId: string) {
  const device = new DataStore<{ anchor: string | null; marker: BotCapabilityBootstrapMarkerState | null }>("synthetic-device-state.json", { anchor: null, marker: null }, () => root, { fileMode: 0o600, compact: true });
  const store = createBotCapabilityStore({ root: () => root, checkpoint: createBotCapabilityStateCheckpoint({
    root: () => root, keyStore: createBotCapabilityOpaqueKeyStore({ root: () => root }),
    anchor: { load: async () => (await device.load()).anchor, store: async (value, expected) => device.update(draft => { if (draft.anchor !== expected) throw new Error("Stale synthetic anchor"); draft.anchor = value; }) },
    bootstrapMarker: { load: async () => (await device.load()).marker, store: async (value, expected) => device.update(draft => { if (JSON.stringify(draft.marker) !== JSON.stringify(expected)) throw new Error("Stale synthetic marker"); draft.marker = value; }) },
    inspectInitialBootstrap: async () => "clean" as const,
  }) });
  await store.initialize();
  const fp = (value: string) => createHash("sha256").update(value).digest("hex");
  const snapshot = buildBotCapabilityCatalogSnapshot({ inventory: {
    providers: [{ sourceId: "fixture", label: "Synthetic provider", available: true, connectionFingerprint: fp("connection"), models: ["A", "B"].map(id => ({ sourceId: id, label: `Model ${id}`, available: true, modelFingerprint: fp(id) })) }],
    fileScopes: [{ sourceId: "full", label: "Full Mac", available: false, kind: "full_mac", scopeFingerprint: fp("full") }, { sourceId: "home", label: "Bot folder", available: false, kind: "bot_home", scopeFingerprint: fp("home") }], shell: { available: false, shellFingerprint: fp("shell") }, connections: [], skills: [], otherCapabilities: [],
  }, notice: { version: "bot-full-access-v1", requiresAcknowledgement: true }, mintOpaqueId: createBotCapabilityOpaqueIdMint(Buffer.alloc(32, 9)) });
  const provider = snapshot.catalog.providers[0]!;
  const models = createModels(); models.setProvider(fauxProvider({ provider: "fixture", models: [{ id: "A" }, { id: "B" }] }).provider);
  const service = createBotRoutineModelService({
    persistence: { read: () => store.getRoutineModelsState(), write: (...args) => store.saveRoutineModelsState(...args) },
    identity: async (owner, routine) => { if (owner !== botId || routine !== undefined && routine !== routineId) throw new Error("Unknown synthetic owner"); return { botIncarnation: "test-bot", ...(routine ? { routineIncarnation: "test-routine" } : {}) }; },
    snapshot: async () => snapshot, metadata: async (_provider, id) => models.getModel("fixture", id)!,
    defaultChoice: async () => ({ binding: bindBotProviderModel({ providerId: provider.id, modelId: provider.models[0]!.id, catalogRevision: snapshot.catalog.revision, snapshot }), thinkingLevel: "off" }),
  });
  return { service, select: async (id: "A" | "B") => {
    const result = await service.save({ botId, routineId, mutationId: randomUUID(), expectedRevision: (await service.read(botId, routineId)).revision, catalogRevision: snapshot.catalog.revision,
      selection: { mode: "selected", primary: { providerId: provider.id, modelId: provider.models.find(model => model.label === `Model ${id}`)!.id, thinkingLevel: "off" } } }, { signal: new AbortController().signal, assertCurrent() {} });
    if (!result.ok) throw new Error(result.error);
  } };
}

export function claimTestModule(file: string): string { return pathToFileURL(path.resolve(file)).href; }

/** Stop only after the child reports that its real ownership file was saved. */
export async function killAfterRoutineReceipt(t: TestContext, script: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, AIDEN_ANALYTICS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ownership receipt checkpoint timed out: ${stderr}`)), 10_000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("OWNERSHIP_SAVED")) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Receipt child exited: ${stderr}`)); });
  });
  child.kill("SIGKILL"); await exited;
}
