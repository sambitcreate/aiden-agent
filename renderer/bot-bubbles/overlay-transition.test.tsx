import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  BotBubbleTransitionView,
  SHRINK_HEAD_WAIT_MS,
  type OverlayTransition,
} from "./overlay-app";

/** One animation the view started, as the test's stand-in for Web Animations recorded it. */
interface Played {
  keyframes: Keyframe[];
  finish(): void;
}

let played: Played[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

beforeEach(() => {
  played = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(keyframes: Keyframe[]) {
      const animation = {
        onfinish: null as (() => void) | null,
        oncancel: null as (() => void) | null,
        cancel() {},
      };
      played.push({ keyframes, finish: () => animation.onfinish?.() });
      return animation;
    },
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const RECT = { x: 100, y: 80, width: 600, height: 500 };
const HEAD = { x: 934, y: 374 };
const shrink = (overrides: Partial<OverlayTransition> = {}): OverlayTransition => ({
  botId: "bot-1",
  kind: "shrink",
  rect: RECT,
  image: "data:image/png;base64,AAAA",
  key: 1,
  head: null,
  ...overrides,
});

const lastFrame = (animation: Played) => animation.keyframes[animation.keyframes.length - 1]!;
const picture = () => document.querySelector<HTMLElement>("[data-bubble-transition]");

test("a shrink shows the chat's picture still, says so, and moves only when its head is there", async () => {
  const events: string[] = [];
  const view = (head: typeof HEAD | null) => (
    <BotBubbleTransitionView
      transition={shrink({ cover: 4 })}
      head={head}
      onShown={() => events.push("shown")}
      onDone={() => events.push("done")}
    />
  );
  const rendered = render(view(null));
  await waitFor(() => assert.deepEqual(events, ["shown"]));
  assert.ok(picture()?.querySelector("img"), "the picture covers the chat");
  assert.notEqual(picture()?.style.visibility, "hidden");
  assert.equal(played.length, 0, "nothing moves before the head exists");

  rendered.rerender(view(HEAD));
  assert.equal(played.length, 1);
  assert.equal(played[0]!.keyframes[0]!.opacity, 1, "it starts as the full picture");
  assert.equal(lastFrame(played[0]!).opacity, 0, "and ends gone, on the head");

  // The head shifting as others restack never restarts it.
  rendered.rerender(view({ x: 934, y: 300 }));
  assert.equal(played.length, 1);

  act(() => played[0]!.finish());
  assert.deepEqual(events, ["shown", "done"]);
});

test("a shrink whose head never comes fades out instead of staying over the chat", async () => {
  let done = 0;
  render(<BotBubbleTransitionView transition={shrink()} head={null} onDone={() => (done += 1)} />);
  await waitFor(() => assert.equal(played.length, 1), { timeout: SHRINK_HEAD_WAIT_MS + 1_500 });
  assert.ok(
    played[0]!.keyframes.every((frame) => frame.transform === undefined),
    "a fade in place: nowhere to fly to",
  );
  act(() => played[0]!.finish());
  assert.equal(done, 1);
});

test("with Reduce Motion a shrink is a fade in place once the head is there", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  render(<BotBubbleTransitionView transition={shrink()} head={HEAD} onDone={() => undefined} />);
  await waitFor(() => assert.equal(played.length, 1));
  assert.ok(played[0]!.keyframes.every((frame) => frame.transform === undefined));
  assert.equal(lastFrame(played[0]!).opacity, 0);
});

test("a grow leaves from its head; with Reduce Motion or no head it draws nothing and ends at once", async () => {
  const grow = (head: typeof HEAD | null): OverlayTransition => ({
    botId: "bot-1",
    kind: "grow",
    rect: RECT,
    image: null,
    key: 2,
    head,
  });
  let done = 0;
  const first = render(
    <BotBubbleTransitionView transition={grow(HEAD)} head={HEAD} onDone={() => (done += 1)} />,
  );
  await waitFor(() => assert.equal(played.length, 1));
  assert.ok(picture() !== null);
  assert.equal(done, 0);
  first.unmount();

  played = [];
  render(
    <BotBubbleTransitionView transition={grow(null)} head={null} onDone={() => (done += 1)} />,
  );
  await waitFor(() => assert.equal(done, 1));
  assert.ok(picture() === null, "no window-sized sheet flashes");

  cleanup();
  document.documentElement.dataset.reduceMotion = "true";
  render(
    <BotBubbleTransitionView transition={grow(HEAD)} head={HEAD} onDone={() => (done += 1)} />,
  );
  await waitFor(() => assert.equal(done, 2));
  assert.ok(picture() === null);
  assert.equal(played.length, 0);
});
