# Bot chat activity · Slice B (status line and Chat activity, desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a Bot works, its desktop chat shows one calm status line ("Thinking", "Reading", "Searching the web"…), never tool rows by default. Each Bot gets a Chat activity setting (Quiet, Summary or Detailed; Follows the work or Always "Thinking") with live previews. Narration becomes ordinary bubbles, queued messages show faded with Remove, and Bot faces glance while their Bot works.

**Architecture:** One shared module (`renderer/shared/bot-activity.ts`) owns the phase vocabulary, the tool → phase classifier, step phrases, elapsed-time and announcement throttling, so main, the renderer and (in slice D) the phones read one table. Main derives a live `activity` (phase, start time, safe step) from `pi.live` plus question, approval, stop and resume state, and enriches transcript tool calls and results (`kind`, `label`, `detail`, `status`, `durationMs`). It also projects queued inputs from `pi.inbox`. The renderer draws `BotStatusLine` and a Bot-specific recap fold, chosen per Bot through `BotDefinition.chatActivity`, saved through the existing `bots:update` path.

**Tech Stack:** Electron main (Node, `@earendil-works/pi-durable` 1.0.3 harness), React 19 + TanStack Router/Query + Radix RadioGroup in `renderer/`, `node:test` via `tsx --test`, Testing Library on happy-dom (`renderer/main/bots/test-dom.ts`), pi-ai faux provider for real harness turns.

**Spec:** [`docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md`](../specs/2026-10-14-bot-chat-activity-design.md). Slice B is §4 row B, §5, §6, §7, §14, §15 and the B rows of §16. Slice A ([plan](2026-10-14-bot-chat-activity-a-quick-fixes.md)) lands first. This plan assumes its files exist: `bot-model-choice.ts`, `bot-model-picker.tsx`, Advanced's `ModelSection` using `BotModelPicker`, and Memory and Advanced in every ••• menu.

## Findings this plan rests on

- **Pi Durable can withdraw one queued submission.** `@earendil-works/pi-durable@1.0.3` exposes `Harness.abortSubmission(id, context, conversationId)` and `Submission.abort(context)` (`dist/harness/submissions.js`). A submission still `queued` is settled `unanswered`/`aborted` and its `pi.inbox` item is removed. One already placed returns `already_placed`; a finished one returns `settled`. **So the Queued bubble gets a Remove** (Task 8).
- **Refusals are marked durably.** When a `beforeTool` hook blocks a call (policy refusal, a denied approval, an ingress rule), Pi writes the tool result with `isError: true` and `data.diagnostics[*].code === "blocked"` (`dist/harness/tool.js`, `harnessError("blocked", …)`). Any other error result is a failure. That is how `status: "blocked"` and `status: "failed"` are told apart (Task 2).
- **Queued and steered input lives in `pi.inbox`** (`InboxState.items: { id, mode: "steer" | "followUp" | "write", content | entry }[]`). The live feed already receives every conversation doc in `watch.value.docs`.
- **A paused (interrupted) Bot still has `pi.live.run`.** So the live activity is gated on the session state being `running`, not on `pi.live.run` alone (Task 3).
- **MCP and Composio tool names** are minted by `mcpAgentToolName` (`main/services/mcp-tool-identity.ts`) as `<server name>__<tool>_<12 hex>`, with non `[A-Za-z0-9_-]` characters replaced by `_`. The connection label for "Using {app}" is read back from that prefix (Task 1).
- **The Remote projection picks wire fields explicitly** (`projectBotSessionEntries` in `main/services/aiden-remote-bot-session.ts`; Bot detail in `aiden-remote-bots.ts`). The new transcript fields and `chatActivity` therefore never reach phones in this slice. iOS and Android consume only the Remote wire, so this slice needs no mobile code change. Task 11 re-runs the Remote suite to prove the wire is unchanged.

## Rulings on spec ambiguities

1. **Recap component.** §6 says the trail reuses `ActivityFeed`. `ActivityFeed` owns its open state: it auto-opens only on issues, and while running its ticker replaces the header. It also tints issues amber. That contradicts §6's Detailed rules (open while live, auto-fold on finish, a manual toggle sticks) and its red "1 issue". Slice B therefore adds a small Bot recap (`BotActivityRecap`). It reuses the feed's tone tokens (`text-red`, `text-support-warning`), its `agent-thinking-shimmer` class and its row rhythm, but takes its wording from the shared step phrases rather than `summarizeActivity`. `summarizeActivity` says "Explored 1 file … 1 tool call" and cannot name apps, while §6 asks for "read 1 file, searched the web, edited 1 file, used Notion". Task 11 records this in the spec.
2. **Where categories live.** `agent-steps.ts` has verb pairs but no tool categories, so nothing moves out of it. The phase table lives only in `renderer/shared/bot-activity.ts`.
3. **Connection label.** It is parsed from the MCP agent tool name, which is sync and pure, rather than looked up through `facts.mcpTools()`. The projection has no tool facts, and `projectBotTranscript` must stay pure for Remote.
4. **Command detail.** Main prefers the model's own `description` argument, matching `safeToolDescriptor` in `generation-timeline.ts`. Otherwise it shows the first 80 characters of `command`. Either way the text is passed through `sanitizeDiagnosticText` (the existing path and secret redaction) *before* it is cut, so a secret is never split past the redactor.
5. **`chatActivity` on update** is optional. When it is absent the stored value is **kept**. Profile edits (`updateBotIdentity`) and Remote `PATCH` (which builds the update without it) must not reset the choice.
6. **Always "Thinking" hides the peek.** With that wording, neither the hover peek nor the status line's accessible name includes the step.
7. **Blocked versus failed on the recap.** The red "N issues" counts failed steps. Blocked steps get their own amber "N blocked", so the two never look alike.
8. **Extra live fields.** `BotLiveSnapshot` also gains `queued` (from `pi.inbox`), with a `queued` live event. A transcript tool call also carries `app?`, so steps from the same app can merge.
9. **Stopped turns.** "You stopped this reply." is derived in the renderer from an assistant entry with `stopReason: "aborted"` that is not followed by an `interrupted` notice. Nothing is stored. A tool result aborted by Stop counts as `failed`.
10. **Onboarding.** The Bots tile (`BotsArt` in `renderer/components/onboarding-art/control-art.tsx`) shows a chat with a bubble and typing bars. It shows neither the old list nor the Updates line, so §15 needs no redraw. Task 11 records the review.

## Global Constraints

- Phase ids, words and marks are exactly §5's table. Unknown ids render as `working`.
- Always "Thinking" keeps the words of `waiting`, `stopping` and `reconnecting` only.
- Elapsed time appears after 20 seconds ("· 1m 12s", measured from `activity.startedAt`). After 2 minutes a centred note reads "Still going. I'll message you when it's done." Stop appears on the Mac's line after 20 seconds.
- The status line is hidden while the reply's visible text streams.
- `step.detail` is at most 80 characters, built in main and redacted. Thinking text is never projected.
- `chatActivity` absent means `{ level: "quiet", wording: "follows" }`. New Bots never write it.
- Status line semantics: `role="status"`, accessible name = word (plus `, {detail}` on the Mac with Follows the work), announced at most once every 2 seconds.
- Motion: marks and faces freeze on their still pose under Reduce Motion and off-screen. Shimmer runs only under `data-reduce-motion="false"`. Previews pause.
- No decorative borders or outlines on radio rows; selection uses the radio plus `bg-list-selection`. Keep every `focus-visible` ring. Settings pages follow `docs/settings-design-system.md` (BotPageShell, FieldSet groups, trailing values).
- Copy, exact: "Chat activity", "How much to show", "What the status line says", "Quiet", "Summary", "Detailed", "Recommended", "Follows the work", "Always “Thinking”", "On iPhone and Android", "Queued", "Remove", "You stopped this reply.", "Still going. I'll message you when it's done.", "Worked for {t}", "Couldn’t {verb}", "Blocked: {verb}".
- Desktop only. No Remote route, wire field, feature token or protocol revision changes (slice D).
- Every new test file goes in the matching `package.json` script **and** `scripts/ci-test-registry.json`, then `npm run test:ci-policy` passes. Tests are behavioural: no source greps, no class-string or snapshot assertions.
- No network calls are added.

## Review Focus

