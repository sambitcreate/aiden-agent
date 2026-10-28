import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotEventRoutineView } from "../../shared/bot-event-routines";
import { BotEventRoutines, botWatchStatusLine, type BotEventRoutinesApi } from "./bot-event-routines";

afterEach(cleanup);

function fakeApi(link: string | null = "http://mac.local:4567/hooks/bot-routines/abc") {
  const routines: BotEventRoutineView[] = [];
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const api: BotEventRoutinesApi = {
    list: async () => [...routines],
    create: async (input) => {
      created.push(input);
      const routine: BotEventRoutineView = { id: `r${routines.length + 1}`, botId: input.botId, name: input.name, prompt: input.prompt, trigger: input.trigger, enabled: true };
      routines.push(routine);
      return { routine, ...(input.trigger.kind === "webhook" ? { link } : {}) };
    },
    update: async (input) => {
      updated.push(input);
      const routine = routines.find((entry) => entry.id === input.id)!;
      if (input.enabled !== undefined) routine.enabled = input.enabled;
      if (input.name !== undefined) routine.name = input.name;
      if (input.prompt !== undefined) routine.prompt = input.prompt;
      if (input.trigger !== undefined) routine.trigger = input.trigger;
      return routine;
    },
    rotateLink: async () => ({ link: "http://mac.local:4567/hooks/bot-routines/new" }),
    remove: async (input) => {
      routines.splice(routines.findIndex((entry) => entry.id === input.id), 1);
      return { removed: true };
    },
  };
  return { api, created, updated, routines };
}

const BOT = { id: "bot-a", name: "Scout" };

test("choosing a folder saves a file_change trigger and lists it with its label", async () => {
  const h = fakeApi();
  render(<BotEventRoutines bot={BOT} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add/u }));
  fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Receipts" } });
  fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "File new receipts." } });
  fireEvent.change(screen.getByLabelText("Folder inside the Bot's folder"), { target: { value: "Inbox" } });
  fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
  await waitFor(() => assert.ok(screen.getByText("When files change in Inbox")));
  assert.deepEqual(h.created, [{ botId: "bot-a", name: "Receipts", prompt: "File new receipts.", trigger: { kind: "file_change", folder: "Inbox" } }]);
});

test("a link routine shows its link once, with Copy; without Aiden On The Go it says how to turn it on", async () => {
  const h = fakeApi(null);
  render(<BotEventRoutines bot={BOT} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add/u }));
  fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Orders" } });
  fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "Summarize the order." } });
  fireEvent.click(screen.getByRole("radio", { name: "Its link is called" }));
  assert.equal(screen.queryByLabelText("Folder inside the Bot's folder"), null);
  fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
  await waitFor(() => assert.ok(screen.getByText(/Turn on Aiden On The Go/u)));
  assert.equal(screen.queryByRole("button", { name: /Copy link/u }), null);
});

test("Add routine stays disabled until name, task and folder are filled", async () => {
  const h = fakeApi();
  render(<BotEventRoutines bot={BOT} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add/u }));
  const add = screen.getByRole("button", { name: "Add routine" }) as HTMLButtonElement;
  assert.equal(add.disabled, true);
  fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "x" } });
  fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "y" } });
  assert.equal(add.disabled, true, "a folder is still needed");
});

test("a link routine's link can be made again after it was lost", async () => {
  const h = fakeApi(null);
  render(<BotEventRoutines bot={BOT} api={h.api} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add/u }));
  fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Orders" } });
  fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "Summarize." } });
  fireEvent.click(screen.getByRole("radio", { name: "Its link is called" }));
  fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
  fireEvent.click(await screen.findByRole("button", { name: "New link for Orders" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: /Copy link/u })));
});

const NOW = Date.UTC(2026, 9, 28, 12);

