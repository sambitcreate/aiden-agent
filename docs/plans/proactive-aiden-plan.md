# Proactive Aiden: detailed plan

Written 2026-11-22 against main `c26b7979`.

**Status (2026-11-22):** Phases 1, 2, 4 and 5 are built and in review as one PR, to save CI runs; E1 moved into Phase 4. Phase 3 (B1–B6) is blocked: it waits on the subagent panel plan's PR 1 and 2, which have not landed, and on the in-flight subagent upgrade ([subagent-desktop-serve-upgrade-plan.md](subagent-desktop-serve-upgrade-plan.md)), which is activating the same background coordinator. Phase 6 stays later.

All five ideas, with the owner's 23 answers folded in, come to **44 planned pull-request units in 6 phases**. Two reviewers checked every unit against the code, and their 40 findings are fixed below.

## Your answers and what they mean

| # | Question | Answer | What gets built |
| --- | --- | --- | --- |
| 1 | What Stop stops | a | Stop ends everything running in that chat: the goal pauses, helpers and started chats stop (except a started chat you typed in). Promises for later stay. |
| 2 | Where results of a chat-made task land | a | In that chat, with a switch on the approval card; the task's own chat if the chat is gone. |
| 3 | Late check-backs | a | Still run up to 2 hours late; older ones leave a note. |
| 4 | Deleting a chat a task posts into | a | The task carries on in its own chat; the delete dialog says so. |
| 5 | Keep awake default | a | On. Running work holds on battery too; a check-back due soon holds only when plugged in. |
| 6 | Check-back switch | a | One switch in Settings. |
| 7 | How a goal starts | a | `/goal` or the + menu now; Aiden suggesting a goal comes in a later PR. Aiden never starts one alone. |
| 8 | Rounds before stopping | 50 rounds, 3 stalls | 50 rounds, then a pause. Keep going starts again at round 1 of 50. Three rounds without progress also pause. See below. |
| 9 | Who judges done | a | The chat's own model, reusing the cached conversation. |
| 10 | `/until` | becomes a goal | `/until <command>` becomes a goal checked by that command, with one bar. |
| 11 | Browser and Computer Use in goals | yes | Allowed while that chat is open and in front on the desktop. New PR A9. |
| 12 | How many helpers at once | depth 1, no count | No count limit on background helpers; helpers can't start their own helpers. See below. |
| 13 | A helper finishes while you're away | a | Aiden replies by itself, within the 6-an-hour limit. |
| 14 | Helpers changing files | a | Read-only first; later, edits only in their own worktree after one approval at launch. |
| 15 | Quitting with helpers running | a | Quit at once, mark them Interrupted, offer Run again. |
| 16 | Who can call a task link | a | Your network or Tailscale only. |
| 17 | Bursts of link calls | a | Up to 20 waiting calls go into the next run. |
| 18 | Missed scheduled times | a | Run once if under 12 hours late, else skip. |
| 19 | No-AI checks of connected apps | a | Later, read-only, after links and app checks prove out. |
| 20 | How many chats one chat runs | depth 1, no count | No count limit; started chats can't start chats. See below. |
| 21 | Lead starting chats while you're away | a | No. It can read, follow up and stop; new starts wait for you. |
| 22 | Approval wait inside a started chat | a | 30 minutes, then denied and the chat is told. |
| 23 | On from the start | a | On, with a switch in Settings → Approvals. |

### The rules behind 8, 12 and 20

- **Goal rounds (8).** A goal is not unlimited: at most 50 rounds and 3 stalls. At 50 rounds the goal pauses ("Reached the limit of 50 rounds"); `/goal resume` starts again at round 1 with the same limit of 50. A stall is the reviewer giving the same reason as last time, or a round with no tool calls; three in a row pause it. The chat's spending limit is an extra stop.
- **Helpers at once (12).** Background helpers have no limit on how many run at once and no hourly launch limit. The only limit is depth 1, so a helper can't start helpers: no per-chat or app-wide count, no launches-per-hour cap, depth 1. A few technical guards stay because they protect your computer, not your choices: a chat on a local model runs one helper at a time on the single local model slot; Aiden's existing memory guards (32 registered helpers app-wide, at most 8 launches in one answer) stay; and woken turns can't launch helpers, otherwise helpers could trigger each other forever. Foreground helpers keep today's 2 at once.
- **Chats one chat runs (20).** Started chats follow the same depth rule and have no count limit: no "3 at once / 8 in total" and no host-wide cap. Depth stays 1, Ask mode still shows a card before each start, each new worktree still needs free disk space, and every chat obeys the spending limit.

### What changed from the first plan

- Goal loop: 50 rounds instead of 20 (A1, A3, A4), and new PR **A9** lets goal rounds use the browser and Computer Use while the chat is on screen.
- Helpers: B1 drops the 2-per-chat, 3-app-wide and 12-an-hour limits for background helpers. Time limits follow the separate subagent panel plan (below).
- Chat teams: D3 drops the 3-at-once, 8-in-total, 4-per-call, 4-worktrees and host-wide caps.
- Helpers now build on the 4-PR **subagent panel plan** you picked in its own thread: no 10-minute limits, the snapshot fix, each helper's full conversation saved and shown as a read-only helper chat. B1 waits for that plan's PR 1 and 2.
- The reviewers' fixes: D4 needs no phone revision after all (phones get notices as plain text), so **6 PRs** change the phone contract, not 7. E5 now waits only on C4, and E2 also waits on C4.
- Total: **44 PRs in 6 phases** (43 plus A9).

## Rules every PR follows