1. **A Profile edit (or a phone's Remote `PATCH`) after choosing Summary.** Expected: renaming the Bot keeps Summary; only an explicit choice changes it. Test: Task 4, Step 1, test 1.
2. **A `bots.json` record whose `chatActivity` is hand-edited, from a newer build, or malformed** (`level: "verbose"`, extra keys). Expected: the Bot still loads, and its chat behaves as Quiet / Follows the work. Test: Task 4, Step 1, test 2.
3. **Remove pressed on a queued message whose turn already started.** Expected: nothing is withdrawn. The service reports `started`, and the message runs as a normal turn. Test: Task 8, Step 1, test 2.
4. **Picking a Chat activity choice fails to save** (revision conflict, Bot deleted). Expected: the radio returns to the saved choice and a toast says it couldn't save. A half-applied state never shows. Test: Task 9, Step 1, test 3.
5. **Stop pressed while nothing is running (a double-click after the reply landed).** Expected: the next turn starts at "Getting ready", never "Stopping". Test: Task 3, Step 1, test 4.

---

## File map

| File | Responsibility |
|---|---|
| Create `renderer/shared/bot-activity.ts` (+ `.test.ts`) | Phase vocabulary, tool → phase classifier, app label, step phrases, elapsed labels, announcement throttle, parallel tie-break |
| Create `main/services/bot-runtime/bot-activity-detail.ts` (+ `.test.ts`) | `botStepDescriptor`: kind, past label, bounded redacted detail for one tool call |
| Modify `renderer/shared/bot-live.ts` | Tool call `kind/label/detail/app`; tool result `status/durationMs/at`; `BotLiveActivity`; `BotQueuedMessage`; `activity` and `queued` events |
| Modify `main/services/bot-runtime/live-projection.ts` (+ test) | Enriched transcript; `liveBotActivity`; `liveQueuedMessages`; feed activity/queued; `notifyStopping`, `notifyResuming`, `refreshActivity` |
| Modify `main/services/bot-runtime/bot-session-main.ts` | `approvalPending` dep; approval changes refresh activity |
| Modify `main/services/bot-runtime/bot-session-service.ts` | `withdraw(botId, submissionId)` |
| Modify `main/handlers/bots.ts`, `main/handlers/bot-params.ts` (+ test), `main/handlers/bot-live.test.ts` | Stop/resume notify the projection; `bots:withdraw`; `chatActivity` on `bots:update` |
| Modify `renderer/shared/bots.ts`, `main/services/bot-store-core.ts` (+ test) | `BotChatActivity` type, parser, default; stored and kept across edits |
| Modify `renderer/main/bots/bot-identity.ts`, `renderer/lib/ipc.ts` | `chatActivity` patch; `botsApi.withdraw` |
| Create `renderer/main/bots/bot-status-line.tsx` (+ `.test.tsx`) | `BotStatusLine` |
| Create `renderer/main/bots/bot-activity-steps.ts`, `bot-activity-recap.tsx` (+ `bot-activity-recap.test.tsx`) | Recap step model, merge, sentence; the recap fold |
| Modify `renderer/main/bots/bot-transcript-rows.ts` (+ test), `bot-chat-pane.tsx` (+ test) | Levels, recap rows, stopped line, progress bubbles, queued rows, status line, Remove |
| Delete `renderer/main/bots/bot-updates.tsx`, `renderer/main/bots/bot-reply-projection.ts`; modify `bot-chat-mode.test.tsx` | Updates line removed |
| Create `renderer/main/bots/bot-chat-activity-page.tsx` (+ `.test.tsx`) | Advanced → Chat activity sub-page and previews |
| Modify `renderer/main/bots/bot-advanced.tsx`, `bot-page-search.ts`, `renderer/main/bots-view.tsx` | "Chat activity" row; `?page=chat-activity` |
| Modify `renderer/components/bot-avatar.tsx`, `aiden-activity-mark.tsx`, `renderer/styles.css`, `bot-chat-header.tsx`, `bot-list.tsx` (+ `bot-list.test.tsx`) | `working` faces |
| Modify `package.json`, `scripts/ci-test-registry.json`, the spec, `docs/plans/README.md`; create `.memory/bot-chat-activity.md`; modify `.memory/bots-rework-ui.md` | Registration, docs, memory |

---

### Task 1: Shared status vocabulary and tool classifier

**Files:**
- Create: `renderer/shared/bot-activity.ts`
- Test: `renderer/shared/bot-activity.test.ts`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `ActivityMark` from `renderer/shared/activity-marks.ts`. `BotChatActivityWording` is declared here as a local string union so this task has no dependency on Task 4. Task 4 re-exports it from `bots.ts`.
- Produces:
  - `BOT_ACTIVITY_PHASES`, `type BotActivityPhase`, `isBotActivityPhase(value): value is BotActivityPhase`
  - `type BotToolPhase` (the subset a tool maps to, including `"waiting"`)
  - `type BotChatActivityWording = "follows" | "thinking"`
  - `BOT_APP_LABEL_CHARS = 40`, `botToolApp(toolName): string | undefined`, `botToolPhase(toolName, app?): BotToolPhase`
  - `botPhaseWord(phase, app?): string`, `botActivityDisplay(phase: string, wording, app?): { phase; word; mark }`
  - `botStepPhrase(kind: BotToolPhase, count, app?): string` (past tense, "Read 6 files"), `botStepInfinitive(kind, app?): string` ("run a command")
  - `BOT_ELAPSED_AFTER_MS = 20_000`, `BOT_STILL_GOING_AFTER_MS = 120_000`, `botDurationLabel(ms)`, `botElapsedLabel(startedAt, now): string | null`
  - `BOT_ANNOUNCE_GAP_MS = 2_000`, `interface BotAnnouncement { text; at }`, `nextBotAnnouncement(current, text, now, gapMs?) → { shown; retryInMs? }`
  - `pickActiveToolSlot<T extends { status: string }>(slots): T | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/shared/bot-activity.test.ts
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
  ["inspect_image", "photo"],
  ["subagent", "helper"],
  ["bot_memory", "remembering"],
  ["routines", "routine"],
  ["routine_notes", "routine"],
  ["ask_user_question", "waiting"],
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
  const tool = "Google_Calendar__list_events_0123456789ab";
  assert.equal(botToolApp(tool), "Google Calendar");
  assert.equal(botToolPhase(tool, botToolApp(tool)), "app");
  assert.equal(botActivityDisplay("app", "follows", "Google Calendar").word, "Using Google Calendar");
  const long = `${"A".repeat(60)}__search_0123456789ab`;
  assert.equal([...(botToolApp(long) ?? "")].length, 40);
  // Not a minted connection tool name: no app.
  assert.equal(botToolApp("web_search"), undefined);
  assert.equal(botToolApp("Notion__search"), undefined);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/shared/bot-activity.test.ts`
Expected: FAIL, `Cannot find module './bot-activity'`.

- [ ] **Step 3: Write the implementation**

```ts
// renderer/shared/bot-activity.ts
// What a working Bot's status line says (spec 2026-10-14 §5): one phase at a
// time, with the same ids, words and marks on the Mac and, from slice D, on
// phones. Main classifies the active tool with this table, the renderer draws
// it, and the CLI bundles it as is.

import type { ActivityMark } from "./activity-marks.js";

export const BOT_ACTIVITY_PHASES = [
  "preparing",
  "thinking",
  "reading",
  "photo",
  "searching",
  "command",
  "editing",
  "app",
  "helper",
  "computer",
  "remembering",
  "routine",
  "working",
  "writing",
  "waiting",
  "tidying",
  "stopping",
  "resuming",
  "reconnecting",
] as const;
export type BotActivityPhase = (typeof BOT_ACTIVITY_PHASES)[number];

/** The phases an active tool maps to (§5.1). */
export type BotToolPhase = Extract<
  BotActivityPhase,
  | "reading"
  | "photo"
  | "searching"
  | "command"
  | "editing"
  | "app"
  | "helper"
  | "computer"
  | "remembering"
  | "routine"
  | "working"
  | "waiting"
>;

/** What the status line says: the work, or always "Thinking". */
export type BotChatActivityWording = "follows" | "thinking";

const PHASES: Record<BotActivityPhase, { word: string; mark: ActivityMark }> = {
  preparing: { word: "Getting ready", mark: "bounce" },
  thinking: { word: "Thinking", mark: "tri-step" },
  reading: { word: "Reading", mark: "scan-grid" },
  photo: { word: "Looking at your photo", mark: "scan-grid" },
  searching: { word: "Searching the web", mark: "scan-grid" },
  command: { word: "Running a command", mark: "quad-shuffle" },
  editing: { word: "Editing files", mark: "quad-shuffle" },
  app: { word: "Using an app", mark: "quad-shuffle" },
  helper: { word: "Asking a helper", mark: "quad-shuffle" },
  computer: { word: "Using your Mac", mark: "quad-shuffle" },
  remembering: { word: "Remembering", mark: "compose" },
  routine: { word: "Setting up a routine", mark: "tri-step" },
  working: { word: "Working", mark: "quad-shuffle" },
  writing: { word: "Writing", mark: "compose" },
  waiting: { word: "Waiting for you", mark: "glance" },
  tidying: { word: "Tidying up its notes", mark: "bounce" },
  stopping: { word: "Stopping", mark: "bounce" },
  resuming: { word: "Picking up where it left off", mark: "bounce" },
  reconnecting: { word: "Reconnecting to your Mac", mark: "bounce" },
};

/** The Bot tool set's fixed tools (`bot-tool-policy.ts`, `bot-file-tool-router.ts`). */
const TOOL_PHASES: ReadonlyMap<string, BotToolPhase> = new Map<string, BotToolPhase>([
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
  ["inspect_image", "photo"],
  ["subagent", "helper"],
  ["bot_memory", "remembering"],
  ["routines", "routine"],
  ["routine_notes", "routine"],
  ["ask_user_question", "waiting"],
]);

const PHASE_IDS: ReadonlySet<string> = new Set(BOT_ACTIVITY_PHASES);

export function isBotActivityPhase(value: unknown): value is BotActivityPhase {
  return typeof value === "string" && PHASE_IDS.has(value);
}

/** The longest connection label a status line shows; the Remote wire uses the same bound (§11). */
export const BOT_APP_LABEL_CHARS = 40;

// `mcpAgentToolName` (main/services/mcp-tool-identity.ts) mints connection
// tools as `<server name>__<tool>_<12 hex>`, with other characters as `_`.
const MCP_AGENT_TOOL = /^(.+?)__.+_[0-9a-f]{12}$/u;

/** The connection label of an MCP or Composio tool, or undefined for Aiden's own tools. */
export function botToolApp(toolName: string): string | undefined {
  const match = MCP_AGENT_TOOL.exec(toolName);
  const label = match?.[1]?.replace(/_+/gu, " ").trim();
  if (!label) return undefined;
  const points = [...label];
  return points.length > BOT_APP_LABEL_CHARS ? points.slice(0, BOT_APP_LABEL_CHARS).join("").trimEnd() : label;
}

/** The phase an active tool puts its Bot in (§5.1). */
export function botToolPhase(toolName: string, app?: string): BotToolPhase {
  return TOOL_PHASES.get(toolName) ?? (app ? "app" : "working");
}

/** The status line's word for a phase; `app` fills "Using {app}". */
export function botPhaseWord(phase: BotActivityPhase, app?: string): string {
  return phase === "app" && app ? `Using ${app}` : PHASES[phase].word;
}

/** Phases that keep their own word under Always "Thinking": they change what the person should do. */
const KEEPS_ITS_WORD: ReadonlySet<BotActivityPhase> = new Set(["waiting", "stopping", "reconnecting"]);

export interface BotActivityDisplay {
  phase: BotActivityPhase;
  word: string;
  mark: ActivityMark;
}

/** What the line shows for a phase id from any client: unknown ids read as `working` (§5.2). */
export function botActivityDisplay(phase: string, wording: BotChatActivityWording, app?: string): BotActivityDisplay {
  const known: BotActivityPhase = isBotActivityPhase(phase) ? phase : "working";
  const shown: BotActivityPhase = wording === "thinking" && !KEEPS_ITS_WORD.has(known) ? "thinking" : known;
  return { phase: shown, word: botPhaseWord(shown, app), mark: PHASES[shown].mark };
}

interface StepPhrases {
  one: string;
  many(count: number): string;
  infinitive: string;
}

function stepPhrases(kind: BotToolPhase, app?: string): StepPhrases {
  const name = app ?? "an app";
  switch (kind) {
    case "reading":
      return { one: "Read 1 file", many: (n) => `Read ${n} files`, infinitive: "read a file" };
    case "editing":
      return { one: "Edited 1 file", many: (n) => `Edited ${n} files`, infinitive: "edit a file" };
    case "command":
      return { one: "Ran a command", many: (n) => `Ran ${n} commands`, infinitive: "run a command" };
    case "searching":
      return { one: "Searched the web", many: (n) => `Searched the web ${n} times`, infinitive: "search the web" };
    case "photo":
      return { one: "Looked at your photo", many: (n) => `Looked at ${n} photos`, infinitive: "look at your photo" };
    case "computer":
      return { one: "Used your Mac", many: (n) => `Used your Mac ${n} times`, infinitive: "use your Mac" };
    case "helper":
      return { one: "Asked a helper", many: (n) => `Asked ${n} helpers`, infinitive: "ask a helper" };
    case "remembering":
      return { one: "Updated its memory", many: () => "Updated its memory", infinitive: "update its memory" };
    case "routine":
      return { one: "Set up a routine", many: (n) => `Worked on ${n} routines`, infinitive: "set up a routine" };
    case "app":
      return { one: `Used ${name}`, many: (n) => `Used ${name} ${n} times`, infinitive: `use ${name}` };
    case "waiting":
      return { one: "Asked you a question", many: (n) => `Asked you ${n} questions`, infinitive: "ask you a question" };
    case "working":
      return { one: "Used a tool", many: (n) => `Used ${n} tools`, infinitive: "use a tool" };
  }
}

/** A finished step, past tense: "Read 1 file", "Read 6 files", "Used Notion". */
export function botStepPhrase(kind: BotToolPhase, count: number, app?: string): string {
  const phrases = stepPhrases(kind, app);
  return count <= 1 ? phrases.one : phrases.many(count);
}

/** The bare verb phrase for "Couldn’t …" and "Blocked: …". */
export function botStepInfinitive(kind: BotToolPhase, app?: string): string {
  return stepPhrases(kind, app).infinitive;
}

export const BOT_ELAPSED_AFTER_MS = 20_000;
export const BOT_STILL_GOING_AFTER_MS = 120_000;

/** "18s", "1m 12s", "2m", "1h 2m". Never less than one second. */
export function botDurationLabel(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** The status line's elapsed time, once a turn has run for 20 seconds. */
export function botElapsedLabel(startedAt: number, now: number): string | null {
  const elapsed = now - startedAt;
  return Number.isFinite(elapsed) && elapsed >= BOT_ELAPSED_AFTER_MS ? botDurationLabel(elapsed) : null;
}

/** Screen readers hear a phase change at most this often (§14). */
export const BOT_ANNOUNCE_GAP_MS = 2_000;

export interface BotAnnouncement {
  text: string;
  at: number;
}

/**
 * What to announce now. A change inside the gap keeps the current text and
 * says when to try again; the newest text wins once the gap has passed.
 */
export function nextBotAnnouncement(
  current: BotAnnouncement | null,
  text: string,
  now: number,
  gapMs = BOT_ANNOUNCE_GAP_MS,
): { shown: BotAnnouncement; retryInMs?: number } {
  if (current !== null && current.text === text) return { shown: current };
  if (current === null || now - current.at >= gapMs) return { shown: { text, at: now } };
  return { shown: current, retryInMs: gapMs - (now - current.at) };
}

/**
 * The tool slot a status line follows. Slots are in call order and parallel
 * calls start in that order, so the last running one started most recently;
 * with none running, the first one about to start.
 */
export function pickActiveToolSlot<T extends { status: string }>(slots: readonly T[] | undefined): T | undefined {
  if (!slots) return undefined;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index]!.status === "running") return slots[index];
  }
  return slots.find((slot) => slot.status === "pending");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test renderer/shared/bot-activity.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Register the test**

Append ` renderer/shared/bot-activity.test.ts` to the end of the `test:bots` command string in `package.json`. In `scripts/ci-test-registry.json`, add `"renderer/shared/bot-activity.test.ts",` directly after `"renderer/shared/bot-capabilities.test.ts",`.

Run: `npm run test:ci-policy`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/shared/bot-activity.ts renderer/shared/bot-activity.test.ts package.json scripts/ci-test-registry.json
git commit -m "Bots: shared status words and tool phase classifier"
```

---

### Task 2: Transcript tool calls and results carry kind, label, detail and status

**Files:**
- Create: `main/services/bot-runtime/bot-activity-detail.ts`
- Test: `main/services/bot-runtime/bot-activity-detail.test.ts`
- Modify: `renderer/shared/bot-live.ts` (types), `main/services/bot-runtime/live-projection.ts` (`projectBotTranscript`), `main/services/bot-runtime/live-projection.test.ts`
- Modify fixtures: `renderer/main/bots/bot-transcript-rows.test.ts` (`step`, `result`), `renderer/main/bots/bot-chat-pane.test.tsx` (the inline calendar call at about line 305 and `toolStep` at about line 478)
- Modify: `package.json` (`test:bot-runtime`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `botToolApp`, `botToolPhase`, `botStepPhrase`, `BotToolPhase` (Task 1); `sanitizeDiagnosticText` from `main/services/diagnostics-contract.ts`.
- Produces:
  - `BOT_STEP_DETAIL_CHARS = 80`; `botStepDescriptor(toolName: string, args: unknown): BotStepDescriptor` where `interface BotStepDescriptor { kind: BotToolPhase; label: string; detail?: string; app?: string }` (label is `botStepPhrase(kind, 1, app)`).
  - `BotTranscriptToolCall` becomes `{ id: string; name: string; kind: BotToolPhase; label: string; detail?: string; app?: string }`.
  - `type BotToolResultStatus = "ok" | "failed" | "blocked"`. The `tool_result` entry gains `status: BotToolResultStatus; durationMs?: number; at?: number` and keeps `isError`.

- [ ] **Step 1: Write the failing tests**

```ts
// main/services/bot-runtime/bot-activity-detail.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpAgentToolName } from "../mcp-tool-identity.js";
import { BOT_STEP_DETAIL_CHARS, botStepDescriptor } from "./bot-activity-detail.js";

test("a file step names only the file's base name", () => {
  assert.deepEqual(botStepDescriptor("read_file", { path: "/Users/sam/Lists/grocery-list.md" }), {
    kind: "reading",
    label: "Read 1 file",
    detail: "grocery-list.md",
  });
  assert.deepEqual(botStepDescriptor("edit_file", { path: "notes\\week.md" }), {
    kind: "editing",
    label: "Edited 1 file",
    detail: "week.md",
  });
  assert.equal(botStepDescriptor("grep", { pattern: "tofu", path: "recipes" }).detail, "tofu");
});

test("a command step is bounded and never shows a secret or an absolute path", () => {
  const secret = botStepDescriptor("run_command", {
    command: "export OPENAI_API_KEY=sk-live1234567890abcdef && ls /Users/sam/Private",
  });
  assert.equal(secret.kind, "command");
  assert.equal(secret.label, "Ran a command");
  assert.ok(secret.detail);
  assert.doesNotMatch(secret.detail, /sk-live/u);
  assert.doesNotMatch(secret.detail, /\/Users\/sam/u);
  const long = botStepDescriptor("run_command", { command: "echo hi && ".repeat(20) }).detail ?? "";
  assert.ok([...long].length <= BOT_STEP_DETAIL_CHARS);
  assert.ok(long.endsWith("…"));
  // The model's own description is preferred over the raw command.
  assert.equal(botStepDescriptor("run_command", { command: "ls -la", description: "List the folder" }).detail, "List the folder");
});

test("a search step shows its query; a connection step names the app and shows no arguments", () => {
  assert.deepEqual(botStepDescriptor("web_search", { query: "lisbon trains" }), {
    kind: "searching",
    label: "Searched the web",
    detail: "lisbon trains",
  });
  const notion = mcpAgentToolName({ id: "srv-1", name: "Notion" }, "search_pages");
  assert.deepEqual(botStepDescriptor(notion, { query: "private plans" }), {
    kind: "app",
    label: "Used Notion",
    app: "Notion",
  });
  assert.deepEqual(botStepDescriptor("ask_user_question", {}), { kind: "waiting", label: "Asked you a question" });
  assert.deepEqual(botStepDescriptor("read_file", "not an object"), { kind: "reading", label: "Read 1 file" });
});
```

Add to `main/services/bot-runtime/live-projection.test.ts`. Add `countingTool` to the import from `./test-support/fixtures.js`. Below the existing "files the Bot wrote…" test:

```ts
test("tool calls carry a kind, a past-tense label and a short safe detail; results say ok, failed or blocked", () => {
  const result = (id: number, toolCallId: string, toolName: string, timestamp: number, code?: string) => ({
    id,
    kind: "pi.tool-result",
    data: { diagnostics: code ? [{ severity: "error", code, message: code }] : [] },
    model: [{ role: "toolResult", toolCallId, toolName, isError: code !== undefined, content: [], timestamp }],
  });
  const entries = projectBotTranscript([
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Plan dinners" }], timestamp: 900 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 1_000,
        content: [
          { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "/Users/sam/lists/grocery-list.md" } },
          { type: "toolCall", id: "c2", name: "run_command", arguments: { command: "cat /Users/sam/.ssh/id_rsa" } },
          { type: "toolCall", id: "c3", name: "web_search", arguments: { query: "lisbon trains" } },
        ],
      }],
    },
    result(3, "c1", "read_file", 1_400),
    result(4, "c2", "run_command", 1_050, "blocked"),
    result(5, "c3", "web_search", 2_000, "tool_error"),
  ] as never);
  const assistant = entries.find((entry) => entry.type === "assistant");
  assert.ok(assistant?.type === "assistant");
  assert.deepEqual(assistant.toolCalls[0], { id: "c1", name: "read_file", kind: "reading", label: "Read 1 file", detail: "grocery-list.md" });
  assert.equal(assistant.toolCalls[1]!.kind, "command");
  assert.doesNotMatch(assistant.toolCalls[1]!.detail ?? "", /\/Users|id_rsa/u);
  assert.deepEqual(assistant.toolCalls[2], { id: "c3", name: "web_search", kind: "searching", label: "Searched the web", detail: "lisbon trains" });
  const results = entries.flatMap((entry) =>
    entry.type === "tool_result" ? [[entry.toolCallId, entry.status, entry.durationMs, entry.at]] : [],
  );
  assert.deepEqual(results, [
    ["c1", "ok", 400, 1_400],
    ["c2", "blocked", 50, 1_050],
    ["c3", "failed", 1_000, 2_000],
  ]);
});

test("a tool the Bot's access refused is blocked, a tool that broke is failed, and neither looks like the other", async () => {
  const shell = countingTool("run_command");
  const search = countingTool("web_search", async () => {
    throw new Error("The search service is down.");
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: "ls" }), fauxToolCall("web_search", { text: "trains" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("I couldn't do that one."),
  ]);
  const live = await start(fauxModels, {
    service: {
      extension: recordingDeps({
        tools: [
          { tool: shell, replay: "unsafe" },
          { tool: search, replay: "unsafe" },
        ],
        policy: (name) => (name === "run_command" ? { allowed: false, reason: "The shell is off for this Bot." } : { allowed: true }),
      }),
    },
  });
  try {
    const sent = await live.service.send("bot:a", { text: "go", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    const view = await (await live.service.conversation("bot:a")).context(ctx);
    const statuses = new Map(
      projectBotTranscript(view.entries).flatMap((entry) => (entry.type === "tool_result" ? [[entry.toolName, entry]] : [])),
    );
    assert.equal(statuses.get("run_command")?.status, "blocked");
    assert.equal(statuses.get("web_search")?.status, "failed");
    assert.deepEqual(shell.executions, [], "a refused tool never runs");
    for (const entry of statuses.values()) {
      assert.ok(typeof entry.durationMs === "number" && entry.durationMs >= 0);
    }
  } finally {
    await live.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/bot-runtime/bot-activity-detail.test.ts main/services/bot-runtime/live-projection.test.ts`
Expected: FAIL. `Cannot find module './bot-activity-detail.js'`, then (once the module exists) `toolCalls[0]` has only `{ id, name }` and `status` is undefined.

- [ ] **Step 3: Write the descriptor**

```ts
// main/services/bot-runtime/bot-activity-detail.ts
// One Bot tool call, as the chat may show it (spec §6 "Projection changes"):
// its phase kind, a past-tense label and a short, safe detail. The detail is
// built here in main and only from allow-listed arguments: a file's base name,
// a search query or pattern, or a command (the model's own description when it
// gave one). Text passes the diagnostic redactor before it is cut, so a secret
// is never split past it. Arguments of connection tools are never shown.

import {
  botStepPhrase,
  botToolApp,
  botToolPhase,
  type BotToolPhase,
} from "../../../renderer/shared/bot-activity.js";
import { sanitizeDiagnosticText } from "../diagnostics-contract.js";

export const BOT_STEP_DETAIL_CHARS = 80;
/** Longest argument read before redaction; enough for any useful first 80 characters. */
const RAW_DETAIL_CHARS = 4_000;

export interface BotStepDescriptor {
  kind: BotToolPhase;
  label: string;
  detail?: string;
  app?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function baseName(value: unknown): string | undefined {
  const text = stringOf(value);
  if (!text) return undefined;
  const parts = text.replace(/\\/gu, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeDiagnosticText([...value].slice(0, RAW_DETAIL_CHARS).join(""), RAW_DETAIL_CHARS);
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > BOT_STEP_DETAIL_CHARS
    ? `${points.slice(0, BOT_STEP_DETAIL_CHARS - 1).join("").trimEnd()}…`
    : clean;
}

function rawDetail(toolName: string, kind: BotToolPhase, args: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "reading":
    case "editing":
      return toolName === "glob" || toolName === "grep"
        ? stringOf(args.pattern)
        : baseName(args.path ?? args.filePath ?? args.directory);
    case "command":
      return stringOf(args.description) ?? stringOf(args.command);
    case "searching":
      return stringOf(args.query);
    default:
      return undefined;
  }
}

export function botStepDescriptor(toolName: string, args: unknown): BotStepDescriptor {
  const app = botToolApp(toolName);
  const kind = botToolPhase(toolName, app);
  const detail = bounded(rawDetail(toolName, kind, record(args)));
  return {
    kind,
    label: botStepPhrase(kind, 1, app),
    ...(detail ? { detail } : {}),
    ...(app ? { app } : {}),
  };
}
```

- [ ] **Step 4: Extend the shared types**

In `renderer/shared/bot-live.ts`, add the import and replace `BotTranscriptToolCall`:

```ts
import type { BotToolPhase } from "./bot-activity.js";
```

```ts
export interface BotTranscriptToolCall {
  id: string;
  name: string;
  /** The phase this call puts its Bot in (`botToolPhase`). */
  kind: BotToolPhase;
  /** Past tense, for recaps: "Read 1 file", "Used Notion". */
  label: string;
  /** A short, safe object of the action, built and redacted in main. */
  detail?: string;
  /** The connection's display label, for connection tools. */
  app?: string;
}

/** How a tool call ended. `blocked`: the Bot's access or the person refused it before it ran. */
export type BotToolResultStatus = "ok" | "failed" | "blocked";
```

Replace the `tool_result` member of `BotTranscriptEntry`:

```ts
  | {
      id: string;
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      status: BotToolResultStatus;
      /** From the answer that made the call to its result. */
      durationMs?: number;
      at?: number;
    }
```

- [ ] **Step 5: Project them in main**

In `main/services/bot-runtime/live-projection.ts`:

1. Import the descriptor and the status type:

```ts
import { botStepDescriptor } from "./bot-activity-detail.js";
```

and add `type BotToolResultStatus,` to the existing `../../../renderer/shared/bot-live.js` import.

2. Add above `projectBotTranscript`:

```ts
/** `blocked` when Pi's `beforeTool` refused the call (policy, a denied approval, ingress); any other error failed. */
function toolResultStatus(record: EntryRecord, isError: boolean): BotToolResultStatus {
  if (!isError) return "ok";
  const diagnostics = (record.data as { diagnostics?: unknown } | undefined)?.diagnostics;
  const blocked = Array.isArray(diagnostics) && diagnostics.some((item) => (item as { code?: unknown } | null)?.code === "blocked");
  return blocked ? "blocked" : "failed";
}
```

3. In `projectBotTranscript`, next to `homeFileCalls`, add:

```ts
  /** When the answer that made each call was written, for its duration. */
  const callStartedAt = new Map<string, number>();
```

4. In the `pi.assistant` branch, replace

```ts
      const toolCalls = calls.map((call) => ({ id: call.id, name: call.name }));
```

with

```ts
      for (const call of calls) {
        if (typeof message.timestamp === "number") callStartedAt.set(call.id, message.timestamp);
      }
      const toolCalls = calls.map((call) => ({ id: call.id, name: call.name, ...botStepDescriptor(call.name, call.arguments) }));
```

5. In the `pi.tool-result` branch, replace the `mapped.push({ entry: { id, type: "tool_result", … } })` block with:

```ts
      const startedAt = callStartedAt.get(message.toolCallId);
      const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
      mapped.push({
        entry: {
          id,
          type: "tool_result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          status: toolResultStatus(record, message.isError),
          ...(startedAt !== undefined && at !== undefined ? { durationMs: Math.max(0, at - startedAt) } : {}),
          ...(at === undefined ? {} : { at }),
        },
        turn,
      });
```

`textOf` already drops thinking parts. Do not change it.

- [ ] **Step 6: Update the renderer fixtures for the new required fields**

`renderer/main/bots/bot-transcript-rows.test.ts`:

```ts
const step = (id: string, text: string): BotTranscriptEntry => ({
  id,
  type: "assistant",
  text,
  toolCalls: [{ id: `${id}-call`, name: "web_search", kind: "searching", label: "Searched the web" }],
  stopReason: "toolUse",
});
```

```ts
const result = (id: string): BotTranscriptEntry => ({
  id,
  type: "tool_result",
  toolCallId: `${id}-call`,
  toolName: "web_search",
  isError: false,
  status: "ok",
});
```

`renderer/main/bots/bot-chat-pane.test.tsx`: in the "text before a tool call…" test, use `toolCalls: [{ id: "t1", name: "calendar", kind: "working", label: "Used a tool" }]`, and add `status: "ok"` to its `tool_result`. In `toolStep`, use `toolCalls: [{ id: \`${id}-call\`, name: "web_search", kind: "searching", label: "Searched the web" }]`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test main/services/bot-runtime/bot-activity-detail.test.ts main/services/bot-runtime/live-projection.test.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: PASS.

Run: `npx tsx --test main/services/aiden-remote-bot-session.test.ts`
Expected: PASS. Remote picks wire fields explicitly, so its entries are unchanged.

- [ ] **Step 8: Register and type-check**

Append ` main/services/bot-runtime/bot-activity-detail.test.ts` to the end of `test:bot-runtime` in `package.json`. In `scripts/ci-test-registry.json`, add `"main/services/bot-runtime/bot-activity-detail.test.ts",` directly after `"main/services/bot-runtime/live-projection.test.ts",`.

Run: `npm run test:ci-policy && npm run type-check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add main/services/bot-runtime/bot-activity-detail.ts main/services/bot-runtime/bot-activity-detail.test.ts main/services/bot-runtime/live-projection.ts main/services/bot-runtime/live-projection.test.ts renderer/shared/bot-live.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: tool steps carry kind, label, safe detail, and ok/failed/blocked status"
```

---

### Task 3: Live activity in the projection

**Files:**
- Modify: `renderer/shared/bot-live.ts`, `main/services/bot-runtime/live-projection.ts`, `main/services/bot-runtime/bot-session-main.ts`, `main/handlers/bots.ts`
- Test: `main/services/bot-runtime/live-projection.test.ts`, `main/handlers/bot-live.test.ts` (fake projection), `renderer/main/bots/bot-chat-pane.test.tsx` (snapshot helper)

**Interfaces:**
- Consumes: `pickActiveToolSlot`, `botPhaseWord`, `BotActivityPhase` (Task 1); `botStepDescriptor` (Task 2).
- Produces:
  - `interface BotLiveActivityStep { kind: BotToolPhase; label: string; detail?: string }` (label is the present-tense phase word, "Reading").
  - `interface BotLiveActivity { phase: BotActivityPhase; app?: string; startedAt: number; step?: BotLiveActivityStep }`.
  - `BotLiveSnapshot.activity: BotLiveActivity | null`; event `{ type: "activity"; activity: BotLiveActivity | null }`.
  - `export function liveBotActivity(input: BotLiveActivityInput): BotLiveActivity | null` with `interface BotLiveActivityInput { entries: readonly EntryRecord[]; docs: Readonly<Record<string, unknown>>; waiting: boolean; stopping: boolean; resuming: boolean; startedAt: number }`. It returns null when `pi.live.run` is absent.
  - `BotLiveProjectionDeps` gains `approvalPending?(botId): boolean` and `now?(): number`.
  - `BotLiveProjection` gains `notifyStopping(botId): void`, `notifyResuming(botId): void`, `refreshActivity(botId): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `live-projection.test.ts`, add `liveBotActivity` to the `./live-projection.js` import and `fauxText, fauxThinking` to the faux import. Then add:

```ts
function observedPhases(events: readonly BotLiveEvent[]): Array<string | null> {
  const phases: Array<string | null> = [];
  for (const event of events) {
    const activity = event.type === "activity" ? event.activity : event.type === "snapshot" ? event.snapshot.activity : undefined;
    if (activity === undefined) continue;
    const phase = activity?.phase ?? null;
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases;
}

/** Every phase seen appears in `allowed`, in that order (frames may coalesce, so some can be skipped). */
function inOrder(phases: ReadonlyArray<string | null>, allowed: readonly string[]): boolean {
  let at = 0;
  for (const phase of phases) {
    if (phase === null) continue;
    const found = allowed.indexOf(phase, at);
    if (found === -1) return false;
    at = found;
  }
  return true;
}

// Test 1
test("a reply's activity follows the work: getting ready, reading while a file tool runs, writing, then nothing", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reader = countingTool("read_file", async () => {
    await released;
    return "eggs, milk";
  });
  const fauxModels = createFauxModels(
    [
      fauxAssistantMessage([fauxToolCall("read_file", { text: "groceries" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("word ".repeat(60)),
    ],
    { tokensPerSecond: 40 },
  );
  const live = await start(fauxModels, {
    service: { extension: recordingDeps({ tools: [{ tool: reader, replay: "safe" }] }) },
  });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    assert.equal(snapshot.activity, null);
    const sent = await live.service.send("bot:a", { text: "What's on my list?", requestId: "desk-1" });
    await waitFor(() => tape.view?.activity?.phase === "reading", { what: "the reading phase" });
    assert.deepEqual(tape.view?.activity?.step, { kind: "reading", label: "Reading" });
    assert.ok((tape.view?.activity?.startedAt ?? 0) > 0);
    release();
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the line to clear" });
    const phases = observedPhases(tape.events);
    assert.ok(inOrder(phases, ["preparing", "thinking", "reading", "thinking", "writing"]), phases.join(" → "));
    assert.ok(phases.includes("writing"), phases.join(" → "));
    assert.equal(phases[phases.length - 1], null);
    unsubscribe();
  } finally {
    await live.close();
  }
});

// Test 2
test("thinking text is never projected, in the transcript or the live activity", () => {
  const entries = [
    { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [{ role: "assistant", stopReason: "stop", timestamp: 2, content: [fauxThinking("SECRET-PLAN"), fauxText("Done.")] }],
    },
  ];
  assert.doesNotMatch(JSON.stringify(projectBotTranscript(entries as never)), /SECRET-PLAN/u);
  const activity = liveBotActivity({
    entries: entries as never,
    docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, generation: { attempt: 1, message: { content: [fauxThinking("SECRET-PLAN")] } } } },
    waiting: false,
    stopping: false,
    resuming: false,
    startedAt: 5,
  });
  assert.deepEqual(activity, { phase: "thinking", startedAt: 5 });
});

// Test 3
test("the live phase reads stop, a waiting card, compaction, the newest running tool, and resume, in that order", () => {
  const user = { id: 1, kind: "pi.user", model: [{ role: "user", content: "go", timestamp: 1 }] };
  const calling = {
    id: 2,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 2,
      content: [
        { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "lists/a.md" } },
        { type: "toolCall", id: "c2", name: "web_search", arguments: { query: "tofu bowls" } },
      ],
    }],
  };
  const tools = [
    { callId: "c1", name: "read_file", status: "running" },
    { callId: "c2", name: "web_search", status: "running" },
  ];
  const base = { entries: [user, calling] as never, waiting: false, stopping: false, resuming: false, startedAt: 9 };
  const docs = (live: Record<string, unknown>) => ({ "pi.live": { run: { taskId: 1, inputs: [1] }, ...live } });
  assert.equal(liveBotActivity({ ...base, docs: {} }), null, "no run, no line");
  assert.deepEqual(liveBotActivity({ ...base, docs: docs({ tools }) }), {
    phase: "searching",
    startedAt: 9,
    step: { kind: "searching", label: "Searching the web", detail: "tofu bowls" },
  });
  assert.equal(liveBotActivity({ ...base, docs: docs({ compactions: [{ blocking: true }], tools }) })?.phase, "tidying");
  assert.equal(liveBotActivity({ ...base, waiting: true, docs: docs({ tools }) })?.phase, "waiting");
  assert.equal(liveBotActivity({ ...base, waiting: true, stopping: true, docs: docs({ tools }) })?.phase, "stopping");
  assert.equal(liveBotActivity({ ...base, entries: [user] as never, docs: docs({}) })?.phase, "preparing");
  assert.equal(liveBotActivity({ ...base, docs: docs({}) })?.phase, "thinking");
  assert.equal(liveBotActivity({ ...base, resuming: true, docs: docs({}) })?.phase, "resuming");
  assert.equal(
    liveBotActivity({ ...base, docs: docs({ generation: { attempt: 1, message: { content: [{ type: "text", text: "Here" }] } } }) })?.phase,
    "writing",
  );
});

