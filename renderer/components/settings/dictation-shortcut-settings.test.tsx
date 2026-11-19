import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES, type AppCapabilities } from "../../lib/app-capabilities";
import { Toaster, toast } from "../ui";
import { DictationShortcutSettings } from "./dictation-shortcut-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

async function mount(
  capabilities: Partial<AppCapabilities>,
  settings: Record<string, unknown> = {},
  saveGate?: Promise<void>,
  saveFails = false,
) {
  let stored = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => stored,
    "settings:set": async (patch: unknown) => {
      await saveGate;
      if (saveFails) throw new Error("Save cancelled");
      const next = patch as Record<string, unknown>;
      stored = { ...stored, ...next };
      // Main keeps the release-events flag in step with the chosen behavior.
      if (next.dictationActivationMode) stored.dictationHoldToTalk = next.dictationActivationMode !== "toggle";
      return stored;
    },
    "shortcut:get": () => ({ effective: {}, global: [] }),
  });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={createBotTestQueryClient()}>
        <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, ...capabilities }}>
          <Toaster />
          <DictationShortcutSettings />
        </AppCapabilitiesProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByText("Stop after silence");
  return calls;
}

const behavior = () => screen.queryByRole("combobox", { name: "Dictation shortcut behavior" });

test("a desktop with one behavior states it as a plain row with nothing to choose", async () => {
  await mount({});
  assert.notEqual(screen.queryByText("Press the global dictation shortcut once to start and again to stop."), null);
  assert.equal(behavior() === null, true);
  assert.equal(screen.queryAllByRole("radio").length, 0);
});

test("the row describes the saved behavior next to its selector", async () => {
  await mount({ dictationHoldToTalk: true }, { dictationHoldToTalk: true, dictationActivationMode: "hybrid" });
  await waitFor(() => assert.equal(behavior()?.textContent?.includes("Tap or hold"), true));
  assert.notEqual(
    screen.queryByText("Tap to start and tap again to stop, or hold while speaking and release to transcribe."),
    null,
  );
  assert.equal(screen.queryByText("Press once to start; press again to stop and transcribe.") === null, true);
});

test("choosing a behavior saves it and the description follows", async () => {
  const calls = await mount({ dictationHoldToTalk: true });
  const trigger = await screen.findByRole("combobox", { name: "Dictation shortcut behavior" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "Tap or hold" }));
  await waitFor(() =>
    assert.deepEqual(
      calls.find((call) => call.channel === "settings:set")?.args[0],
      { dictationActivationMode: "hybrid" },
    ),
  );
  await screen.findByText("Tap to start and tap again to stop, or hold while speaking and release to transcribe.");
});

test("while a behavior saves, focus stays on the selector and a second choice waits", async () => {
  let finishSave = () => {};
  const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
  const calls = await mount({ dictationHoldToTalk: true }, {}, saveGate);
  const trigger = await screen.findByRole("combobox", { name: "Dictation shortcut behavior" });
  const saves = () => calls.filter((call) => call.channel === "settings:set");
  const choose = async (name: string) => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name }));
    await waitFor(() => assert.equal(screen.queryByRole("option") === null, true));
  };

  await choose("Tap or hold");
  await waitFor(() => assert.equal(trigger.getAttribute("aria-busy"), "true"));
  await waitFor(() => assert.equal(document.activeElement === trigger, true));

  await choose("Hold to dictate");
  assert.equal(saves().length, 1);

  finishSave();
  await waitFor(() => assert.equal(trigger.getAttribute("aria-busy"), "false"));
  assert.equal(trigger.textContent?.includes("Tap or hold"), true);
});

test("a desktop that assigns the hold shortcut keeps saying so while Press to toggle is selected", async () => {
  await mount({ dictationHoldSetup: true });
  assert.equal(behavior()?.textContent?.includes("Press to toggle"), true);
  assert.notEqual(
    screen.queryByText(/let your desktop assign a hold shortcut for this session/u),
    null,
  );
});

test("each dictation switch is named by its row and saves its own setting", async () => {
  const calls = await mount({});
  const saves = () => calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  fireEvent.click(screen.getByRole("switch", { name: "Stop after silence" }));
  fireEvent.click(screen.getByRole("switch", { name: "Clean up transcript" }));
  fireEvent.click(screen.getByRole("switch", { name: "Play sounds" }));
  await waitFor(() =>
    assert.deepEqual(saves(), [
      { dictationSilenceStop: true },
      { dictationCleanup: true },
      { dictationSounds: true },
    ]),
  );
});

test("a failed switch save says so without blaming hold shortcuts", async () => {
  await mount({}, {}, undefined, true);
  fireEvent.click(screen.getByRole("switch", { name: "Play sounds" }));
  await screen.findByText("Couldn’t change dictation settings.");
  assert.equal(screen.queryByText(/hold shortcuts/u), null);
});

test("a failed behavior change explains that hold shortcuts may be unsupported", async () => {
  await mount({ dictationHoldToTalk: true }, {}, undefined, true);
  const trigger = await screen.findByRole("combobox", { name: "Dictation shortcut behavior" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "Tap or hold" }));
  await screen.findByText(/Your desktop may not support hold shortcuts/u);
});
