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
  "innerHTML that writes a label naming JavaScript": '<script>legend.innerHTML = "<b>JavaScript: 41%</b>";</script>',
  "a division after a parenthesized value": "<script>var r = (a) / 2; var s = \"/\"; location='https://x';</script>",
  "a division inside an if body": '<script>if (x) { y = (a + b) / "2"; }</script>',
  "a regex after a block": '<script>if (ok) { draw(); } /^#/.test(location.hash) && open(); var w = n++ / 2;</script>',
  "a division after a template literal": "<script>var h = `${rows}` / 2; label.textContent = h + ' rows';</script>",
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
// off, which turns <noscript> text into markup, so both parses count.
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
  ["<select>", "</select>"],
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