// Test 4 (Review Focus 5)
test("Stop pressed while nothing runs is ignored, so the next reply never starts at Stopping", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("word ".repeat(40))], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    live.projection.notifyStopping("bot:a");
    const sent = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => tape.view?.activity === null && tape.view.state.kind === "idle", { what: "the reply to land" });
    assert.equal(observedPhases(tape.events).includes("stopping"), false);
    unsubscribe();
  } finally {
    await live.close();
  }
});
```

Extend two existing tests:

- "subscribing mid-stream returns a snapshot that already has the partial reply": after the `partial` assertion add `assert.equal(snapshot.activity?.phase, "writing");`.
- "Stop ends the running reply…": replace `const state = await live.service.stop("bot:a");` with

```ts
    live.projection.notifyStopping("bot:a");
    const state = await live.service.stop("bot:a");
```

  and after the `waitFor` add:

```ts
    const phases = observedPhases(tape.events);
    assert.ok(phases.includes("stopping"), phases.join(" → "));
    assert.equal(phases[phases.length - 1], null);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/bot-runtime/live-projection.test.ts`
Expected: FAIL. `liveBotActivity` is not exported, `notifyStopping` is not a function, and `snapshot.activity` is undefined.

- [ ] **Step 3: Extend the live types**

In `renderer/shared/bot-live.ts`, extend the Task 2 import to `import type { BotActivityPhase, BotToolPhase } from "./bot-activity.js";` and add:

```ts
/** The step behind the current phase, for the Mac's hover peek and Detailed steps. */
export interface BotLiveActivityStep {
  kind: BotToolPhase;
  /** Present tense, the phase word: "Reading", "Using Notion". */
  label: string;
  detail?: string;
}

/** What a Bot in a running turn is doing now (spec §5). Null when no turn runs. */
export interface BotLiveActivity {
  phase: BotActivityPhase;
  /** The connection's label, for `app`. */
  app?: string;
  /** When the turn started, for elapsed time. */
  startedAt: number;
  step?: BotLiveActivityStep;
}
```

Add `activity: BotLiveActivity | null;` to `BotLiveSnapshot` (after `question`). Add `| { type: "activity"; activity: BotLiveActivity | null }` to `BotLiveEventBody`. In `applyBotLiveEvent`'s switch, add:

```ts
    case "activity":
      return { ...snapshot, seq: event.seq, activity: event.activity };
```

- [ ] **Step 4: Derive the activity in the projection**

In `main/services/bot-runtime/live-projection.ts`:

1. Imports: add `pickActiveToolSlot, botPhaseWord, type BotActivityPhase` from `../../../renderer/shared/bot-activity.js`, and `type BotLiveActivity` to the `bot-live.js` import.

2. Below `liveRunActive`, add:

```ts
interface LiveDocView {
  run?: unknown;
  generation?: { message?: { content?: unknown } };
  tools?: Array<{ callId: string; name: string; status: string }>;
  compactions?: Array<{ blocking?: boolean }>;
}

export interface BotLiveActivityInput {
  entries: readonly EntryRecord[];
  docs: Readonly<Record<string, unknown>>;
  /** An approval or A–E question is open. */
  waiting: boolean;
  /** The person pressed Stop and the run has not ended. */
  stopping: boolean;
  /** This run is a Resume and has not moved on yet. */
  resuming: boolean;
  startedAt: number;
}

/** Whether the newest input already has an assistant entry after it. */
function inputAnswered(entries: readonly EntryRecord[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index]!.kind;
    if (kind === "pi.assistant") return true;
    if (kind === "pi.user") return false;
  }
  return false;
}

/** The arguments of tool call `callId`, from the answer that made it. */
function callArguments(entries: readonly EntryRecord[], callId: string): unknown {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = firstMessage(entries[index]!);
    if (message?.role !== "assistant") continue;
    const call = message.content.find((part): part is ToolCall => part.type === "toolCall" && part.id === callId);
    if (call) return call.arguments;
  }
  return undefined;
}

/**
 * The phase of a run from `pi.live` (spec §5): Stop, then an open card,
 * then compaction inside the turn, then the newest running tool (§5.2), then
 * the reply's text, then Resume, then thinking (or "getting ready" before
 * the model produced anything). Thinking content is read only to know the
 * model is generating; its text is never copied.
 */
export function liveBotActivity(input: BotLiveActivityInput): BotLiveActivity | null {
  const live = input.docs["pi.live"] as LiveDocView | undefined;
  if (live?.run === undefined) return null;
  const at = (phase: BotActivityPhase): BotLiveActivity => ({ phase, startedAt: input.startedAt });
  if (input.stopping) return at("stopping");
  if (input.waiting) return at("waiting");
  if (live.compactions?.some((compaction) => compaction.blocking === true)) return at("tidying");
  const slot = pickActiveToolSlot(live.tools);
  if (slot) {
    const step = botStepDescriptor(slot.name, callArguments(input.entries, slot.callId));
    return {
      phase: step.kind,
      startedAt: input.startedAt,
      ...(step.app ? { app: step.app } : {}),
      step: { kind: step.kind, label: botPhaseWord(step.kind, step.app), ...(step.detail ? { detail: step.detail } : {}) },
    };
  }
  const content = live.generation?.message?.content;
  if (Array.isArray(content) && textOf(content as TextContent[]).trim()) return at("writing");
  if (input.resuming) return at("resuming");
  if (Array.isArray(content) && content.length > 0) return at("thinking");
  return at(inputAnswered(input.entries) ? "thinking" : "preparing");
}
```

3. Extend `BotLiveProjectionDeps`:

```ts
  /** Whether a tool approval is waiting on the person. */
  approvalPending?(botId: string): boolean;
  /** Clock for `startedAt`; defaults to `Date.now`. */
  now?(): number;
```

4. Extend `BotLiveProjection`:

```ts
  /** The person pressed Stop: the running turn reads "Stopping" until it ends. Ignored when nothing runs. */
  notifyStopping(botId: string): void;
  /** The next run starts from Resume: it reads "Picking up where it left off" until it moves on. */
  notifyResuming(botId: string): void;
  /** An approval appeared or settled: re-derive the activity. */
  refreshActivity(botId: string): Promise<void>;
```

5. Extend `Feed`:

```ts
  activity: BotLiveActivity | null;
  /** When the current running turn started. */
  startedAt: number;
  stopping: boolean;
  resuming: boolean;
  /** The newest frame, so approvals, questions and Stop can re-derive the activity. */
  frame: { entries: readonly EntryRecord[]; docs: Readonly<Record<string, unknown>> };
```

6. Inside `createBotLiveProjection`, below `const newEpoch = …`:

```ts
  const now = deps.now ?? Date.now;
  /** Bots whose next run is a Resume. */
  const resumingBots = new Set<string>();
```

Add `activity: feed.activity,` to the object `snapshotOf` returns. Below `emitSnapshot`, add:

```ts
  function waitingOn(botId: string): boolean {
    return (deps.question?.(botId) ?? null) !== null || deps.approvalPending?.(botId) === true;
  }

  /** Null unless the session is running: a paused Bot keeps `pi.live.run` but is not working. */
  function computeActivity(feed: Feed): BotLiveActivity | null {
    if (feed.state.kind !== "running") return null;
    return (
      liveBotActivity({
        ...feed.frame,
        waiting: waitingOn(feed.botId),
        stopping: feed.stopping,
        resuming: feed.resuming,
        startedAt: feed.startedAt,
      }) ?? { phase: "preparing", startedAt: feed.startedAt }
    );
  }

  function updateActivity(feed: Feed): void {
    const activity = computeActivity(feed);
    if (activity && activity.phase !== "resuming") feed.resuming = false;
    if (JSON.stringify(activity) === JSON.stringify(feed.activity)) return;
    feed.activity = activity;
    emit(feed, { type: "activity", activity });
  }

  function startRun(feed: Feed): void {
    feed.startedAt = now();
    feed.stopping = false;
    feed.resuming = resumingBots.delete(feed.botId);
  }
```

7. Replace `onFrame` and `setState`:

```ts
  async function onFrame(feed: Feed, entries: readonly EntryRecord[], docs: Readonly<Record<string, unknown>>) {
    if (feed.ended) return;
    feed.frame = { entries, docs };
    applyEntries(feed, await resolveCards(feed.botId, projectBotTranscript(entries)));
    const partial = livePartialText(docs);
    if (partial !== feed.partial) {
      feed.partial = partial;
      emit(feed, { type: "partial", text: partial });
    }
    const runActive = liveRunActive(docs);
    if (runActive === feed.runActive) {
      updateActivity(feed);
      return;
    }
    feed.runActive = runActive;
    // The run's end is reported with its new state, so the line never flashes a phase after the reply.
    const state = await deps.state(feed.botId).catch(() => feed.state);
    setState(feed, state);
    updateActivity(feed);
    if (!runActive) {
      deps.onRunSettled?.(feed.botId, state);
      void closeIfUnwatched(feed);
    }
  }

  function setState(feed: Feed, state: BotSessionState): void {
    if (JSON.stringify(state) === JSON.stringify(feed.state)) return;
    const wasRunning = feed.state.kind === "running";
    feed.state = state;
    if (state.kind === "running" && !wasRunning) startRun(feed);
    if (state.kind !== "running") {
      feed.stopping = false;
      feed.resuming = false;
    }
    emit(feed, { type: "state", state });
    updateActivity(feed);
  }
```

8. In `openFeed`, add these fields to the `Feed` literal:

```ts
        activity: null,
        startedAt: now(),
        stopping: false,
        resuming: false,
        frame: { entries: initial.entries, docs: initial.docs },
```

Directly after the literal and before `feeds.set(botId, feed);`, add:

```ts
      if (feed.state.kind === "running") startRun(feed);
      feed.activity = computeActivity(feed);
```

9. In `syncQuestion`, after `emit(feed, { type: "question", question });`, add `updateActivity(feed);`.

10. In `notifyState`, add as the first line: `if (state.kind !== "running") resumingBots.delete(botId);`.

11. Add the three methods to the returned object:

```ts
    notifyStopping(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      void enqueueWork(feed, async () => {
        if (feed.state.kind !== "running") return;
        feed.stopping = true;
        updateActivity(feed);
      });
    },

    notifyResuming(botId) {
      resumingBots.add(botId);
    },

    async refreshActivity(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await enqueueWork(feed, async () => updateActivity(feed));
    },
