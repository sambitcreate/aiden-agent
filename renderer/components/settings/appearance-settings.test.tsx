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

/** Relative luminance (0 black to 1 white) of a CSS hex or rgb() color. */
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color);
  const channels = (hex ? hex.slice(1).map((part) => Number.parseInt(part, 16)) : rgb?.slice(1).map(Number)) ?? [];
  assert.equal(channels.length, 3, `unreadable color ${color}`);
  const [r, g, b] = channels.map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Each theme tile's name and how bright its preview is. */
function tileBrightness(): Array<{ name: string; luminance: number }> {
  const themes = screen.getByRole("radiogroup", { name: "Themes" });
  return within(themes).getAllByRole("radio").map((tile) => ({
    name: tile.textContent ?? "",
    luminance: luminance((tile.querySelector(".appearance-tile-swatch") as HTMLElement).style.backgroundColor),
  }));
}

test("every theme tile previews the light or dark look the chosen mode gives it", async () => {
  const { group, held } = await mount();
  // System on a computer in light mode: every tile, Graphite, Dusk and Midnight included, shows its light look.
  for (const tile of tileBrightness()) assert.ok(tile.luminance > 0.5, `${tile.name} should preview light`);

  fireEvent.click(radio(group, "Dark"));
  await waitFor(() => assert.equal(held.length, 1));
  // The tiles follow the choice at once, before the system confirms it.
  for (const tile of tileBrightness()) assert.ok(tile.luminance < 0.1, `${tile.name} should preview dark`);
  await act(async () => held[0]!.finish());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  for (const tile of tileBrightness()) assert.ok(tile.luminance < 0.1, `${tile.name} should stay dark`);

  fireEvent.click(radio(group, "Light"));
  await waitFor(() => assert.equal(held.length, 2));
  await act(async () => held[1]!.finish());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  for (const tile of tileBrightness()) assert.ok(tile.luminance > 0.5, `${tile.name} should preview light again`);
});
