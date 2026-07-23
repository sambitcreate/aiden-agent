import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  advanceStreamingRevealCount,
  advanceStreamingRevealSchedule,
  STREAMING_REVEAL_COMPLETE_DELAY_MS,
  STREAMING_REVEAL_FALLBACK_MS,
  STREAMING_REVEAL_HANDOFF_MS,
  parseStreamingReveal,
  revealDelayMs,
  splitStreamingRevealUnit,
  streamingRevealHandoffDelay,
} from "./streaming-reveal.js";

function units(text: string, complete = false) {
  return parseStreamingReveal(text, complete).flatMap((block) =>
    block.units.map((unit) => ({ block: block.kind, ...unit })),
  );
}

function renderChunkedMarkdown(chunks: string[]): string {
  return renderToStaticMarkup(
    React.createElement(
      "p",
      null,
      chunks.map((chunk, index) => {
        const parts = splitStreamingRevealUnit(chunk);
        return React.createElement(
          "span",
          { key: index },
          parts.leadingWhitespace,
          parts.markdown
            ? React.createElement(ReactMarkdown, {
                components: {
                  p: ({ children }) => React.createElement(React.Fragment, null, children),
                },
                children: parts.markdown,
              })
            : null,
          parts.trailingWhitespace,
        );
      }),
    ),
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

test("holds a short local-model fragment until completion, then reveals it exactly", () => {
  const partial = units("9.9 is larger than ");
  const complete = units("9.9 is larger than 9.11.", true);

  assert.deepEqual(partial, []);
  assert.equal(complete.map((unit) => unit.text).join(""), "9.9 is larger than 9.11.");
});

test("preserves spaces and newlines outside independently parsed Markdown chunks", () => {
  const html = renderChunkedMarkdown([
    "Rain falls softly ",
    "on thirsty earth.\n",
    "It taps gently against ",
    "windowpanes.",
  ]);

  assert.match(html, /softly <\/span><span>on/u);
  assert.match(html, /earth\.\n<\/span><span>It/u);
  assert.match(html, /against <\/span><span>windowpanes/u);
  assert.doesNotMatch(html, /softly<\/span><span>on|against<\/span><span>windowpanes/u);
});

test("withholds ambiguous starters while previewing open code with a stable block", () => {
  assert.deepEqual(units("#"), []);
  assert.deepEqual(units("1."), []);

  const beforeClosingFence = units("```ts\nconst answer = 1;\n");
  const openClosingFence = units("```ts\nconst answer = 1;\n```");
  const closedClosingFence = units("```ts\nconst answer = 1;\n```\n");
  assert.deepEqual(openClosingFence, beforeClosingFence);
  assert.deepEqual(closedClosingFence, beforeClosingFence);
  assert.equal(beforeClosingFence[0]?.text, "```ts\nconst answer = 1;\n```\n");

  const longerFence = units("````md\n```not a closing fence\n````");
  assert.equal(longerFence[0]?.text, "````md\n```not a closing fence\n````\n");

  const completedCode = units("```ts\nconst answer = 1;\n```", true);
  assert.equal(completedCode.length, 1);
  assert.equal(completedCode[0]?.block, "markdown");
  assert.equal(completedCode[0]?.text, "```ts\nconst answer = 1;\n```");
});

test("reveals lists and tables atomically with their canonical Markdown source", () => {
  const growingList = units("- Read files\n  - Note details");
  const extendedList = units("- Read files\n  - Note details\n- Run tests");
  assert.equal(growingList.length, 1);
  assert.equal(growingList[0]?.id, extendedList[0]?.id);
  assert.equal(growingList[0]?.text, "- Read files\n  - Note details");
  assert.equal(extendedList[0]?.text, "- Read files\n  - Note details\n- Run tests");

  const listSource = "- Read files\n  - Note details\n- Run tests\n\n";
  const list = units(listSource);
  assert.deepEqual(
    list.map((unit) => [unit.block, unit.text]),
    [["markdown", listSource.slice(0, -1)]],
  );

  const tableSource = "| Name | State |\n| --- | --- |\n| Build | Done |\n";
  const table = units(tableSource, true);
  assert.equal(table.length, 1);
  assert.equal(table[0]?.block, "markdown");
  assert.equal(table[0]?.text, tableSource);
});

test("holds potential table headers through separator and row arrival", () => {
  const header = units("| Name | State |\n");
  const partialSeparator = units("| Name | State |\n| ---");
  const separator = units("| Name | State |\n| --- | --- |\n");
  const row = units("| Name | State |\n| --- | --- |\n| Build | Done |\n");

  assert.deepEqual(header, []);
  assert.deepEqual(partialSeparator, []);
  assert.equal(separator.length, 1);
  assert.equal(row.length, 1);
  assert.equal(separator[0]?.id, row[0]?.id);
  assert.equal(separator[0]?.text, "| Name | State |\n| --- | --- |\n");
  assert.equal(row[0]?.text, "| Name | State |\n| --- | --- |\n| Build | Done |\n");
  const complete = units("| Name | State |\n| --- | --- |\n| Build | Done |\n", true);
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.block, "markdown");
});

test("never retracts prose when a later pipe makes the open line ambiguous", () => {
  const text = "A complete sentence. | maybe a table later\nSecond line";
  let previous: ReturnType<typeof units> = [];
  for (let end = 1; end <= text.length; end += 1) {
    const next = units(text.slice(0, end));
    assert.deepEqual(next.slice(0, previous.length), previous, text.slice(0, end));
    previous = next;
  }
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
    assert.equal(
      units(prefix).some((unit) => /unfinished|emphasis that/u.test(unit.text)),
      false,
      prefix,
    );
  }

  const multiline =
    "A sufficiently long first line with *emphasis that\ncontinues on the next line* and settles. ";
  assert.ok(units(multiline).length > 0);
});

