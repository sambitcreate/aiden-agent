import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_DESIGN_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_PARENT_FRAME_SRC,
  GENERATIVE_UI_PROTOCOL_SCHEME,
} from "../../renderer/shared/generative-ui.js";
import {
  DESIGN_PICKER_COMMAND,
  DESIGN_PICKER_SELECTION,
} from "../../renderer/shared/design-workspace.js";
import {
  generativeUiExportDocument,
  OMITTED_DESIGN_HTML_SENTINEL,
  validateGenerativeUiHtml,
  wrapGenerativeUiHtml,
} from "./generative-ui-html.js";

const TITLE = "Dependency map";

test("wrapper injects guest CSP, sandbox contract, and host library protocol", () => {
  const document = wrapGenerativeUiHtml('<p>hello</p><canvas id="c"></canvas>', TITLE);
  assert.match(
    document,
    new RegExp(`content="${GENERATIVE_UI_GUEST_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"),
  );
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

test("the Design HTML omission sentinel can never become artifact content", () => {
  assert.throws(
    () => validateGenerativeUiHtml(OMITTED_DESIGN_HTML_SENTINEL),
    /placeholder cannot be rendered/iu,
  );
  assert.throws(
    () => validateGenerativeUiHtml(`<main>${OMITTED_DESIGN_HTML_SENTINEL}</main>`),
    /placeholder cannot be rendered/iu,
  );
});

test("Design wrapper alone receives the local React Grab selection bridge", () => {
  const ordinary = wrapGenerativeUiHtml("<button>Save</button>", "Ordinary");
  const design = wrapGenerativeUiHtml(
    '<button data-aiden-id="save">Save</button>',
    "Design",
    undefined,
    {
      designCapability: "main-owned-capability",
    },
  );
  assert.doesNotMatch(ordinary, /react-grab-primitives\.js/u);
  assert.doesNotMatch(ordinary, new RegExp(DESIGN_PICKER_SELECTION, "u"));
  assert.match(design, /aiden-genui:\/\/react-grab-primitives\.js/u);
  assert.match(design, new RegExp(DESIGN_PICKER_COMMAND, "u"));
  assert.match(design, new RegExp(DESIGN_PICKER_SELECTION, "u"));
  assert.match(design, /main-owned-capability/u);
  assert.match(
    design,
    new RegExp(GENERATIVE_UI_DESIGN_GUEST_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assert.match(GENERATIVE_UI_DESIGN_GUEST_CSP, /connect-src 'none'/u);
});

test("Design picker keeps the exact React Grab hit instead of promoting tagged ancestors", () => {
  const design = wrapGenerativeUiHtml(
    '<article data-aiden-id="card"><button><span>Save</span></button></article>',
    "Exact selection",
    undefined,
    { designCapability: "main-owned-capability" },
  );
  assert.match(design, /const target = primitives\.getElementAtPoint/u);
  assert.match(design, /return target \|\| null/u);
  assert.match(design, /primitives\.getElementSelector\(element\)/u);
  assert.match(design, /show\(event\.target, false\)/u);
  assert.match(design, /const target = document\.activeElement/u);
  assert.doesNotMatch(design, /stableElement/u);
  assert.doesNotMatch(design, /element\.closest\("\[data-aiden-id\]"\)/u);
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

test("parent CSP lists only owned and loopback previews so arbitrary web frames stay denied", async () => {
  const html = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../main-window.html"),
    "utf8",
  );
  assert.match(html, /frame-src 'self' aiden-genui:/u);
  assert.doesNotMatch(html, /frame-src [^;]*https/u);
  assert.doesNotMatch(html, /frame-src [^;]*blob:/u);
  assert.match(html, /frame-src [^;]*http:\/\/127\.0\.0\.1:\*/u);
  assert.equal(GENERATIVE_UI_PARENT_FRAME_SRC, "'self' aiden-genui: http://127.0.0.1:*");
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
  assert.doesNotMatch(exported, /react-grab-primitives/u);
  assert.match(exported, /script-src 'unsafe-inline'/u);
  assert.doesNotMatch(exported, /script-src 'unsafe-inline' aiden-genui:/u);
  assert.match(exported, /sandbox="allow-scripts"/u);
  assert.match(exported, /srcdoc="/u);
  assert.match(
    exported,
    new RegExp(GENERATIVE_UI_EXPORT_HOST_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assert.doesNotMatch(GENERATIVE_UI_EXPORT_HOST_CSP, /frame-src [^;]*https/u);
});

test("export srcdoc preserves HTML entities for the guest parser", () => {
  const exported = generativeUiExportDocument('<p data-label="&quot;">&amp;</p>', TITLE, {
    "chart.js": "window.Chart = '&quot;';",
    "plotly.js": "window.Plotly = {};",
    "katex.js": "window.katex = {};",
    "katex.css": "body::before { content: '&quot;'; }",
  });
  assert.match(exported, /&amp;quot;/u);
  assert.match(exported, /&amp;amp;/u);
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
  assert.doesNotMatch(
    GENERATIVE_UI_IFRAME_SANDBOX,
    /allow-same-origin|allow-popups|allow-forms|allow-downloads/u,
  );
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
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../renderer/components/html-artifact-frame.tsx",
    ),
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

test("golden interactive control fixture is admitted without a network hint", () => {
  const fixture = `<button type="button" id="n">0</button>
<script>
document.getElementById("n").addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.textContent = String(Number(button.textContent) + 1);
});
</script>`;
  assert.ok(validateGenerativeUiHtml(fixture).byteLength > 0);
  const document = wrapGenerativeUiHtml(fixture, "Counter");
  assert.match(document, /addEventListener\("click"/u);
  assert.doesNotMatch(document, /https?:\/\//u);
});

test("artifact chrome promotes one interactive iframe into the modal top layer", async () => {
  const frame = await fs.readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../renderer/components/html-artifact-frame.tsx",
    ),
    "utf8",
  );
  assert.match(frame, /max-w-\[42rem\]/u);
  assert.match(frame, /popover="auto"/u);
  assert.match(frame, /section\.showPopover\(\)/u);
  assert.match(frame, /section\.hidePopover\(\)/u);
  assert.match(frame, /isolateExpandedArtifact\(section\)/u);
  assert.equal(frame.match(/<HtmlArtifactIframe\b/gu)?.length, 1);
  assert.match(frame, /trigger\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(frame, /role=\{expanded \? "dialog" : undefined\}/u);
  assert.match(frame, /aria-modal=\{expanded \|\| undefined\}/u);
  assert.match(frame, /aria-label=\{`Expand \$\{artifact\.title\}`\}/u);
  assert.match(frame, /aria-label=\{`Export \$\{artifact\.title\}`\}/u);
  assert.match(frame, /aria-label=\{`Close \$\{artifact\.title\}`\}/u);
  assert.match(frame, /error && src/u);
  assert.match(frame, /data-html-artifact-error=\{error\.kind\}/u);
  assert.match(frame, /Showing the previous version/u);
  assert.match(frame, /Could not export this visualization/u);
  assert.doesNotMatch(frame, /expandedFrameTargetRef/u);
  assert.doesNotMatch(frame, /getBoundingClientRect/u);
  const styles = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../renderer/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.aiden-html-artifact-popover:popover-open/u);
  const messageList = await fs.readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../renderer/components/message-list.tsx",
    ),
    "utf8",
  );
  assert.match(messageList, /MINIMUM_VISUALIZING_MS = 700/u);
  assert.match(messageList, /active=\{active \|\| visualizing\}/u);
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
