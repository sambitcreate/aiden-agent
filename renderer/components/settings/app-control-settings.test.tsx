import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { AppControlSettings } from "./app-control-settings";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function install(settings: Record<string, unknown> = {}) {
  let current = { appControlPolicy: "safe", remoteAppControlsEnabled: false, ...settings };
  return installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch) => {
      current = { ...current, ...(patch as object) };
      return current;
    },
  });
}

test("changing the policy saves it", async () => {
  const calls = install();
  render(<AppControlSettings />);
  await flush();
  const trigger = screen.getByRole("combobox", { name: "Agent app actions" });
  assert.match(trigger.textContent ?? "", /Safe controls/u);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: "Ask every time" }));
  await flush();
  assert.ok(calls.some((call) => call.channel === "settings:set" && (call.args[0] as { appControlPolicy?: string }).appControlPolicy === "ask"));
  assert.match(screen.getByRole("combobox", { name: "Agent app actions" }).textContent ?? "", /Ask every time/u);
});

test("paired-device controls turn on only after the confirmation", async () => {
  const calls = install();
  render(<AppControlSettings />);
  await flush();
  fireEvent.click(screen.getByRole("switch", { name: "Paired-device chat controls" }));
  await flush();
  assert.equal(calls.some((call) => call.channel === "settings:set"), false);
  fireEvent.click(await screen.findByRole("button", { name: "Allow chat controls" }));
  await flush();
  assert.ok(calls.some((call) => call.channel === "settings:set" && (call.args[0] as { remoteAppControlsEnabled?: boolean }).remoteAppControlsEnabled === true));
  assert.equal(screen.getByRole("switch", { name: "Paired-device chat controls" }).getAttribute("aria-checked"), "true");
});

test("paired-device controls turn off without a confirmation", async () => {
  const calls = install({ remoteAppControlsEnabled: true });
  render(<AppControlSettings />);
  await flush();
  fireEvent.click(screen.getByRole("switch", { name: "Paired-device chat controls" }));
  await flush();
  assert.ok(calls.some((call) => call.channel === "settings:set" && (call.args[0] as { remoteAppControlsEnabled?: boolean }).remoteAppControlsEnabled === false));
});
