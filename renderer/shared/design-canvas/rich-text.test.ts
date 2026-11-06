// The Markdown subset notes and text items are stored in: what it reads,
// what it writes back, and the HTML an editor starts from.

import assert from "node:assert/strict";
import test from "node:test";
import {
  linkFromInput,
  parseInline,
  parseRichText,
  richTextHtml,
  richTextPlain,
  safeLinkHref,
  serializeRichText,
} from "./rich-text.js";

test("bold, italic, underline and links read as marked runs of words", () => {
  assert.deepEqual(parseInline("a **bold** *it* <u>under</u> [site](https://example.com/x)"), [
    { text: "a ", marks: {} },
    { text: "bold", marks: { bold: true } },
    { text: " ", marks: {} },
    { text: "it", marks: { italic: true } },
    { text: " ", marks: {} },
    { text: "under", marks: { underline: true } },
    { text: " ", marks: {} },
    { text: "site", marks: { href: "https://example.com/x" } },
  ]);
  assert.deepEqual(parseInline("***both***"), [{ text: "both", marks: { bold: true, italic: true } }]);
  assert.deepEqual(parseInline("**bold *and italic***"), [
    { text: "bold ", marks: { bold: true } },
    { text: "and italic", marks: { bold: true, italic: true } },
  ]);
});

test("what is not a mark stays as its words", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ text: "2 * 3 * 4", marks: {} }]);
  assert.deepEqual(parseInline("snake_case_name"), [{ text: "snake_case_name", marks: {} }]);
  assert.deepEqual(parseInline("**unclosed"), [{ text: "**unclosed", marks: {} }]);
  assert.deepEqual(parseInline("\\*not italic\\*"), [{ text: "*not italic*", marks: {} }]);
  assert.deepEqual(parseInline("<b>tag</b>"), [{ text: "<b>tag</b>", marks: {} }]);
});

test("a link to anything but http, https or mailto keeps only its words", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "aiden-design://x/y", "vbscript:x"]) {
    assert.equal(safeLinkHref(bad), null, bad);
    const spans = parseInline(`[go](${bad})`);
    assert.ok(spans.every((span) => span.marks.href === undefined), bad);
  }
  assert.equal(safeLinkHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(linkFromInput("example.com/pricing"), "https://example.com/pricing");
  assert.equal(linkFromInput("sam@example.com"), "mailto:sam@example.com");
  assert.equal(linkFromInput("javascript:alert(1)"), null);
  assert.equal(linkFromInput("   "), null);
});

test("each line is a paragraph, and runs of - or 1. lines are lists", () => {
  assert.deepEqual(parseRichText("Title\n- one\n- **two**\n\n1. first\n2. second\nend"), [
    { type: "paragraph", spans: [{ text: "Title", marks: {} }] },
    {
      type: "bullets",
      items: [[{ text: "one", marks: {} }], [{ text: "two", marks: { bold: true } }]],
    },
    { type: "paragraph", spans: [] },
    { type: "numbers", items: [[{ text: "first", marks: {} }], [{ text: "second", marks: {} }]] },
    { type: "paragraph", spans: [{ text: "end", marks: {} }] },
  ]);
});

test("writing back gives the same Markdown, and reading that gives the same document", () => {
  const sources = [
    "Plain words",
    "**Bold** then *italic* and <u>underline</u>",
    "A [link](https://example.com/a) and [**bold link**](https://example.com/b)",
    "- one\n- two\n\n1. first\n2. second",
    "Escapes: 2 \\* 3, \\[not a link\\], a\\_b and \\<u\\>",
    "\\- not a bullet\n3\\. not a number",
  ];
  for (const source of sources) {
    const blocks = parseRichText(source);
    const written = serializeRichText(blocks);
    assert.deepEqual(parseRichText(written), blocks, source);
  }
  assert.equal(serializeRichText(parseRichText("**a** *b* <u>c</u>")), "**a** *b* <u>c</u>");
});

test("marks wrap words, not the spaces around them", () => {
  const written = serializeRichText([
    { type: "paragraph", spans: [{ text: "hello ", marks: { bold: true } }, { text: "world", marks: {} }] },
  ]);
  assert.equal(written, "**hello** world");
});

test("the plain words drop every mark", () => {
  assert.equal(richTextPlain("**Plan** for [the site](https://x.co)\n- *one*\n- two"), "Plan for the site\none\ntwo");
});

test("the editor's starting HTML escapes every word and writes only its own tags", () => {
  const html = richTextHtml('<img src=x onerror="alert(1)"> & **bold** [x](https://e.com/?a="b")\n- item');
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(html.includes("<b>bold</b>"), html);
  assert.ok(html.includes('<ul><li>item</li></ul>'), html);
  const tags = [...html.matchAll(/<\/?([a-z]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(tags)].sort(), ["a", "b", "div", "li", "ul"]);
  assert.equal(richTextHtml("a\n\nb"), "<div>a</div><div><br></div><div>b</div>");
});

test("a mark that starts inside another one writes back to the same runs", () => {
  const blocks = [
    {
      type: "paragraph" as const,
      spans: [
        { text: "ab", marks: { bold: true as const } },
        { text: "cd", marks: { bold: true as const, italic: true as const } },
        { text: "ef", marks: { italic: true as const } },
        { text: "gh", marks: { underline: true as const, italic: true as const } },
      ],
    },
  ];
  assert.deepEqual(parseRichText(serializeRichText(blocks)), blocks);
});

test("any run of marked words, special characters included, survives writing and reading", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const alphabet = ["a", "b", "c", "*", "_", "[", "]", "(", ")", "<", ">", "\\", "u", "1", "."];
  const links = ["https://example.com/a", "https://example.com/b"];
  for (let round = 0; round < 400; round += 1) {
    const spans: { text: string; marks: Record<string, unknown> }[] = [];
    const count = 1 + Math.floor(random() * 5);
    for (let index = 0; index < count; index += 1) {
      let text = "";
      const length = 1 + Math.floor(random() * 4);
      for (let char = 0; char < length; char += 1) text += alphabet[Math.floor(random() * alphabet.length)];
      const marks: Record<string, unknown> = {};
      if (random() < 0.4) marks.bold = true;
      if (random() < 0.4) marks.italic = true;
      if (random() < 0.3) marks.underline = true;
      if (random() < 0.2) marks.href = links[Math.floor(random() * links.length)];
      const last = spans[spans.length - 1];
      if (last && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += text;
      else spans.push({ text, marks });
    }
    const blocks = [{ type: "paragraph" as const, spans }] as Parameters<typeof serializeRichText>[0];
    const written = serializeRichText(blocks);
    assert.deepEqual(parseRichText(written), blocks, written);
  }
});