test("a watch saves its address and interval, and stays unsaved until the address is allowed", async () => {
  const h = fakeApi();
  render(<BotEventRoutines bot={BOT} api={h.api} now={NOW} />);
  fireEvent.click(await screen.findByRole("button", { name: /Add/u }));
  fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Status page" } });
  fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "Tell me what changed." } });
  fireEvent.click(screen.getByRole("radio", { name: "A page or script gives a new answer" }));
  const add = screen.getByRole("button", { name: "Add routine" }) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("Address to check"), { target: { value: "http://status.example.com" } });
  assert.equal(add.disabled, true);
  assert.ok(screen.getByText(/Use an https address/u), "plain http beyond this Mac says why");
  fireEvent.change(screen.getByLabelText("Address to check"), { target: { value: "https://status.example.com/api" } });
  assert.equal(add.disabled, false);
  fireEvent.click(add);
  await waitFor(() => assert.ok(screen.getByText("Every hour, when https://status.example.com/api changes")));
  assert.deepEqual(h.created, [{
    botId: "bot-a",
    name: "Status page",
    prompt: "Tell me what changed.",
    trigger: { kind: "watch", source: { type: "url", url: "https://status.example.com/api" }, everyMinutes: 60 },
  }]);
  assert.ok(screen.getByText("First check soon."));
});

test("editing a watch keeps its kind and interval and can switch it to a script", async () => {
  const h = fakeApi();
  h.routines.push({
    id: "w1",
    botId: "bot-a",
    name: "Build",
    prompt: "Fix it.",
    enabled: true,
    trigger: { kind: "watch", source: { type: "url", url: "https://ci.example.com/" }, everyMinutes: 45 },
    watch: { failures: 0, lastCheckAt: NOW - 3 * 60_000, sameSince: NOW - 2 * 3_600_000, lastResult: "no_change" },
  });
  render(<BotEventRoutines bot={BOT} api={h.api} now={NOW} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Build" }));
  assert.equal(screen.queryByRole("radio", { name: "Files change in a folder" }), null, "a routine's kind is fixed");
  assert.equal((screen.getByLabelText("Address to check") as HTMLInputElement).value, "https://ci.example.com/");
  fireEvent.click(screen.getByRole("radio", { name: "A script in the Bot’s folder" }));
  fireEvent.change(screen.getByLabelText("Script inside the Bot's folder"), { target: { value: "scripts/ci.sh" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.ok(screen.getByText("Every 45 min, when the output of scripts/ci.sh changes")));
  assert.deepEqual(h.updated, [{
    botId: "bot-a",
    id: "w1",
    name: "Build",
    prompt: "Fix it.",
    trigger: { kind: "watch", source: { type: "script", script: "scripts/ci.sh" }, everyMinutes: 45 },
  }]);
});

test("a watch row says when it last checked, that nothing changed, or why it stopped", async () => {
  const h = fakeApi();
  h.routines.push(
    {
      id: "w1", botId: "bot-a", name: "Status", prompt: "x", enabled: true,
      trigger: { kind: "watch", source: { type: "url", url: "https://status.example.com/" }, everyMinutes: 15 },
      watch: { failures: 0, lastCheckAt: NOW - 5 * 60_000, sameSince: NOW - 26 * 3_600_000, lastResult: "no_change" },
    },
    {
      id: "w2", botId: "bot-a", name: "Prices", prompt: "x", enabled: false,
      trigger: { kind: "watch", source: { type: "url", url: "https://shop.example.com/" }, everyMinutes: 60 },
      watch: { failures: 3, lastCheckAt: NOW - 60_000, lastResult: "error", lastError: "shop.example.com answered 503." },
    },
  );
  render(<BotEventRoutines bot={BOT} api={h.api} now={NOW} />);
  assert.ok(await screen.findByText(/^Checked 5 minutes ago · No change since /u));
  assert.ok(screen.getByText("Turned off after 3 failed checks in a row. shop.example.com answered 503. Turn it on to try again."));
});

test("a failing watch that is still on counts its failed checks", () => {
  const line = botWatchStatusLine({ failures: 2, lastCheckAt: NOW - 60_000, lastResult: "error", lastError: "Aiden couldn't reach ci.example.com." }, true, "Scout", NOW);
  assert.equal(line.tone, "error");
  assert.match(line.text, /\(2 in a row\): Aiden couldn't reach ci\.example\.com\.$/u);
  assert.equal(botWatchStatusLine({ failures: 0, lastCheckAt: NOW, lastResult: "changed" }, true, "Scout", NOW).text.endsWith("Changed, so Scout took a look"), true);
});
