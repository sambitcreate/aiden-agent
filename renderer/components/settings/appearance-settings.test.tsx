import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { createDefaultAppearanceConfig, type AppearanceMode } from "../../shared/appearance";
import { TooltipProvider } from "../ui";
import { AppearanceSettings } from "./appearance-settings";

afterEach(cleanup);

type HeldMode = { mode: AppearanceMode; finish(): void; fail(): void };

/** The native theme bridge, with every mode change held open until the test finishes or fails it. */
async function mount() {
  const held: HeldMode[] = [];
  let themeSource: AppearanceMode = "system";
  installBotTestIpc({
    "settings:getAppearanceState": () => ({ appearance: { ...createDefaultAppearanceConfig(), mode: "system" }, pending: false }),
    "settings:previewAppearance": (appearance: unknown) => appearance,
    "settings:set": (patch: unknown) => patch,
    "bots:list": () => [],
  });
  const api = window.aidenAPI as unknown as Record<string, unknown>;
  api.nativeTheme = {
    getInfo: async () => ({ themeSource, shouldUseDarkColors: themeSource === "dark" }),
    onChanged: () => () => undefined,
    setThemeSource: (mode: AppearanceMode) =>
      new Promise<void>((resolve, reject) => {
        held.push({
          mode,
          finish() {
            themeSource = mode;
            resolve();
          },
          fail: () => reject(new Error("The system refused the theme.")),
        });
      }),
  };
  render(
    <TooltipProvider>
      <QueryClientProvider client={createBotTestQueryClient()}>
        <AppearanceSettings />
      </QueryClientProvider>
    </TooltipProvider>,
  );
  const group = await screen.findByRole("radiogroup", { name: "Theme mode" });
  await waitFor(() => assert.equal(within(group).getByRole("radio", { name: /System/u }).getAttribute("aria-checked"), "true"));
  return { group, held };
}

const radio = (group: HTMLElement, name: string) => within(group).getByRole("radio", { name: new RegExp(name, "u") });
const checkedMode = (group: HTMLElement) =>
  within(group).getAllByRole("radio").find((option) => option.getAttribute("aria-checked") === "true")?.textContent;

test("arrowing through theme modes keeps focus on the radios while each change is pending, and the last one wins", async () => {
  const { group, held } = await mount();
  radio(group, "System").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  await waitFor(() => assert.equal(held.length, 1));
  const light = radio(group, "Light");
  assert.equal(document.activeElement, light);
  assert.equal(light.hasAttribute("disabled"), false);
  assert.equal(checkedMode(group), "Light");

  // The next arrow still moves while Light is pending, and supersedes it.
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  const dark = radio(group, "Dark");
  assert.equal(document.activeElement, dark);
  assert.equal(dark.hasAttribute("disabled"), false);
  assert.equal(checkedMode(group), "Dark");

  // Let every native change land, including the superseded Light putting the system back before Dark runs.
  for (let index = 0; index < held.length; index += 1) {
    await act(async () => held[index]!.finish());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  assert.equal(held[held.length - 1]?.mode, "dark");
  assert.equal(checkedMode(group), "Dark");
  assert.equal(document.activeElement, dark);
});

test("a theme mode the system refuses puts the previous mode back", async () => {
  const { group, held } = await mount();
  fireEvent.click(radio(group, "Dark"));
  await waitFor(() => assert.equal(held.length, 1));
  assert.equal(checkedMode(group), "Dark");
  await act(async () => held[0]!.fail());
  await waitFor(() => assert.equal(checkedMode(group), "System"));
  assert.equal(radio(group, "Dark").hasAttribute("disabled"), false);
});
