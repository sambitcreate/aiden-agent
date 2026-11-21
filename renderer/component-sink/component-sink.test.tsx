import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as ui from "../components/ui";
import * as uiPrimitives from "../components/ui-primitives";
import * as infoHint from "../components/ui-info-hint";
import * as settingsPage from "../components/settings/settings-page";
import { APPEARANCE_STORAGE_KEY } from "../lib/appearance-runtime";
import { ComponentSink } from "./component-sink";

/**
 * Shared exports the sink leaves out on purpose. Anything else these modules
 * export as a component must appear in the sink, so a new primitive fails here
 * until it gets a case.
 */
const NOT_IN_SINK: Record<string, string> = {
  TooltipProvider: "renders no element; the sink is wrapped in it",
  SplitView: "the window shell, which needs the app's window chrome",
  Sidebar: "part of the window shell",
  SidebarFooter: "part of the window shell",
  ScrollArea: "the chat scroller, which needs a sized window pane",
  ScrollAreaFooterStack: "part of the chat scroller",
  ErrorBoundary: "a wrapper; its fallback, ErrorBoundaryView, is shown",
  SettingsAnchorContext: "a React context, not a component",
};

const MODULES: Record<string, unknown>[] = [ui, uiPrimitives, infoHint, settingsPage];

/** Every exported component, with aliases (`FieldLabel` is `Label`) grouped under one value. */
function exportedComponents(): Map<unknown, string[]> {
  const byValue = new Map<unknown, string[]>();
  for (const module of MODULES) {
    for (const [name, value] of Object.entries(module)) {
      if (!/^[A-Z]/u.test(name)) continue;
      const component =
        typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
      if (!component) continue;
      byValue.set(value, [...(byValue.get(value) ?? []), name]);
    }
  }
  return byValue;
}

function sinkClaims(): Set<string> {
  const claims = new Set<string>();
  for (const element of document.querySelectorAll("[data-sink]")) {
    for (const name of (element.getAttribute("data-sink") ?? "").split(/\s+/u)) if (name) claims.add(name);
  }
  return claims;
}

let savedAppearance: string | null = null;
beforeEach(() => {
  savedAppearance = JSON.stringify({ version: 1, mode: "light", light: { preset: "paper" }, dark: { preset: "aiden" } });
  localStorage.setItem(APPEARANCE_STORAGE_KEY, savedAppearance);
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(APPEARANCE_STORAGE_KEY);
});

test("the sink shows every shared component its modules export", () => {
  render(<ComponentSink />);
  const claims = sinkClaims();
  const exported = exportedComponents();
  const missing = [...exported.values()]
    .filter((names) => !names.some((name) => claims.has(name) || name in NOT_IN_SINK))
    .map((names) => names.join(" = "));
  assert.deepEqual(missing, [], "add a case for each, or a NOT_IN_SINK reason");

  const exportedNames = new Set([...exported.values()].flat());
  const unknown = [...claims].filter((name) => !exportedNames.has(name));
  assert.deepEqual(unknown, [], "data-sink names that no shared module exports");
  const stale = Object.keys(NOT_IN_SINK).filter((name) => !exportedNames.has(name));
  assert.deepEqual(stale, [], "NOT_IN_SINK entries that are no longer exported");
});

test("the sink renders each state it lists", () => {
  render(<ComponentSink />);
  const buttons = within(document.querySelector('[data-sink="Button"]') as HTMLElement);
  // Nine variants, each at rest, disabled and loading.
  assert.equal(buttons.getAllByRole("button", { name: "Save" }).length, 18);
  assert.equal(buttons.getAllByRole("button", { name: "Saving…" }).filter((button) => button.getAttribute("aria-busy") === "true").length, 9);

  assert.equal((screen.getByRole("textbox", { name: "Filled" }) as HTMLInputElement).value, "Weekly report");
  assert.equal((screen.getByRole("textbox", { name: "Disabled" }) as HTMLInputElement).disabled, true);
  assert.equal(screen.getByRole("textbox", { name: "Invalid" }).getAttribute("aria-invalid"), "true");
  assert.equal(screen.getByRole("switch", { name: "On" }).getAttribute("aria-checked"), "true");
  assert.equal(screen.getByRole("switch", { name: "Disabled on" }).hasAttribute("disabled"), true);
  assert.equal(screen.getByRole("checkbox", { name: "Toggle me" }).getAttribute("aria-checked"), "true");
  assert.equal(screen.getByRole("radio", { name: "Unavailable" }).hasAttribute("disabled"), true);
  const badges = within(document.querySelector('[data-sink="Badge"]') as HTMLElement);
  for (const color of ["gray", "green", "red", "blue", "warning"]) {
    assert.equal(badges.getAllByText(color).length, 2, `${color} badge with and without an icon`);
  }
});

test("dialog and menu triggers open the real primitives", async () => {
  render(<ComponentSink />);
  fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  assert.ok(within(dialog).getByRole("button", { name: "Rename" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));

  fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
  const alert = await screen.findByRole("alertdialog", { name: "Delete this chat?" });
  assert.ok(within(alert).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));

  fireEvent.pointerDown(screen.getByRole("button", { name: "Open menu" }), { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  assert.equal(within(menu).getByRole("menuitem", { name: "Share (unavailable)" }).getAttribute("aria-disabled"), "true");
  assert.equal(within(menu).getByRole("menuitemcheckbox", { name: /Pinned/u }).getAttribute("aria-checked"), "true");
  assert.equal(within(menu).getByRole("menuitemradio", { name: "Recent first" }).getAttribute("aria-checked"), "true");
  assert.equal(within(menu).getByRole("menuitem", { name: "Move to" }).getAttribute("aria-haspopup"), "menu");
});

test("the toolbar applies a preset and scheme the way the app does, and keeps the app's cached appearance", async () => {
  render(<ComponentSink />);
  const root = document.documentElement;
  // The sink starts from the app's cached appearance: light Paper.
  await waitFor(() => assert.equal(root.dataset.theme, "paper"));
  assert.equal(root.dataset.appearanceScheme, "light");
  const paperCanvas = root.style.getPropertyValue("--theme-canvas");

  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  await waitFor(() => assert.equal(root.dataset.appearanceScheme, "dark"));
  assert.equal(root.classList.contains("dark"), true);

  fireEvent.pointerDown(screen.getByRole("button", { name: /^Theme preset:/u }), { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  act(() => {
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Moss" }));
  });
  await waitFor(() => assert.equal(root.dataset.theme, "moss"));
  assert.notEqual(root.style.getPropertyValue("--theme-canvas"), paperCanvas);
  assert.ok(screen.getByRole("button", { name: "Theme preset: Moss" }));

  assert.equal(localStorage.getItem(APPEARANCE_STORAGE_KEY), savedAppearance);
});
