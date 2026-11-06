import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { LiveChatAccessSettings } from "./live-chat-access-settings";
import type { AppSettings } from "../../lib/types";

afterEach(cleanup);

function mount(settings: Partial<AppSettings>) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <LiveChatAccessSettings />
    </QueryClientProvider>,
  );
  return { calls, current: () => current };
}

const name = "Let Live use the open chat";

test("Live may use chats by default, and turning it off saves the switch", async () => {
  const { calls, current } = mount({});
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(screen.getByRole("switch", { name }).getAttribute("aria-checked"), "false"));
  assert.ok(calls.some((call) => call.channel === "settings:set"));
  assert.equal(current().aidenLiveChatAccess, false);
});

test("a saved choice to keep Live out of chats shows as off", async () => {
  mount({ aidenLiveChatAccess: false });
  await waitFor(() =>
    assert.equal(screen.getByRole("switch", { name }).getAttribute("aria-checked"), "false"),
  );
});
