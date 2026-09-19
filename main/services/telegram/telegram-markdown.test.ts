import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToTelegramHtml,
  chunkForTelegram,
  chunkRichMarkdown,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_RICH_MESSAGE_LIMIT,
} from "./telegram-markdown.js";

test("converts **bold** to <b>bold</b>", () => {
  assert.equal(markdownToTelegramHtml("**bold**"), "<b>bold</b>");
});

test("converts `code` to <code>code</code>", () => {
  assert.equal(markdownToTelegramHtml("`code`"), "<code>code</code>");
});

test("converts fenced code block with language to pre/code", () => {
  const md = "```ts\nconst x = 1;\n```";
  assert.equal(
    markdownToTelegramHtml(md),
    '<pre><code class="language-ts">const x = 1;</code></pre>',
  );
});

test("converts [text](url) links", () => {
  assert.equal(
    markdownToTelegramHtml("[text](https://url)"),
    '<a href="https://url">text</a>',
  );
});

test("escapes <, >, & in plain text", () => {
  assert.equal(markdownToTelegramHtml("a < b > c & d"), "a &lt; b &gt; c &amp; d");
});

test("converts # heading to bold", () => {
  assert.equal(markdownToTelegramHtml("# Title"), "<b>Title</b>");
});

test("chunkForTelegram returns a single chunk for short text", () => {
  assert.deepEqual(chunkForTelegram("hello world"), ["hello world"]);
});

test("chunkForTelegram splits text over the limit into multiple chunks", () => {
  const long = "x".repeat(5000);
  const chunks = chunkForTelegram(long);
  assert.ok(chunks.length >= 2, "expected more than one chunk");
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= TELEGRAM_MESSAGE_LIMIT,
      `chunk length ${chunk.length} exceeds limit ${TELEGRAM_MESSAGE_LIMIT}`,
    );
  }
  // Char-level splits preserve content exactly.
  assert.equal(chunks.join(""), long);
});

test("chunkForTelegram splits at paragraph boundaries when possible", () => {
  const para1 = "a".repeat(2000);
  const para2 = "b".repeat(2000);
  const para3 = "c".repeat(2000);
  const html = `${para1}\n\n${para2}\n\n${para3}`;

  const chunks = chunkForTelegram(html);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= TELEGRAM_MESSAGE_LIMIT,
      `chunk length ${chunk.length} exceeds limit ${TELEGRAM_MESSAGE_LIMIT}`,
    );
  }
  // Paragraph separators remain part of the rendered text.
  assert.ok(chunks[0].endsWith("\n\n"));
  assert.equal(chunks.join(""), html);
});

test("chunkForTelegram returns empty array for empty string", () => {
  assert.deepEqual(chunkForTelegram(""), []);
});

test("chunkRichMarkdown preserves fences while splitting long code", () => {
  const chunks = chunkRichMarkdown(`\`\`\`ts\n${"const value = 1;\n".repeat(3_000)}\`\`\``);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= TELEGRAM_RICH_MESSAGE_LIMIT));
  assert.ok(chunks.every((chunk) => chunk.startsWith("```ts\n") && chunk.endsWith("\n```")));
});

test("chunkRichMarkdown keeps a wrapped inline block balanced", () => {
  const chunks = chunkRichMarkdown(`**${"word ".repeat(8_000)}**`);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.startsWith("**") && chunk.endsWith("**")));
});

/** Independent strict reader for the converter's HTML subset. */
function readTelegramHtml(html: string): { text: string; styled: string[] } {
  const stack: string[] = [];
  const styled: string[] = [];
  let text = "";
  for (const part of html.split(/(<[^>]*>)/)) {
    if (part.startsWith("<")) {
      const close = /^<\/(\w+)>$/.exec(part);
      if (close) {
        assert.equal(stack.pop()?.match(/^<(\w+)/)?.[1], close[1], "properly nested closing tag");
      } else {
        assert.match(part, /^<(b|i|s|u|a|pre|code|blockquote)(?:\s[^<>]*)?>$/);
        stack.push(part);
      }
      continue;
    }
    assert.doesNotMatch(part, /[<>]|&(?!amp;|lt;|gt;|quot;|#\d+;|#x[\da-f]+;)/i, "no partial tags/entities");
    const decoded = part.replace(/&(amp|lt|gt|quot|#\d+|#x[\da-f]+);/gi, (_match, entity: string) => {
      if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.startsWith("#x") ? `0x${entity.slice(2)}` : entity.slice(1)));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"' } as Record<string, string>)[entity];
    });
    assert.doesNotMatch(decoded, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no split surrogate pairs");
    text += decoded;
    for (const character of decoded) styled.push(JSON.stringify([character, stack]));
  }
  assert.deepEqual(stack, [], "all tags close within the message");
  return { text, styled };
}

function assertHtmlChunks(html: string): string[] {
  const expected = readTelegramHtml(html);
  const chunks = chunkForTelegram(html);
  const actual = chunks.map((chunk) => {
    const parsed = readTelegramHtml(chunk);
    assert.ok(parsed.text.length > 0 && parsed.text.length <= TELEGRAM_MESSAGE_LIMIT, "parsed UTF-16 length fits Telegram");
    return parsed;
  });
  assert.equal(actual.map(({ text }) => text).join(""), expected.text, "no text or whitespace lost");
  assert.deepEqual(actual.flatMap(({ styled }) => styled), expected.styled, "formatting and attributes survive every boundary");
  return chunks;
}

test("chunkForTelegram preserves long nested inline formatting and links", () => {
  for (const wrapper of [
    (text: string) => `<b><i>${text}</i></b>`,
    (text: string) => `<a href="https://example.com/?a=1&amp;b=2"><s>${text}</s></a>`,
    (text: string) => `<blockquote><u>${text}</u></blockquote>`,
    (text: string) => `<code>${text}</code>`,
  ]) assert.ok(assertHtmlChunks(wrapper("x".repeat(12_500))).length > 1);
});

test("chunkForTelegram keeps entities and astral Unicode intact around hard boundaries", () => {
  for (let offset = 4020; offset <= 4034; offset += 1) {
    assertHtmlChunks(`${"a".repeat(offset)}&amp;&lt;&gt;&quot;&#128512;&#x1F680;😀${"z".repeat(4200)}`);
  }
});

test("chunkForTelegram preserves code language, indentation and blank lines across chunks", () => {
  const markdown = `\`\`\`ts\n${"  const x = '<&😀>';\n\n\n".repeat(700)}  tail\n\`\`\``;
  const chunks = assertHtmlChunks(markdownToTelegramHtml(markdown));
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.startsWith('<pre><code class="language-ts">') && chunk.endsWith("</code></pre>")));
});

