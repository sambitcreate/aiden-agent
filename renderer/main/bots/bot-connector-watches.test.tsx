import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BOT_CONNECTOR_WATCH_TEMPLATES, type BotConnectorWatchCreateInput, type BotConnectorWatchIdentityInput, type BotConnectorWatchList, type BotConnectorWatchTestInput, type BotConnectorWatchUpdateInput, type BotConnectorWatchView } from "../../shared/bot-connector-watches";
import { BotConnectorWatches, type BotConnectorWatchesApi } from "./bot-connector-watches";

afterEach(() => { cleanup(); localStorage.clear(); });
const bot = { id: "bot-a", name: "Scout" };
function saved(input: BotConnectorWatchCreateInput): BotConnectorWatchView {
  return { id: input.mutationId, botId: input.botId, name: input.name, prompt: input.prompt, condition: input.condition, everyMinutes: input.everyMinutes,
    revision: "r1", templateId: input.condition.kind === "calendar" ? "calendar_upcoming" : "mail_messages",
    source: { providerLabel: input.condition.kind === "calendar" ? "Google Calendar" : "Mail", accountLabel: "Work", resourceLabel: input.condition.kind === "calendar" ? "Team events" : "Inbox" }, enabled: true, state: "waiting" };
}
function harness() {
  const data: BotConnectorWatchList = { supported: true, templates: [...BOT_CONNECTOR_WATCH_TEMPLATES], watches: [] };
  let discoveries = 0;
  let checks = 0;
  let runs = 0;
  const runReceipts = new Map<string, { id: string; revision: string; admitted: boolean }>();
  const listeners = new Set<(id: string) => void>();
  const api: BotConnectorWatchesApi = {
    list: async () => structuredClone(data),
    discoverSources: async () => { discoveries++; return { choices: [{ id: "opaque-inbox", templateId: "mail_messages", providerLabel: "Mail", accountLabel: "Work", resourceLabel: "Inbox", available: true }], unavailableReasons: [] }; },
    create: async (input) => { const existing = data.watches.find((row) => row.id === input.mutationId); if (existing) return existing; const row = saved(input); data.watches.push(row); return row; },
    update: async (input) => {
      const row = data.watches.find((item) => item.id === input.id)!;
      if (input.expectedRevision !== row.revision) return { ok: false, code: "revision_conflict", message: "Review the newer saved version.", current: { ...row } };
      Object.assign(row, input, { revision: "r3" }); return row;
    },
    setEnabled: async (input) => { const row = data.watches.find((item) => item.id === input.id)!; row.enabled = input.enabled; row.revision = "r2"; return row; },
    remove: async (input) => { data.watches = data.watches.filter((row) => row.id !== input.id); return { id: input.id, revision: "removed", removed: true }; },
    runNow: async (input) => {
      const receipt = runReceipts.get(input.mutationId);
      if (receipt) return receipt;
      runs++; const result = { id: input.id, revision: input.expectedRevision, admitted: true };
      runReceipts.set(input.mutationId, result); return result;
    },
    testCheck: async () => { checks++; return { checkedAt: 1, result: "baseline", itemCount: 2, changeCount: 0, preview: ["Meeting notes", "New receipt"] }; },
    onChanged: (listener) => { listeners.add(listener); return () => void listeners.delete(listener); },
  };
  return { api, data, get discoveries() { return discoveries; }, get checks() { return checks; }, get runs() { return runs; }, changed: () => listeners.forEach((fn) => fn(bot.id)) };
}
async function newDraft() {
  fireEvent.click(await screen.findByRole("button", { name: "Add watch" }));
  fireEvent.change(screen.getByLabelText("Watch name"), { target: { value: "Work receipts" } });
  fireEvent.change(screen.getByLabelText("What the Bot should do"), { target: { value: "File the new receipts." } });
  fireEvent.click(screen.getByRole("button", { name: "Find sources" }));
  const source = await screen.findByRole("combobox", { name: "Connected source" });
  fireEvent.click(source);
  fireEvent.click(await screen.findByRole("option", { name: "Mail · Work · Inbox" }));
}

