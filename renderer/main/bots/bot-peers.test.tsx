import "./test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BotPeerExchangeDialog, BotPeerManagerDialog, type BotPeerApi } from "./bot-peers";
import { pendingBotPeerChanges, recordBotPeerAttempt, settleBotPeerStop } from "./bot-peer-journal";
import { forgetBotPendingChanges, pendingChangeBotIds } from "../../lib/bot-local-pending";
import type { BotPeerExchangeDetail, BotPeerMutation, BotPeerSettings, BotPeerStopMutation } from "../../shared/bot-peers";

const sample = JSON.parse(readFileSync(new URL("../../../protocol/aiden-remote/v1/fixtures/bot-peers.json", import.meta.url), "utf8"));
const botId = sample.settings.botId as string, exchangeId = sample.detail.id as string;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); localStorage.clear(); });
function fixture() {
  let settings: BotPeerSettings = { ...structuredClone(sample.settings), revision: "peers_initial", pairs: [], lastMutationId: undefined };
  let exchange: BotPeerExchangeDetail = { ...structuredClone(sample.waiting), state: "running", lastStop: undefined };
  let effects = 0;
  const requests: BotPeerMutation[] = [], stops: BotPeerStopMutation[] = [], receipts = new Set<string>();
  const api: BotPeerApi = {
    settings: async () => structuredClone(settings), catalog: async () => structuredClone(sample.catalog), exchanges: async () => ({ ...sample.exchanges, exchanges: [exchange] }), exchange: async () => structuredClone(exchange), evidence: async () => structuredClone(sample.evidence),
    mutate: async (request) => {
      requests.push(structuredClone(request));
      if (receipts.has(request.mutationId)) return { ok: true, mutationId: request.mutationId, replayed: true, snapshot: structuredClone(settings) };
      if (request.expectedRevision !== settings.revision) return { ok: false, code: "conflict", error: "Settings changed on another device.", snapshot: structuredClone(settings) };
      effects++; receipts.add(request.mutationId);
      settings = { ...settings, revision: "peers_" + effects, lastMutationId: request.mutationId,
        ...(request.action === "describe" ? { routingDescription: request.routingDescription } : request.action === "approve" ? { pairs: structuredClone(sample.settings.pairs) } : { pairs: [] }) };
      return { ok: true, mutationId: request.mutationId, replayed: false, snapshot: structuredClone(settings) };
    },
    stop: async (request) => {
      stops.push(structuredClone(request));
      exchange = { ...exchange, state: "stopping", lastStop: { mutationId: request.mutationId, state: "requested", at: Date.now() } };
      return { ok: true, mutationId: request.mutationId, replayed: stops.length > 1, exchange: structuredClone(exchange) };
    },
  };
  return { api, requests, stops, get effects() { return effects; }, get settings() { return settings; }, get exchange() { return exchange; },
    phoneEdit: (routingDescription = settings.routingDescription) => { settings = { ...settings, routingDescription, revision: "phone_revision", lastMutationId: crypto.randomUUID() }; },
    setExchange: (value: BotPeerExchangeDetail) => { exchange = structuredClone(value); } };
}
function mount(api: BotPeerApi, kind: "settings" | "exchange" = "settings") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}>{kind === "settings" ? <BotPeerManagerDialog botId={botId} botName="Planner" onClose={() => {}} api={api} /> : <BotPeerExchangeDialog botId={botId} exchangeId={exchangeId} onClose={() => {}} api={api} />}</QueryClientProvider>) };
}
async function approvePair() {
  fireEvent.click(await screen.findByRole("combobox", { name: "Bot to approve" }));
  fireEvent.click(await screen.findByRole("option", { name: "Researcher" }));
  fireEvent.click(screen.getByRole("button", { name: "Review pair" }));
}