```

- [ ] **Step 5: Wire main**

`main/services/bot-runtime/bot-session-main.ts`. In `createBotLiveProjection({ … })`, add `approvalPending: (botId) => botApprovals.pending(botId).length > 0,`. Next to the `botQuestions.onChange(...)` block, add:

```ts
// An approval appearing or settling changes the line to and from "Waiting for you".
botApprovals.onChange((botId) => {
  void liveProjection?.refreshActivity(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} activity view report.`, error),
  );
});
```

`main/handlers/bots.ts`. Replace the `bots:resume` and `bots:stop` handlers:

```ts
  ipcMain.handle("bots:resume", async (_event, input: unknown) => {
    const { botId, requestId } = parseBotSessionAction(input, "resume");
    botLiveProjection().notifyResuming(botId);
    return (await botSessionRuntime()).resume(botId, requestId);
  });
```

```ts
  ipcMain.handle("bots:stop", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    botLiveProjection().notifyStopping(botId);
    return (await botSessionRuntime()).stop(botId);
  });
```

- [ ] **Step 6: Update the fakes and fixtures**

`main/handlers/bot-live.test.ts`: add `activity: null,` to the fake snapshot, and add to the fake projection:

```ts
    notifyStopping: () => undefined,
    notifyResuming: () => undefined,
    refreshActivity: async () => undefined,
```

`renderer/main/bots/bot-chat-pane.test.tsx`: add `activity: null,` to the `snapshot()` helper defaults.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/handlers/bot-live.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: PASS.

Run: `npm run test:bot-runtime && npm run type-check`
Expected: PASS. If `bot-starter.test.ts` or another test builds a `BotLiveSnapshot` by hand, add `activity: null`.

- [ ] **Step 8: Commit**

```bash
git add renderer/shared/bot-live.ts main/services/bot-runtime/live-projection.ts main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-session-main.ts main/handlers/bots.ts main/handlers/bot-live.test.ts renderer/main/bots/bot-chat-pane.test.tsx
git commit -m "Bots: project the live activity phase from pi.live, cards, Stop and Resume"
```

---

### Task 4: `chatActivity` on the Bot record

**Files:**
- Modify: `renderer/shared/bots.ts`, `main/services/bot-store-core.ts`, `main/handlers/bot-params.ts`, `renderer/main/bots/bot-identity.ts`
- Test: `main/services/bot-store-core.test.ts`, `main/handlers/bot-params.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `renderer/shared/bots.ts`):
  - `BOT_CHAT_ACTIVITY_LEVELS = ["quiet", "summary", "detailed"] as const`, `type BotChatActivityLevel`
  - `BOT_CHAT_ACTIVITY_WORDINGS = ["follows", "thinking"] as const`, `type BotChatActivityWording` (re-exported to match Task 1's union)
  - `interface BotChatActivity { level: BotChatActivityLevel; wording: BotChatActivityWording }`, `DEFAULT_BOT_CHAT_ACTIVITY`
  - `parseBotChatActivity(value: unknown): BotChatActivity | undefined` (exact keys, enum values), `resolveBotChatActivity(value: BotChatActivity | undefined): BotChatActivity`
  - `BotDefinition.chatActivity?: BotChatActivity`; `BotUpdateInput.chatActivity?: BotChatActivity` (absent keeps the stored value)
  - `BotIdentityPatch.chatActivity?: BotChatActivity`

- [ ] **Step 1: Write the failing tests**

Add to `main/services/bot-store-core.test.ts` (import `BotIdentityRevisionConflictError` is not needed):

```ts
// Test 1 (Review Focus 1)
test("a Bot's chat activity is saved with a new revision, and identity edits that leave it out keep it", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({
      name: "Planner",
      instructions: "Plan dinners.",
      avatar: { version: 1, shape: "hex", color: "sun" },
    });
    assert.equal(created.chatActivity, undefined, "new Bots store nothing: absent means Quiet");
    const chosen = await store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: created.name,
      instructions: created.instructions,
      avatar: created.avatar,
      chatActivity: { level: "summary", wording: "thinking" },
    });
    assert.deepEqual(chosen.chatActivity, { level: "summary", wording: "thinking" });
    assert.notEqual(chosen.revision, created.revision);
    const renamed = await store.update({
      id: created.id,
      expectedRevision: chosen.revision,
      name: "Meal planner",
      instructions: created.instructions,
      avatar: created.avatar,
    });
    assert.equal(renamed.name, "Meal planner");
    assert.deepEqual(renamed.chatActivity, { level: "summary", wording: "thinking" });
    await assert.rejects(
      store.update({
        id: created.id,
        expectedRevision: renamed.revision,
        name: renamed.name,
        instructions: renamed.instructions,
        avatar: renamed.avatar,
        chatActivity: { level: "verbose", wording: "follows" } as never,
      }),
      /chat activity/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Test 2 (Review Focus 2)
test("a stored chat activity that isn't a current choice reads as absent and keeps the Bot", async () => {
  const { root } = await fixture();
  try {
    const bot = (id: string, chatActivity: unknown) => ({
      id,
      name: id,
      instructions: "x",
      avatar: { version: 1, shape: "orb", color: "sky" },
      createdAt: 1,
      updatedAt: 1,
      chatActivity,
    });
    await writeFile(
      join(root, "bots.json"),
      JSON.stringify({
        version: 1,
        bots: [
          bot("bot:newer", { level: "verbose", wording: "follows" }),
          bot("bot:extra", { level: "summary", wording: "follows", sound: true }),
          bot("bot:good", { level: "detailed", wording: "follows" }),
        ],
      }),
    );
    const store = createBotStore({ root: () => root, now: () => 50 });
    const byId = new Map((await store.list()).map((entry) => [entry.id, entry.chatActivity]));
    assert.equal(byId.size, 3, "no Bot is lost to a bad setting");
    assert.equal(byId.get("bot:newer"), undefined);
    assert.equal(byId.get("bot:extra"), undefined);
    assert.deepEqual(byId.get("bot:good"), { level: "detailed", wording: "follows" });
    assert.deepEqual(resolveBotChatActivity(byId.get("bot:newer")), { level: "quiet", wording: "follows" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

and extend the import: `import { DEFAULT_BOT_AVATAR, resolveBotChatActivity } from "../../renderer/shared/bots.js";`.

Add to `main/handlers/bot-params.test.ts`:

```ts
test("a Bot update may carry an exact chat activity choice, and nothing else new", () => {
  const fields = {
    id: "bot-1",
    expectedRevision: "botrev:one",
    name: "Planner",
    instructions: "Plan.",
    avatar: { version: 1 as const, shape: "hex" as const, color: "sun" as const },
  };
  assert.deepEqual(parseBotUpdate({ ...fields, chatActivity: { level: "detailed", wording: "thinking" } }), {
    ...fields,
    description: undefined,
    chatActivity: { level: "detailed", wording: "thinking" },
  });
  assert.equal("chatActivity" in parseBotUpdate(fields), false);
  assert.throws(() => parseBotUpdate({ ...fields, chatActivity: { level: "loud", wording: "follows" } }), /chat activity/u);
  assert.throws(
    () => parseBotUpdate({ ...fields, chatActivity: { level: "quiet", wording: "follows", extra: 1 } }),
    /chat activity/u,
  );
  assert.throws(() => parseBotUpdate({ ...fields, chatActivity: "quiet" }), /chat activity/u);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/bot-store-core.test.ts main/handlers/bot-params.test.ts`
Expected: FAIL. `resolveBotChatActivity` is not exported, and `parseBotUpdate` rejects the `chatActivity` key as `Invalid bot update fields`.

- [ ] **Step 3: Add the shared type**

In `renderer/shared/bots.ts`, after `BOT_LIMITS`:

```ts
export const BOT_CHAT_ACTIVITY_LEVELS = ["quiet", "summary", "detailed"] as const;
export type BotChatActivityLevel = (typeof BOT_CHAT_ACTIVITY_LEVELS)[number];
export const BOT_CHAT_ACTIVITY_WORDINGS = ["follows", "thinking"] as const;
export type BotChatActivityWording = (typeof BOT_CHAT_ACTIVITY_WORDINGS)[number];

/** How much a Bot chat shows while the Bot works, and what its status line says (spec §7). */
export interface BotChatActivity {
  level: BotChatActivityLevel;
  wording: BotChatActivityWording;
}

/** What an absent setting means; new Bots never store it. */
export const DEFAULT_BOT_CHAT_ACTIVITY: BotChatActivity = { level: "quiet", wording: "follows" };

/** Exact check: both keys, current values, nothing else. */
export function parseBotChatActivity(value: unknown): BotChatActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.every((key) => key === "level" || key === "wording")) return undefined;
  if (!includes(BOT_CHAT_ACTIVITY_LEVELS, record.level) || !includes(BOT_CHAT_ACTIVITY_WORDINGS, record.wording)) return undefined;
  return { level: record.level, wording: record.wording };
}

export function resolveBotChatActivity(value: BotChatActivity | undefined): BotChatActivity {
  return value ? { level: value.level, wording: value.wording } : { ...DEFAULT_BOT_CHAT_ACTIVITY };
}
```

`includes` is declared further down the file as a function declaration, so it is hoisted. Add to `BotDefinition` after `avatar`:

```ts
  /** Absent: Quiet, Follows the work. */
  chatActivity?: BotChatActivity;
```

Replace `BotUpdateInput`:

```ts
export interface BotUpdateInput extends BotCreateInput {
  id: string;
  expectedRevision: string;
  /** Absent keeps the stored choice, so identity edits never reset it. */
  chatActivity?: BotChatActivity;
}
```

To keep one union, change Task 1's local declaration in `renderer/shared/bot-activity.ts` to a re-export:

```ts
export type { BotChatActivityWording } from "./bots.js";
```

Then add `import type { BotChatActivityWording } from "./bots.js";` for its own use.

- [ ] **Step 4: Normalise and keep it in the store**

`main/services/bot-store-core.ts`: import `parseBotChatActivity`. In `projectBot`, add to `projected` after `avatar,`:

```ts
    // A choice this build does not know reads as absent (Quiet); the Bot itself is kept.
    ...(parseBotChatActivity(bot.chatActivity) ? { chatActivity: parseBotChatActivity(bot.chatActivity)! } : {}),
```

In `update`, after `const normalized = normalizeInput(input);`:

```ts
        const chatActivity = input.chatActivity === undefined ? undefined : parseBotChatActivity(input.chatActivity);
        if (input.chatActivity !== undefined && !chatActivity) throw new Error("Choose a valid chat activity.");
```

and inside the draft mutation, after the avatar assignment:

```ts
          if (chatActivity) bot.chatActivity = chatActivity;
```

`main/handlers/bot-params.ts`: import `parseBotChatActivity` from `../../renderer/shared/bots.js`. Change `UPDATE_KEYS` to `new Set([...CREATE_KEYS, "chatActivity", "expectedRevision", "id"])`, and `parseBotUpdate` to:

```ts
export function parseBotUpdate(value: unknown): BotUpdateInput {
  const record = exact(value, UPDATE_KEYS, "bot update fields");
  const chatActivity = record.chatActivity === undefined ? undefined : parseBotChatActivity(record.chatActivity);
  if (record.chatActivity !== undefined && !chatActivity) throw new Error("Invalid bot chat activity.");
  return {
    id: parseBotId(record.id),
    expectedRevision: parseBotRevision(record.expectedRevision),
    ...createFields(record),
    ...(chatActivity ? { chatActivity } : {}),
  };
}
```

- [ ] **Step 5: Let the renderer patch it**

`renderer/main/bots/bot-identity.ts`: change the `BotAvatar` import to `import type { BotAvatar, BotChatActivity, BotDefinition } from "../../shared/bots";`, add `chatActivity: BotChatActivity;` to `BotIdentityPatch`, and in `botsApi.update({ … })` add after `avatar: next.avatar,`:

```ts
    ...(patch.chatActivity ? { chatActivity: patch.chatActivity } : {}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test main/services/bot-store-core.test.ts main/handlers/bot-params.test.ts && npx tsx --test main/services/aiden-remote-bots.test.ts`
Expected: PASS. Remote `PATCH` builds its update without `chatActivity`, so the stored choice is kept and Remote's tests are unchanged.

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/shared/bots.ts renderer/shared/bot-activity.ts main/services/bot-store-core.ts main/services/bot-store-core.test.ts main/handlers/bot-params.ts main/handlers/bot-params.test.ts renderer/main/bots/bot-identity.ts
git commit -m "Bots: store a per-Bot chat activity choice, kept across identity edits"
```

---

### Task 5: `BotStatusLine` in the Bot chat

**Files:**
- Create: `renderer/main/bots/bot-status-line.tsx`
- Test: `renderer/main/bots/bot-status-line.test.tsx`
- Modify: `renderer/main/bots/bot-chat-pane.tsx`, `renderer/main/bots/bot-chat-pane.test.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `botActivityDisplay`, `botElapsedLabel`, `nextBotAnnouncement`, `BOT_STILL_GOING_AFTER_MS`, `BotAnnouncement` (Task 1); `BotLiveActivity` (Task 3); `BotChatActivityWording`, `resolveBotChatActivity` (Task 4); `AidenActivityMark`.
- Produces: `BotStatusLine({ activity, wording, now?, onStop? }: { activity: BotLiveActivity; wording: BotChatActivityWording; now?: number; onStop?(): void })`. `now` freezes the clock (tests, previews); `onStop` shows Stop after 20 seconds.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-status-line.test.tsx
import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotLiveActivity } from "../../shared/bot-live";
import { BotStatusLine } from "./bot-status-line";

afterEach(cleanup);

const reading: BotLiveActivity = {
  phase: "reading",
  startedAt: 1_000,
  step: { kind: "reading", label: "Reading", detail: "grocery-list.md" },
};

test("the line says the phase with its step on the Mac, and only Thinking with Always Thinking", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000} />);
  assert.ok(screen.getByRole("status", { name: "Reading, grocery-list.md" }));
  cleanup();
  render(<BotStatusLine activity={reading} wording="thinking" now={1_000} />);
  assert.ok(screen.getByRole("status", { name: "Thinking" }));
  assert.equal(screen.queryByText(/grocery-list\.md/u), null, "Always Thinking never peeks at the step");
});

test("waiting keeps its word under Always Thinking, and an unknown phase reads as Working", () => {
  render(<BotStatusLine activity={{ phase: "waiting", startedAt: 0 }} wording="thinking" now={0} />);
  assert.ok(screen.getByRole("status", { name: "Waiting for you" }));
  cleanup();
  render(<BotStatusLine activity={{ phase: "browsing" as never, startedAt: 0 }} wording="follows" now={0} />);
  assert.ok(screen.getByRole("status", { name: "Working" }));
});

test("after 20 seconds the line shows elapsed time and Stop; after 2 minutes, a still-going note", () => {
  const calls: string[] = [];
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 19_000} onStop={() => calls.push("stop")} />);
  assert.equal(screen.queryByRole("button", { name: "Stop" }), null);
  assert.equal(screen.queryByText(/19s/u), null);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 72_000} onStop={() => calls.push("stop")} />);
  assert.ok(screen.getByText("· 1m 12s"));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  assert.deepEqual(calls, ["stop"]);
  assert.equal(screen.queryByRole("note"), null);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 121_000} />);
  assert.ok(screen.getByRole("note"));
  assert.ok(screen.getByText("Still going. I'll message you when it's done."));
});
```

In `renderer/main/bots/bot-chat-pane.test.tsx`, replace the test "a just-sent message shows the Bot working before any reply text arrives" with:

```tsx
test("a just-sent message shows the status line before any reply text arrives", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan Lisbon")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "preparing", startedAt: Date.now() },
      }),
  });
  assert.ok(await screen.findByText("Plan Lisbon"));
  assert.ok(await screen.findByRole("status", { name: "Getting ready" }));
});

test("the status line follows live activity, and hides while the reply's words stream", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "What's on my list?")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "groceries.md" } },
      }),
  });
  assert.ok(await screen.findByRole("status", { name: "Reading, groceries.md" }));
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "activity",
    activity: { phase: "writing", startedAt: Date.now() },
  });
  emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 2, type: "partial", text: "Eggs and milk." });
  await waitFor(() => assert.equal(screen.queryByText("Reading"), null));
  assert.equal(screen.queryByText("Writing"), null, "the words themselves are the signal");
});

test("a Bot set to Always Thinking says Thinking while it reads", async () => {
  await mountChat({
    "bots:get": () => botFixture({ chatActivity: { level: "quiet", wording: "thinking" } }),
    "bots:live:subscribe": () =>
      snapshot({
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "groceries.md" } },
      }),
  });
  assert.ok(await screen.findByRole("status", { name: "Thinking" }));
});
```

`mountChat` spreads `handlers` after its default `bots:get`, so the override in the third test wins.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-status-line.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. `Cannot find module './bot-status-line'`, and the pane has no status role named "Getting ready".

- [ ] **Step 3: Write the component**

```tsx
// renderer/main/bots/bot-status-line.tsx
// The one calm line a working Bot shows (spec §5, §6, §14): an activity mark
// and a word, a hover/focus peek at the current step on the Mac, elapsed time
// and Stop after 20 seconds, and a still-going note after 2 minutes. The
// accessible name changes at most once every 2 seconds.

import * as React from "react";
import { Square } from "lucide-react";
import { AidenActivityMark } from "../../components/aiden-activity-mark";
import { Button, Text } from "../../components/ui";
import {
  BOT_STILL_GOING_AFTER_MS,
  botActivityDisplay,
  botElapsedLabel,
  nextBotAnnouncement,
  type BotAnnouncement,
} from "../../shared/bot-activity";
import type { BotLiveActivity } from "../../shared/bot-live";
import type { BotChatActivityWording } from "../../shared/bots";