test("profile reads stay offline until explicit discovery; preview does not save or start the Bot", async () => {
  const h = harness();
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  await screen.findByText("No connected-app watches");
  assert.equal(h.discoveries, 0);
  await newDraft();
  assert.equal(h.discoveries, 1);
  assert.ok(screen.getByText(/Calendar watches are not available yet/u));
  assert.ok(screen.getByText(/The first successful Mail check records a baseline without waking the Bot/u));
  assert.equal(screen.queryByText(/The first Calendar check can report events/u), null);
  fireEvent.click(screen.getByRole("button", { name: "Test check" }));
  await screen.findByText("Meeting notes");
  assert.equal(h.checks, 1);
  assert.equal(h.data.watches.length, 0);
  assert.equal(h.runs, 0);
  fireEvent.change(screen.getByLabelText("Sender filter"), { target: { value: "billing@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
  await screen.findByRole("button", { name: "Edit watch Work receipts" });
  assert.equal(h.data.watches.length, 1);
  assert.deepEqual(h.data.watches[0].condition, { kind: "email", unreadOnly: false, sender: "billing@example.com" });
  assert.equal(h.data.watches[0].prompt, "File the new receipts.");
});

test("an eligible Calendar source supports preview, durable replay and saved-watch management", async () => {
  const h = harness();
  // Synthetic host eligibility exercises the shared UI; it does not enable a
  // connector or establish live account/Calendar acceptance.
  h.data.templates = h.data.templates.map((item) => item.kind === "calendar" ? { ...item, available: true, unavailableReason: undefined } : item);
  let discoveries = 0;
  const checks: BotConnectorWatchTestInput[] = [];
  const creates: BotConnectorWatchCreateInput[] = [];
  const updates: BotConnectorWatchUpdateInput[] = [];
  const runs: BotConnectorWatchIdentityInput[] = [];
  h.api.discoverSources = async () => {
    discoveries++;
    return { choices: [
      { id: "opaque-mail", templateId: "mail_messages", providerLabel: "Mail", accountLabel: "Personal", resourceLabel: "Inbox", available: true },
      { id: "opaque-team-calendar", templateId: "calendar_upcoming", providerLabel: "Google Calendar", accountLabel: "Work", resourceLabel: "Team events", available: true },
    ], unavailableReasons: [] };
  };
  h.api.testCheck = async (input) => { checks.push(structuredClone(input)); return { checkedAt: 1, result: "changed", itemCount: 1, changeCount: 1, preview: ["Team planning · 10:00"] }; };
  const create = h.api.create;
  h.api.create = async (input) => {
    creates.push(structuredClone(input));
    const result = await create(input);
    if (creates.length === 1) throw new Error("Calendar save response lost.");
    return result;
  };
  const update = h.api.update;
  h.api.update = async (input) => { updates.push(structuredClone(input)); return update(input); };
  const run = h.api.runNow;
  h.api.runNow = async (input) => { runs.push(structuredClone(input)); return run(input); };
  const first = render(<BotConnectorWatches bot={bot} api={h.api} />);
  await screen.findByText("No connected-app watches");
  assert.equal(discoveries, 0);
  fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
  fireEvent.change(screen.getByLabelText("Watch name"), { target: { value: "Team agenda" } });
  fireEvent.change(screen.getByLabelText("What the Bot should do"), { target: { value: "Prepare the agenda for upcoming team events." } });
  fireEvent.click(screen.getByRole("combobox", { name: "What to watch" }));
  fireEvent.click(await screen.findByRole("option", { name: "Upcoming calendar events" }));
  assert.equal(screen.queryByLabelText("Sender filter"), null);
  assert.ok(screen.getByText(/The first Calendar check can report events already in the upcoming window/u));
  assert.equal(screen.queryByText(/The first successful Mail check records a baseline/u), null);
  const lookAheadInput = screen.getByRole("spinbutton", { name: "Look ahead (minutes)" });
  const timezoneInput = screen.getByRole("textbox", { name: "Time zone" });
  assert.equal((screen.getByText("Look ahead (minutes)") as HTMLLabelElement).control, lookAheadInput);
  assert.equal((screen.getByText("Time zone") as HTMLLabelElement).control, timezoneInput);
  fireEvent.change(lookAheadInput, { target: { value: "120" } });
  fireEvent.change(timezoneInput, { target: { value: "America/New_York" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Check every" }));
  fireEvent.click(await screen.findByRole("option", { name: "15 minutes" }));
  assert.equal((screen.getByRole("button", { name: "Add watch" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Find sources" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Connected source" }));
  assert.equal(screen.queryByRole("option", { name: "Mail · Personal · Inbox" }), null);
  fireEvent.click(await screen.findByRole("option", { name: "Google Calendar · Work · Team events" }));
  fireEvent.click(screen.getByRole("button", { name: "Test check" }));
  await screen.findByText("Team planning · 10:00");
  assert.deepEqual(checks, [{ botId: bot.id, sourceChoiceId: "opaque-team-calendar", condition: { kind: "calendar", lookAheadMinutes: 120, timezone: "America/New_York" } }]);
  assert.equal(h.data.watches.length, 0);
  assert.equal(h.runs, 0);
  fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
  await screen.findByText("Calendar save response lost.");
  assert.equal(h.data.watches.length, 1);
  first.unmount();
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  assert.equal((screen.getByLabelText("Look ahead (minutes)") as HTMLInputElement).value, "120");
  assert.equal((screen.getByLabelText("Time zone") as HTMLInputElement).value, "America/New_York");
  assert.equal((screen.getByRole("button", { name: "Add watch" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByRole("button", { name: "Edit watch Team agenda" });
  await waitFor(() => assert.equal(screen.queryByText("Change waiting for confirmation"), null));
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1], creates[0]);
  assert.equal(creates[0].sourceChoiceId, "opaque-team-calendar");
  assert.equal(h.data.watches.length, 1);
  assert.equal(h.data.watches[0].templateId, "calendar_upcoming");
  assert.equal(h.data.watches[0].everyMinutes, 15);
  assert.equal(discoveries, 1, "reopening a pending Calendar draft must not rediscover accounts");
  fireEvent.click(screen.getByRole("button", { name: "Edit watch Team agenda" }));
  fireEvent.click(screen.getByRole("button", { name: "Test saved watch" }));
  await waitFor(() => assert.equal(checks.length, 2));
  assert.deepEqual(checks[1], { botId: bot.id, id: h.data.watches[0].id, expectedRevision: "r1" });
  fireEvent.change(screen.getByLabelText("Look ahead (minutes)"), { target: { value: "180" } });
  fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/London" } });
  fireEvent.click(screen.getByRole("button", { name: "Save watch" }));
  await waitFor(() => assert.equal(updates.length, 1));
  assert.equal(updates[0].expectedRevision, "r1");
  assert.equal(updates[0].sourceChoiceId, undefined, "editing the window retains the host's bound source");
  assert.deepEqual(h.data.watches[0].condition, { kind: "calendar", lookAheadMinutes: 180, timezone: "Europe/London" });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Save watch" }), null));
  fireEvent.click(screen.getByRole("switch", { name: "Team agenda on" }));
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Team agenda on" }).getAttribute("aria-checked"), "false"));
  fireEvent.click(screen.getByRole("switch", { name: "Team agenda on" }));
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Team agenda on" }).getAttribute("aria-checked"), "true"));
  fireEvent.click(screen.getByRole("button", { name: "Run Team agenda now" }));
  await screen.findByText(/Run request confirmed/u);
  assert.equal(h.runs, 1);
  assert.equal(runs[0].expectedRevision, h.data.watches[0].revision);
  fireEvent.click(screen.getByRole("button", { name: "Remove watch Team agenda" }));
  assert.equal(h.data.watches.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Remove watch" }));
  await screen.findByText("No connected-app watches");
  assert.equal(h.data.watches.length, 0);
  assert.equal(localStorage.length, 0);
});

test("a lost create response freezes the request across remount and replay leaves one watch", async () => {
  const h = harness();
  const create = h.api.create;
  let dropped = false;
  const ids: string[] = [];
  h.api.create = async (input) => {
    ids.push(input.mutationId);
    const result = await create(input);
    if (!dropped) { dropped = true; throw new Error("Connection lost."); }
    return result;
  };
  const first = render(<BotConnectorWatches bot={bot} api={h.api} />);
  await newDraft();
  fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
  await screen.findByText("Connection lost.");
  assert.equal(h.data.watches.length, 1, "the host committed before the connection failed");
  assert.equal((screen.getByLabelText("Watch name") as HTMLInputElement).disabled, true);
  first.unmount();
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  assert.equal((screen.getByLabelText("Watch name") as HTMLInputElement).value, "Work receipts");
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.ok(!screen.queryByText("Change waiting for confirmation")));
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(h.data.watches.length, 1);
  assert.equal(localStorage.length, 0);
});

test("a revision conflict preserves edits and requires review before replacing the newer version", async () => {
  const h = harness();
  h.data.watches.push(saved({ botId: bot.id, name: "Receipts", prompt: "File receipts", mutationId: crypto.randomUUID(), condition: { kind: "email", unreadOnly: false }, everyMinutes: 30, sourceChoiceId: "opaque-inbox" }));
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit watch Receipts" }));
  fireEvent.change(screen.getByLabelText("What the Bot should do"), { target: { value: "Only file paid receipts" } });
  h.data.watches[0].revision = "r2";
  h.data.watches[0].prompt = "Newer setting from phone";
  fireEvent.click(screen.getByRole("button", { name: "Save watch" }));
  await screen.findByText("Watch changed elsewhere");
  assert.equal((screen.getByLabelText("What the Bot should do") as HTMLTextAreaElement).value, "Only file paid receipts");
  assert.equal((screen.getByRole("button", { name: "Save watch" }) as HTMLButtonElement).disabled, true);
  assert.equal(h.data.watches[0].prompt, "Newer setting from phone");
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits against this version" }));
  fireEvent.click(screen.getByRole("button", { name: "Save watch" }));
  await waitFor(() => assert.equal(h.data.watches[0].prompt, "Only file paid receipts"));
});

test("pause, run and confirmed deletion act on the current watch and refresh its row", async () => {
  const h = harness();
  h.data.watches.push(saved({ botId: bot.id, name: "Receipts", prompt: "File receipts", mutationId: crypto.randomUUID(), condition: { kind: "email", unreadOnly: false }, everyMinutes: 30, sourceChoiceId: "opaque-inbox" }));
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Receipts on" }));
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Receipts on" }).getAttribute("aria-checked"), "false"));
  fireEvent.click(screen.getByRole("button", { name: "Run Receipts now" }));
  await screen.findByText(/Run request confirmed/u);
  assert.equal(h.runs, 1);
  fireEvent.click(screen.getByRole("button", { name: "Remove watch Receipts" }));
  assert.equal(h.data.watches.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Remove watch" }));
  await screen.findByText("No connected-app watches");
  assert.equal(h.data.watches.length, 0);
});

test("older or unsupported hosts provide guidance without exposing creation controls", async () => {
  const h = harness();
  h.data.supported = false; h.data.unavailableReason = "Update the owning computer.";
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  await screen.findByText("Update the owning computer.");
  assert.equal(screen.queryByRole("button", { name: "Add watch" }), null);
  assert.equal(h.discoveries, 0);
});

test("a rejected retry cannot discard an earlier unknown Run or allow a fresh identity", async () => {
  const h = harness();
  h.data.watches.push(saved({ botId: bot.id, name: "Receipts", prompt: "File receipts", mutationId: crypto.randomUUID(), condition: { kind: "email", unreadOnly: false }, everyMinutes: 30, sourceChoiceId: "opaque-inbox" }));
  const run = h.api.runNow;
  const identities: string[] = [];
  h.api.runNow = async (input) => {
    identities.push(input.mutationId);
    if (identities.length === 1) { await run(input); throw new Error("Response lost."); }
    if (identities.length === 2) return { ok: false, code: "capability_denied", message: "Schedules access removed." };
    return run(input);
  };
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Run Receipts now" }));
  await screen.findByText("Response lost.");
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText(/The earlier outcome is still unconfirmed/u);
  assert.equal((screen.getByRole("button", { name: "Run Receipts now" }) as HTMLButtonElement).disabled, true);
  assert.equal(h.runs, 1);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText(/Run request confirmed/u);
  assert.ok(!screen.queryByText("Change waiting for confirmation"));
  assert.equal(h.runs, 1, "the original receipt settles without running again");
  assert.equal(new Set(identities).size, 1);
});

test("a valid escaped prompt retains its uncertain create across remount and performs a same-key replay", async () => {
  const h = harness();
  const create = h.api.create;
  const ids: string[] = [];
  h.api.create = async (input) => {
    ids.push(input.mutationId);
    const result = await create(input);
    if (ids.length === 1) throw new Error("Response lost.");
    return result;
  };
  const prompt = `A${"\n".repeat(26_000)}B`;
  const first = render(<BotConnectorWatches bot={bot} api={h.api} />);
  await newDraft();
  fireEvent.change(screen.getByLabelText("What the Bot should do"), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
  await screen.findByText("Response lost.");
  assert.ok(localStorage.getItem(`aiden:pending-connector-watch:${bot.id}`)!.length > 50_000);
  first.unmount();
  render(<BotConnectorWatches bot={bot} api={h.api} />);
  assert.equal((screen.getByLabelText("What the Bot should do") as HTMLTextAreaElement).value, prompt);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.ok(!screen.queryByText("Change waiting for confirmation")));
  assert.equal(ids.length, 2, "recreation must actually dispatch the saved retry");
  assert.equal(ids[0], ids[1]);
  assert.equal(h.data.watches.length, 1);
  assert.equal(localStorage.length, 0);
});
