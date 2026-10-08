import assert from "node:assert/strict";
import test from "node:test";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botTranscriptRows } from "./bot-transcript-rows";

const user = (id: string, text: string): BotTranscriptEntry => ({ id, type: "user", text, imageCount: 0 });
const step = (id: string, text: string): BotTranscriptEntry => ({
  id,
  type: "assistant",
  text,
  toolCalls: [{ id: `${id}-call`, name: "web_search" }],
  stopReason: "toolUse",
});
const answer = (id: string, text: string): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop" });
const result = (id: string): BotTranscriptEntry => ({ id, type: "tool_result", toolCallId: `${id}-call`, toolName: "web_search", isError: false });
const failed = (id: string, retryText: string | null): BotTranscriptEntry => ({ id, type: "failed_turn", retryText });

const kinds = (rows: ReturnType<typeof botTranscriptRows>) => rows.map((row) => row.kind);

test("every tool round of one reply folds into a single Updates line before the answer", () => {
  const rows = botTranscriptRows(
    [
      user("u1", "Find flights"),
      step("a1", "Searching airlines."),
      result("a1"),
      step("a2", "Comparing prices."),
      result("a2"),
      step("a3", ""),
      result("a3"),
      answer("a4", "The cheapest is TAP on Friday."),
      user("u2", "Book it"),
      step("b1", "Opening the booking page."),
      result("b1"),
      answer("b2", "Booked."),
    ],
    null,
    false,
  );
  assert.deepEqual(kinds(rows), ["user", "updates", "assistant", "user", "updates", "assistant"]);
  const first = rows[1];
  assert.equal(first?.kind === "updates" && first.progressText, "Searching airlines.\n\nComparing prices.");
  assert.equal(first?.kind === "updates" && first.active, false);
});

test("a running reply keeps one Working line that also carries the streamed text", () => {
  const rows = botTranscriptRows(
    [user("u1", "Plan dinner"), step("a1", "Checking the fridge list."), result("a1")],
    "Looking at recipes",
    true,
  );
  assert.deepEqual(kinds(rows), ["user", "updates"]);
  const updates = rows[1];
  assert.equal(updates?.kind === "updates" && updates.active, true);
  assert.equal(updates?.kind === "updates" && updates.progressText, "Checking the fridge list.\n\nLooking at recipes");

  // Just sent: nothing written yet, the Bot is still shown working.
  assert.deepEqual(kinds(botTranscriptRows([user("u1", "Hi")], null, true)), ["user", "updates"]);
});

test("files and shared images show as chips in the reply, not as extra Updates lines", () => {
  const rows = botTranscriptRows(
    [
      user("u1", "Write my list"),
      step("a1", "Writing it."),
      result("a1"),
      { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
      { id: "i1", type: "shared_image", name: "chart.png", mimeType: "image/png", size: 3, data: "AAAA" },
    ],
    null,
    true,
  );
  assert.deepEqual(kinds(rows), ["user", "updates", "file", "image"]);
  assert.equal(rows[1]?.kind === "updates" && rows[1].active, true);
});

test("only the newest failed turn offers Retry, and never while the Bot is working", () => {
  const history = [user("u1", "Plan dinner"), failed("a1:failed", "Plan dinner")];
  const latest = botTranscriptRows(history, null, false).slice(-1)[0];
  assert.deepEqual(latest, { kind: "failed", id: "a1:failed", retryText: "Plan dinner" });

  const older = botTranscriptRows([...history, user("u2", "Never mind"), answer("a2", "Okay.")], null, false);
  assert.deepEqual(older.find((row) => row.kind === "failed"), { kind: "failed", id: "a1:failed", retryText: null });

  const busy = botTranscriptRows(history, null, true).find((row) => row.kind === "failed");
  assert.equal(busy?.kind === "failed" && busy.retryText, null);

  const routine = botTranscriptRows([failed("r1:failed", null)], null, false)[0];
  assert.equal(routine?.kind === "failed" && routine.retryText, null);
});

test("a paused reply keeps what it wrote as a bubble instead of a Working line", () => {
  const rows = botTranscriptRows([user("u1", "Summarize")], "Here is what I have so far", false);
  assert.deepEqual(rows[rows.length - 1], { kind: "assistant", id: "partial", text: "Here is what I have so far" });
});
