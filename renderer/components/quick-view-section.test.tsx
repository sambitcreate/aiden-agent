import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuickViewSectionId } from "../lib/quick-view-layout";
import { QuickViewSection } from "./quick-view-section";

afterEach(cleanup);

function Harness({
  sidebar = false,
  index = 1,
  onMove = () => {},
  onDragPreview,
  measureSiblings = () => [],
}: {
  sidebar?: boolean;
  index?: number;
  onMove?: (id: string, to: number) => void;
  onDragPreview?: (id: QuickViewSectionId, to: number | null) => void;
  measureSiblings?: () => DOMRect[];
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <QuickViewSection
      id="changes"
      title="Changes"
      summary={<span>+12 −3</span>}
      summaryLabel="12 additions, 3 deletions"
      headerAction={sidebar ? { kind: "sidebar", label: "Open Changes in sidebar", onSelect: () => onMove("sidebar", -1) } : undefined}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
      index={index}
      count={3}
      onMove={onMove as never}
      onDragPreview={onDragPreview}
      measureSiblings={measureSiblings}
    >
      <button type="button">Compare branch</button>
    </QuickViewSection>
  );
}

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

test("collapsing hides the rows from the accessibility tree and reports the state", () => {
  render(<Harness />);
  const header = screen.getByRole("button", { name: /^Changes/ });
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByRole("button", { name: "Compare branch" }));
  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("button", { name: "Compare branch" }), null);
  const body = document.getElementById(header.getAttribute("aria-controls") ?? "");
  assert.ok(body?.hasAttribute("inert"), "a collapsed body is inert so its rows cannot take focus");
  const summary = document.getElementById(header.getAttribute("aria-describedby") ?? "");
  assert.equal(summary?.textContent, "12 additions, 3 deletions", "the collapsed header describes its summary in words");
  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByRole("button", { name: "Compare branch" }));
});

test("the Open in sidebar button opens the tool without collapsing the card", () => {
  const calls: unknown[] = [];
  render(<Harness sidebar onMove={(id, to) => calls.push([id, to])} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Changes in sidebar" }));
  assert.deepEqual(calls, [["sidebar", -1]]);
  assert.equal(screen.getByRole("button", { name: /^Changes/ }).getAttribute("aria-expanded"), "true");
});

test("the grip moves the section with arrow keys and stops at the ends", () => {
  const moves: unknown[] = [];
  const { rerender } = render(<Harness index={1} onMove={(id, to) => moves.push([id, to])} />);
  const grip = screen.getByRole("button", { name: "Move Changes" });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  rerender(<Harness index={0} onMove={(id, to) => moves.push([id, to])} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Changes" }), { key: "ArrowUp" });
  assert.deepEqual(moves, [["changes", 0], ["changes", 2]]);
  assert.match(screen.getByRole("status").textContent ?? "", /Changes moved to position 3 of 3/);
});

test("dragging the grip past the next card's midpoint drops it there and clears the preview", () => {
  const moves: unknown[] = [];
  const previews: unknown[] = [];
  // Three visible cards; Changes is the short one in the middle.
  const rects = [rect(0, 200), rect(208, 40), rect(256, 120)];
  render(
    <Harness
      index={1}
      onMove={(id, to) => moves.push([id, to])}
      onDragPreview={(id, to) => previews.push([id, to])}
      measureSiblings={() => rects}
    />,
  );
  const grip = screen.getByRole("button", { name: "Move Changes" });
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 220 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 222 });
  assert.deepEqual(previews, [], "moves under the 4px threshold do not start a drag");
  // Leading (bottom) edge 248 + 80 = 328 passes the last card's midpoint (316).
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 300 });
  const card = grip.closest("[data-quick-view-section]");
  assert.ok(card?.hasAttribute("data-dragging"));
  fireEvent.pointerUp(grip, { pointerId: 1, clientY: 300 });
  assert.deepEqual(moves, [["changes", 2]]);
  assert.deepEqual(previews, [["changes", 2], ["changes", null]]);
  assert.equal(card?.hasAttribute("data-dragging"), false);
});

test("a drag that returns to its own slot or is cancelled does not move the section", () => {
  const moves: unknown[] = [];
  const previews: unknown[] = [];
  const rects = [rect(0, 200), rect(208, 40), rect(256, 120)];
  render(
    <Harness
      index={1}
      onMove={(id, to) => moves.push([id, to])}
      onDragPreview={(id, to) => previews.push([id, to])}
      measureSiblings={() => rects}
    />,
  );
  const grip = screen.getByRole("button", { name: "Move Changes" });
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 220 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 100 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 230 });
  fireEvent.pointerUp(grip, { pointerId: 1, clientY: 230 });
  fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientY: 220 });
  fireEvent.pointerMove(grip, { pointerId: 2, clientY: 100 });
  fireEvent.pointerCancel(grip, { pointerId: 2 });
  assert.deepEqual(moves, []);
  assert.deepEqual(previews, [["changes", 0], ["changes", 1], ["changes", null], ["changes", 0], ["changes", null]]);
});
