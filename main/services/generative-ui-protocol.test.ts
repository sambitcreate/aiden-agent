import assert from "node:assert/strict";
import test from "node:test";
import {
  generativeUiHostLibraryNameFromUrl,
  generativeUiPreviewTokenFromUrl,
  shouldBlockGenerativeUiGuestNavigation,
} from "../../renderer/shared/generative-ui.js";

test("custom protocol only serves the exact host library names", () => {
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js"), "chart.js");
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://katex.css"), "katex.css");
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js.evil"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("https://chart.js"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://../chart.js"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js/extra"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js?x=1"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("not a url"), undefined);
});

test("preview URLs reject extra path, query, and fragment", () => {
  const token = "b".repeat(64);
  assert.equal(generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}`), token);
  assert.equal(generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}/x`), undefined);
  assert.equal(generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}?q=1`), undefined);
});

test("a live Generative UI guest cannot navigate its own frame away from containment", () => {
  const preview = `aiden-genui://preview/${"a".repeat(64)}`;
  const refreshedPreview = `aiden-genui://preview/${"b".repeat(64)}`;
  assert.equal(
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: false,
      frameUrl: preview,
      initiatorUrl: preview,
      targetUrl: refreshedPreview,
    }),
    true,
  );
  assert.equal(
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: false,
      frameUrl: preview,
      initiatorUrl: preview,
      targetUrl: "https://example.com/",
    }),
    true,
  );
  assert.equal(
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: false,
      frameUrl: preview,
      initiatorUrl: "file:///Applications/Aiden/renderer.html",
      targetUrl: refreshedPreview,
    }),
    false,
  );
  assert.equal(
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: false,
      frameUrl: preview,
      initiatorUrl: "file:///Applications/Aiden/renderer.html",
      targetUrl: "https://example.com/",
    }),
    true,
  );
  assert.equal(
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: true,
      frameUrl: preview,
      initiatorUrl: preview,
      targetUrl: "https://example.com/",
    }),
    false,
  );
});

test("source previews stay on their exact live proxy origin", () => {
  const sourcePreviewFrames = [
    { origin: "http://127.0.0.1:4100", active: true },
    { origin: "http://127.0.0.1:4200", active: true },
    { origin: "http://127.0.0.1:4300", active: false },
  ];
  const navigation = (overrides: Partial<Parameters<typeof shouldBlockGenerativeUiGuestNavigation>[0]>) =>
    shouldBlockGenerativeUiGuestNavigation({
      isMainFrame: false,
      frameUrl: "http://127.0.0.1:4100/current",
      initiatorUrl: "http://127.0.0.1:4100/current",
      targetUrl: "http://127.0.0.1:4100/next?route=one",
      sourcePreviewFrames,
      ...overrides,
    });

  assert.equal(navigation({}), false, "same-proxy app routing stays available");
  assert.equal(
    navigation({ targetUrl: "http://127.0.0.1:4200/" }),
    true,
    "a guest cannot jump to another active local preview",
  );
  assert.equal(
    navigation({ targetUrl: "http://127.0.0.1:9999/" }),
    true,
    "a guest cannot probe another loopback service",
  );
  assert.equal(navigation({ targetUrl: "https://example.com/" }), true);
  assert.equal(
    navigation({
      initiatorUrl: "http://localhost:5173/main-window.html",
      targetUrl: "http://127.0.0.1:4200/",
      trustedRendererInitiator: true,
    }),
    false,
    "the trusted renderer can replace a frame with another active preview",
  );
  assert.equal(
    navigation({
      frameUrl: "http://127.0.0.1:4300/",
      initiatorUrl: undefined,
      targetUrl: "http://127.0.0.1:4300/",
    }),
    true,
    "a stopped preview fails closed",
  );
  assert.equal(
    navigation({
      frameUrl: "http://127.0.0.1:9999/",
      initiatorUrl: "http://127.0.0.1:9999/",
      targetUrl: "http://127.0.0.1:9998/",
    }),
    false,
    "unrelated loopback frames keep their existing policy",
  );
});
