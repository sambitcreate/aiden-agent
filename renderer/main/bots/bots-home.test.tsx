import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import { MCP_PRESETS } from "../../../main/services/mcp-presets";
import { BotConnectionSetupHost } from "./bot-connection-setup-host";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

afterEach(cleanup);

const idle = { botId: "bot-1", preview: null, updatedAt: null, state: { kind: "idle" } };

test("tapping a Bot row opens its one chat directly", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:live:summary": () => ({ ...idle, preview: "Lisbon in May", updatedAt: Date.now() }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /^Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Lisbon in May")));

  fireEvent.click(row);
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1/chat"));
  assert.deepEqual(calls.filter((call) => call.channel === "bots:send"), []);
});

test("the row's ••• menu opens the Bot's profile", async () => {
  installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:live:summary": () => idle,
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.keyDown(await screen.findByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Profile" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
});

test("a Bot that needs a model says so in its row", async () => {
  installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:live:summary": () => ({ ...idle, state: { kind: "needs_model" } }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /^Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Needs an AI model")));
});

test("an interrupted Bot's row reads Paused", async () => {
  installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:live:summary": () => ({ ...idle, state: { kind: "interrupted", submissionId: "s-1" } }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /^Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Paused — tap to resume")));
});

test("Start chat on a starter Bot sends one create request and opens its chat", async () => {
  let created = false;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-chief", name: "Chief of Staff" })] : []),
    "bots:live:summary": () => idle,
    "bots:createFromPreset": () => {
      const firstTime = !created;
      created = true;
      return { bot: botFixture({ id: "bot-chief", name: "Chief of Staff" }), created: firstTime };
    },
    "bots:live:subscribe": () => ({
      botId: "bot-chief",
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
    }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const heading = await screen.findByRole("heading", { name: "Meet your first Bot" });
  assert.ok(heading);
  const starters = screen.getByRole("list", { name: "Starter Bots" });
  const startChat = within(starters).getAllByRole("button", { name: "Start chat" })[0]!;

  // A second tap while the first is still answering is ignored; the same Bot opens.
  fireEvent.click(startChat);
  fireEvent.click(startChat);
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-chief/chat"));
  const presetCalls = calls.filter((call) => call.channel === "bots:createFromPreset");
  assert.equal(presetCalls.length, 1);
  assert.deepEqual(presetCalls[0]!.args[0], { presetId: "chief-of-staff" });
});

test("Create my own from the first run opens the create flow", async () => {
  installBotTestIpc({
    "bots:list": () => [],
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "Create my own" }));
  assert.ok(await screen.findByRole("dialog", { name: "New Bot" }));
});

test("a phone's Finish on your Mac opens the connection setup even with the Bots list closed", async () => {
  const presets = MCP_PRESETS.map((preset) => ({
    preset,
    serverId: `preset-${preset.id}`,
    configured: false,
    enabled: false,
    ready: false,
  }));
  let loaded = false;
  installBotTestIpc({
    "mcp:list": () => [],
    "mcp:presets": () => {
      loaded = true;
      return presets;
    },
  });
  // Mounted where the app mounts it, with the person on another page.
  await mountWithBotRouter(<BotConnectionSetupHost />, { initialPath: "/settings" });
  await waitFor(() => assert.ok(loaded));
  await new Promise((resolve) => setTimeout(resolve, 0));
  emitBotTestNotification("bots:connections:setup", { pluginId: "gmail" });
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getAllByText(/Gmail/u).length > 0);
});
