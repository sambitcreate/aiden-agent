import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./types.js";
import { MAX_VISIBLE_COPY_MESSAGES } from "../shared/chat-copy-contract.js";
import { filterForkTurnChoices, forkTurnEligibility } from "./chat-copy-view.js";

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
