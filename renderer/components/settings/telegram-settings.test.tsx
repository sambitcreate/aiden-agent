import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { TelegramStatus } from "../../lib/ipc";
import { TelegramSettings } from "./telegram-settings";

afterEach(cleanup);

function mount(initial: Partial<TelegramStatus>) {
  let status: TelegramStatus = {
    enabled: false,
    hasToken: true,
    polling: false,
    queuedCount: 0,
    draftPreviews: false,
    activity: "quiet",
    rendering: "rich",
    voiceMode: "hidden",
    threadedMode: false,
    activeProfile: "default",
    profiles: [],
    recentDiagnostics: [],
    ...initial,
  };
  const calls = installBotTestIpc({
    "telegram:get": () => status,
    "telegram:setEnabled": (enabled: unknown) => {
      status = { ...status, enabled: enabled as boolean };
      return enabled;
    },
    "providers:list": () => [],
    "settings:get": () => ({}),
    "workspaces:list": () => [],
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <TelegramSettings />
    </QueryClientProvider>,
  );
  return { calls, status: () => status };
}

test("a bridge that is on but failed to poll can still be turned off", async () => {
  const { status } = mount({ enabled: true, polling: false, lastError: "Another process owns this bot." });
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), false));
  fireEvent.click(disconnect);
  await waitFor(() => assert.equal(status().enabled, false));
});

test("a bridge that is off has nothing to disconnect", async () => {
  mount({ enabled: false, polling: false });
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  assert.equal(disconnect.hasAttribute("disabled"), true);
});

test("the bridge has one on and off control, in step 3", async () => {
  mount({ hasToken: true });
  await screen.findByRole("button", { name: "Connect" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced Telegram settings" }));
  const switches = await screen.findAllByRole("switch");
  assert.deepEqual(
    switches.map((control) => control.getAttribute("aria-label")),
    ["Live answer drafts", "Private-chat threads"],
  );
});

test("connection steps stay open until a token is saved", async () => {
  mount({ hasToken: false });
  await screen.findByText(/Copy the bot token/u);
  cleanup();
  mount({ hasToken: true });
  await screen.findByRole("button", { name: "How to connect" });
  assert.equal(screen.queryByText(/Copy the bot token/u), null);
  fireEvent.click(screen.getByRole("button", { name: "How to connect" }));
  await screen.findByText(/Copy the bot token/u);
});

test("the unattended-authority notice shows without opening anything", async () => {
  for (const hasToken of [true, false]) {
    mount({ hasToken });
    await screen.findByText(/full unattended authority/u);
    cleanup();
  }
});

test("setup with no folder workspaces points at the sidebar", async () => {
  mount({ hasToken: false });
  await screen.findByText(/Add a folder workspace from the sidebar/u);
});
