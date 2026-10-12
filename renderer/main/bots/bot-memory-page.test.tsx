import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "../../components/ui";
import type {
  BotMemoryEdit,
  BotMemoryEditInput,
  BotMemoryEditResult,
  BotMemoryEntry,
  BotMemoryView,
} from "../../shared/bot-memory";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

afterEach(cleanup);

function store(entries: BotMemoryEntry[], limitChars: number) {
  const usedChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  return { entries, usedChars, limitChars, overBudget: usedChars > limitChars };
}

function memoryView(
  user: BotMemoryEntry[],
  memory: BotMemoryEntry[],
  overrides: Partial<BotMemoryView> = {},
): BotMemoryView {
  return {
    botId: "bot-1",
    revision: `rev-${user.length}-${memory.length}-${user.map((entry) => entry.id).join(".")}`,
    readable: true,
    user: store(user, 1_375),
    memory: store(memory, 2_200),
    updatedAt: 1,
    ...overrides,
  };
}

const SHORT = { id: "u-short", text: "Prefers short answers." };
const KIDS = { id: "u-kids", text: "Has two kids, Mia (8) and Leo (5)." };
const MEALS = { id: "m-meals", text: "Weekly meal plan is vegetarian except Fridays." };

/**
 * A fake main-process memory service: edits apply to the stored view, unless
 * `refuse` answers a code first. Every edit is recorded.
 */
function memoryIpc(
  initial: BotMemoryView,
  options: { refuse?: (edit: BotMemoryEdit) => Extract<BotMemoryEditResult, { ok: false }>["code"] | null } = {},
) {
  let view = initial;
  const edits: BotMemoryEdit[] = [];
  const calls = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:get": () => botFixture(),
    "bots:routines:list": () => [],
    "bots:memory:get": () => view,
    "bots:memory:edit": (input) => {
      const { edit } = input as BotMemoryEditInput;
      edits.push(edit);
      const code = options.refuse?.(edit) ?? null;
      if (code) return { ok: false, code, message: "", view };
      if (edit.kind === "clear") {
        view = memoryView([], []);
      } else {
        const key = edit.target;
        const current = view[key].entries;
        if (!current.some((entry) => entry.id === edit.entryId)) {
          return { ok: false, code: "entry_not_found", message: "", view };
        }
        const next =
          edit.kind === "remove"
            ? current.filter((entry) => entry.id !== edit.entryId)
            : current.map((entry) => (entry.id === edit.entryId ? { id: `${entry.id}+`, text: edit.text } : entry));
        view =
          key === "user"
            ? memoryView(next, view.memory.entries)
            : memoryView(view.user.entries, next);
      }
      return { ok: true, view };
    },
  });
  return {
    calls,
    edits,
    set(next: BotMemoryView) {
      view = next;
    },
  };
}

async function mountMemory(path = "/bots/bot-1?page=memory") {
  return mountWithBotRouter(
    <>
      <BotsView />
      <Toaster />
    </>,
    { initialPath: path },
  );
}

