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

test("Stop during a tool run: the step reads as stopped and the turn ends with a stopped line", () => {
  // The harness writes only the round's tool results (status "stopped"); no aborted reply follows.
  const stoppedResult = { ...result("a1"), status: "stopped", isError: true } as BotTranscriptEntry;
  const rows = botTranscriptRows([user("u1", "go"), step("a1", ""), stoppedResult], null, { running: false, level: "summary" });
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => s.status), ["stopped"]);
  assert.equal(rows[rows.length - 1]?.kind, "stopped");
  const quietRows = botTranscriptRows([user("u1", "go"), step("a1", ""), stoppedResult], null, quiet);
  assert.equal(quietRows[quietRows.length - 1]?.kind, "stopped", "Quiet shows the stopped line too");

  const restarted = botTranscriptRows(
    [user("u1", "go"), step("a1", ""), stoppedResult, { id: "n1", type: "notice", notice: "interrupted" }],
    null,
    quiet,
  );
  assert.equal(kinds(restarted).includes("stopped"), false, "a restart cut it short; the person did not stop it");
});

test("an unfinished call in a reply the person stopped is stopped, not failed", () => {
  const aborted: BotTranscriptEntry = {
    id: "a1",
    type: "assistant",
    text: "",
    toolCalls: [{ id: "a1-call", name: "run_command", kind: "command", label: "Ran a command" }],
    stopReason: "aborted",
  };
  const rows = botTranscriptRows([user("u1", "go"), aborted], null, { running: false, level: "summary" });
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => s.status), ["stopped"]);
  assert.equal(rows[rows.length - 1]?.kind, "stopped");
});

test("a reply that carries on after a restart's stop marker and finishes never reads as stopped", () => {
  // Resume after a restart: recovery settles an unsafe in-flight tool as interrupted ("stopped"), then the run goes on.
  const interruptedResult = { ...result("a1"), status: "stopped", isError: true } as BotTranscriptEntry;
  const resumed = botTranscriptRows(
    [user("u1", "go"), step("a1", ""), interruptedResult, answer("a2", "Recovered.")],
    null,
    { running: false, level: "summary" },
  );
  assert.equal(kinds(resumed).includes("stopped"), false, kinds(resumed).join(", "));
  const recap = resumed.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => s.status), ["stopped"], "the cut-short step stays neutral");

  // A retried request after a restart mid-stream: the partial lands as an aborted reply, then the retry answers.
  const partialCall: BotTranscriptEntry = {
    id: "a1",
    type: "assistant",
    text: "Once upon",
    toolCalls: [{ id: "a1-call", name: "run_command", kind: "command", label: "Ran a command" }],
    stopReason: "aborted",
  };
  const retried = botTranscriptRows([user("u1", "Story"), partialCall, answer("a2", "Recovered.")], null, {
    running: false,
    level: "summary",
  });
  assert.equal(kinds(retried).includes("stopped"), false, kinds(retried).join(", "));
  const retriedRecap = retried.find((row) => row.kind === "recap");
  assert.ok(retriedRecap?.kind === "recap");
  assert.deepEqual(retriedRecap.steps.map((s) => s.status), ["stopped"], "the unfinished call is neither failed nor running");
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

test("a queued follow-up is a faded row at the end, and a steer is a normal bubble right away", () => {
  const rows = botTranscriptRows([user("u1", "Plan dinner")], null, {
    running: true,
    level: "quiet",
    queued: [
      { submissionId: "7", mode: "steer", text: "Make it vegetarian", imageCount: 0 },
      { submissionId: "8", mode: "followUp", text: "", imageCount: 2 },
      { submissionId: "9", mode: "followUp", text: "", imageCount: 0 },
    ],
  });
  assert.deepEqual(rows.slice(1), [
    { kind: "user", id: "queued:7", text: "Make it vegetarian" },
    { kind: "queued", id: "queued:8", submissionId: "8", text: "2 photos" },
  ]);
});

test("a steer placed after the round's tool results keeps the step ok and reads in order", () => {
  // pi-durable places a steer at the post-tools boundary: result first, then the steer, then the reply continues.
  const entries = [
    userAt("u1", "Find flights", 1_000),
    step("a1", ""),
    { ...result("a1"), at: 4_000 } as BotTranscriptEntry,
    user("u2", "Make it cheap"),
    answerAt("a2", "TAP on Friday.", 9_000),
  ];
  const rows = botTranscriptRows(entries, null, { running: false, level: "summary" });
  assert.deepEqual(
    rows.map((row) => (row.kind === "user" ? `user:${row.text}` : row.kind)),
    ["user:Find flights", "recap", "user:Make it cheap", "assistant"],
  );
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(recap.steps.map((s) => [s.kind, s.status]), [["searching", "ok"]]);
});

test("a new message after a reply stopped mid tool call starts its own turn; the stopped line stays with the first", () => {
  const aborted: BotTranscriptEntry = {
    id: "a1",
    type: "assistant",
    text: "",
    toolCalls: [{ id: "a1-call", name: "web_search", kind: "searching", label: "Searched the web" }],
    stopReason: "aborted",
    at: 2_000,
  };
  const entries = [userAt("u1", "Find flights", 1_000), aborted, userAt("u2", "Never mind, hotels", 3_600_000), answerAt("a3", "Hotel X.", 3_601_000)];
  const rows = botTranscriptRows(entries, null, { running: false, level: "summary" });
  assert.deepEqual(
    rows.map((row) => (row.kind === "user" ? `user:${row.text}` : row.kind)),
    ["user:Find flights", "recap", "stopped", "user:Never mind, hotels", "assistant"],
  );
  const recap = rows.find((row) => row.kind === "recap");
  assert.ok(recap?.kind === "recap");
  assert.equal(recap.durationMs, 1_000);
  assert.deepEqual(recap.steps.map((s) => s.status), ["stopped"]);
});

test("a new message after a finished tool starts a new turn with its own recap", () => {
  const entries = [
    user("u1", "Find flights"),
    step("a1", ""),
    result("a1"),
    answer("a2", "TAP."),
    user("u2", "And hotels"),
    answer("a3", "Hotel X."),
  ];
  const rows = botTranscriptRows(entries, null, { running: false, level: "summary" });
  assert.deepEqual(kinds(rows), ["user", "recap", "assistant", "user", "assistant"]);
});