function useClock(fixed: number | undefined): number {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (fixed !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

/** The text screen readers hear: the newest wording, at most once per gap. */
function useAnnouncement(text: string): string {
  const [shown, setShown] = React.useState<BotAnnouncement>(() => ({ text, at: Date.now() }));
  React.useEffect(() => {
    const next = nextBotAnnouncement(shown, text, Date.now());
    if (next.shown !== shown) setShown(next.shown);
    if (next.retryInMs === undefined) return;
    const timer = window.setTimeout(() => setShown({ text, at: Date.now() }), next.retryInMs);
    return () => window.clearTimeout(timer);
  }, [text, shown]);
  return shown.text;
}

export function BotStatusLine({
  activity,
  wording,
  now: fixedNow,
  onStop,
}: {
  activity: BotLiveActivity;
  wording: BotChatActivityWording;
  /** A fixed clock (tests and previews); otherwise the line ticks each second. */
  now?: number;
  /** Shown as Stop once the turn has run for 20 seconds. */
  onStop?(): void;
}) {
  const display = botActivityDisplay(activity.phase, wording, activity.app);
  const now = useClock(fixedNow);
  const detail = wording === "follows" && display.phase !== "thinking" ? activity.step?.detail : undefined;
  const elapsed = botElapsedLabel(activity.startedAt, now);
  const stillGoing = now - activity.startedAt >= BOT_STILL_GOING_AFTER_MS;
  const announced = useAnnouncement(detail ? `${display.word}, ${detail}` : display.word);
  const shimmer = display.phase !== "waiting" && display.phase !== "stopping";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div
          role="status"
          aria-label={announced}
          tabIndex={detail ? 0 : undefined}
          data-bot-status-phase={display.phase}
          className="group/status flex h-6 min-w-0 max-w-full items-center gap-2 rounded-control outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <AidenActivityMark mark={display.mark} size={20} className="shrink-0 text-primary" />
          <span aria-hidden="true" className="flex min-w-0 items-center gap-1 text-small text-secondary">
            <span className={`shrink-0 ${shimmer ? "agent-thinking-shimmer" : ""}`}>{display.word}</span>
            {detail ? (
              <span className="hidden min-w-0 truncate text-tertiary group-hover/status:inline group-focus-visible/status:inline">
                · {detail}
              </span>
            ) : null}
            {elapsed ? <span className="shrink-0 tabular-nums text-tertiary">· {elapsed}</span> : null}
          </span>
        </div>
        {elapsed && onStop ? (
          <Button variant="transparent" size="small" onClick={onStop}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : null}
      </div>
      {stillGoing ? (
        <Text as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
          Still going. I'll message you when it's done.
        </Text>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Show it in the chat**

In `renderer/main/bots/bot-chat-pane.tsx`:

1. Imports: `import { BotStatusLine } from "./bot-status-line";` and `import { resolveBotChatActivity } from "../../shared/bots";`.
2. In the `shell`'s `autoScrollDeps`, add `snapshot?.activity?.phase,`.
3. After `const question = snapshot.question;`, add:

```tsx
  const chatActivity = resolveBotChatActivity(current.chatActivity);
  // While the reply's visible words stream, the words are the signal (§5.2).
  const replyStreaming = running && (snapshot.partial?.trim().length ?? 0) > 0;
```

4. In the final `shell(...)` body, directly after `</MessageAttachmentPreviewProvider>`:

```tsx
      {snapshot.activity && !replyStreaming ? (
        <BotStatusLine activity={snapshot.activity} wording={chatActivity.wording} onStop={stop} />
      ) : null}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-status-line.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`
Expected: PASS.

- [ ] **Step 6: Register the test**

Append ` renderer/main/bots/bot-status-line.test.tsx` to `test:bots` in `package.json`. In `scripts/ci-test-registry.json`, add `"renderer/main/bots/bot-status-line.test.tsx",` directly after `"renderer/main/bots/bot-transcript-rows.test.ts",`.

Run: `npm run test:ci-policy`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/bots/bot-status-line.tsx renderer/main/bots/bot-status-line.test.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-chat-pane.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: one calm status line while a Bot works"
```

---

### Task 6: Summary and Detailed recaps, failed versus blocked, and the stopped line

**Files:**
- Create: `renderer/main/bots/bot-activity-steps.ts`, `renderer/main/bots/bot-activity-recap.tsx`
- Test: `renderer/main/bots/bot-activity-recap.test.tsx`
- Modify: `renderer/main/bots/bot-transcript-rows.ts`, `renderer/main/bots/bot-transcript-rows.test.ts`, `renderer/main/bots/bot-chat-pane.tsx`, `renderer/main/bots/bot-chat-pane.test.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `botStepPhrase`, `botStepInfinitive`, `botPhaseWord`, `botDurationLabel`, `BotToolPhase` (Task 1); `BotToolResultStatus`, the enriched tool calls (Task 2); `BotChatActivityLevel` (Task 4).
- Produces:
  - `bot-activity-steps.ts`: `type BotRecapStepStatus = BotToolResultStatus | "running"`; `interface BotRecapStep { id: string; kind: BotToolPhase; label: string; detail?: string; app?: string; status: BotRecapStepStatus; count?: number }`; `mergeBotSteps(steps): BotRecapStep[]`; `botRecapSentence(steps): string`; `botRecapHeader(steps, durationMs, live): string`; `botRecapIssues(steps): { failed: number; blocked: number }`; `botStepLine(step): { text: string; detail?: string; tone: "normal" | "warning" | "error"; active: boolean }`.
  - `BotActivityRecap({ steps, durationMs, live, level })`.
  - `botTranscriptRows(entries, partial, options: BotTranscriptRowOptions)` where `interface BotTranscriptRowOptions { running: boolean; level: BotChatActivityLevel }`. New row kinds: `{ kind: "recap"; id; steps: BotRecapStep[]; durationMs: number; live: boolean }` and `{ kind: "stopped"; id }`.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-activity-recap.test.tsx
import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BotActivityRecap } from "./bot-activity-recap";
import type { BotRecapStep } from "./bot-activity-steps";

afterEach(cleanup);

const ok = (id: string, kind: BotRecapStep["kind"], label: string, extra: Partial<BotRecapStep> = {}): BotRecapStep => ({
  id,
  kind,
  label,
  status: "ok",
  ...extra,
});

const TURN: BotRecapStep[] = [
  ok("1", "reading", "Read 1 file", { detail: "a.md" }),
  ok("2", "reading", "Read 1 file", { detail: "b.md" }),
  ok("3", "searching", "Searched the web", { detail: "lisbon trains" }),
  ok("4", "app", "Used Notion", { app: "Notion" }),
];

test("a finished recap is one closed line that opens to its merged steps", () => {
  render(<BotActivityRecap steps={TURN} durationMs={18_000} live={false} level="summary" />);
  const header = screen.getByRole("button", { name: "Worked for 18s · read 2 files, searched the web, used Notion" });
  assert.equal(header.getAttribute("aria-expanded"), "false");
  fireEvent.click(header);
  const list = screen.getByRole("list", { name: "Steps" });
  assert.deepEqual(
    within(list).getAllByRole("listitem").map((item) => item.textContent),
    ["Read 2 files", "Searched the web · lisbon trains", "Used Notion"],
  );
});

test("Detailed opens while live with the last three steps, and folds itself when the reply lands", () => {
  const live = [...TURN, { id: "5", kind: "editing" as const, label: "Edited 1 file", detail: "plan.md", status: "running" as const }];
  const { rerender } = render(<BotActivityRecap steps={live} durationMs={0} live level="detailed" />);
  const list = screen.getByRole("list", { name: "Steps" });
  assert.deepEqual(
    within(list).getAllByRole("listitem").map((item) => item.textContent),
    ["Searched the web · lisbon trains", "Used Notion", "Editing files · plan.md"],
  );
  rerender(<BotActivityRecap steps={live.map((step) => ({ ...step, status: "ok" }))} durationMs={9_000} live={false} level="detailed" />);
  assert.equal(screen.queryByRole("list", { name: "Steps" }), null);
});

test("a manual close or open during the run sticks after the reply lands", () => {
  const { rerender } = render(<BotActivityRecap steps={TURN} durationMs={0} live level="detailed" />);
  fireEvent.click(screen.getByRole("button", { name: /^Working/u }));
  rerender(<BotActivityRecap steps={TURN} durationMs={0} live level="detailed" />);
  assert.equal(screen.queryByRole("list", { name: "Steps" }), null, "closed by hand stays closed while live");
  fireEvent.click(screen.getByRole("button", { name: /^Working/u }));
  rerender(<BotActivityRecap steps={TURN} durationMs={4_000} live={false} level="detailed" />);
  assert.ok(screen.getByRole("list", { name: "Steps" }), "opened by hand stays open after the reply");
});

test("a failed step is a red issue and a refused one is amber Blocked, never alike", () => {
  render(
    <BotActivityRecap
      steps={[
        ok("1", "reading", "Read 1 file"),
        { id: "2", kind: "command", label: "Ran a command", status: "failed" },
        { id: "3", kind: "searching", label: "Searched the web", status: "blocked" },
      ]}
      durationMs={5_000}
      live={false}
      level="summary"
    />,
  );
  const header = screen.getByRole("button", { name: "Worked for 5s · read 1 file · 1 issue · 1 blocked" });
  fireEvent.click(header);
  assert.ok(screen.getByText("Couldn’t run a command"));
  assert.ok(screen.getByText("Blocked: search the web"));
});
```

Replace the body of `renderer/main/bots/bot-transcript-rows.test.ts` from the first `test(` through the end with the following. Keep the imports and the `user`/`step`/`answer`/`result`/`failed`/`kinds` helpers, and add `at` support to `user` and `answer`:

```ts
const userAt = (id: string, text: string, at: number): BotTranscriptEntry => ({ id, type: "user", text, imageCount: 0, at });
const answerAt = (id: string, text: string, at: number): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop", at });
const quiet = { running: false, level: "quiet" } as const;

test("every tool round of one reply folds into a single Updates line before the answer", () => {
  const rows = botTranscriptRows(
    [
      user("u1", "Find flights"),
      step("a1", "Searching airlines."),
      result("a1"),
      step("a2", "Comparing prices."),
      result("a2"),
      answer("a3", "The cheapest is TAP on Friday."),
    ],
    null,
    quiet,
  );
  assert.deepEqual(kinds(rows), ["user", "updates", "assistant"]);
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
  // The Updates line is still here until Task 7 removes it.
  assert.deepEqual(kinds(rows), ["user", "updates", "file", "recap", "assistant"]);
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
```

Delete the now-replaced tests "a running reply keeps one Working line…" and "files and shared images show as chips…". Task 7 rewrites the Updates expectations.

In `renderer/main/bots/bot-chat-pane.test.tsx`, add:

```tsx
test("a Summary Bot shows one recap above its answer that opens to the steps", async () => {
  await mountChat({
    "bots:get": () => botFixture({ chatActivity: { level: "summary", wording: "follows" } }),
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          { ...userEntry("u1", "Find flights"), at: 1_000 } as BotTranscriptEntry,
          toolStep("a1", ""),
          { id: "r1", type: "tool_result", toolCallId: "a1-call", toolName: "web_search", isError: false, status: "ok", at: 5_000 },
          { ...assistantEntry("a2", "TAP on Friday is cheapest."), at: 19_000 } as BotTranscriptEntry,
        ],
      }),
  });
  const recap = await screen.findByRole("button", { name: "Worked for 18s · searched the web" });
  fireEvent.click(recap);
  assert.ok(await screen.findByText("Searched the web"));
});

test("a reply the person stopped says so in a quiet centred line", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Tell me a story"),
          { id: "a1", type: "assistant", text: "Once upon", toolCalls: [], stopReason: "aborted" },
        ],
      }),
  });
  assert.ok(await screen.findByText("You stopped this reply."));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-activity-recap.test.tsx renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. `Cannot find module './bot-activity-recap'`, and `botTranscriptRows` is called with an options object while it still takes a boolean, so no recap is produced.

- [ ] **Step 3: Write the step model**

```ts
// renderer/main/bots/bot-activity-steps.ts
// A turn's tool steps as the recap shows them (spec §6): merged repeats
// ("Read 6 files"), one deterministic sentence, and failed versus refused
// steps that never look alike.

import {
  botDurationLabel,
  botPhaseWord,
  botStepInfinitive,
  botStepPhrase,
  type BotToolPhase,
} from "../../shared/bot-activity";
import type { BotToolResultStatus } from "../../shared/bot-live";

export type BotRecapStepStatus = BotToolResultStatus | "running";

export interface BotRecapStep {
  id: string;
  kind: BotToolPhase;
  /** Past tense: "Read 1 file". */
  label: string;
  detail?: string;
  app?: string;
  status: BotRecapStepStatus;
  /** Set on a merged row. */
  count?: number;
}

/** Consecutive successful steps of the same kind (and app) become one row. */
export function mergeBotSteps(steps: readonly BotRecapStep[]): BotRecapStep[] {
  const merged: BotRecapStep[] = [];
  for (const step of steps) {
    const last = merged[merged.length - 1];
    if (last && last.status === "ok" && step.status === "ok" && last.kind === step.kind && last.app === step.app) {
      const { detail: _detail, ...rest } = last;
      const count = (last.count ?? 1) + 1;
      merged[merged.length - 1] = { ...rest, count, label: botStepPhrase(step.kind, count, step.app) };
      continue;
    }
    merged.push(step);
  }
  return merged;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "read 2 files, searched the web, used Notion": successful steps, grouped in first-seen order. */
export function botRecapSentence(steps: readonly BotRecapStep[]): string {
  const groups = new Map<string, { kind: BotToolPhase; app?: string; count: number }>();
  for (const step of steps) {
    if (step.status !== "ok" || step.kind === "waiting") continue;
    const key = `${step.kind}\u0000${step.app ?? ""}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { kind: step.kind, ...(step.app ? { app: step.app } : {}), count: 1 });
  }
  return [...groups.values()].map(({ kind, app, count }) => lowerFirst(botStepPhrase(kind, count, app))).join(", ");
}

export function botRecapHeader(steps: readonly BotRecapStep[], durationMs: number, live: boolean): string {
  const sentence = botRecapSentence(steps);
  const lead = live ? "Working" : `Worked for ${botDurationLabel(durationMs)}`;
  return sentence ? `${lead} · ${sentence}` : lead;
}

export function botRecapIssues(steps: readonly BotRecapStep[]): { failed: number; blocked: number } {
  return {
    failed: steps.filter((step) => step.status === "failed").length,
    blocked: steps.filter((step) => step.status === "blocked").length,
  };
}

export function botStepLine(step: BotRecapStep): {
  text: string;
  detail?: string;
  tone: "normal" | "warning" | "error";
  active: boolean;
} {
  const detail = step.detail ? { detail: step.detail } : {};
  switch (step.status) {
    case "running":
      return { text: botPhaseWord(step.kind, step.app), ...detail, tone: "normal", active: true };
    case "failed":
      return { text: `Couldn’t ${botStepInfinitive(step.kind, step.app)}`, ...detail, tone: "error", active: false };
    case "blocked":
      return { text: `Blocked: ${botStepInfinitive(step.kind, step.app)}`, ...detail, tone: "warning", active: false };
    case "ok":
      return { text: step.label, ...detail, tone: "normal", active: false };
  }
}
```

- [ ] **Step 4: Write the recap fold**

```tsx
// renderer/main/bots/bot-activity-recap.tsx
// One collapsed account of a turn's steps (spec §6). Summary: closed. Detailed:
// open while the turn runs (its last three steps, the active one shimmering)
// and folded when the reply lands. A manual open or close sticks. Tones reuse
// the activity feed's tokens; red is a failure, amber a refusal.

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { BotChatActivityLevel } from "../../shared/bots";
import {
  botRecapHeader,
  botRecapIssues,
  botStepLine,
  mergeBotSteps,
  type BotRecapStep,
} from "./bot-activity-steps";

const LIVE_ROWS = 3;

function toneClass(tone: "normal" | "warning" | "error"): string {
  if (tone === "error") return "text-red";
  if (tone === "warning") return "text-support-warning";
  return "text-secondary";
}

function RecapStepRow({ step }: { step: BotRecapStep }) {
  const line = botStepLine(step);
  return (
    <div role="listitem" className="flex min-h-5 min-w-0 items-start py-px text-mini">
      <span className={`min-w-0 break-words ${line.active ? "agent-thinking-shimmer" : ""}`}>
        <span className={`${toneClass(line.tone)} font-medium`}>{line.text}</span>
        {line.detail ? <span className="text-tertiary"> · {line.detail}</span> : null}
      </span>
    </div>
  );
}

