import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_PARENT_FRAME_SRC,
  GENERATIVE_UI_PROTOCOL_SCHEME,
} from "../../renderer/shared/generative-ui.js";
import { GENERATIVE_UI_DEFAULT_THEME_VARS } from "../../renderer/shared/generative-ui-theme.js";
import {
  createGenerativeUiDraftCheck,
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

test("the wrapper keeps head styles and scripts without a src, in order, and drops the rest of the head", () => {
  const document = wrapGenerativeUiHtml(
    "<!doctype html><html><head><title>t</title><style data-src=x>b{}</style><script>var a=1</script><STYLE>i{}</STYLE></head><body><p>x</p></body></html>",
    TITLE,
  );
  const body = document.slice(document.lastIndexOf("<body>"));
  assert.equal(body.includes("b{}"), false);
  assert.equal(body.includes("<title>"), false);
  assert.ok(body.indexOf("<script>var a=1</script>") < body.indexOf("<STYLE>i{}</STYLE>"));
  assert.ok(body.indexOf("<STYLE>i{}</STYLE>") < body.indexOf("<p>x</p>"));
});

/**
 * Asserts that `run` takes roughly linear time: four times the input may take
 * at most eight times as long (a quadratic step takes sixteen), and never
 * more than five seconds. After a warm-up, the two sizes are timed in turn,
 * five times each, and each size counts as its median, so a burst of load
 * slows both sizes alike and one slow run cannot fail it. A small size
 * faster than `floorMs` counts as `floorMs`, so timer noise and garbage
 * collection in a run of a few milliseconds cannot fail it.
 */
function assertScalesLinearly(label: string, run: (size: number) => void, size: number, floorMs = 100): void {
  const time = (n: number) => {
    const started = performance.now();
    run(n);
    return performance.now() - started;
  };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  run(size);
  const smalls: number[] = [];
  const larges: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    smalls.push(time(size));
    larges.push(time(size * 4));
  }
  const small = median(smalls);
  const large = median(larges);
  const timing = `${label}: ${Math.round(small)} ms at ${size}, ${Math.round(large)} ms at ${size * 4} (medians of ${smalls.map(Math.round).join("/")} and ${larges.map(Math.round).join("/")})`;
  assert.ok(large < Math.max(small, floorMs) * 8, timing);
  assert.ok(large < 5_000, timing);
}

/**
 * Streams `html` through one draft check in `chunk`-sized pieces, as the
 * draft preview does: whether it was admitted, the text the check handed
 * back to show, and where it was refused.
 */
const streamInChunks = (html: string, chunk: number): { admitted: boolean; shown: string; refusedAt?: number } => {
  const check = createGenerativeUiDraftCheck();
  let shown = "";
  for (let at = 0; at < html.length; at += chunk) {
    const checked = check.append(html.slice(at, at + chunk));
    if (checked === false) return { admitted: false, shown, refusedAt: at };
    shown += checked;
  }
  const rest = check.finish();
  if (rest === false) return { admitted: false, shown, refusedAt: html.length };
  return { admitted: true, shown: shown + rest };
};

test("streaming a visual up to the size cap in small chunks takes linear time and shows only checked text", () => {
  const unfinished: Record<string, (size: number) => string> = {
    smilValues: (size) => `<svg><a><animate attributeName="href" values="${";".repeat(size)}`,
    urlValue: (size) => `<a href="${" ".repeat(size)}`,
    handler: (size) => `<p onclick="${"x;".repeat(size / 2)}`,
    attributeName: (size) => `<p ${"x".repeat(size)}`,
    comment: (size) => `<!--${"x".repeat(size)}`,
    script: (size) => `<script>${"x;".repeat(size / 2)}`,
    word: (size) => `<p>${"x".repeat(size)}`,
  };
  for (const [shape, build] of Object.entries(unfinished)) {
    assertScalesLinearly(
      shape,
      (size) => {
        const html = build(size);
        assert.deepEqual(streamInChunks(html, 64), { admitted: true, shown: html });
      },
      // Just under a quarter of the cap, so four times it with the opening
      // tag still fits.
      131_040,
    );
  }
  // A refusal in an unfinished tag still stops the draft before the tag
  // ends, and the refused URL is never handed back to show.
  const refused = `<p>Chart</p><a href="javascript:${"x".repeat(100_000)}`;
  const streamed = streamInChunks(refused, 64);
  assert.equal(streamed.admitted, false);
  assert.ok(streamed.refusedAt! < refused.length / 2, `refused at ${streamed.refusedAt}`);
  assert.ok(refused.startsWith(streamed.shown));
  assert.equal(streamed.shown.includes("javascript:"), false);
});

const XML_SHAPE_START = `<script>new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">`;
const XML_SHAPE_END = `</svg>', 'image/svg+xml')</script>`;

