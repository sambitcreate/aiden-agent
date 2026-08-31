import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  GENERATIVE_UI_VENDOR_SOURCES,
  REACT_GRAB_PRIMITIVES_ENTRY,
  REACT_GRAB_PRIMITIVES_FILENAME,
  inlineKatexFonts,
  vendorDestinationDirectory,
  vendorSourcePath,
} from "./vendor-generative-ui-libs.mjs";

test("vendor sources stay inside node_modules and write into resources/generative-ui", () => {
  const root = "/repo";
  assert.equal(
    vendorSourcePath(root, GENERATIVE_UI_VENDOR_SOURCES["chart.umd.min.js"]),
    path.join(root, "node_modules", "chart.js", "dist", "chart.umd.min.js"),
  );
  assert.equal(vendorDestinationDirectory(root), path.join(root, "resources", "generative-ui"));
  for (const segments of Object.values(GENERATIVE_UI_VENDOR_SOURCES)) {
    const source = vendorSourcePath(root, segments);
    assert.ok(source.startsWith(path.join(root, "node_modules") + path.sep));
    assert.equal(path.extname(source) === ".js" || path.extname(source) === ".css", true);
  }
});

test("React Grab vendor entry exposes only the selection primitives used by Design", () => {
  assert.equal(REACT_GRAB_PRIMITIVES_FILENAME, "react-grab-primitives.js");
  for (const primitive of [
    "getElementAtPoint",
    "getElementBounds",
    "getElementSelector",
    "isElementGrabbable",
  ]) {
    assert.match(REACT_GRAB_PRIMITIVES_ENTRY, new RegExp(primitive, "u"));
  }
  assert.match(REACT_GRAB_PRIMITIVES_ENTRY, /AidenReactGrabPrimitives/u);
  assert.doesNotMatch(REACT_GRAB_PRIMITIVES_ENTRY, /initReactGrab|telemetry/u);
});

test("KaTeX CSS font URLs are rewritten to data URIs with an allowlisted basename", async () => {
  const css = await inlineKatexFonts(
    '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2")}',
    "/tmp/fonts",
  );
  assert.match(css, /data:font\/woff2;base64,\{\{KaTeX_Main-Regular\.woff2\}\}/u);
  await assert.rejects(
    () => inlineKatexFonts("src:url(fonts/../evil.woff2)", "/tmp/fonts"),
    /Unexpected KaTeX font URL/u,
  );
});
