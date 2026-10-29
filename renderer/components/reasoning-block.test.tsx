import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, render } from "@testing-library/react";
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

test("streaming reasoning begins as an accessible expanded preview", () => {
  const markup = renderToStaticMarkup(
    <ReasoningBlock content="Readable model thought" streaming active />,
  );
  assert.match(markup, /aria-expanded="true"/u);
  assert.match(markup, /aria-controls=/u);
  assert.match(markup, /role="region" aria-label="Model reasoning"/u);
  assert.match(markup, /Readable model thought/u);
  assert.match(markup, />Thinking</u);
  assert.doesNotMatch(markup, /Thinking…/u);
});

test("persisted reasoning stays inspectable but starts collapsed", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="Stored model thought" />);
  assert.match(markup, /aria-expanded="false"/u);
  assert.doesNotMatch(markup, /Stored model thought/u);
  assert.match(markup, />Thinking</u);
});

test("a custom label carries the Visualizing shimmer state", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="" active label="Visualizing" />);
  assert.match(markup, />Visualizing</u);
  assert.doesNotMatch(markup, /Visualizing…/u);
  assert.match(markup, /agent-thinking-shimmer/u);
  assert.doesNotMatch(markup, /Thinking/u);
  const settled = renderToStaticMarkup(
    <ReasoningBlock content="" label="Visualizing" />,
  );
  assert.match(settled, />Visualizing</u);
});

test("the automatic preview is a bounded, keyboard-scrollable viewport", () => {
  const markup = renderToStaticMarkup(
    <ReasoningBlock content="Long streaming thought" streaming active />,
  );
  assert.match(markup, /data-disclosure-layout="preview"/u);
  // The preview region scrolls on its own, so it must be reachable by keyboard.
  assert.match(markup, /role="region" aria-label="Model reasoning" tabindex="0"/u);
  const collapsed = renderToStaticMarkup(<ReasoningBlock content="Stored thought" />);
  assert.match(collapsed, /data-disclosure-layout="collapsed"/u);
  assert.doesNotMatch(collapsed, /role="region"/u);
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