export function BotActivityRecap({
  steps,
  durationMs,
  live,
  level,
}: {
  steps: readonly BotRecapStep[];
  durationMs: number;
  live: boolean;
  level: BotChatActivityLevel;
}) {
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const regionId = React.useId();
  const open = choice ?? (live && level === "detailed");
  const issues = botRecapIssues(steps);
  const header = botRecapHeader(steps, durationMs, live);
  const name = [
    header,
    issues.failed ? (issues.failed === 1 ? "1 issue" : `${issues.failed} issues`) : "",
    issues.blocked ? `${issues.blocked} blocked` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = live ? steps.slice(-LIVE_ROWS) : mergeBotSteps(steps);
  return (
    <div className="min-w-0" data-bot-recap={live ? "live" : "done"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={name}
        onClick={() => setChoice(!open)}
        className="flex max-w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-small text-secondary outline-none transition-colors duration-150 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span className={`min-w-0 truncate ${live ? "agent-thinking-shimmer" : ""}`}>{header}</span>
        {issues.failed ? (
          <span className="shrink-0 text-red">{issues.failed === 1 ? "1 issue" : `${issues.failed} issues`}</span>
        ) : null}
        {issues.blocked ? <span className="shrink-0 text-support-warning">{issues.blocked} blocked</span> : null}
      </button>
      {open ? (
        <div id={regionId} role="list" aria-label="Steps" className="mt-1 flex flex-col pl-6">
          {shown.map((step) => (
            <RecapStepRow key={step.id} step={step} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Build recap and stopped rows**

Replace `renderer/main/bots/bot-transcript-rows.ts` with:

```ts
// What a Bot chat shows, row by row, from the durable projection.
//
// A reply's turn starts at the person's message (or a routine, or their answer
// to a question) and ends at the next one. Narration written before tool
// calls, and the in-flight partial while the reply runs, fold into ONE
// "Updates" line per reply. With Summary or Detailed chat activity, a turn
// that used tools also gets one recap of its steps just above its answer;
// Detailed shows it, live, while the turn runs. A reply the person stopped
// ends with a "stopped" line that is derived here and never stored.

import { botRetryableFailedTurn, type BotTranscriptEntry } from "../../shared/bot-live";
import type { BotChatActivityLevel } from "../../shared/bots";
import type { ConnectCardEntry } from "../../shared/bot-connections";
import type { BotRoutineProposalEntryData, BotRoutineProposalStatus } from "../../shared/bot-routine-proposals";
import type { BotRecapStep } from "./bot-activity-steps";
import { resolveBotReplyProjection } from "./bot-reply-projection";

export interface BotTranscriptRowOptions {
  running: boolean;
  level: BotChatActivityLevel;
}

export type BotTranscriptRow =
  | { kind: "user"; id: string; text: string }
  | { kind: "routine"; id: string; label: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  /** The one collapsed progress line of a reply; `active` while it runs. */
  | { kind: "updates"; id: string; progressText: string; active: boolean }
  /** One turn's steps; `live` while the turn runs (Detailed only). */
  | { kind: "recap"; id: string; steps: BotRecapStep[]; durationMs: number; live: boolean }
  /** "You stopped this reply." */
  | { kind: "stopped"; id: string }
  | { kind: "file"; id: string; path: string; operation: "written" | "edited" }
  | { kind: "image"; id: string; name: string; mimeType: string; size: number; data: string }
  | { kind: "notice"; id: string; notice: "interrupted" | "session_reset" }
  | { kind: "connect"; id: string; card: ConnectCardEntry }
  /** `retryText` is set only on the newest failed turn, when Retry applies. */
  | { kind: "failed"; id: string; retryText: string | null; errorMessage?: string }
  /** A quiet "Memory updated" caption; never folded into Updates. */
  | { kind: "memory_update"; id: string }
  | {
      kind: "routine_proposal";
      id: string;
      proposal: BotRoutineProposalEntryData;
      status: BotRoutineProposalStatus;
      routineId?: string;
    };

type UpdatesRow = Extract<BotTranscriptRow, { kind: "updates" }>;

interface Turn {
  id: string;
  startAt?: number;
  lastAt?: number;
  /** Index of the turn's answer bubble in `rows`, once it has one. */
  answerRow: number | null;
  steps: BotRecapStep[];
  byCall: Map<string, BotRecapStep>;
  stopped: boolean;
}

function joinProgress(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function botTranscriptRows(
  entries: readonly BotTranscriptEntry[],
  partial: string | null,
  { running, level }: BotTranscriptRowOptions,
): BotTranscriptRow[] {
  const rows: BotTranscriptRow[] = [];
  const retryable = running ? null : botRetryableFailedTurn(entries);
  const state: { turn: Turn | null; updates: { row: UpdatesRow; parts: string[] } | null } = { turn: null, updates: null };

  const fold = (id: string, text: string) => {
    if (!state.updates) {
      const row: UpdatesRow = { kind: "updates", id: `${id}:updates`, progressText: "", active: false };
      rows.push(row);
      state.updates = { row, parts: [] };
    }
    state.updates.parts.push(text);
    state.updates.row.progressText = joinProgress(state.updates.parts);
  };

  const endTurn = (live: boolean) => {
    state.updates = null;
    const turn = state.turn;
    state.turn = null;
    if (!turn) return;
    const steps = turn.steps.filter((step) => step.kind !== "waiting");
    if (steps.length > 0 && (level === "detailed" || (level === "summary" && !live))) {
      const recap: BotTranscriptRow = {
        kind: "recap",
        id: `${turn.id}:recap`,
        steps: live ? steps : steps.map((step) => (step.status === "running" ? { ...step, status: "failed" } : step)),
        durationMs: Math.max(0, (turn.lastAt ?? 0) - (turn.startAt ?? turn.lastAt ?? 0)),
        live,
      };
      if (live || turn.answerRow === null) rows.push(recap);
      else rows.splice(turn.answerRow, 0, recap);
    }
    if (turn.stopped && !live) rows.push({ kind: "stopped", id: `${turn.id}:stopped` });
  };

  const beginTurn = (id: string, at: number | undefined) => {
    endTurn(false);
    state.turn = {
      id,
      ...(at === undefined ? {} : { startAt: at, lastAt: at }),
      answerRow: null,
      steps: [],
      byCall: new Map(),
      stopped: false,
    };
  };

  const touch = (at: number | undefined) => {
    if (state.turn && at !== undefined) state.turn.lastAt = at;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "question_answer":
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "routine":
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "routine", id: entry.id, label: entry.label, text: entry.text });
        break;
      case "assistant": {
        // A reply with no visible input (the self-intro) still gets a turn.
        if (!state.turn) beginTurn(entry.id, entry.at);
        const turn = state.turn!;
        touch(entry.at);
        for (const call of entry.toolCalls) {
          const step: BotRecapStep = {
            id: call.id,
            kind: call.kind,
            label: call.label,
            ...(call.detail ? { detail: call.detail } : {}),
            ...(call.app ? { app: call.app } : {}),
            status: "running",
          };
          turn.steps.push(step);
          turn.byCall.set(call.id, step);
        }
        if (entry.stopReason === "aborted") turn.stopped = true;
        if (entry.toolCalls.length > 0) fold(entry.id, entry.text);
        else if (entry.text.trim()) {
          turn.answerRow = rows.length;
          rows.push({ kind: "assistant", id: entry.id, text: entry.text });
        }
        break;
      }
      case "tool_result": {
        touch(entry.at);
        const step = state.turn?.byCall.get(entry.toolCallId);
        if (step) step.status = entry.status;
        break;
      }
      case "file":
        rows.push({ kind: "file", id: entry.id, path: entry.path, operation: entry.operation });
        break;
      case "shared_image":
        rows.push({ kind: "image", id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, data: entry.data });
        break;
      case "notice":
        // A paused turn that was dismissed was not stopped by the person.
        if (entry.notice === "interrupted" && state.turn) state.turn.stopped = false;
        endTurn(false);
        rows.push({ kind: "notice", id: entry.id, notice: entry.notice });
        break;
      case "connect_card":
        rows.push({ kind: "connect", id: entry.id, card: entry.card });
        break;
      case "failed_turn":
        rows.push({
          kind: "failed",
          id: entry.id,
          retryText: retryable?.id === entry.id ? entry.retryText : null,
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        });
        break;
      case "memory_update":
        // Back-to-back saves read as one update.
        if (rows[rows.length - 1]?.kind !== "memory_update") rows.push({ kind: "memory_update", id: entry.id });
        break;
      case "routine_proposal":
        rows.push({
          kind: "routine_proposal",
          id: entry.id,
          proposal: entry.proposal,
          status: entry.status,
          ...(entry.routineId ? { routineId: entry.routineId } : {}),
        });
        break;
    }
  }

  if (running) {
    // Everything streamed so far is progress until the reply commits.
    const { progressText } = partial === null ? { progressText: "" } : resolveBotReplyProjection(partial, null, true);
    const current = state.updates;
    if (current) {
      current.row.active = true;
      if (progressText) current.row.progressText = joinProgress([...current.parts, progressText]);
    } else {
      rows.push({ kind: "updates", id: "working", progressText, active: true });
    }
    endTurn(true);
  } else {
    endTurn(false);
    if (partial !== null && partial.trim()) rows.push({ kind: "assistant", id: "partial", text: partial });
  }
  return rows;
}
```

- [ ] **Step 6: Render the rows**

In `renderer/main/bots/bot-chat-pane.tsx`:

1. Import `import { BotActivityRecap } from "./bot-activity-recap";` and `import type { BotChatActivityLevel } from "../../shared/bots";`.
2. Add `level: BotChatActivityLevel;` to the `TranscriptEntries` props type and destructure it. Change the rows call to `botTranscriptRows(entries, partial, { running, level })`.
3. Add two `case`s to the row switch:

```tsx
          case "recap":
            return <BotActivityRecap key={row.id} steps={row.steps} durationMs={row.durationMs} live={row.live} level={level} />;
          case "stopped":
            return (
              <Text key={row.id} as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
                You stopped this reply.
              </Text>
            );
```

4. Pass `level={chatActivity.level}` to `<TranscriptEntries … />`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-activity-recap.test.tsx renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: PASS.

- [ ] **Step 8: Register and check**

Append ` renderer/main/bots/bot-activity-recap.test.tsx` to `test:bots`. In `scripts/ci-test-registry.json`, add `"renderer/main/bots/bot-activity-recap.test.tsx",` after the Task 5 entry.

Run: `npm run test:ci-policy && npm run type-check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add renderer/main/bots/bot-activity-steps.ts renderer/main/bots/bot-activity-recap.tsx renderer/main/bots/bot-activity-recap.test.tsx renderer/main/bots/bot-transcript-rows.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-chat-pane.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: Summary and Detailed recaps, failed versus blocked steps, stopped line"
```

---

### Task 7: Progress narration becomes bubbles; the Updates line goes

**Files:**
- Modify: `renderer/main/bots/bot-transcript-rows.ts`, `renderer/main/bots/bot-transcript-rows.test.ts`, `renderer/main/bots/bot-chat-pane.tsx`, `renderer/main/bots/bot-chat-pane.test.tsx`, `renderer/main/bots/bot-chat-mode.test.tsx`
- Delete: `renderer/main/bots/bot-updates.tsx`, `renderer/main/bots/bot-reply-projection.ts`

**Interfaces:**
- Consumes: Task 6's `botTranscriptRows` shape.
- Produces: the `updates` row kind is removed. A running partial is `{ kind: "assistant", id: "partial", text, streaming: true }`.

- [ ] **Step 1: Write the failing tests**

In `renderer/main/bots/bot-transcript-rows.test.ts`, replace the "every tool round … single Updates line" test with:

```ts
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
```

Also in that file, in the "Quiet never adds a recap; Summary puts one…" test, change the expected kinds to `["user", "file", "recap", "assistant"]` and delete its "Updates line is still here" comment. A tool step with no text no longer adds a row.

In `renderer/main/bots/bot-chat-pane.test.tsx`:

- Replace "a reply still being written is folded under Working and opens to its text" with:

```tsx
test("a reply still being written shows as its own bubble", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ partial: "Checking your calendar now", state: { kind: "running", submissionId: "s1" } }),
  });
  assert.ok(await screen.findByText("Checking your calendar now"));
  assert.equal(screen.queryByRole("button", { name: /Working|Updates/u }), null);
});
```

- Replace "text before a tool call folds under Updates, and only the final answer is a bubble" with:

```tsx
test("the Bot's own progress message is a bubble at every level, and Quiet shows no tool rows", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Am I free Friday?"),
          {
            id: "a1",
            type: "assistant",
            text: "Let me check your calendar.",
            toolCalls: [{ id: "t1", name: "calendar", kind: "working", label: "Used a tool" }],
            stopReason: "toolUse",
          },
          { id: "r1", type: "tool_result", toolCallId: "t1", toolName: "calendar", isError: false, status: "ok" },
          assistantEntry("a2", "You are free all day Friday."),
        ],
      }),
  });
  assert.ok(await screen.findByText("Let me check your calendar."));
  assert.ok(screen.getByText("You are free all day Friday."));
  assert.equal(screen.queryByText(/Used a tool/u), null);
});
```

- Replace "all tool rounds before an answer fold into one Updates line" with:

```tsx
test("each round's narration is its own bubble before the answer", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Find flights"),
          toolStep("a1", "Searching airlines."),
          toolStep("a2", "Comparing prices."),
          assistantEntry("a3", "TAP on Friday is cheapest."),
        ],
      }),
  });
  assert.ok(await screen.findByText("Searching airlines."));
  assert.ok(screen.getByText("Comparing prices."));
  assert.ok(screen.getByText("TAP on Friday is cheapest."));
});
```

- In "a renderer reload mid-reply…", delete the line `fireEvent.click(await screen.findByRole("button", { name: /Working/u }));`. The `findByText` that follows now finds the streaming bubble directly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. Narration still folds into `updates`, and "Checking your calendar now" is hidden under a collapsed Working line.

- [ ] **Step 3: Remove the fold from the rows**

In `renderer/main/bots/bot-transcript-rows.ts`:

1. Replace the file header comment's second sentence block with: "Everything the Bot writes is a bubble, including the narration it writes alongside tool calls (spec decision 9); tool steps themselves never become rows."
2. Delete the `resolveBotReplyProjection` import, the `updates` member of `BotTranscriptRow`, `UpdatesRow`, `joinProgress`, `fold`, and the `updates` field of `state` (and `state.updates = null;` in `endTurn`).
3. In the `assistant` case, replace

```ts
        if (entry.toolCalls.length > 0) fold(entry.id, entry.text);
        else if (entry.text.trim()) {
          turn.answerRow = rows.length;
          rows.push({ kind: "assistant", id: entry.id, text: entry.text });
        }
```

with

```ts
        if (entry.text.trim()) {
          if (entry.toolCalls.length === 0) turn.answerRow = rows.length;
          rows.push({ kind: "assistant", id: entry.id, text: entry.text });
        }
```

4. Replace the `if (running) { … } else { … }` tail with:

```ts
  endTurn(running);
  if (partial !== null && partial.trim()) {
    rows.push({ kind: "assistant", id: "partial", text: partial, ...(running ? { streaming: true } : {}) });
  }
  return rows;
```

- [ ] **Step 4: Remove the Updates line from the chat**

In `renderer/main/bots/bot-chat-pane.tsx`, delete `import { BotUpdates } from "./bot-updates";` and the `case "updates":` branch. In the `assistant` case, pass `streaming={row.streaming}` to `SafeMessageBubble`. Update the `TranscriptEntries` doc comment to "Chat transcript rows: bubbles, recaps, chips, cards."

Delete the files:

```bash
git rm renderer/main/bots/bot-updates.tsx renderer/main/bots/bot-reply-projection.ts
```

In `renderer/main/bots/bot-chat-mode.test.tsx`, delete the test "the reply projection matches the phone rule…", its `toolTimeline` helper, and the now-unused imports (`resolveBotReplyProjection`, and `GenerationTimeline` if nothing else uses it).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx renderer/main/bots/bot-chat-mode.test.tsx`
Expected: PASS.

Run: `npm run type-check && npm run lint`
Expected: PASS. Nothing else imports the deleted modules.

- [ ] **Step 6: Commit**

```bash
git add -A renderer/main/bots
git commit -m "Bots: progress narration is a bubble; remove the Updates line"
```

---

### Task 8: Steer and Queue, with a faded Queued bubble and Remove

**Files:**
- Modify: `renderer/shared/bot-live.ts`, `main/services/bot-runtime/live-projection.ts`, `main/services/bot-runtime/bot-session-service.ts`, `main/handlers/bots.ts`, `main/handlers/bot-params.ts`, `renderer/lib/ipc.ts`, `renderer/main/bots/bot-transcript-rows.ts`, `renderer/main/bots/bot-chat-pane.tsx`
- Test: `main/services/bot-runtime/live-projection.test.ts`, `main/handlers/bot-params.test.ts`, `main/handlers/bot-live.test.ts`, `renderer/main/bots/bot-transcript-rows.test.ts`, `renderer/main/bots/bot-chat-pane.test.tsx`

**Interfaces:**
- Consumes: Task 3's feed and events; Task 7's rows.
- Produces:
  - `interface BotQueuedMessage { submissionId: string; mode: "steer" | "followUp"; text: string; imageCount: number }`; `BotLiveSnapshot.queued: BotQueuedMessage[]`; event `{ type: "queued"; queued: BotQueuedMessage[] }`.
  - `export function liveQueuedMessages(docs): BotQueuedMessage[]` (routine and hidden inputs are left out).
  - `type BotWithdrawResult = "withdrawn" | "started" | "gone"`; `BotSessionService.withdraw(botId, submissionId): Promise<BotWithdrawResult>`.
  - IPC `bots:withdraw` `{ botId, submissionId }`; `parseBotWithdraw(input): { botId: string; submissionId: string }`; `botsApi.withdraw(botId, submissionId): Promise<BotWithdrawResult>`.
  - `BotTranscriptRowOptions.queued?: readonly BotQueuedMessage[]`; row kind `{ kind: "queued"; id: string; submissionId: string; text: string }`.

- [ ] **Step 1: Write the failing tests**

In `main/services/bot-runtime/live-projection.test.ts` (add `liveQueuedMessages` to the import):

```ts
// Test 1
test("a follow-up sent while the Bot works shows as queued, and Remove withdraws it before it runs", async () => {
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    assert.deepEqual(snapshot.queued, []);
    await live.service.send("bot:a", { text: "Plan dinners", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply to stream" });
    const queued = await live.service.send("bot:a", { text: "Also add dessert", requestId: "desk-2", whenBusy: "followUp" });
    await waitFor(() => tape.view?.queued.length === 1, { what: "the queued message" });
    assert.deepEqual(tape.view?.queued, [
      { submissionId: queued.submissionId, mode: "followUp", text: "Also add dessert", imageCount: 0 },
    ]);
    assert.equal(await live.service.withdraw("bot:a", queued.submissionId), "withdrawn");
    await waitFor(() => tape.view?.queued.length === 0, { what: "the queued message to leave" });
    await live.service.stop("bot:a");
    await waitFor(() => tape.view?.state.kind === "idle", { what: "the stop" });
    assert.equal(fauxModels.calls(), 1, "the withdrawn follow-up never reached the model");
    assert.equal(visibleText(tape.view).includes("user:Also add dessert"), false);
    unsubscribe();
  } finally {
    await live.close();
  }
});

// Test 2 (Review Focus 3)
test("Remove on a queued message whose turn already started withdraws nothing", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("word ".repeat(30)), slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "the first reply" });
    const second = await live.service.send("bot:a", { text: "two", requestId: "desk-2", whenBusy: "followUp" });
    await waitFor(() => visibleText(tape.view).includes("user:two"), { what: "the follow-up to start" });
    assert.equal(await live.service.withdraw("bot:a", second.submissionId), "started");
    assert.equal(await live.service.withdraw("bot:a", "999999"), "gone");
    await live.service.stop("bot:a");
    unsubscribe();
  } finally {
    await live.close();
  }
});

// Test 3
test("queued routine and hidden prompts are not shown as the person's messages", () => {
  const notice = (data: unknown) => ({ id: 1, mode: "write", entry: { kind: "aiden.bot-notice", data } });
  assert.deepEqual(
    liveQueuedMessages({
      "pi.inbox": {
        items: [
          notice({ notice: "routine", label: "Morning check-in", requestId: "routine:r1:1" }),
          { id: 2, mode: "followUp", content: "Check in on today" },
          notice({ notice: "hidden_input", requestId: "intro:1" }),
          { id: 4, mode: "followUp", content: "Introduce yourself" },
          { id: 5, mode: "steer", content: [{ type: "text", text: "Make it vegetarian" }, { type: "image", data: "AA", mimeType: "image/png" }] },
        ],
      },
    }),
    [{ submissionId: "5", mode: "steer", text: "Make it vegetarian", imageCount: 1 }],
  );
  assert.deepEqual(liveQueuedMessages({}), []);
});
```

In `main/handlers/bot-params.test.ts` (add `parseBotWithdraw` to the import):

```ts
test("Remove names an exact Bot and one numeric submission id", () => {
  assert.deepEqual(parseBotWithdraw({ botId: "bot-1", submissionId: "42" }), { botId: "bot-1", submissionId: "42" });
  assert.throws(() => parseBotWithdraw({ botId: "bot-1", submissionId: "42; drop" }), /submission/u);
  assert.throws(() => parseBotWithdraw({ botId: "bot-1", submissionId: "42", extra: true }), /withdraw fields/u);
  assert.throws(() => parseBotWithdraw({ botId: "../x", submissionId: "1" }), /bot id/u);
});
```

In `renderer/main/bots/bot-transcript-rows.test.ts`:

```ts
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
```

In `renderer/main/bots/bot-chat-pane.test.tsx`:

```tsx
test("a queued message shows faded as Queued, and Remove withdraws that one submission", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan dinners")],
        state: { kind: "running", submissionId: "s1" },
        queued: [{ submissionId: "8", mode: "followUp", text: "Also add dessert", imageCount: 0 }],
      }),
    "bots:withdraw": () => "withdrawn",
  });
  assert.ok(await screen.findByText("Also add dessert"));
  assert.ok(screen.getByText("Queued"));
  fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:withdraw")?.args, [{ botId: "bot-1", submissionId: "8" }]),
  );
});
```

Add `queued: [],` to the `snapshot()` helper defaults here and to the fake snapshot in `main/handlers/bot-live.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/handlers/bot-params.test.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. `snapshot.queued` is undefined, `withdraw` is not a function, `parseBotWithdraw` is not exported, and the queued options are ignored.

- [ ] **Step 3: Types and events**

In `renderer/shared/bot-live.ts`, add:

```ts
/** A message waiting for the running turn: a follow-up (queued) or a steer (joins at the next step). */
export interface BotQueuedMessage {
  /** The durable submission id; Remove withdraws it. */
  submissionId: string;
  mode: "steer" | "followUp";
  text: string;
  imageCount: number;
}
```

Add `queued: BotQueuedMessage[];` to `BotLiveSnapshot`, `| { type: "queued"; queued: BotQueuedMessage[] }` to `BotLiveEventBody`, and to `applyBotLiveEvent`:

```ts
    case "queued":
      return { ...snapshot, seq: event.seq, queued: event.queued };
```

- [ ] **Step 4: Project `pi.inbox`**

In `main/services/bot-runtime/live-projection.ts`, add `type BotQueuedMessage` to the `bot-live.js` import and, below `liveBotActivity`:

