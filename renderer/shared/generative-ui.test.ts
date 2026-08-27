import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATIVE_UI_UNSUPPORTED_DEVICE_COPY,
  generativeUiHostLibraryNameFromUrl,
  generativeUiPreviewTokenFromUrl,
  isHtmlArtifactMediaId,
  isHtmlArtifactTitle,
} from "./generative-ui.js";

test("HTML artifact titles reject controls, padding, and empty values", () => {
  assert.equal(isHtmlArtifactTitle("Dependencies"), true);
  assert.equal(isHtmlArtifactTitle(""), false);
  assert.equal(isHtmlArtifactTitle(" leading"), false);
  assert.equal(isHtmlArtifactTitle("trailing "), false);
  assert.equal(isHtmlArtifactTitle("bad\ntitle"), false);
  assert.equal(isHtmlArtifactTitle("a".repeat(121)), false);
  assert.equal(isHtmlArtifactTitle("a".repeat(120)), true);
});

test("HTML artifact media ids are opaque identities, not paths", () => {
  assert.equal(isHtmlArtifactMediaId("chat-1:gen-1:call-1"), true);
  assert.equal(isHtmlArtifactMediaId("../etc/passwd"), false);
  assert.equal(isHtmlArtifactMediaId("media id"), false);
  assert.equal(isHtmlArtifactMediaId(""), false);
});

test("mobile fallback copy is fixed host-owned text", () => {
  assert.equal(
    GENERATIVE_UI_UNSUPPORTED_DEVICE_COPY,
    "Can't view on this device. View in Aiden Agent.",
  );
});

test("aiden-genui URLs only resolve exact host library names", () => {
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js"), "chart.js");
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://../chart.js"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js/extra"), undefined);
  assert.equal(generativeUiHostLibraryNameFromUrl("aiden-genui://chart.js?x=1"), undefined);
});

test("preview documents require an exact 64-hex token path", () => {
  const token = "a".repeat(64);
  assert.equal(
    generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}`),
    token,
  );
  assert.equal(
    generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token.toUpperCase()}`),
    token,
  );
  assert.equal(
    generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}/extra`),
    undefined,
  );
  assert.equal(
    generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}?steal=1`),
    undefined,
  );
  assert.equal(
    generativeUiPreviewTokenFromUrl(`aiden-genui://preview/${token}#frag`),
    undefined,
  );
  assert.equal(generativeUiPreviewTokenFromUrl("aiden-genui://preview/not-hex"), undefined);
  assert.equal(generativeUiPreviewTokenFromUrl("aiden-genui://chart.js"), undefined);
});
