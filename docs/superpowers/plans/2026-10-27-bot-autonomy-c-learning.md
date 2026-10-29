# Bot autonomy C: self-improving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots learn from their own routine runs, from the person's corrections and from procedures the person liked. They tidy their memory, and every change they learn is visible on one page with Undo.

**Architecture:**
- **Close the skill gap first.** Today a Bot can give itself an unapproved skill; that is fixed before anything else.
- **Shared spine:** a per-Bot learning history (before and after content with behavior fingerprints), a daily learning budget, and a lesson store. Every learning job writes through all three.
- **Learning jobs:** the jobs reuse the memory review's admission, lease and `Models.completeSimple` pattern from `main/services/bot-memory/review.ts`:
  - routine reflection (L1);
  - correction capture (L3), inside the existing review;
  - memory tidying (L4).
- **Approval cards:** lessons and skills that need approval are conversation-entry cards, using the same pattern as routine proposals.

**Tech Stack:** TypeScript, Electron, Pi Durable 1.4.0 `Models.completeSimple`, React, Swift, Kotlin, `tsx --test`.

**Spec:** [`docs/superpowers/specs/2026-10-27-bot-autonomy-design.md`](../specs/2026-10-27-bot-autonomy-design.md) §3 (D5, D6), §4.4, §7, §8, §10.

**Depends on:**
- Task 1 depends on nothing; ship it first.
- Tasks 2–9 need Plan A Task 1 (failure kinds) and Task 9 (claim check), because reflection reads both.
- Task 8 needs Plan A Task 3 (Bot issues), for unapproved-skill review.

## Global Constraints

- Everything in Plan A's Global Constraints applies.
- Nothing learned may change locked rules, authority, tool access or the persona. Lessons and skills sit in untrusted-data blocks below authority. They are escaped with `escapePromptText` and scanned with `main/services/bot-memory/scan.ts` before they are stored.
- Learning reads only person turns, plus the Bot's own routine output, through `memoryProvenance` and `personTurns` (`review.ts:358-451`). Routine and intro inputs never become memory, corrections or lessons.
- Approval (D5): reflection lessons and skills need an approval card. Corrections and tidying apply at once and show "· Undo".
- Budget (D6): 12 model requests and 24,000 output tokens per Bot per local day, across review, reflection, tidy and correction work.
- Keep how-to lessons out of `USER.md` and `MEMORY.md`. Personal facts and workflow knowledge stay separate (harness-quality plan H5).
- No brain icons anywhere. The learning page uses an existing non-brain icon from the shared icon set.
- Bot-proposed skills are capped at 16 KiB of instructions, so history snapshots stay bounded.

## Review Focus

1. **Undo after a later change.** The person edits memory by hand after a tidy, then presses Undo on the tidy. Expect `conflict`, nothing overwritten, and a message to use the memory page. Task 2 tests this.
2. **A reflection whose runs span a setup change.** The fingerprint differs between runs. Expect a `confounded` verdict and no card. Task 5 tests this.
3. **The budget runs out mid-reflection.** Expect a clean stop with no partial lesson and a retry the next day. Task 3 tests this.
4. **A correction that is really a personal fact** ("no, my daughter's name is Mia"). It must go to `USER.md` through the existing memory routing, not to lessons. Task 6 tests this.
5. **A skill the person dropped into the Bot's folder by hand.** It must not load silently, must not be lost, and must get one review card. Task 1 tests this.

---

### Task 1: Close the self-written skill gap (L0)

