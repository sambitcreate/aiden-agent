import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "./test-dom";
import { BotRoutineModelDialog, type BotRoutineModelApi } from "./bot-routine-models";
import { pendingRoutineModelChanges, recordRoutineModelAttempt } from "./routine-model-journal";
import type { BotRoutineModelCatalog, BotRoutineModelResult, BotRoutineModelSave, BotRoutineModelSettings } from "../../shared/bot-routine-models";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); localStorage.clear(); });
const botId = "bot_model", routineId = "routine_model";
const catalog: BotRoutineModelCatalog = { revision: "catalog_1", providers: [{ id: "provider_1", label: "Local provider", available: true, models: [
  { id: "model_a", label: "Reasoner", available: true, supportsImages: true, thinkingLevels: ["low", "high"] },
  { id: "model_b", label: "Writer", available: true, supportsImages: false, thinkingLevels: ["off"] },
] }] };
function fixture() {
  let settings: BotRoutineModelSettings = { botId, routineId, revision: "revision_1", selection: { mode: "inherit" }, updatedAt: 1 };
  let version = 1;
  const receipts = new Map<string, string>(), requests: BotRoutineModelSave[] = [];
  const api: BotRoutineModelApi = {
    directory: async () => ({ botId, routines: [{ id: routineId, name: "Morning review", kind: "scheduled" }] }),
    resumeStatus: async () => ({ requiresUnknownCostAcknowledgement: false }),
    read: async () => structuredClone(settings), catalog: async () => catalog, readRuns: async () => [],
    save: async (request) => {
      requests.push(structuredClone(request));
      if (receipts.has(request.mutationId)) {
        assert.equal(receipts.get(request.mutationId), JSON.stringify(request));
        return { ok: true, settings: structuredClone(settings), mutationId: request.mutationId, replayed: true };
      }
      if (request.expectedRevision !== settings.revision) return { ok: false, code: "conflict", error: "This routine changed on another device.", settings: structuredClone(settings) };
      settings = { ...settings, revision: "revision_" + ++version, selection: structuredClone(request.selection), updatedAt: version, lastMutationId: request.mutationId };
      receipts.set(request.mutationId, JSON.stringify(request));
      return { ok: true, settings: structuredClone(settings), mutationId: request.mutationId, replayed: false };
    },
  };
  return { api, requests, get settings() { return settings; }, phoneEdit: () => { settings = { ...settings, revision: "revision_" + ++version, lastMutationId: crypto.randomUUID() }; } };
}
function mount(api: BotRoutineModelApi) {
  installBotTestIpc({ "providers:list": () => [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return { ...render(<QueryClientProvider client={client}><BotRoutineModelDialog botId={botId} routineId={routineId} routineName="Morning review" onClose={() => {}} api={api} /></QueryClientProvider>), client };
}
async function primary() {
  fireEvent.click(await screen.findByRole("combobox", { name: "Model choice" }));
  fireEvent.click(await screen.findByRole("option", { name: "Choose a routine model" }));
  fireEvent.click(await screen.findByRole("button", { name: "Primary model" }));
  fireEvent.click(await screen.findByRole("option", { name: /Reasoner/u }));
}

test("routine model controls require an explicit model and optional fallback, and can clear back to inheritance", async () => {
  const f = fixture(); mount(f.api); await primary();
  fireEvent.click(screen.getByRole("combobox", { name: "Primary model thinking" }));
  assert.ok(!screen.queryByRole("option", { name: "Maximum" }));
  fireEvent.click(await screen.findByRole("option", { name: "High" }));
  fireEvent.click(screen.getByRole("switch", { name: "Allow a fallback I choose" }));
  assert.ok((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled);
  fireEvent.click(screen.getByRole("button", { name: "Fallback model" }));
  fireEvent.click(await screen.findByRole("option", { name: /Writer/u }));
  fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await screen.findByText("Routine model saved. Future runs use this choice.");
  assert.deepEqual(f.settings.selection, { mode: "selected", primary: { providerId: "provider_1", modelId: "model_a", thinkingLevel: "high" }, fallback: { providerId: "provider_1", modelId: "model_b", thinkingLevel: "off" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Model choice" }));
  fireEvent.click(await screen.findByRole("option", { name: "Inherit Bot model" }));
  fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await waitFor(() => assert.equal(f.settings.selection.mode, "inherit"));
  assert.equal(f.requests.length, 2);
});
test("a lost save restores its frozen choice and replays the same identity after a later phone edit", async () => {
  const f = fixture(), save = f.api.save;
  f.api.save = async (input) => { const result = await save(input); if (f.requests.length === 1) throw new Error("Connection lost after acceptance."); return result; };
  const first = mount(f.api); await primary(); fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await screen.findByText("Connection lost after acceptance.");
  assert.equal(pendingRoutineModelChanges(botId, routineId).length, 1);
  f.phoneEdit(); first.unmount(); first.client.clear(); mount(f.api);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved request" }));
  await waitFor(() => assert.equal(pendingRoutineModelChanges(botId, routineId).length, 0));
  assert.equal(f.requests[0].mutationId, f.requests[1].mutationId);
  assert.deepEqual(f.requests[0], f.requests[1]); assert.equal(f.settings.revision, "revision_3");
});
test("matching host receipt confirms an accepted lost save after remount without another mutation", async () => {
  const f = fixture(), save = f.api.save;
  f.api.save = async (input) => { await save(input); throw new Error("Lost reply."); };
  const first = mount(f.api); await primary(); fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await screen.findByText("Lost reply."); first.unmount(); first.client.clear(); mount(f.api);
  await screen.findByText("The computer confirmed the saved model change.");
  assert.equal(pendingRoutineModelChanges(botId, routineId).length, 0); assert.equal(f.requests.length, 1);
});
test("a stale first save retains the draft and requires reviewing the newer revision", async () => {
  const f = fixture(); mount(f.api); await primary(); f.phoneEdit();
  fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await screen.findByText("Changed on another device");
  assert.ok((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled);
  assert.equal(pendingRoutineModelChanges(botId, routineId).length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Use latest revision for my choices" }));
  fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await waitFor(() => assert.equal(f.settings.selection.mode, "selected"));
  assert.equal(f.requests[1].expectedRevision, "revision_2"); assert.notEqual(f.requests[0].mutationId, f.requests[1].mutationId);
});
test("unavailable then a later refusal retains the original request and blocks a new model save", async () => {
  const f = fixture(); let attempts = 0;
  f.api.save = async (request): Promise<BotRoutineModelResult> => { f.requests.push(request); return ++attempts === 1 ? { ok: false, code: "unavailable", error: "Publication is unconfirmed." } : { ok: false, code: "not_found", error: "Routine unavailable." }; };
  mount(f.api); await primary(); fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved request" }));
  await screen.findByText(/Routine unavailable/u);
  assert.equal(pendingRoutineModelChanges(botId, routineId).length, 1); assert.equal(f.requests[0].mutationId, f.requests[1].mutationId);
  assert.ok((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled);
});
test("an expired uncertain request is retained and never resent under a new identity", async () => {
  const f = fixture(); const originalNow = Date.now;
  try { Date.now = () => originalNow() - 24 * 60 * 60 * 1000;
    recordRoutineModelAttempt({ botId, routineId, mutationId: crypto.randomUUID(), expectedRevision: "revision_1", catalogRevision: "catalog_1", selection: { mode: "inherit" } });
  } finally { Date.now = originalNow; }
  mount(f.api); fireEvent.click(await screen.findByRole("button", { name: "Retry saved request" }));
  await screen.findByText(/too old to retry safely/u);
  assert.equal(f.requests.length, 0); assert.equal(pendingRoutineModelChanges(botId, routineId).length, 1);
});
test("failure to load settings offers recovery instead of an endless loading state", async () => {
  const f = fixture(); f.api.read = async () => { throw new Error("Host unavailable."); }; mount(f.api);
  await screen.findByText("Routine model unavailable"); assert.ok(!screen.queryByText("Loading routine model…"));
  assert.ok(screen.getByRole("button", { name: "Try again" }));
});

test("storage refusal preserves the model draft and prevents transmission until it can be retained", async () => {
  const f = fixture(); mount(f.api); await primary();
  const storage = localStorage, original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return storage.length; }, key: storage.key.bind(storage), getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage), clear: storage.clear.bind(storage),
      setItem: () => { throw new Error("Device storage is full."); },
    } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Device storage is full.");
    assert.equal(f.requests.length, 0);
    assert.ok(screen.getByRole("button", { name: "Primary model" }).textContent?.includes("Reasoner"));
  } finally { Object.defineProperty(globalThis, "localStorage", original); }
  fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await screen.findByText("Routine model saved. Future runs use this choice.");
  assert.equal(f.requests.length, 1);
});

test("confirming one window's change retains another window's saved request", async () => {
  const f = fixture(), save = f.api.save;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  f.api.save = async (request) => { const result = await save(request); await held; return result; };
  mount(f.api); await primary(); fireEvent.click(screen.getByRole("button", { name: "Save model" }));
  await waitFor(() => assert.equal(f.requests.length, 1));
  // Another window read the previous empty journal before the first write.
  const otherId = crypto.randomUUID(), firstKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find((name) => name.startsWith("aiden:routine-model:pending:"))!;
  localStorage.setItem(firstKey.slice(0, -36) + otherId, JSON.stringify({ version: 1, createdAt: Date.now() + 1, attempts: 1,
    request: { ...f.requests[0], mutationId: otherId, selection: { mode: "inherit" } } }));
  fireEvent(window, new Event("storage")); release();
  await waitFor(() => assert.equal(pendingRoutineModelChanges(botId, routineId).length, 1));
  assert.equal(pendingRoutineModelChanges(botId, routineId)[0].request.mutationId, otherId);
  assert.equal(f.requests.length, 1);
  assert.ok((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled);
  assert.ok(screen.getByRole("button", { name: "Retry saved request" }));
});

test("run details distinguish the chosen model, actual fallback and delayed scheduled occurrence", async () => {
  const f = fixture();
  f.api.readRuns = async () => [{ runId: "run_delayed", admittedAt: Date.UTC(2026, 10, 3, 14), startedAt: Date.UTC(2026, 10, 3, 14, 10), scheduledFor: Date.UTC(2026, 10, 3, 14), timezone: "America/New_York", triggerKind: "catch_up",
    model: { chosen: { providerId: "provider_1", modelId: "model_a", thinkingLevel: "high" }, actual: { providerId: "provider_1", modelId: "model_b", thinkingLevel: "off" },
      chosenProviderLabel: "Local provider", chosenModelLabel: "Reasoner", providerLabel: "Local provider", modelLabel: "Writer", fallbackReason: "credentials_unavailable" } }];
  mount(f.api);
  await screen.findByText("Used Writer");
  assert.ok(screen.getByText("Chosen Reasoner · Local provider · High thinking"));
  assert.ok(screen.getByText(/Scheduled .*America\/New_York.*10 min late/u));
  assert.ok(screen.getByText("Configured fallback used because the primary credentials were unavailable."));
});
