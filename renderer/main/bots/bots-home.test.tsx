import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../shared/bots";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);

const planner: BotDefinition = {
  id: "bot-1",
  revision: "rev-1",
  name: "Planner",
  description: "Plans trips",
  instructions: "Plan trips.",
  avatar: { ...DEFAULT_BOT_AVATAR },
  createdAt: 1,
  updatedAt: 1,
};

test("tapping a Bot row opens its one chat directly", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [planner],
    "bots:sessionState": () => ({ kind: "idle" }),
    "bots:openChat": () => ({ chatId: "chat-1", title: "Lisbon in May", updatedAt: Date.now() }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Lisbon in May")));

  fireEvent.click(row);
  await waitFor(() =>
    assert.equal(router.state.location.pathname, "/bots/bot-1/chat/chat-1"),
  );
  assert.deepEqual(calls.filter((call) => call.channel === "bots:send"), []);
});

test("the row context menu opens the Bot's profile", async () => {
  installBotTestIpc({
    "bots:list": () => [planner],
    "bots:sessionState": () => ({ kind: "idle" }),
    "bots:openChat": () => ({ chatId: "chat-1", title: "New chat", updatedAt: 1 }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.contextMenu(await screen.findByRole("button", { name: /Planner/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Profile" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
});