test("approving a pair reviews both names and recipient rules before any mutation", async () => {
  const f = fixture(); mount(f.api); await approvePair();
  assert.equal(f.requests.length, 0);
  assert.ok(screen.getByText("Planner ↔ Researcher"));
  assert.ok(screen.getByText(/Each recipient keeps its own access and rules/u));
  fireEvent.click(screen.getByRole("button", { name: "Approve both directions" }));
  await screen.findByText("Bot messaging settings saved.");
  assert.equal(f.effects, 1); assert.equal(f.settings.pairs[0].peer.name, "Researcher");
  assert.equal(pendingBotPeerChanges(botId).length, 0);
});
test("lost approval survives page visits and a later phone edit, then replays its exact body once", async () => {
  const f = fixture(), original = f.api.mutate;
  f.api.mutate = async (request) => { const result = await original(request); if (f.requests.length === 1) throw new Error("Lost accepted reply."); return result; };
  const first = mount(f.api); await approvePair(); fireEvent.click(screen.getByRole("button", { name: "Approve both directions" }));
  await screen.findByText("Lost accepted reply."); assert.equal(pendingBotPeerChanges(botId).length, 1);
  f.phoneEdit(); first.unmount(); first.client.clear(); mount(f.api);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved change" }));
  await waitFor(() => assert.equal(pendingBotPeerChanges(botId).length, 0));
  assert.deepEqual(f.requests[1], f.requests[0]); assert.equal(f.effects, 1); assert.equal(f.settings.revision, "phone_revision");
});
test("a stale description retains the draft until the person reviews the host revision", async () => {
  const f = fixture(); mount(f.api);
  const field = await screen.findByRole("textbox", { name: "When other Bots should ask me" });
  fireEvent.change(field, { target: { value: "Review research and coordinate updates." } }); f.phoneEdit();
  fireEvent.click(screen.getByRole("button", { name: "Save description" }));
  await screen.findByText("Changed on another device");
  assert.equal((screen.getByRole("button", { name: "Save description" }) as HTMLButtonElement).disabled, true);
  assert.equal((field as HTMLTextAreaElement).value, "Review research and coordinate updates.");
  fireEvent.click(screen.getByRole("button", { name: "Use latest revision for my description" }));
  fireEvent.click(screen.getByRole("button", { name: "Save description" }));
  await screen.findByText("Bot messaging settings saved.");
  assert.equal(f.requests[1].expectedRevision, "phone_revision"); assert.notEqual(f.requests[0].mutationId, f.requests[1].mutationId);
});
test("approving a pair preserves a separate unsaved description and updates the revision for its eventual save", async () => {
  const f = fixture(); mount(f.api);
  const field = await screen.findByRole("textbox", { name: "When other Bots should ask me" });
  fireEvent.change(field, { target: { value: "Keep this unsaved routing description." } });
  await approvePair(); fireEvent.click(screen.getByRole("button", { name: "Approve both directions" }));
  await screen.findByText("Bot messaging settings saved.");
  assert.equal((field as HTMLTextAreaElement).value, "Keep this unsaved routing description.");
  fireEvent.click(screen.getByRole("button", { name: "Save description" }));
  await waitFor(() => assert.equal(f.requests.length, 2));
  assert.equal(f.requests[1].action, "describe"); assert.equal(f.requests[1].expectedRevision, "peers_1");
  await waitFor(() => assert.equal(f.settings.routingDescription, "Keep this unsaved routing description."));
});
test("a pair decision cannot silently rebase a draft over a description changed on another device", async () => {
  const f = fixture(), mounted = mount(f.api);
  const field = await screen.findByRole("textbox", { name: "When other Bots should ask me" });
  fireEvent.change(field, { target: { value: "My local draft." } });
  f.phoneEdit("Description written on my phone.");
  await mounted.client.invalidateQueries({ queryKey: ["bot-peers", botId, "settings"] });
  await approvePair(); fireEvent.click(screen.getByRole("button", { name: "Approve both directions" }));
  await screen.findByText("Bot messaging settings saved.");
  await screen.findByText("Changed on another device");
  assert.equal((field as HTMLTextAreaElement).value, "My local draft.");
  assert.equal((screen.getByRole("button", { name: "Save description" }) as HTMLButtonElement).disabled, true);
  assert.equal(f.settings.routingDescription, "Description written on my phone.");
  fireEvent.click(screen.getByRole("button", { name: "Revoke pair with Researcher" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke pair" }));
  await waitFor(() => assert.equal(f.settings.pairs.length, 0));
  assert.ok(screen.getByText("Changed on another device"));
  assert.equal((screen.getByRole("button", { name: "Save description" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Use latest revision for my description" }));
  fireEvent.click(screen.getByRole("button", { name: "Save description" }));
  await waitFor(() => assert.equal(f.settings.routingDescription, "My local draft."));
  assert.equal(f.requests[2].expectedRevision, "peers_2");
});
test("leaving an exchange during its saved-Stop preflight cannot post a later request", async () => {
  const f = fixture(); recordBotPeerAttempt({ kind: "stop", request: sample.stop });
  const read = f.api.exchange; let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  f.api.exchange = async (...args) => { if (++reads === 2) { entered(); await hold; } return read(...args); };
  const mounted = mount(f.api, "exchange");
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Stop" })); await started;
  mounted.unmount(); release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.stops.length, 0); assert.equal(pendingBotPeerChanges(botId).length, 1);
});
test("an accepted pending Stop retains its identity across remount and a blocked acknowledgement settles honestly", async () => {
  const f = fixture(), first = mount(f.api, "exchange");
  fireEvent.click(await screen.findByRole("button", { name: "Stop exchange" })); fireEvent.click(screen.getByRole("button", { name: "Confirm Stop" }));
  await screen.findByRole("button", { name: "Retry saved Stop" });
  assert.equal(pendingBotPeerChanges(botId).length, 1); assert.equal(f.stops.length, 1);
  first.unmount(); first.client.clear(); mount(f.api, "exchange");
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Stop" }));
  await waitFor(() => assert.equal(f.stops.length, 2)); assert.deepEqual(f.stops[0], f.stops[1]);
  assert.equal(pendingBotPeerChanges(botId).length, 1);
  const blocked = { ...f.exchange, state: "running" as const, lastStop: { mutationId: f.stops[0].mutationId, state: "blocked" as const, reason: "mixed_inputs" as const, at: Date.now() } };
  f.setExchange(blocked);
  assert.equal(settleBotPeerStop(botId, blocked), true); assert.equal(pendingBotPeerChanges(botId).length, 0); assert.equal(blocked.state, "running");
});
test("another device's pending Stop offers passive refresh without minting a replacement request", async () => {
  const f = fixture(); f.setExchange(sample.waiting); mount(f.api, "exchange");
  await screen.findByText("Stop awaiting acknowledgement");
  assert.equal(screen.queryByRole("button", { name: "Stop exchange" }), null);
  assert.equal(screen.queryByRole("button", { name: "Retry saved Stop" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Refresh exchange" }));
  await waitFor(() => assert.equal(f.stops.length, 0)); assert.equal(pendingBotPeerChanges(botId).length, 0);
});
test("an old unknown Stop requires a freshly matching pending host receipt and never substitutes a new request", async () => {
  const f = fixture(), attempt = recordBotPeerAttempt({ kind: "stop", request: sample.stop });
  const name = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find((name) => name.includes(sample.stop.mutationId))!;
  localStorage.setItem(name, JSON.stringify({ ...attempt, createdAt: Date.now() - 25 * 60 * 60 * 1000 }));
  const first = mount(f.api, "exchange"); fireEvent.click(await screen.findByRole("button", { name: "Retry saved Stop" }));
  await screen.findByText(/too old to retry/u); assert.equal(f.stops.length, 0); assert.equal(pendingBotPeerChanges(botId)[0].request.mutationId, sample.stop.mutationId);
  first.unmount(); first.client.clear();
  f.setExchange({ ...f.exchange, lastStop: { mutationId: sample.stop.mutationId, state: "uncertain", at: Date.now() } }); mount(f.api, "exchange");
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Stop" }));
  await waitFor(() => assert.equal(f.stops.length, 1)); assert.deepEqual(f.stops[0], sample.stop);
  assert.equal(pendingBotPeerChanges(botId).length, 1);
});
test("confirmed Bot deletion removes all peer journals and fences late recreation", () => {
  recordBotPeerAttempt({ kind: "settings", request: sample.describe }); recordBotPeerAttempt({ kind: "stop", request: sample.stop });
  assert.ok(pendingChangeBotIds().includes(botId));
  assert.equal(forgetBotPendingChanges(botId), true); assert.deepEqual(pendingBotPeerChanges(botId), []);
  assert.throws(() => recordBotPeerAttempt({ kind: "settings", request: sample.describe }), /deleted/u);
  assert.throws(() => recordBotPeerAttempt({ kind: "stop", request: sample.stop }), /deleted/u);
});
