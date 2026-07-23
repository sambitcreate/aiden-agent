import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAMING_REVEAL_HANDOFF_MS,
  parseStreamingReveal,
  revealDelayMs,
  streamingRevealHandoffDelay,
} from "./streaming-reveal.js";

function units(text: string, complete = false) {
  return parseStreamingReveal(text, complete).flatMap((block) =>
    block.units.map((unit) => ({ block: block.kind, ...unit })),
  );
}

test("keeps previously emitted prose units prefix-stable as text grows", () => {
  const first = units(
    "This is a sufficiently long opening sentence that can settle naturally. A second thought",
  );
  const next = units(
    "This is a sufficiently long opening sentence that can settle naturally. A second thought keeps growing.",
  );

  assert.ok(first.length > 0);
  assert.deepEqual(next.slice(0, first.length), first);
});

test("withholds ambiguous Markdown starters and unfinished code blocks", () => {
  assert.deepEqual(units("#"), []);
  assert.deepEqual(units("1."), []);
  assert.deepEqual(units("```ts\nconst one = 1;\nconst two = 2;\nconst three = 3;\n"), []);

  const streamingCode = units(
    "```ts\nconst one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n",
  );
  assert.equal(streamingCode.length, 1);
  assert.equal(streamingCode[0]?.block, "code");

  const completedCode = units("```ts\nconst answer = 1;\n```", true);
  assert.equal(completedCode.length, 1);
  assert.equal(completedCode[0]?.block, "code");
});

test("reveals list items incrementally in one semantic list and tables atomically", () => {
  const list = units("- Read files\n- Run tests\n");
  assert.deepEqual(
    list.map((unit) => [unit.block, unit.text]),
    [
      ["list", "Read files"],
      ["list", "Run tests"],
    ],
  );

  const table = units("| Name | State |\n| --- | --- |\n| Build | Done |\n", true);
  assert.equal(table.length, 1);
  assert.equal(table[0]?.block, "table");
});

test("holds potential table headers through separator and row arrival", () => {
  const header = units("| Name | State |\n");
  const partialSeparator = units("| Name | State |\n| ---");
  const separator = units("| Name | State |\n| --- | --- |\n");
  const row = units("| Name | State |\n| --- | --- |\n| Build | Done |\n");

  assert.deepEqual(header, []);
  assert.deepEqual(partialSeparator, []);
  assert.deepEqual(separator, []);
  assert.deepEqual(row, []);
  const complete = units("| Name | State |\n| --- | --- |\n| Build | Done |\n", true);
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.block, "table");
});

test("does not emit an inline Markdown group with an unmatched delimiter", () => {
  const partial = units(
    "This sentence is long enough to reveal but ends with an unfinished **bold phrase that continues ",
  );
  assert.equal(
    partial.some((unit) => unit.text.includes("unfinished **")),
    false,
  );

  const settled = units(
    "This sentence is long enough to reveal and ends with a finished **bold phrase** naturally. ",
  );
  assert.ok(settled.length > 0);
});

test("holds italic, strike, link, and multiline markup until it balances", () => {
  const prefixes = [
    "A sufficiently long sentence ending in *unfinished italic formatting ",
    "A sufficiently long sentence ending in ~~unfinished strike formatting ",
    "A sufficiently long sentence ending in [unfinished link text",
    "A sufficiently long sentence ending in [link text](https://example.com",
    "A sufficiently long first line with *emphasis that\ncontinues on the next line ",
  ];
  for (const prefix of prefixes) {
    assert.equal(units(prefix).length, 0, prefix);
  }

  const multiline =
    "A sufficiently long first line with *emphasis that\ncontinues on the next line* and settles. ";
  assert.ok(units(multiline).length > 0);
});

test("completion flushes prose remainder and cadence accelerates with backlog", () => {
  assert.equal(units("Short remainder").length, 0);
  assert.equal(units("Short remainder", true).length, 1);
  assert.ok(revealDelayMs(20, false) < revealDelayMs(1, false));
  assert.equal(revealDelayMs(20, true), 18);
});

test("reduced motion removes the final handoff wait", () => {
  assert.equal(streamingRevealHandoffDelay(true), 0);
  assert.equal(streamingRevealHandoffDelay(false), STREAMING_REVEAL_HANDOFF_MS);
});
