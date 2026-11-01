import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SIDEBAR_PREFERENCES_KEY, useSidebarView } from "../../lib/use-sidebar-view";
import { SidebarViewPicker } from "./sidebar-view-picker";

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
  assert.deepEqual(
    screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label") ?? radio.textContent),
    ["By workspace", "Recent only", "Inbox (Beta)"],
  );
  assert.deepEqual(checked().map((radio) => radio.textContent), ["Recent only"]);
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
  assert.deepEqual(checked().map((radio) => radio.textContent), ["Recent only"]);
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
