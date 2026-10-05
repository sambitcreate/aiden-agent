import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHAT_TITLE_CHARS,
  nextForkTitle,
  parseChatForkLineageV1,
} from "./chat-copy-contract.js";

test("fork titles count past the highest fork of the same base title", () => {
  assert.equal(nextForkTitle("Plan", []), "Plan (fork)");
  assert.equal(nextForkTitle("Plan", ["Plan", "Plan (copy)"]), "Plan (fork)");
  assert.equal(nextForkTitle("Plan", ["Plan (fork)"]), "Plan (fork 2)");
  assert.equal(nextForkTitle("Plan (fork 2)", ["Plan (fork)", "Plan (fork 7)"]), "Plan (fork 8)");
  // Another chat whose title merely ends the same way is not a sibling.
  assert.equal(nextForkTitle("Plan", ["Other plan (fork 4)"]), "Plan (fork)");
});

test("fork titles stay within the title limit without splitting a character", () => {
  const title = nextForkTitle("😀".repeat(MAX_CHAT_TITLE_CHARS), []);
  assert.ok(title.endsWith(" (fork)"));
  assert.ok(Array.from(title).length <= MAX_CHAT_TITLE_CHARS);
  assert.ok(!title.replace(" (fork)", "").includes("�"));
  assert.match(title.replace(" (fork)", ""), /^(?:😀)+$/u);
});

test("long titles keep numbering forks after the base is truncated", () => {
  const source = "x".repeat(MAX_CHAT_TITLE_CHARS);
  const titles: string[] = [];
  for (let index = 0; index < 11; index += 1) titles.push(nextForkTitle(source, titles));
  assert.deepEqual(
    titles.map((title) => / \((fork(?: \d+)?)\)$/u.exec(title)?.[1]),
    ["fork", ...Array.from({ length: 10 }, (_, index) => `fork ${index + 2}`)],
  );
  assert.ok(titles.every((title) => Array.from(title).length <= MAX_CHAT_TITLE_CHARS));
  // Forking one of those forks continues the same sequence.
  assert.match(nextForkTitle(titles[0]!, titles), / \(fork 12\)$/u);
});

test("fork lineage parsing accepts only the exact recorded shape", () => {
  const lineage = { chatId: "chat_1", messageId: "msg-2", position: "before", at: 1_700_000_000_000 };
  assert.deepEqual(parseChatForkLineageV1(lineage), lineage);
  for (const invalid of [
    null,
    [],
    "chat_1",
    { ...lineage, extra: true },
    { chatId: "chat_1", messageId: "msg-2", position: "before" },
    { ...lineage, chatId: "../chat" },
    { ...lineage, messageId: "x".repeat(161) },
    { ...lineage, position: "at" },
    { ...lineage, at: -1 },
    { ...lineage, at: 1.5 },
  ]) {
    assert.equal(parseChatForkLineageV1(invalid), undefined);
  }
});
