import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { TelegramStatus } from "../../lib/ipc";
import { telegramStatusPollInterval } from "../../lib/queries";
import { TelegramSettings } from "./telegram-settings";

afterEach(cleanup);

function mount(initial: Partial<TelegramStatus>, overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
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
    "telegram:setKey": () => {
      status = { ...status, hasToken: true };
      return { hasKey: true };
    },
    "telegram:setEnabled": (enabled: unknown) => {
      status = { ...status, enabled: enabled as boolean };
      return enabled;
    },
    "providers:list": () => [],
    "settings:get": () => ({}),
    "workspaces:list": () => [],
    ...overrides,
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

test("Connect and Disconnect both wait while the bridge is turning off", async () => {
  let finish: () => void = () => undefined;
  mount({ enabled: true, polling: false, lastError: "Another process owns this bot." }, {
    "telegram:setEnabled": () => new Promise<void>((resolve) => { finish = resolve; }),
  });
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), false));

  fireEvent.click(disconnect);

  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), true));
  assert.equal(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"), true);
  finish();
  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), false));
});

test("a Disconnect that fails leaves the button ready to try again", async () => {
  let attempts = 0;
  mount({ enabled: true, polling: true, allowedUserId: 7 }, {
    "telegram:setEnabled": () => {
      attempts += 1;
      throw new Error("Couldn’t save the Telegram setting.");
    },
  });
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), false));

  fireEvent.click(disconnect);

  await waitFor(() => assert.equal(attempts, 1));
  await waitFor(() => assert.equal(disconnect.hasAttribute("disabled"), false));
});

test("settings watch a bridge only while it is running and still has something to report", () => {
  const running = { enabled: true, polling: true } as TelegramStatus;
  const watching = (status: Partial<TelegramStatus>) => telegramStatusPollInterval({ ...running, ...status }) !== false;

  assert.equal(watching({ botUsername: "aiden_bot" }), true, "waiting for /start");
  assert.equal(watching({ allowedUserId: 7 }), true, "paired, but the bot hasn’t answered yet");
  assert.equal(watching({ allowedUserId: 7, botUsername: "aiden_bot" }), false, "connected");
  assert.equal(watching({ polling: false, lastError: "401: Unauthorized" }), false, "failed and stopped");
  assert.equal(watching({ enabled: false, polling: false }), false, "off");
  assert.equal(telegramStatusPollInterval(undefined), false, "not loaded");
});

test("a bridge that is off has nothing to disconnect", async () => {
  mount({ enabled: false, polling: false });
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  assert.equal(disconnect.hasAttribute("disabled"), true);
});

test("Connect and Disconnect are the only way to turn the bridge on and off", async () => {
  mount({ hasToken: true });
  await screen.findByRole("button", { name: "Connect" });
  screen.getByRole("button", { name: "Disconnect" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced Telegram settings" }));
  await screen.findByRole("switch", { name: "Live answer drafts" });
  assert.equal(screen.queryByRole("switch", { name: /enable|telegram/iu }), null);
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

test("saving a token folds the connection steps away", async () => {
  mount({ hasToken: false });
  await screen.findByText(/Copy the bot token/u);
  fireEvent.change(screen.getByPlaceholderText(/Paste your bot token/u), { target: { value: "123:abc" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(screen.queryByText(/Copy the bot token/u) === null, true));
  screen.getByRole("button", { name: "How to connect" });
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
