import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningBlock } from "./reasoning-block.js";

/** A stand-in for the browser's IntersectionObserver that tests drive by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  scroll(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

function header(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Thinking|^Thought/u });
}

test("streaming reasoning stays one closed row as thoughts arrive", () => {
  const view = render(<ReasoningBlock content="Read the diff. Then" streaming active />);
  assert.equal(header().getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("region"), null, "nothing opens on its own");
  view.rerender(
    <ReasoningBlock content={"Read the diff. Then group the hunks by story.\n\nREADME has two"} streaming active />,
  );
  assert.equal(header().getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("region"), null, "more reasoning never opens it either");
});

test("while thinking, the row shows the latest finished sentence and drops it once done", () => {
  const view = render(<ReasoningBlock content="Read the diff. Then group" streaming active />);
  const line = view.container.querySelector('button [aria-hidden="true"]:not(svg)');
  assert.equal(line?.textContent, "Read the diff.");
  assert.equal(line?.classList.contains("opacity-0"), false);

  view.rerender(<ReasoningBlock content="Read the diff. Then group by story. Now" streaming active />);
  assert.equal(line?.textContent, "Then group by story.", "the line rolls in place");

  view.rerender(<ReasoningBlock content="Read the diff. Then group by story. Now" label="Thought briefly" />);
  assert.ok(line?.classList.contains("opacity-0"), "the finished thought's line fades out");
  assert.match(header().textContent ?? "", /^Thought briefly/u);
});

test("stored reasoning shows no live line and keeps its text closed", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="Stored model thought. More " />);
  assert.match(markup, /aria-expanded="false"/u);
  assert.doesNotMatch(markup, /Stored model thought/u);
  assert.match(markup, />Thinking</u);
});

test("the reader opens it to full height and closes it at once under Reduce Motion", () => {
  document.documentElement.dataset.reduceMotion = "true";
  render(<ReasoningBlock content="Readable model thought" streaming active />);
  act(() => header().click());
  assert.equal(header().getAttribute("aria-expanded"), "true");
  const region = screen.getByRole("region", { name: "Model reasoning" });
  assert.match(region.textContent ?? "", /Readable model thought/u);
  assert.equal(header().getAttribute("aria-controls"), region.id);

  act(() => header().click());
  assert.equal(header().getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("region"), null);
});

test("with motion, a close folds the body before it leaves", () => {
  document.documentElement.dataset.reduceMotion = "false";
  const view = render(<ReasoningBlock content="Readable model thought" />);
  act(() => header().click());
  act(() => header().click());
  assert.equal(header().getAttribute("aria-expanded"), "false", "the header reports closed right away");
  const body = view.container.querySelector<HTMLElement>(".reasoning-body");
  assert.equal(body?.dataset.state, "closing", "the body stays mounted while it folds");

  const end = new Event("transitionend", { bubbles: true }) as Event & { propertyName: string };
  Object.defineProperty(end, "propertyName", { value: "grid-template-rows" });
  act(() => {
    fireEvent(body!, end);
  });
  assert.equal(view.container.querySelector(".reasoning-body"), null);
});

test("before any readable text the row is a status with nothing to open", () => {
  const view = render(<ReasoningBlock content="" streaming active />);
  const section = view.container.querySelector("section");
  assert.equal(section?.getAttribute("role"), "status");
  assert.ok(header().disabled);
  // The same element takes the reasoning when it arrives, so nothing remounts.
  view.rerender(<ReasoningBlock content="First thought. " streaming active />);
  assert.equal(view.container.querySelector("section"), section);
  assert.equal(section?.getAttribute("role"), null);
  assert.equal(header().disabled, false);
});

test("a custom label carries the Visualizing shimmer state", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="" active label="Visualizing" />);
  assert.match(markup, />Visualizing</u);
  assert.doesNotMatch(markup, /Visualizing…/u);
  assert.match(markup, /agent-thinking-shimmer/u);
  assert.doesNotMatch(markup, /Thinking/u);
  const settled = renderToStaticMarkup(<ReasoningBlock content="" label="Visualizing" />);
  assert.match(settled, />Visualizing</u);
});

test("a live thinking shimmer pauses while scrolled away or while the window is hidden", () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const { container, rerender } = render(<ReasoningBlock content="" active />);
  const shimmer = container.querySelector(".agent-thinking-shimmer");
  assert.ok(shimmer, "a live block shimmers its label");
  const observers = FakeIntersectionObserver.instances;
  assert.equal(observers.length, 1, "every shimmer shares one observer");
  const [observer] = observers;
  assert.ok(observer!.targets.has(shimmer));

  observer!.scroll(shimmer, false);
  assert.equal(shimmer.hasAttribute("data-offscreen"), true, "scrolled away, it pauses");
  observer!.scroll(shimmer, true);
  assert.equal(shimmer.hasAttribute("data-offscreen"), false, "back in view, it runs again");

  assert.equal(document.documentElement.hasAttribute("data-document-hidden"), false);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(document.documentElement.hasAttribute("data-document-hidden"), true, "a hidden window pauses it");
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(document.documentElement.hasAttribute("data-document-hidden"), false);

  rerender(<ReasoningBlock content="" />);
  assert.equal(container.querySelector(".agent-thinking-shimmer"), null);
  assert.equal(observer!.targets.size, 0, "a settled label is no longer watched");
  cleanup();
});