async function chooseEntryAction(text: string, action: "Edit" | "Delete") {
  const row = (await screen.findByText(text)).closest("li")!;
  fireEvent.keyDown(within(row).getByRole("button", { name: "Memory options" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

const memoryGets = (calls: { channel: string }[]) => calls.filter((call) => call.channel === "bots:memory:get").length;

test("Profile shows how much the Bot remembers, and Memory lists both groups with their usage", async () => {
  memoryIpc(memoryView([SHORT, KIDS], [MEALS]));
  await mountMemory("/bots/bot-1");

  const row = await screen.findByRole("button", { name: "Memory" });
  await waitFor(() => assert.match(row.textContent ?? "", /3 things/u));
  fireEvent.click(row);

  assert.ok(await screen.findByRole("heading", { name: "Memory" }));
  assert.ok(
    screen.getByText("What Planner remembers about you and its work. It’s stored on this Mac, and Planner uses it in every chat."),
  );
  const aboutYou = screen.getByRole("list", { name: "About you" });
  assert.deepEqual(
    within(aboutYou).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent),
    [SHORT.text, KIDS.text],
  );
  const notes = screen.getByRole("list", { name: "Planner’s notes" });
  assert.deepEqual(within(notes).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent), [MEALS.text]);

  const meters = screen.getAllByRole("meter");
  assert.deepEqual(
    meters.map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuetext")]),
    [
      ["About you space used", "56 of 1,375 characters"],
      ["Planner’s notes space used", "46 of 2,200 characters"],
    ],
  );
});

test("an empty memory invites the person to share something and offers nothing to erase", async () => {
  memoryIpc(memoryView([], []));
  await mountMemory();
  assert.ok(await screen.findByText("Nothing yet. Tell Planner something to remember, like “I’m vegetarian.”"));
  assert.equal(screen.queryByRole("button", { name: "Erase memory" }) === null, true);
});

test("an edit main refuses explains why in the dialog; a valid edit saves and shows the new text", async () => {
  const ipc = memoryIpc(memoryView([SHORT, KIDS], [MEALS]), {
    refuse: (edit) => (edit.kind === "replace" && /password/u.test(edit.text) ? "blocked" : null),
  });
  await mountMemory();
  await chooseEntryAction(SHORT.text, "Edit");

  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByRole("textbox", { name: "Memory" }) as HTMLTextAreaElement;
  assert.equal(field.value, SHORT.text);
  assert.ok(within(dialog).getByText("22 / 500"));
  fireEvent.change(field, { target: { value: "My password is hunter2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  const alert = await within(dialog).findByRole("alert");
  assert.equal(
    alert.textContent,
    "This can’t be saved because it looks like a password or an instruction to the Bot.",
  );
  assert.ok(screen.getByRole("dialog"), "the dialog stays open so the person can fix it");

  fireEvent.change(field, { target: { value: "Prefers short, friendly answers." } });
  assert.equal(within(dialog).queryByRole("alert") === null, true, "typing clears the old error");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(document.querySelector("[role=dialog]") === null, true));
  assert.ok(await screen.findByText("Prefers short, friendly answers."));
  assert.equal(screen.queryByText(SHORT.text) === null, true);
  assert.deepEqual(ipc.edits, [
    { kind: "replace", target: "user", entryId: SHORT.id, text: "My password is hunter2" },
    { kind: "replace", target: "user", entryId: SHORT.id, text: "Prefers short, friendly answers." },
  ]);
});

test("an edit to a memory that changed elsewhere says so and shows the fresh list", async () => {
  const ipc = memoryIpc(memoryView([SHORT], []));
  await mountMemory();
  await chooseEntryAction(SHORT.text, "Edit");
  const dialog = await screen.findByRole("dialog");
  // Meanwhile the Bot rewrote that memory.
  ipc.set(memoryView([{ id: "u-new", text: "Prefers very short answers." }], []));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Memory" }), { target: { value: "Likes detail." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.match((await within(dialog).findByRole("alert")).textContent ?? "", /changed since you opened it/u);
  assert.ok(await screen.findByText("Prefers very short answers."));
});

test("Delete hides a memory at once, Undo brings it back untouched, and a kept delete is sent on leaving", async () => {
  const ipc = memoryIpc(memoryView([SHORT, KIDS], [MEALS]));
  await mountMemory();

  await chooseEntryAction(KIDS.text, "Delete");
  await waitFor(() => assert.equal(screen.queryByText(KIDS.text) === null, true));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  assert.ok(await screen.findByText(KIDS.text));
  assert.deepEqual(ipc.edits, [], "an undone delete never reaches main");

  await chooseEntryAction(KIDS.text, "Delete");
  await waitFor(() => assert.equal(screen.queryByText(KIDS.text) === null, true));
  assert.deepEqual(ipc.edits, []);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Instructions" });
  await waitFor(() => assert.deepEqual(ipc.edits, [{ kind: "remove", target: "user", entryId: KIDS.id }]));
  const memoryRow = await screen.findByRole("button", { name: "Memory" });
  await waitFor(() => assert.match(memoryRow.textContent ?? "", /2 things/u));
});

test("Erase memory asks first, then clears both groups", async () => {
  const ipc = memoryIpc(memoryView([SHORT], [MEALS]));
  await mountMemory();
  fireEvent.click(await screen.findByRole("button", { name: "Erase memory" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByRole("heading", { name: "Erase everything Planner remembers?" }));
  assert.ok(within(confirm).getByText("This can’t be undone."));
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(document.querySelector("[role=alertdialog]") === null, true));
  assert.deepEqual(ipc.edits, []);

  fireEvent.click(screen.getByRole("button", { name: "Erase memory" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Erase memory" }));
  await waitFor(() => assert.deepEqual(ipc.edits, [{ kind: "clear" }]));
  assert.ok(await screen.findByText("Nothing yet. Tell Planner something to remember, like “I’m vegetarian.”"));
  assert.equal(screen.queryByText(SHORT.text) === null, true);
  assert.equal(screen.queryByText(MEALS.text) === null, true);
});

test("unreadable memory shows a callout whose only action is Erase", async () => {
  const ipc = memoryIpc(memoryView([], [], { readable: false }));
  await mountMemory("/bots/bot-1");
  const row = await screen.findByRole("button", { name: "Memory" });
  await waitFor(() => assert.match(row.textContent ?? "", /Couldn’t be read/u));
  fireEvent.click(row);

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Memory couldn’t be read/u);
  assert.equal(screen.queryByRole("list", { name: "About you" }) === null, true);
  assert.equal(screen.queryAllByRole("meter").length, 0);
  assert.deepEqual(
    within(alert).getAllByRole("button").map((button) => button.textContent),
    ["Erase memory"],
  );
  fireEvent.click(within(alert).getByRole("button", { name: "Erase memory" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Erase memory" }));
  await waitFor(() => assert.deepEqual(ipc.edits, [{ kind: "clear" }]));
  assert.ok(await screen.findByText("Nothing yet. Tell Planner something to remember, like “I’m vegetarian.”"));
});

test("a pushed memory change with a new revision refreshes the page; this Bot's same revision or another Bot's does not", async () => {
  const ipc = memoryIpc(memoryView([SHORT], []));
  await mountMemory();
  assert.ok(await screen.findByText(SHORT.text));
  const before = memoryGets(ipc.calls);

  emitBotTestNotification("bots:memory:changed", { botId: "bot-2", revision: "other" });
  emitBotTestNotification("bots:memory:changed", { botId: "bot-1", revision: memoryView([SHORT], []).revision });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(memoryGets(ipc.calls), before);

  const next = memoryView([SHORT, KIDS], []);
  ipc.set(next);
  emitBotTestNotification("bots:memory:changed", { botId: "bot-1", revision: next.revision });
  assert.ok(await screen.findByText(KIDS.text));
  assert.equal(memoryGets(ipc.calls), before + 1);
});
