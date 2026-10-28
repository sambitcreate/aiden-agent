import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotEventRoutineView } from "../../shared/bot-event-routines";
import { BotEventRoutines, type BotEventRoutinesApi } from "./bot-event-routines";

afterEach(cleanup);

function fakeApi(link: string | null = "http://mac.local:4567/hooks/bot-routines/abc") {
  const routines: BotEventRoutineView[] = [];
  const created: unknown[] = [];
  const api: BotEventRoutinesApi = {
    list: async () => [...routines],
    create: async (input) => {
      created.push(input);
      const routine: BotEventRoutineView = { id: `r${routines.length + 1}`, botId: input.botId, name: input.name, prompt: input.prompt, trigger: input.trigger, enabled: true };
      routines.push(routine);
      return { routine, ...(input.trigger.kind === "webhook" ? { link } : {}) };
    },
    update: async (input) => {
      const routine = routines.find((entry) => entry.id === input.id)!;
      routine.enabled = input.enabled;
      return routine;
    },
    remove: async (input) => {
      routines.splice(routines.findIndex((entry) => entry.id === input.id), 1);
      return { removed: true };
    },
  };
  return { api, created, routines };
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
