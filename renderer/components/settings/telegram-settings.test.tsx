import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { TelegramStatus } from "../../lib/ipc";
import { telegramStatusPollInterval } from "../../lib/queries";
import { Toaster, toast } from "../ui";
import { TelegramSettings } from "./telegram-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

const baseStatus: TelegramStatus = {
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
};

function mount(initial: Partial<TelegramStatus>, overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  let status: TelegramStatus = { ...baseStatus, ...initial };
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
      <Toaster />
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

test("removing the token rereads the bridge when the removal reports a failure", async () => {
  let status: Partial<TelegramStatus> = { enabled: true, polling: true, hasToken: true, allowedUserId: 7 };
  mount({}, {
    "telegram:get": () => ({ ...baseStatus, ...status }),
    "telegram:setKey": () => {
      status = { enabled: false, polling: false, hasToken: false };
      throw new Error("Telegram is off, but its running turn did not stop in time.");
    },
  });
  const remove = await screen.findByRole("button", { name: "Remove" });
  await waitFor(() => assert.equal(remove.hasAttribute("disabled"), false));

  fireEvent.click(remove);

  // The token is gone, so the page must show that rather than the state from before the click.
  await screen.findByText("Save your bot token in section 1 to connect.");
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

test("Reset pairing asks first, says who claims the bot next, and clears the owner only on confirm", async () => {
  let owner: number | undefined = 7;
  const { calls } = mount({}, {
    "telegram:get": () => ({ ...baseStatus, enabled: true, polling: true, allowedUserId: owner }),
    "telegram:resetPairing": () => {
      owner = undefined;
      return { reset: true };
    },
  });
  const resets = () => calls.filter((call) => call.channel === "telegram:resetPairing").length;

  fireEvent.click(await screen.findByRole("button", { name: "Reset pairing" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Reset Telegram pairing?" });
  assert.match(dialog.textContent ?? "", /next person to message your bot becomes its owner/u);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  assert.equal(resets(), 0);
  screen.getByText("User ID: 7");

  fireEvent.click(screen.getByRole("button", { name: "Reset pairing" }));
  await screen.findByRole("alertdialog", { name: "Reset Telegram pairing?" });
  fireEvent.click(screen.getByRole("button", { name: "Reset pairing" }));
  await screen.findByText("Pairing reset. The next person to message your bot becomes its owner.");
  assert.equal(resets(), 1);
  await waitFor(() => assert.equal(screen.queryByText("User ID: 7"), null));
  // The Reset pairing button is gone, so focus lands on Disconnect rather than the page.
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("button", { name: "Disconnect" })));
});

test("a Reset pairing that fails says why and keeps the owner", async () => {
  mount({ enabled: true, polling: true, allowedUserId: 7 }, {
    "telegram:resetPairing": () => {
      throw new Error("Couldn’t save the Telegram owner.");
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Reset pairing" }));
  await screen.findByRole("alertdialog", { name: "Reset Telegram pairing?" });
  fireEvent.click(screen.getByRole("button", { name: "Reset pairing" }));
  await screen.findByText("Couldn’t save the Telegram owner.");
  screen.getByText("User ID: 7");
});

test("deleting a profile that fails to delete says why", async () => {
  mount({ activeProfile: "work", profiles: ["default", "work"].map((name) => ({ name, hasToken: true, settings: {}, status: { status: "idle", queuedCount: 0 } })) }, {
    "telegram:deleteProfile": () => {
      throw new Error("The work profile is still connected.");
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Advanced Telegram settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  await screen.findByText("The work profile is still connected.");
  assert.equal(screen.queryByText(/profile work deleted/u), null);
});
