import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotTranscriptEntry, BotTranscriptToolCall } from "../../shared/bot-live";
import { BOT_ACTIVITY_TITLE_CHARS, botActivityLog, formatBotActivityWhen } from "./bot-activity-log";

const call = (id: string, name: string, kind: BotTranscriptToolCall["kind"], label: string, detail?: string): BotTranscriptToolCall => ({
  id,
  name,
  kind,
  label,
  ...(detail ? { detail } : {}),
});

const result = (callId: string, status: "ok" | "failed" | "blocked" | "stopped"): BotTranscriptEntry => ({
  id: `${callId}:result`,
  type: "tool_result",
  toolCallId: callId,
  toolName: "tool",
  isError: status !== "ok",
  status,
});

const working = (id: string, calls: BotTranscriptToolCall[], at?: number, stopReason: "toolUse" | "aborted" = "toolUse"): BotTranscriptEntry => ({
  id,
  type: "assistant",
  text: "",
  toolCalls: calls,
  stopReason,
  ...(at === undefined ? {} : { at }),
});

const answer = (id: string, text: string): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop" });
const message = (id: string, text: string): BotTranscriptEntry => ({ id, type: "user", text, imageCount: 0 });

const ENTRIES: BotTranscriptEntry[] = [
  { id: "r1", type: "routine", label: "Sunday plan", text: "Plan next week", at: 100 },
  working("a1", [call("c1", "read_file", "reading", "Read 1 file", "pantry.md")]),
  result("c1", "ok"),
  answer("a2", "Planned."),
  { id: "u1", type: "user", text: "Ask me nothing", imageCount: 0, at: 150 },
  answer("a3", "Sure."),
  { id: "u2", type: "user", text: "Plan dinners for this week", imageCount: 0, at: 200 },
  working("a4", [
    call("c2", "web_search", "searching", "Searched the web", "dairy-free dinners"),
    call("c3", "run_command", "command", "Ran a command"),
  ]),
  result("c2", "ok"),
  result("c3", "failed"),
  working("a5", [call("c4", "edit_file", "editing", "Edited 1 file", "meal-plan.md")]),
  result("c4", "blocked"),
  answer("a6", "Here's your week."),
];

test("replies come newest first, each with its steps in the order they ran, and a reply with no steps is left out", () => {
  const log = botActivityLog(ENTRIES, { running: false });
  assert.deepEqual(log.map((reply) => reply.title), ["Plan dinners for this week", "Sunday plan"]);
  assert.deepEqual(
    log[0]!.steps.map((step) => [step.label, step.detail ?? null, step.status]),
    [
      ["Searched the web", "dairy-free dinners", "ok"],
      ["Ran a command", null, "failed"],
      ["Edited 1 file", "meal-plan.md", "blocked"],
    ],
  );
  assert.equal(log[0]!.at, 200);
});

test("a routine run carries the routine's name", () => {
  const routine = botActivityLog(ENTRIES, { running: false }).find((reply) => reply.routine);
  assert.equal(routine?.title, "Sunday plan");
  assert.equal(routine?.steps[0]?.detail, "pantry.md");
});

test("a step still running reads as failed once the Bot stopped, but stays running in the live reply", () => {
  const unfinished = [...ENTRIES.slice(0, 6), message("u3", "Next"), working("a7", [call("c5", "grep", "reading", "Read 1 file")])];
  assert.equal(botActivityLog(unfinished, { running: true })[0]!.steps[0]!.status, "running");
  assert.equal(botActivityLog(unfinished, { running: false })[0]!.steps[0]!.status, "failed");
  const older = [...unfinished, message("u4", "Again")];
  assert.equal(botActivityLog(older, { running: true }).find((reply) => reply.id === "u3")?.steps[0]?.status, "failed");
});