test("chunkForTelegram counts parsed text rather than indivisible HTML attributes", () => {
  const html = `<a href="https://example.com/${"a".repeat(5000)}">${"&amp;😀".repeat(2000)}</a>`;
  assertHtmlChunks(html);
});

test("chunkForTelegram preserves mixed formatting at deterministic fuzz boundaries", () => {
  let seed = 29;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const atoms = ["x", "😀", "&amp;", "&lt;", "\n", "\n\n\n", "  ", "é", "&#x1F680;"];
  for (let run = 0; run < 12; run += 1) {
    let html = "";
    for (let block = 0; block < 30; block += 1) {
      const text = Array.from({ length: 100 + next() % 200 }, () => atoms[next() % atoms.length]).join("");
      html += [text, `<b>${text}</b>`, `<a href="https://example.com"><i>${text}</i></a>`, `<pre><code class="language-ts">${text}</code></pre>`][next() % 4];
    }
    assertHtmlChunks(html);
  }
});

test("chunkForTelegram handles exact limits and tag transitions without empty tails", () => {
  for (const length of [4031, 4032, 4033, 4095, 4096, 8064]) {
    const html = `<b>${"a".repeat(length)}</b><i>😀</i>`;
    assertHtmlChunks(html);
    assertHtmlChunks(`${"a".repeat(length)}😀${"b".repeat(4032)}`);
  }
  assert.deepEqual(chunkForTelegram(`<b>${"&amp;".repeat(1000)}</b>`), [`<b>${"&amp;".repeat(1000)}</b>`]);
  assert.equal(assertHtmlChunks(`<b>${"a".repeat(4032)}</b>`).length, 1);
});

test("chunkForTelegram preserves converter output for long headings, quotes and links", () => {
  for (const markdown of [
    `# ${"heading 😀 ".repeat(600)}`,
    `> **${"quoted & <text> ".repeat(700)}**`,
    `[${"linked text ".repeat(800)}](https://example.com/?q=hello&lang=en)`,
  ]) assertHtmlChunks(markdownToTelegramHtml(markdown));
});

test("chunkForTelegram does not separate combining marks or emoji graphemes", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const grapheme of ["e\u0301", "👩‍💻", "👨‍👩‍👧‍👦", "🇺🇸", "👍🏽", "1️⃣"]) {
    for (let offset = 4025; offset <= 4033; offset += 1) {
      const text = `${"a".repeat(offset)}${grapheme}${"z".repeat(100)}`;
      const chunks = assertHtmlChunks(`<b>${text}</b>`).map((chunk) => readTelegramHtml(chunk).text);
      assert.deepEqual(chunks.flatMap((chunk) => Array.from(segmenter.segment(chunk), ({ segment }) => segment)),
        Array.from(segmenter.segment(text), ({ segment }) => segment), `whole grapheme ${grapheme} at ${offset}`);
    }
  }
  for (const html of [
    `${"a".repeat(4031)}<b>e</b>&#769;${"z".repeat(100)}`,
    `${"a".repeat(4030)}&#x1F469;<i>&#8205;</i>&#x1F4BB;${"z".repeat(100)}`,
  ]) {
    const chunks = assertHtmlChunks(html).map((chunk) => readTelegramHtml(chunk).text);
    assert.ok(chunks[1].startsWith("é") || chunks[1].startsWith("👩‍💻"));
  }
});

test("chunkForTelegram progresses when one grapheme exceeds the provider limit", () => {
  const html = `<b>e${"\u0301".repeat(9000)}</b>`;
  assert.ok(assertHtmlChunks(html).length >= 3);
});
