import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal.js";

const STREAMING = "First paragraph.\n\nSecond paragraph still streaming";

function renderedText(content: string, complete: boolean, reduceMotion: boolean): string {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset: { reduceMotion: String(reduceMotion) } } },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      matchMedia: () => ({ matches: reduceMotion }),
    },
  });
  try {
    return renderToStaticMarkup(
      <StreamingMarkdownReveal content={content} complete={complete} />,
    ).replace(/<[^>]*>/g, "");
  } finally {
    for (const key of ["document", "window"] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("reduced motion shows a streaming reply as written, unfinished prose included", () => {
  const text = renderedText(STREAMING, false, true);
  assert.match(text, /First paragraph\./u);
  assert.match(text, /Second paragraph still streaming/u);
});

test("without reduced motion the unfinished prose waits for the reveal", () => {
  assert.doesNotMatch(renderedText(STREAMING, false, false), /Second paragraph still streaming/u);
});

test("a finished reply shows in full whatever the motion preference", () => {
  for (const reduceMotion of [false, true]) {
    const text = renderedText(STREAMING, true, reduceMotion);
    assert.match(text, /First paragraph\./u);
    assert.match(text, /Second paragraph still streaming/u);
  }
});
