import "../../main/bots/test-dom";
import * as React from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES, type AppCapabilities } from "../../lib/app-capabilities";
import { SIDEBAR_PREFERENCES_KEY, useInboxDockBadgeSync, useSidebarView } from "../../lib/use-sidebar-view";
import { InboxDockBadgeSetting, SidebarViewPicker } from "./sidebar-view-picker";

/** Stands in for the sidebar's Organize menu: another reader and writer of the same view. */
function OrganizeMenuProbe() {
  const { view, setView } = useSidebarView();
  return (
    <button type="button" data-testid="organize" data-view={view} onClick={() => setView("recent")}>
      Organize
    </button>
  );
}

function renderPicker() {
  return render(
    <>
      <h2 id="sidebar-title">Sidebar</h2>
      <SidebarViewPicker labelledBy="sidebar-title" />
      <OrganizeMenuProbe />
    </>,
  );
}

const storedView = () => (JSON.parse(localStorage.getItem(SIDEBAR_PREFERENCES_KEY) ?? "{}") as { view?: string }).view;
const checked = () => screen.getAllByRole("radio").filter((radio) => radio.getAttribute("aria-checked") === "true");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("the Sidebar setting offers the three views, checks the stored one and keeps one tab stop", () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "recent" }));
  renderPicker();
  const group = screen.getByRole("radiogroup", { name: "Sidebar" });
  assert.ok(group);
  // Each choice is found by its accessible name, in this order.
  assert.deepEqual(
    screen.getAllByRole("radio"),
    ["By workspace", "Recent only", "Inbox (Beta)"].map((name) => screen.getByRole("radio", { name })),
  );
  assert.deepEqual(checked(), [screen.getByRole("radio", { name: "Recent only" })]);
  assert.deepEqual(
    screen.getAllByRole("radio").map((radio) => radio.tabIndex),
    [-1, 0, -1],
  );
});

test("choosing Inbox switches the sidebar's view, and the Organize menu's change shows here", () => {
  renderPicker();
  fireEvent.click(screen.getByRole("radio", { name: "Inbox (Beta)" }));
  assert.equal(storedView(), "inbox");
  assert.equal(screen.getByTestId("organize").dataset.view, "inbox");
  assert.equal(screen.getByRole("radio", { name: "Inbox (Beta)" }).getAttribute("aria-checked"), "true");

  act(() => fireEvent.click(screen.getByTestId("organize")));
  assert.deepEqual(checked(), [screen.getByRole("radio", { name: "Recent only" })]);
});

test("arrow keys move the choice and focus together, wrapping at the ends", () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "projects" }));
  renderPicker();
  const first = screen.getByRole("radio", { name: "By workspace" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  assert.equal(storedView(), "inbox");
  assert.equal(document.activeElement, screen.getByRole("radio", { name: "Inbox (Beta)" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  assert.equal(storedView(), "projects");
  assert.equal(document.activeElement, first);
});

test("ArrowRight and ArrowDown move forward, wrapping past the last choice, and End jumps to it", () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "projects" }));
  renderPicker();
  const radio = (name: string) => screen.getByRole("radio", { name });
  radio("By workspace").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  assert.equal(storedView(), "recent");
  assert.equal(document.activeElement, radio("Recent only"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(storedView(), "inbox");
  assert.equal(document.activeElement, radio("Inbox (Beta)"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(storedView(), "projects", "ArrowDown on the last choice wraps to the first");
  assert.equal(document.activeElement, radio("By workspace"));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  assert.equal(storedView(), "inbox");
  assert.equal(document.activeElement, radio("Inbox (Beta)"));
  assert.deepEqual(checked(), [radio("Inbox (Beta)")]);
});

/** Stands in for the app root, which tells main whether to show the badge. */
function BadgeSyncProbe({ reports }: { reports: boolean[] }) {
  const report = React.useCallback(async (enabled: boolean) => {
    reports.push(enabled);
  }, [reports]);
  useInboxDockBadgeSync(report, true);
  return null;
}

function renderBadgeSetting(capabilities: Partial<AppCapabilities>, reports: boolean[] = []) {
  return render(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, ...capabilities }}>
      <h2 id="sidebar-title">Sidebar</h2>
      <SidebarViewPicker labelledBy="sidebar-title" />
      <InboxDockBadgeSetting />
      <BadgeSyncProbe reports={reports} />
    </AppCapabilitiesProvider>,
  );
}

const DOCK_SWITCH = "Show Needs you count on the Dock icon";
/** Reports go out after the effect, on the next microtask. */
const lastReport = async (reports: boolean[]) => {
  await Promise.resolve();
  await Promise.resolve();
  return reports[reports.length - 1];
};
const storedDockBadge = () =>
  (JSON.parse(localStorage.getItem(SIDEBAR_PREFERENCES_KEY) ?? "{}") as { dockBadge?: boolean }).dockBadge;

test("the Dock badge switch shows only while Inbox is the view, on by default, and its choice is stored", async () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "projects" }));
  const reports: boolean[] = [];
  renderBadgeSetting({ platform: "darwin", badgeCount: true }, reports);
  assert.equal(screen.queryByRole("switch", { name: DOCK_SWITCH }), null);
  assert.equal(await lastReport(reports), false, "no badge outside the Inbox");

  fireEvent.click(screen.getByRole("radio", { name: "Inbox (Beta)" }));
  const toggle = screen.getByRole("switch", { name: DOCK_SWITCH });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(await lastReport(reports), true);

  fireEvent.click(toggle);
  assert.equal(screen.getByRole("switch", { name: DOCK_SWITCH }).getAttribute("aria-checked"), "false");
  assert.equal(storedDockBadge(), false);
  assert.equal(await lastReport(reports), false, "switching it off clears the badge");

  // Leaving the Inbox hides the switch but keeps the choice for coming back.
  fireEvent.click(screen.getByRole("radio", { name: "Recent only" }));
  assert.equal(screen.queryByRole("switch", { name: DOCK_SWITCH }), null);
  fireEvent.click(screen.getByRole("radio", { name: "Inbox (Beta)" }));
  assert.equal(screen.getByRole("switch", { name: DOCK_SWITCH }).getAttribute("aria-checked"), "false");
  assert.equal(await lastReport(reports), false);
});

test("Linux names the app icon, and a host with no badge shows no switch", () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "inbox" }));
  const linux = renderBadgeSetting({ platform: "linux", badgeCount: true });
  assert.ok(screen.getByRole("switch", { name: "Show Needs you count on the app icon" }));
  linux.unmount();
  renderBadgeSetting({ platform: "other", badgeCount: false });
  assert.equal(screen.queryByRole("switch"), null);
});

test("a main that refuses the badge report leaves the settings usable", () => {
  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ view: "inbox" }));
  function RefusingSync() {
    // The preload throws at once for a channel it doesn't expose.
    useInboxDockBadgeSync(() => {
      throw new Error("IPC channel is not available to the renderer");
    }, true);
    return null;
  }
  render(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", badgeCount: true }}>
      <InboxDockBadgeSetting />
      <RefusingSync />
    </AppCapabilitiesProvider>,
  );
  fireEvent.click(screen.getByRole("switch", { name: DOCK_SWITCH }));
  assert.equal(storedDockBadge(), false);
});
