import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotOpenWorkItem, BotOpenWorkMutation, BotOpenWorkResult, BotOpenWorkSnapshot } from "../../shared/bot-open-work";
import { BotOpenWorkContent } from "./bot-open-work-page";
import type { BotOpenWorkApi } from "./use-bot-open-work";
import { pendingOpenWork } from "./open-work-journal";

const bot = { id: "bot-work", name: "Scout" };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); localStorage.clear(); });

function item(id = "work-1"): BotOpenWorkItem {
  return { id, revision: "item-1", title: "Review invoice", note: "Reconcile the total.", state: "open", createdAt: 10, updatedAt: 10,
    source: { kind: "person" }, links: [], execution: { state: "idle", canStop: false } };
}
function harness(initial: BotOpenWorkItem[] = []) {
  const data: BotOpenWorkSnapshot = { botId: bot.id, revision: "snapshot-1", items: initial, undo: [] };
  const receipts = new Map<string, { mutation: BotOpenWorkMutation; result: Extract<BotOpenWorkResult, { ok: true }>; before?: BotOpenWorkItem }>();
  const ids: string[] = []; let version = 1; let stopAcknowledged = false;
  const advance = (row?: BotOpenWorkItem) => {
    data.revision = "snapshot-" + ++version;
    if (row) { row.revision = "item-" + version; row.updatedAt = 10 + version; }
  };
  const api: BotOpenWorkApi = {
    snapshot: async () => structuredClone(data),
    onChanged: () => () => {},
    evidence: async (_botId, id, kind) => ({ itemId: id, kind, submissionId: "1", entryId: kind === "source" ? "2" : "3",
      title: kind === "source" ? "Original invoice request" : "Supporting reply", text: kind === "source" ? "Compare <invoice> totals with the order." : "The totals differ by 20.", truncated: false }),
    mutate: async (_botId, mutation) => {
      ids.push(mutation.mutationId);
      const prior = receipts.get(mutation.mutationId);
      if (prior) {
        if (prior.result.stop?.state === "uncertain" && stopAcknowledged) {
          const row = data.items.find((entry) => entry.id === prior.result.itemId)!;
          row.execution = { state: "idle", canStop: false };
          row.lastStop = { ...prior.result.stop, state: "stopped", finishedAt: 100 };
          if (prior.mutation.action === "stop_and_dismiss") { row.state = "dismissed"; delete row.waitingReason; }
          advance(row); prior.result.stop = row.lastStop;
        }
        return structuredClone({ ...prior.result, replayed: true, snapshot: data });
      }
      const row = "id" in mutation ? data.items.find((entry) => entry.id === mutation.id) : undefined;
      const expected = mutation.action === "add" ? data.revision : row?.revision;
      if (mutation.action !== "undo" && expected !== mutation.expectedRevision) return { ok: false, code: "stale", error: "This work changed on another device.", snapshot: structuredClone(data) };
      let target = row; let before: BotOpenWorkItem | undefined;
      if (mutation.action === "add") {
        target = { ...item("work-" + (data.items.length + 1)), title: mutation.title, note: mutation.note ?? "" }; data.items.push(target);
      } else if (mutation.action === "undo") {
        const original = receipts.get(mutation.undoOf);
        target = data.items.find((entry) => entry.id === original?.result.itemId);
        if (!target || target.revision !== mutation.expectedRevision) return { ok: false, code: "undo_conflict", error: "A later change cannot be undone.", snapshot: structuredClone(data) };
        const execution = target.execution;
        if (original?.before) Object.assign(target, structuredClone(original.before), { execution });
        else target.state = "dismissed";
      } else if (target) {
        before = structuredClone(target);
        if (mutation.action === "edit") {
          Object.assign(target, mutation.patch);
          if (target.state !== "waiting") delete target.waitingReason;
          if (target.state === "done") target.completion = { by: "person", at: 100 }; else delete target.completion;
        } else if (mutation.action === "dismiss") { target.state = "dismissed"; delete target.waitingReason; delete target.completion; }
        else {
          target.lastStop = { mutationId: mutation.mutationId, state: "uncertain", requestedAt: 100 };
          target.execution = { state: "stopping", canStop: false };
        }
      }
      assert.ok(target);
      advance(target);
      data.undo = data.undo.filter((entry) => entry.itemId !== target!.id);
      const reversible = ["add", "edit", "dismiss"].includes(mutation.action);
      const undo = reversible ? { mutationId: mutation.mutationId, itemId: target.id, expectedRevision: target.revision, expiresAt: Date.now() + 86_400_000 } : undefined;
      if (undo) data.undo.push(undo);
      const result: Extract<BotOpenWorkResult, { ok: true }> = { ok: true, mutationId: mutation.mutationId, replayed: false, itemId: target.id, snapshot: structuredClone(data),
        ...(undo ? { undo } : {}), ...(target.lastStop ? { stop: target.lastStop } : {}) };
      receipts.set(mutation.mutationId, { mutation, result, ...(before ? { before } : {}) });
      return structuredClone(result);
    },
  };
  return { api, data, ids, acknowledgeStop: () => { stopAcknowledged = true; },
    phoneEdit: () => { const row = data.items[0]!; row.note = "A newer note from the phone."; advance(row); data.undo = []; } };
}
function mount(api: BotOpenWorkApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return { ...render(<QueryClientProvider client={client}><BotOpenWorkContent bot={bot} api={api} /></QueryClientProvider>), client };
}
async function addDraft(title = "Review invoice") {
  fireEvent.click(await screen.findByRole("button", { name: "Add work" }));
  fireEvent.change(screen.getByLabelText("Work title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Work notes"), { target: { value: "Compare the totals." } });
}

