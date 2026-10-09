import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_VENDORED_LIBS } from "../../renderer/shared/generative-ui.js";
import {
  generativeUiLibraryPath,
  readGenerativeUiHostLibrary,
} from "./generative-ui-host-libraries.js";

test("the generated Aiden kit is served as CSS without touching the vendored directory", async () => {
  const kit = await readGenerativeUiHostLibrary("aiden-ui.css");
  assert.equal(kit?.mimeType, "text/css; charset=utf-8");
  assert.match(kit?.bytes.toString("utf8") ?? "", /\.aiden-btn\b/u);
});

test("host library names map to allowlisted filenames under resources/generative-ui", () => {
  assert.equal(GENERATIVE_UI_VENDORED_LIBS.length, 4);
  assert.match(generativeUiLibraryPath("chart.js"), /chart\.umd\.min\.js$/u);
  assert.match(generativeUiLibraryPath("plotly.js"), /plotly\.min\.js$/u);
  assert.match(generativeUiLibraryPath("katex.js"), /katex\.min\.js$/u);
  assert.match(generativeUiLibraryPath("katex.css"), /katex\.min\.css$/u);
});

test("unknown host library names are not read from disk", async () => {
  assert.equal(await readGenerativeUiHostLibrary("../chart.js"), undefined);
  assert.equal(await readGenerativeUiHostLibrary("chart.umd.min.js"), undefined);
});
