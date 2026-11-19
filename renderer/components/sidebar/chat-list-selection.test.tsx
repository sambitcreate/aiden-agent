// Installs happy-dom for the Testing Library cases; must stay the first import.
import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatRow, type ChatRowMenu } from "./chat-row.js";
import { SelectionBar } from "./selection-bar.js";
import { TooltipProvider } from "../ui.js";
import { useRovingRows } from "../../lib/roving-rows.js";
import { useRowSelection } from "../../lib/use-row-selection.js";
import { bulkFailureMessage, runInOrder } from "../../lib/bulk-delete.js";

afterEach(cleanup);

interface Chat {
  id: string;
  title: string;
}

const CHATS: Chat[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Bravo" },
  { id: "c", title: "Charlie" },
  { id: "d", title: "Delta" },
];

const menu: ChatRowMenu = (Item) => <Item>Rename</Item>;

/** The sidebar's chat list in miniature: real rows, the list's hooks and the bulk bar. */
function ChatList({
  chats,
  current,
  onOpen = () => {},
  onBulkDelete = () => {},
}: {
  chats: Chat[];
  current?: string;
  onOpen?: (id: string) => void;
  onBulkDelete?: (ids: readonly string[]) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRovingRows(ref);
  const selection = useRowSelection(ref, { enabled: true, platform: "darwin" });
  return (
    <TooltipProvider>
      <button type="button">Search</button>
      <div ref={ref}>
        {chats.map((chat) => (
          <ChatRow
            key={chat.id}
            title={chat.title}
            status={{ state: "idle", unread: false }}
            selected={chat.id === current}
            menu={menu}
            selectId={chat.id}
            inSelection={selection.has(chat.id)}
            onOpen={() => onOpen(chat.id)}
          />
        ))}
        {selection.ids.length >= 2 ? (
          <SelectionBar
            count={selection.ids.length}
            onDelete={() => onBulkDelete(selection.ids)}
            onClear={selection.clear}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

const row = (title: string) => screen.getByRole("button", { name: title });
const selectedTitles = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-in-selection='true']")).map((element) => element.textContent);
const focused = () => document.activeElement?.textContent;
/** A click with the mouse: `detail` is 0 only for a click made with ↩ or Space. */
const pointerClick = (element: HTMLElement, init: MouseEventInit = {}) =>
  fireEvent.click(element, { detail: 1, ...init });
const tabStops = () =>
  screen
    .getAllByRole("button")
    .filter((element) => element.getAttribute("tabindex") !== "-1")
    .map((element) => element.getAttribute("aria-label") ?? element.textContent);

test("the chat list is one Tab stop: the open chat and its own ••• button", () => {
  render(<ChatList chats={CHATS} current="c" />);
  assert.deepEqual(tabStops(), ["Search", "Charlie", "More for Charlie"]);
});

test("↑ ↓ Home and End move between chats without opening them", () => {
  const opened: string[] = [];
  render(<ChatList chats={CHATS} current="a" onOpen={(id) => opened.push(id)} />);
  act(() => row("Alpha").focus());
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(focused(), "Bravo");
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  assert.equal(focused(), "Delta");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  assert.equal(focused(), "Alpha");
  assert.deepEqual(opened, []);
});

test("typing a title moves to that chat", () => {
  render(<ChatList chats={CHATS} current="a" />);
  act(() => row("Alpha").focus());
  fireEvent.keyDown(document.activeElement!, { key: "d" });
  assert.equal(focused(), "Delta");
});

test("a plain click and ↩ open the chat and select nothing", () => {
  const opened: string[] = [];
  render(<ChatList chats={CHATS} onOpen={(id) => opened.push(id)} />);
  pointerClick(row("Bravo"));
  fireEvent.click(row("Charlie"), { detail: 0, metaKey: true });
  assert.deepEqual(opened, ["b", "c"]);
  assert.deepEqual(selectedTitles(), []);
});

test("⌘-click toggles a chat without opening it, and two selected show the bar", () => {
  const opened: string[] = [];
  render(<ChatList chats={CHATS} onOpen={(id) => opened.push(id)} />);
  pointerClick(row("Alpha"), { metaKey: true });
  assert.deepEqual(selectedTitles(), ["Alpha"]);
  assert.equal(screen.queryByRole("group", { name: "Selected chats" }), null, "one chat is not a bulk selection");
  pointerClick(row("Charlie"), { metaKey: true });
  assert.deepEqual(selectedTitles(), ["Alpha", "Charlie"]);
  assert.equal(screen.getByRole("status").textContent, "2 selected");
  assert.equal(row("Charlie").getAttribute("aria-description"), "Selected");
  pointerClick(row("Alpha"), { metaKey: true });
  assert.deepEqual(selectedTitles(), ["Charlie"]);
  assert.deepEqual(opened, []);
});

test("Shift-click selects a range from the anchor, and a second range replaces the first", () => {
  render(<ChatList chats={CHATS} />);
  pointerClick(row("Bravo"), { metaKey: true });
  pointerClick(row("Delta"), { shiftKey: true });
  assert.deepEqual(selectedTitles(), ["Bravo", "Charlie", "Delta"]);
  pointerClick(row("Alpha"), { shiftKey: true });
  assert.deepEqual(selectedTitles(), ["Alpha", "Bravo"]);
});

test("Shift+↓ extends the selection from the focused chat, and Escape clears it", () => {
  render(<ChatList chats={CHATS} current="a" />);
  act(() => row("Bravo").focus());
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", shiftKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", shiftKey: true });
  assert.equal(focused(), "Delta");
  assert.deepEqual(selectedTitles(), ["Bravo", "Charlie", "Delta"]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp", shiftKey: true });
  assert.deepEqual(selectedTitles(), ["Bravo", "Charlie"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  assert.deepEqual(selectedTitles(), []);
  assert.equal(screen.queryByRole("group", { name: "Selected chats" }), null);
});

test("the bar's Delete acts on every selected chat, and deleted chats leave the selection", async () => {
  let deleted: readonly string[] = [];
  const { rerender } = render(<ChatList chats={CHATS} onBulkDelete={(ids) => (deleted = ids)} />);
  pointerClick(row("Alpha"), { metaKey: true });
  pointerClick(row("Charlie"), { shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  assert.deepEqual([...deleted].sort(), ["a", "b", "c"]);
  rerender(<ChatList chats={CHATS.filter((chat) => !deleted.includes(chat.id))} onBulkDelete={(ids) => (deleted = ids)} />);
  assert.deepEqual(selectedTitles(), []);
  assert.equal(screen.queryByRole("group", { name: "Selected chats" }), null);
});

test("when the focused chat is removed, focus moves to the chat that took its place", async () => {
  const { rerender } = render(<ChatList chats={CHATS} current="a" />);
  act(() => row("Bravo").focus());
  rerender(<ChatList chats={CHATS.filter((chat) => chat.id !== "b")} current="a" />);
  await act(() => Promise.resolve());
  assert.equal(focused(), "Charlie");
});

test("a delete that fails part way stops there, says how many went, and keeps the rest selected", async () => {
  const removed: string[] = [];
  let message = "";
  let chats = CHATS;
  const remove = async (id: string) => {
    if (id === "c") throw new Error("The disk is full.");
    removed.push(id);
  };
  const onBulkDelete = async (ids: readonly string[]) => {
    const result = await runInOrder(ids, remove);
    if (result.error) message = bulkFailureMessage("Deleted", result, ids.length, (result.error as Error).message);
    chats = chats.filter((chat) => !result.done.includes(chat.id));
  };
  const view = () => <ChatList chats={chats} onBulkDelete={(ids) => void onBulkDelete(ids)} />;
  const { rerender } = render(view());
  pointerClick(row("Alpha"), { metaKey: true });
  pointerClick(row("Delta"), { shiftKey: true });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  assert.deepEqual(removed, ["a", "b"], "nothing after the failure is tried");
  assert.equal(message, "Deleted 2 of 4; The disk is full.");
  rerender(view());
  assert.deepEqual(selectedTitles(), ["Charlie", "Delta"]);
  assert.equal(screen.getByRole("status").textContent, "2 selected");
});
