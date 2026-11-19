import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { glideIntoView } from "./scroll-into-view";

/** Frames that run only when the test advances time. */
function manualFrames() {
  let queue: { id: number; callback: FrameRequestCallback }[] = [];
  let nextId = 0;
  let now = 1_000;
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    queue.push({ id: ++nextId, callback });
    return nextId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queue = queue.filter((frame) => frame.id !== id);
  };
  return {
    pending: () => queue.length,
    advance(ms: number) {
      now += ms;
      const due = queue;
      queue = [];
      for (const frame of due) frame.callback(now);
    },
    restore() {
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
    },
  };
}

/** A scrollport whose row Chromium would center at `middle`. */
function page(middle: number) {
  const port = document.createElement("div");
  port.style.overflowY = "auto";
  const row = document.createElement("div");
  row.scrollIntoView = () => {
    port.scrollTop = middle;
  };
  port.append(row);
  document.body.append(port);
  return { port, row };
}

let frames: ReturnType<typeof manualFrames> | undefined;
afterEach(() => {
  frames?.restore();
  frames = undefined;
  document.body.replaceChildren();
});

test("glides from where the page is to where the row sits in the middle, then stops", () => {
  frames = manualFrames();
  const { port, row } = page(600);
  port.scrollTop = 100;
  glideIntoView(row, { animate: true });
  assert.equal(port.scrollTop, 100, "nothing moves before the first frame");

  const seen: number[] = [];
  for (let frame = 0; frame < 8 && frames.pending() > 0; frame += 1) {
    frames.advance(60);
    seen.push(port.scrollTop);
  }
  assert.ok(seen.length > 2, "it takes several frames");
  assert.ok(seen.every((offset, index) => index === 0 || offset >= seen[index - 1]!), "it never moves back");
  assert.ok(seen.slice(0, -1).every((offset) => offset > 100 - 1 && offset < 600), "it passes through the offsets in between");
  assert.equal(port.scrollTop, 600);
  assert.equal(frames.pending(), 0);
});

test("stopping it mid-glide leaves the page where something else put it", () => {
  frames = manualFrames();
  const { port, row } = page(600);
  const stop = glideIntoView(row, { animate: true });
  frames.advance(16);
  frames.advance(100);
  assert.ok(port.scrollTop > 0);

  stop();
  port.scrollTop = 0;
  frames.advance(500);
  assert.equal(port.scrollTop, 0);
  assert.equal(frames.pending(), 0);
});

test("a person scrolling mid-glide takes over", () => {
  frames = manualFrames();
  const { port, row } = page(600);
  glideIntoView(row, { animate: true });
  frames.advance(16);
  frames.advance(100);

  port.scrollTop = 42;
  frames.advance(60);
  frames.advance(500);
  assert.equal(port.scrollTop, 42);
  assert.equal(frames.pending(), 0);
});

test("without animation, or with the row already in the middle, it lands at once", () => {
  frames = manualFrames();
  const { port, row } = page(600);
  glideIntoView(row, { animate: false });
  assert.equal(port.scrollTop, 600);
  assert.equal(frames.pending(), 0);

  glideIntoView(row, { animate: true });
  assert.equal(port.scrollTop, 600);
  assert.equal(frames.pending(), 0);
});
