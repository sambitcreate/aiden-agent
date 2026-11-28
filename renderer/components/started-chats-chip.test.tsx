// Installs happy-dom for the Testing Library cases; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StartedChatsChipView } from "./started-chats-chip";
import { TooltipProvider } from "./ui";
import { chatsApi } from "../lib/ipc";
import type { StartedChatView } from "../shared/child-chats";

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function mount(
  views: StartedChatView[],
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
) {
  const calls = installBotTestIpc({
    "chats:childChatsStop": () => ({
      chatId: "child-1",
      title: "Tests",
      state: "done",
      outcome: "stopped",
    }),
    "chats:childChatsStopAll": () => undefined,
    ...handlers,
  });
  const opened: string[] = [];
  let changed = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div data-testid="bar">
          <StartedChatsChipView
            leadChatId="lead-1"
            views={views}
            onOpen={(chatId) => opened.push(chatId)}
            onChanged={() => (changed += 1)}
          />
        </div>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, calls, opened, changed: () => changed };
}

const running: StartedChatView = { chatId: "child-1", title: "Tests", state: "running" };
const approval: StartedChatView = {
  chatId: "child-2",
  title: "Docs",
  state: "waiting_for_approval",
  branch: "aiden/docs",
};
const finished: StartedChatView = {
  chatId: "child-3",
  title: "Changelog",
  state: "done",
  outcome: "completed",
};

test("nothing shows when the chat started no chats", () => {
  mount([]);
  assert.equal(screen.getByTestId("bar").childElementCount, 0);
});

test("the chip counts working chats, says when one needs you, and lists each state", async () => {
  mount([
    running,
    approval,
    finished,
    { chatId: "child-4", title: "Yours", state: "running", tookOver: true },
  ]);
  // A chat the person took over still runs, so it counts as working.
  const chip = screen.getByRole("button", { name: "3 chats working, 1 needs you" });
  assert.match(chip.textContent ?? "", /3 chats working/u);
  fireEvent.click(chip);
  const dialog = await screen.findByRole("dialog", { name: "Started chats" });
  assert.ok(within(dialog).getByText("Working"));
  assert.ok(
    within(dialog).getByText("Needs your approval · aiden/docs"),
    "a chat in its own worktree names its branch",
  );
  assert.ok(within(dialog).getByText("Done"));
  assert.ok(within(dialog).getByText("Yours now"));
  // Stop is offered only where Aiden is still driving: not on a finished chat or one you took over.
  assert.ok(within(dialog).getByRole("button", { name: "Stop “Tests”" }));
  assert.ok(within(dialog).getByRole("button", { name: "Stop “Docs”" }));
  assert.equal(within(dialog).queryByRole("button", { name: "Stop “Changelog”" }), null);
  assert.equal(within(dialog).queryByRole("button", { name: "Stop “Yours”" }), null);
});

test("once none is working the chip counts the started chats and offers no Stop all", async () => {
  mount([finished, { chatId: "child-5", title: "Lint", state: "failed", reason: "interrupted" }]);
  fireEvent.click(screen.getByRole("button", { name: "2 started chats" }));
  const dialog = await screen.findByRole("dialog", { name: "Started chats" });
  assert.ok(within(dialog).getByText("Interrupted"));
  assert.equal(within(dialog).queryByRole("button", { name: "Stop all" }), null);
});

test("Open goes to the started chat and closes the list", async () => {
  const { opened } = mount([running]);
  fireEvent.click(screen.getByRole("button", { name: "1 chat working" }));
  const dialog = await screen.findByRole("dialog", { name: "Started chats" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Open “Tests”" }));
  assert.deepEqual(opened, ["child-1"]);
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Started chats" }), null));
});

test("Stop stops one chat for this lead and Stop all stops the rest", async () => {
  const { calls, changed } = mount([running, approval]);
  fireEvent.click(screen.getByRole("button", { name: "2 chats working, 1 needs you" }));
  const dialog = await screen.findByRole("dialog", { name: "Started chats" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop “Tests”" }));
  await waitFor(() => assert.equal(changed(), 1));
  assert.deepEqual(calls.find((call) => call.channel === "chats:childChatsStop")?.args, [
    { leadChatId: "lead-1", chatId: "child-1" },
  ]);

  fireEvent.click(within(dialog).getByRole("button", { name: "Stop all" }));
  await waitFor(() => assert.equal(changed(), 2));
  assert.deepEqual(calls.find((call) => call.channel === "chats:childChatsStopAll")?.args, [
    { leadChatId: "lead-1" },
  ]);
});

test("a failed Stop puts the row back", async () => {
  mount([running], {
    "chats:childChatsStop": () => {
      throw new Error("Aiden couldn't stop that chat.");
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "1 chat working" }));
  const dialog = await screen.findByRole("dialog", { name: "Started chats" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop “Tests”" }));
  assert.ok(within(dialog).getByText("Stopping…"));
  await waitFor(() => assert.ok(within(dialog).getByRole("button", { name: "Stop “Tests”" })));
  assert.ok(within(dialog).getByText("Working"));
});

test("the list read from main drops damaged rows and keeps the rest", async () => {
  installBotTestIpc({
    "chats:childChats": () => [
      { chatId: "child-1", title: "Tests", state: "running", reply: "ignored", runId: "run-1" },
      { chatId: "", title: "No id", state: "running" },
      { chatId: "child-2", title: "Odd", state: "exploded" },
      "garbage",
      {
        chatId: "child-3",
        title: "Docs",
        state: "done",
        outcome: "completed",
        branch: "aiden/docs",
      },
    ],
  });
  const views = await chatsApi.startedChats("lead-1");
  assert.deepEqual(views, [
    { chatId: "child-1", title: "Tests", state: "running" },
    { chatId: "child-3", title: "Docs", state: "done", outcome: "completed", branch: "aiden/docs" },
  ]);
});