test("work can be added, waiting with a reason, marked done, undone and dismissed through accessible controls", async () => {
  const h = harness(); mount(h.api); await addDraft();
  fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit work Review invoice" }));
  fireEvent.click(screen.getByRole("combobox", { name: "State" }));
  fireEvent.click(await screen.findByRole("option", { name: "Waiting" }));
  assert.equal((screen.getByRole("button", { name: "Save work" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(screen.getByLabelText("Waiting reason"), { target: { value: "Waiting for the receipt" } });
  fireEvent.click(screen.getByRole("button", { name: "Save work" }));
  await screen.findByText("Waiting · Waiting for the receipt");
  fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
  fireEvent.click(await screen.findByRole("button", { name: "History (1)" }));
  await screen.findByText("Marked done by you");
  fireEvent.click(screen.getByRole("button", { name: "Undo last change to Review invoice" }));
  await screen.findByText("Waiting · Waiting for the receipt");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await screen.findByText("No open work");
  assert.equal(h.data.items[0].state, "dismissed");
});

test("durable Undo remains available after remount and Undo Add retains the item as dismissed", async () => {
  const h = harness(); const first = mount(h.api); await addDraft();
  fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByRole("button", { name: "Undo last change to Review invoice" });
  const identity = h.data.items[0].id; first.unmount(); first.client.clear();
  mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "Undo last change to Review invoice" }));
  await screen.findByText("No open work");
  assert.equal(h.data.items[0].id, identity);
  assert.equal(h.data.items[0].state, "dismissed");
});

test("a lost Add response survives remount and replays one identity while preserving a later phone edit", async () => {
  const h = harness(); const mutate = h.api.mutate;
  h.api.mutate = async (...args) => { const result = await mutate(...args); if (h.ids.length === 1) { h.phoneEdit(); throw new Error("Reply lost."); } return result; };
  const first = mount(h.api); await addDraft();
  fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByText("Reply lost.");
  assert.equal(pendingOpenWork(bot.id).length, 1);
  first.unmount(); first.client.clear(); mount(h.api);
  const title = await screen.findByLabelText("Work title") as HTMLInputElement;
  assert.equal(title.value, "Review invoice"); assert.equal(title.disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.ok(!screen.queryByText("Change waiting for confirmation")));
  assert.equal(h.ids.length, 2); assert.equal(h.ids[0], h.ids[1]);
  assert.equal(h.data.items.length, 1); assert.equal(h.data.items[0].note, "A newer note from the phone.");
});

test("unavailable and a later definitive refusal cannot discard an earlier uncertain mutation", async () => {
  const h = harness(); const mutate = h.api.mutate; let attempt = 0;
  h.api.mutate = async (...args) => {
    if (++attempt === 1) { await mutate(...args); h.phoneEdit(); return { ok: false, code: "unavailable", error: "Publication outcome is unknown." }; }
    if (attempt === 2) return { ok: false, code: "stale", error: "Review current work.", snapshot: structuredClone(h.data) };
    return mutate(...args);
  };
  mount(h.api); await addDraft(); fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByText(/Publication outcome is unknown/u);
  const identity = pendingOpenWork(bot.id)[0].mutation.mutationId;
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText(/Review current work.*earlier outcome is still unconfirmed/u);
  assert.equal(pendingOpenWork(bot.id)[0].mutation.mutationId, identity);
  assert.equal((screen.getByLabelText("Work title") as HTMLInputElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.equal(pendingOpenWork(bot.id).length, 0));
  assert.equal(h.data.items.length, 1); assert.equal(h.ids[0], h.ids[1]);
});

test("a revision conflict preserves the draft and requires explicit review before saving against the newer version", async () => {
  const h = harness([item()]); mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "Edit work Review invoice" }));
  fireEvent.change(screen.getByLabelText("Work notes"), { target: { value: "My unsaved note" } }); h.phoneEdit();
  fireEvent.click(screen.getByRole("button", { name: "Save work" }));
  await screen.findByText("Work changed elsewhere");
  assert.equal((screen.getByLabelText("Work notes") as HTMLTextAreaElement).value, "My unsaved note");
  assert.equal((screen.getByRole("button", { name: "Save work" }) as HTMLButtonElement).disabled, true);
  assert.equal(h.data.items[0].note, "A newer note from the phone.");
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits against this version" }));
  fireEvent.click(screen.getByRole("button", { name: "Save work" }));
  await waitFor(() => assert.equal(h.data.items[0].note, "My unsaved note"));
});