1. **Two hourly limits per chat.**
   - 6 automatic wake-ups, shared by everything Aiden starts by itself: finished background jobs, pull request updates, `/until`-style checks, check-backs, helper reports and started-chat results. This is the existing `MAX_WAKES_PER_CHAT_PER_HOUR = 6` in `notice-delivery.ts`.
   - 6 task runs, shared by schedules and triggers, because you approved those (new, in C4).
   - Over a limit, the card is saved and Aiden reads it with your next message.
   - Both counters live in memory (today's wake counter is an in-memory map), so they reset when Aiden restarts. That is acceptable because nothing restarts by itself after a quit.
2. **Goal rounds count as you being there.** You started the goal and can see it. Rounds are attended turns modelled on owed turns: approvals wait 30 minutes (A5 adds this; owed turns wait 5 today), they may run read-only foreground helpers but never background helpers or helpers that write, they don't use the wake limit, and they can't set check-backs. That makes helper → round → helper loops impossible, not just bounded by 50 rounds. While a goal is active, any notice that would wake the chat starts a goal round instead.
3. **Stop** ends everything running in that chat. Promises for later (check-backs, schedules, triggers) stay, each with a visible Cancel or Pause.
4. **Nothing restarts by itself after a quit or crash.** Goals come back paused, helpers and started chats show Interrupted, late check-backs follow the 2-hour rule, and missed cron runs follow the 12-hour rule.
5. **Keep awake** holds only while something is actively working, plus check-backs due within the hour when plugged in. Recurring schedules, triggers and watches never hold in advance.
6. **One delivery path.** Every automatic message into a chat goes through `NoticeDelivery` in order. Every task run, whatever started it, goes through C4's `deliverTaskRunToChat`. Turns in started chats run through the same chat and stream services phone turns use.
7. **Approvals.** Aiden-started attended turns (goal rounds, started chats) keep a card open 30 minutes, then deny politely and tell the agent. Turns with nobody around get no approvals at all. Nothing ever approves on your behalf, and no chat answers another chat's approvals.
8. **Outside text is data.** Webhook bodies, watch diffs, connector events, helper reports and started-chat replies are fenced with `fenceAsData` and never become instructions.
9. **Phones.** Desktop first. Each phone PR claims the next free Remote revision when it merges (66 is free today; main is at 65) and updates iOS, Android and `protocol/aiden-remote/v1/fixtures` together. Older phones keep working and show less. New notice sources need no revision, because phones get each notice as one line of text.
10. **Every PR** updates affected docs in the same PR (README, PRODUCT, the relevant `docs/*.md`, `docs/plans/README.md`, `.memory/`), adds behavioural tests registered in `package.json` (appended to `test:serial`) and `scripts/ci-test-registry.json`, ships light and dark screenshots for any visible change, and adds analytics only through `analytics-events.ts` plus a `docs/analytics.md` row and test. Nothing touches Telegram.

## Phase 1: Quick wins (6 PRs)

Fix, C1, C2 and C4 are independent and can merge in any order. C3 waits on C1 and C2; C5 waits on C2 and C4.

### Fix: worktrees keep the workspace's approval settings

- **Problem.** `workspace-worktree-application-service.ts` (around line 350) copies `permission` and the skills and connectors fields into a new worktree workspace, but not `approvalMode` or `macGrants`. A worktree of a workspace set to Ask, on a Mac set globally to Never ask, runs Never ask.
- **Change.** Copy `approvalMode` and `macGrants` at both places a worktree workspace is built in `workspace-worktree-application-service.ts`: creation (around line 350) and the snapshot-restore path (around line 851). Extend `validateBeforeSave` (around line 373), which today compares only `permission`, to compare them too. This covers desktop New worktree, phone new-worktree, and later B7 and D5.
- **Tests.** Extend the worktree application service tests: a worktree of an Ask workspace stays Ask; Mac grants are copied; a workspace with no customisation still follows the global mode.
- **Docs.** PRODUCT.md's workspace approval-mode paragraph (around line 32) gains one sentence: worktrees keep their workspace's approval settings. **Revision:** no. **Screenshots:** no. **Size:** S. **Waits on:** nothing.

### C1. Keep the computer awake while Aiden works

- **Core.** New `main/services/keep-awake/keep-awake-core.ts`, pure and tested with a fake clock. It holds while any of these is true:
  - a `hostRunRegistry` run is `working` (not `needs_approval` or `needs_input`);
  - a provider usage-limit wait ends within 10 minutes (from `usage-limit-service.ts`);
  - a background job without a listening port is running (builds and tests count; servers don't), or an `/until` check runs.
- **Behaviour.** A 60-second grace keeps one hold across back-to-back runs. After 4 hours of system idle time (`powerMonitor.getSystemIdleTime`) the hold lets go until you return. Released at quit.
- **Electron.** Add `powerSaveBlocker` to `main/platform.ts`. Use `prevent-app-suspension`: the display can still sleep, and closing a Mac lid still sleeps unless it's in clamshell mode. On Linux Electron asks the desktop's inhibit service over D-Bus; check GNOME and KDE with `systemd-inhibit --list` and document it as best-effort. New capability `keepAwake: darwin || linux` in `host-platform-capabilities.ts`.
- **Setting.** C1 creates a new group "While you're away" on Settings → Scheduled tasks, after the existing "Background execution" group (`scheduled-tasks-settings.tsx` around line 81). Row **Keep this computer awake while Aiden works**: trailing switch, saved as `keepAwakeWhileWorking` in the scheduled-task settings store that page already uses (on by default, only `false` stored), a live line ("Keeping awake: 1 chat working" / "Not needed right now"), and a description saying closing the lid still sleeps. Settings search gains awake, sleep, caffeinate.
- **Files.** New `keep-awake-core.ts`, `keep-awake-main.ts`; changed `main/platform.ts`, `main/index.ts`, `host-platform-capabilities.ts`, settings types and parser, `scheduled-tasks-settings.tsx`, `settings-section.ts`.
- **Tests.** Core: grace keeps one hold; flapping inside the grace doesn't restart; switch off releases at once; idle cap. Inputs: a `needs_approval` run and a server job don't hold; a build job and a working run do. Settings render: toggling saves `false`; searching "awake" finds the row. New `test:keep-awake`, appended to `test:serial` with its files assigned in `scripts/ci-test-registry.json`; the Settings test joins `test:settings-design`.
- **Docs.** README, PRODUCT, `docs/linux.md`, `docs/settings-design-system.md`, plans index. **Revision:** no. **Screenshots:** yes. **Size:** S–M.

### C2. Chats that check back

- **Tool.** `check_back` with `action: set | list | cancel`, `in_minutes` (1–1440) or `at` ("HH:MM", within 24 hours), `note` (up to 500 characters), `id` for cancel. Result codes `invalid_time`, `invalid_note`, `too_many_pending`, `not_found`, `off`. The time rules move from `bot-wake-ups/wake-ups.ts` into a shared `main/services/wake-up-time.ts` used by both tools.
- **Where offered.** Every turn of an ordinary workspace chat on Mac and Linux, including read-only workspaces. Not in Bots (they have `wake_up`), the Assistant, Live, subagents or scheduled runs. Today `chatTurnToolRefusal` decides by tool name only (`chat-turn-tool-policy.ts` around line 169). C2 adds `goalRound?: boolean` to `ChatTurnAudience` and an args-aware refusal (name plus arguments) run through `firstTurnToolRefusal`. It refuses `check_back` with `set` in unattended or windowless turns and in goal rounds, so check-backs can't chain; `list` and `cancel` always work. Phone-sent turns are person turns and may set one.
- **Storage and firing.** Records in follow-through `state.json` as `checkBacks: {id, chatId, fireAt, note, setAt, setByTurnId, state: pending|claimed|fired|cancelled}[]`. At most 3 pending per chat and 20 in total, changes serialised per chat. One timer for the soonest, re-armed at startup, `resume` and `unlock-screen`. Firing saves `claimed`, then posts a notice with the new source `check_back` (card "Checking back", summary = the note) with `wake: true`. Model text: "You said you would check back at 3:10 PM (set at 2:50 PM): \<note>. It is now 3:10 PM. Do what the note says; if nothing is left to do, say so in one line."
- **What a check-back turn can do.** The woken turn uses the existing unattended rules (`UNATTENDED_FOLLOW_UP_GENERATION`: no approvals, connectors, helpers or Computer Use). The tool description says so, so Aiden only promises check-backs it can keep. Once the goal loop ships, a check-back in a chat with an active goal becomes a goal round instead.
- **Missed times (answer 3a).** Up to 2 hours late: still wakes the chat and says it's late. Older: a record-only "Missed check-back (due 3:10 PM)" card. A record still `claimed` at startup becomes a record-only card, so nothing fires twice.
- **UI.** Composer chip "Checking back at 3:10 PM" in `follow-through-chips.tsx`, with a popover listing notes and Cancel. Tool row "Will check back at 3:10 PM". Alarm-clock icon on the notice card. `ChatFollowThroughV1` gains `checkBacks`.
- **Interactions.** Stop leaves pending check-backs (Cancel visible). Deleting the chat drops them. Workspace access off: the card is recorded only. Inbox Snooze and Done unchanged.
- **Switch (answer 6a).** **Let chats check back later** in the "While you're away" group (created by C1, or by C2 if it merges first), saved as `chatCheckBacks` in the same scheduled-task settings store, on by default. Off cancels all pending and the tool returns `off`.
- **Files.** New `follow-through/check-backs.ts`, `check-back-tool.ts`, `wake-up-time.ts`; changed `follow-through-main.ts`, `follow-through-tools-main.ts`, `llm-client.ts`, `chat-turn-tool-policy.ts`, `agent-notices.ts`, `renderer/shared/follow-through.ts`, `follow-through-chips.tsx`, `agent-notice-card.tsx`, `bot-wake-ups/wake-ups.ts`.
- **Tests.** Caps (3 per chat, 20 total, concurrent sets); cancel; switch off cancels all; a due fire posts `wake: true`; 2 hours late wakes with the late text; older is recorded only; a `claimed` record after restart becomes a card; chat delete. Tool validation and codes. Policy: `set` refused unattended, windowless and in goal rounds, allowed in a phone person turn. Notice parse for the new source; chip renders with Cancel. Lane `test:follow-through`.
- **Docs.** `docs/coding-follow-through.md`, README, PRODUCT, plans index, `.memory/`. **Revision:** no (phones show the notice as one line). **Screenshots:** yes. **Size:** M.

### C3. Stay awake for a check-back due soon

Adds check-backs and Bot wake-ups due within 60 minutes as keep-awake inputs, only on AC power (`powerMonitor.isOnBatteryPower()`). Core input tests. **Revision:** no. **Screenshots:** no. **Size:** S. **Waits on:** C1, C2.

### C4. Tasks made in a chat post into that chat

- **Binding (answer 2a).** New main-owned `ScheduledTask.originChatId`, set once at create by `createScheduleTaskTool` from a new `originChatId` field on the `standard` variant of `ScheduleToolAccess` (`schedule-tool.ts` around line 105), passed from the chat context in `createSchedulingTools` (around line 2013). Kept on every renderer or phone update; the parsers refuse it as input. Cleared only by a new IPC `schedule:use-own-chat` or by chat deletion. The tool gains `post_in_chat` (default true when the chat's workspace is the task's workspace; true otherwise is an error).
- **Cadence floor.** A cron task that posts into a chat may run at most every 15 minutes, measured over the next 5 runs. Faster is refused with a hint to use the task's own chat. Triggers (E) don't use this floor; they rely on the 6-task-runs-an-hour chat limit plus batching.
- **Approval card.** New row "Posts in: This chat" / "Its own chat". Phones on the existing schedule card show the old rows (C7 adds the row).
- **Run path.** New `deliverTaskRunToChat(task, {trigger, eventText?})` in `schedule-execution.ts`, returning `ran | skipped: chat_busy | chat_budget | fell_back`:
  1. The origin chat must exist, not be a Bot, and share the task's workspace; otherwise use today's `ensureChat`.
  2. Wait up to 10 minutes for the chat to go idle (a new bounded version of `waitForChatIdle`, which has no timeout today); still busy → skipped `chat_busy` with a record-only notice.
  3. Over 6 task runs this hour in that chat → skipped `chat_budget`, one notice per hour. A skipped trigger run keeps its held batch of calls or changes for the next allowed run, so nothing is silently lost.
  4. Otherwise append the prompt as a notice `{source: "schedule", title: "Scheduled task: <name>", summary: <cadence>}` (C4 adds `"schedule"` to `AGENT_NOTICE_SOURCES` in `agent-notices.ts`, which today drops unknown sources) and run `scheduledGenerationSurface` (`conversation-surface-generation.ts`) with the task's own tool policy (`scheduledGenerationToolPolicy`: its permission and exact `mcpServerIds`/`mcpServerBindings`), so a connector task keeps its connectors.
  5. Event text from triggers (E) is fenced as data. Runs share the per-chat order with notices.
  6. A script-mode task has no prompt and runs no model: its non-empty output is posted into the chat as a record-only `schedule` notice, as it is posted into the task chat today.
- **Deleting the chat (answer 4a).** The task falls back to its own chat; the delete dialog says "Daily build check will keep running in its own chat."
- **UI.** Task editor shows "Posts in \<chat title>" with **Use its own chat**. The chat composer shows "Daily build check · next 9:00 AM", opening the task.
- **Files.** `schedule-tool.ts`, `agent-tool-assembly.ts` and `llm-client.ts` (pass the chat id into the scheduling tools), `schedule-execution.ts`, `schedule-store-core.ts`, `types.ts`, `agent-notices.ts` and the notice card, the scheduled-task parse handler, `aiden-remote-schedules.ts` (preserve only), `scheduled-task-approval.tsx`, the task editor, `follow-through-chips.tsx`, the chat delete path.
- **Tests.** Tool: binds by default from a chat; workspace mismatch refuses `true`; under 15 minutes refuses posting. Store: renderer and phone can't set the binding; updates keep it. Execution: the run appends a notice and runs with the task's MCP bindings; busy past the wait → `chat_busy` plus notice; over budget → `chat_budget`; deleted chat falls back and clears the binding; a script task's output lands as a notice. Remote PATCH keeps the binding. Lanes `test:scheduled`, `test:assistant-automations`.
- **Docs.** README, PRODUCT, plans index, one sentence in `docs/aiden-remote-api-v1.md` (the binding isn't projected). **Revision:** no. **Screenshots:** yes. **Size:** M–L.

### C5. Onboarding tile

The "Scheduled Automations" gallery tile shows a check-back chip and a result posted in a chat, with code-drawn art in `onboarding-art/` using the art kit, theme tokens and `oa-anim-*` classes. Extend the onboarding art test. **Screenshots:** yes. **Size:** S. **Waits on:** C2, C4.

## Phase 2: Keep going until it's done (7 PRs)

### How it works

- **Starting (answer 7a).** `/goal <objective>` (up to 2,000 characters) in the composer, or **Keep going until done…** in the + menu, which pre-fills ` /goal  `. The objective is sent as your message; main journals a hidden kickoff note after it. Bare `/goal` shows the goal and last reason; `/goal pause|resume|clear` work too. Any ordinary chat, including scratch chats, with or without folder access. Not Bots, the Assistant, agent-harness (ACP) chats, chats hosted on a paired Mac (v1), or chats another feature owns.
- **The loop.** After any run in the chat settles with nothing owed and no pending notice, wait 1.5 seconds and check the chat is still idle (your queued send wins). If the chat's own helper is still running, the review is skipped; the helper's report wakes the chat and the loop runs again then. Pre-checks pause the goal: Aiden restarted (boot id changed), you pressed Stop, the last answer failed, or 50 rounds reached.
- **Reviewer (answer 9a).** The chat's own model, sent as `sideCallContinuation` of the chat's last request (same tools, system prompt and thinking, reviewer text as the last user message), short cache retention, 400 output tokens, 60-second timeout. If the cached prefix is stale, fall back to the isolated tool-free projection in `advisor-context.ts`. Any tool call in the reply counts as no verdict; two unusable answers pause. Recorded as a new `UsageRequestSource` `"goal-review"` (`usage-store-core.ts`) and checked against the chat's spending limit before sending through `SpendingLedger` (`spending-core.ts`, `spending-main.ts`).
- **Verdicts.** `done` → Done. `blocked` → Needs you. `paused` → paused (your latest message asked to stop). `wait` → stay active, offered only while background jobs run (a running helper already skips the review). A 30-minute watchdog covers both jobs and helpers, then pauses the goal. `continue` → update the stall count; 3 stalls pause "Not making progress"; otherwise rounds + 1 and a continuation notice starts the next round.
- **Stalls.** A stall is the same reason as last round, or a round with no tool calls. One exception: a round with no tool calls that still wrote substantial new text is not a stall, so writing goals (a trip plan, a report) aren't paused for making progress in plain text.
- **Rounds.** Attended turns built like owed turns (`owedTurnStartRequest`), with a notice card "Keep going · round 3 of 50". Your approval mode applies exactly as for your own turns; the goal never raises access.
- **Writes** are compare-and-set on `{id, revision}`; your pause or clear always wins.
- **Prompts.** Objective wrapped in `<untrusted_objective>` and escaped. The reviewer judges on evidence (tool results, outputs, files, pages read), never on claims.
- **State.** `GoalRecord v1 { id, chatId, objective, status: active|paused|needs-you|done, rounds, maxRounds: 50, stalls, reason?, source, setAt, updatedAt, revision, boot, check? }` in follow-through `state.json` as optional `goals`. Deleting the chat drops it; forks don't inherit it; an active goal blocks a workspace move; a folder-access change pauses it.
- **Limits (answer 8).** 50 rounds. Keep going (or Resume) sets rounds back to 1 and stalls to 0, with the limit still 50, so the bar reads "round 3 of 50" again. 3 stalls. 30-minute wait limit. One goal per chat. Spending limit reached → paused; **Allow more** doesn't resume it, Keep going does.
- **Restart.** Goals come back paused. The reply's Resume button resumes only the reply; the goal has its own Resume.
- **Notifications.** One desktop notification when a goal settles (Done, Needs you, or paused by the system), only if no focused window shows the chat.
- **Cache.** Continuations extend the prefix; the reviewer reads cache and is never journaled; a reminder sits right after a compaction summary and stays byte-stable until the goal ends.

### A1. Goal core and prompts

Pure state machine (set, pause, resume, clear, settle → verdict, stalls, 50-round cap, boot pause, compare-and-set), prompt rendering and escaping, verdict parsing. New `main/services/goal/goal-core.ts`, `goal-prompts.ts`, `goal-verdict.ts`, `renderer/shared/goal.ts`. Tests: scenario tables over real transitions; an objective containing `</untrusted_objective>` can't escape; fenced JSON parses; `wait` refused with nothing running. New `test:goal` lane appended to `test:serial`, with its files assigned in `scripts/ci-test-registry.json` (root `test` runs `scripts/run-ci-tests.mjs`). Docs: plans row, `.memory/goal-loop.md`. **Revision:** no. **Screenshots:** no. **Size:** S–M.

### A2. Reviewer

`goal-reviewer.ts`: side-call continuation, isolated fallback, `"goal-review"` in `UsageRequestSource` (`usage-store-core.ts`), spending pre-check through `SpendingLedger` (`spending-core.ts`, `spending-main.ts`). Tests with `createPromptPrefixHarness`: the request extends the parent's bytes; no tool runs; falls back when the prefix is stale; refuses over the cap. Lanes `test:goal`, `test:compaction`. Docs: `docs/usage-limits-and-spending.md`. **Size:** M. **Waits on:** A1.

### A3. Main loop, rounds and IPC (switched off)

`goal-main.ts`, `goal-round-start.ts`, a hook in the `llm-client.ts` settle path (next to `owedTurns.settleAfter`), state persistence, IPC `chats:goal:get|set|pause|resume|clear` plus `chats:goal-changed`, notice source `"goal"`, the post-compaction reminder in `chat-frozen-state.ts`, and two analytics events: `goal_started {source: slash|menu|proposal|phone|until}` and `goal_settled {outcome, rounds}`. `rounds` uses a new goal-specific enum (1, 2-5, 6-10, 11-20, 21-49, 50) because the shared `COUNT_BUCKETS` stops at "11+" and can't show how often goals hit 50; the enum gets its registry entry, `docs/analytics.md` row and test. Behind `goalLoopEnabled()`. Tests: register-and-invoke IPC; loop with a fake reviewer (Stop, restart and failure pause; 50-round cap; Keep going resets to round 1 with stalls 0; a running helper skips the review; your send preempts a round); prefix-stability cases in `prompt-prefix-stability.test.ts`; analytics registry. Docs: `docs/analytics.md`. **Size:** L. **Waits on:** A2.

### A4. Desktop goal bar

`/goal` slash command, + menu item, `goal-bar.tsx` above the composer (beside the spending-limit notice; design-guide tokens and squircle buttons): "Working · round 3 of 50", "Needs you", "Done", with Pause, Resume, Keep going and Clear. Goal notice card; settle notification. Switch on. Tests: each state's actions and focus-visible; slash-command cases; a Playwright spec. Docs: new `docs/keep-going-goals.md`, README, PRODUCT. **Screenshots:** yes. **Size:** M. **Waits on:** A3.

### A5. Approvals, jobs and `/until` becomes a goal (answer 10)

- **Approvals.** 30-minute card lifetime for goal rounds: today `OWED_TURN_PROMPT_LIFETIME_MS` is a fixed 5-minute constant (`chat-owed-turn-prompts.ts` line 9), so A5 adds a per-turn lifetime that goal rounds (and later started chats) set to 30 minutes. An expired card denies that tool and the goal goes to Needs you. Approvals that only the owning window can grant today (`classify`, `generate_image`) are denied in windowless rounds; the round is told why, and A9's on-screen rounds can use them.
- **Helpers in rounds.** Goal rounds may run foreground helpers with read-only roles only and may not launch background helpers. Owed turns allow every subagent role today (`chat-owed-turn-start.ts` line 59), so A5 narrows that for goal rounds through the args-aware refusal from C2.
- **Jobs and notices.** `wait` with jobs and its watchdog. Job and PR notices route as goal rounds while a goal is active. Inbox Needs you row.
- **`/until`.** `/until <command>` becomes a goal with `check: {command}`: exit code 0 means done, no reviewer. A command goal keeps today's limit of 5 checks (`MAX_DONE_WHEN_CHECKS`) instead of 50 rounds, because each check is a full round of work plus a command; Keep going grants 5 more. Saved `/until` checks migrate into goals. One bar.
- **Tests.** Extend `done-when.test.ts` and `notice-delivery.test.ts`, plus goal-main cases: a card expiring after 30 minutes moves the goal to Needs you; a write-role helper is refused in a round; an `/until` goal stops after 5 checks. Docs: `docs/coding-follow-through.md`. **Screenshots:** yes. **Size:** M. **Waits on:** A4.

### A9. Browser and Computer Use in goal rounds (answer 11)

- **Today.** A goal round is windowless, like an owed turn: it runs with a headless owner (`id: 0`, `documentId: owed:…`, `llm-client.ts` around line 828), and window tools depend on a real window owner (`owner.id !== 0`, around lines 1385, 3966 and 4077), fixed when the turn starts. `chatTurnToolRefusal` therefore refuses Computer Use, hooks, browser, canvas, `form_fill`, `ask_user_question`, the to-do list and `advisor` in windowless turns (`chat-turn-tool-policy.ts` around line 137).
- **Change.** When a round is due and a focused desktop window shows that chat, main asks that window to start the round through its normal send path, so the round is an ordinary window-owned run with every tool, exactly as if you had typed the continuation. Window tools stay available for the whole round: Computer Use has to bring other apps' windows to the front to work (`computer-use/controller.ts` refuses with `window_not_key` otherwise), so Aiden losing focus mid-round is expected and is not checked. Focus and screen lock are checked only before the round starts.
- **Edge cases.** If the window closes, reloads or switches to another chat mid-round, that round stops and the goal pauses ("The chat was closed"). If no focused window shows the chat when a round is due, the round runs windowless as before; a window-only call is refused and the reviewer usually answers `blocked`. The goal bar then says "Open this chat to let Aiden use the browser" with **Continue here**, which starts the next round from that window.
- **Safety.** Computer Use keeps its own permission checks, approval mode and its existing refusal while the screen is locked. A goal never starts a window-owned round while the Mac is locked.
- **Files.** `goal-main.ts` (choose window-owned or windowless), a new renderer IPC to start a goal round in a window, the chat-pane send path, `goal-bar.tsx`.
- **Tests.** A due round with a focused window showing the chat starts through that window and is offered window tools; one without a window is windowless and refused them; the window closing mid-round pauses the goal; Continue here starts the next round from the window. Playwright spec, plus a run on the macOS host for the Computer Use path.
- **Docs.** `docs/keep-going-goals.md`, `docs/computer-use-integration.md`. **Screenshots:** yes. **Size:** M. **Waits on:** A5.

### A8. Aiden suggests a goal; onboarding tile

`propose_goal {objective}` shows a card "Keep going until: … \[Start\] \[Not now\]"; only your press starts it. The objective is one line of up to 300 characters, shown whole. In ordinary desktop chats it is declared for cache stability in every turn and refused at call time in goal rounds, unattended and other Aiden-started turns, and paired devices' turns; never declared for Bots, the Assistant or agent-harness chats. Feature gallery tile with code-drawn art. Tests: tool registration and refusal; onboarding art test. **Screenshots:** yes. **Size:** M. **Waits on:** A4.

## Phase 3: Background helpers (6 PRs)

### What comes first

The subagent panel plan you picked in its own thread lands first. Its PR 1 removes the 10-minute limits (`DEFAULT_SUBAGENT_TREE_DEADLINE_MS` and the child deadline), fixes the snapshot sanitizer and hands a stopped or failed helper's last message and changed files to the parent. Its PR 2 saves each helper's full conversation through the unused `appendSessionMessages` hook in `child-agent-runtime.ts`, and PRs 3 and 4 show it as a read-only helper chat. B1 starts after its PR 1 and 2. Whether unattended helpers keep a 60-minute limit is your open question in that thread; B follows that answer.

### How it works

- **Existing engine.** `background-lifecycle-v2.ts`, `background-subagent-coordinator-v2.ts` and the `backgroundRuns` store are built and tested but not called. `subagentBackgroundEnabled()` is a default-on rollback switch with no callers.
- **Gaps B1 closes.** The task is cut to 240 characters before the child sees it; there's no way for the report to come back; management needs the launching window's document id; background and foreground share one small concurrency gate; children are registered under the turn, so the turn ending would stop them; and a live child counts as the chat being busy (`chatHasGenerationOwnership` checks `hasLiveChatChildren`, `llm-client.ts` around line 862), so a background helper would block your sends, owed turns and notices until it ended.
- **Model contract.** One `subagent` tool gains `execution: "foreground" | "background"` and actions `status | stop | message`. Description: "background returns at once. Each helper's report arrives later as a message in this chat. Do not wait, poll or check on it, and do not repeat its work." Background is refused for Bots, the Assistant, agent-harness chats, chats without a folder, woken turns and goal rounds; those may still use `status` and `stop`. Today an unattended turn refuses the whole `subagent` tool by name (`chat-turn-tool-policy.ts` around line 181); B3 replaces that with C2's args-aware refusal so only launches are refused.
- **Limits (answer 12).** No per-chat or app-wide count of background helpers and no launches-per-hour cap. Background helpers are depth 1: built with no nested launcher and `maxDepth: 1`, so they get no `subagent` tool. Local-model chats run one helper at a time on the single local slot, foreground first. Spending limits refuse and the run fails "spending limit reached". Time limits follow the panel plan. Existing caps and what happens to each (B1):
  - `SubagentConcurrencyGate` `{hosted: 2, local: 1}` (`concurrency-gate.ts` line 21): background gets its own lane with no hosted cap; foreground keeps 2 hosted at once, unchanged.
  - `MAX_QUEUED_SUBAGENT_CHILDREN = 32` and `MAX_REGISTERED_SUBAGENT_CHILDREN = 32` (`concurrency-gate.ts` line 3, `child-agent-runtime.ts` line 45): kept as app-wide memory guards, well above normal use. Reaching them refuses a launch with a clear reason; it is not a choice limit.
  - `MAX_SUBAGENT_LAUNCHES_PER_GENERATION = 8` (`contracts.ts` line 13): kept per answer, so one answer starts at most 8; the next answer can start more.
  - Foreground helpers can nest two deep today (`MAX_SUBAGENT_TREE_DEPTH = 2`, child delegation on by default). That is outside this plan and stays as is; dropping foreground to depth 1 would be its own decision.
- **Results (answer 13a).** One notice per launch batch, source `subagent`, each report fenced as data and capped at 8,000 characters, naming any sibling still running. It joins a running answer, or wakes an idle chat within the 6-an-hour limit, or waits for your next message. A saved `delivered` mark means no double posts.
- **Stop (answer 1a).** Stop in a running answer also stops that chat's helpers and drops their queued notices. The pill offers Stop all when no answer is running.
- **Quit (answer 15a).** Helpers stop; cards say "Interrupted when Aiden quit" with **Run again**; one notice is saved without waking Aiden.
- **Files later (answer 14a).** B7: one approval at launch, a managed worktree per helper, writes confined to it, no shell.

### B1. Background runtime seam (hidden)

Close the six gaps: full task (up to 8,000 characters) kept in memory; report saved in the same compare-and-swap as the terminal state, then an `onTerminal` hook; chat-scoped management like `SubagentControlMainV2.stopForChat`; a separate background lane in `concurrency-gate.ts` with no hosted cap and the shared local slot (the memory guards above stay); background children built with no nested launcher and `maxDepth: 1`; background children excluded from `chatHasGenerationOwnership` and `hasLiveChatChildren`; children registered under the run, not the generation (`abortGeneration` doesn't stop them; `abortChat`, revocation, deletion and shutdown do). Construct the coordinator in main with startup reconciliation; shutdown runs in the existing 7-second subagents quit step. Files: `background-lifecycle-v2.ts`, `background-subagent-coordinator-v2.ts`, `concurrency-gate.ts`, `child-agent-runtime.ts`, `subagent-run-store-v2-core.ts`, `subagent-control-main.ts`, new `background-subagent-main.ts`, `main/index.ts`. Tests: full task reaches the child; a terminal event is never seen without its saved report; stop works after the window reloads; a generation ending doesn't stop a background child; a running background child doesn't make the chat busy; a background child gets no `subagent` tool; three hosted background children run at once while foreground stays at 2; restart yields `interrupted` with no relaunch. Lanes `test:subagents`, `test:subagents:phase7a`. **Size:** M. **Waits on:** panel plan PR 1 and 2.

### B2. Results come back to the chat

`subagent` notice source, batching per launch, `delivered` marks, the interrupted-at-quit notice with no wake, Stop and deletion cancel queued notices, a desktop notice card. Files: `agent-notices.ts`, `notice-delivery*.ts`, new `background-subagent-notices.ts`, the notice card. Tests: queued into a running turn; an idle chat woken once; a spent limit only records; no second post after restart; card render. Lanes `test:follow-through`, `test:serial`. Docs: `docs/coding-follow-through.md`. **Screenshots:** yes. **Size:** M. **Waits on:** B1.

### B3. Aiden can launch background helpers

`execution` parameter; `status`, `stop`, `message` actions; descriptions and prompt guidance; refusals; `subagent_launched` gains `execution: foreground|background`. Files: `subagent-tool.ts`, `contracts.ts`, `subagent-supervisor*.ts`, `subagent-foreground-persistence-v2.ts`, `subagent-tool-assembly.ts`, `chat-turn-tool-policy.ts`, `llm-client.ts`, `analytics-events.ts`. Tests: schema parse and refuse; background returns at once and the child outlives the turn; steering acknowledged at a safe point; a woken turn and a goal round refuse a background launch but allow `status` and `stop`; a helper gets no `subagent` tool; analytics registry. Docs: README, `docs/analytics.md`. **Size:** M. **Waits on:** B1, B2, C2 (args-aware refusal).

### B4. Desktop visibility across turns

The card's "Working in the background" state; the pill stays while helpers run between answers; a sidebar "working" dot; Stop cascade and Stop all; opening a finished helper uses the panel plan's read-only helper chat. Files: `subagent-composer-pill.tsx`, `subagent-chips.tsx`, the sidebar row, `chat-pane`. Update the onboarding gallery's existing "Native Subagents" tile (`onboarding-feature-gallery.tsx` around line 89) so its copy and code-drawn art show a helper working in the background. Tests: extend pill and chip tests; extend the onboarding art test; a Playwright run where a background helper survives the end of its turn (Cua Space and macOS host). **Screenshots:** yes. **Size:** M. **Waits on:** B3, panel plan PR 3.

### B6. Helper questions go to the chat

Child tool `ask_parent` (2 per run): the child waits at a safe point and the run moves to `needs_attention`; a question notice goes out at once and is dropped if the run settles first; the parent answers with `message`; no answer in 30 minutes → the child ends with a "blocked" report. Tests: a question wakes the parent once; an answer resumes the child; timeout gives a blocked report; Stop cancels the queued notice. **Screenshots:** yes. **Size:** S–M. **Waits on:** B2, B3.

### E1. Shared event core (runs alongside phase 3)

Refactor only. Widen `bot-routine-events/dispatcher.ts` and `watch.ts` from `botId` to an `ownerKey`, so chat tasks can reuse the Bot event machinery; Bots keep `ownerKey = botId`. Move `botRoutineEventBlock` framing into a shared `event-trigger-block.ts`. Oracle: existing `test:bot-proactive` and `test:bot-routine-models` unchanged, plus one dispatcher case with a non-Bot owner (gap, dedupe, replay). **Size:** M. **Waits on:** nothing.

## Phase 4: Smarter triggers (5 PRs)

### How it works

- `ScheduledTask` gains an optional main-validated `trigger`; no trigger means cron, so existing tasks and APIs don't change. Trigger tasks have no cron. Today an empty cron throws "A cron schedule is required." when a task loads, normalises or is enabled (`schedule-store-core.ts` around lines 76, 297, 465 and 748), so E2 makes `cron` optional whenever `trigger` is set in normalise, parse, `setEnabled` and next-run calculation.
- Kinds: `webhook` (filters, dedupe path, included fields, optional HMAC signature), `watch` (URL or project script, every 5–1440 minutes) and `connector` (iMCP Mail on Mac, Composio Calendar on Mac and Linux, every 15/30/60 minutes).
- Bookkeeping in `<userData>/scheduled-task-triggers.json` (token hash, seen ids, held batch, receipts, watch state, failure streak, delivery log). The HMAC secret is stored under `aiden-internal:task-hook:<taskId>` in `secrets.ts`. The agent and phones never see the link or secret.
- Runs land through C4's `deliverTaskRunToChat` (answer 2a), share its 6-task-runs-an-hour limit, and keep the task's own tool policy. Today a non-Bot run ignores `trigger` and always uses the task's prompt (`schedule-execution.ts` around line 394), so E2 routes event runs through C4. A check with no change runs no model.
- Limits per task: 5-minute gap (a link may choose 1–60), 48 runs a day, 4 running at once overall, receipts replayed after a restart. Three failed checks pause the trigger with one card; three failed runs in a row pause any chat task.
- Missed cron (answer 18a): catch up once only if under 12 hours late, else record `skipped` and wait for the next slot.
- Triggers never hold keep-awake. Scheduled runs never get the `schedule` tool (`scheduledGenerationToolPolicy` puts it in `excludeToolNames`, so `schedulingAllowed` is false) and never get `child_chats`, so a run can't create triggers or chats.
- Until E6, trigger tasks are hidden from phones: the Remote list, runs feed, save, pause, resume and run-now skip them, the way Bot routines are hidden, because today phones receive every task as `schedule: task.cron` and send the cron back on save.

### E2. Watch triggers (desktop)

- **Change.** `trigger` type and validation in `schedule-store-core.ts`; new `scheduled-task-triggers-store.ts` and `scheduled-task-triggers-main.ts`; `schedule-service-core.ts` skips cron for trigger tasks; `schedule-execution.ts` accepts `{kind: "event"}` for chat tasks and hands the framed payload to C4's `deliverTaskRunToChat`; `cron` becomes optional when `trigger` is set; trigger tasks are hidden from the Remote schedule routes.
- **Script checks** get an optional private state file (`AIDEN_CHECK_STATE`, up to 8 KB) and `AIDEN_CHECK_RUNS`; empty output means nothing to report.
- **Editor** gains a **When** control (On a schedule / When something changes).
- **Tests.** Store round-trip and rejection; a trigger task with no cron loads, saves and enables without "Needs attention"; a router test shows phones never receive trigger tasks or their runs; a change produces one run with the framed diff; no change runs no model; three failures pause with one card; empty script output stays quiet; the state file persists and is capped. Lanes `test:scheduled`, `test:assistant-automations`, `test:bot-proactive`.
- **Docs.** New `docs/scheduled-task-triggers.md`, README, PRODUCT, plans index. **Screenshots:** yes. **Size:** L. **Waits on:** E1, C4.

### E3. Link triggers (answers 16a, 17a)

- **Route.** `/hooks/tasks/:token` on the Remote listener (on only while Aiden On The Go is on; Tailscale first, then LAN), separate from Bot hooks, with a new `taskTriggerWebhook` dependency on `AidenRemoteService` next to `botRoutineWebhook` (`aiden-remote-service-main.ts` around line 550).
- **Order of checks.** Wrong method → 405; unknown or disabled token → 404, before the body is read; 60 calls a minute → 429; content type other than JSON or text → 415; body over 256 KB → 413; optional HMAC with constant-time compare; filters; dedupe. Unlike the Bot path, which passes only `content-type` to its handler (`aiden-remote-router.ts` around line 2539), the router passes the configured signature header through.
- **Bursts.** Calls inside the gap are batched, up to 20, oldest dropped beyond with a "N more calls were dropped" line. Delivery log of the last 50 with outcome and a 2 KB redacted preview.
- **What the model sees.** Only the included fields, or the body cut to 4,000 characters, with credential-looking headers redacted. Copy link (once) and Rotate on the desktop.
- **Tests.** Router register-and-invoke (405, 404 before the body is read, 429, 415, 413, 202); good and bad `sha256=` signatures; filter miss; duplicate id; queue full at 21; log keeps 50; redaction; the link never appears in tool results. Lanes `test:aiden-remote`, `test:scheduled`.
- **Docs.** `docs/aiden-on-the-go-remote-access.md`, the trigger guide. **Revision:** no (not part of the paired-device contract). **Screenshots:** yes. **Size:** M. **Waits on:** E2.

### E4. Aiden can propose triggers

`trigger` parameter on the `schedule` tool's `create`, canonicalised and summarised; the approval card shows the trigger label; Assistant tasks may use links and URL watches only; one prompt line. Result is `{task, status, link: "person_creates_in_task_details"}`. Tests: the trigger survives approval unchanged; Assistant rejects script watches; the summary names the trigger; a scheduled run has no `schedule` tool. Lanes `test:scheduled`, `test:assistant-automations`. Docs: the trigger guide. **Screenshots:** yes. **Size:** S–M. **Waits on:** E2, E3.

### E5. Failure pause and the 12-hour rule (answer 18a)

For chat tasks only (no `botId`); Bot routines keep their documented 7-day catch-up window (`docs/bot-routines.md`). Three failed runs in a row pause any chat task with one card in its landing chat. The 12-hour rule applies to every automatic fire whose time is more than 12 hours ago, both in the startup catch-up loop (`schedule-service-core.ts` around line 679, where today an overdue task always runs once) and in `dispatch` (around line 367), which today runs any due fire, including one that arrives late after sleep. Such a fire is recorded `skipped` and the task waits for its next slot. Tests: overdue under 12 hours runs once; over 12 hours records skipped, at startup and after sleep; a Bot routine still catches up within 7 days; three failures pause with one card. Lanes `test:scheduled`, `test:follow-through`. Docs: README, PRODUCT, and the trigger guide if E2 has landed. **Screenshots:** yes. **Size:** M. **Waits on:** C4.

### E7. When a connected app has news

Polling with the Bot connector adapters, authority from the task's exact bindings plus a foreground **Find sources** step you do in the editor; background checks never connect, sign in or reconnect. First check records a baseline. Connector checks report as `watch` in the existing `scheduled_task_ran` analytics, so no new event value. Tests: revoked binding pauses; drift refuses; first check is a baseline; no background connects. Lanes `test:bot-proactive`, `test:scheduled`. Docs: trigger guide, `docs/composio.md`. **Screenshots:** yes. **Size:** L. **Waits on:** E2.

## Phase 5: Chats that run other chats (7 PRs)

### How it works

- **Tool `child_chats`** with one action per call: `start` (`chats: [{title, task, workspace?: same|new_worktree, base_ref?, branch_name?, model?, result_schema?}]`), `send` (`auto|queue|steer`, refused if you've typed in that chat since the lead's last message), `wait` (up to 8 chats, up to 600 seconds, `any|all`; a timeout never cancels), `read` (up to 20 messages, each capped at 20,000 characters, fenced), `list`, `stop`. The lead reaches only chats it started.
- **`submit_result`** in started chats, checked with ajv against the stored schema (16 KB schema cap, no remote `$ref`), newest accepted value kept.
- **Lineage.** `ChatMeta.startedBy {version: 1, kind: "chat", chatId, at}`, parsed strictly like `forkedFrom`. A local `chat-orchestration.json` (mode 0600) holds per-child links, the permission ceiling, the person-took-over marker, owed results and delivery dedupe.
- **Runs.** Started chats run through `AidenRemoteChatService` and `AidenRemoteStreamService` under an internal audience `chat:<leadChatId>`: windowless runs whose approvals go to you on the desktop card, Inbox Needs you and phones. The audience has no device record and can't be reached over HTTP. D2 special-cases `chat:` ids in `deviceReportsAnalytics` (today any id without a device record counts as reporting, `aiden-remote-service-main.ts` around line 713) so they send no device analytics, and sets both the approval and question lifetimes (`APPROVAL_LIFETIME_MS` and `QUESTION_LIFETIME_MS`, 5 minutes each in `aiden-remote-streams.ts`) to 30 minutes for this audience (answer 22a).
- **Limits (answer 20).** No count caps. The MCP runner's own limits (10 turns a minute, 2 runs at once, 8 unanswered turns per app and 32 across apps, in `aiden-mcp-tools.ts`) stay with outside apps and don't apply to started chats. The stream service's structural cap of 256 kept stream records stays as a memory guard. Depth 1: a chat with `startedBy` gets no `child_chats`. Ask mode shows a card before each `start`; Auto lets the judge decide. Each new worktree needs free disk space (existing admission). Every child turn passes the spending-limit check.
- **Permission ceiling,** applied both where `generationApprovalPolicy` sets a turn's policy and where each later decision rereads the workspace's current approval (`run-approval.ts` around lines 40 and 79), so a mode change mid-turn can't get around it: the stricter approval mode (Ask < Auto < Never ask), intersected Mac grants, the narrower folder access. A child can only use the lead's workspace or a new worktree of it.
- **Approval classes.** `start` is Consequential; `send`, `stop`, `list`, `read`, `wait` on your own children are Exempt. Every `child_chats` result is a taint source, because `bringsOutsideContent` decides by tool name only (`tool-classes.ts` around line 68); that is stricter than needed for `start`, `list` and `stop`, and simpler than making taint depend on the action. (Changed in the final review: only a `wait`, `read` or `list` result that returns the words of a started chat whose run held outside content taints, marked by `details.outside` on the result; see [chats that run chats](../chats-that-run-chats.md).)
- **Woken leads (answer 21a).** A woken lead may list, read, wait, send and stop; `start` is refused ("Starting chats needs the person here").
- **Stop (answer 1a).** Stop in the lead stops its turn and every child's current turn except chats you've typed in, and suppresses lead wakes until you next send. Stop in a child stops only that child.
- **Wakes.** A child reaching done, failed or interrupted posts a `chat` notice to the lead; children finishing within 10 seconds are grouped; a child already returned by an active `wait` isn't notified again; approval waits never wake the lead.
- **After a quit.** Nothing resumes; children show Interrupted with Resume.
- **On by default (answer 23a).** Switch **Chats can start other chats** in Settings → Approvals → Advanced.

### D1. Extract the chat-run core from the MCP runner

Move run snapshot, wait loop, owned-run tracking and request dedupe from `AidenMcpToolRunner` into `chat-orchestration/run-core.ts`, no behaviour change. run-core takes no limits: `admitTurn` and the pending caps stay in `AidenMcpToolRunner`. Tests: existing `aiden-mcp-server.test.ts` green, new `run-core.test.ts` (terminal state answers the wait; timeout leaves the run running; abort; more than 2 runs at once through run-core). Lane `test:aiden-remote`. **Size:** S–M.

### D2. Lineage, link store, internal audience and ceiling (hidden)

`ChatMeta.startedBy` and parser; `chat-orchestration/links.ts`; the `chat:` audience in `aiden-remote-chats.ts` and `aiden-remote-streams.ts` with 30-minute approval and question lifetimes; `deviceReportsAnalytics` returns false for it; the ceiling in both places in `approval-gate/run-approval.ts`. Tests: a child in a Never-ask worktree under an Ask lead asks; a mode change mid-turn still respects the ceiling; grants intersect; a `chat:` audience reports no analytics; link-store resilience; router refuses a `chat:` audience over HTTP; a corrupt `startedBy` is dropped. **Size:** M. **Waits on:** D1, Fix.

### D3. `child_chats` in the same workspace, with its Settings switch

- **Change.** Offered in `llm-client.ts` for workspace chats passing the `followThroughAvailable` checks and not started by a chat; gate classes and taint in `tool-classes.ts`; depth 1; the took-over rule; fencing; Stop suppressing wakes; the Settings switch.
- **No double starts.** Idempotency keys `agent-chat:<leadChatId>:<key>:<index>`, so a Resume replay never starts a second chat. Workspace chats have no durable tool-call memo today (only the Bot runtime has `call.memo`), so D3 first checks whether a Resume replay reuses the journaled tool-call id. If it does, that id is the key; if not, D3 adds a small durable memo store for `child_chats` calls modelled on the Bot one.
- **Tests.** Depth; ceiling refusal; replay creates nothing new; send modes; send refused after you type; start refused when woken; replies fenced; more than 3 children run at once. New `test:chat-orchestration`.
- **Docs.** New `docs/chats-that-run-chats.md`, README, PRODUCT, `docs/settings-design-system.md`. **Screenshots:** yes. **Size:** L. **Waits on:** D2.

### D4. Completion wakes and the Stop cascade

`"chat"` notice source, `completion-delivery.ts` over `NoticeDelivery`, grouping, dedupe with `wait`, Stop all. Adds `"chat"` to `AGENT_NOTICE_SOURCES` and the notice card. Tests: queued into a running lead; wakes an idle lead; over the limit only records; approval wait never wakes; grouping within 10 seconds; Stop skips a chat you took over. **Revision:** no: phones receive each notice as one line of text (`aiden-remote-chats.ts` around line 803), not its source. **Screenshots:** yes. **Size:** M. **Waits on:** D3.

### D5. Children in new worktrees

`workspace: "new_worktree"`, `base_ref`, `branch_name`, extending `createAidenRemoteNewWorktrees.create` with an optional base and a key passed in (today it is fixed to `phone-chat:<chatId>`). Today `create` refuses when the source is already a worktree ("This chat is already in a worktree."); for a lead in a managed worktree, D5 resolves the worktree's source workspace and uses the lead's branch as the base. Tests: key reuse; base honoured; a lead in a worktree stacks from its branch; refusal sentences; free-space refusal. **Size:** M. **Waits on:** D3, Fix.

### D6. Structured results

`result_schema` and `submit_result`, ajv validation, stored on the link. Tests: accept; reject naming the field; newest value wins; a send with a schema is queued, not steered; `wait` returns `result`; a schema that won't compile is refused before anything is created. **Size:** M. **Waits on:** D3.

### D7. Desktop UI and onboarding

- **Lineage.** A "Started by “Release prep”" header line and sidebar glyph, following the fork-lineage pattern. Outside apps' chats already show "Started by \<app>" from `aiden-mcp-chat-provenance.json`. The two can't both apply, because started chats are created inside Aiden; if a record somehow has both, the chat lineage wins.
- **Lead chat.** A "3 chats working" chip and list with Open, Stop and Stop all.
- **Messages.** A "From “Release prep”" label on messages the lead sent.
- **Onboarding.** A gallery tile with code-drawn art.
- **Tests.** Chip and label rendering; onboarding art test; Playwright `chats-that-run-chats.spec.ts` with a fake provider (start, child approval in Needs you, finish wakes the lead, Stop all) in a Cua Space. **Screenshots:** yes. **Size:** L. **Waits on:** D4, D6.

## Phase 6: Later (13 PRs)

Phones, the headless server and the switched-off experiments wait until the desktop shape has settled.

| # | What | Revision | Waits on |
| --- | --- | --- | --- |
| A6 | Phones set, pause and clear goals (capability `chat:goal`, routes, feed event, iOS and Android bars) | Yes | A5 |
| A7 | Goals on `aiden serve` (isolated reviewer until serve records the last request) | No | A6 |
| B5 | Phones see and stop background helpers (roster includes them, `execution` field, interrupt accepts them) | Yes | B3 |
| B7 | Helpers that edit files in their own worktree, one approval at launch, no shell | No | B4, B6, Fix |
| B8 | Packaged soak test and wrap-up | No | B7 |
| C6 | One-time schedules up to a year ahead; phones can't edit them into a yearly cron | Yes | C4 |
| C7 | Phones list and cancel check-backs and show "Posts in this chat" | Yes | C2, C4 |
| C8 | Keep awake for `aiden serve` (`systemd-inhibit` or `caffeinate`, 60-second grace) | No | C1 |
| D8 | Phones show Started by and From labels | Yes | D7 |
| D9 | `child_chats` on `aiden serve` (makes `ajv`, already in the CLI lockfile, a direct pinned dependency) | No | D6 |
| E6 | Phones list trigger tasks, Pause, Resume, Run now, Recent calls (token `chat-task-triggers-v1`) | Yes | E3 |
| E8 | MCP push-events spike, switched off, written decision only | No | E7 |
| E9 | No-AI code checks, read-only, switched off (answer 19a) | Maybe | E2, E7 |

## Risks

- **Cost with no count limits (answers 12 and 20).** Mitigations: depth 1, woken turns can't launch helpers or start chats, the chat spending limit on every request, Ask-mode cards before each chat start, and Stop ending everything. If real use shows runaway fan-out, a soft per-chat warning can be added without a new decision.
- **Provider rate limits** when many helpers run at once on one hosted model: existing retry and usage-limit waits handle them. Attended helpers have no time limit after the panel plan; if you pick its 60-minute limit for unattended helpers, a usage-limit wait counts toward those 60 minutes.
- **A goal judged done too early or never.** The reviewer judges evidence only and is told "when in doubt, continue"; 50 rounds and 3 stalls bound it; `/until` gives a deterministic check.
- **Prompt injection** through objectives, webhook bodies, diffs and child replies: all fenced as data; reviewers have no tools; no templating into instructions.
- **Computer Use in goals (A9).** A window-owned round starts only while the chat is focused on screen and the Mac is unlocked; existing Computer Use permissions, approval mode and lock-screen refusal apply.
- **Linux keep-awake** is best-effort and documented as such.
- **Downgrades.** An older build forgets pending check-backs and goals on its next save, and disables trigger tasks ("Needs attention", because they have no cron) and drops their trigger on its next save. Both go in the release notes.
- **Remote revision collisions.** Six phone PRs (A6, B5, C6, C7, D8, E6), plus E9 if it turns out to need one; each claims the next free number at merge and rechecks after every `main` merge.
