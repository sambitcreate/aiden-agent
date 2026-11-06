import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { useBotAllowed } from "../../main/bots/use-bot-allowed";
import type { BotAllowedEntry } from "../../shared/tool-approval-scope";
import { BotAllowedList } from "./bot-allowed-list";

afterEach(cleanup);
const ENTRIES: BotAllowedEntry[] = [
  { kind: "rule", id: "r1", botId: "bot:a", what: "Google Calendar · Create event", createdAt: "2026-11-03T15:00:00Z", uses: 12 },
  { kind: "rule", id: "r2", botId: "bot:a", what: "Click on amazon.com", createdAt: "2026-11-03T15:00:00Z", uses: 0 },
  { kind: "folder", id: "folder_team", botId: "bot:a", what: "Folder · ~/Documents/Team", createdAt: "2026-11-03T15:00:00Z" },
];

test("allowed rows show their exact coverage, added date and rule-only usage", () => {
  render(<BotAllowedList entries={ENTRIES} onRemove={() => {}} />);
  screen.getByRole("group", { name: "Google Calendar · Create event" });
  screen.getByText("Added 3 Nov 2026 · Used 12 times");
  screen.getByText("Added 3 Nov 2026 · Not used yet");
  const folder = screen.getByRole("group", { name: "Folder · ~/Documents/Team" });
  within(folder).getByText("Added 3 Nov 2026");
  assert.ok(!within(folder).queryByText(/used/iu));
});

test("Remove forwards the chosen entry and disables its pending row", () => {
  const removed: BotAllowedEntry[] = [];
  const view = render(<BotAllowedList entries={ENTRIES} onRemove={(entry) => removed.push(entry)} />);
  fireEvent.click(within(screen.getByRole("group", { name: "Click on amazon.com" })).getByRole("button", { name: "Remove" }));
  assert.equal(removed[0], ENTRIES[1]);
  view.rerender(<BotAllowedList entries={ENTRIES} removing="r2" onRemove={(entry) => removed.push(entry)} />);
  const button = within(screen.getByRole("group", { name: "Click on amazon.com" })).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.equal(removed.length, 1);
});

test("one use is singular and long folder labels remain complete", () => {
  const what = `Folder · ~/Documents/${"a-long-folder/".repeat(20)}`;
  render(<BotAllowedList entries={[{ ...ENTRIES[0]!, kind: "rule", uses: 1 }, { ...ENTRIES[2]!, kind: "folder", what }]} onRemove={() => {}} />);
  screen.getByText("Added 3 Nov 2026 · Used 1 time");
  screen.getByText(what);
});

function QueryConsumer({ botId }: { botId?: string }) {
  const allowed = useBotAllowed(botId);
  return <p>{`${botId ?? "all"}: ${allowed.data?.length ?? "loading"}`}</p>;
}

test("host changes invalidate only the changed Bot and all-Bot queries, with listener teardown", async (t) => {
  let list: BotAllowedEntry[] = [];
  const calls = installBotTestIpc({ "bots:allowed:list": () => list });
  const on = t.mock.method(window.aidenAPI.ipc, "onNotification");
  const queryClient = createBotTestQueryClient();
  const view = render(<QueryClientProvider client={queryClient}><QueryConsumer botId="bot:a" /><QueryConsumer botId="bot:b" /><QueryConsumer /></QueryClientProvider>);
  for (const id of ["bot:a", "bot:b", "all"]) await screen.findByText(`${id}: 0`);
  const before = calls.length;
  list = ENTRIES;
  act(() => emitBotTestNotification("bots:allowed:changed", { botId: "bot:a" }));
  await screen.findByText("bot:a: 3");
  await screen.findByText("all: 3");
  screen.getByText("bot:b: 0");
  assert.deepEqual(calls.slice(before).map((call) => call.args[0]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ botId: "bot:a" }, {}].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(on.mock.calls.filter((call) => call.arguments[0] === "bots:allowed:changed").length, 1, "one shared subscription per query client");
  view.unmount();
  const afterUnmount = calls.length;
  act(() => emitBotTestNotification("bots:allowed:changed", { botId: "bot:a" }));
  await act(async () => {});
  assert.equal(calls.length, afterUnmount);
  assert.equal(queryClient.getQueryState(["bot-allowed", "bot:a"])?.isInvalidated, false, "unmounted listeners do not invalidate cached data");
});
