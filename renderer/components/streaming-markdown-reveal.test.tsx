import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal.js";

const STREAMING = "First paragraph.\n\nSecond paragraph still streaming";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

function renderReveal(content: string, complete: boolean, reduceMotion: boolean) {
  document.documentElement.dataset.reduceMotion = String(reduceMotion);
  const { container } = render(<StreamingMarkdownReveal content={content} complete={complete} />);
  const surface = container.querySelector(".streaming-reveal");
  assert.ok(surface, "the reveal surface renders");
  return surface;
}

test("reduced motion shows a streaming reply as written, unfinished prose included", () => {
  const text = renderReveal(STREAMING, false, true).textContent ?? "";
  assert.match(text, /First paragraph\./u);
  assert.match(text, /Second paragraph still streaming/u);
});

test("without reduced motion a finished paragraph shows while the unfinished one waits", () => {
  const text = renderReveal(STREAMING, false, false).textContent ?? "";
  assert.match(text, /First paragraph\./u);
  assert.doesNotMatch(text, /Second paragraph still streaming/u);
});

test("a finished reply shows in full whatever the motion preference", () => {
  for (const reduceMotion of [false, true]) {
    const text = renderReveal(STREAMING, true, reduceMotion).textContent ?? "";
    assert.match(text, /First paragraph\./u);
    assert.match(text, /Second paragraph still streaming/u);
    cleanup();
  }
});

test("only a reply that is still streaming fades its blocks in", () => {
  assert.equal(renderReveal(STREAMING, false, false).hasAttribute("data-streaming"), true);
  cleanup();
  assert.equal(
    renderReveal(STREAMING, true, false).hasAttribute("data-streaming"),
    false,
    "a reply that mounts finished shows at once instead of fading in under the handoff",
  );
});
