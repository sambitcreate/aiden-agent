import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { ComputerUseSettings } from "./computer-use-settings";
import type { AppSettings, ComputerUseStatus } from "../../lib/types";

afterEach(cleanup);

function computerUseStatus(enabled: boolean): ComputerUseStatus {
  return {
    enabled,
    beta: true,
    state: enabled ? "ready" : "disabled",
    detail: enabled ? "Computer Use is ready." : "Computer Use is off.",
    ready: enabled,
    available: true,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: enabled, screenRecording: enabled },
  };
}

function mount(settings: Partial<AppSettings>) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "computerUse:status": () => computerUseStatus(current.computerUseEnabled === true),
    "formFill:status": () => ({ enabled: false, status: { state: "not-downloaded" } }),
    "computerUse:resetChatGrants": () => {
      current = { ...current, computerUseAlwaysAllow: false };
      return { cleared: 2 };
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ComputerUseSettings />
    </QueryClientProvider>,
  );
  return calls;
}

const alwaysAllowName = "Always allow Computer Use in every chat";

test("Always allow is off by default and turning it on saves the setting", async () => {
  const calls = mount({ computerUseEnabled: true });
  const toggle = await screen.findByRole("switch", { name: alwaysAllowName });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
      [{ computerUseAlwaysAllow: true }],
    ),
  );
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
});

test("a saved Always allow shows as on and can be turned off", async () => {
  const calls = mount({ computerUseEnabled: true, computerUseAlwaysAllow: true });
  const toggle = await screen.findByRole("switch", { name: alwaysAllowName });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  fireEvent.click(toggle);
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
      [{ computerUseAlwaysAllow: false }],
    ),
  );
});

test("Always allow and resetting chat permissions are hidden while the beta is off", async () => {
  mount({ computerUseEnabled: false, computerUseAlwaysAllow: true });
  await screen.findByRole("switch", { name: "Enable Computer Use beta" });
  await waitFor(() => assert.ok(screen.getByText("Off")));
  assert.equal(screen.queryByRole("switch", { name: alwaysAllowName }), null);
  assert.equal(screen.queryByRole("button", { name: "Reset" }), null);
});

test("resetting chat permissions clears grants and shows Always allow as off again", async () => {
  const calls = mount({ computerUseEnabled: true, computerUseAlwaysAllow: true });
  const toggle = await screen.findByRole("switch", { name: alwaysAllowName });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  const settingsReads = calls.filter((call) => call.channel === "settings:get").length;
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  assert.equal(calls.filter((call) => call.channel === "computerUse:resetChatGrants").length, 1);
  assert.ok(calls.filter((call) => call.channel === "settings:get").length > settingsReads);
});
