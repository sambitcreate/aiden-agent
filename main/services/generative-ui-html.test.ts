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
  assert.match(document, new RegExp(`content="${GENERATIVE_UI_GUEST_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.match(document, new RegExp(`${GENERATIVE_UI_PROTOCOL_SCHEME}://chart\\.js`, "u"));
  assert.match(document, /<p>hello<\/p>/u);
  assert.equal(GENERATIVE_UI_IFRAME_SANDBOX, "allow-scripts");
  assert.doesNotMatch(GENERATIVE_UI_IFRAME_SANDBOX, /allow-same-origin/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /connect-src 'none'/u);
  assert.match(GENERATIVE_UI_GUEST_CSP, /frame-src 'none'/u);
});

test("wrapper keeps inline head styles from a complete HTML document", () => {
  const document = wrapGenerativeUiHtml(
    "<!DOCTYPE html><html><head><style>h1{color:red}</style></head><body><h1>Chart</h1></body></html>",
    TITLE,
  );
  assert.match(document, /h1\{color:red\}/u);
  assert.match(document, /<h1>Chart<\/h1>/u);
});

test("html admission rejects remote scripts, frames, and javascript URLs", () => {
  assert.throws(() => validateGenerativeUiHtml('<script src="https://evil.test/x.js"></script>'));
  assert.throws(() => validateGenerativeUiHtml('<iframe src="https://evil.test"></iframe>'));
  assert.throws(() => validateGenerativeUiHtml('<a href="javascript:alert(1)">x</a>'));
  assert.throws(() => validateGenerativeUiHtml('<img src="https://evil.test/x.png">'));
  assert.throws(() => validateGenerativeUiHtml("\0p"));
  assert.ok(validateGenerativeUiHtml('<a href="https://example.com/docs">cite</a>').byteLength > 0);
  const ok = validateGenerativeUiHtml("<button onclick=\"this.textContent='ok'\">Go</button>");
  assert.ok(ok.byteLength > 0);
});

test("parent CSP lists only self frames so arbitrary https frames stay denied", async () => {
  const html = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../main-window.html"),
    "utf8",
  );
  assert.match(html, /frame-src 'self' aiden-genui:/u);
  assert.doesNotMatch(html, /frame-src [^;]*https/u);
  assert.doesNotMatch(html, /frame-src [^;]*blob:/u);
  assert.equal(GENERATIVE_UI_PARENT_FRAME_SRC, "'self' aiden-genui:");
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
  assert.match(GENERATIVE_UI_GUEST_CSP, /webrtc 'block'/u);
  assert.doesNotMatch(GENERATIVE_UI_GUEST_CSP, /aiden-genui:(?!\/\/)/u);
});

test("iframe preview uses aiden-genui protocol src, not inherited srcdoc", async () => {
  const frame = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../renderer/components/html-artifact-frame.tsx"),
    "utf8",
  );
  assert.match(frame, /src=\{src\}/u);
  assert.doesNotMatch(frame, /srcDoc=/u);
  assert.doesNotMatch(frame, /srcdoc=\{/u);
  assert.match(frame, /htmlArtifactSrcdoc/u);
  assert.match(frame, /artifact\.id/u);
  const html = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../main-window.html"),
    "utf8",
  );
  assert.match(html, /frame-src 'self' aiden-genui:/u);
  assert.doesNotMatch(html, /script-src [^;]*'unsafe-inline'/u);
  assert.doesNotMatch(html, /script-src [^;]*aiden-genui/u);
});

test("export refuses to silently drop missing host libraries", () => {
  assert.throws(
    () => generativeUiExportDocument("<p>n</p>", TITLE, { "chart.js": "window.Chart = 1;" }),
    /missing host library/u,
  );
});

test("per-artifact HTML export is gated on unresolved GUI recovery", async () => {
  const handlers = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../handlers/chats.ts"),
    "utf8",
  );
  const exportHandler = handlers.slice(handlers.indexOf('"chats:exportHtmlArtifact"'));
  assert.match(exportHandler, /unresolvedGuiArtifactMessage\(chatId\)/u);
  assert.match(exportHandler, /BrowserWindow\.fromWebContents/u);
  assert.match(exportHandler, /rendererDocumentOwner/u);
});
