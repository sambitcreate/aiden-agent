import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotRoutines } from "./bot-routines";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);

const bot = { id: "bot-1", name: "Planner" };

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    botId: "bot-1",
    name: "Weekly meal prep",
    prompt: "Plan this week's meals.",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    timezone: "UTC",
    label: "Every Sunday at 8:41 AM",
    enabled: true,
    updatedAt: 10,
    ...overrides,
  };
}

test("routines show the label the host gives them", async () => {
  installBotTestIpc({ "bots:routines:list": () => [routine()] });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  const list = await screen.findByRole("list", { name: "Routines" });
  assert.ok(within(list).getByText("Weekly meal prep"));
  assert.ok(within(list).getByText("Every Sunday at 8:41 AM"));
});

test("Add routine builds a weekly schedule from the picked days and time", async () => {
  const calls = installBotTestIpc({
    "bots:routines:list": () => [],
    "bots:routines:create": (input) => routine({ ...(input as object), id: "task-2", label: "Every Sunday at 8:41 AM" }),
  });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  fireEvent.click(await screen.findByRole("button", { name: /Add routine/u }));
  const dialog = await screen.findByRole("dialog", { name: "Add routine" });

  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Weekly meal prep" } });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Weekly" }));
  // Weekly starts on Monday; switch it to Sunday.
  fireEvent.click(within(dialog).getByRole("button", { name: "Monday" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Sunday" }));
  fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "08:41" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it do?" }), {
    target: { value: "Plan this week's meals." },
  });
  assert.ok(within(dialog).getByText("Every Sunday at 8:41 AM"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routines:create").length, 1));
  const input = calls.find((call) => call.channel === "bots:routines:create")!.args[0] as Record<string, unknown>;
  assert.equal(input.botId, "bot-1");
  assert.equal(input.name, "Weekly meal prep");
  assert.equal(input.prompt, "Plan this week's meals.");
  assert.deepEqual(input.schedule, { kind: "weekly", days: [0], time: "08:41" });
  assert.equal(typeof input.timezone, "string");
});

test("a saved routine can be edited and deleted from its editor", async () => {
  const calls = installBotTestIpc({
    "bots:routines:list": () => [routine()],
    "bots:routines:delete": () => undefined,
  });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  fireEvent.click(await screen.findByRole("button", { name: /Weekly meal prep/u }));
  const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete routine" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routines:delete").length, 1));
  assert.deepEqual(calls.find((call) => call.channel === "bots:routines:delete")!.args[0], {
    botId: "bot-1",
    id: "task-1",
    expectedUpdatedAt: 10,
  });
});

test("editing a routine starts from its saved name, schedule, and message, and saves the change", async () => {
  const calls = installBotTestIpc({
    "bots:routines:list": () => [
      routine(),
      routine({ id: "task-2", name: "Morning brief", prompt: "Brief me.", schedule: { kind: "daily", time: "07:30" }, label: "Every day at 7:30 AM" }),
    ],
    "bots:routines:update": (input) => routine(input as Record<string, unknown>),
  });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  // Open Add first, then close it: the next editor must not keep the blank form.
  fireEvent.click(await screen.findByRole("button", { name: /Add routine/u }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Add routine" })).getByRole("button", { name: "Cancel" }));
  fireEvent.click(await screen.findByRole("button", { name: /Weekly meal prep/u }));
  const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
  assert.equal((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Weekly meal prep");
  assert.equal(
    (within(dialog).getByRole("textbox", { name: "What should it do?" }) as HTMLTextAreaElement).value,
    "Plan this week's meals.",
  );
  assert.equal(within(dialog).getByRole("radio", { name: "Weekly" }).getAttribute("aria-checked"), "true");
  assert.equal(within(dialog).getByRole("button", { name: "Sunday" }).getAttribute("aria-pressed"), "true");
  assert.equal((within(dialog).getByLabelText("Time") as HTMLInputElement).value, "08:41");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Sunday meal prep" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routines:update").length, 1));
  assert.deepEqual(calls.find((call) => call.channel === "bots:routines:update")!.args[0], {
    botId: "bot-1",
    id: "task-1",
    expectedUpdatedAt: 10,
    name: "Sunday meal prep",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Plan this week's meals.",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // A second routine opens with its own values, not the first one's.
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Edit routine" }), null));
  fireEvent.click(await screen.findByRole("button", { name: /Morning brief/u }));
  const second = await screen.findByRole("dialog", { name: "Edit routine" });
  assert.equal((within(second).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Morning brief");
  assert.equal(within(second).getByRole("radio", { name: "Every day" }).getAttribute("aria-checked"), "true");
});

test("an incomplete routine is not saved and says what is missing", async () => {
  const calls = installBotTestIpc({ "bots:routines:list": () => [] });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  fireEvent.click(await screen.findByRole("button", { name: /Add routine/u }));
  const dialog = await screen.findByRole("dialog", { name: "Add routine" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByText("Give the routine a name."));

  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Weekly" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByText("Tell the Bot what to do."));

  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it do?" }), { target: { value: "Check in." } });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Weekly" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Monday" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByText("Choose at least one day."));

  fireEvent.click(within(dialog).getByRole("button", { name: "Tuesday" }));
  fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByText("Choose a time."));
  assert.equal(calls.some((call) => call.channel === "bots:routines:create"), false);
});

test("a time the host refuses keeps the editor open with its reason", async () => {
  installBotTestIpc({
    "bots:routines:list": () => [],
    "bots:routines:create": () => Promise.reject(new Error("Pick a time in the future for this routine.")),
  });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  fireEvent.click(await screen.findByRole("button", { name: /Add routine/u }));
  const dialog = await screen.findByRole("dialog", { name: "Add routine" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Reminder" } });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Once" }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it do?" }), { target: { value: "Remind me." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByText("Pick a time in the future for this routine."));
  assert.ok(screen.getByRole("dialog", { name: "Add routine" }));
});

test("routines that fail to load say so instead of claiming there are none", async () => {
  let attempts = 0;
  installBotTestIpc({
    "bots:routines:list": () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("offline")) : [routine()];
    },
  });
  await mountWithBotRouter(<BotRoutines bot={bot} />, { initialPath: "/bots/bot-1" });
  const alert = await screen.findByRole("alert");
  assert.ok(within(alert).getByText("Aiden couldn’t load Planner’s routines."));
  assert.equal(screen.queryByText(/No routines yet/u), null);
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  assert.ok(await screen.findByText("Every Sunday at 8:41 AM"));
});