test("completion flushes prose remainder and cadence accelerates with backlog", () => {
  assert.equal(units("Short remainder").length, 0);
  const longOpenProse =
    "This intentionally unpunctuated local model response keeps producing enough words to reveal a stable group before completion ";
  assert.ok(units(longOpenProse).length > 0);
  assert.equal(units("Short remainder", true).length, 1);
  assert.ok(revealDelayMs(20, false) < revealDelayMs(1, false));
  assert.equal(revealDelayMs(20, true), STREAMING_REVEAL_COMPLETE_DELAY_MS);
});

test("completion never drops valid inline code, math, links, or intraword underscores", () => {
  const samples = [
    "Use `a*b` now.",
    "Visit [docs](https://example.com/a_b) now.",
    "Price is `$5` today.",
    "Use file_name now.",
    "Math $x_1$ is useful.",
    "Display $$ E = mc ",
  ];
  for (const sample of samples) {
    assert.equal(
      units(sample, true)
        .map((unit) => unit.text)
        .join(""),
      sample,
    );
  }
});

test("fast completion drains through bounded reveal waves instead of jumping to the end", () => {
  const unitCount = 25;
  let revealed = advanceStreamingRevealCount(0, unitCount, true);
  assert.ok(revealed > 0);
  assert.ok(revealed < unitCount);

  let steps = 1;
  while (revealed < unitCount) {
    revealed = advanceStreamingRevealCount(revealed, unitCount, true);
    steps += 1;
  }
  assert.equal(revealed, unitCount);
  assert.ok(steps <= 12);
  assert.equal(advanceStreamingRevealCount(0, unitCount, false), 1);
});

test("persistent scheduling advances during continuous fast-stream backlog growth", () => {
  let schedule = { revealedCount: 0, dueAt: null as number | null };
  let unitCount = 0;
  for (let now = 0; now <= 1_000; now += 16) {
    unitCount += 1;
    schedule = advanceStreamingRevealSchedule(
      schedule,
      { unitCount, complete: false, reducedMotion: false },
      now,
    );
  }
  assert.ok(schedule.revealedCount > 8);
  assert.ok(schedule.revealedCount < unitCount);
});

test("reduced motion exposes the latest backlog without hiding it when motion returns", () => {
  const reduced = advanceStreamingRevealSchedule(
    { revealedCount: 3, dueAt: 50 },
    { unitCount: 10, complete: false, reducedMotion: true },
    100,
  );
  assert.deepEqual(reduced, { revealedCount: 10, dueAt: null });

  const restored = advanceStreamingRevealSchedule(
    reduced,
    { unitCount: 12, complete: false, reducedMotion: false },
    116,
  );
  assert.equal(restored.revealedCount, 10);
  assert.ok(restored.dueAt !== null);
});

test("reduced motion removes the final handoff wait", () => {
  assert.equal(streamingRevealHandoffDelay(true), 0);
  assert.equal(streamingRevealHandoffDelay(false), STREAMING_REVEAL_HANDOFF_MS);
  assert.ok(STREAMING_REVEAL_FALLBACK_MS > STREAMING_REVEAL_HANDOFF_MS * 5);
});
