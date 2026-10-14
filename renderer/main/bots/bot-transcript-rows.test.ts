import assert from "node:assert/strict";
import test from "node:test";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botTranscriptRows } from "./bot-transcript-rows";

const user = (id: string, text: string): BotTranscriptEntry => ({ id, type: "user", text, imageCount: 0 });
const userAt = (id: string, text: string, at: number): BotTranscriptEntry => ({ id, type: "user", text, imageCount: 0, at });
const step = (id: string, text: string): BotTranscriptEntry => ({
  id,
  type: "assistant",
  text,
  toolCalls: [{ id: `${id}-call`, name: "web_search", kind: "searching", label: "Searched the web" }],
  stopReason: "toolUse",
});
const answer = (id: string, text: string): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop" });
const answerAt = (id: string, text: string, at: number): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop", at });
const result = (id: string): BotTranscriptEntry => ({ id, type: "tool_result", toolCallId: `${id}-call`, toolName: "web_search", isError: false, status: "ok" });
const failed = (id: string, retryText: string | null): BotTranscriptEntry => ({ id, type: "failed_turn", retryText });

const kinds = (rows: ReturnType<typeof botTranscriptRows>) => rows.map((row) => row.kind);

const quiet = { running: false, level: "quiet" } as const;

test("narration written alongside tool calls is a bubble, and tool steps never become rows", () => {
  const rows = botTranscriptRows(
    [
      user("u1", "Find flights"),
      step("a1", "On it, I'll check the airlines."),
      result("a1"),
      step("a2", ""),
      result("a2"),
      answer("a3", "The cheapest is TAP on Friday."),
    ],
    null,
    quiet,
  );
  assert.deepEqual(
    rows.map((row) => (row.kind === "assistant" ? `assistant:${row.text}` : row.kind)),
    ["user", "assistant:On it, I'll check the airlines.", "assistant:The cheapest is TAP on Friday."],
  );
});

test("a running reply streams as a bubble, and nothing is shown before it has words", () => {
  const rows = botTranscriptRows([user("u1", "Plan dinner")], "Looking at recipes", { running: true, level: "quiet" });
  assert.deepEqual(rows[rows.length - 1], { kind: "assistant", id: "partial", text: "Looking at recipes", streaming: true });
  assert.deepEqual(kinds(botTranscriptRows([user("u1", "Hi")], null, { running: true, level: "quiet" })), ["user"]);
});

test("Quiet never adds a recap; Summary puts one recap of the turn right above its answer", () => {
  const entries = [
    userAt("u1", "Find flights", 1_000),
    step("a1", ""),
    { ...result("a1"), at: 4_000 } as BotTranscriptEntry,
    { id: "f1", type: "file", path: "trips.md", operation: "written" } as BotTranscriptEntry,
    answerAt("a2", "TAP on Friday.", 19_000),
  ];
  assert.equal(kinds(botTranscriptRows(entries, null, quiet)).includes("recap"), false);
  const rows = botTranscriptRows(entries, null, { running: false, level: "summary" });
  assert.deepEqual(kinds(rows), ["user", "file", "recap", "assistant"]);
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.equal(recap.live, false);
  assert.equal(recap.durationMs, 18_000);
  assert.deepEqual(recap.steps.map((s) => [s.kind, s.status]), [["searching", "ok"]]);
});

test("while running, Summary shows no recap yet and Detailed shows a live one at the end", () => {
  const entries = [user("u1", "Plan dinner"), step("a1", "")];
  assert.equal(kinds(botTranscriptRows(entries, null, { running: true, level: "summary" })).includes("recap"), false);
  const rows = botTranscriptRows(entries, null, { running: true, level: "detailed" });
  const recap = rows[rows.length - 1];
  assert.ok(recap?.kind === "recap");
  assert.equal(recap.live, true);
  assert.deepEqual(recap.steps.map((s) => s.status), ["running"]);
});

test("a call with no result in a finished turn counts as failed", () => {
  const rows = botTranscriptRows([user("u1", "go"), step("a1", ""), answer("a2", "Done.")], null, { running: false, level: "summary" });
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => s.status), ["failed"]);
});

test("a stopped step carries through as stopped, and an unfinished call in a stopped turn is stopped, not failed", () => {
  const stoppedResult = { ...result("a1"), status: "stopped", isError: true } as BotTranscriptEntry;
  const aborted: BotTranscriptEntry = {
    id: "a2",
    type: "assistant",
    text: "",
    toolCalls: [{ id: "a2-call", name: "run_command", kind: "command", label: "Ran a command" }],
    stopReason: "aborted",
  };
  const rows = botTranscriptRows(
    [user("u1", "go"), step("a1", ""), stoppedResult, aborted],
    null,
    { running: false, level: "summary" },
  );
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => s.status), ["stopped", "stopped"]);
  assert.equal(rows[rows.length - 1]?.kind, "stopped");
});

test("a reply the person stopped ends with a stopped line; an interrupted one does not", () => {
  const aborted: BotTranscriptEntry = { id: "a1", type: "assistant", text: "Once upon", toolCalls: [], stopReason: "aborted" };
  assert.deepEqual(kinds(botTranscriptRows([user("u1", "Story"), aborted], null, quiet)), ["user", "assistant", "stopped"]);
  const interrupted = botTranscriptRows(
    [user("u1", "Story"), aborted, { id: "n1", type: "notice", notice: "interrupted" }],
    null,
    quiet,
  );
  assert.deepEqual(kinds(interrupted), ["user", "assistant", "notice"]);
});

test("only the newest failed turn offers Retry, and never while the Bot is working", () => {
  const history = [user("u1", "Plan dinner"), failed("a1:failed", "Plan dinner")];
  const latest = botTranscriptRows(history, null, quiet).slice(-1)[0];
  assert.deepEqual(latest, { kind: "failed", id: "a1:failed", retryText: "Plan dinner" });

  const older = botTranscriptRows([...history, user("u2", "Never mind"), answer("a2", "Okay.")], null, quiet);
  assert.deepEqual(older.find((row) => row.kind === "failed"), { kind: "failed", id: "a1:failed", retryText: null });

  const busy = botTranscriptRows(history, null, { running: true, level: "quiet" }).find((row) => row.kind === "failed");
  assert.equal(busy?.kind === "failed" && busy.retryText, null);

  const routine = botTranscriptRows([failed("r1:failed", null)], null, quiet)[0];
  assert.equal(routine?.kind === "failed" && routine.retryText, null);
});

test("a paused reply keeps what it wrote as a bubble", () => {
  const rows = botTranscriptRows([user("u1", "Summarize")], "Here is what I have so far", quiet);
  assert.deepEqual(rows[rows.length - 1], { kind: "assistant", id: "partial", text: "Here is what I have so far" });
});
