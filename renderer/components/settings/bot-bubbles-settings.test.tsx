import "../../main/bots/test-dom";
import { installBotTestIpc } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { botBubbleStore } from "../../lib/bot-bubbles-api";
import { EMPTY_BOT_BUBBLE_STATE, type BotBubbleState } from "../../shared/bot-bubbles";
import { BotBubblesSettings } from "./bot-bubbles-settings";

afterEach(() => {
  cleanup();
  botBubbleStore.accept(EMPTY_BOT_BUBBLE_STATE);
});

function mount(saved: Record<string, unknown>, bubbles: Partial<BotBubbleState>) {
  const calls = installBotTestIpc({
    "settings:get": () => saved,
    "settings:set": (patch: unknown) => ({ ...saved, ...(patch as Record<string, unknown>) }),
    "bots:bubbles:state": () => ({ ...EMPTY_BOT_BUBBLE_STATE, host: "window", ...bubbles }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <QueryClientProvider client={client}>
      <BotBubblesSettings />
    </QueryClientProvider>,
  );
  return calls;
}

const saves = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);

test("both switches start on, and each saves its own setting", async () => {
  const calls = mount({}, { floatOverAppsAvailable: true, host: "overlay" });
  const allow = await screen.findByRole("switch", { name: "Allow bubbles" });
  const float = await screen.findByRole("switch", { name: "Float over other apps" });
  await waitFor(() => assert.equal((allow as HTMLButtonElement).disabled, false));
  assert.equal(allow.getAttribute("aria-checked"), "true");
  assert.equal(float.getAttribute("aria-checked"), "true");

  await act(async () => fireEvent.click(float));
  await waitFor(() => assert.deepEqual(saves(calls), [{ botBubblesFloatOverApps: false }]));
  await waitFor(() => assert.equal(float.getAttribute("aria-checked"), "false"));

  await act(async () => fireEvent.click(allow));
  await waitFor(() => assert.deepEqual(saves(calls)[1], { botBubblesEnabled: false }));
  await waitFor(() => assert.equal(allow.getAttribute("aria-checked"), "false"));
});

test("with bubbles off, Float over other apps can't be changed", async () => {
  mount({ botBubblesEnabled: false }, { floatOverAppsAvailable: true, host: "off" });
  const float = await screen.findByRole("switch", { name: "Float over other apps" });
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Allow bubbles" }).getAttribute("aria-checked"), "false"));
  assert.equal((float as HTMLButtonElement).disabled, true);
});

test("where heads can't float over other apps, the switch is replaced by a note", async () => {
  mount({}, { floatOverAppsAvailable: false });
  await screen.findByRole("switch", { name: "Allow bubbles" });
  // The bubble state arrives after the first paint; the switch must never show.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.equal(screen.queryByRole("switch", { name: "Float over other apps" }), null);
  assert.ok(screen.getByText("On this desktop, heads stay inside the Aiden window."));
});
