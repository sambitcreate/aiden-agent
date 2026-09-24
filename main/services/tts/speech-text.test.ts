import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareSpeechText,
  segmentSpeechText,
  SPEECH_TEXT_POLICY_VERSION,
  SpeechTextError,
} from "./speech-text.js";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";

const BOTH = { inlineCode: true, fencedCode: true };
const DEFAULTS = { inlineCode: true, fencedCode: false };

test("plain prose is preserved with formatting markers removed", () => {
  const result = prepareSpeechText({
    markdown: "Hello **world** and _good morning_.",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "Hello world and good morning.");
  assert.deepEqual(result.omissions, []);
  assert.equal(result.policyVersion, SPEECH_TEXT_POLICY_VERSION);
});

test("links keep their visible label and drop the URL", () => {
  const result = prepareSpeechText({
    markdown: "See [the guide](https://example.com/a?b=1) for details.",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "See the guide for details.");
});

test("fenced code is omitted by default with a notice and included when enabled", () => {
  const skipped = prepareSpeechText({
    markdown: "Before.\n\n```js\nconst x = 1;\n```\n\nAfter.",
    reading: { inlineCode: true, fencedCode: false },
  });
  assert.ok(skipped);
  assert.equal(skipped.text, "Before.\n\nAfter.");
  assert.deepEqual(skipped.omissions, ["Code blocks skipped"]);

  const included = prepareSpeechText({
    markdown: "Before.\n\n```\nnpm install\n```\n\nAfter.",
    reading: { inlineCode: true, fencedCode: true },
  });
  assert.ok(included);
  assert.equal(
    included.text,
    "Before.\n\nnpm install\n\nAfter.",
  );
  assert.deepEqual(included.omissions, []);
});

test("inline code is read literally when enabled and omitted with a notice when disabled", () => {
  const included = prepareSpeechText({
    markdown: "Set `verbose=false` to disable logging.",
    reading: { inlineCode: true, fencedCode: false },
  });
  assert.ok(included);
  assert.equal(included.text, "Set verbose=false to disable logging.");

  const omitted = prepareSpeechText({
    markdown: "Set `verbose=false` to disable logging.",
    reading: { inlineCode: false, fencedCode: false },
  });
  assert.ok(omitted);
  assert.equal(omitted.text, "Set to disable logging.");
  assert.deepEqual(omitted.omissions, ["Inline code skipped"]);
});

test("lists preserve order without reading bullet markers", () => {
  const result = prepareSpeechText({
    markdown: "- First item\n- Second item\n\n1. Step one\n2. Step two",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(
    result.text,
    "First item\n\nSecond item\n\n1. Step one\n\n2. Step two",
  );
});

test("tables are linearized by row with header context", () => {
  const result = prepareSpeechText({
    markdown: "| Name | Value |\n| --- | --- |\n| A | 1 |\n| B | 2 |",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "Name: A; Value: 1\n\nName: B; Value: 2");
});

test("oversized tables are skipped with a notice, never summarized", () => {
  const rows = Array.from({ length: 14 }, (_, i) => `| R${i} | ${i} |`).join("\n");
  const result = prepareSpeechText({
    markdown: `Intro.\n\n| A | B |\n| --- | --- |\n${rows}`,
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "Intro.");
  assert.deepEqual(result.omissions, ["Large tables skipped"]);
});

test("images, embedded HTML, and footnotes are excluded with notices", () => {
  const result = prepareSpeechText({
    markdown: "Text ![alt](a.png) more.\n\n<div>hidden</div>\n\nA note[^1].\n\n[^1]: The footnote body.",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "Text more.\n\nA note.");
  assert.ok(result.omissions.includes("Images skipped"));
  assert.ok(result.omissions.includes("Embedded content skipped"));
});

test("math is kept as a conservative literal representation", () => {
  const result = prepareSpeechText({
    markdown: "The area is $A = \\pi r^2$ for any circle.",
    reading: BOTH,
  });
  assert.ok(result);
  assert.equal(result.text, "The area is A = \\pi r^2 for any circle.");
});

test("unicode, negations, and mixed languages are preserved exactly", () => {
  const markdown = "不行。 This is not enabled. Verison 3.8.1-beta.emoji 🌍";
  const result = prepareSpeechText({ markdown, reading: BOTH });
  assert.ok(result);
  assert.equal(result.text, markdown);
});

test("empty or non-prose responses produce no speakable text", () => {
  assert.equal(
    prepareSpeechText({ markdown: "", reading: BOTH }),
    null,
  );
  assert.equal(
    prepareSpeechText({ markdown: "![only an image](x.png)", reading: BOTH }),
    null,
  );
  assert.equal(
    prepareSpeechText({ markdown: "```js\nonly code\n```", reading: DEFAULTS }),
    null,
  );
});

test("oversized sources are rejected before parsing", () => {
  const oversized = "a".repeat(TTS_LIMITS.sourceMaxBytes + 1);
  assert.throws(
    () => prepareSpeechText({ markdown: oversized, reading: BOTH }),
    (error: unknown) =>
      error instanceof SpeechTextError && error.kind === "source_too_large",
  );
});

test("deterministic output for identical input", () => {
  const input = {
    markdown: "Same **input** twice.\n\n- a\n- b",
    reading: BOTH,
  };
  assert.deepEqual(
    prepareSpeechText(input),
    prepareSpeechText(input),
  );
});

test("segmentation packs blocks within the target window", () => {
  const blocks = Array.from(
    { length: 5 },
    (_, i) => `Paragraph ${i} ${"x".repeat(300)}`,
  );
  const segments = segmentSpeechText(blocks.join("\n\n"));
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(segment.length <= TTS_LIMITS.segmentTargetMaxChars + 1);
  }
  // Order is exact and nothing is lost.
  assert.equal(segments.join("\n\n"), blocks.join("\n\n"));
});

test("segmentation never splits a surrogate pair", () => {
  const longEmojiRun = "🌍".repeat(4000);
  const segments = segmentSpeechText(longEmojiRun);
  assert.ok(segments.length > 1);
  for (const segment of segments) {
    // Every segment must start and end on a complete code point.
    assert.ok(
      !/[\uD800-\uDBFF]$/u.test(segment) &&
        !/^[\uDC00-\uDFFF]/u.test(segment),
    );
  }
  assert.equal(segments.join(""), longEmojiRun);
});
