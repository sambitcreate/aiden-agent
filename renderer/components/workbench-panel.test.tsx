import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../lib/command-system";
import { COMMAND_IDS } from "../shared/keybindings";
import { WorkbenchTabStrip, type WorkbenchTab } from "./workbench-panel";

const SHORTCUTS = {
  effective: Object.fromEntries(
    COMMAND_IDS.map((id) => [id, id === "environment.toggle" ? "Command+Shift+E" : null]),
  ),
  global: [],
};

beforeEach(() => {
  installBotTestIpc({ "shortcut:get": () => SHORTCUTS });
  localStorage.clear();
});
afterEach(cleanup);

function renderWithCommands(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommandSystemProvider>{ui}</CommandSystemProvider>
    </QueryClientProvider>,
  );
}

const STRIP_TABS: { id: string; label: string; closable?: boolean; renameable?: boolean }[] = [
  { id: "notes", label: "Notes" },
  { id: "log", label: "Log", renameable: true },
  { id: "pinned", label: "Pinned", closable: false },
];

function StripHarness({
  busy = false,
  launcher = true,
  events,
}: {
  busy?: boolean;
  launcher?: boolean;
  events: string[];
}) {
  const [openIds, setOpenIds] = React.useState(STRIP_TABS.map((tab) => tab.id));
  const [selectedId, setSelectedId] = React.useState("notes");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const tabs: WorkbenchTab[] = STRIP_TABS.filter((tab) => openIds.includes(tab.id)).map((tab) => ({
    id: tab.id,
    viewId: tab.id,
    label: tab.label,
    selected: tab.id === selectedId,
    closable: tab.closable,
    dataAttributes: { "data-note-tab": tab.id },
    wrap: tab.renameable ? (button) => <span data-tab-wrapper={tab.id}>{button}</span> : undefined,
    onRename: tab.renameable
      ? () => {
          events.push(`rename:${tab.id}`);
          setRenamingId(tab.id);
        }
      : undefined,
    editor:
      renamingId === tab.id ? (
        <input aria-label={`Rename ${tab.label}`} defaultValue={tab.label} />
      ) : undefined,
  }));
  return (
    <WorkbenchTabStrip
      tabs={tabs}
      idPrefix="test"
      tabListLabel="Test views"
      busy={busy}
      activeTabRef={activeTabRef}
      onSelectTab={(tab) => {
        events.push(`select:${tab.id}`);
        setSelectedId(tab.id);
      }}
      onCloseTab={(tab) => {
        events.push(`close:${tab.id}`);
        setOpenIds((ids) => ids.filter((id) => id !== tab.id));
      }}
      newTab={launcher ? { label: "New test tab", onOpen: () => events.push("new-tab") } : undefined}
      closeLabel="Close test panel"
      closeTitle="Close test panel"
      onClose={() => events.push("close-panel")}
    />
  );
}

const selected = (name: string) =>
  screen.getByRole("tab", { name }).getAttribute("aria-selected");

test("a non-workspace tab set renders as one tablist with a single tab stop", () => {
  renderWithCommands(<StripHarness events={[]} />);
  const list = screen.getByRole("tablist", { name: "Test views" });
  assert.deepEqual(
    Array.from(list.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
    ["Notes", "Log", "Pinned"],
  );
  const notes = screen.getByRole("tab", { name: "Notes" });
  assert.equal(notes.getAttribute("aria-selected"), "true");
  assert.equal(notes.id, "test-notes-tab");
  assert.equal(notes.getAttribute("aria-controls"), "test-notes-panel");
  assert.equal(notes.tabIndex, 0);
  assert.equal(screen.getByRole("tab", { name: "Log" }).tabIndex, -1);
  assert.equal(screen.getByRole("tab", { name: "Log" }).id, "");
  assert.ok(screen.getByRole("tab", { name: "Log" }).closest('[data-tab-wrapper="log"]'));
  assert.ok(screen.getByRole("tab", { name: "Pinned" }).closest('[data-note-tab="pinned"]'));
});

test("arrow keys, Home and End move the selection and wrap at the ends", () => {
  renderWithCommands(<StripHarness events={[]} />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "ArrowRight" });
  assert.equal(selected("Log"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "End" });
  assert.equal(selected("Pinned"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "ArrowRight" });
  assert.equal(selected("Notes"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "ArrowLeft" });
  assert.equal(selected("Pinned"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "Home" });
  assert.equal(selected("Notes"), "true");
});

test("Delete closes a closable tab but never a fixed one", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness events={events} />);
  assert.equal(screen.queryByRole("button", { name: "Close Pinned tab" }), null);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "Delete" });
  assert.ok(screen.getByRole("tab", { name: "Pinned" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "Delete" });
  assert.equal(screen.queryByRole("tab", { name: "Log" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Close Notes tab" }));
  assert.equal(screen.queryByRole("tab", { name: "Notes" }), null);
  assert.deepEqual(events, ["close:log", "close:notes"]);
});

test("F2 and double-click rename only tabs that support it, and the editor replaces the button", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness events={events} />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "F2" });
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Notes" }));
  assert.deepEqual(events, []);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "F2" });
  assert.deepEqual(events, ["rename:log"]);
  assert.ok(screen.getByRole("textbox", { name: "Rename Log" }));
  assert.equal(screen.queryByRole("tab", { name: "Log" }), null);
  assert.ok(screen.getByRole("button", { name: "Close Log tab" }));
  cleanup();

  const clicks: string[] = [];
  renderWithCommands(<StripHarness events={clicks} />);
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Log" }));
  assert.deepEqual(clicks, ["rename:log"]);
});

test("busy disables tab navigation but leaves Close panel usable", async () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness busy events={events} />);
  for (const name of ["Notes", "Log", "Pinned"]) {
    assert.equal((screen.getByRole("tab", { name }) as HTMLButtonElement).disabled, true, name);
  }
  assert.equal((screen.getByRole("button", { name: "Close Notes tab" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "New test tab" }) as HTMLButtonElement).disabled, true);
  fireEvent.keyDown(screen.getByRole("button", { name: "Open tabs" }), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.getAttribute("aria-disabled")), ["true", "true", "true"]);
  fireEvent.keyDown(items[0], { key: "Escape" });
  const close = (await screen.findByRole("button", { name: "Close test panel" })) as HTMLButtonElement;
  assert.equal(close.disabled, false);
  fireEvent.click(close);
  assert.deepEqual(events, ["close-panel"]);
});

test("the new-tab launcher appears only when the tab set has one", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness launcher={false} events={events} />);
  assert.equal(screen.queryByRole("button", { name: "New test tab" }), null);
  cleanup();
  renderWithCommands(<StripHarness events={events} />);
  fireEvent.click(screen.getByRole("button", { name: "New test tab" }));
  assert.deepEqual(events, ["new-tab"]);
});

test("Open tabs lists every tab and selects the one chosen", async () => {
  renderWithCommands(<StripHarness events={[]} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Open tabs" }), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Notes", "Log", "Pinned"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Pinned" }));
  assert.equal(selected("Pinned"), "true");
});

test("Close panel names the panel toggle shortcut", async () => {
  renderWithCommands(<StripHarness events={[]} />);
  const close = screen.getByRole("button", { name: "Close test panel" });
  await waitFor(() =>
    assert.match(close.getAttribute("aria-keyshortcuts") ?? "", /^(Meta|Control)\+Shift\+E$/u),
  );
  assert.match(close.getAttribute("title") ?? "", /^Close test panel \((?!Unassigned).+\)$/u);
});