test("a step the person stopped, or a restart cut short, reads as stopped, never as a failure", () => {
  const stoppedByResult = botActivityLog(
    [message("u1", "Go"), working("a1", [call("c1", "grep", "reading", "Read 1 file"), call("c2", "grep", "searching", "Searched the web")]), result("c1", "stopped")],
    { running: false },
  );
  assert.deepEqual(stoppedByResult[0]!.steps.map((step) => step.status), ["stopped", "stopped"]);

  const aborted = botActivityLog([message("u1", "Go"), working("a1", [call("c1", "grep", "reading", "Read 1 file")], undefined, "aborted")], { running: false });
  assert.equal(aborted[0]!.steps[0]!.status, "stopped");

  const restarted = botActivityLog(
    [message("u1", "Go"), working("a1", [call("c1", "grep", "reading", "Read 1 file")]), { id: "n1", type: "notice", notice: "interrupted" }],
    { running: false },
  );
  assert.equal(restarted[0]!.steps[0]!.status, "stopped");

  // A real failure in a reply that was not stopped stays a failure.
  const failed = botActivityLog([message("u1", "Go"), working("a1", [call("c1", "grep", "reading", "Read 1 file")])], { running: false });
  assert.equal(failed[0]!.steps[0]!.status, "failed");
});

test("a question the Bot asked is not an action and does not appear as a step", () => {
  const log = botActivityLog(
    [message("u1", "Go"), working("a1", [call("c1", "ask_user_question", "waiting", "Asked you a question"), call("c2", "grep", "reading", "Read 1 file")]), result("c2", "ok")],
    { running: false },
  );
  assert.deepEqual(log[0]!.steps.map((step) => step.label), ["Read 1 file"]);
});

test("a step shows only the detail the transcript already carries, and a command never gains text", () => {
  const log = botActivityLog(
    [message("u1", "Go"), working("a1", [call("c1", "run_command", "command", "Ran a command")]), result("c1", "ok")],
    { running: false },
  );
  assert.equal(log[0]!.steps[0]!.detail, undefined);
});

test("a long message makes a short title, and a photo-only message reads as Photo", () => {
  const long = "word ".repeat(40);
  const log = botActivityLog(
    [
      message("u1", long),
      working("a1", [call("c1", "grep", "reading", "Read 1 file")]),
      { id: "u2", type: "user", text: "", imageCount: 1 },
      working("a2", [call("c2", "inspect_image", "photo", "Looked at your photo")]),
    ],
    { running: false },
  );
  assert.equal(log[0]!.title, "Photo");
  assert.ok([...log[1]!.title].length <= BOT_ACTIVITY_TITLE_CHARS);
  assert.ok(log[1]!.title.endsWith("…"));
});

test("a long transcript projects every reply once, in order", () => {
  const entries: BotTranscriptEntry[] = [];
  for (let index = 0; index < 3000; index += 1) {
    entries.push(message(`u${index}`, `Message ${index}`));
    entries.push(working(`a${index}`, [call(`c${index}`, "grep", "reading", "Read 1 file")]));
    entries.push(result(`c${index}`, "ok"));
  }
  const log = botActivityLog(entries, { running: false });
  assert.equal(log.length, 3000);
  assert.equal(log[0]!.title, "Message 2999");
  assert.equal(log[2999]!.title, "Message 0");
  assert.ok(log.every((reply) => reply.steps.length === 1 && reply.steps[0]!.status === "ok"));
});

test("reply times read as today, yesterday, or a date, each with the time", () => {
  const now = new Date(2026, 9, 14, 18, 0).getTime();
  assert.match(formatBotActivityWhen(new Date(2026, 9, 14, 9, 5).getTime(), now), /^Today, \S/u);
  assert.match(formatBotActivityWhen(new Date(2026, 9, 13, 23, 0).getTime(), now), /^Yesterday, \S/u);
  const older = new Date(2026, 9, 6, 19, 0);
  const olderDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(older);
  assert.ok(formatBotActivityWhen(older.getTime(), now).startsWith(`${olderDay}, `), "an older reply names its date");
  assert.equal(formatBotActivityWhen(undefined, now), "Earlier");
});