```ts
/**
 * Inputs waiting in `pi.inbox`, as the person sent them. A routine's input and
 * the hidden self-intro are preceded by their notice write and are not shown.
 */
export function liveQueuedMessages(docs: Readonly<Record<string, unknown>>): BotQueuedMessage[] {
  const items = (docs["pi.inbox"] as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const queued: BotQueuedMessage[] = [];
  let skipNext = false;
  for (const value of items) {
    const item = value as { id?: unknown; mode?: unknown; content?: unknown; entry?: { kind?: unknown; data?: unknown } };
    if (item.mode === "write") {
      const notice = (item.entry?.data as { notice?: unknown } | undefined)?.notice;
      if (item.entry?.kind === BOT_NOTICE_ENTRY_KIND && (notice === "routine" || notice === "hidden_input")) skipNext = true;
      continue;
    }
    if (item.mode !== "steer" && item.mode !== "followUp") continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const content = item.content as UserContent | undefined;
    if (content === undefined || (typeof item.id !== "number" && typeof item.id !== "string")) continue;
    queued.push({ submissionId: String(item.id), mode: item.mode, text: textOf(content), imageCount: imageCount(content) });
  }
  return queued;
}
```

Add `queued: BotQueuedMessage[];` to `Feed`, `queued: feed.queued,` to `snapshotOf`, and `queued: liveQueuedMessages(initial.docs),` to the `openFeed` literal. In `onFrame`, directly after the `partial` block:

```ts
    const queued = liveQueuedMessages(docs);
    if (JSON.stringify(queued) !== JSON.stringify(feed.queued)) {
      feed.queued = queued;
      emit(feed, { type: "queued", queued });
    }
```

- [ ] **Step 5: Withdraw in the session service**

In `main/services/bot-runtime/bot-session-service.ts`:

```ts
/** Remove's outcome: withdrawn before it ran, already started, or no longer waiting. */
export type BotWithdrawResult = "withdrawn" | "started" | "gone";
```

Add to `BotSessionService`:

```ts
  /**
   * Withdraw one queued message before its turn starts (Pi's
   * `abortSubmission`). A message already placed in a turn keeps running.
   */
  withdraw(botId: string, submissionId: string): Promise<BotWithdrawResult>;
```

and to the `service` object:

```ts
    withdraw(botId, submissionId) {
      return serialize(botId, async () => {
        await openBot(botId);
        const opened = await requireHost().open(botId);
        const result = await opened.harness.abortSubmission(
          Number(submissionId) as SubmissionId,
          ctx,
          opened.conversation.id,
        );
        if (result === "aborted") return "withdrawn";
        return result === "already_placed" ? "started" : "gone";
      });
    },
```

If `npm run type-check` reports a hand-written `BotSessionService` fake elsewhere, add `withdraw: async () => "gone" as const` to it.

- [ ] **Step 6: IPC**

`main/handlers/bot-params.ts`:

```ts
const BOT_SUBMISSION_ID = /^\d{1,16}$/u;

/** Remove on a queued message: the Bot and one durable submission id. */
export function parseBotWithdraw(input: unknown): { botId: string; submissionId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid bot withdraw fields.");
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => key === "botId" || key === "submissionId")) {
    throw new Error("Invalid bot withdraw fields.");
  }
  if (typeof fields.submissionId !== "string" || !BOT_SUBMISSION_ID.test(fields.submissionId)) {
    throw new Error("Invalid bot submission id.");
  }
  return { botId: parseBotId(fields.botId), submissionId: fields.submissionId };
}
```

`main/handlers/bots.ts`: import `parseBotWithdraw` and, next to `bots:stop`:

```ts
  ipcMain.handle("bots:withdraw", async (_event, input: unknown) => {
    const { botId, submissionId } = parseBotWithdraw(input);
    return (await botSessionRuntime()).withdraw(botId, submissionId);
  });
```

`renderer/lib/ipc.ts`, in `botsApi` after `stop`:

```ts
  /** Remove a queued message before its turn starts. */
  withdraw: (botId: string, submissionId: string) =>
    invoke<import("../../main/services/bot-runtime/bot-session-service").BotWithdrawResult>("bots:withdraw", {
      botId,
      submissionId,
    }),
```

- [ ] **Step 7: Rows and the Queued bubble**

`renderer/main/bots/bot-transcript-rows.ts`: import `type BotQueuedMessage` from `../../shared/bot-live`. Add `queued?: readonly BotQueuedMessage[];` to `BotTranscriptRowOptions` and destructure it. Add the row kind:

```ts
  /** A follow-up waiting for the running turn; shown faded with Remove. */
  | { kind: "queued"; id: string; submissionId: string; text: string }
```

Before `return rows;`:

```ts
  for (const message of queued ?? []) {
    const text = message.text.trim()
      ? message.text
      : message.imageCount === 1
        ? "Photo"
        : message.imageCount > 1
          ? `${message.imageCount} photos`
          : "";
    if (!text) continue;
    // A steer joins the running turn: it reads as sent right away (§6).
    if (message.mode === "steer") rows.push({ kind: "user", id: `queued:${message.submissionId}`, text });
    else rows.push({ kind: "queued", id: `queued:${message.submissionId}`, submissionId: message.submissionId, text });
  }
```

`renderer/main/bots/bot-chat-pane.tsx`:

1. Add the component above `TranscriptEntries`:

```tsx
/** A follow-up waiting for the running turn: a faded bubble, "Queued", and Remove. */
function BotQueuedBubble({ text, removing, onRemove }: { text: string; removing: boolean; onRemove(): void }) {
  return (
    <div className="flex flex-col items-end gap-1" data-bot-queued>
      <div className="max-w-full opacity-60">
        <SafeMessageBubble role="user" content={text} showCopy={false} />
      </div>
      <div className="flex items-center gap-2 text-small text-tertiary">
        <span>Queued</span>
        <Button variant="transparent" size="small" disabled={removing} aria-label="Remove queued message" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
```

2. `TranscriptEntries` gains props `queued: readonly BotQueuedMessage[]`, `removing: string | null` and `onRemoveQueued(submissionId: string): void`. Pass `queued` into `botTranscriptRows(entries, partial, { running, level, queued })`, and add:

```tsx
          case "queued":
            return (
              <BotQueuedBubble
                key={row.id}
                text={row.text}
                removing={removing === row.submissionId}
                onRemove={() => onRemoveQueued(row.submissionId)}
              />
            );
```

3. In `BotChatPane`, add `const [removing, setRemoving] = React.useState<string | null>(null);` and, next to `stop`:

```tsx
  const removeQueued = async (submissionId: string) => {
    setRemoving(submissionId);
    try {
      const result = await botsApi.withdraw(current.id, submissionId);
      if (result === "started") toast.info("That message already started, so it stays.");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t remove that message."));
    } finally {
      setRemoving(null);
    }
  };
```

  Then pass `queued={snapshot.queued}`, `removing={removing}` and `onRemoveQueued={(id) => void removeQueued(id)}` to `TranscriptEntries`. Import `type BotQueuedMessage` from `../../shared/bot-live`.

4. Add `snapshot?.queued.length,` to `autoScrollDeps`.

The composer already sends `onQueue` as `whenBusy: "followUp"` and `onSteer` as `"steer"`. No composer change is needed.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/handlers/bot-params.test.ts main/handlers/bot-live.test.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.test.tsx`
Expected: PASS.

Run: `npx tsx --test main/handlers/ipc-contract.test.ts && npm run type-check`
Expected: PASS. The AST inventory sees `bots:withdraw` both registered in main and invoked by `ipc.ts`.

- [ ] **Step 9: Commit**

```bash
git add renderer/shared/bot-live.ts main/services/bot-runtime/live-projection.ts main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-session-service.ts main/handlers/bots.ts main/handlers/bot-params.ts main/handlers/bot-params.test.ts main/handlers/bot-live.test.ts renderer/lib/ipc.ts renderer/main/bots/bot-transcript-rows.ts renderer/main/bots/bot-transcript-rows.test.ts renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-chat-pane.test.tsx
git commit -m "Bots: queued follow-ups show faded with Remove; steers show at once"
```

---

### Task 9: Advanced → Chat activity, with live previews

**Files:**
- Create: `renderer/main/bots/bot-chat-activity-page.tsx`
- Test: `renderer/main/bots/bot-chat-activity-page.test.tsx`
- Modify: `renderer/main/bots/bot-page-search.ts`, `renderer/main/bots-view.tsx`, `renderer/main/bots/bot-advanced.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `BotStatusLine` (Task 5); `BotActivityRecap`, `BotRecapStep` (Task 6); `resolveBotChatActivity`, `BotChatActivity*` (Task 4); `updateBotIdentity` (Task 4); `prefersReducedMotion` from `renderer/lib/appearance-runtime.ts`; `BotPageShell`.
- Produces:
  - `BOT_CHAT_ACTIVITY_LEVEL_LABELS`, `BOT_CHAT_ACTIVITY_WORDING_LABELS`, `botChatActivitySummary(value?: BotChatActivity): string` ("Quiet · Follows the work").
  - `BotChatActivityPage({ bot, onClose })`; `BotChatActivityPreview({ level, wording, label, name })`.
  - `BotSubpage` gains `"chat-activity"`; `BotAdvanced` gains `onOpenChatActivity(): void`.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-chat-activity-page.test.tsx
import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import { BotsView } from "../bots-view";
import { botFixture, catalogFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

function store(initial: BotDefinition, options: { failUpdate?: boolean } = {}) {
  let bot = initial;
  const updates: BotUpdateInput[] = [];
  installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:update": (input) => {
      const update = input as BotUpdateInput;
      updates.push(update);
      if (options.failUpdate) throw new Error("This Bot changed on another surface. Refresh it and try again.");
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      bot = { ...bot, ...fields, revision: `${bot.revision}+` };
      return bot;
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:getTelegramBinding": () => null,
  });
  return { updates, current: () => bot };
}