test("checking, wrapping or streaming a visual up to the size cap takes linear time, whatever its shape", () => {
  const cap = 512 * 1024 - 64;
  const fill = (size: number, unit: string, before = "", after = "") =>
    before + unit.repeat(Math.floor((size - before.length - after.length) / unit.length)) + after;
  const attributes = (count: number) => Array.from({ length: count }, (_, index) => ` a${index.toString(36)}`).join("");
  const shapes: Record<string, (size: number) => string> = {
    unclosedHeadScripts: (size) => fill(size, "<script>", "<head>", "</head>"),
    unclosedHeadStyles: (size) => fill(size, "<style>", "<head>", "</head>"),
    headScriptTagWithoutEnd: (size) => fill(size, "<script ", "<head>", "</head>"),
    headScriptsWithAttributes: (size) => fill(size, "<script x>", "<head>", "</head>"),
    openHeads: (size) => fill(size, "<head>"),
    openBodies: (size) => fill(size, "<body>"),
    htmlTagsWithoutEnd: (size) => fill(size, "<html ", "<!doctype html>"),
    bodyTagsWithoutEnd: (size) => fill(size, "<body ", "<!doctype html>"),
    htmlEndTagsWithoutEnd: (size) => fill(size, "</html ", "<html>"),
    deepNesting: (size) => fill(size, "<div>".repeat(510) + "</div>".repeat(510)),
    manyAttributes: (size) => fill(size, `<p${attributes(510)}>`),
    formattingReconstruction: (size) =>
      fill(size, "<p>t</p>", `<p>${Array.from({ length: 500 }, (_, index) => `<b x${index}>`).join("")}</p>`),
    scriptStrings: (size) => fill(size, "x.innerHTML='<p>';", "<script>", "</script>"),
    // Arrays spread into a call after many literal arguments.
    spreadsAfterLiterals: (size) => fill(size, "...[", `<script>f(${"'a',".repeat(Math.floor(size / 8))}`, "</script>"),
    // Namespaced XML a script parses, read as HTML element by element.
    xmlTextElements: (size) => fill(size, "<style>a</style><x:title>t</x:title>", XML_SHAPE_START, XML_SHAPE_END),
    xmlCdataSections: (size) => fill(size, "<![CDATA[a]]>", XML_SHAPE_START, XML_SHAPE_END),
    xmlPrefixedLinks: (size) => fill(size, '<a q:href="#a"/>', XML_SHAPE_START, XML_SHAPE_END),
    xmlUnclosedTextElements: (size) => fill(size, "<style ", XML_SHAPE_START, XML_SHAPE_END),
    xmlUnterminatedInstructions: (size) => fill(size, "<?", XML_SHAPE_START, XML_SHAPE_END),
    xmlUnterminatedDoctypes: (size) => fill(size, "<!DOCTYPE x ", XML_SHAPE_START, XML_SHAPE_END),
    // Tags parse5 drops in a <select>, checked as they are read.
    selectContent: (size) => fill(size, '<img src="#" onclick="f(1)"><b x>', "<select>", "</select>"),
    // An <svg> in a <select> is built and read as SVG.
    selectIcons: (size) => fill(size, '<option><svg><path d="M0 0"/></svg>a</option>', "<select>", "</select>"),
    cssUrls: (size) => fill(size, "url(a)", "<style>", "</style>"),
    noscriptBlocks: (size) => fill(size, "<noscript><p>x</p></noscript>"),
    contentMovedOutOfTables: (size) => fill(size, "a<i></i>", "<table>"),
    // The siblings and the moved content both grow with the size.
    contentMovedPastManySiblings: (size) => fill(size, "<p></p>", "", `<table>${"a<i></i>".repeat(Math.floor(size / 64))}`),
  };
  for (const [shape, build] of Object.entries(shapes)) {
    assertScalesLinearly(
      shape,
      (size) => {
        const html = build(size);
        let admitted = true;
        try {
          wrapGenerativeUiHtml(html, TITLE);
        } catch {
          admitted = false;
        }
        assert.equal(streamInChunks(html, 997).admitted, admitted, `${shape}: the draft and the finished visual disagree at ${size} characters`);
      },
      Math.floor(cap / 4),
      // Under 100 ms at a quarter of the cap leaves 800 ms at the cap; the
      // quadratic shapes this guards against took seconds to minutes there.
      100,
    );
  }
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

/** Line comments about `size` characters long, to push a sink far past a fork. */
const commentLines = (size: number) => Array.from({ length: Math.ceil(size / 60) }, () => `// ${"x".repeat(56)}`).join("\n");
/**
 * After `{}` a `/` divides and the backquote opens a template whose `${…}`
 * runs, while the likelier reading takes `/`+"`"+`/` as a regex and the rest
 * as comments: the other reading has to be followed however far it goes.
 */
const farTemplateSink = (size: number, sink: string, after = "") => `var o={}; var x = {} /\`/${after};\n${commentLines(size)}\n// \${${sink}}\n// \`;`;

/** `line` 40 times, 1.5 KB of comments apart. */
const repeatedLine = (line: string) => Array.from({ length: 40 }, () => `${line}\n${commentLines(1500)}`).join("\n");

const IFRAME_SINK = 'document.body.innerHTML="<iframe src=https://e.test></iframe>";';
const HASHBANG_SINKS = {
  template: `<script>#!/x/ \`\n${IFRAME_SINK}\n//\`</script>`,
  blockComment: `<script>#!/x/ /*\n${IFRAME_SINK}\n//*/</script>`,
  module: `<script type="module">#!/x/ \`\n${IFRAME_SINK}\n//\`</script>`,
  byteOrderMark: `<script>\uFEFF#!/x/ \`\n${IFRAME_SINK}\n//\`</script>`,
  // A handler's body is compiled as a function's source text, which may start
  // with a hashbang too.
  svgOnload: `<p>x</p><svg onload='#!/x/ \`\n${IFRAME_SINK}\n//\`'></svg>`,
  imgOnerrorEntity: `<p>x</p><img alt="" src="data:,x" onerror='&#35;!/x/ \`&#10;${IFRAME_SINK}&#10;//\`'>`,
  handlerLineSeparator: `<p>x</p><svg onload='#!/x/ \`\u2028${IFRAME_SINK}\u2028//\`'></svg>`,
  handlerBlockComment: `<p>x</p><svg onload='#!/x/ /*\n${IFRAME_SINK}\n//*/'></svg>`,
  handlerInInnerHtml: `<p>x</p><script>document.body.innerHTML = "<img src=data:,x onerror='#!/x/ \`\\n${IFRAME_SINK.replace(/"/gu, '\\"')}\\n//\`'>";</script>`,
};

// Sinks spelled with escapes a browser's JavaScript engine decodes: legacy
// octal escapes in sloppy-mode strings (`\74` is "<", `\152` is "j", `\43` is
// "#"), braced code points with leading zeros, and \u escapes in names.
const NESTED_ESCAPED_SINK = String.raw`document.body.innerHTML=\'\\x3ciframe src=https:\\x2f\\x2fe.test>\\x3c\\x2fiframe>\'`;
const ESCAPED_SINKS = {
  octalMarkup: String.raw`<p>x</p><script>document.body.innerHTML = '\74iframe src=https://e.test>\74/iframe>';</script>`,
  octalMarkupInOnclick: String.raw`<p>x</p><button onclick="document.body.innerHTML = '\74iframe src=https://e.test>\74/iframe>'">Go</button>`,
  octalLocation: String.raw`<p>x</p><script>location = '\152avascript:alert(1)';</script>`,
  octalHref: String.raw`<p>x</p><script>a.href = '\144ata:text/html,<b>x</b>';</script>`,
  octalHandlerHashbang: `<p>x</p><script>document.body.innerHTML = '<img src=data:,x onerror="\\43!/x/ \`\\n${NESTED_ESCAPED_SINK};\\n//\`">';</script>`,
  octalScriptHashbang: `<p>x</p><script>document.write('<script>\\43!/x/ \`\\n${NESTED_ESCAPED_SINK};\\n//\`<\\/script>');</script>`,
  longBracedMarkup: String.raw`<p>x</p><script>document.body.innerHTML = '\u{0000003c}iframe src=https://e.test>\u{0000003c}/iframe>';</script>`,
  longBracedLocation: String.raw`<p>x</p><script>location = '\u{0000006a}avascript:alert(1)';</script>`,
  bracedName: String.raw`<p>x</p><script>\u{6F}pen('javascript:alert(1)');</script>`,
  fourDigitName: `<p>x</p><script>a.${"\\"}u0068ref = 'javascript:alert(1)';</script>`,
  bracedProperty: String.raw`<p>x</p><script>document.body.inner\u{48}TML = '<iframe src=https://e.test></iframe>';</script>`,
};

// Sinks nested `layers` strings deep, each layer writing the next: an
// onclick set by setAttribute and clicked, markup written by
// insertAdjacentHTML or innerHTML whose <img onerror> writes the next, and an
// <img onerror> in the page that starts an innerHTML chain. Past the depth the
// check reads again, the innermost layers are refused unread.
const attributeValue = (text: string) => text.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
const NESTED_LAYERS = {
  setAttribute: (layers: number, final = IFRAME_SINK) => {
    let js = final;
    for (let layer = layers; layer >= 1; layer -= 1) js = `b${layer}.setAttribute('onclick', ${JSON.stringify(js)}); b${layer}.click()`;
    return `<p>x</p>${[1, 2, 3, 4, 5].map((n) => `<button id=b${n}>${n}</button>`).join("")}<script>${js}</script>`;
  },
  insertAdjacentHTML: (layers: number, final = IFRAME_SINK) => {
    let js = final;
    for (let layer = layers; layer >= 1; layer -= 1) {
      js = `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<img src=x${layer} onerror="${attributeValue(js)}">`)})`;
    }
    return `<p>x</p><script>${js}</script>`;
  },
  innerHTML: (layers: number, final = IFRAME_SINK) => {
    let js = final;
    for (let layer = layers; layer >= 1; layer -= 1) js = `document.body.innerHTML=${JSON.stringify(`<img src=x${layer} onerror="${attributeValue(js)}">`)}`;
    return `<p>x</p><script>${js}</script>`;
  },
  pageHandler: (layers: number, final = IFRAME_SINK) => {
    let js = final;
    for (let layer = layers; layer >= 1; layer -= 1) js = `document.body.innerHTML=${JSON.stringify(`<img src=x${layer} onerror="${attributeValue(js)}">`)}`;
    return `<p>x</p><img src=x0 onerror="${attributeValue(js)}">`;
  },
};
const DEEP_NESTED_SINKS = Object.fromEntries(
  Object.entries(NESTED_LAYERS).flatMap(([name, build]) => [3, 4].map((layers) => [`${layers} ${name} layers`, build(layers)])),
);

const IFRAME_MARKUP = JSON.stringify("<iframe src=https://e.test></iframe>");
const IFRAME_HANDLER = JSON.stringify(IFRAME_SINK);
// XML documents DOMParser builds whose nodes the page takes, by type: each
// holds an element the page loads or runs that an HTML reading of the same
// text, or a reading of the prefixes as written, would not see.
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XML_ERROR_IMG = `<img src="x" onerror="location='javascript:alert(1)'"/>`;
const XML_DOCUMENTS: Record<string, [xml: string, type: string]> = {
  "XML whose DOCTYPE gives an element the XHTML namespace by default": [
    `<!DOCTYPE r [<!ATTLIST img xmlns CDATA #FIXED "http:&#47;&#47;www.w3.org&#47;1999&#47;xhtml">]><r>${XML_ERROR_IMG}</r>`,
    "application/xml",
  ],
  "XML whose DOCTYPE gives the root the XHTML namespace by default": [
    `<!DOCTYPE r [<!ATTLIST r xmlns CDATA #FIXED "http:&#47;&#47;www.w3.org&#47;1999&#47;xhtml">]><r>${XML_ERROR_IMG}</r>`,
    "text/xml",
  ],
  "XML whose elements take the XHTML namespace through a non-ASCII prefix": [`<r xmlns:é="${XHTML_NS}"><é:img src="x" onerror="location='javascript:alert(1)'"/></r>`, "text/xml"],
  "XHTML whose empty <xmp/> HTML would read the following elements as text in": [`<r xmlns="${XHTML_NS}"><xmp/>${XML_ERROR_IMG}</r>`, "text/xml"],
  "an XHTML document whose empty <xmp/> HTML would read the following elements as text in": [`<r xmlns="${XHTML_NS}"><xmp/>${XML_ERROR_IMG}</r>`, "application/xhtml+xml"],
  "XHTML whose <style> holds an element": [`<r xmlns="${XHTML_NS}"><style>${XML_ERROR_IMG}</style></r>`, "text/xml"],
  "XHTML whose <textarea> holds an element": [`<r xmlns="${XHTML_NS}"><textarea>${XML_ERROR_IMG}</textarea></r>`, "text/xml"],
  "XHTML whose <script> holds an element": [`<r xmlns="${XHTML_NS}"><script>${XML_ERROR_IMG}</script></r>`, "text/xml"],
  "XHTML whose prefixed <title> holds an element": [`<h:r xmlns:h="${XHTML_NS}"><h:title><h:img src="x" onerror="location='javascript:alert(1)'"/></h:title></h:r>`, "text/xml"],
  "XHTML whose CDATA section HTML would read as the start of a comment": [`<r xmlns="${XHTML_NS}"><![CDATA[ > <!-- ]]>${XML_ERROR_IMG}</r>`, "application/xhtml+xml"],
  // A <!-- in a processing instruction or a DOCTYPE literal starts no comment.
  "XHTML whose processing instruction holds what would start a comment": [`<r xmlns="${XHTML_NS}"><?x <!-- ?>${XML_ERROR_IMG}<?y -->?></r>`, "text/xml"],
  "XHTML whose DOCTYPE literal holds what would start a comment": [`<!DOCTYPE r SYSTEM "<!--"><r xmlns="${XHTML_NS}">${XML_ERROR_IMG}<?y -->?></r>`, "application/xhtml+xml"],
  "an SVG document whose foreignObject holds an empty XHTML <xmp/>": [
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><xmp xmlns="${XHTML_NS}"/><img xmlns="${XHTML_NS}" src="x" onerror="location='javascript:alert(1)'"/></foreignObject></svg>`,
    "image/svg+xml",
  ],
  "an SVG link whose href takes the XLink namespace through another prefix": [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><a q:href="javascript:alert(1)"><text y="9">go</text></a></svg>`,
    "image/svg+xml",
  ],
  "an SVG link whose prefixed href follows an unprefixed one": [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><a href="#top" q:href="javascript:alert(1)"><text y="9">go</text></a></svg>`,
    "image/svg+xml",
  ],
  "an SVG <set> of an href under another XLink prefix": [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><a><set attributeName="q:href" to="javascript:alert(1)"/><text y="9">go</text></a></svg>`,
    "image/svg+xml",
  ],
  "an SVG <set> of an href under another XLink prefix, parsed as text/xml": [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><a><set attributeName=" q:href " to="javascript:alert(1)"/><text y="9">go</text></a></svg>`,
    "text/xml",
  ],
  "an SVG <animate> of an href under another XLink prefix": [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><a><animate attributeName="Q:HREF" values="#a;javascript:alert(1)"/><text y="9">go</text></a></svg>`,
    "image/svg+xml",
  ],
};
const parsedXml = (xml: string, type: string) => `document.body.append(new DOMParser().parseFromString(${JSON.stringify(xml)}, '${type}').documentElement)`;
const literalSink = (js: string) => `<p>x</p><button id=b onclick="void 0">Go</button><a id=a>x</a><script>${js}</script>`;
// Sinks reached through a split string, a wrapped callee or a shifted argument.
const INDIRECT_SINKS: Record<string, string> = {
  "markup written after a value and a +": `document.body.innerHTML = x + ${IFRAME_MARKUP}`,
  "markup written after a number and a +": `document.body.innerHTML = 0 + ${IFRAME_MARKUP}`,
  "markup split between a string and a parenthesized one": `document.body.innerHTML = '<ifr' + ('ame src=https://e.test></iframe>')`,
  "markup split around a value": `document.body.innerHTML = '<p>' + name + '</p><ifr' + x + 'ame src=https://e.test></iframe>'`,
  "a handler split around a value": `b.setAttribute('onclick', "document.body.inner" + x + "HTML='<iframe src=https://e.test></iframe>'"); b.click()`,
  "a javascript: URL continued in an array after a +": "location = 'java' + ['script:alert(1)']",
  "a javascript: URL in parentheses after an empty string": "location = '' + ('javascript:alert(1)')",
  "a javascript: URL continued through a parenthesized piece": "location = 'java' + ('script') + ':alert(1)'",
  "a javascript: URL started in parentheses": "location = ('java') + 'script:alert(1)'",
  "a javascript: URL started and continued in parentheses": "location = ('java') + ('script:alert(1)')",
  "a javascript: URL spelled across parentheses in location.assign": "location.assign('java' + ('script') + ':alert(1)')",
  "a javascript: URL started in parentheses in location.assign": "location.assign(('java') + 'script:alert(1)')",
  "a javascript: URL split by an empty template substitution": "location = `java${''}script:alert(1)`",
  "a parenthesized setAttribute": `(b.setAttribute)('onclick', ${IFRAME_HANDLER}); b.click()`,
  "a parenthesized document.write": `(document.write)(${IFRAME_MARKUP})`,
  "a parenthesized document.write tag": "(document.write)`<iframe src=https://e.test></iframe>`",
  "a parenthesized location.assign": "(location.assign)('javascript:alert(1)')",
  "open called through a comma expression": "(0, open)('javascript:alert(1)')",
  "a bound setAttribute": `b.setAttribute.bind(b)('onclick', ${IFRAME_HANDLER}); b.click()`,
  "insertAdjacentHTML called through .call": `Element.prototype.insertAdjacentHTML.call(document.body, 'beforeend', ${IFRAME_MARKUP})`,
  "a bracketed setAttribute called through .call": `b['setAttribute'].call(b, 'onclick', ${IFRAME_HANDLER}); b.click()`,
  "document.write called through .call": `document.write.call(document, ${IFRAME_MARKUP})`,
  "location.replace called through .call": "location.replace.call(location, 'javascript:alert(1)')",
  "setAttribute arguments spread from an array": `b.setAttribute(...['onclick', ${IFRAME_HANDLER}]); b.click()`,
  "setAttribute arguments after an empty spread": `b.setAttribute(...[], 'onclick', ${IFRAME_HANDLER}); b.click()`,
  "a setAttribute name spread with a trailing comma": `b.setAttribute(...['onclick',], ${IFRAME_HANDLER}); b.click()`,
  "insertAdjacentHTML markup spread after a position": `document.body.insertAdjacentHTML(...['beforeend'], ${IFRAME_MARKUP})`,
  "a DOMParser type spread from an array": `document.body.append(...new DOMParser().parseFromString(...[${IFRAME_MARKUP}, 'text/html']).body.childNodes)`,
  "a DOMParser type spread from an array with a trailing comma": `document.body.append(...new DOMParser().parseFromString(...[${IFRAME_MARKUP}, 'text/html',]).body.childNodes)`,
  "a DOMParser type spread into .call": `const p = new DOMParser(); document.body.append(...p.parseFromString.call(p, ...[${IFRAME_MARKUP}, 'text/html']).body.childNodes)`,
  "a bare innerHTML in a with block": `with (document.body) innerHTML = ${IFRAME_MARKUP}`,
  "markup awaited on the next line": `(async () => { document.body.innerHTML = await\n${IFRAME_MARKUP} })()`,
  "an onclick attribute node read by getAttributeNodeNS": `b.getAttributeNodeNS(null, 'onclick').value = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node read by getNamedItemNS": `b.attributes.getNamedItemNS(null, 'onclick').value = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node read from bracketed attributes": `b['attributes'].onclick.value = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node's value set by Object.assign": `Object.assign(b.attributes.onclick, {value: ${IFRAME_HANDLER}}); b.click()`,
  "a location key copied onto window": "Object.assign(window, {location: 'javascript:alert(1)'})",
  "a computed innerHTML key": `Object.assign(document.body, {['innerHTML']: ${IFRAME_MARKUP}})`,
  "markup inserted by execCommand": `document.execCommand('insertHTML', false, ${IFRAME_MARKUP})`,
  "an SVG link's href.baseVal": "a.href.baseVal = 'javascript:alert(1)'",
  "a navigation.navigate call": "navigation.navigate('javascript:alert(1)')",
};
// Literal sinks written other than as a plain call or assignment: an
// optional call, a tagged template, a callee named in brackets, a literal
// wrapped in a trivial expression, an object key Object.assign copies, a
// DOMParser document whose nodes the page takes, and an attribute node.
const LITERAL_SINKS: Record<string, string> = {
  ...INDIRECT_SINKS,
  "an optional setAttribute call": `b.setAttribute?.('onclick', ${IFRAME_HANDLER}); b.click()`,
  "an optional document.write call": `document.write?.(${IFRAME_MARKUP})`,
  "an optional insertAdjacentHTML call": `document.body.insertAdjacentHTML?.('beforeend', ${IFRAME_MARKUP})`,
  "an optional setHTMLUnsafe call": `document.body.setHTMLUnsafe?.(${IFRAME_MARKUP})`,
  "an optional location.assign call": "location.assign?.('javascript:alert(1)')",
  "an optional open call": "open?.('javascript:alert(1)')",
  "an optional location.replace call": "location.replace?.('javascript:alert(1)')",
  "a document.write tagged template": "document.write`<iframe src=https://e.test></iframe>`",
  "a location.assign tagged template": "location.assign`javascript:alert(1)`",
  "a setAttribute named in brackets": `b['setAttribute']('onclick', ${IFRAME_HANDLER}); b.click()`,
  "innerHTML set to a parenthesized string": `document.body.innerHTML = (${IFRAME_MARKUP})`,
  "innerHTML set to a comma expression": `document.body.innerHTML = (0, ${IFRAME_MARKUP})`,
  "innerHTML set to an || expression": `document.body.innerHTML = 0 || ${IFRAME_MARKUP}`,
  "innerHTML set to a conditional": `document.body.innerHTML = 1 ? ${IFRAME_MARKUP} : ''`,
  "innerHTML set to an && expression": `document.body.innerHTML = ready && ${IFRAME_MARKUP}`,
  "innerHTML set to a String.raw template": "document.body.innerHTML = String.raw`<iframe src=https://e.test></iframe>`",
  "innerHTML set to an array holding the markup": `document.body.innerHTML = [${IFRAME_MARKUP}]`,
  "a template substitution that writes the markup": `document.body.innerHTML = \`<p>\${${IFRAME_MARKUP}}</p>\``,
  "a parenthesized document.write argument": `document.write((${IFRAME_MARKUP}))`,
  "an href set to a parenthesized javascript: URL": "a.href = ('javascript:alert(1)')",
  "location set to an || expression of a javascript: URL": "location = 0 || 'javascript:alert(1)'",
  "an innerHTML key copied by Object.assign": `Object.assign(document.body, {innerHTML: ${IFRAME_MARKUP}})`,
  "a DOMParser document whose nodes the page takes": `document.body.append(...new DOMParser().parseFromString(${IFRAME_MARKUP}, 'text/html').body.childNodes)`,
  "a DOMParser document parsed as XHTML": `document.body.append(new DOMParser().parseFromString(${JSON.stringify('<div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://e.test"></iframe></div>')}, 'application/xhtml+xml').documentElement)`,
  "a DOMParser document whose type is computed": `document.body.append(...new DOMParser().parseFromString(${IFRAME_MARKUP}, kind).body.childNodes)`,
  "a DOMParser SVG document with a handler": `document.body.append(new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" onload="location=\\'javascript:alert(1)\\'"/>', 'image/svg+xml').documentElement)`,
  // XML elements in the XHTML namespace are HTML ones once the page takes them.
  "XML whose prefixed elements are in the XHTML namespace": `document.body.append(new DOMParser().parseFromString('<r xmlns:h="http://www.w3.org/1999/xhtml"><h:iframe src="https://e.test"/></r>', 'text/xml').documentElement)`,
  "XML that declares entities": `document.body.append(new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>', 'application/xml').documentElement)`,
  ...Object.fromEntries(Object.entries(XML_DOCUMENTS).map(([name, [xml, type]]) => [name, parsedXml(xml, type)])),
  "an onclick attribute node's value": `b.attributes.onclick.value = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node's textContent": `b.attributes.onclick.textContent = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node's nodeValue": `b.attributes['onclick'].nodeValue = ${IFRAME_HANDLER}; b.click()`,
  "an onclick attribute node read by getAttributeNode": `b.getAttributeNode('onclick').value = ${IFRAME_HANDLER}; b.click()`,
  "an href attribute node set to a javascript: URL": "a.attributes.href.value = 'javascript:alert(1)'",
  "an onclick attribute made by createAttribute": `const n = document.createAttribute('onclick'); n.value = ${IFRAME_HANDLER}; b.setAttributeNode(n); b.click()`,
  "an onclick attribute made by createAttributeNS": `const n = document.createAttributeNS(null, 'ONCLICK'); n.value = ${IFRAME_HANDLER}; b.setAttributeNode(n); b.click()`,
};

const REFUSED_MARKUP: Record<string, string> = {
  "an img whose error handler sets its own outerHTML": `<p>x</p><img src=x onerror="outerHTML='&lt;iframe src=https://e.test&gt;&lt;/iframe&gt;'">`,
  "an <iframe> written through octal escapes for <": ESCAPED_SINKS.octalMarkup,
  "an onclick that writes an <iframe> through octal escapes for <": ESCAPED_SINKS.octalMarkupInOnclick,
  "a javascript: URL spelled with an octal escape": ESCAPED_SINKS.octalLocation,
  "a data:text/html href spelled with an octal escape": ESCAPED_SINKS.octalHref,
  "an <iframe> after a handler hashbang written as an octal escape": ESCAPED_SINKS.octalHandlerHashbang,
  "an <iframe> after a written script's hashbang spelled as an octal escape": ESCAPED_SINKS.octalScriptHashbang,
  "an <iframe> written through braced escapes with leading zeros": ESCAPED_SINKS.longBracedMarkup,
  "a javascript: URL spelled with a braced escape with leading zeros": ESCAPED_SINKS.longBracedLocation,
  "an open() whose name is spelled with a braced escape": ESCAPED_SINKS.bracedName,
  "an href whose name is spelled with a four-digit escape": ESCAPED_SINKS.fourDigitName,
  "an innerHTML whose name is spelled with a braced escape": ESCAPED_SINKS.bracedProperty,
  ...Object.fromEntries(Object.entries(LITERAL_SINKS).map(([name, js]) => [name, literalSink(js)])),
  ...Object.fromEntries(Object.entries(DEEP_NESTED_SINKS).map(([name, html]) => [`an <iframe> written ${name} deep`, html])),
  // An on* attribute's value is a handler's body, run when the event fires.
  "a setAttribute onclick whose handler writes an <iframe>":
    `<p>x</p><button id=b>Go</button><script>b.setAttribute('onclick', "document.body.innerHTML='<iframe src=https://e.test></iframe>'"); b.click();</script>`,
  "a setAttribute onclick whose handler navigates to javascript:":
    `<p>x</p><button id=b>Go</button><script>b.setAttribute('onclick', "location='javascript:alert(1)'");</script>`,
  "a setAttribute ONCLICK named in a template whose handler navigates to javascript:":
    "<p>x</p><button id=b>Go</button><script>b.setAttribute(`ONCLICK`, \"location='javascript:alert(1)'\");</script>",
  "a setAttribute onclick named with an octal escape whose handler navigates to javascript:": String.raw`<p>x</p><button id=b>Go</button><script>b.setAttribute('\157nclick', "location='javascript:alert(1)'");</script>`,
  "a setAttributeNS onclick whose handler navigates to javascript:":
    `<p>x</p><button id=b>Go</button><script>b.setAttributeNS(null, 'onclick', "location='javascript:alert(1)'");</script>`,
  "a setAttribute.call onclick whose handler navigates to javascript:":
    `<p>x</p><button id=b>Go</button><script>Element.prototype.setAttribute.call(b, 'onclick', "location='javascript:alert(1)'");</script>`,
  "a setAttribute onclick whose handler hides a sink behind a hashbang":
    "<p>x</p><button id=b>Go</button><script>b.setAttribute('onclick', '#!/x/ `\\nlocation=\"javascript:alert(1)\"\\n//`');</script>",
  "a setAttribute.call href to a javascript: URL": "<p>x</p><a id=b>x</a><script>Element.prototype.setAttribute.call(b, 'href', 'javascript:alert(1)');</script>",
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
  "an <iframe> after a comment that opens a quoted value": '<!-- <p title=" --><iframe src="https://evil.test/"></iframe><!-- " -->',
  "a javascript: link after a comment that opens a script": '<!--<script>--><a href="javascript:alert(1)">x</a><!--</script>-->',
  "a <base> after a <textarea> that holds a script tag": '<textarea><script></textarea><base href="https://evil.test/"><textarea></script></textarea>',
  "a refresh <meta> after a <title> that holds a style tag": '<title><style></title><meta http-equiv="refresh" content="0;url=https://evil.test/"><title></style></title>',
  "an <embed> after a bogus comment that opens a quote": '<? <p title=" ><embed src="https://evil.test/x"><? " >',
  "an <embed> inside an svg <style>": '<svg><style><embed src="https://evil.test/x"></style></svg>',
  "a refresh <meta> inside an svg <style>": '<svg><style><meta http-equiv="refresh" content="0;url=https://evil.test/"></style></svg>',
  "an <embed> inside an svg <script>": '<svg><script><embed src="https://evil.test/x"></script></svg>',
  "an svg <script> that loads by href": '<svg><script href="https://evil.test/a.js"></script></svg>',
  "an svg <set> of href to javascript:": '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>',
  "an svg <animate> through javascript: values": '<svg><a><animate attributeName="xlink:href" values="#a; javascript:alert(1)"/><text>x</text></a></svg>',
  "an svg <set> of a prefixed href to javascript:": '<svg><a><set attributeName="q:href" to="javascript:alert(1)"/><text>x</text></a></svg>',
  "a location built from joined strings": '<script>location.href = "java" + "script:alert(1)"</script>',
  "a bracketed href set to a javascript: URL": '<script>a["href"] = "javascript:alert(1)"</script>',
  "a javascript: URL in escaped string characters": '<script>link.href = "\\x6aavascript:alert(1)"</script>',
  "innerHTML that writes an <iframe>": '<script>document.body.innerHTML = "<iframe src=https://evil.test/></iframe>"</script>',
  "insertAdjacentHTML that writes a javascript: link": "<script>el.insertAdjacentHTML('beforeend', `<a href=\"javascript:alert(1)\">x</a>`)</script>",
  "document.write of a <base>": '<script>document.write("<base href=https://evil.test/>")</script>',
  "a javascript: URL after a regex that follows an if head": "<script>if (x) /\"/.test(y); location='javascript:alert(1)'</script>",
  "a javascript: URL after a regex that follows a while head": "<script>while (x) /'/.exec(y); location='javascript:alert(1)'</script>",
  "a javascript: URL after a regex that follows a for await head": "<script>for await (const x of y) /`/.test(x); location='javascript:alert(1)'</script>",
  "an <iframe> written after a division that follows a with method call":
    '<script>[1,2].with(0,3) /1; document.body.innerHTML = "<iframe src=https://evil.test/></iframe>"; 2/ 1</script>',
  "a javascript: URL after a division that follows an if method call": "<script>o.if() /1; location='javascript:alert(1)'; 2/ 1</script>",
  "a javascript: URL after a division that follows a for method call": "<script>o?.for() /1; location='javascript:alert(1)'; 2/ 1</script>",
  "a javascript: URL after a division that follows a while method call": "<script>o.while(x) /1; location='javascript:alert(1)'; 2/ 1</script>",
  "an onclick that navigates after a division that follows an if method call":
    "<button onclick=\"o.if() /1; location='javascript:alert(1)'; 2/ 1\">Go</button>",
  "an onclick that navigates after a division that follows a with method call":
    "<button onclick=\"[1,2].with(0,3) /1; location='javascript:alert(1)'; 2/ 1\">Go</button>",
  "an onclick that navigates after a division that follows a for method call":
    "<button onclick=\"o.for() /1; location='javascript:alert(1)'; 2/ 1\">Go</button>",
  // A / that could start a regex or divide: each is a division in real
  // JavaScript, so the sink between the two slashes runs.
  "an <iframe> written after a division that follows an object literal":
    '<script>var a={}/1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a postfix increment":
    '<script>var i=0; var a=i++ /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a property named of":
    '<script>var o={of:4}; var a=o.of /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a variable named of":
    '<script>var of=4; var a=of /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a variable named yield":
    '<script>var yield=4; var a=yield /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a variable named await":
    '<script>var await=4; var a=await /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a property named in":
    '<script>var o={in:4}; var a=o.in /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "an <iframe> written after a division that follows a property named return":
    '<script>var o={return:4}; var a=o.return /1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; var b=2/ 1;</script>',
  "a javascript: URL after a division that follows a template literal":
    "<script>var t=`a${1}b` /1; location='javascript:alert(1)'; var b=2/ 1;</script>",
  "an onclick that navigates after a division that follows an object literal":
    "<button onclick=\"var a={}/1; location='javascript:alert(1)'; var b=2/ 1\">Go</button>",
  "an onclick that navigates after a division that follows a postfix increment":
    "<button onclick=\"var i=0; var a=i++ /1; location='javascript:alert(1)'; var b=2/ 1\">Go</button>",
  "an onclick that navigates after a division that follows a variable named of":
    "<button onclick=\"var of=4; var a=of /1; location='javascript:alert(1)'; var b=2/ 1\">Go</button>",
  // <!-- anywhere and --> at the start of a line begin a line comment in a
  // classic script or handler, so the /* after them opens nothing.
  "an <iframe> written after an HTML-like comment opener":
    '<script><!-- /*\ndocument.body.innerHTML="<iframe src=https://e.test></iframe>";\n// */</script>',
  "an <iframe> written after an HTML-like comment closer at a line start":
    '<script>var z=1;\n--> /*\ndocument.body.innerHTML="<iframe src=https://e.test></iframe>";\n// */</script>',
  "an onclick that navigates after an HTML-like comment opener":
    "<button onclick=\"<!-- /*\nlocation='javascript:alert(1)'\n// */\">Go</button>",
  "an <iframe> in a template 2 KB past a division after an object literal": `<script>${farTemplateSink(2100, 'document.body.innerHTML="<iframe src=https://e.test></iframe>"')}</script>`,
  "an <iframe> in a template 4 KB past a division after an object literal": `<script>${farTemplateSink(4000, 'document.body.innerHTML="<iframe src=https://e.test></iframe>"')}</script>`,
  "an <iframe> in a template 2 KB past a regex-like division followed by in": `<script>${farTemplateSink(2100, 'document.body.innerHTML="<iframe src=https://e.test></iframe>"', " in o")}</script>`,
  "an <iframe> after a regex that a class extends": `<script>class A extends /\`/.constructor {}\ndocument.body.innerHTML="<iframe src=https://e.test></iframe>";\n// \`</script>`,
  "an <iframe> after a regex that a module exports by default": `<script type="module">export default /\`/;\ndocument.body.innerHTML="<iframe src=https://e.test></iframe>";\n// \`</script>`,
  // A private name spells a keyword but is a name: the / after it divides.
  "an <iframe> after a division by a private field named default": `<script>class A{#default=1;m(){var q=this.#default/1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; return 0//\n}}new A().m();</script>`,
  "an <iframe> after a division by a private field named return": `<script>class A{#return=1;m(){var q=this.#return/1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; return 0//\n}}new A().m();</script>`,
  "an <iframe> after a division by a private field read through ?.": `<script>class A{#typeof=1;m(){var q=this?.#typeof/1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; return 0//\n}}new A().m();</script>`,
  "an <iframe> after a division by a private method named if": `<script>class A{#if(){return 4} m(){var q=this.#if()/1; document.body.innerHTML="<iframe src=https://e.test></iframe>"; return 0//\n}} new A().m();</script>`,
  // A #! at the very start of a script is a line comment, so the rest of
  // that line opens no template, string or comment.
  "an <iframe> after a hashbang that names a template": HASHBANG_SINKS.template,
  "an <iframe> after a hashbang that names a block comment": HASHBANG_SINKS.blockComment,
  "an <iframe> after a hashbang in a module": HASHBANG_SINKS.module,
  "an <iframe> after a hashbang that follows a byte order mark": HASHBANG_SINKS.byteOrderMark,
  "an <iframe> after a hashbang that starts an svg onload": HASHBANG_SINKS.svgOnload,
  "an <iframe> after a hashbang written as &#35;! that starts an img onerror": HASHBANG_SINKS.imgOnerrorEntity,
  "an <iframe> after a handler hashbang ended by a line separator": HASHBANG_SINKS.handlerLineSeparator,
  "an <iframe> after a handler hashbang that names a block comment": HASHBANG_SINKS.handlerBlockComment,
  "an <iframe> after a hashbang that starts a handler written by innerHTML": HASHBANG_SINKS.handlerInInnerHtml,
  "an onclick that navigates from a template 2 KB past a division after an object literal": `<button onclick="${farTemplateSink(2100, "location='javascript:alert(1)'")}">Go</button>`,
  "an onclick that navigates from a template 4 KB past a division after an object literal": `<button onclick="${farTemplateSink(4000, "location='javascript:alert(1)'")}">Go</button>`,
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
  "a code sample that shows an <iframe> as text": '<pre><code>&lt;iframe src="https://x"&gt;</code></pre>',
  "a script string that holds a tag": '<script>const s = "<iframe>"; el.textContent = s;</script>',
  "a comment that holds a tag": "<!-- <iframe src=\"https://evil.test/\"> was here -->",
  "a script loop bound named like a tag": "<script>for (let i=0;i<iframes;i++){}</script>",
  "an svg <use> of a local id": '<svg><use href="#a"/></svg>',
  "a data: PNG image": '<img src="data:image/png;base64,AAAA">',
  "an svg <set> of a fill named javascript:": '<svg><rect><set attributeName="fill" to="javascript:"/></rect></svg>',
  "an svg <set> of an attribute whose name ends in href": '<svg><rect><set attributeName="data-href" to="javascript:"/></rect></svg>',
  "innerHTML that writes a label naming JavaScript": '<script>legend.innerHTML = "<b>JavaScript: 41%</b>";</script>',
  "a division after a parenthesized value": "<script>var r = (a) / 2; var s = \"/\"; location='https://x';</script>",
  "a division inside an if body": '<script>if (x) { y = (a + b) / "2"; }</script>',
  "a regex after a block": '<script>if (ok) { draw(); } /^#/.test(location.hash) && open(); var w = n++ / 2;</script>',
  "a division after a template literal": "<script>var h = `${rows}` / 2; label.textContent = h + ' rows';</script>",
  "a class with private fields that divides them and checks a brand with in":
    "<script>class Meter { #count = 3; #max = 8; #brand = true; static is(o) { return #brand in o; } ratio() { return this.#count / this.#max; } }\nconst m = new Meter(); bar.style.width = m.ratio() * 100 + '%'; label.textContent = Meter.is(m) ? `${m.ratio()} / 1` : '';</script>",
  "escaped strings that decode to digits, a null and a copyright sign":
    String.raw`<script>label.textContent = '\0' + ' v1.0 \251 2026 \8\9'; legend.innerHTML = '<b>\61\62</b>'; note.textContent = ` + "`\\0 rows`;</script>",
  "setAttribute handlers that toggle, open an https page or label with markup, and a title that names javascript:":
    `<button id=b>Go</button><script>b.setAttribute('onclick', 'toggle()'); b.setAttributeNS(null, 'onmouseover', "location='https://example.com/'"); b.setAttribute('onfocus', "legend.innerHTML='<b>Hi</b>'"); b.setAttribute('title', "location='javascript:alert(1)'"); fn.call(o, 'onclick', "location='javascript:alert(1)'");</script>`,
  "values that reach no sink: a statement after an href on the next line, a key after an href key, wrapped labels and an attribute node that is not a handler":
    literalSink(
      [
        "a.href = next",
        "label.textContent = 'javascript: is a URL scheme'",
        "const link = {href: '#top', label: 'javascript: links'}",
        "legend.innerHTML = ready ? '<b>Ready</b>' : ('<i>Waiting</i>')",
        "a.href = '#' + (hash || 'javascript: notes')",
        "a.attributes.title.value = 'javascript: notes'",
        "const t = document.createAttribute('title')",
        "note.textContent = String.raw`<iframe>`",
      ].join("\n"),
    ),
  "markup and URLs built by joining strings with values": literalSink(
    [
      `list.innerHTML = '<a href="' + url + '">' + label + '</a>'`,
      "row.innerHTML = '<td>' + v + '</td>'",
      `pic.innerHTML = '<img alt="" src="data:image/png;base64,' + b64 + '">'`,
      "location.href = base + '?q=' + encodeURIComponent(q)",
      "location.href = base + 'javascript: notes'",
      "location.href = base + ('java') + 'script: notes'",
      "location.href = (base + 'java') + 'script: notes'",
      "location.assign('/notes/' + id + ('java') + 'script:')",
      "a.href = `/search?q=${q}&page=${''}1`",
    ].join("\n"),
  ),
  "calls that pass no sink a value: .call of a plain function or of replace, a bound function with arguments, a title spread into setAttribute and keys that are not sinks": literalSink(
    [
      `fn.call(o, 'onclick', "location='javascript:alert(1)'")`,
      "label.textContent = String.prototype.replace.call(name, 'javascript:', '')",
      // Bound with its name, this sets title to "onclick".
      `b.setAttribute.bind(b, 'title')('onclick', "location='javascript:alert(1)'")`,
      "b.setAttribute(...['title', 'javascript: notes'])",
      "(0, console.log)('<iframe src=https://e.test></iframe>')",
      "Object.assign(settings, {value: 'javascript: notes', location: '#home'})",
      "if (ready) ('javascript: notes').length",
      "b.getAttributeNodeNS(null, 'title').value = 'javascript: notes'",
    ].join("\n"),
  ),
  // XML in no HTML, SVG or MathML namespace builds no element the page runs
  // or loads, and DOMParser throws for a type it does not know.
  "a script that reads an RSS feed, an Atom feed and a config file with DOMParser":
    literalSink(
      [
        `const rss = new DOMParser().parseFromString('<rss version="2.0"><channel><title>News</title><link>https://example.com/</link><item><title>A &amp; B</title><link>https://example.com/a</link></item></channel></rss>', 'text/xml')`,
        `const atom = new DOMParser().parseFromString(\`<feed xmlns="http://www.w3.org/2005/Atom"><link href="https://example.com/"/><entry><title>\${title}</title></entry></feed>\`, 'application/xml')`,
        `const config = new DOMParser().parseFromString('<config><script src="https://e.test/x.js"/><iframe src="https://e.test"/></config>', "text/xml")`,
        `const none = new DOMParser().parseFromString('<iframe src="https://e.test"></iframe>', 'text/plain')`,
        // XHTML and SVG types parse XML too: without a namespace these are plain XML elements.
        `const page = new DOMParser().parseFromString('<page><title>Notes</title><iframe src="https://e.test"/></page>', 'application/xhtml+xml')`,
        // An SVG icon's <title> and <style> hold only text, which HTML reads as XML does.
        `const icon = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Close &amp; exit</title><style><![CDATA[ .a > path { fill: currentColor } ]]></style><path class="a" d="M4 12h16"/><a href="#top"><circle r="2"/></a></svg>', 'image/svg+xml')`,
        // XML builds nothing from a comment, so what one names is not read.
        `const notes = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><!-- note: icons never use <script> --><!--Note:style is inline--><style><!--TODO:link to docs--> path { fill: red }</style><path d="M0 0"/></svg>', 'image/svg+xml')`,
        `const doc = new DOMParser().parseFromString('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hi</p></body></html>', 'application/xhtml+xml')`,
        "label.textContent = rss.querySelector('item title').textContent + atom.title + config.documentElement.childElementCount + page.title",
        "document.body.append(icon.documentElement, doc.body.firstChild, notes.documentElement)",
      ].join("\n"),
    ),
  // A handler past the depth cap with no string in it has nothing to write.
  "setAttribute handlers nested four deep whose innermost one only removes its button": NESTED_LAYERS.setAttribute(4, "this.remove()"),
  "names spelled with escapes that are not sinks": String.raw`<script>const \u{6C}abel = document.body; \u{6C}abel.textContent = 'ready'; a.\u{74}itle = 'javascript: notes';</script>`,
  // A hashbang line is a comment, so what it names never runs.
  "a script whose hashbang line names a javascript: URL": "<script>#!/usr/bin/env node location='javascript:void 0'\nlabel.textContent = 'ready';</script>",
  // Read as a regex, `/ 2; … rows /` would be followed by a name (`$`): a syntax
  // error, so only the division reading can run. Followed to the end, each
  // such line would cost the rest of a 60 KB script.
  "a division after an increment with a template later on the line, repeated through a long script": `<script>${repeatedLine("i++ / 2; const t = `${rows} rows / ${cols} cols`;")}</script>`,
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

// An independent reading of what a browser would load: parse5 builds the
// document tree (as Chromium's parser does) and this walks every element,
// including <template> contents, for an embedding tag, an external script, a
// refresh <meta>, or an unsafe or remote URL attribute. A visual renders in a
// frame that runs scripts, but a viewer or an exported page may have them
// off, which turns <noscript> text into markup, so both parses count. A
// <select> is left out: parse5 drops the tags in it that Chromium builds, and
// its own test below lists what a <select> may hold.
const ORACLE_EMBEDDING_TAGS = new Set(["iframe", "object", "embed", "applet", "frame", "frameset", "base", "link"]);
const ORACLE_URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "data"]);
function browserLoadsSomething(html: string): boolean {
  let found = false;
  const walk = (node: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      const attributes = new Map(child.attrs.map((attribute) => [(attribute.prefix ? `${attribute.prefix}:` : "") + attribute.name, attribute.value]));
      if (ORACLE_EMBEDDING_TAGS.has(child.tagName)) found = true;
      if (child.tagName === "script" && (attributes.has("src") || attributes.has("href") || attributes.has("xlink:href"))) found = true;
      if (child.tagName === "meta" && attributes.has("http-equiv")) found = true;
      for (const [name, value] of attributes) {
        const url = value.replace(/[\t\n\r]/gu, "").replace(/^[\0-\x20]+/u, "").toLowerCase();
        if (ORACLE_URL_ATTRIBUTES.has(name) && /^(?:javascript:|data:\s*text\/html)/u.test(url)) found = true;
        if (name === "src" && /^https?:\/\//u.test(url)) found = true;
      }
      walk(child);
      if (child.tagName === "template") walk((child as DefaultTreeAdapterTypes.Template).content);
    }
  };
  walk(parse(html));
  walk(parse(html, { scriptingEnabled: false }));
  return found;
}

