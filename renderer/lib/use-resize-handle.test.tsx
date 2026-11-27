// The shared divider behavior: the drag threshold, the modifier guard, keys,
// Enter to collapse, right-to-left text and the ARIA value.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SplitView } from "../components/ui";
import { effectiveBindings } from "../shared/keybindings";
import { CommandSystemProvider } from "./command-system";
import { useResizeHandle, type ResizeHandleOptions } from "./use-resize-handle";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type Log = { resized: number[]; committed: number[]; resizing: boolean[]; toggles: number };

function Divider({
  log,
  initial = 300,
  rtl = false,
  collapsible = false,
  ...options
}: Partial<Omit<ResizeHandleOptions, "value" | "onResize" | "onCommit">> & {
  log: Log;
  initial?: number;
  rtl?: boolean;
  collapsible?: boolean;
}) {
  const [size, setSize] = React.useState(initial);
  const handle = useResizeHandle({
    orientation: "vertical",
    panel: "start",
    min: 200,
    max: 400,
    ...options,
    value: size,
    onResize: (next) => {
      log.resized.push(next);
      setSize(next);
    },
    onCommit: (next) => {
      log.committed.push(next);
      setSize(next);
    },
    onResizingChange: (resizing) => log.resizing.push(resizing),
    onToggleCollapse: collapsible ? () => (log.toggles += 1) : undefined,
  });
  return (
    <div style={rtl ? { direction: "rtl" } : undefined}>
      <div {...handle} aria-label="Resize panel" />
    </div>
  );
}

const newLog = (): Log => ({ resized: [], committed: [], resizing: [], toggles: 0 });
const divider = () => screen.getByRole("separator", { name: "Resize panel" });
const valueNow = () => Number(divider().getAttribute("aria-valuenow"));

function press(init: PointerEventInit = {}) {
  fireEvent.pointerDown(divider(), { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, ...init });
}
function pointer(type: "pointermove" | "pointerup" | "pointercancel", clientX: number, clientY = 100) {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX, clientY }));
  });
}
function key(key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(divider(), { key, ...init });
}

test("the divider reports its size, bounds and orientation, and leaves the tab order when disabled", () => {
  const log = newLog();
  const view = render(<Divider log={log} initial={312.6} />);
  assert.equal(divider().getAttribute("aria-orientation"), "vertical");
  assert.equal(divider().getAttribute("aria-valuemin"), "200");
  assert.equal(divider().getAttribute("aria-valuemax"), "400");
  assert.equal(valueNow(), 313);
  assert.equal(divider().tabIndex, 0);
  view.rerender(<Divider log={log} disabled />);
  assert.equal(divider().tabIndex, -1);
  press();
  pointer("pointermove", 150);
  key("End");
  assert.deepEqual([log.resized, log.committed], [[], []], "a disabled divider ignores input");
});

test("a press that moves less than 3px is a click, not a resize", () => {
  const log = newLog();
  render(<Divider log={log} />);
  press();
  pointer("pointermove", 102, 102);
  pointer("pointerup", 102, 102);
  assert.deepEqual(log, newLog());
  assert.equal(valueNow(), 300);
  assert.equal(document.body.style.cursor, "");
});

test("the threshold counts movement along the resize axis only", () => {
  const log = newLog();
  render(<Divider log={log} />);
  press();
  pointer("pointermove", 102, 140);
  pointer("pointerup", 102, 140);
  assert.deepEqual(log, newLog(), "moving across a column divider never resizes it");
});

test("a mouse press never focuses the divider, so a later Enter goes where focus was; Tab still reaches it", () => {
  const log = newLog();
  render(
    <>
      <button type="button">Send</button>
      <Divider log={log} collapsible />
    </>,
  );
  screen.getByRole("button", { name: "Send" }).focus();
  assert.equal(fireEvent.mouseDown(divider(), { button: 0 }), false, "the press's default focus change is prevented");
  assert.equal(document.activeElement?.textContent, "Send");
  divider().focus();
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Resize panel");
  key("Enter");
  assert.equal(log.toggles, 1);
});

test("a drag past the threshold follows the pointer within the bounds and commits on release", () => {
  const log = newLog();
  render(<Divider log={log} />);
  press();
  pointer("pointermove", 103);
  assert.deepEqual(log.resizing, [true]);
  assert.equal(valueNow(), 303);
  assert.equal(document.body.style.cursor, "col-resize", "the cursor holds while the pointer crosses other content");
  pointer("pointermove", 400);
  assert.equal(valueNow(), 400, "never past the maximum");
  assert.deepEqual(log.committed, [], "nothing settles mid-drag");
  pointer("pointerup", 20);
  assert.deepEqual(log.committed, [220]);
  assert.deepEqual(log.resizing, [true, false]);
  assert.equal(document.body.style.cursor, "");
  pointer("pointermove", 300);
  assert.equal(valueNow(), 220, "the drag ended with the release");
});

test("a canceled pointer keeps the size it reached", () => {
  const log = newLog();
  render(<Divider log={log} />);
  press();
  pointer("pointermove", 140);
  pointer("pointercancel", 0);
  assert.deepEqual(log.committed, [340]);
  assert.deepEqual(log.resizing, [true, false]);
});

test("a press with a modifier or another button, or from a second pointer, never resizes", () => {
  for (const init of [
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { button: 2 },
    { isPrimary: false },
  ]) {
    const log = newLog();
    render(<Divider log={log} />);
    press(init);
    pointer("pointermove", 160);
    pointer("pointerup", 160);
    assert.deepEqual(log, newLog(), JSON.stringify(init));
    cleanup();
  }
});

