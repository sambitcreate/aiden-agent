import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRovingRows } from "./roving-rows";

afterEach(cleanup);

interface Row {
  id: string;
  title: string;
}

/** A folder of chats like the sidebar's: the folder row, then its chats, each with a ••• button. */
function List({ rows, current, onToggle }: { rows: Row[]; current?: string; onToggle?: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRovingRows(ref);
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button">Before</button>
      <div ref={ref}>
        <div data-roving-group>
          <div data-roving-row>
            <button
              type="button"
              data-roving-item
              aria-expanded={open}
              onClick={() => {
                setOpen(!open);
                onToggle?.();
              }}
            >
              Folder
            </button>
            <button type="button">New chat in Folder</button>
          </div>
          {open
            ? rows.map((row) => (
                <div key={row.id} data-roving-row>
                  <button type="button" data-roving-item aria-current={row.id === current ? "page" : undefined}>
                    {row.title}
                  </button>
                  <button type="button">{`More for ${row.title}`}</button>
                </div>
              ))
            : null}
        </div>
      </div>
      <button type="button">After</button>
    </>
  );
}

const ROWS: Row[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Bravo" },
  { id: "c", title: "Charlie" },
];

const button = (name: string) => screen.getByRole("button", { name });
/** What Tab can reach, in order. */
const tabStops = () =>
  screen
    .getAllByRole("button")
    .filter((element) => element.getAttribute("tabindex") !== "-1")
    .map((element) => element.textContent);

test("the list is one Tab stop on the open chat, with only that row's own buttons beside it", () => {
  render(<List rows={ROWS} current="b" />);
  assert.deepEqual(tabStops(), ["Before", "Bravo", "More for Bravo", "After"]);
});

test("with no open chat the stop is the first row", () => {
  render(<List rows={ROWS} />);
  assert.deepEqual(tabStops(), ["Before", "Folder", "New chat in Folder", "After"]);
});

test("↓ and ↑ move between rows, Home and End jump to the ends, and the Tab stop follows", () => {
  render(<List rows={ROWS} current="a" />);
  button("Alpha").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(document.activeElement, button("Bravo"));
  assert.deepEqual(tabStops(), ["Before", "Bravo", "More for Bravo", "After"]);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  assert.equal(document.activeElement, button("Charlie"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(document.activeElement, button("Charlie"), "the last row stays put");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  assert.equal(document.activeElement, button("Folder"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  assert.equal(document.activeElement, button("Folder"));
});

test("keys with a modifier, and keys on a row's other buttons, are left alone", () => {
  render(<List rows={ROWS} current="a" />);
  button("Alpha").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", shiftKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", metaKey: true });
  assert.equal(document.activeElement, button("Alpha"));
  button("More for Alpha").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(document.activeElement, button("More for Alpha"));
});

test("← on a chat goes to its folder; ← and → close and open the folder", () => {
  let toggles = 0;
  render(<List rows={ROWS} current="b" onToggle={() => (toggles += 1)} />);
  button("Bravo").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  assert.equal(document.activeElement, button("Folder"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  assert.equal(toggles, 0, "→ on an open folder does nothing");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  assert.equal(toggles, 1);
  assert.equal(screen.queryByRole("button", { name: "Bravo" }), null);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  assert.equal(toggles, 2);
  assert.ok(button("Bravo"));
});

test("leaving the list brings its stop back to the open chat", () => {
  render(<List rows={ROWS} current="a" />);
  button("Alpha").focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(document.activeElement, button("Charlie"));
  act(() => button("After").focus());
  assert.deepEqual(tabStops(), ["Before", "Alpha", "More for Alpha", "After"]);
});

test("rows that arrive later join the list without adding Tab stops", async () => {
  const { rerender } = render(<List rows={ROWS} current="a" />);
  rerender(<List rows={[...ROWS, { id: "d", title: "Delta" }]} current="a" />);
  // The list re-syncs when its rows change.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(tabStops(), ["Before", "Alpha", "More for Alpha", "After"]);
  rerender(<List rows={[...ROWS, { id: "d", title: "Delta" }]} current="d" />);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(tabStops(), ["Before", "Delta", "More for Delta", "After"]);
});
