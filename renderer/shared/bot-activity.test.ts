import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botActivityDisplay,
  botElapsedLabel,
  botStepInfinitive,
  botStepPhrase,
  botToolApp,
  botToolPhase,
  nextBotAnnouncement,
  pickActiveToolSlot,
} from "./bot-activity";

// The spec's §5.1 table, row by row: the independent oracle.
const SPEC_TOOL_PHASES: ReadonlyArray<[string, string]> = [
  ["read_file", "reading"],
  ["list_dir", "reading"],
  ["glob", "reading"],
  ["grep", "reading"],
  ["edit_file", "editing"],
  ["write_file", "editing"],
  ["run_command", "command"],
  ["web_search", "searching"],
  ["computer_use", "computer"],
  ["form_fill", "computer"],
  ["computer", "app"],
  ["computer_shell", "command"],
  ["inspect_image", "photo"],
  ["subagent", "helper"],
  ["bot_memory", "remembering"],
  ["routines", "routine"],
  ["routine_notes", "routine"],
  ["ask_user_question", "waiting"],
  ["hand_off", "waiting"],
  ["sign_in", "waiting"],
  ["share_image", "working"],
  ["suggest_connection", "working"],
  ["skill_meal_planning", "working"],
  ["constructor", "working"],
];

test("every Bot tool maps to the phase in the spec's table, and anything else is working", () => {
  for (const [tool, phase] of SPEC_TOOL_PHASES) {
    assert.equal(botToolPhase(tool, botToolApp(tool)), phase, tool);
  }
});

test("a connection tool is Using {app}, named from the connection, and bounded", () => {
  const tool = "google_calendar__list_events";
  assert.equal(botToolApp(tool), "Google Calendar");
  assert.equal(botToolPhase(tool, botToolApp(tool)), "app");
  assert.equal(botActivityDisplay("app", "follows", "Google Calendar").word, "Using Google Calendar");
  // Two servers sharing a prefix, a long tool name, and a digit-led server keep their app.
  assert.equal(botToolApp("google_calendar_1a2b3c__list_events"), "Google Calendar");
  assert.equal(botToolApp("notion__search_pages_and_databases_0123abcd"), "Notion");
  assert.equal(botToolApp("mcp_1password__item_lookup"), "1password");
  const long = `${"a".repeat(60)}__search`;
  assert.equal([...(botToolApp(long) ?? "")].length, 40);
  // Not a minted connection tool name: no app.
  assert.equal(botToolApp("web_search"), undefined);
  assert.equal(botToolApp("Notion__search"), undefined);
});

test("the Bot's own computer reads as Using its computer, never as the person's Mac", () => {
  const app = botToolApp("computer");
  assert.equal(app, "its computer");
  assert.equal(botActivityDisplay(botToolPhase("computer", app), "follows", app).word, "Using its computer");
  assert.equal(botStepPhrase("app", 1, app), "Used its computer");
  assert.equal(botStepInfinitive("app", app), "use its computer");
  assert.equal(botActivityDisplay(botToolPhase("computer_use"), "follows").word, "Using your Mac");
  assert.equal(botActivityDisplay(botToolPhase("computer_shell"), "follows").word, "Running a command");
});

test("when tools run in parallel, the most recently started one wins", () => {
  const slots = [
    { name: "a", status: "done" },
    { name: "b", status: "running" },
    { name: "c", status: "running" },
    { name: "d", status: "pending" },
  ];
  assert.equal(pickActiveToolSlot(slots)?.name, "c");
  assert.equal(pickActiveToolSlot([{ name: "x", status: "pending" }, { name: "y", status: "pending" }])?.name, "x");
  assert.equal(pickActiveToolSlot([{ name: "z", status: "done" }]), undefined);
  assert.equal(pickActiveToolSlot(undefined), undefined);
});

test("each phase has the spec's word and mark, and an unknown phase is working", () => {
  assert.deepEqual(botActivityDisplay("preparing", "follows"), { phase: "preparing", word: "Getting ready", mark: "bounce" });
  assert.deepEqual(botActivityDisplay("reading", "follows"), { phase: "reading", word: "Reading", mark: "scan-grid" });
  assert.deepEqual(botActivityDisplay("tidying", "follows"), { phase: "tidying", word: "Tidying up its notes", mark: "bounce" });
  assert.deepEqual(botActivityDisplay("browsing", "follows"), { phase: "working", word: "Working", mark: "quad-shuffle" });
});

test("Always Thinking says Thinking for everything except waiting, stopping and reconnecting", () => {
  for (const phase of ["preparing", "reading", "command", "app", "writing", "tidying", "resuming", "browsing"]) {
    assert.deepEqual(botActivityDisplay(phase, "thinking", "Notion"), { phase: "thinking", word: "Thinking", mark: "tri-step" }, phase);
  }
  assert.equal(botActivityDisplay("waiting", "thinking").word, "Waiting for you");
  assert.equal(botActivityDisplay("stopping", "thinking").word, "Stopping");
  assert.equal(botActivityDisplay("reconnecting", "thinking").word, "Reconnecting to your Mac");
});

test("elapsed time shows only after 20 seconds, as minutes and seconds", () => {
  assert.equal(botElapsedLabel(0, 19_999), null);
  assert.equal(botElapsedLabel(0, 20_000), "20s");
  assert.equal(botElapsedLabel(0, 72_400), "1m 12s");
  assert.equal(botElapsedLabel(0, 120_000), "2m");
  assert.equal(botElapsedLabel(0, 3_725_000), "1h 2m");
  assert.equal(botElapsedLabel(Number.NaN, 50_000), null);
});

test("announcements change at most once every 2 seconds, and the newest wording wins once the gap passes", () => {
  const first = nextBotAnnouncement(null, "Reading", 1_000);
  assert.deepEqual(first, { shown: { text: "Reading", at: 1_000 } });
  const tooSoon = nextBotAnnouncement(first.shown, "Searching the web", 1_500);
  assert.deepEqual(tooSoon, { shown: { text: "Reading", at: 1_000 }, retryInMs: 1_500 });
  const same = nextBotAnnouncement(first.shown, "Reading", 1_200);
  assert.equal(same.shown, first.shown);
  assert.equal(same.retryInMs, undefined);
  assert.deepEqual(nextBotAnnouncement(first.shown, "Editing files", 3_000), { shown: { text: "Editing files", at: 3_000 } });
});

test("step phrases read naturally and count repeats", () => {
  assert.equal(botStepPhrase("reading", 1), "Read 1 file");
  assert.equal(botStepPhrase("reading", 6), "Read 6 files");
  assert.equal(botStepPhrase("searching", 1), "Searched the web");
  assert.equal(botStepPhrase("searching", 3), "Searched the web 3 times");
  assert.equal(botStepPhrase("app", 1, "Notion"), "Used Notion");
  assert.equal(botStepPhrase("command", 2), "Ran 2 commands");
  assert.equal(botStepInfinitive("command"), "run a command");
  assert.equal(botStepInfinitive("app", "Notion"), "use Notion");
});