test("Stop and dismiss waits for host acknowledgement and retries the same Stop without marking work done", async () => {
  const linked = item(); linked.state = "waiting"; linked.waitingReason = "The run is unfinished"; linked.execution = { state: "running", canStop: true };
  const other = item("work-2"); other.title = "Unrelated work";
  const h = harness([linked, other]); mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "Stop and dismiss" }));
  await screen.findByText(/Stop is awaiting acknowledgement. Check the same request/u);
  assert.equal(h.data.items[0].state, "waiting"); assert.equal(h.data.items[0].completion, undefined);
  assert.equal(pendingOpenWork(bot.id).length, 1);
  h.acknowledgeStop();
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.equal(pendingOpenWork(bot.id).length, 0));
  assert.equal(h.ids[0], h.ids[1]); assert.equal(h.data.items[0].state, "dismissed");
  assert.equal(h.data.items[1].state, "open"); assert.equal(h.data.items[1].title, "Unrelated work");
});

test("a Stop pending on another device prevents new item mutations until acknowledged", async () => {
  const linked = item(); linked.execution = { state: "stopping", canStop: false };
  linked.lastStop = { mutationId: crypto.randomUUID(), state: "uncertain", requestedAt: 100 };
  const h = harness([linked]);
  h.data.undo.push({ itemId: linked.id, mutationId: crypto.randomUUID(), expectedRevision: linked.revision, expiresAt: Date.now() + 86_400_000 });
  const mounted = mount(h.api);
  for (const name of ["Edit work Review invoice", "Mark done", "Dismiss without stopping", "Undo last change to Review invoice"]) {
    const button = await screen.findByRole("button", { name });
    assert.ok((button as HTMLButtonElement).disabled); fireEvent.click(button);
  }
  assert.equal(h.ids.length, 0); assert.equal(pendingOpenWork(bot.id).length, 0);
  linked.execution = { state: "idle", canStop: false }; linked.lastStop = { ...linked.lastStop, state: "stopped", finishedAt: 101 };
  await act(async () => { await mounted.client.invalidateQueries(); });
  await waitFor(() => assert.ok(!(screen.getByRole("button", { name: "Mark done" }) as HTMLButtonElement).disabled));
});

test("an editor opened before another device's Stop cannot publish while acknowledgement is pending", async () => {
  const h = harness([item()]); const mounted = mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "Edit work Review invoice" }));
  fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Keep my draft" } });
  h.data.items[0].lastStop = { mutationId: crypto.randomUUID(), state: "requested", requestedAt: 100 };
  h.data.items[0].execution = { state: "stopping", canStop: false };
  await act(async () => { await mounted.client.invalidateQueries(); });
  await waitFor(() => assert.ok((screen.getByRole("button", { name: "Save work" }) as HTMLButtonElement).disabled));
  fireEvent.click(screen.getByRole("button", { name: "Save work" }));
  assert.equal(h.ids.length, 0); assert.equal(pendingOpenWork(bot.id).length, 0);
  assert.equal((screen.getByLabelText("Work title") as HTMLInputElement).value, "Keep my draft");
  assert.ok(!(screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled);
});

