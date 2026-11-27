// The live viewport readout and breakpoint ticks of a live app frame's resize
// (design mode v2 Phase 3c, S91).

// Installs happy-dom; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { AppViewportRuler } from "./app-viewport-ruler";

afterEach(cleanup);

const ticks = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-breakpoint]")).map((tick) => ({
    width: Number(tick.dataset.breakpoint),
    left: tick.style.left,
    right: tick.style.right,
    label: tick.textContent,
  }));

test("the readout shows width × height", () => {
  const { container } = render(
    <AppViewportRuler side="right" viewport={{ width: 1180, height: 800 }} scale={0.5} zoom={1} breakpoints={[]} />,
  );
  assert.equal(container.textContent, "1180 × 800");
});

test("ticks sit at breakpoint × scale × zoom from the fixed edge", () => {
  const view = render(
    <AppViewportRuler side="right" viewport={{ width: 1280, height: 800 }} scale={0.5} zoom={1} breakpoints={[640, 768, 1024]} />,
  );
  assert.deepEqual(
    ticks().map(({ width, left, right }) => ({ width, left, right })),
    [
      { width: 640, left: "320px", right: "" },
      { width: 768, left: "384px", right: "" },
      { width: 1024, left: "512px", right: "" },
    ],
  );
  view.rerender(<AppViewportRuler side="right" viewport={{ width: 1280, height: 800 }} scale={0.5} zoom={0.5} breakpoints={[640, 768, 1024]} />);
  assert.deepEqual(
    ticks().map(({ left }) => left),
    ["160px", "192px", "256px"],
  );
  // A left drag keeps the right edge, so it measures from there.
  view.rerender(<AppViewportRuler side="left" viewport={{ width: 1280, height: 800 }} scale={0.5} zoom={1} breakpoints={[640, 768, 1024]} />);
  assert.deepEqual(
    ticks().map(({ left, right }) => ({ left, right })),
    [
      { left: "", right: "320px" },
      { left: "", right: "384px" },
      { left: "", right: "512px" },
    ],
  );
});

test("a label too close to the previous one is hidden", () => {
  render(<AppViewportRuler side="right" viewport={{ width: 1280, height: 800 }} scale={0.5} zoom={1} breakpoints={[640, 660, 768, 800]} />);
  // 320 px, then 330 (10 from 320: hidden), 384 (64 from 320: shown), 400 (16 from 384: hidden).
  assert.deepEqual(
    ticks().map(({ width, label }) => [width, label]),
    [
      [640, "640"],
      [660, ""],
      [768, "768"],
      [800, ""],
    ],
  );
});

test("a height drag or a corner shows the readout and no ticks", () => {
  for (const side of ["top", "bottom", "corner"] as const) {
    const { container, unmount } = render(
      <AppViewportRuler side={side} viewport={{ width: 1280, height: 640 }} scale={0.5} zoom={1} breakpoints={[640, 768]} />,
    );
    assert.equal(container.textContent, "1280 × 640", side);
    assert.equal(ticks().length, 0, side);
    unmount();
  }
});
