import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScrollArea } from "./ui";

afterEach(() => cleanup());

const CLIENT_HEIGHT = 400;

/**
 * Gives the transcript scrollport real-looking geometry: a content height the
 * test grows chunk by chunk, and a scroll offset that clamps like a browser's.
 * `scrollTo` with smooth behaviour is recorded but does not move; the test
 * decides where the animation lands.
 */
function scrollport(viewport = document.querySelector<HTMLElement>("[data-scroll-top]")) {
  assert.ok(viewport, "the transcript scrolls in its own scrollport");
  let height = 2_000;
  let top = height - CLIENT_HEIGHT;
  const clamp = (value: number) => Math.max(0, Math.min(value, height - CLIENT_HEIGHT));
  const smoothTargets: number[] = [];
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = clamp(value);
    },
  });
  viewport.scrollTo = ((options: ScrollToOptions) => {
    if (options.behavior === "smooth") smoothTargets.push(options.top ?? top);
    else top = clamp(options.top ?? top);
  }) as typeof viewport.scrollTo;
  return {
    viewport,
    smoothTargets,
    top: () => top,
    bottom: () => height - CLIENT_HEIGHT,
    grow: (by: number) => {
      height += by;
    },
    /** The engine moves the viewport (user scroll or a landing animation). */
    moveTo: (value: number) => {
      top = clamp(value);
      fireEvent.scroll(viewport);
    },
    following: () => viewport.dataset.follow === "true",
  };
}

