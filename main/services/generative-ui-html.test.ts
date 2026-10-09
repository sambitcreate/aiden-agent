import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_PARENT_FRAME_SRC,
  GENERATIVE_UI_PROTOCOL_SCHEME,
} from "../../renderer/shared/generative-ui.js";
import { GENERATIVE_UI_DEFAULT_THEME_VARS } from "../../renderer/shared/generative-ui-theme.js";
import {
  generativeUiDraftDocumentHead,
  generativeUiExportDocument,
  parseGenerativeUiTheme,
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
  assert.match(exported, /sandbox="allow-scripts"/u);
  assert.match(exported, /srcdoc="/u);
  assert.match(exported, new RegExp(GENERATIVE_UI_EXPORT_HOST_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(GENERATIVE_UI_EXPORT_HOST_CSP, /frame-src [^;]*https/u);
});

test("export srcdoc preserves HTML entities for the guest parser", () => {
  const exported = generativeUiExportDocument(
    '<p data-label="&quot;">&amp;</p>',
    TITLE,
    {
      "chart.js": "window.Chart = '&quot;';",
      "plotly.js": "window.Plotly = {};",
      "katex.js": "window.katex = {};",
      "katex.css": "body::before { content: '&quot;'; }",
    },
  );
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
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../renderer/components/html-artifact-frame.tsx"),
    "utf8",
  );
  assert.match(frame, /popover="auto"/u);
  assert.match(frame, /section\.showPopover\(\)/u);
  assert.match(frame, /section\.hidePopover\(\)/u);
  assert.match(frame, /isolateExpandedArtifact\(section\)/u);
  assert.match(frame, /trigger\.focus\(\{ preventScroll: true \}\)/u);
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
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../renderer/components/message-list.tsx"),
    "utf8",
  );
  assert.match(messageList, /assistantPresentationRows\(/u);
  assert.doesNotMatch(messageList, /MINIMUM_VISUALIZING_MS/u);
  const chatPane = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../renderer/main/chat-pane.tsx"),
    "utf8",
  );
  assert.match(chatPane, /hasActiveToolStep\(displayedGenerationTimeline, RENDER_ARTIFACT_TOOL_NAME\)/u);
  assert.match(chatPane, /visualizingVisible:/u);
});

test("wrapper emits sanitized vars, the kit stylesheet, and a transparent inline canvas", () => {
  const theme = {
    colorScheme: "dark" as const, canvas: "#111111", foreground: "#eeeeee", secondary: "#999999", accent: "#3388ff",
    vars: { "--chart-1": "#83d8ff", "--text-primary": "red;}" },
  };
  const doc = wrapGenerativeUiHtml("<p>x</p>", "T", theme, { inline: true });
  assert.match(doc, /--chart-1: #83d8ff;/u);
  assert.doesNotMatch(doc, /red;\}/u);
  assert.match(doc, /href="aiden-genui:\/\/aiden-ui\.css"/u);
  assert.match(doc, /html, body \{[^}]*background: transparent/u);
  // Standalone pages (export, Design Studio) keep a solid canvas.
  const standalone = wrapGenerativeUiHtml("<p>x</p>", "T", theme);
  assert.match(standalone, /html, body \{[^}]*background: var\(--artifact-canvas\)/u);
});

test("the draft document head is open-ended and only its nonce'd bridge may run", () => {
  const nonce = "abcdefghijklmnop0123==";
  const head = generativeUiDraftDocumentHead("Draft", undefined, nonce);
  assert.match(head, new RegExp(`<script nonce="${nonce}">`, "u"));
  assert.match(head, /<body>\s*$/u);
  assert.doesNotMatch(head, /<\/body>/u);
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(head)?.[1] ?? "";
  assert.match(meta, new RegExp(`script-src 'nonce-${nonce}'`, "u"));
  assert.doesNotMatch(/script-src[^;]*/u.exec(meta)?.[0] ?? "", /unsafe-inline/u);
  assert.throws(() => generativeUiDraftDocumentHead("Draft", undefined, "\" onload=\"x"), /nonce/u);
});

test("documents without a renderer theme still carry Aiden's default token kit", () => {
  for (const doc of [
    wrapGenerativeUiHtml("<p>x</p>", "T"),
    generativeUiExportDocument("<p>x</p>", "T", {
      "chart.js": "window.Chart = 1;", "plotly.js": "1", "katex.js": "1", "katex.css": "b{}",
    }),
  ]) {
    for (const name of ["--chart-1", "--chart-8", "--status-green-surface", "--surface-well", "--text-primary"]) {
      assert.match(doc, new RegExp(`${name}: [^;]+;`, "u"), name);
    }
  }
  // Renderer-supplied values win over the defaults.
  const themed = wrapGenerativeUiHtml("<p>x</p>", "T", {
    colorScheme: "dark", canvas: "#111111", foreground: "#eeeeee", secondary: "#999999", accent: "#3388ff",
    vars: { "--chart-1": "#83d8ff" },
  });
  assert.equal(themed.match(/--chart-1: /gu)?.length, 1);
  assert.match(themed, /--chart-1: #83d8ff;/u);
});

test("legacy four-color theme callers still render", () => {
  const doc = wrapGenerativeUiHtml("<p>x</p>", "T", {
    colorScheme: "light", canvas: "#ffffff", foreground: "#000000", secondary: "#666666", accent: "#0b7de5",
  });
  assert.match(doc, /--artifact-accent: #0b7de5;/u);
  assert.match(doc, /<p>x<\/p>/u);
});

test("legacy four-color themes derive their semantic foreground and series from the caller colors", () => {
  const legacyDark = {
    colorScheme: "dark", canvas: "#101010", foreground: "#fafafa", secondary: "#a0a0a0", accent: "#3399ff",
  };
  const vars = parseGenerativeUiTheme(legacyDark).vars ?? {};
  assert.equal(vars["--text-primary"], "#fafafa");
  assert.equal(vars["--focus-ring"], "#fafafa");
  assert.equal(vars["--text-secondary"], "#a0a0a0");
  assert.equal(vars["--accent"], "#3399ff");
  // Caller-supplied explicit vars stay authoritative over the derived defaults.
  const explicit = parseGenerativeUiTheme({ ...legacyDark, vars: { "--text-primary": "#123456" } }).vars ?? {};
  assert.equal(explicit["--text-primary"], "#123456");
  assert.equal(explicit["--text-secondary"], "#a0a0a0");
  // Without a caller theme the light defaults are unchanged.
  const none = wrapGenerativeUiHtml("<p>x</p>", "T");
  assert.match(none, new RegExp(`--text-primary: ${GENERATIVE_UI_DEFAULT_THEME_VARS["--text-primary"]};`, "u"));
});

test("export inlines the generated Aiden kit without a caller-supplied copy", () => {
  const exported = generativeUiExportDocument("<p class=\"aiden-card\">n</p>", TITLE, {
    "chart.js": "window.Chart = function Chart() {};",
    "plotly.js": "window.Plotly = {};",
    "katex.js": "window.katex = {};",
    "katex.css": "body { font-size: 16px; }",
  });
  assert.doesNotMatch(exported, /aiden-genui:\/\//u);
  assert.match(exported, /\.aiden-card/u);
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
