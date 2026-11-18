import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import { DISABLED_APP_CAPABILITIES, type AppCapabilities } from "../../lib/app-capabilities";
import { AidenLiveSettings } from "./gemini-live-settings";
import { ScheduledTasksSettings } from "./scheduled-tasks-settings";

afterEach(cleanup);

async function mount(
  settings: Record<string, unknown> = {},
  capabilities?: AppCapabilities,
  { microphone = "granted", withScheduledTasks = false }: { microphone?: string; withScheduledTasks?: boolean } = {},
) {
  let stored = { ...settings };
  installBotTestIpc({
    "settings:get": () => stored,
    // Main stores the Scheduled tasks switch in app settings.
    "schedule:settings": (patch: unknown) => {
      const enabled = (patch as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled === "boolean") stored = { ...stored, scheduledTasksEnabled: enabled };
      return { enabled: stored.scheduledTasksEnabled !== false, defaultPermission: "read-only", defaultMcpEnabled: false };
    },
    "schedule:list": () => [],
    "mcp:list": () => [],
    "assistant-live:status": () => ({ available: false, reason: "missing-provider", state: "idle" }),
    "computerUse:status": () => ({ ready: false, detail: "Computer Use is off." }),
    "shortcut:get": () => ({ global: [] }),
  });
  (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.systemPreferences = {
    getMediaAccessStatus: async () => microphone,
    askForMediaAccess: async () => true,
  };
  const page = withScheduledTasks ? (
    <>
      <ScheduledTasksSettings />
      <AidenLiveSettings />
    </>
  ) : (
    <AidenLiveSettings />
  );
  await mountWithBotRouter(page, {
    initialPath: "/settings",
    ...(capabilities ? { capabilities } : {}),
  });
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

test("Screen and Accessibility is a readiness row only where this computer offers Computer Use", async () => {
  await mount({}, { ...DISABLED_APP_CAPABILITIES, geminiLive: true, computerUse: true });
  const offered = await screen.findByRole("group", { name: "Screen and Accessibility" });
  await within(offered).findByRole("button", { name: "Manage" });
  within(offered).getByText("Needs attention");
  cleanup();

  await mount({}, { ...DISABLED_APP_CAPABILITIES, geminiLive: true, computerUse: false });
  await screen.findByRole("group", { name: "Microphone" });
  assert.equal(screen.queryByRole("group", { name: "Screen and Accessibility" }), null);
});

test("a microphone the host can't report on is not shown as a problem", async () => {
  await mount({}, undefined, { microphone: "unknown" });
  const row = await screen.findByRole("group", { name: "Microphone" });
  await within(row).findByText("Not checked");
  assert.equal(within(row).queryByText("Needs attention"), null);

  fireEvent.click(within(row).getByRole("button", { name: "Allow" }));
  await within(row).findByText("Ready");
  cleanup();

  await mount({}, undefined, { microphone: "denied" });
  const denied = await screen.findByRole("group", { name: "Microphone" });
  await within(denied).findByText("Needs attention");
});

test("Scheduled tasks reads On on a fresh install and follows the Scheduled tasks switch", async () => {
  await mount({}, undefined, { withScheduledTasks: true });
  const row = await screen.findByRole("group", { name: "Scheduled tasks" });
  await within(row).findByText("On");

  const toggle = await screen.findByRole("switch", { name: "Enable scheduled tasks" });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  fireEvent.click(toggle);

  await within(row).findByText("Off");
  assert.equal(within(row).queryByText("On"), null);
});
