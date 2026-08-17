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
  // Paragraph-boundary splits reconstruct the original via double newlines.
  assert.equal(chunks.join("\n\n"), html);
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