function Transcript({ chunks, streaming = true }: { chunks: number; streaming?: boolean }) {
  return (
    <ScrollArea autoScrollToBottom autoScrollDeps={[chunks]} showScrollToBottomButton streaming={streaming}>
      {Array.from({ length: chunks }, (_, index) => (
        <p key={index}>chunk {index}</p>
      ))}
    </ScrollArea>
  );
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * A wheel event stamped with an explicit gesture time, so momentum windows are
 * decided by the timeline the test describes rather than by real waits.
 */
function wheel(target: Element, { deltaY, deltaX = 0, at }: { deltaY: number; deltaX?: number; at: number }) {
  const { WheelEvent: DomWheelEvent } = window as unknown as typeof globalThis;
  const event = new DomWheelEvent("wheel", { deltaY, deltaX, bubbles: true, cancelable: true });
  Object.defineProperty(event, "timeStamp", { value: at });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

test("a streaming reply keeps the transcript on its last line, before the next paint", () => {
  const view = render(<Transcript chunks={1} />);
  const port = scrollport();
  for (let chunk = 2; chunk <= 50; chunk += 1) {
    // Lists and tables grow by whole rows; plain text by a line.
    port.grow(chunk % 7 === 0 ? 180 : 22);
    view.rerender(<Transcript chunks={chunk} />);
    // No frame has run yet: the settle happens in the layout pass itself.
    assert.equal(port.top(), port.bottom(), `pinned after chunk ${chunk}`);
  }
  assert.equal(port.following(), true);
});

test("a wheel-up keeps the reader's place while the reply grows, and the jump lands at the true bottom", async () => {
  const view = render(<Transcript chunks={1} />);
  const port = scrollport();
  fireEvent.wheel(port.viewport, { deltaY: -120 });
  port.moveTo(300);
  assert.equal(port.following(), false);

  for (let chunk = 2; chunk <= 20; chunk += 1) {
    port.grow(40);
    view.rerender(<Transcript chunks={chunk} />);
  }
  await wait(50);
  assert.equal(port.top(), 300, "growth never pulls the reader back down");

  const jump = await screen.findByRole("button", { name: "Scroll to bottom" });
  fireEvent.click(jump);
  assert.equal(port.top(), port.bottom(), "while streaming the jump snaps to the true bottom");
  assert.equal(port.following(), true);

  port.grow(60);
  view.rerender(<Transcript chunks={21} />);
  assert.equal(port.top(), port.bottom(), "and the next chunk stays pinned");
  await wait(0);
  assert.equal(screen.queryByRole("button", { name: "Scroll to bottom" }), null);
});

test("a smooth jump that lands short of content added mid-animation is corrected", async () => {
  const view = render(<Transcript chunks={1} streaming={false} />);
  const port = scrollport();
  fireEvent.wheel(port.viewport, { deltaY: -120 });
  port.moveTo(200);

  fireEvent.click(await screen.findByRole("button", { name: "Scroll to bottom" }));
  assert.equal(port.smoothTargets.length, 1, "an idle jump animates");
  const bottomWhenClicked = port.bottom();

  // Content arrives while the animation runs; the jump does not fight it, and
  // the animation ends where the bottom used to be.
  port.grow(300);
  view.rerender(<Transcript chunks={2} streaming={false} />);
  port.moveTo(bottomWhenClicked);
  assert.ok(port.top() < port.bottom());
  fireEvent(port.viewport, new Event("scrollend"));

  assert.equal(port.top(), port.bottom());
  assert.equal(port.following(), true);
});

test("wheel momentum from before a jump neither breaks follow nor drags the view", async () => {
  render(<Transcript chunks={1} />);
  const port = scrollport();
  wheel(port.viewport, { deltaY: -120, at: 1_000 });
  port.moveTo(300);
  // The trackpad keeps coasting while the reader reaches for the jump button.
  for (let tick = 1; tick <= 5; tick += 1) wheel(port.viewport, { deltaY: -20, at: 1_000 + tick * 40 });
  fireEvent.click(await screen.findByRole("button", { name: "Scroll to bottom" }));
  assert.equal(port.top(), port.bottom());

  const coasting = wheel(port.viewport, { deltaY: -10, at: 1_240 });
  assert.equal(coasting.defaultPrevented, true, "a coasting tick is swallowed");
  assert.equal(port.following(), true);

  // A fresh gesture after the wheel goes quiet is the reader's intent again.
  wheel(port.viewport, { deltaY: -120, at: 1_600 });
  assert.equal(port.following(), false);
});

test("a sideways pan over a wide table or code block leaves follow alone", () => {
  render(<Transcript chunks={1} />);
  const port = scrollport();
  wheel(port.viewport, { deltaY: -6, deltaX: -140, at: 1_000 });
  assert.equal(port.following(), true);
  wheel(port.viewport, { deltaY: -120, deltaX: -20, at: 2_000 });
  assert.equal(port.following(), false, "a mostly vertical gesture still reads back");
});

test("a scrollbar press keeps follow until the thumb is dragged away, and re-arms on release near the end", () => {
  const view = render(<Transcript chunks={1} />);
  const port = scrollport();
  fireEvent.pointerDown(port.viewport);
  fireEvent.pointerUp(window);
  assert.equal(port.following(), true, "a click on the scrollbar is not a reason to stop following");
  assert.equal(port.viewport.style.overflowAnchor, "none", "following owns the bottom edge");

  fireEvent.pointerDown(port.viewport);
  port.moveTo(port.bottom() - 500);
  assert.equal(port.following(), false);
  assert.equal(port.viewport.style.overflowAnchor, "", "a reader away from the end keeps scroll anchoring");
  port.grow(80);
  view.rerender(<Transcript chunks={2} />);
  assert.equal(port.top(), port.bottom() - 580, "growth does not pull the held thumb down");

  port.moveTo(port.bottom() - 10);
  assert.equal(port.following(), false, "still held: no re-arm yet");
  fireEvent.pointerUp(window);
  assert.equal(port.following(), true, "let go near the end");
});

test("focus moving to an earlier message is not snapped back to the bottom", () => {
  const view = render(<Transcript chunks={1} />);
  const port = scrollport();
  port.grow(40);
  view.rerender(<Transcript chunks={2} />);
  assert.equal(port.top(), port.bottom());
  // No wheel or key: the engine scrolls a focused earlier button into view.
  port.moveTo(200);
  assert.equal(port.following(), false);
  port.grow(120);
  view.rerender(<Transcript chunks={3} />);
  assert.equal(port.top(), 200, "the focused message stays in view");
});

test("a reading key on the page body only stops following in the pane pressed last", () => {
  render(
    <>
      <ScrollArea autoScrollToBottom>
        <p>Left pane</p>
      </ScrollArea>
      <ScrollArea autoScrollToBottom>
        <p>Right pane</p>
      </ScrollArea>
    </>,
  );
  const [left, right] = [...document.querySelectorAll<HTMLElement>("[data-scroll-top]")];
  const leftPort = scrollport(left);
  const rightPort = scrollport(right);
  fireEvent.pointerDown(screen.getByText("Right pane"));
  fireEvent.pointerUp(window);
  fireEvent.keyDown(document.body, { key: "PageUp" });
  assert.equal(rightPort.following(), false);
  assert.equal(leftPort.following(), true);
});

test("scrolling inside a code block that can still scroll up leaves follow alone", () => {
  render(
    <ScrollArea autoScrollToBottom>
      <pre data-testid="code" style={{ overflowY: "auto" }}>
        long code
      </pre>
    </ScrollArea>,
  );
  const port = scrollport();
  const code = screen.getByTestId("code");
  Object.defineProperty(code, "scrollHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(code, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(code, "scrollTop", { configurable: true, get: () => 120, set: () => {} });

  fireEvent.wheel(code, { deltaY: -120 });
  assert.equal(port.following(), true, "the code block consumed that wheel");

  Object.defineProperty(code, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
  fireEvent.wheel(code, { deltaY: -120 });
  assert.equal(port.following(), false, "once the code block is at its top, the transcript scrolls");
});

test("reading keys break follow; typing in a field does not", () => {
  render(
    <ScrollArea autoScrollToBottom footer={<textarea aria-label="Message" />}>
      <button type="button">Copy</button>
    </ScrollArea>,
  );
  const port = scrollport();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "PageUp" });
  assert.equal(port.following(), true);

  fireEvent.keyDown(screen.getByRole("button", { name: "Copy" }), { key: "End" });
  assert.equal(port.following(), true, "a key toward the end is not a reason to stop following");

  fireEvent.keyDown(screen.getByRole("button", { name: "Copy" }), { key: "PageUp" });
  assert.equal(port.following(), false);
});

test("follow re-arms only when the reader comes back down near the end", () => {
  render(<Transcript chunks={1} />);
  const port = scrollport();
  fireEvent.wheel(port.viewport, { deltaY: -120 });
  port.moveTo(port.bottom() - 30);
  assert.equal(port.following(), false, "a small nudge up still counts as reading back");

  port.moveTo(port.bottom() - 200);
  port.moveTo(port.bottom() - 100);
  assert.equal(port.following(), false, "coming back down but not near the end");

  port.moveTo(port.bottom() - 20);
  assert.equal(port.following(), true, "within 40px of the end, heading down");
});

test("the transcript reserves room for the overlaid toolbar, composer, and floating chrome", () => {
  // Toolbar and footer float over the scrollport, so its padding must clear
  // their measured height, plus any chrome floating above the composer.
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const height = Number((this.firstElementChild as HTMLElement | null)?.dataset.height ?? 0);
    return { ...original.call(this), height } as DOMRect;
  };
  try {
    render(
      <ScrollArea
        autoScrollToBottom
        scrollContentBottomOffset={56}
        toolbar={<header data-height="52">Chat title</header>}
        footer={<div data-height="120">Composer</div>}
      >
        <p>Last transcript row</p>
      </ScrollArea>,
    );
    const viewport = document.querySelector<HTMLElement>("[data-scroll-top]");
    assert.ok(viewport);
    assert.equal(viewport.style.paddingTop, "52px");
    assert.equal(viewport.style.paddingBottom, "176px");
    assert.equal(viewport.contains(screen.getByText("Composer")), false, "the composer is not scrolled away");
    assert.equal(viewport.contains(screen.getByText("Chat title")), false);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});