**Files:**
- Create: `main/services/bot-skill-approvals.ts`, `main/services/bot-skill-approvals.test.ts`
- Modify: `main/services/bot-skill-inventory.ts:94,115`. Drop home-sourced skills (`incarnationPartition === "bot:<id>"`) whose `contentFingerprint` is not approved, and report them through `unapproved(botId)`.
- Modify: `main/services/bot-runtime/bot-file-tool-router.ts:286`. Refuse writes and edits under `<home>/.aiden/skills`, `<home>/.claude/skills` and `<home>/.agents` with: "Skills need the person's OK. Use propose_skill instead."
- Modify: `main/services/bot-capability-services-main.ts:80` (wire approvals; on inventory change, raise a `skill_review` card through Task 8's card path. Until Task 8 lands, a Bot issue titled "New skill found: {name}" with `open_chat`.)
- Test: `main/services/bot-skill-inventory.test.ts`, `main/services/bot-runtime/bot-file-tool-router.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BotSkillApprovals {
    isApproved(botId: string, stableId: string, contentFingerprint: string): Promise<boolean>;
    approve(botId: string, stableId: string, contentFingerprint: string): Promise<void>;
    revoke(botId: string, stableId: string): Promise<void>;
    list(botId: string): Promise<Record<string, string>>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotSkillApprovals(options: { profileDir(): string }): BotSkillApprovals; // <profile>/bots/<dir>/skill-approvals.json
  ```

- [ ] **Step 1: Failing tests:**
  - `an unapproved home skill is not admitted under Full access`;
  - `approving its fingerprint admits it; editing the file un-admits it until approved again`;
  - `configured and global skills are unaffected`;
  - `a hand-placed home skill is reported once as unapproved` (Review Focus 5);
  - `the Bot's file tools cannot write into its skill folders`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-skill-approvals.test.ts main/services/bot-skill-inventory.test.ts main/services/bot-runtime/bot-file-tool-router.test.ts` and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 4: Register in a new `"test:bot-learning"` script and the CI registry, then commit:** "Require approval for skills in a Bot's own folder".

### Task 2: Behavior fingerprint and learning history (L5 spine)

**Files:**
- Create: `renderer/shared/bot-learning.ts`, `main/services/bot-learning/fingerprint.ts`, `main/services/bot-learning/history.ts`
- Create: `main/services/bot-learning/fingerprint.test.ts`, `main/services/bot-learning/history.test.ts`
- Modify: `main/services/bot-memory/store.ts` (add `restore(botId, files: { memory: string; user: string }, expectedRevision: string): Promise<{ ok: true; revision: string } | { ok: false; code: "conflict" }>`)
- Modify: `main/services/bot-memory/review.ts` (each successful add records a `memory_review` change)
- Modify: `main/services/scheduled-bot-routines.ts:357` and `main/services/types.ts:570` (`ScheduledRun.fingerprint?: string`, computed at submit time)

**Interfaces:**
- Produces:
  ```ts
  export interface BotFingerprintInputs { botRevision: string; rulesRevision: number; memoryRevision: string; lessonsRevision: string; skills: Array<{ name: string; contentFingerprint: string }>; toolNames: string[]; appVersion: string }
  export function botBehaviorFingerprint(inputs: BotFingerprintInputs): string; // sha256 hex (64) of canonical JSON with sorted skills and tool names
  export type BotLearningChangeKind = "memory_review" | "memory_tidy" | "lesson_added" | "lesson_removed" | "skill_added" | "skill_changed" | "skill_removed" | "follow_up_noted";
  export type BotLearningTarget = { kind: "memory" } | { kind: "lesson"; lessonId: string } | { kind: "skill"; name: string } | { kind: "follow_up"; commitmentId: string };
  export interface BotLearningChange { id: string; botId: string; at: number; kind: BotLearningChangeKind; summary: string; target: BotLearningTarget; before: string | null; after: string | null; fingerprintBefore: string; fingerprintAfter: string; undoneAt?: number; undoOf?: string }
  export const BOT_LEARNING_HISTORY_LIMITS = { changes: 100, bytes: 1_048_576, summaryChars: 160 } as const;
  export interface BotLearningHistory {
    record(change: Omit<BotLearningChange, "id" | "at">): Promise<BotLearningChange>;
    list(botId: string): Promise<BotLearningChange[]>; // newest first
    undo(botId: string, changeId: string): Promise<{ ok: true; change: BotLearningChange } | { ok: false; code: "conflict" | "not_found" | "already_undone" }>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotLearningHistory(deps: { profileDir(): string; current(botId: string, target: BotLearningTarget): Promise<string | null>; apply(botId: string, target: BotLearningTarget, content: string | null): Promise<void>; fingerprint(botId: string): Promise<string>; now(): number }): BotLearningHistory;
  ```
- `undo` checks that `current(target)` equals `after`, then applies `before` and records an `undoOf` change.
- Memory content is serialized as JSON `{ memory, user }` file text. Over the byte cap, the oldest changes are dropped first; changes already undone go before live ones.

- [ ] **Step 1: Failing fingerprint tests:**
  - `same inputs in any order give the same 64-hex fingerprint`;
  - `a changed skill fingerprint or tool name changes it`;
  - `a tool result never enters it`. It is a pure function of its inputs; check that the input type has no transcript field by constructing it.
- [ ] **Step 2: Failing history tests:**
  - `undo restores before when the current state equals after`;
  - `undo after a later hand edit returns conflict and changes nothing` (Review Focus 1);
  - `undo twice returns already_undone`;
  - `the cap drops the oldest undone changes first`.
  - In the review suite: `a review add is recorded with before and after memory`.
- [ ] **Step 3: Implement.** `restore` reuses the store's per-Bot queue, the threat scan and the budgets. A restore that would exceed the limits is refused as `conflict`.
- [ ] **Step 4: Run** `npx tsx --test main/services/bot-learning/*.test.ts main/services/bot-memory/*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** "Record what a Bot learns, with Undo".

### Task 3: Daily learning budget (D6)

**Files:**
- Create: `main/services/bot-learning/budget.ts`, `main/services/bot-learning/budget.test.ts`
- Modify: `main/services/bot-memory/review.ts:190` (reserve before each `completeSimple`; release with the response's `usage.output`)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_LEARNING_DAILY_LIMITS = { requests: 12, outputTokens: 24_000 } as const;
  export type BotLearningJob = "review" | "reflection" | "tidy";
  export interface BotLearningBudget {
    reserve(botId: string, job: BotLearningJob): Promise<{ ok: true; settle(outputTokens: number | undefined): Promise<void> } | { ok: false; reason: "daily_limit" }>;
    today(botId: string): Promise<{ requests: number; outputTokens: number }>;
  }
  export function createBotLearningBudget(deps: { profileDir(): string; timeZone(): string; now(): number }): BotLearningBudget; // <profile>/bots/<dir>/learning-budget.json, one row per local day
  ```
- Unknown usage (`undefined`) settles with `maxTokens` of that request, to stay conservative.

- [ ] **Step 1: Failing tests:**
  - `the 13th request of a local day is refused`;
  - `output tokens over 24,000 refuse further requests`;
  - `a new local day resets the budget`, with the time zone fixed;
  - `unknown usage counts as maxTokens`.
  - In the review suite: `a review stops cleanly when the budget is spent and writes no marker`, so it retries next time (Review Focus 3, for the review path).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the tests. Expected: PASS.
- [ ] **Step 4: Commit:** "Cap a Bot's background learning per day".

### Task 4: The lesson store and prompt injection (shared by L1 and L3)

**Files:**
- Create: `renderer/shared/bot-lessons.ts`, `main/services/bot-lessons/store.ts`, `main/services/bot-lessons/prompt.ts`
- Create: `main/services/bot-lessons/store.test.ts`, `main/services/bot-lessons/prompt.test.ts`
- Modify: `main/services/scheduled-bot-routines.ts:53` (`botRoutineMessage(prompt, notes, eventBlock?, lessons?)`; routine lessons go after the notes)
- Modify: `main/services/bot-runtime/bot-session-main.ts:~220-247` (Bot-wide lessons are rendered in the `aiden-guidance` section)
- Modify: `main/services/bot-learning/fingerprint.ts` (inputs gain `lessonsRevision`)

**Interfaces:**
- Produces:
  ```ts
  export type BotLessonScope = { kind: "routine"; routineId: string } | { kind: "bot" };
  export type BotLessonComponent = "routine_prompt" | "procedure" | "tool_use" | "output_format";
  export type BotLessonVerdict = "helped" | "hurt" | "no_effect" | "confounded";
  export type BotLessonSource = "reflection" | "correction";
  export type BotLessonStatus = "proposed" | "active" | "dismissed" | "retired";
  export interface BotLesson { id: string; botId: string; scope: BotLessonScope; cue: string; lesson: string; component: BotLessonComponent; evidence: string[]; verdict: BotLessonVerdict; source: BotLessonSource; status: BotLessonStatus; createdAt: number; decidedAt?: number; retires?: string }
  export const BOT_LESSON_LIMITS = { cueChars: 160, lessonChars: 300, evidence: 8, activePerRoutine: 6, activeBotWide: 12, proposedPerBot: 2 } as const;
  export const BOT_LESSON_PROPOSAL_ENTRY_KIND = "aiden.lesson-proposal";
  export const BOT_LESSON_STATUS_ENTRY_KIND = "aiden.lesson-status";
  export const BOT_LESSON_LEARNED_ENTRY_KIND = "aiden.lesson-learned";   // the "Learned: … · Undo" line
  export interface BotLessonStore {
    add(botId: string, input: Omit<BotLesson, "id" | "botId" | "createdAt" | "status"> & { status: "proposed" | "active" }): Promise<{ ok: true; lesson: BotLesson } | { ok: false; code: "blocked" | "full" | "invalid"; error: string }>;
    setStatus(botId: string, id: string, status: BotLessonStatus): Promise<BotLesson | undefined>;
    list(botId: string, filter?: { scope?: BotLessonScope; status?: BotLessonStatus }): Promise<BotLesson[]>;
    revision(botId: string): Promise<string>; // 16 hex of sha256 over active lessons
    forgetBot(botId: string): Promise<void>;
    forgetRoutine(botId: string, routineId: string): Promise<void>;
  }
  export function renderRoutineLessons(lessons: readonly BotLesson[]): string; // "" or "Lessons from earlier runs of this routine:\n- {lesson}"
  export function renderBotLessons(lessons: readonly BotLesson[]): string;     // "" or "How this person likes things done:\n- {lesson}"
  ```
- Adding past an active cap retires the oldest active lesson in that scope and records a `lesson_removed` change.

- [ ] **Step 1: Failing tests:**
  - `a lesson that fails the threat scan is blocked`;
  - `the seventh active routine lesson retires the oldest`;
  - `a lesson's text is escaped in the rendered block`;
  - `routine lessons appear only in that routine's input, after its notes`;
  - `Bot-wide lessons appear in the guidance section and change the fingerprint`;
  - `deleting a routine forgets its lessons`. Wire it into the routine-delete fan-out beside `botRoutineNotes.clear` (`scheduled-bot-routines-main.ts:48`).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-lessons/*.test.ts main/services/scheduled-bot-routines.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit:** "Store a Bot's lessons and use them in its prompts".

### Task 5: Routine reflection and the lesson card (L1)

**Files:**
- Create: `main/services/bot-learning/routine-reflection.ts`, `main/services/bot-learning/routine-reflection-prompt.ts`, `main/services/bot-learning/routine-reflection.test.ts`
- Create: `renderer/components/bots/lesson-proposal-card.tsx`, `renderer/components/bots/lesson-proposal-card.test.tsx`
- Modify: `main/services/bot-runtime/live-projection.ts` (project `aiden.lesson-proposal` and its status, like routine proposals at `:350`), `renderer/shared/bot-live.ts` (the `{ type: "lesson_proposal"; lesson: BotLesson; status }` variant), `renderer/main/bots/bot-transcript-rows.ts`, `renderer/main/bots/bot-chat-pane.tsx`
- Modify: `main/handlers/` (IPC `bots:lessons:respond` with `{ botId, lessonId, decision: "keep" | "dismiss" }`)
- Modify: `main/services/scheduled-bot-routines.ts:388` (call `reflection.afterRun(task, run)` after the run is recorded)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_ROUTINE_REFLECTION_INTERVAL = 5;
  export const BOT_ROUTINE_REFLECTION_OUTPUT_CHARS = 1_500;
  export interface ReflectionRunView { runId: string; result: ScheduledRunResult; failure?: BotRoutineFailure; claimCheck?: { toolNames: string[] }; toolNames: string[]; toolErrors: string[]; output: string; fingerprint?: string; finishedAt: number }
  export function reflectionInput(input: { routineName: string; prompt: string; notes: string; lessons: readonly BotLesson[]; runs: readonly ReflectionRunView[] }): { systemPrompt: string; message: string };
  export function createRoutineReflection(deps: {
    runs(taskId: string): Promise<ScheduledRun[]>; runView(task: ScheduledTask, run: ScheduledRun): Promise<ReflectionRunView>; // transcript slice by request id (submissionByRequest), tool names and errors
    lessons: BotLessonStore; history: BotLearningHistory; budget: BotLearningBudget;
    admit(botId: string): Promise<BotMemoryAdmission>;   // the same admission as the memory review (bot-session-main.ts:175)
    appendEntry(botId: string, kind: string, data: unknown): Promise<void>;
    state: { lastReflectedRunId(taskId: string): Promise<string | undefined>; set(taskId: string, runId: string): Promise<void> };
    timeoutMs?: number;
  }): { afterRun(task: ScheduledTask, run: ScheduledRun): Promise<"skipped" | "no_entry" | "proposed" | "confounded" | "failed" | "budget">; cancel(botId: string): void };
  ```
- Model tools (one call max each, `maxRounds: 2`):
  - `record_lesson { cue, lesson, component, evidence: string[], verdict }`
  - `retire_lesson { lessonId, evidence: string[] }`
- Validation:
  - Every `evidence` id must be a provided run id.
  - `verdict: "confounded"` gives `confounded` and no card.
  - `verdict: "no_effect"` gives no card.
  - A lesson is proposed only with `helped` or `hurt`. `hurt` is for "stop doing X" and needs `retire_lesson`.
- Prompt rules, adapted from Harness² `core/prompts.py:1105-1147` and `:913-924`. Keep them short and quote these sentences exactly:
  - "A failure that repeats across these runs is real. A problem in one run is noise."
  - "Prefer confounded when the setup changed between runs (the fingerprint differs) or when one run is all the evidence. An invented cause poisons every later run."
  - "Name the component the lesson concerns. Too generic is useless ('be thorough'); too specific never fires again."
  - "Adoption alone never shows that a lesson helped."
  - "If nothing here supports a reusable lesson, reply NO_ENTRY."
- Card copy:
  - title `"I learned something about {routine}"`;
  - body: the lesson text;
  - an evidence line `"Based on {n} recent runs"`;
  - buttons "Keep this" and "Not now".

  Keep makes the lesson `active` and records a `lesson_added` change. Not now makes it `dismissed`.

- [ ] **Step 1: Failing reflection tests**, with a fake `admit` returning a scripted `completeSimple`:
  - `runs only after 5 settled non-skipped runs since the last reflection`;
  - `NO_ENTRY proposes nothing and advances the watermark`;
  - `a lesson citing an unknown run id is rejected`;
  - `runs with different fingerprints and a confounded verdict propose nothing` (Review Focus 2);
  - `a helped lesson appends one lesson-proposal entry and stays proposed`;
  - `at two pending proposals the next lesson is dropped as no_entry`;
  - `budget refusal stops before any request and keeps the watermark` (Review Focus 3);
  - `losing authority mid-run writes nothing`. Use `BotMemoryAuthorityLostError`, as review.ts does.
  - Also check `reflectionInput` with a fixture: `includes each run's failure kind, claim-check tools, tool errors and fingerprint, and clips output to 1,500 chars`.
- [ ] **Step 2: Failing card tests:**
  - `Keep this responds keep`;
  - `a decided card shows a quiet status and no buttons`.
  - A handler register-and-invoke test: `bots:lessons:respond rejects extra keys`.
- [ ] **Step 3: Implement.** The reflection runs after the routine's run is recorded, debounced 10 s, and only when the Bot is idle (`isIdle`, as in the review).
- [ ] **Step 4: Run** `npx tsx --test main/services/bot-learning/routine-reflection.test.ts renderer/components/bots/lesson-proposal-card.test.tsx` and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 5: Commit:** "Let a Bot propose one lesson from a routine's recent runs".

### Task 6: Learn from corrections (L3)

**Files:**
- Create: `main/services/bot-lessons/how-to-tool.ts`, `main/services/bot-lessons/how-to-tool.test.ts`
- Modify: `main/services/bot-memory/review.ts:94,152` (the review gets `note_how_to` next to the add-only memory tool and `note_follow_up`; prompt lines for corrections)
- Modify: `main/services/bot-memory/routing.ts:10` (one sentence separating facts about the person (USER), the Bot's notes (MEMORY) and how the person wants work done (`note_how_to`))
- Modify: `main/services/bot-runtime/live-projection.ts`, `renderer/main/bots/bot-chat-pane.tsx` (render `aiden.lesson-learned` as a subtle line "Learned: {lesson} · Undo", in the style of the existing "Memory updated" line)

**Interfaces:**
- Produces: `createNoteHowToTool(deps: { botId: string; lessons: BotLessonStore; history: BotLearningHistory; appendEntry(...): Promise<void> }): AgentTool`. Its name is `note_how_to`, with params `{ cue: string; lesson: string }`. It creates a Bot-scope lesson with `source: "correction"`, `status: "active"`, `verdict: "helped"`, `component: "output_format" | "procedure"` (the model picks), and `evidence` set to the person entry ids from the review window.
- Review prompt lines (exact):
  - "When the person corrects how you did something ("no, put the totals first"), call note_how_to with when it applies and what to do."
  - "Facts about the person go to user memory, not note_how_to."

- [ ] **Step 1: Failing tests:**
  - `a correction in a person turn creates one active Bot lesson and one Learned line`;
  - `the same correction twice is one lesson`, deduped by normalized lesson text;
  - `a personal fact phrased as a correction goes to USER, not lessons` (Review Focus 4). Script the model's choice in the fake, and assert on the routing guidance string's presence in the system prompt the review sends. That asserts what the review sends to the model, not the source text.
  - `a routine input's text never produces a lesson`;
  - `Undo on the Learned line retires the lesson and records lesson_removed`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-lessons/how-to-tool.test.ts main/services/bot-memory/review.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit:** "Let Bots learn from the person's corrections".

### Task 7: Memory tidying (L4)

**Files:**
- Create: `main/services/bot-memory/tidy.ts`, `main/services/bot-memory/tidy.test.ts`
- Modify: `main/services/bot-memory/store.ts` (a `tidyOnly` apply mode: `replace` and `remove` only; the batch's final state must be smaller in characters per target)
- Modify: `main/services/bot-runtime/bot-session-main.ts:266` (check tidy need after the review settles)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_MEMORY_TIDY = { usageRatio: 0.8, entries: 56, minIntervalMs: 24 * 3_600_000, idleMs: 10 * 60_000, maxRounds: 3 } as const;
  export function needsMemoryTidy(view: BotMemoryView): boolean;
  export function createBotMemoryTidy(deps: { memory: BotMemoryService; history: BotLearningHistory; budget: BotLearningBudget; admit(botId: string): Promise<BotMemoryAdmission>; isIdle(botId: string): boolean; appendEntry(...): Promise<void>; lastTidyAt: { get(botId: string): Promise<number | undefined>; set(botId: string, at: number): Promise<void> }; now(): number }): { maybeRun(botId: string): Promise<"not_needed" | "too_soon" | "busy" | "budget" | "tidied" | "unchanged" | "failed"> };
  ```
- Tidy prompt (exact core): "Merge duplicates, drop entries that a newer entry replaces, and shorten wordy entries. Never add a new fact. Keep every fact that is still true."
- On success, record a `memory_tidy` change with the full before and after, and append a line "Tidied memory · Undo".

- [ ] **Step 1: Failing tests:**
  - `runs at 81% of the memory limit and not at 79%`;
  - `57 entries trigger it`;
  - `at most once per 24 hours`;
  - `an add in a tidy batch is refused`;
  - `a batch that grows a target is refused`;
  - `Undo restores the exact before files`, through history;
  - `budget refusal leaves memory untouched`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npx tsx --test main/services/bot-memory/tidy.test.ts main/services/bot-memory/store.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit:** "Let Bots tidy memory that is nearly full".

### Task 8: Skill proposals with a diff card (L2)

**Files:**
- Create: `main/services/bot-skills/validate.ts`, `main/services/bot-skills/validate.test.ts`, `main/services/bot-skills/propose-tool.ts`, `main/services/bot-skills/proposals.ts`, `main/services/bot-skills/proposals.test.ts`
- Create: `renderer/components/bots/skill-proposal-card.tsx`, `renderer/components/bots/skill-proposal-card.test.tsx`
- Create: `renderer/components/diff-view.tsx` (move `DiffViewer` out of `renderer/components/review-panel.tsx:210` so both use one component; keep `parseUnifiedDiff` at `:152`)
- Modify: `main/services/bot-runtime/bot-tool-policy.ts:76-83` (`propose_skill` joins `UNATTENDED_WITHHELD`), `main/services/bot-runtime/bot-tool-sources-main.ts:411` (install the candidate), the live projection and transcript rows (`{ type: "skill_proposal"; … }`)
- Modify: `main/services/bot-capability-bindings.ts:1215` path (under Custom access, accepting adds the skill to `selection.skillIds` through the existing capability editor)
- Modify: iOS `AidenBotSessionChatView.swift` and Android `AidenBotSessionScreen.kt`. Phones show the card read-only with "Review on your Mac" until `bot:learning`; Task 9 adds phone actions.

**Interfaces:**
- Produces:
  ```ts
  export const BOT_SKILL_PROPOSAL_LIMITS = { nameChars: 48, descriptionChars: 240, instructionsBytes: 16_384, pendingPerBot: 1 } as const;
  export function validateBotSkillProposal(input: { name: string; description: string; instructions: string }, context: { existingNames: ReadonlySet<string>; existingSources: ReadonlyMap<string, "configured" | "workspace" | "global">; current?: string }): { ok: true; file: string; diff: string } | { ok: false; errors: string[] };
  export function createProposeSkillTool(deps: { botId: string; proposals: BotSkillProposals }): AgentTool; // params { name, description, instructions, reason }
  export interface BotSkillProposals { propose(botId: string, input: …, append: …): Promise<{ ok: true; proposalId: string } | { ok: false; code: "invalid" | "too_many_pending"; errors?: string[] }>; respond(input: { botId: string; proposalId: string; decision: "add" | "dismiss" }): Promise<{ status: "added" | "dismissed" }> }
  ```
- Validator error strings (each names the problem and its consequence):
  - `"Name must be lowercase letters, numbers and dashes (got “{name}”)."`
  - `"A {source} skill is already named “{name}”, so this one would be hidden."`
  - `"The description must say when to use this skill; an unused skill does nothing."`
  - `"Instructions are {n} KB; the limit is 16 KB."`
  - `"This text was blocked: {scan reason}."`
- The file is built with frontmatter `name` and `description`, then the instructions. It must re-parse cleanly through `parseSkillMd` (`skills-discovery.ts:38`); the validator's tests prove this.
- Tool description (cheapest-form ladder, exact core): "Propose a skill when you just completed a multi-step procedure the person liked and will want again. A skill costs nothing until it is used. Prefer it to adding long notes to memory."
- Accepting:
  - writes `<home>/.aiden/skills/{name}/SKILL.md` atomically;
  - calls `approvals.approve(…)`;
  - records `skill_added` (or `skill_changed` with the old file as `before`);
  - appends the status entry.

  A skill with the same name in the Bot's home is shown as a diff.

- [ ] **Step 1: Failing validator tests:**
  - one per error string above;
  - `a valid proposal round-trips through parseSkillMd with the same name, description and instructions`;
  - `an update produces a unified diff against the current file`.
- [ ] **Step 2: Failing proposal tests:**
  - `propose is refused on routine and Telegram runs`, through `botIngressAllowsTool`;
  - `a second pending proposal is refused`;
  - `add writes the file, approves the fingerprint and the skill is admitted on the next inventory`;
  - `under Custom access add also grants the skill`;
  - `Undo of skill_added removes the file and revokes approval`;
  - `the unapproved hand-placed skill from Task 1 becomes a review card and Add approves it without rewriting the file`.
- [ ] **Step 3: Failing card test:** `shows the skill name, reason and diff; Add and Not now respond`. Reuse `DiffView`; the review-panel suite must still pass.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npx tsx --test main/services/bot-skills/*.test.ts renderer/components/bots/skill-proposal-card.test.tsx renderer/components/review-panel.test.tsx` and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 6: Commit:** "Let Bots propose skills the person approves".

### Task 9: The "What I've learned" page and phones (L5 UI)

**Files:**
- Create: `renderer/main/bots/bot-learning-page.tsx`, `renderer/main/bots/bot-learning-page.test.tsx`
- Modify: `renderer/main/bots/bot-profile.tsx` (a row "What I've learned"), `renderer/main/bots-view.tsx:147-170`
- Modify: `main/handlers/` (IPC `bots:learning:get` returns `{ lessons, skills, followUps, changes, budget }`; `bots:learning:undo`; `bots:lessons:remove`; `bots:skills:remove`)
- Modify: `main/services/aiden-remote-protocol.ts` (`bot:learning`: `GET /bots/:botId/learning`, `POST /bots/:botId/learning/:changeId/undo`, `POST /bots/:botId/lessons/:lessonId/respond`, `POST /bots/:botId/skill-proposals/:id/respond`), `main/services/aiden-remote-router.ts`, `openapi.json`, `contract.json`, `docs/aiden-remote-api-v1.md`
- Create: iOS `Features/Bots/AidenBotLearningView.swift`, Android `features/bots/AidenBotLearningScreen.kt`. Update the lesson and skill cards on both phones to act when `bot:learning` is negotiated.

**Interfaces:**
- Produces: `BotLearningOverview = { lessons: BotLesson[]; skills: Array<{ name: string; addedAt: number; changeId: string }>; followUps: BotCommitment[]; changes: BotLearningChange[]; budget: { requests: number; outputTokens: number; limits: typeof BOT_LEARNING_DAILY_LIMITS } }`. The `followUps` field is empty until Plan B Task 4 lands.
- Page sections, in this order:
  - "Lessons" (active, each with Remove);
  - "Skills I added" (each with Remove);
  - "Follow-ups" (waiting);
  - "Recent changes" (newest 20, each with Undo while not undone).

  Empty state: "Nothing yet. I'll show what I learn here."

- [ ] **Step 1: Failing renderer tests:**
  - `lists lessons, skills, follow-ups and recent changes`;
  - `Undo calls bots:learning:undo and a conflict shows "This changed since. Edit it on the Memory page."`;
  - `Remove on a lesson retires it`;
  - `the empty state shows when nothing was learned`;
  - `no element uses a brain icon`. Assert the rendered icon component is the chosen non-brain one, by its accessible name or test id, not by class.
- [ ] **Step 2: Failing Remote tests:**
  - `learning routes need bot:learning`;
  - `undo conflict is 409 with code conflict`.
  - Native decode and undo tests.
- [ ] **Step 3: Implement** with the settings design system's grouped cards and inset separators. Keep the copy minimal.
- [ ] **Step 4: Run** the renderer, Remote, iOS and Android suites. Expected: PASS.
- [ ] **Step 5: Commit:** "Show what a Bot has learned, with Undo".

### Task 10: Onboarding, docs and memory

**Files:**
- Modify: `renderer/components/onboarding-feature-gallery.tsx`, and create `renderer/components/onboarding-art/bots-that-learn.tsx` (one code-drawn tile: a Bot chat slice with a lesson card and a "· Undo" line; one Bot avatar tint; shared `oa-anim-*` classes only), with its case in the onboarding art test
- Modify: `README.md`, `PRODUCT.md`, `docs/aiden-remote-api-v1.md`, `packages/cli/README.md` (the CLI Bot host gets reflection, tidy and corrections through shared modules; no CLI learning page yet)
- Modify: `docs/plans/README.md` (program row and Plan C status), `docs/plans/aiden-harness-quality-upgrade-plan.md` (a dated note that Bot lessons use the H5a vocabulary in their own store, `main/services/bot-lessons/`, because `WorkflowEvidenceStore` is chat-scoped and needs host receipts Bots do not produce)
- Create: `.memory/bot-learning.md` (layout, constants, approval rules, the skill-gap fix, budget)

- [ ] **Step 1:** Search for stale claims: `rg -n "add-only|no background tidy|write skills|SKILL.md" docs README.md PRODUCT.md .memory`. Update each.
- [ ] **Step 2:** Run `npm run test:bot-learning`, `npm run test:bot-runtime`, the onboarding art test, and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [ ] **Step 3: Commit:** "Document Bots that learn".
