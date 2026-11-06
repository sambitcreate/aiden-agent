import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, screen } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import { AidenLiveSettings } from "./gemini-live-settings";

afterEach(cleanup);

async function mount(settings: Record<string, unknown> = {}) {
  installBotTestIpc({
    "settings:get": () => settings,
    "assistant-live:status": () => ({ available: false, reason: "missing-provider", state: "idle" }),
    "computerUse:status": () => ({ ready: false, detail: "Computer Use is off." }),
    "shortcut:get": () => ({ global: [] }),
  });
  (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.systemPreferences = {
    getMediaAccessStatus: async () => "granted",
  };
  await mountWithBotRouter(<AidenLiveSettings />, { initialPath: "/settings" });
}

test("the page keeps Aiden Live's beta mark and says how to end session access", async () => {
  await mount();
  await screen.findByText("Beta");
  await screen.findByText(/Stop Live to end\s+session access\./u);
});

test("Actions offers the two rows that do something, not a static statement", async () => {
  await mount();
  await screen.findByRole("group", { name: "Scheduled tasks" });
  await screen.findByRole("group", { name: "Global shortcut" });
});

test("with Aiden Live off, only the switch remains", async () => {
  await mount({ aidenLiveEnabled: false });
  await screen.findByRole("switch", { name: "Aiden Live" });
  assert.equal(screen.queryByRole("group", { name: "Scheduled tasks" }) === null, true);
  assert.equal(screen.queryByText("Live readiness") === null, true);
  assert.equal(screen.queryByText("Audio devices") === null, true);
});