const ORACLE_CONTAINERS: readonly (readonly [string, string])[] = [
  ["", ""],
  ["<!--", "-->"],
  ["<!-- <p title=\"", "\" -->"],
  ["<?", ">"],
  ["<textarea>", "</textarea>"],
  ["<title>", "</title>"],
  ["<style>", "</style>"],
  ["<xmp>", "</xmp>"],
  ["<noscript>", "</noscript>"],
  ["<noscript><p title=\"</noscript>", "\"></noscript>"],
  ["<head><noscript>", "</noscript></head>"],
  ["<noembed>", "</noembed>"],
  ["<noframes>", "</noframes>"],
  ["<template>", "</template>"],
  ["<table><tr>", "</tr></table>"],
  ["<p title=\"", "\">"],
  ["<svg><style>", "</style></svg>"],
  ["<svg><script>", "</script></svg>"],
  ["<svg><![CDATA[", "]]></svg>"],
  ["<svg><desc>", "</desc></svg>"],
  ["<math><mi>", "</mi></math>"],
  ["<math><annotation-xml encoding=\"text/html\">", "</annotation-xml></math>"],
  ["<plaintext>", ""],
];
const ORACLE_PAYLOADS: readonly string[] = [
  '<iframe src="https://evil.test/"></iframe>',
  '<base href="https://evil.test/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
  '<script src="https://evil.test/a.js"></script>',
  '<a href="javascript:alert(1)">x</a>',
  '<img src="https://evil.test/a.png">',
  "<p>Revenue up 4%</p>",
  '<svg><rect aria-label="JavaScript: 41%"></rect></svg>',
];

