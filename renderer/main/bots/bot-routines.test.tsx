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