test("an accepted Stop response without its acknowledgement retains the exact saved request", async () => {
  const linked = item(); linked.execution = { state: "running", canStop: true };
  const h = harness([linked]); const mutate = h.api.mutate;
  h.api.mutate = async (...args) => { const result = await mutate(...args); if (h.ids.length === 1 && result.ok) delete result.stop; return result; };
  mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "Stop and dismiss" }));
  await screen.findByText(/Stop is awaiting acknowledgement. Check the same request/u);
  assert.equal(pendingOpenWork(bot.id).length, 1); assert.equal(h.data.items[0].state, "open");
  h.acknowledgeStop(); fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.equal(pendingOpenWork(bot.id).length, 0));
  assert.equal(h.ids[0], h.ids[1]); assert.equal(h.data.items[0].state, "dismissed");
});

test("source and result controls open actual text as data without interpreting markup", async () => {
  const linked = item(); linked.source = { kind: "person", submissionId: "1", entryId: "2" };
  linked.links = [{ kind: "source", submissionId: "1", entryId: "2" }, { kind: "result", submissionId: "1", entryId: "3" }];
  const h = harness([linked]); mount(h.api);
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  const dialog = await screen.findByRole("dialog", { name: "Original invoice request" });
  assert.ok(dialog.textContent?.includes("Compare <invoice> totals with the order."));
  assert.ok(!dialog.querySelector("invoice"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "View reply" }));
  await screen.findByText("The totals differ by 20.");
});

test("a device storage failure prevents transmission and keeps the editable draft", async () => {
  const h = harness(); mount(h.api); await addDraft();
  const storage = localStorage;
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return storage.length; }, key: storage.key.bind(storage), getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage), clear: storage.clear.bind(storage),
      setItem: () => { throw new Error("Device storage is full."); },
    } });
    fireEvent.click(screen.getByRole("button", { name: "Add work" }));
    await screen.findByText("Device storage is full.");
    assert.equal(h.ids.length, 0);
    assert.equal((screen.getByLabelText("Work title") as HTMLInputElement).value, "Review invoice");
  } finally { Object.defineProperty(globalThis, "localStorage", original); }
  fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByRole("button", { name: "Edit work Review invoice" });
  assert.equal(h.data.items.length, 1);
});

test("confirmation in one window cannot erase another window's uncertain change", async () => {
  const h = harness(); const mutate = h.api.mutate;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  h.api.mutate = async (...args) => { const result = await mutate(...args); if (h.ids.length === 1) await held; return result; };
  mount(h.api); await addDraft(); fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await waitFor(() => assert.equal(h.ids.length, 1));
  const firstKey = localStorage.key(0)!; const otherId = crypto.randomUUID();
  // A concurrent window has its own durable request; its response was lost.
  // A separate key preserves both requests despite a cross-window stale read.
  const otherKey = firstKey.slice(0, -36) + otherId;
  localStorage.setItem(otherKey, JSON.stringify({ version: 1, botId: bot.id, mutation: { action: "add", mutationId: otherId, expectedRevision: h.data.revision, title: "Other window", note: "" }, attempts: 1, createdAt: Date.now() + 1 }));
  fireEvent(window, new Event("storage"));
  await screen.findByText("Other window"); release();
  await waitFor(() => assert.equal(pendingOpenWork(bot.id).length, 1));
  assert.equal(pendingOpenWork(bot.id)[0].mutation.mutationId, otherId);
  assert.equal(h.data.items.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => assert.equal(pendingOpenWork(bot.id).length, 0));
  assert.deepEqual(h.data.items.map((entry) => entry.title), ["Review invoice", "Other window"]);
});

test("editing text respects both scalar and UTF-8 bounds without cutting an emoji", async () => {
  const h = harness(); mount(h.api); await addDraft();
  fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "😀".repeat(161) } });
  fireEvent.change(screen.getByLabelText("Work notes"), { target: { value: "界".repeat(1000) } });
  assert.equal((screen.getByLabelText("Work title") as HTMLInputElement).value, "😀".repeat(160));
  assert.equal((screen.getByLabelText("Work notes") as HTMLTextAreaElement).value, "界".repeat(682));
  fireEvent.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByText("Added here");
  assert.equal(h.data.items[0].title, "😀".repeat(160));
  assert.equal(h.data.items[0].note, "界".repeat(682));
});