test("html admission refuses exactly what a browser's parse of the markup would load", () => {
  let refused = 0;
  for (const [open, close] of ORACLE_CONTAINERS) {
    for (const payload of ORACLE_PAYLOADS) {
      const html = `<p>Lead</p>${open}${payload}${close}<p>Tail</p>`;
      const expected = browserLoadsSomething(html);
      let admitted = true;
      try {
        validateGenerativeUiHtml(html);
      } catch {
        admitted = false;
      }
      assert.equal(admitted, !expected, `${expected ? "should refuse" : "should admit"} ${html}`);
      assert.equal(isGenerativeUiDraftAcceptable(html), !expected, `draft verdict for ${html}`);
      // Streamed a few characters at a time, a draft refuses at least as much
      // (a tag still being written counts before the parser may drop it).
      if (expected) assert.equal(streamInChunks(html, 3).admitted, false, `streamed draft verdict for ${html}`);
      if (expected) refused += 1;
    }
  }
  // The corpus exercises both verdicts.
  assert.ok(refused > 20 && refused < ORACLE_CONTAINERS.length * ORACLE_PAYLOADS.length - 20);
});

test("html admission names the XML a script parses that it cannot read as the browser does, and what to change", () => {
  const declared = literalSink(parsedXml(`<!DOCTYPE r [<!ENTITY e "<img src=x>">]><r>&e;</r>`, "text/xml"));
  assert.throws(() => validateGenerativeUiHtml(declared), /DOCTYPE internal subset, an <!ENTITY> or an <!ATTLIST> declaration\. Remove the DOCTYPE internal subset/u);
  const cdata = literalSink(parsedXml(`<r xmlns="${XHTML_NS}"><![CDATA[ <x> ]]></r>`, "image/svg+xml"));
  assert.throws(() => validateGenerativeUiHtml(cdata), /names the XHTML, SVG or MathML namespace, so it is checked as HTML.*Give those elements text only/u);
  // HTML ends a processing instruction or DOCTYPE at its first >, so what
  // XML reads as the rest of it HTML reads as markup.
  const instruction = literalSink(parsedXml(`<r xmlns="${XHTML_NS}"><?x > <!-- ?>${XML_ERROR_IMG}<!-- --></r>`, "text/xml"));
  const doctype = literalSink(parsedXml(`<!DOCTYPE r SYSTEM "a>b<!--"><r xmlns="${XHTML_NS}"><!-- -->${XML_ERROR_IMG}</r>`, "text/xml"));
  for (const html of [instruction, doctype]) {
    assert.throws(() => validateGenerativeUiHtml(html), /processing instruction or DOCTYPE holding < or >.*Remove the < and > from the processing instruction or DOCTYPE/u);
  }
  for (const html of [declared, cdata, instruction, doctype]) assert.equal(isGenerativeUiDraftAcceptable(html), false);
  const declarations = literalSink(
    parsedXml(
      `<?xml version="1.0"?><?xml-stylesheet href="a.xsl" type="text/xsl"?><!DOCTYPE note SYSTEM "note.dtd"><r xmlns="${XHTML_NS}"><!-- note --><p>Hi</p></r>`,
      "text/xml",
    ),
  );
  assert.ok(validateGenerativeUiHtml(declarations).byteLength > 0);
  assert.equal(isGenerativeUiDraftAcceptable(declarations), true);
});

