import assert from "node:assert/strict";
import test from "node:test";
import { generativeUiHostLibraryNameFromUrl } from "../../renderer/shared/generative-ui.js";

test("custom protocol only serves the exact host library names", () => {
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js"), "chart.js");
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://katex.css"), "katex.css");
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js.evil"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("https://chart.js"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://../chart.js"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("not a url"), undefined);
});
