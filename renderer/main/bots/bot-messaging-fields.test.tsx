import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "./test-dom";
import { createBotTestQueryClient } from "./test-providers";
import type { BotDefinition } from "../../shared/bots";
import { BotMessagingFields } from "./bot-messaging-fields";
afterEach(cleanup);
function mount(off = false) {
  const bot = { id: "ada", name: "Ada", revision: "rev", instructions: "" } as BotDefinition;
  const calls = installBotTestIpc({
    "settings:get": () => ({ botMessaging: !off }),
    "bots:get": () => bot,
    "bots:update": () => bot,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <BotMessagingFields bot={bot} />
    </QueryClientProvider>,
  );
  return calls;
}
test("messaging switches default on, are keyboard controls, and save independently", async () => {
  const calls = mount();
  const toggle = await screen.findByRole("switch", { name: "Other Bots can message Ada" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  for (const control of screen.getAllByRole("switch")) {
    assert.equal(control.getAttribute("aria-checked"), "true");
    assert.ok(control.tabIndex >= 0);
  }
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(calls.filter((c) => c.channel === "bots:update").length, 1));
  const patch = calls.find((c) => c.channel === "bots:update")!.args[0] as Record<string, unknown>;
  assert.equal(patch.acceptsBotMessages, false);
  assert.equal(patch.messagesOtherBots, undefined);
});
test("the global switch disables both Bot controls", async () => {
  mount(true);
  await waitFor(() =>
    assert.equal(
      screen.getAllByRole("switch").every((c) => c.hasAttribute("disabled")),
      true,
    ),
  );
  await screen.findAllByText("Turned off in Settings → Bots");
});
