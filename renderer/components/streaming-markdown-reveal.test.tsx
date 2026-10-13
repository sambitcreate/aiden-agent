import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal.js";

test("with reduced motion, shows trailing unpunctuated prose", () => {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };

  try {
    // Mock reduced motion enabled
    const mockDocument = { documentElement: { dataset: { reduceMotion: "true" } } };
    const mockWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      matchMedia: () => ({ matches: true }),
    };

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: mockDocument,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: mockWindow,
    });

    const markup = renderToStaticMarkup(
      <StreamingMarkdownReveal
        content="First paragraph.\n\nSecond paragraph still streaming"
        complete={false}
      />,
    );
    const text = markup.replace(/<[^>]*>/g, "");

    // The trailing unpunctuated prose should be visible
    assert.match(text, /Second paragraph still streaming/u);
  } finally {
    if (saved.document) {
      Object.defineProperty(globalThis, "document", saved.document);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (saved.window) {
      Object.defineProperty(globalThis, "window", saved.window);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("reduced motion shows content that would otherwise be withheld", () => {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };

  try {
    // Without reduced motion, unfinished prose is withheld
    {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { documentElement: { dataset: { reduceMotion: "false" } } },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          matchMedia: () => ({ matches: false }),
        },
      });

      const markupNormal = renderToStaticMarkup(
        <StreamingMarkdownReveal
          content="First paragraph.\n\nUnfinished prose"
          complete={false}
        />,
      );
      const textNormal = markupNormal.replace(/<[^>]*>/g, "");
      // Without reduced motion and before gate advances, shows nothing
      assert.equal(textNormal, "");
    }

    // With reduced motion, everything is shown immediately
    {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { documentElement: { dataset: { reduceMotion: "true" } } },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          matchMedia: () => ({ matches: true }),
        },
      });

      const markupReduced = renderToStaticMarkup(
        <StreamingMarkdownReveal
          content="First paragraph.\n\nUnfinished prose"
          complete={false}
        />,
      );
      const textReduced = markupReduced.replace(/<[^>]*>/g, "");
      // With reduced motion, all content including unfinished prose is shown
      assert.match(textReduced, /First paragraph/u);
      assert.match(textReduced, /Unfinished prose/u);
    }
  } finally {
    if (saved.document) {
      Object.defineProperty(globalThis, "document", saved.document);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (saved.window) {
      Object.defineProperty(globalThis, "window", saved.window);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("when complete, shows all content regardless of motion preference", () => {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };

  try {
    const mockDocument = { documentElement: { dataset: { reduceMotion: "false" } } };
    const mockWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      matchMedia: () => ({ matches: false }),
    };

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: mockDocument,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: mockWindow,
    });

    const markup = renderToStaticMarkup(
      <StreamingMarkdownReveal
        content="First paragraph.\n\nSecond paragraph complete"
        complete={true}
      />,
    );
    const text = markup.replace(/<[^>]*>/g, "");

    // Everything should be visible when complete
    assert.match(text, /First paragraph/u);
    assert.match(text, /Second paragraph complete/u);
  } finally {
    if (saved.document) {
      Object.defineProperty(globalThis, "document", saved.document);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (saved.window) {
      Object.defineProperty(globalThis, "window", saved.window);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
