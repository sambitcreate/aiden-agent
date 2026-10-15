import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const bot = { id: "bot-1", name: "Chief" };

async function openDialog(initialPath = "/bots/bot-1", target: { id: string; name: string } = bot) {
  const harness = await mountWithBotRouter(
    <BotDeleteDialog bot={target} open onOpenChange={() => undefined} />,
    { initialPath },
  );
  return { ...harness, dialog: await screen.findByRole("alertdialog") };
}

test("the delete confirmation warns exactly what is erased", async () => {
  installBotTestIpc();
  const { dialog } = await openDialog();
  assert.ok(within(dialog).getByRole("heading", { name: "Delete Chief?" }));
  assert.ok(
    within(dialog).getByText(
      "This permanently erases Chief's chat, memory, instructions, routines, files, and photo. This can't be undone.",
    ),
  );
  assert.ok(within(dialog).getByRole("button", { name: "Delete Bot" }));
});

test("confirming calls bots:delete and returns to the Bots list", async () => {
  const calls = installBotTestIpc({ "bots:delete": () => undefined, "bots:list": () => [] });
  const { dialog, router } = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("bots:") && call.channel !== "bots:getCanonicalPhoto")[0],
    { channel: "bots:delete", args: ["bot-1"] },
  );
});

test("a failed delete keeps the dialog open and the Bot in place", async () => {
  installBotTestIpc({
    "bots:delete": () => {
      throw new Error("Error invoking remote method 'bots:delete': Error: This Bot is busy.");
    },
  });
  const { dialog, router } = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() =>
    assert.equal(
      (within(dialog).getByRole("button", { name: "Delete Bot" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.equal(router.state.location.pathname, "/bots/bot-1");
  assert.ok(screen.getByRole("alertdialog"));
});

const storedPreferences = () => parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), Date.now());

test("deleting the pinned Bot unpins it, even when it was the last Bot, and a failed delete keeps the pin", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-1", lastViewed: { "bot-1": 5 }, seenReplyAt: { "bot-1": 4 } }),
  );
  let fail = true;
  installBotTestIpc({
    "bots:delete": () => {
      if (fail) throw new Error("Error invoking remote method 'bots:delete': Error: This Bot is busy.");
    },
    "bots:list": () => [],
  });
  const { dialog, router } = await openDialog();
  const confirm = () => within(dialog).getByRole("button", { name: "Delete Bot" }) as HTMLButtonElement;
  fireEvent.click(confirm());
  await waitFor(() => assert.equal(confirm().disabled, false));
  assert.equal(storedPreferences().pinnedBotId, "bot-1", "nothing was deleted");

  fail = false;
  fireEvent.click(confirm());
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  assert.equal(storedPreferences().pinnedBotId, null);
  assert.equal(storedPreferences().lastViewed["bot-1"], undefined);
  assert.equal(storedPreferences().seenReplyAt["bot-1"], undefined);
});

test("deleting a Bot that is not on screen leaves the page, and any unsaved edits on it, where they are", async () => {
  const calls = installBotTestIpc({ "bots:delete": () => undefined, "bots:list": () => [] });
  const { router } = await openDialog("/bots/bot-1?page=instructions", { id: "bot-2", name: "Scout" });
  const confirm = () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete Bot" }) as HTMLButtonElement;
  fireEvent.click(confirm());
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:delete")));
  // The confirm handler has finished once the button is no longer busy.
  await waitFor(() => assert.equal(confirm().disabled, false));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(router.state.location.pathname, "/bots/bot-1");
  assert.equal(router.state.location.searchStr, "?page=instructions");
});
