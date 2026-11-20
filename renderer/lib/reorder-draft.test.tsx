import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  arrangeByDraft,
  draftChanged,
  edgeScrollVelocity,
  pickUp,
  pointerDropTarget,
  reorderKeyAction,
  ReorderAnnouncer,
  stepDraft,
  useReorderDraft,
} from "./reorder-draft";

afterEach(cleanup);

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, defaultPrevented: false, ...extra });
const vertical = { orientation: "vertical" as const, rtl: false };

test("a picked-up item moves in its draft, stops at the ends and jumps with Home and End", () => {
  const picked = pickUp(["a", "b", "c", "d"], "b")!;
  assert.equal(pickUp(["a"], "z"), null);
  assert.deepEqual(stepDraft(picked, "previous").order, ["b", "a", "c", "d"]);
  const top = stepDraft(picked, "first");
  assert.deepEqual(top.order, ["b", "a", "c", "d"]);
  assert.equal(stepDraft(top, "previous"), top, "past the first slot nothing changes");
  const bottom = stepDraft(picked, "last");
  assert.deepEqual(bottom.order, ["a", "c", "d", "b"]);
  assert.equal(stepDraft(bottom, "next"), bottom);
  assert.deepEqual(bottom.original, ["a", "b", "c", "d"], "the original order is kept for cancel");
  assert.equal(draftChanged(bottom), true);
  assert.equal(draftChanged(stepDraft(stepDraft(picked, "next"), "previous")), false);
});

test("keys: Space and Enter pick up and drop, arrows follow the orientation and reading direction", () => {
  assert.equal(reorderKeyAction(key(" "), { ...vertical, held: false }), "pick");
  assert.equal(reorderKeyAction(key("ArrowDown"), { ...vertical, held: false }), null, "arrows wait for a pick-up");
  assert.equal(reorderKeyAction(key("Enter"), { ...vertical, held: true }), "drop");
  assert.equal(reorderKeyAction(key("Escape"), { ...vertical, held: true }), "cancel");
  assert.equal(reorderKeyAction(key("Escape", { isComposing: true }), { ...vertical, held: true }), null);
  assert.equal(reorderKeyAction(key("ArrowUp", { altKey: true }), { ...vertical, held: true }), null);
  assert.equal(reorderKeyAction(key("ArrowLeft"), { ...vertical, held: true }), null);
  assert.equal(reorderKeyAction(key("ArrowLeft"), { orientation: "horizontal", rtl: false, held: true }), "previous");
  assert.equal(reorderKeyAction(key("ArrowLeft"), { orientation: "horizontal", rtl: true, held: true }), "next");
  assert.equal(reorderKeyAction(key("End"), { ...vertical, held: true }), "last");
});

test("arrangeByDraft reorders only the draft's members and leaves the rest in place", () => {
  const draft = stepDraft(pickUp(["a", "c"], "c")!, "first");
  assert.deepEqual(arrangeByDraft(["a", "b", "c"], (id) => id, draft), ["c", "b", "a"]);
  assert.deepEqual(arrangeByDraft(["x", "y"], (id) => id, draft), ["x", "y"]);
});

test("pointer targets and edge scrolling", () => {
  const rows = [
    { id: "a", top: 0, bottom: 32 },
    { id: "b", top: 32, bottom: 64 },
  ];
  assert.deepEqual(pointerDropTarget(10, rows), { id: "a", place: "before" });
  assert.deepEqual(pointerDropTarget(50, rows), { id: "b", place: "after" });
  assert.deepEqual(pointerDropTarget(500, rows), { id: "b", place: "after" }, "past the end lands after the last row");
  assert.equal(pointerDropTarget(10, []), null);
  assert.equal(pointerDropTarget(10, rows, "a"), null, "over the dragged row itself it lands nowhere");
  assert.deepEqual(pointerDropTarget(40, rows, "a"), { id: "b", place: "before" });
  assert.equal(edgeScrollVelocity(200, 0, 400), 0);
  assert.equal(edgeScrollVelocity(0, 0, 400), -18);
  assert.equal(edgeScrollVelocity(400, 0, 400), 18);
  assert.ok(edgeScrollVelocity(376, 0, 400) > 0 && edgeScrollVelocity(376, 0, 400) < 18);
});

function List({ commits }: { commits: string[][] }) {
  const [items, setItems] = React.useState(["Alpha", "Beta", "Gamma"]);
  const reorder = useReorderDraft({
    groupOf: () => items,
    label: (id) => id,
    handle: (id) => document.querySelector<HTMLElement>(`[aria-label="Move ${id}"]`),
    onCommit: (order) => {
      commits.push([...order]);
      setItems([...order]);
    },
  });
  return (
    <>
      <ul>
        {arrangeByDraft(items, (id) => id, reorder.draft).map((id) => (
          <li key={id}>
            <button type="button" aria-label={`Move ${id}`} {...reorder.handleProps(id)} />
          </li>
        ))}
      </ul>
      <button type="button">Elsewhere</button>
      <ReorderAnnouncer message={reorder.announcement} />
    </>
  );
}

const order = () => screen.getAllByRole("button", { name: /^Move / }).map((button) => button.getAttribute("aria-label")!.slice(5));

test("a drop commits once, and only when the order changed", () => {
  const commits: string[][] = [];
  render(<List commits={commits} />);
  const alpha = () => screen.getByRole("button", { name: "Move Alpha" });
  act(() => alpha().focus());
  fireEvent.keyDown(alpha(), { key: " " });
  fireEvent.keyDown(alpha(), { key: "Enter" });
  assert.deepEqual(commits, [], "dropping where it was picked up commits nothing");
  assert.equal(screen.getByRole("status").textContent, "Dropped Alpha at position 1 of 3.");

  fireEvent.keyDown(alpha(), { key: " " });
  fireEvent.keyDown(alpha(), { key: "ArrowDown" });
  fireEvent.keyDown(alpha(), { key: "ArrowDown" });
  assert.deepEqual(commits, [], "moves stay in the draft");
  fireEvent.keyDown(alpha(), { key: " " });
  assert.deepEqual(commits, [["Beta", "Gamma", "Alpha"]]);
  assert.deepEqual(order(), ["Beta", "Gamma", "Alpha"]);
  assert.equal(document.activeElement, alpha());
});

test("leaving the handle cancels the draft and restores the order", async () => {
  const commits: string[][] = [];
  render(<List commits={commits} />);
  const gamma = () => screen.getByRole("button", { name: "Move Gamma" });
  act(() => gamma().focus());
  fireEvent.keyDown(gamma(), { key: " " });
  fireEvent.keyDown(gamma(), { key: "ArrowUp" });
  assert.deepEqual(order(), ["Alpha", "Gamma", "Beta"]);
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.deepEqual(order(), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(commits, []);
  assert.equal(screen.getByRole("status").textContent, "Moved Gamma back to position 3 of 3.");
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Elsewhere" }), "focus stays where the person took it");
});
