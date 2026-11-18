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
  isGenerativeUiDraftAcceptable,
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
  assert.throws(() => validateGenerativeUiHtml('<div style="background:url(javascript:alert(1))"></div>'));
  assert.throws(() => validateGenerativeUiHtml('<a href="data:text/html,<b>x</b>">x</a>'));
  assert.throws(() => validateGenerativeUiHtml('<base href="https://evil.test/">'));
  assert.throws(() => validateGenerativeUiHtml('<link rel="stylesheet" href="https://evil.test/a.css">'));
});

test("html admission lets labels and script comparisons through that only look like loads", () => {
  const chart = [
    "<h2>Languages</h2>",
    "<ul><li>JavaScript: 41%</li><li>Python: 30%</li><li>The <code>javascript:</code> scheme is blocked</li></ul>",
    "<p>Data as text/html or data: text/html is fine to mention.</p>",
    "<script>",
    "const rows = [1, 2, 3]; const object = rows; const base = 2; const link = 1, frame = 0;",
    "for (let i = 0; i < object.length; i += 1) { if (i<base && frame<link) console.log(i); }",
    "</script>",
  ].join("");
  assert.ok(validateGenerativeUiHtml(chart).byteLength > 0);
});

const REFUSED_MARKUP: Record<string, string> = {
  "a <base> whose earlier attribute quotes a <": '<base data-x="<" href="https://evil.test/">',
  "a <link> whose title holds a <": '<link title="a<b" rel=stylesheet href=https://evil.test/a.css>',
  "an <object> whose title is a <": '<object title="<" data=https://evil.test/x.svg></object>',
  "a refresh <meta> whose URL ends in <": '<meta content="0;url=https://evil.test/?<" http-equiv=refresh>',
  "an <iframe> whose title is a <": '<iframe title="<" src="https://evil.test/"></iframe>',
  "a <script src> after a quoted <": '<script data-x="<" src="https://evil.test/a.js"></script>',
  "window.open of a javascript: URL": '<script>window.open("javascript:alert(1)")</script>',
  "setAttribute href to a javascript: URL": "<script>a.setAttribute('href', 'javascript:alert(1)')</script>",
  "location set to a javascript: URL": "<script>location.href = `javascript:alert(1)`</script>",
  "an element src set to data:text/html": '<script>frame.src = "data:text/html,<b>x</b>"</script>',
  "an entity-encoded javascript: href": '<a href="&#106;avascript&colon;alert(1)">x</a>',
  "a javascript: href split by a tab": '<a href="java\tscript:alert(1)">x</a>',
  "an svg xlink:href to javascript:": '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  "an onclick that navigates to javascript:": "<button onclick=\"location='javascript:alert(1)'\">Go</button>",
  "a stylesheet url() of javascript:": "<style>.x { background: url('javascript:alert(1)') }</style>",
  "an unquoted remote img src": "<img src=https://evil.test/x.png>",
};

const ADMITTED_MARKUP: Record<string, string> = {
  "an aria-label that names JavaScript": '<svg><rect aria-label="JavaScript: 41%"></rect></svg>',
  "an option value that names JavaScript": '<select><option value="JavaScript: 41%">JS</option></select>',
  "a script that writes JavaScript: into a label": '<script>el.textContent = "JavaScript: 41%";</script>',
  "a script comparison against base": "<script>const ok = i<base && i>0;</script>",
  "a script comparison against link": "<script>if (n<link || n>9) draw();</script>",
  "a script string that holds a URL": '<script>const src = "https://example.com/data.csv"; label.textContent = src;</script>',
  "a string replace of the word javascript:": '<script>label.textContent = name.replace("javascript:", "");</script>',
  "a title attribute that quotes a tag": '<p title="<iframe src=https://evil.test>">Embeds are refused</p>',
  "a baseline element name": "<svg><text dominant-baseline=\"middle\">x</text></svg>",
  "a cited https link": '<a href="https://example.com/docs">cite</a>',
};

for (const [name, html] of Object.entries(REFUSED_MARKUP)) {
  test(`html admission refuses ${name}, finished or streaming`, () => {
    assert.throws(() => validateGenerativeUiHtml(html));
    assert.equal(isGenerativeUiDraftAcceptable(html), false);
  });
}

for (const [name, html] of Object.entries(ADMITTED_MARKUP)) {
  test(`html admission admits ${name}`, () => {
    assert.ok(validateGenerativeUiHtml(html).byteLength > 0);
    assert.equal(isGenerativeUiDraftAcceptable(html), true);
  });
}

test("a streaming draft cut inside a script or a quoted attribute is read as script or value, not as tags", () => {
  assert.equal(isGenerativeUiDraftAcceptable("<script>for (let i = 0; i<base && i>0"), true);
  assert.equal(isGenerativeUiDraftAcceptable('<p title="a <link> tag'), true);
  assert.equal(isGenerativeUiDraftAcceptable("<p>Chart</p><iframe"), false);
  assert.equal(isGenerativeUiDraftAcceptable('<a href="javascript:'), false);
});

test("a refused visual's error quotes the markup that was refused", () => {
  assert.throws(
    () => validateGenerativeUiHtml('<p>Chart</p><iframe src="https://evil.test/embed"></iframe>'),
    (error: Error) => error.message.includes('"<iframe src=\\"https://evil.test/embed\\">"'),
  );
  assert.throws(
    () => validateGenerativeUiHtml('<p>JavaScript: 41%</p><a href="javascript:alert(1)">x</a>'),
    (error: Error) => error.message.includes('found "href=\\"javascript:alert(1)\\""') && !/remote URLs/u.test(error.message),
  );
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
  // Standalone pages (export) keep a solid canvas.
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
