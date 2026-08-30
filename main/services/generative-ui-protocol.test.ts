import assert from "node:assert/strict";
import test from "node:test";
import {
  generativeUiHostLibraryNameFromUrl,
  generativeUiPreviewTokenFromUrl,
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