// parse5 still drops every tag in a <select> but its options, where
// Chromium's customizable <select> builds them, and an <svg>, <math> or
// <style> there is read as SVG, MathML or CSS, as Chromium reads it. Inside
// that SVG or MathML only SVG and MathML tags are admitted, since Chromium
// reads any other tag there by its in-body rules and parse5 by the select's.
test("html admission reads the elements a <select> holds as Chromium builds them, written or set by a script, finished or streaming", () => {
  const errorImage = `<img src=x onerror="location='javascript:alert(1)'">`;
  const setBySelect = (html: string) => `<div id="d"></div><script>d.innerHTML = '${html.replace(/'/gu, "\\'")}';</script>`;
  const refused: Record<string, [string, RegExp]> = {
    "an image's handler": [`<select>${errorImage}</select>`, /found "onerror=/u],
    "an image's handler set by a script": [setBySelect(`<select>${errorImage}</select>`), /cannot load remote images or scripts/u],
    "a remote image": ['<select><option>a</option><img src="https://evil.test/a.png"></select>', /found "src=/u],
    "a frame": ['<select><iframe src="about:blank"></iframe></select>', /cannot include iframes/u],
    "an SVG script, which decodes character references": [
      "<select><svg><script>location&#61;'javascript:alert(1)'</script></svg></select>",
      /found "location=/u,
    ],
    "an SVG link in an option": ['<select><option><svg><a href="javascript:alert(1)"><text>t</text></a></svg>Red</option></select>', /found "href=/u],
    "an SVG link set by a script": [
      setBySelect('<select><option><svg><a href="javascript:alert(1)"><text>t</text></a></svg>Red</option></select>'),
      /cannot load remote images or scripts/u,
    ],
    "an SVG <set> of href": ['<select><option><svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg></option></select>', /found "to=/u],
    "an image in an SVG <foreignObject>": [
      `<select><option><svg><foreignObject>${errorImage}</foreignObject></svg></option></select>`,
      /<img> inside an <svg> or <math> in a <select> is read differently by the browser and the check\. Keep only SVG or MathML/u,
    ],
    "an image in MathML text": [`<select><option><math><mi>${errorImage}</mi></math></option></select>`, /<img> inside an <svg> or <math> in a <select>/u],
    "a style sheet": ['<select><style>p{background:url("javascript:alert(1)")}</style></select>', /found "url\(\\"javascript:alert\(1\)\\"\)"/u],
    "a style sheet in an SVG <foreignObject>": [
      '<select><option><svg><foreignObject><style>p{background:url(javascript:alert(1))}</style></foreignObject></svg></option></select>',
      /<style> inside an <svg> or <math> in a <select>/u,
    ],
    // Chromium builds the <div> in the <desc> and leaves the <svg> at </desc>,
    // so it reads the CDATA opener as a comment ending at its first > and
    // builds the image; parse5 drops the <div> and reads the CDATA as text.
    "an image after a <div> in an SVG <desc>": [
      `<select><svg><desc><div></desc><![CDATA[>${errorImage}]]></svg></select>`,
      /<div> inside an <svg> or <math> in a <select>/u,
    ],
    "an image after HTML that leaves an <svg>": [`<select><svg><b>x</b><![CDATA[>${errorImage}]]></svg></select>`, /<b> inside an <svg> or <math>/u],
    "an image after a </p> in an <svg>": [`<select><svg></p><![CDATA[>${errorImage}]]></svg></select>`, /<\/p> inside an <svg> or <math>/u],
    // Chromium closes the <svg> at </option> and reads the CDATA opener as a
    // comment ending at its first >, so the image is built.
    "an image after an SVG an option's end tag closes": [
      `<select><option><svg></option><![CDATA[></select>${errorImage}]]></select>`,
      /<\/option> inside an <svg> or <math> in a <select> is read differently by the browser and the check\. Keep only SVG or MathML inside an <svg> or <math> in a <select>, closing each with its own end tag/u,
    ],
    "a script after MathML a <div>'s end tag closes": [
      `<select><div><math><mi>x</mi></div><script>location&#61;'#';document.body.innerHTML='<iframe></iframe>'</script></select>`,
      /<\/div> inside an <svg> or <math>/u,
    ],
    // Chromium ignores a </select> inside a <foreignObject>, so the <svg>
    // stays open and its <script> decodes &#39;.
    "an SVG script after a </select> in a <foreignObject>": [
      `<select><svg><foreignObject></select></foreignObject><script>x='&#39;';document.body.innerHTML='<iframe></iframe>'</script></svg>`,
      /<\/select> inside an <svg> or <math>/u,
    ],
    // Chromium reads an <xmp>'s content as text up to </xmp>, so the comment
    // opener is text and the frame is built; parse5 drops the <xmp> and reads
    // a comment that hides the frame.
    "a frame after an <xmp> in an option": [
      '<select><option><xmp><!--</xmp><iframe src="https://evil.test/"></iframe>--></option></select>',
      /<xmp> in a <select> has content the browser reads as text and the check reads as markup\. Move the <xmp> out of the <select>\./u,
    ],
    "an image after a <textarea> in an SVG <foreignObject>": [
      `<select><svg><foreignObject><textarea><!--</textarea>${errorImage}--></foreignObject></svg></select>`,
      /Move the <textarea> out of the <select>/u,
    ],
    "an image after a <noframes> in MathML text": [`<select><math><mtext><noframes><!--</noframes>${errorImage}--></mtext></math></select>`, /Move the <noframes> out/u],
  };
  for (const [name, [html, message]] of Object.entries(refused)) {
    assert.throws(() => validateGenerativeUiHtml(html), message, name);
    assert.equal(isGenerativeUiDraftAcceptable(html), false, `draft verdict for ${name}`);
    for (const chunk of [1, 7, 64]) assert.equal(streamInChunks(html, chunk).admitted, false, `draft verdict for ${name} streamed by ${chunk}`);
  }
  const icon = '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5"/><path d="M1 1L5 5"/></svg>';
  const admitted = [
    '<select><option>One</option><img src="data:image/png;base64,AA" alt=""><button onclick="this.textContent=\'x\'">b</button></select>',
    "<select><template><svg><rect/></svg></template></select><svg><rect/></svg>",
    `<style>select,::picker(select){appearance:base-select}</style><select><button><selectedcontent></selectedcontent></button><option>${icon} Red</option><option>Blue</option></select>`,
    `<select><option>${icon}Red</option></select>`,
    `<select><button>${icon}</button><option>A</option></select>`,
    "<select><option>Red</option><style>option{color:red}</style></select>",
    '<select><option><svg><style>.c{fill:red}</style><rect class="c" width="4" height="4"/></svg>Red</option></select>',
    "<select><option><math><mi>x</mi><mo>=</mo><mn>2</mn></math></option></select>",
    "<template><select><svg><circle r=1></circle></svg></select></template>",
    "<table><tr><td><select><svg><text>t</text></svg><option>a</option></select></td></tr></table>",
    '<select><option><svg><title>Red</title><rect width="4" height="4"/></svg>Red</option></select>',
    "<select><option><svg><circle r=1></select><p>after</p>",
    "<select><option>Notes</option></select><textarea>x</textarea>",
    "<select><template><xmp>x</xmp></template></select>",
    // An SVG <select> left open: the host's closing markup after the visual
    // does not refuse what the streamed draft admitted.
    "<select><svg><select>C",
    setBySelect(`<select><option>${icon}Red</option></select>`),
  ];
  for (const html of admitted) {
    assert.ok(validateGenerativeUiHtml(html).byteLength > 0, html);
    assert.equal(isGenerativeUiDraftAcceptable(html), true, html);
    for (const chunk of [1, 7, 64]) assert.deepEqual(streamInChunks(html, chunk), { admitted: true, shown: html }, `${html} streamed by ${chunk}`);
  }
});

// Chromium ignores an end tag that names an SVG <title> or <desc>, or MathML
// text, around an open HTML element, so it stays in that element and reads
// the CDATA opener as a bogus comment ending at its first >. parse5 pops to
// the SVG or MathML element and reads the CDATA as text.
test("html admission refuses an end tag that closes SVG or MathML around open HTML, finished or streaming", () => {
  const errorImage = `<img src=x onerror="location='javascript:alert(1)'">`;
  const refused: Record<string, [string, string]> = {
    "an SVG <title>": [`<div><svg><title><b>x</title><![CDATA[x>${errorImage}]]></svg></div>`, "title"],
    "an SVG <desc>": [`<div><svg><desc><b>x</desc><![CDATA[x>${errorImage}]]></svg></div>`, "desc"],
    "a MathML <mi>": [`<div><math><mi><b>x</mi><![CDATA[x>${errorImage}]]></math></div>`, "mi"],
    "a MathML <mtext>": [`<div><math><mtext><span>x</mtext><![CDATA[x>${errorImage}]]></math></div>`, "mtext"],
    "a MathML <annotation-xml>": [
      `<div><math><annotation-xml encoding="text/html"><b>x</annotation-xml><![CDATA[x>${errorImage}]]></math></div>`,
      "annotation-xml",
    ],
    "an SVG <title> around a nested <svg>": [`<svg><title><span><svg><g></title><![CDATA[x>${errorImage}]]></svg>`, "title"],
  };
  for (const [name, [html, tag]] of Object.entries(refused)) {
    const message = new RegExp(`</${tag}> ends an SVG or MathML element around an open HTML element, which the browser leaves open\\. Close the HTML elements`, "u");
    assert.throws(() => validateGenerativeUiHtml(html), message, name);
    assert.equal(isGenerativeUiDraftAcceptable(html), false, `draft verdict for ${name}`);
    for (const chunk of [1, 7, 64]) assert.equal(streamInChunks(html, chunk).admitted, false, `draft verdict for ${name} streamed by ${chunk}`);
  }
  const admitted = [
    '<svg><title>Chart</title><rect width="4" height="4"/></svg>',
    "<math><mtext>x</mtext></math>",
    "<div><svg><title><b>x</b></title><rect/></svg></div>",
    '<svg width="100" height="40"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml">Hi <b>there</b></div></foreignObject></svg>',
    "<svg><foreignObject><div><p>Hi</foreignObject></svg>",
    "<svg><text><tspan>a</tspan></text></svg><b><i>x</b></i>",
  ];
  for (const html of admitted) {
    assert.ok(validateGenerativeUiHtml(html).byteLength > 0, html);
    assert.equal(isGenerativeUiDraftAcceptable(html), true, html);
    for (const chunk of [1, 7, 64]) assert.deepEqual(streamInChunks(html, chunk), { admitted: true, shown: html }, `${html} streamed by ${chunk}`);
  }
});

test("html admission refuses markup nested or attributed past what a visual needs, finished or streaming", () => {
  const attributes = (count: number) => Array.from({ length: count }, (_, index) => ` a${index}`).join("");
  const refused = {
    deep: "<div>".repeat(600),
    attributes: `<p${attributes(600)}>x</p>`,
    adopted: Array.from({ length: 600 }, (_, index) => `<html b${index}>`).join(""),
    movedOutOfTable: `<table>${"a<i></i>".repeat(9000)}</table>`,
  };
  for (const html of Object.values(refused)) {
    assert.throws(() => validateGenerativeUiHtml(html), /too complex to check/u);
    assert.equal(isGenerativeUiDraftAcceptable(html), false);
  }
  const admitted = [`${"<div>".repeat(400)}x`, `<p${attributes(400)}>x</p>`, `<table>${"a<i></i>".repeat(7000)}</table>`];
  for (const html of admitted) {
    assert.ok(validateGenerativeUiHtml(html).byteLength > 0);
    assert.equal(isGenerativeUiDraftAcceptable(html), true);
  }
});

// Full documents whose wrapped fragment carries a load that the document as
// written hides: the wrapper cuts out the first <body>...</body> (or the
// head's inline scripts) by text, wherever the parser would have put it.
const HIDDEN_BY_THE_DOCUMENT: Record<string, string> = {
  "a <body> inside a <textarea>": '<textarea><body><a href="javascript:alert(1)">x</a></body></textarea>',
  "a <body> inside a comment": '<!-- <body> <a href="javascript:alert(1)">x</a> </body> -->',
  "a <body> inside a <title>": '<title><body><iframe src="https://evil.test/"></iframe></body></title>',
  "a <body> inside a script string": "<script>var s = \"<body><a href='javascript:alert(1)'>x</a></body>\";</script>",
  "a <body> inside a style comment": '<style>/* <body><a href="javascript:alert(1)">x</a></body> */</style>',
  "a <body> inside an attribute value": "<p title=\"<body><a href='javascript:alert(1)'>x</a></body>\">x</p>",
  "a head script inside a comment": "<!doctype html><head><!-- <script>location='javascript:alert(1)'</script> --></head><body>x</body>",
  "a head style inside a <title>": "<!doctype html><head><title><style>a{background:url(javascript:alert(1))}</style></title></head><body>x</body>",
};

for (const [name, html] of Object.entries(HIDDEN_BY_THE_DOCUMENT)) {
  test(`every render path refuses what it would render from ${name}`, () => {
    assert.throws(() => validateGenerativeUiHtml(html), /cannot/u);
    assert.throws(() => wrapGenerativeUiHtml(html, TITLE), /cannot/u);
    assert.throws(() => wrapGenerativeUiHtml(html, TITLE, undefined, { inline: true }), /cannot/u);
    assert.throws(() => wrapGenerativeUiHtml(html, TITLE, undefined, { stillImage: true }), /cannot/u);
    assert.throws(() => generativeUiExportDocument(html, TITLE, {}), /cannot/u);
  });
}

test("a full document's body and head are still rendered when nothing hides in them", () => {
  const html = "<!doctype html><html><head><title>t</title><style>p{color:red}</style></head><body><p title=\"<b>\">x</p><textarea><a></textarea></body></html>";
  assert.ok(validateGenerativeUiHtml(html).byteLength > 0);
  const document = wrapGenerativeUiHtml(html, TITLE);
  assert.ok(document.includes("<style>p{color:red}</style>\n<p title=\"<b>\">x</p><textarea><a></textarea>\n</body>"));
});

test("a streaming draft cut inside a script or a quoted attribute is read as script or value, not as tags", () => {
  assert.equal(isGenerativeUiDraftAcceptable("<script>for (let i = 0; i<base && i>0"), true);
  assert.equal(isGenerativeUiDraftAcceptable('<p title="a <link> tag'), true);
  assert.equal(isGenerativeUiDraftAcceptable("<p>Chart</p><iframe"), false);
  assert.equal(isGenerativeUiDraftAcceptable('<a href="javascript:'), false);
});

test("a hashbang streamed in pieces, even split between # and !, is still read as a comment", () => {
  for (const html of Object.values(HASHBANG_SINKS)) {
    const scriptStart = html.search(/#!|&#35;!/u);
    for (const chunk of [1, 3, scriptStart + 1]) {
      assert.equal(streamInChunks(html, chunk).admitted, false, `${chunk}-character pieces of ${html}`);
    }
  }
});

test("an escaped sink streamed in pieces, even split inside its escape, is refused", () => {
  for (const html of Object.values(ESCAPED_SINKS)) {
    const escapeAt = html.indexOf("\\");
    for (const chunk of [1, 2, 5, escapeAt + 2]) {
      assert.equal(streamInChunks(html, chunk).admitted, false, `${chunk}-character pieces of ${html}`);
    }
  }
});

test("a sink nested past the depth the check reads again is refused, streamed in pieces too", () => {
  for (const html of Object.values(DEEP_NESTED_SINKS)) {
    for (const chunk of [1, 7, 64]) {
      assert.equal(streamInChunks(html, chunk).admitted, false, `${chunk}-character pieces of ${html}`);
    }
  }
  assert.throws(() => validateGenerativeUiHtml(NESTED_LAYERS.innerHTML(4)), /too complex to check/u);
  assert.throws(() => validateGenerativeUiHtml(NESTED_LAYERS.setAttribute(4)), /too complex to check/u);
});

test("a sink reached through a split string, a wrapped callee or a shifted argument is refused, streamed in pieces too", () => {
  for (const js of Object.values(INDIRECT_SINKS)) {
    for (const chunk of [1, 7, 64]) {
      assert.equal(streamInChunks(literalSink(js), chunk).admitted, false, `${chunk}-character pieces of ${js}`);
    }
  }
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
  // Markup a script joins from strings is quoted as joined, since the
  // source never spells it in one piece; one written whole is not.
  for (const joined of [`'<ifr' + 'ame src="https://evil.test/">'`, `'<ifr' + ('ame src="https://evil.test/">')`]) {
    assert.throws(
      () => validateGenerativeUiHtml(`<div id="d"></div><script>d.innerHTML = ${joined};</script>`),
      (error: Error) => error.message.includes('found "<iframe src=\\"https://evil.test/\\">", which a script joins from strings)'),
    );
  }
  assert.throws(
    () => validateGenerativeUiHtml(`<div id="d"></div><script>d.innerHTML = '<iframe src="https://evil.test/">';</script>`),
    (error: Error) => error.message.includes('found "<iframe src=\\"https://evil.test/\\">")'),
  );
  // A handler joined from strings is quoted as the call the source writes, so it is not marked as joined.
  assert.throws(
    () => validateGenerativeUiHtml(`<button id="b"></button><script>b.setAttribute('onclick', 'loca' + "tion='javascript:alert(1)'"); b.click()</script>`),
    (error: Error) => error.message.includes(`found "setAttribute('onclick', 'loca' + \\"tion=`) && !error.message.includes("joins from strings"),
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
