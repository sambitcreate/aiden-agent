import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_PARENT_FRAME_SRC,
  GENERATIVE_UI_PROTOCOL_SCHEME,
} from "../../renderer/shared/generative-ui.js";
import {
  generativeUiExportDocument,
  validateGenerativeUiHtml,
  wrapGenerativeUiHtml,
} from "./generative-ui-html.js";

const TITLE = "Dependency map";

test("wrapper injects guest CSP, sandbox contract, and host library protocol", () => {
  const document = wrapGenerativeUiHtml("<p>hello</p><canvas id=\"c\"></canvas>", TITLE);
  assert.match(document, new RegExp(`content="${GENERATIVE_UI_GUEST_CSP.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.match(document, new RegExp(`${GENERATIVE_UI_PROTOCOL_SCHEME}://chart\\.js`, "u"));
  assert.match(document, /<p>hello<\/p>/u);
  assert.equal(GENERATIVE_UI_IFRAME_SANDBOX, "allow-scripts");
  assert.doesNotMatch(GENERATIVE_UI_IFRAME_SANDBOX, /allow-same-origin/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /connect-src 'none'/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /frame-src 'none'/u);
});

test("wrapper extracts a body fragment from a full HTML document", () => {
  const document = wrapGenerativeUiHtml(
    "<!DOCTYPE html><html><head><title>x</title></head><body><h1>Chart</h1></body></html>",
    TITLE,
  );
  assert.match(document, /<h1>Chart<\/h1>/u);
  assert.equal((document.match(/<!DOCTYPE html>/giu) ?? []).length, 1);
});

test("html admission rejects remote scripts, frames, and javascript URLs", () => {
  assert.throws(() => validateGenerativeUiHtml('<script src="https://evil.test/x.js"></script>'));
  assert.throws(() => validateGenerativeUiHtml('<iframe src="https://evil.test"></iframe>'));
  assert.throws(() => validateGenerativeUiHtml('<a href="javascript:alert(1)">x</a>'));
  assert.throws(() => validateGenerativeUiHtml('<img src="https://evil.test/x.png">'));
  assert.throws(() => validateGenerativeUiHtml("\0p"));
  const ok = validateGenerativeUiHtml("<button onclick=\"this.textContent='ok'\">Go</button>");
  assert.ok(ok.byteLength > 0);
});

test("parent CSP lists only self frames so arbitrary https frames stay denied", async () => {
  const html = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../main-window.html"),
    "utf8",
  );
  assert.match(html, /frame-src 'self'/u);
  assert.doesNotMatch(html, /frame-src [^;]*https/u);
  assert.doesNotMatch(html, /frame-src [^;]*blob:/u);
  assert.equal(GENERATIVE_UI_PARENT_FRAME_SRC, "'self'");
});

test("export inlines host libraries and removes the custom protocol", () => {
  const exported = generativeUiExportDocument("<p>n</p>", TITLE, {
    "chart.js": "window.Chart = function Chart() {};",
    "plotly.js": "window.Plotly = {};",
    "katex.js": "window.katex = {};",
    "katex.css": "body { font-size: 16px; }",
  });
  assert.match(exported, /window\.Chart = function Chart/u);
  assert.doesNotMatch(exported, /aiden-genui:\/\//u);
  assert.match(exported, /script-src 'unsafe-inline'/u);
  assert.doesNotMatch(exported, /script-src 'unsafe-inline' aiden-genui:/u);
});

test("golden chart fixture is admitted and wrapped without a network hint", () => {
  const fixture = `<canvas id="c"></canvas>
<script>
const ctx = document.getElementById("c");
new Chart(ctx, { type: "line", data: { labels: ["A", "B"], datasets: [{ data: [1, 2] }] } });
</script>`;
  assert.ok(validateGenerativeUiHtml(fixture).byteLength > 0);
  const document = wrapGenerativeUiHtml(fixture, "Line chart");
  assert.match(document, /new Chart/u);
  assert.doesNotMatch(document, /https?:\/\//u);
  assert.match(document, /connect-src 'none'/u);
});

test("sandbox contract keeps guest scripts unique-origin and network-denied", () => {
  assert.equal(GENERATIVE_UI_IFRAME_SANDBOX, "allow-scripts");
  assert.doesNotMatch(GENERATIVE_UI_IFRAME_SANDBOX, /allow-same-origin|allow-popups|allow-forms|allow-downloads/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /connect-src 'none'/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /frame-src 'none'/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /form-action 'none'/u);
  const wrapped = wrapGenerativeUiHtml("<p>x</p><script>void 0</script>", TITLE);
  assert.doesNotMatch(wrapped, /window\.parent\.document/u);
});