test("arrows step, Shift steps further, Home and End jump to the bounds", () => {
  const log = newLog();
  render(<Divider log={log} />);
  key("ArrowRight");
  assert.equal(valueNow(), 316);
  key("ArrowRight", { shiftKey: true });
  assert.equal(valueNow(), 356);
  key("ArrowLeft");
  assert.equal(valueNow(), 340);
  key("End");
  key("ArrowRight");
  assert.equal(valueNow(), 400, "never past the maximum");
  key("Home");
  key("ArrowLeft", { shiftKey: true });
  assert.equal(valueNow(), 200, "never under the minimum");
  assert.deepEqual(log.committed, [316, 356, 340, 400, 400, 200, 200], "each key settles the size");
  assert.equal(key("ArrowUp"), true, "the other axis's arrows are not taken");
});

test("Alt, Control and Meta with a key belong to the system", () => {
  const log = newLog();
  render(<Divider log={log} collapsible />);
  for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(key("ArrowRight", init), true, "not prevented");
    assert.equal(key("Enter", init), true);
  }
  assert.deepEqual(log, newLog());
});

test("a panel after the divider grows as it moves toward the start, and a row divider uses Up and Down", () => {
  const log = newLog();
  render(<Divider log={log} panel="end" />);
  key("ArrowLeft");
  assert.equal(valueNow(), 316);
  press();
  pointer("pointermove", 80);
  assert.equal(valueNow(), 336);
  pointer("pointerup", 80);
  cleanup();

  render(<Divider log={newLog()} orientation="horizontal" panel="end" />);
  assert.equal(divider().getAttribute("aria-orientation"), "horizontal");
  key("ArrowUp");
  assert.equal(valueNow(), 316);
  key("ArrowDown", { shiftKey: true });
  assert.equal(valueNow(), 276);
  assert.equal(key("ArrowLeft"), true, "left and right are not taken");
  press({ clientY: 100 });
  pointer("pointermove", 100, 50);
  assert.equal(valueNow(), 326);
  assert.equal(document.body.style.cursor, "row-resize");
  pointer("pointerup", 100, 50);
});

test("right-to-left text flips the horizontal direction for keys and drags", () => {
  const log = newLog();
  render(<Divider log={log} rtl />);
  // The start panel sits to the right, so moving the divider left widens it.
  key("ArrowLeft");
  assert.equal(valueNow(), 316);
  key("ArrowRight");
  assert.equal(valueNow(), 300);
  press();
  pointer("pointermove", 60);
  assert.equal(valueNow(), 340);
  pointer("pointerup", 60);
  assert.deepEqual(log.committed, [316, 300, 340]);
});

test("Enter toggles collapse only for a panel that can collapse, once per press", () => {
  const log = newLog();
  render(<Divider log={log} collapsible />);
  assert.equal(key("Enter"), false, "Enter is taken");
  assert.equal(key("Enter", { repeat: true }), true, "a held key does not toggle again");
  assert.equal(log.toggles, 1);
  cleanup();
  render(<Divider log={log} />);
  assert.equal(key("Enter"), true, "Enter is left alone");
  assert.equal(log.toggles, 1);
});

test("unmounting mid-drag ends the drag and restores the cursor", () => {
  const log = newLog();
  const view = render(<Divider log={log} />);
  press();
  pointer("pointermove", 120);
  view.unmount();
  assert.deepEqual(log.resizing, [true, false]);
  assert.equal(document.body.style.cursor, "");
  pointer("pointermove", 160);
  assert.deepEqual(log.resized, [320]);
});

test("the sidebar divider drags and saves its width, and Enter hides the sidebar and focuses its toggle", async () => {
  const shortcuts = { overrides: undefined, effective: effectiveBindings(undefined), global: [] };
  installBotTestIpc({ "app:renderer-ready": () => null, "shortcut:get": () => shortcuts, "app:setMenuCommands": () => true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["shortcuts"], shortcuts);
  render(
    <QueryClientProvider client={client}>
      <CommandSystemProvider>
        <SplitView storageKey="resize-test" sidebar={<SplitView.SidebarToggle />}>
          <p>Content</p>
        </SplitView>
      </CommandSystemProvider>
    </QueryClientProvider>,
  );
  const sidebarDivider = screen.getByRole("separator", { name: "Resize sidebar" });
  assert.equal(sidebarDivider.getAttribute("aria-valuenow"), "260");
  fireEvent.pointerDown(sidebarDivider, { button: 0, isPrimary: true, pointerId: 1, clientX: 260 });
  pointer("pointermove", 300);
  pointer("pointerup", 300);
  assert.equal(sidebarDivider.getAttribute("aria-valuenow"), "300");
  assert.equal(localStorage.getItem("resize-test.sidebar-width"), "300");

  sidebarDivider.focus();
  fireEvent.keyDown(sidebarDivider, { key: "Enter" });
  assert.equal(localStorage.getItem("resize-test.sidebar-collapsed"), "1");
  assert.equal(sidebarDivider.tabIndex, -1, "the hidden divider leaves the tab order");
  // Focus moves in the next frame. Frames run in the order they were asked for,
  // so once this one runs the toggle has had its turn, with no polling timeout.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  // Compare names: an assertion diff of two DOM elements walks the whole document.
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Show sidebar");
});
