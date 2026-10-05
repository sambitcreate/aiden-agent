import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./types.js";
import { MAX_VISIBLE_COPY_MESSAGES } from "../shared/chat-copy-contract.js";
import {
  filterForkTurnChoices,
  forkSummaryRows,
  forkTurnEligibility,
  withForkLineage,
} from "./chat-copy-view.js";

test("fork labels read only a bounded prefix and preserve code points", () => {
  const result = forkTurnEligibility([
    {
      id: "u",
      role: "user",
      content: `${" ".repeat(255)}😀 ignored${"never scanned".repeat(100_000)}`,
      createdAt: 1,
    },
    { id: "a", role: "assistant", content: "answer", createdAt: 2 },
  ]);
  assert.equal(result.turns[0]?.label, "😀");
});

test("copy eligibility stops at the shared limit and keeps only searchable eligible turns", () => {
  const messages = Array.from({ length: MAX_VISIBLE_COPY_MESSAGES + 1 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `turn ${index}`,
    createdAt: index,
  })) satisfies ChatMessage[];
  const result = forkTurnEligibility(messages);
  assert.equal(result.cloneBlocked, true);
  assert.equal(
    result.turns[result.turns.length - 1]?.id,
    `m-${MAX_VISIBLE_COPY_MESSAGES - 1}`,
  );
  assert.equal(filterForkTurnChoices(result.turns, "").length, 100);
  assert.equal(filterForkTurnChoices(result.turns, "1")[0]?.turnNumber, 1);
  assert.deepEqual(filterForkTurnChoices(result.turns, "x".repeat(257)), []);
});

test("each fork choice points Edit in fork at the prompt that opened its turn", () => {
  const result = forkTurnEligibility([
    { id: "system", role: "system", content: "hidden", createdAt: 0 },
    { id: "u1", role: "user", content: "first", createdAt: 1 },
    { id: "a1", role: "assistant", content: "one", createdAt: 2 },
    { id: "a1b", role: "assistant", content: "one more", createdAt: 3 },
    { id: "u2", role: "user", content: "second", createdAt: 4 },
    { id: "a2", role: "assistant", content: "two", createdAt: 5 },
  ]);
  assert.deepEqual(
    result.turns.map(({ id, userMessageId }) => [id, userMessageId]),
    [["a1", "u1"], ["a1b", "u1"], ["a2", "u2"]],
  );
});

test("Bot chats offer no Edit in fork, including on their first prompt", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", content: "first", createdAt: 1 },
    { id: "a1", role: "assistant", content: "one", createdAt: 2 },
    { id: "u2", role: "user", content: "second", createdAt: 3 },
    { id: "a2", role: "assistant", content: "two", createdAt: 4 },
  ];
  const result = forkTurnEligibility(messages, { editInFork: false });
  assert.deepEqual(result.turns.map(({ id }) => id), ["a1", "a2"]);
  assert.ok(result.turns.every((turn) => turn.userMessageId === undefined));
});

test("a fork summary update replaces or clears only the cached chat's lineage", () => {
  const chat = {
    id: "fork",
    title: "Fork",
    forkedFrom: {
      chatId: "source",
      messageId: "a1",
      position: "after" as const,
      at: 1,
      summary: { state: "pending" as const, afterMessageId: "a1" },
    },
  };
  const ready = { ...chat.forkedFrom, summary: { state: "ready" as const, afterMessageId: "a1", text: "Done." } };
  const updated = withForkLineage(chat, ready);
  assert.deepEqual(updated, { id: "fork", title: "Fork", forkedFrom: ready });
  assert.equal(chat.forkedFrom.summary.state, "pending");

  const cleared = withForkLineage(chat, undefined);
  assert.deepEqual(cleared, { id: "fork", title: "Fork" });
  assert.equal("forkedFrom" in cleared, false);
});

test("Fork with summary is offered only where the fork leaves later messages to summarize", () => {
  const eligible = forkSummaryRows([
    { id: "u1", role: "user", content: "first", createdAt: 1 },
    { id: "a1", role: "assistant", content: "one", createdAt: 2 },
    { id: "u2", role: "user", content: "second", createdAt: 3 },
    { id: "a2", role: "assistant", content: "two", createdAt: 4 },
  ]);
  // The first prompt opens a fresh draft, and nothing follows the last reply.
  assert.deepEqual([...eligible].sort(), ["a1", "u2"]);
  assert.equal(forkSummaryRows([]).size, 0);
});