// Test 1
test("Advanced shows the current choice and opens Chat activity; Back returns to Advanced", async () => {
  store(botFixture({ chatActivity: { level: "summary", wording: "follows" } }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const row = await screen.findByRole("button", { name: "Chat activity" });
  assert.ok(within(row).getByText("Summary · Follows the work"));
  fireEvent.click(row);
  assert.ok(await screen.findByRole("heading", { name: "Chat activity" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  assert.ok(await screen.findByRole("radiogroup", { name: "What it can use" }));
});

// Test 2
test("each choice saves as it is picked, with the Bot's revision and nothing else changed", async () => {
  const bots = store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  assert.equal((within(level).getByRole("radio", { name: "Quiet" }) as HTMLButtonElement).getAttribute("data-state"), "checked");
  fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
  await waitFor(() => assert.equal(bots.updates.length, 1));
  assert.deepEqual(bots.updates[0]!.chatActivity, { level: "detailed", wording: "follows" });
  assert.equal(bots.updates[0]!.expectedRevision, "rev-1");
  assert.equal(bots.updates[0]!.name, "Planner");
  const wording = screen.getByRole("radiogroup", { name: "What the status line says" });
  fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
  await waitFor(() => assert.equal(bots.updates.length, 2));
  assert.deepEqual(bots.updates[1]!.chatActivity, { level: "detailed", wording: "thinking" });
  assert.equal(bots.updates[1]!.expectedRevision, "rev-1+");
  assert.equal(screen.queryByRole("button", { name: "Save" }), null, "no Save button on this page");
});

// Test 3 (Review Focus 4)
test("a choice that fails to save goes back to the saved one", async () => {
  store(botFixture(), { failUpdate: true });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  fireEvent.click(within(level).getByRole("radio", { name: "Summary" }));
  await waitFor(() =>
    assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked"),
  );
});

// Test 4
test("under Reduce Motion each preview is a still frame with Play, built from the real status line", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  await screen.findByRole("radiogroup", { name: "How much to show" });
  const follows = document.querySelector('[data-bot-chat-activity-preview="wording-follows"]') as HTMLElement;
  const thinking = document.querySelector('[data-bot-chat-activity-preview="wording-thinking"]') as HTMLElement;
  assert.ok(within(follows).getByText("Searching the web"));
  assert.ok(within(thinking).getByText("Thinking"));
  const play = screen.getByRole("button", { name: "Play preview: Detailed" });
  fireEvent.click(play);
  assert.ok(screen.getByRole("button", { name: "Pause preview: Detailed" }));
  // The phones group explains that phones always show just the line.
  assert.ok(screen.getByText("Always just the line, with the same words."));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-chat-activity-page.test.tsx`
Expected: FAIL. Advanced has no "Chat activity" row, and `?page=chat-activity` falls back to Profile.

- [ ] **Step 3: Write the page and previews**

```tsx
// renderer/main/bots/bot-chat-activity-page.tsx
// Advanced → Chat activity (spec §7): how much a Bot chat shows while the Bot
// works, and what its status line says, each choice with a looping preview
// built from the real status line and recap. Choices save as they are picked.
// Previews pause off-screen; under Reduce Motion they hold a still frame with
// Play. Radio rows show selection with the radio and background, no borders.

import * as React from "react";
import { Pause, Play } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldSet, Label, RadioGroup, RadioGroupItem, toast } from "../../components/ui";
import { prefersReducedMotion } from "../../lib/appearance-runtime";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotToolPhase } from "../../shared/bot-activity";
import {
  resolveBotChatActivity,
  type BotChatActivity,
  type BotChatActivityLevel,
  type BotChatActivityWording,
  type BotDefinition,
} from "../../shared/bots";
import { BotActivityRecap } from "./bot-activity-recap";
import type { BotRecapStep } from "./bot-activity-steps";
import { updateBotIdentity } from "./bot-identity";
import { BotPageShell } from "./bot-page-shell";
import { BotStatusLine } from "./bot-status-line";

export const BOT_CHAT_ACTIVITY_LEVEL_LABELS: Record<BotChatActivityLevel, string> = {
  quiet: "Quiet",
  summary: "Summary",
  detailed: "Detailed",
};

export const BOT_CHAT_ACTIVITY_WORDING_LABELS: Record<BotChatActivityWording, string> = {
  follows: "Follows the work",
  thinking: "Always “Thinking”",
};

/** Advanced's trailing value: "Quiet · Follows the work". */
export function botChatActivitySummary(value?: BotChatActivity): string {
  const resolved = resolveBotChatActivity(value);
  return `${BOT_CHAT_ACTIVITY_LEVEL_LABELS[resolved.level]} · ${BOT_CHAT_ACTIVITY_WORDING_LABELS[resolved.wording]}`;
}

const LEVEL_CHOICES: ReadonlyArray<{ value: BotChatActivityLevel; description: string; recommended?: true }> = [
  { value: "quiet", description: "One line that says what it’s doing.", recommended: true },
  { value: "summary", description: "Adds a short recap above each reply." },
  { value: "detailed", description: "Also shows its last few steps while it works." },
];

const WORDING_CHOICES: ReadonlyArray<{ value: BotChatActivityWording; description: string }> = [
  { value: "follows", description: "Says what it’s doing, like Reading or Searching the web." },
  { value: "thinking", description: "One calm word, whatever it’s doing." },
];

const PREVIEW_STEPS: readonly BotRecapStep[] = [
  { id: "p1", kind: "reading", label: "Read 1 file", detail: "recipes.md", status: "ok" },
  { id: "p2", kind: "searching", label: "Searched the web", detail: "quick weeknight dinners", status: "ok" },
  { id: "p3", kind: "editing", label: "Edited 1 file", detail: "meal-plan.md", status: "ok" },
];

/** One scripted turn: think, read, search, edit, reply. `step` indexes `PREVIEW_STEPS`. */
const PREVIEW_FRAMES: ReadonlyArray<{ ms: number; phase?: "thinking" | BotToolPhase; step?: number }> = [
  { ms: 1_400, phase: "thinking" },
  { ms: 1_600, phase: "reading", step: 0 },
  { ms: 1_600, phase: "searching", step: 1 },
  { ms: 1_400, phase: "editing", step: 2 },
  { ms: 2_800 },
];
/** Reduce Motion's still frame: mid-turn, with a step and the line showing. */
const STILL_FRAME = 2;
const PREVIEW_STARTED_AT = 0;

export function BotChatActivityPreview({
  level,
  wording,
  label,
  name,
}: {
  level: BotChatActivityLevel;
  wording: BotChatActivityWording;
  /** For the Play control's name: "Play preview: Detailed". */
  label: string;
  /** A stable hook for this preview, such as `level-quiet`. */
  name: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [reduced] = React.useState(() => prefersReducedMotion());
  const [playing, setPlaying] = React.useState(!reduced);
  const [visible, setVisible] = React.useState(true);
  const [tick, setTick] = React.useState(reduced ? STILL_FRAME : 0);

  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!playing || !visible) return;
    const frame = PREVIEW_FRAMES[tick % PREVIEW_FRAMES.length]!;
    const timer = window.setTimeout(() => setTick((value) => value + 1), frame.ms);
    return () => window.clearTimeout(timer);
  }, [playing, visible, tick]);

  const frame = PREVIEW_FRAMES[tick % PREVIEW_FRAMES.length]!;
  const loop = Math.floor(tick / PREVIEW_FRAMES.length);
  const replied = frame.phase === undefined;
  const done = replied ? PREVIEW_STEPS.length : (frame.step ?? 0);
  const steps: BotRecapStep[] = [
    ...PREVIEW_STEPS.slice(0, done),
    ...(frame.step !== undefined ? [{ ...PREVIEW_STEPS[frame.step]!, status: "running" as const }] : []),
  ];
  const showRecap = level === "detailed" ? steps.length > 0 : level === "summary" && replied;
  const current = frame.step !== undefined ? PREVIEW_STEPS[frame.step] : undefined;

  return (
    <div ref={ref} className="flex flex-col gap-2" data-bot-chat-activity-preview={name}>
      <div aria-hidden="true" inert className="pointer-events-none flex flex-col gap-2 rounded-control bg-background p-3 text-small">
        <div className="ml-auto max-w-[80%] rounded-card bg-control px-3 py-1.5 text-primary">Plan dinners for this week</div>
        {showRecap ? (
          <BotActivityRecap key={loop} steps={steps} durationMs={18_000} live={!replied} level={level} />
        ) : null}
        {replied ? (
          <div className="max-w-[85%] px-1 text-primary">Here are five quick dinners for the week.</div>
        ) : (
          <BotStatusLine
            activity={{
              phase: frame.phase!,
              startedAt: PREVIEW_STARTED_AT,
              ...(current ? { step: { kind: current.kind, label: current.label, ...(current.detail ? { detail: current.detail } : {}) } } : {}),
            }}
            wording={wording}
            now={PREVIEW_STARTED_AT}
          />
        )}
      </div>
      {reduced ? (
        <Button
          variant="transparent"
          size="small"
          className="self-start"
          aria-label={`${playing ? "Pause" : "Play"} preview: ${label}`}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {playing ? "Pause" : "Play"}
        </Button>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  value,
  label,
  description,
  recommended,
  preview,
}: {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
  preview: React.ReactNode;
}) {
  return (
    <div className="rounded-control bg-well px-3 py-2.5 hover:bg-list-hover has-[[data-state=checked]]:bg-list-selection">
      <Label className="cursor-pointer items-start">
        <RadioGroupItem value={value} aria-label={label} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-regular text-primary">
            {label}
            {recommended ? (
              <span className="rounded-pill bg-control px-2 py-0.5 text-mini text-secondary">Recommended</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-small text-secondary">{description}</span>
        </span>
      </Label>
      <div className="mt-2 pl-7">{preview}</div>
    </div>
  );
}

export function BotChatActivityPage({ bot, onClose }: { bot: BotDefinition; onClose(): void }) {
  const qc = useQueryClient();
  const [value, setValue] = React.useState<BotChatActivity>(() => resolveBotChatActivity(bot.chatActivity));
  const queue = React.useRef<Promise<void>>(Promise.resolve());

  const pick = (next: BotChatActivity) => {
    const previous = value;
    if (next.level === previous.level && next.wording === previous.wording) return;
    setValue(next);
    queue.current = queue.current.then(async () => {
      try {
        await updateBotIdentity(qc, bot.id, { chatActivity: next });
      } catch (error) {
        setValue(previous);
        toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
      }
    });
  };

  return (
    <BotPageShell
      scrollId={`bot-chat-activity:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={onClose}
      heading="Chat activity"
      description={`What you see in ${bot.name}’s chat while it works. Changes save as you pick them.`}
    >
      <FieldSet title="How much to show">
        <Field orientation="vertical">
          <RadioGroup
            orientation="vertical"
            aria-label="How much to show"
            value={value.level}
            onValueChange={(level) => pick({ ...value, level: level as BotChatActivityLevel })}
          >
            {LEVEL_CHOICES.map((choice) => (
              <ChoiceRow
                key={choice.value}
                value={choice.value}
                label={BOT_CHAT_ACTIVITY_LEVEL_LABELS[choice.value]}
                description={choice.description}
                recommended={choice.recommended}
                preview={
                  <BotChatActivityPreview
                    level={choice.value}
                    wording={value.wording}
                    label={BOT_CHAT_ACTIVITY_LEVEL_LABELS[choice.value]}
                    name={`level-${choice.value}`}
                  />
                }
              />
            ))}
          </RadioGroup>
        </Field>
      </FieldSet>
      <FieldSet title="What the status line says">
        <Field orientation="vertical">
          <RadioGroup
            orientation="vertical"
            aria-label="What the status line says"
            value={value.wording}
            onValueChange={(wording) => pick({ ...value, wording: wording as BotChatActivityWording })}
          >
            {WORDING_CHOICES.map((choice) => (
              <ChoiceRow
                key={choice.value}
                value={choice.value}
                label={BOT_CHAT_ACTIVITY_WORDING_LABELS[choice.value]}
                description={choice.description}
                preview={
                  <BotChatActivityPreview
                    level="quiet"
                    wording={choice.value}
                    label={BOT_CHAT_ACTIVITY_WORDING_LABELS[choice.value]}
                    name={`wording-${choice.value}`}
                  />
                }
              />
            ))}
          </RadioGroup>
        </Field>
      </FieldSet>
      <FieldSet title="On iPhone and Android">
        <Field orientation="vertical" description="Always just the line, with the same words.">
          <BotChatActivityPreview level="quiet" wording={value.wording} label="On iPhone and Android" name="phones" />
        </Field>
      </FieldSet>
    </BotPageShell>
  );
}
```

If `Field`'s `description` renders only alongside a `label`, pass `label="Always just the line"` with `description="With the same words as on the Mac."` instead, and update test 4's text to match. Check `renderer/components/ui` before choosing.

- [ ] **Step 4: Route it and add the Advanced row**

`renderer/main/bots/bot-page-search.ts`:

```ts
/** A Bot page reached from its Profile; `/bots/$botId?page=advanced` opens Advanced directly. */
export type BotSubpage = "instructions" | "advanced" | "memory" | "chat-activity";

const SUBPAGES: ReadonlySet<string> = new Set<BotSubpage>(["instructions", "advanced", "memory", "chat-activity"]);
```

`renderer/main/bots-view.tsx`: import `BotChatActivityPage` and change the page switch:

```tsx
      ) : page === "advanced" ? (
        <BotAdvanced
          key={`${current.id}:advanced`}
          bot={current}
          onClose={back}
          onOpenChatActivity={() => openPage("chat-activity")}
        />
      ) : page === "chat-activity" ? (
        <BotChatActivityPage key={`${current.id}:chat-activity`} bot={current} onClose={() => openPage("advanced")} />
      ) : page === "memory" ? (
```

`renderer/main/bots/bot-advanced.tsx`:

1. Import `ChevronRight` from `lucide-react` and `botChatActivitySummary` from `./bot-chat-activity-page`.
2. Change the signature to `export function BotAdvanced({ bot, onClose, onOpenChatActivity }: { bot: BotDefinition; onClose(): void; onOpenChatActivity(): void })`.
3. Below `const guard = useDiscardChangesGuard({ … });`, add a second guard so unsaved access edits are not lost silently:

```tsx
  const chatActivityGuard = useDiscardChangesGuard({
    dirty,
    onLeave: onOpenChatActivity,
    description: `Your changes to ${bot.name}’s Advanced settings won’t be saved.`,
  });
```

4. Directly before `<TelegramSection bot={bot} />`, add:

```tsx
      <FieldSet title="Chat">
        <button
          type="button"
          aria-label="Chat activity"
          className="settings-field relative flex w-full min-w-0 items-center gap-3 p-4 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
          onClick={() => {
            if (!saving) chatActivityGuard.requestLeave();
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-strong text-primary">Chat activity</span>
            <span className="mt-0.5 block text-small text-secondary">What you see while {bot.name} works.</span>
          </span>
          <span className="shrink-0 text-small text-secondary">{botChatActivitySummary(bot.chatActivity)}</span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
        </button>
      </FieldSet>
```

  and `{chatActivityGuard.dialog}` next to `{guard.dialog}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-chat-activity-page.test.tsx renderer/main/bots/bot-profile.test.tsx`
Expected: PASS. Profile and Advanced behaviour is otherwise unchanged.

- [ ] **Step 6: Register and look at it**

Append ` renderer/main/bots/bot-chat-activity-page.test.tsx` to `test:bots`. In `scripts/ci-test-registry.json`, add `"renderer/main/bots/bot-chat-activity-page.test.tsx",` after the Task 6 entry.

Run: `npm run test:ci-policy && npm run type-check`
Expected: PASS.

Run the app (`npm run dev`, or use the `run` skill). Open a Bot → ••• → Advanced → Chat activity in light and dark, and with Settings → Appearance → Reduce Motion on and off. Confirm:
- the rows have no borders and the selected row uses the selection background;
- the arrow keys move within each radio group, with a visible focus ring;
- the previews loop with motion on and hold a still frame with Play under Reduce Motion;
- choosing Detailed shows the open live recap in a real chat.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/bots/bot-chat-activity-page.tsx renderer/main/bots/bot-chat-activity-page.test.tsx renderer/main/bots/bot-page-search.ts renderer/main/bots-view.tsx renderer/main/bots/bot-advanced.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: Advanced → Chat activity with live previews, saved on pick"
```

---

### Task 10: Faces glance while their Bot works

**Files:**
- Modify: `renderer/components/aiden-activity-mark.tsx`, `renderer/components/bot-avatar.tsx`, `renderer/styles.css`, `renderer/main/bots/bot-chat-header.tsx`, `renderer/main/bots/bot-chat-pane.tsx`, `renderer/main/bots/bot-list.tsx`
- Test: `renderer/main/bots/bot-list.test.tsx`, `renderer/main/bots/bot-chat-pane.test.tsx`

**Interfaces:**
- Consumes: `AidenActivityMark` and the `aiden-mark-look`/`aiden-mark-blink` keyframes in `styles.css`.
- Produces:
  - `observeOffscreen(node: Element): () => void` (exported from `aiden-activity-mark.tsx`, sharing its observer).
  - `BotAvatar` gains `working?: boolean`, and its root carries `data-working` while working. A canonical face glances; a photo shows a `glance` mark badge.
  - `BotChatNamePill` gains `working?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `renderer/main/bots/bot-list.test.tsx`:

```tsx
test("a working Bot's face is marked working; an idle one is not", () => {
  renderList([
    { bot: bot("b1", "Runner"), state: { kind: "running", submissionId: "s1" } },
    { bot: bot("b2", "Sleeper"), state: { kind: "idle" } },
  ]);
  assert.equal(screen.getByTitle("Runner").hasAttribute("data-working"), true);
  assert.equal(screen.getByTitle("Sleeper").hasAttribute("data-working"), false);
  assert.ok(within(screen.getByRole("button", { name: /^Runner/u })).getByText("Working"));
});
```

In `renderer/main/bots/bot-chat-pane.test.tsx`:

```tsx
test("the chat header's face works while the Bot works, and a photo gets a small activity badge", async () => {
  await mountChat({
    "bots:getCanonicalPhoto": () => ({ assetRevision: "a1", dataUrl: "data:image/png;base64,AAAA" }),
    "bots:live:subscribe": () =>
      snapshot({ state: { kind: "running", submissionId: "s1" }, activity: { phase: "thinking", startedAt: Date.now() } }),
  });
  const pill = await screen.findByRole("button", { name: "Planner profile" });
  const face = within(pill).getByTitle("Planner");
  assert.equal(face.hasAttribute("data-working"), true);
  await waitFor(() => assert.ok(face.querySelector('[data-aiden-mark="glance"]')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-list.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. `data-working` is absent.

- [ ] **Step 3: Share the off-screen observer**

In `renderer/components/aiden-activity-mark.tsx`, change the observer callback to `(entry.target as Element).toggleAttribute("data-offscreen", !entry.isIntersecting);` and add below `visibilityObserver`:

```ts
/** Pause an element's animations while it is scrolled out of view (`data-offscreen`), on the shared observer. */
export function observeOffscreen(node: Element): () => void {
  const observer = visibilityObserver();
  if (!observer) return () => undefined;
  observer.observe(node);
  return () => observer.unobserve(node);
}
```

Use it in `AidenActivityMark`'s first effect: `React.useEffect(() => { const node = ref.current; return node ? observeOffscreen(node) : undefined; }, []);`.

- [ ] **Step 4: Working faces**

In `renderer/components/bot-avatar.tsx`:

1. Import `{ AidenActivityMark, observeOffscreen } from "./aiden-activity-mark"`.
2. Replace `EyeMark` so each eye can blink as one shape and both can glance:

```tsx
/** The one fixed eye mark every Bot shares; only colour and shape vary. Eyes glance while working. */
function EyeMark({ y, spread }: { y: number; spread: number }) {
  return (
    <g className="bot-avatar-eyes">
      {[20 - spread, 20 + spread].map((x) => (
        <g key={x} className="bot-avatar-eye">
          <ellipse cx={x} cy={y} rx="2.05" ry="2.85" fill="var(--bot-avatar-face)" />
          <circle cx={x - 0.7} cy={y - 1} r="0.58" fill="var(--bot-avatar-eye-highlight)" opacity="0.94" />
        </g>
      ))}
    </g>
  );
}
```

3. Add `working = false,` and `working?: boolean;` to `BotAvatar`'s props. Below the photo state:

```tsx
  React.useEffect(() => {
    const node = avatarRef.current;
    if (!working || !node) return;
    return observeOffscreen(node);
  }, [working]);
```

4. On the root `<span>`, add `data-working={working ? "" : undefined}` and prefix its className with `bot-avatar `. After the `<img>` block, add:

```tsx
      {showPhoto && working ? (
        <span className="absolute bottom-0 right-0 grid place-items-center rounded-full bg-background p-px text-primary">
          <AidenActivityMark mark="glance" size={size === "large" || size === "preview" ? 14 : 10} />
        </span>
      ) : null}
```

`renderer/styles.css`: directly after the `/* Bounce: the typing trio. */` block, add:

```css
/* Bot faces glance and blink while their Bot works (spec §6), reusing the glance
   keyframes. Motion runs only with Reduce Motion off and on screen; otherwise the
   face holds its still pose. */
:root[data-reduce-motion="false"] .bot-avatar[data-working] .bot-avatar-eyes { animation: aiden-mark-look 4s cubic-bezier(.5, 0, .3, 1) infinite; }
:root[data-reduce-motion="false"] .bot-avatar[data-working] .bot-avatar-eye { transform-box: fill-box; transform-origin: center; animation: aiden-mark-blink 4s ease-in-out infinite; }
.bot-avatar[data-offscreen] * { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) {
  .bot-avatar[data-working] * { animation: none !important; }
}
```

- [ ] **Step 5: Use it where Bots are listed and chatted with**

`renderer/main/bots/bot-chat-header.tsx`: add `working?: boolean` to `BotChatNamePill`'s props (default `false`) and pass `working={working}` to its `BotAvatar`.

`renderer/main/bots/bot-chat-pane.tsx`: in `shell`'s `title`, pass `working={running}` to `BotChatNamePill`.

`renderer/main/bots/bot-list.tsx`: pass `working={working}` to the row's `BotAvatar`, and delete the green dot `<span className="absolute -bottom-0.5 -right-0.5 …" />` block. The face, or the photo badge, is now the indicator. Keep the `sr-only` "Working" text.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-list.test.tsx renderer/main/bots/bot-chat-pane.test.tsx renderer/components/aiden-activity-mark.test.tsx renderer/main/bots-view.test.tsx`
Expected: PASS.

In the running app, confirm that a working Bot's face glances in the list and the header pill. With Reduce Motion on it stays still. A Bot with a photo shows a small glance badge.

- [ ] **Step 7: Commit**

```bash
git add renderer/components/aiden-activity-mark.tsx renderer/components/bot-avatar.tsx renderer/styles.css renderer/main/bots/bot-chat-header.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-list.tsx renderer/main/bots/bot-list.test.tsx renderer/main/bots/bot-chat-pane.test.tsx
git commit -m "Bots: faces glance while their Bot works"
```

---

### Task 11: Docs, memory, onboarding review and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` (§6, §17), `docs/plans/README.md`, `.memory/bots-rework-ui.md`
- Create: `.memory/bot-chat-activity.md`

- [ ] **Step 1: Record the plan's rulings in the spec**

In §6, replace "The recap reuses `summarizeActivity`. The trail reuses `ActivityFeed` and the `agent-steps` verbs." with:

> The recap is a Bot-specific fold (`renderer/main/bots/bot-activity-recap.tsx`). It reuses the activity feed's tone tokens, shimmer and row rhythm. Its wording comes from the shared step phrases in `renderer/shared/bot-activity.ts`, because `ActivityFeed` owns its own open state and `summarizeActivity` cannot name apps.

In §17, add:

> - **Slice B rulings (2026-10-14):**
>   - Pi Durable 1.0.3 withdraws one queued submission (`Harness.abortSubmission`), so the Queued bubble has Remove.
>   - Refusals are told from failures by Pi's `blocked` tool diagnostic.
>   - `chatActivity` left out of an update keeps the stored value.
>   - The app label is read from the MCP agent tool name.
>   - A command's detail prefers the model's `description`, and is redacted before it is cut.
>   - Always "Thinking" hides the peek.
>   - The recap shows red "N issues" and amber "N blocked" separately.
>   - The snapshot also carries `queued` from `pi.inbox`.
>   - The Bots onboarding tile needed no redraw: it shows neither the list nor the Updates line.

- [ ] **Step 2: Update the plan index**

In `docs/plans/README.md`, in the "Bot chat activity…" row that slice A added, after "B quiet status line + per-Bot Chat activity setting", insert ` ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-b-status-line.md))`.

- [ ] **Step 3: Project memory**

Create `.memory/bot-chat-activity.md`:

```markdown
# Bot chat activity (2026-10-14)

Spec: docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md. Slice B plan: docs/superpowers/plans/2026-10-14-bot-chat-activity-b-status-line.md.

## Slice B (desktop) — what shipped
- Phase vocabulary and tool classifier: `renderer/shared/bot-activity.ts` (shared with main, the CLI, and slice D's phones). Unknown ids → `working`. Always "Thinking" keeps waiting/stopping/reconnecting.
- Main derives `BotLiveSnapshot.activity` + `activity` event in `live-projection.ts` (`liveBotActivity`), gated on session state `running` (a paused Bot still has `pi.live.run`). Stop/Resume reach it through `notifyStopping`/`notifyResuming` in the `bots:stop`/`bots:resume` handlers; approvals refresh it via `botApprovals.onChange`.
- Transcript tool calls carry `kind/label/detail/app` (`bot-activity-detail.ts`, redacted with `sanitizeDiagnosticText` before cutting to 80); tool results carry `status: ok|failed|blocked` (Pi's `blocked` diagnostic) and `durationMs`.
- `BotDefinition.chatActivity?` `{ level: quiet|summary|detailed, wording: follows|thinking }`; absent = Quiet/Follows; an update without it keeps the stored value (Profile and Remote PATCH never reset it).
- Renderer: `BotStatusLine`, `BotActivityRecap` (Bot-specific, not ActivityFeed), progress narration as bubbles (`BotUpdates` and `bot-reply-projection.ts` deleted), "You stopped this reply." derived from `stopReason: "aborted"`.
- Queue/Steer: `pi.inbox` projected as `snapshot.queued`; follow-ups faded with Remove (`bots:withdraw` → `Harness.abortSubmission`), steers as normal bubbles.
- Advanced → Chat activity (`?page=chat-activity`, `bot-chat-activity-page.tsx`), saved on pick through `updateBotIdentity`.
- `BotAvatar working` (glance eyes; photo → glance badge); list's green dot removed.

## For slice D (phones)
- Remote wire is unchanged by B. D adds `activity` (phase, app ≤ 40, startedAt only) to the session stream and `chatActivity` to detail/PATCH behind `bot-activity-v1`; reuse `botActivityDisplay`, `botElapsedLabel` and `nextBotAnnouncement` semantics and the §5 table as the shared fixture.
```

In `.memory/bots-rework-ui.md`:
- In the Chat bullet, replace "and one collapsible "Working…" / "Updates" line" with "a status line while it works (Chat activity: Quiet/Summary/Detailed), recaps for Summary/Detailed, faded Queued bubbles with Remove".
- In the List bullet, replace "avatar with an activity dot" with "avatar whose face glances while working".
- In Key files, add `bot-status-line.tsx`, `bot-activity-recap.tsx`, `bot-activity-steps.ts`, `bot-chat-activity-page.tsx`, `renderer/shared/bot-activity.ts`, `main/services/bot-runtime/bot-activity-detail.ts`.
- In Deleted, add `bot-updates.tsx` and `bot-reply-projection.ts` (2026-10-14).
- Add "See `.memory/bot-chat-activity.md`."

- [ ] **Step 4: Check the native clients and Remote**

iOS and Android read Bot sessions only through the Remote wire. Slice B leaves that wire unchanged: `projectBotSessionEntries` picks fields explicitly, and Bot detail does not include `chatActivity`. Confirm with:

```bash
npm run test:aiden-remote
```

Expected: PASS with no fixture changes. The mobile suites are not affected by this slice; slice D runs them.

- [ ] **Step 5: Run every affected suite**

```bash
npm run type-check
npm run lint
npm run test:bots
npm run test:bot-runtime
npm run test:ci-policy
npx tsx --test main/handlers/ipc-contract.test.ts main/handlers/bot-live.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md docs/plans/README.md .memory/bots-rework-ui.md .memory/bot-chat-activity.md
git commit -m "Docs: slice B rulings, plan index, project memory"
```
