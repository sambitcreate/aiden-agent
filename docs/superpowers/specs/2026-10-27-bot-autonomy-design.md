# Bots that heal, act and learn on their own

- Status: Design draft, 2026-10-27. The owner approved all 14 ideas and answered D2, D4 and D5 (all as recommended) on 2026-10-27. D1, D3 and D6 follow the recommendation unless the owner says otherwise. The plans are awaiting the owner's review before execution.
- Surfaces: Electron main and renderer, Aiden On The Go iOS and Android, Telegram, and the CLI's Bot host where it shares main-process code.
- Plans:
  - [A: self-healing](../plans/2026-10-27-bot-autonomy-a-healing.md)
  - [B: proactive](../plans/2026-10-27-bot-autonomy-b-proactive.md)
  - [C: self-improving](../plans/2026-10-27-bot-autonomy-c-learning.md)
- Builds on: [Bot memory, soul and proactivity](2026-10-09-bot-memory-soul-proactivity-design.md) (§10 review, §11 routines and proposals, §13 network posture), [Bot hand-offs, rules, pause and computers](../../plans/bot-handoffs-rules-computers-plan.md), [Agent loop resilience](../../plans/agent-loop-resilience-plan.md), [Harness quality upgrade](../../plans/aiden-harness-quality-upgrade-plan.md) (H5a lesson vocabulary).
- References: Harness² at `1cfe254e8d25b15f37048c3730134686abe60335` (`harness2/core/prompts.py:1105-1147` reflection, `core/runmark.py:41-61` fingerprints, `core/tree.py:267-334` skill checks, `core/prompts.py:129-146` cheapest-form ladder). Hermes Agent `background_review.py` (already adapted in `main/services/bot-memory/review.ts`).

## 1. Intent

A Bot should keep working without the person babysitting it. It should notice when it is about to break and fix itself, or ask once, clearly. It should show up when something happens, not only on the clock. And it should get a little better at the person's recurring jobs over time, in ways the person can see and undo.

Success means:

1. A routine that is going to fail because of a sign-in or a changed model is caught before its fire, and the person gets one card with one fix.
2. A routine never fails silently day after day. After three failures in a row of the same kind it pauses itself and says so once.
3. A Bot can wake up on a file change, a webhook, a new email or an upcoming calendar event, using only access the person granted.
4. Proactive messages respect the person's quiet hours and a daily limit.
5. A Bot that runs the same routine repeatedly writes at most one evidence-backed lesson at a time, and the person approves it before it changes behavior.
6. Everything a Bot learns (lessons, skills, memory tidying, corrections) appears on one page with Undo.

Keep the Bots "mom-friendly" (owner memory `bots-rework-2026-10`): no new settings that must be configured, minimal copy, progressive disclosure, everything visible and erasable.

## 2. The 14 approved items

| ID | Item | Plan |
|---|---|---|
| S1 | Check each routine's needs about 30 minutes before it fires; repair what is safe, otherwise one hand-off-style card | A |
| S2 | Classify routine failures; retry temporary ones; after 3 same-kind failures in a row, pause the routine and tell the person once | A |
| S3 | One health status per Bot: OK, Needs you, Paused | A |
| S4 | Detect stuck runs and resume or ask | A |
| S5 | Run the false-success claim check on Bot replies and routine results | A |
| P1 | Event triggers: file change in the Bot's folder, inbound webhook, new email, calendar event soon | B |
| P2 | Follow up on dated promises the Bot made | B |
| P3 | Learn from accepted and declined routine proposals | B |
| P4 | Quiet hours and a daily cap on proactive messages | B |
| L1 | Review a routine's past runs and propose one lesson for its playbook | C |
| L2 | Bots propose skills; the person approves a diff | C |
| L3 | Learn from corrections | C |
| L4 | Tidy memory when it nears its limits | C |
| L5 | Behavior fingerprint and a learning history with Undo | C |

## 3. Decisions for the owner

Each row carries a recommendation. The plans are written to the recommendation, and each plan names the tasks a different answer changes.

Owner answers, 2026-10-27:

- D2: allow, as a visible watch.
- D4: 22:00–07:00 and 5 per day.
- D5: lessons and skills need a card.
- D1, D3 and D6 were not asked separately. They follow the recommendation.

| # | Question | Recommendation | Why it needs the owner |
|---|---|---|---|
| D1 | May the pre-fire check (S1) make network calls (refresh an OAuth token, connect the Bot's MCP servers) up to 30 minutes before a fire? | Yes. The calls serve an existing routine trigger, which spec §13 of the memory/proactivity design already allows, and they would happen at fire time anyway. | §13 reads "no new network call … in the background without an existing Bot turn or routine trigger". The check is earlier than the trigger. |
| D2 | May email and calendar triggers (P1) poll the Bot's granted connector in the background? | Yes, as a visible, person-created watch: no model call per poll, at most every 15 minutes, only while the Mac is awake and Bots are open, read-only tools only. Built only after a spike confirms deterministic connector tools exist (Plan B Task 8). | It amends §11.5 "There is no hidden heartbeat." The watch is visible on the routine row, so it is not hidden, but it is a heartbeat. |
| D3 | Where may webhooks arrive? | Only on Aiden Remote's existing LAN and Tailscale listeners, at an unguessable per-routine URL. No public relay. | A public endpoint needs a relay service and a new trust model, which the Telegram plan deliberately avoided. |
| D4 | Default interruption settings (P4) | Quiet hours on, 22:00–07:00 in the Mac's time zone. At most 5 proactive notifications per Bot per day. Health cards ignore the cap but wait out quiet hours. | Defaults decide how chatty every existing Bot becomes. |
| D5 | Which learning needs an approval card? | Reflection lessons (L1) and skills (L2): a card. Corrections (L3) and memory tidying (L4): applied at once with a "· Undo" line, because the person already said it or the change only shrinks memory. | It trades interruptions against control. |
| D6 | Spend on background learning (review, reflection, tidy, corrections) | At most 12 model requests and 24,000 output tokens per Bot per local day, shared by all learning jobs. | No per-Bot spend accounting exists today. Request and token caps work for subscription providers where dollar cost is unknown. |

## 4. Shared foundations

These are built once in Plan A and reused by B and C.

### 4.1 Failure kinds on run records (F1)

Today a failed Bot turn reaches `ScheduledRun.error` as Pi's bare reason code, usually `"model_error"`. The provider's message is dropped at `main/services/bot-runtime/bot-session-service.ts:577`, where `settledOutcome` reads `settled.reason` and ignores `detail`.

Every failed or doubtful run gets a `failure: BotRoutineFailure` with a kind:

| Kind | Source | Person-facing meaning |
|---|---|---|
| `temporary` | provider failure `network`, `timeout`, `service_unavailable`, `rate_limit`, `interrupted` | It will probably pass on its own |
| `sign_in` | provider failure `authentication` | Someone must sign in again |
| `access_changed` | Bot authority `model_changed`, `capability_changed`, `access_unavailable`, `provider_mismatch`, `managed_home_changed` | The Bot's model or access settings need a look |
| `model_setup` | session `needs_model`, provider failure `quota` | The Bot has no usable AI model or the account is out of quota |
| `tool_error` | the claim check (S5) flagged a success claim over a failed step | A step did not work although the reply says it did |
| `stalled` | the watchdog (S4) stopped the run | The run stopped making progress |
| `other` | anything else | Something went wrong |

The classifier reuses `providerFailureFromLegacyPiMessage` (`main/services/provider-failure.ts:142`) on the recovered detail, and `BotRuntimeAuthorityFailure` classifications (`main/services/bot-runtime-authority.ts:47`).

### 4.2 Bot issues (F2)

Hand-off cards can only be opened from inside a live tool call (`main/services/bot-runtime/bot-handoffs.ts`), so the host cannot use them to tell a person that a routine needs a sign-in. Add a host-owned **Bot issue**: a small, deduplicated "Needs you" item with at most one action.

- **Storage:** per Bot, in `<profile>/bots/<dir>/issues.json`. Open issues are deduplicated by a stable key, for example `preflight:provider_auth`. At most 8 are open per Bot, and the 50 newest resolved issues are kept.
- **In the Bot's chat:** a card, written as a conversation entry `aiden.bot-issue` through `runtime.appendEntry`, a commit with no submission. Resolving it appends `aiden.bot-issue-status`. This is the same pattern as routine proposals.
- **Other surfaces:** the desktop sidebar's "Needs you" state, a Mac notification when no Aiden window is focused, Telegram when the Bot is bound, and the phones' Bot feed (§4.3).
- **Name clash:** "Bot attention" is already taken by the hand-off wiring (`wireBotAttention`), so this item is named "issue" throughout.

### 4.3 One delivery funnel (F4)

Routine results reach the Mac (`notifyBotRoutine`), Telegram (`deliverBotRoutineResult`) and phones. The phone path is a pull feed projected directly from `schedule-runs.json` (`main/services/bot-routine-notifications.ts`).

Replace the three branches with one funnel. It writes a per-Bot delivery log, `<profile>/bots/<dir>/deliveries.json`, then sends to the Mac and Telegram. Each row in the log records its class (`routine_result`, `issue`, `proposal`, `digest`) and a `deliverAfter` time, and the phone feed reads only rows that are due.

The funnel is the single place where quiet hours and the daily cap (P4) apply. Following the repo's pre-1.0 rule, the phone feed switches to the log with no migration.

### 4.4 Behavior fingerprint (L5, used by S and L)

`botBehaviorFingerprint` is a full SHA-256 hash over the inputs that shape a Bot's behavior:

- the Bot record's revision (persona and instructions);
- the rules revision;
- the memory revision;
- a hash of the active lessons;
- the admitted skills' content fingerprints;
- the sorted tool names;
- the app version.

Every routine run records it, and every learning change records it before and after. A reflection can then tell "the setup changed between these runs", which is the Harness² `confounded` case, and Undo can check it is reverting the state it saw. This is Harness² `runmark.fingerprint` (`core/runmark.py:41-61`), minus its 16-character truncation.

## 5. Self-healing (Plan A)

### S1 Pre-fire check

About 30 minutes before each enabled routine's next fire (`BOT_ROUTINE_PREFLIGHT_LEAD_MS`), the host runs that Bot's health checks once for that fire. The checks are cheapest first, and the first two have no network:

1. Session state: paused, `needs_model` or `unavailable`.
2. Model binding drift, through `botProviderModelDrift`. When only the model fingerprint is stale, the binding is repaired through the same path `BotCapabilityStore.admit` uses today, `refreshStaleModelBindings`.
3. Provider credential, through `preflightBotModelAuth`. This may refresh an OAuth token, which is the point (D1).
4. Granted connections, through `resolveBotMcpInventory`, which has a 10-second deadline and a 60-second cache. A server reported as degraded becomes `needs_you`.
5. The Bot computer, through store reads only (`computer(botId)`, `baseReady()`). The check never boots, clones or downloads anything (AGENTS.md Bot-computer rules).

The Bot browser's sign-in state cannot be checked; nothing probes it (§9).

A check that ends `needs_you` raises an issue with a fitting action, for example "Sign in to ChatGPT again" opening provider settings, or "Gmail needs reconnecting" opening the Bot's connections. A later check that passes resolves it. The last report is kept per Bot so S3 can show it.

### S2 Failure handling

- **Retries.** A `temporary` or `stalled` failure schedules up to two retries of the same fire, 5 and then 20 minutes later. A retry is skipped when the routine's next regular fire would come sooner. Retries are persisted on the task (`pendingRoutineRetries`) and replayed at startup, like `pendingRoutineFires`.
- **Immediate issue.** A `sign_in`, `access_changed` or `model_setup` failure raises an issue right away. It does not wait for three failures.
- **Counting.** Failures are counted per fire. A fire failed when its last attempt failed, and its kind is that attempt's kind. A success ends the streak, while skipped, silent and blocked runs do not count either way.
- **Pause.** After three failed fires in a row of the same kind, the routine is paused through `BotRoutineService.pause`. One issue says so ("Paused 'Morning briefing' after 3 failed tries. Gmail needs signing in again."), with Resume as its action. Resuming resolves the issue and resets the streak.

### S3 Health status

The pure function `botHealthStatus` combines the Bot's pause state, its session state, its open issues and its last check report into `ok`, `needs_you` or `paused`.

- **Desktop:** a status dot on the sidebar row, and a Health group on the Bot profile listing the last check results, with "Check now".
- **Phones:** the existing Remote `health: ready | degraded | unavailable` stays. The summary gains `issueCount`, gated behind the capability `bot:issues`.
- **Copy:** "Needs you" is the only label shown unprompted.

### S4 Stuck runs

The Bot session service records a progress time per running Bot, updated from live frames and entry commits. A watchdog checks every minute:

- **Not stuck:** while the run waits on the person (a hand-off, an approval, a question card or a computer give-back), it is never treated as stuck.
- **Unattended runs** (routines): stopped after 10 minutes without progress (`BOT_RUN_STALL_MS`), recorded as a `stalled` failure, then retried through S2. The retry runs in the same conversation, so it sees the earlier partial work.
- **Attended runs** (desktop, phone, Telegram): never stopped automatically. The person gets an issue with two actions: "Stop" and "Keep waiting". Keep waiting snoozes the check for another 10 minutes.

### S5 Claim check for Bots

The repo already has a check that flags a reply claiming success when a matching step failed, was blocked or was cancelled (`renderer/shared/claim-check.ts`). Only regular chats use it today. Bot transcripts are Pi Durable entries, so the Bot version builds the check's timeline from those entries for the run's request id.

- **Routine results:** a flagged result keeps `result: "success"`, records `claimCheck` and `failure: {kind: "tool_error"}`, and adds one fixed line to the delivered text: "One step didn't work: {step}. Check the chat."
- **Attended Bot replies:** they get the same "couldn't confirm" chip regular chats show.
- **Phones:** they show the extra line in routine results. Showing the chip on attended replies is left for later (§9).

## 6. Proactive (Plan B)

### P1 Event triggers

A Bot routine has exactly one of `routineSchedule` (time) or `routineTrigger` (event):

| Trigger | Fires when | Network |
|---|---|---|
| `file_change` | Files change in a folder inside the Bot's home. Changes are coalesced over 30 s and the payload lists the changed paths. | None |
| `webhook` | `POST` reaches `/hooks/bot-routines/:token` on Aiden Remote's LAN or Tailscale listener. The token is 32 random bytes; only its hash is stored, and the URL is shown once. | Inbound only (D3) |
| `new_email` | A poll of the Bot's granted mail connector finds new items matching a filter | Poll every 15, 30 or 60 min (D2) |
| `calendar_soon` | A poll of the Bot's granted calendar connector finds an event starting within 10, 30 or 60 minutes | Poll every 15 or 30 min (D2) |

Every event goes through one dispatcher:

- **Limits:** at least 5 minutes between runs of a routine, at most 24 event runs per routine per day, a payload of at most 4,000 characters, and duplicate event ids dropped.
- **Payload:** rendered as an untrusted-data block before the routine's prompt.
- **Mutating tools:** event runs are unattended, so mutating MCP calls stay blocked, as on any routine run (`bot-tool-assembly.ts:10-16`).
- **Older phones:** their decoders throw on an unknown schedule kind (`ios/AidenOnTheGo/Models/AidenBotRoutine.swift:100-127`). Event routines are sent to them with `schedule: null`. Clients that negotiate `bot:routine-triggers` also get `trigger`.

### P2 Follow-ups on promises

The memory review (`main/services/bot-memory/review.ts`) gets one more add-only tool, `note_follow_up`. It records a dated promise the Bot made in a person turn ("I'll check on the invoice Friday"). The due date must fall between tomorrow and 60 days ahead.

- **Turning a promise into a proposal:** main-process code proposes a one-time routine through `botRoutineProposals.propose`, which works without a model tool call. It runs at the due date, at the promised time or else 09:00, with the reason "You asked me to follow up on …".
- **Limits:** the existing limit of two pending proposals still holds, so extra promises wait their turn. A promise whose date passes without a proposal being accepted expires.
- **Year boundary:** `once` routines are currently rejected outside the current year (`schedule-store-core.ts`). That rule widens to "within the next 366 days", so a promise made in December can land in January.

### P3 Learning from proposals

- **Why the person declined:** "Not now" on a proposal card offers four optional chips: Not useful, Wrong time, Already have this, Something else. Picking nothing is fine.
- **The Bot sees past decisions:** the `routines` tool's `list` action returns the 10 most recent decisions with their reasons.
- **The Bot backs off:**
  - `propose` refuses with `cooling_off` for 7 days after three of the last five proposals were dismissed.
  - It refuses with `declined_before` when a proposal has the same normalized name as one dismissed in the last 30 days.
- **Phones:** they send the reason only when they negotiate `bot:proposal-reasons`.

### P4 Quiet hours and a daily cap

The Bot record gets an `interruptions` setting (D4 defaults). It is edited on a new "Interruptions" page under the Bot's Advanced settings, which follows the settings design system.

| Delivery class | During quiet hours | Over the daily cap |
|---|---|---|
| Routine result, proposal | Held, then sent as one digest per Bot when quiet hours end | Not notified, but still in the chat. The first held item adds one "More updates are in the chat" notification. |
| Issue | Held until quiet hours end | Sent (the cap does not apply) |
| The person's own conversation (replies to their messages, Telegram replies) | Sent | Sent |

## 7. Self-improving (Plan C)

### L0 Close the self-written skill gap (prerequisite)

A Full-access Bot can write `<home>/.aiden/skills/<name>/SKILL.md` with its own file tools today, and that skill is admitted automatically (`bot-runtime-authority.ts:383-385`). From now on:

- **Admission needs approval.** A skill sourced from the Bot's home is admitted only when its content fingerprint is in the Bot's `skill-approvals.json`.
- **New or changed home skills ask first.** An unapproved one, including one the person dropped in through Finder, becomes a skill-review card ("Use this skill?").
- **File tools are refused.** Their writes into the home's skill directories are rejected with a message pointing to `propose_skill`. This is defense in depth: the approval check also covers shell writes.

### L1 Routine reflection and playbook

After every 5th settled, non-skipped run of a routine (`BOT_ROUTINE_REFLECTION_INTERVAL`), a background job reviews the runs since the last reflection.

**What the job sees:**
- For each run: its output (cut to 1,500 characters), failure kind, claim-check flags, tool names and tool errors, and the behavior fingerprint.
- The routine's notes and its active lessons.

**What it may do:** call `record_lesson` once, call `retire_lesson` once, or answer `NO_ENTRY`. The rules are adapted from Harness² `core/prompts.py:1105-1147`:
- A failure that repeats across runs is real; a one-off is noise.
- Prefer `confounded` when the fingerprint changed between runs or one run is all the evidence. A `confounded` verdict never becomes a proposal.
- Every lesson cites run ids from the input, names the component it concerns (routine prompt, procedure, tool use, or output format), and is between too generic and too specific.
- "Adoption alone never shows that a lesson helped."

**Outcome:** a lesson becomes an approval card (D5). Approved lessons are added to that routine's input after its notes, under "Lessons from earlier runs of this routine:". There are at most 6 active per routine.

### L2 Skill proposals

On attended turns only, the Bot gets `propose_skill` with a name, description, instructions and a reason.

- **When to use it:** its description follows the Harness² cheapest-form ladder. Prefer a skill for a repeatable procedure the person liked, rather than writing more into memory or instructions.
- **Checks before the card:** a validator gives specific, named reasons, like Harness² `core/tree.py`:
  - the name is not allowed, or collides with an existing skill (and which one);
  - a field is too long;
  - the description doesn't say when to use the skill;
  - the frontmatter is malformed;
  - the threat scan blocked it.
- **The card:** it shows the new skill, or a diff against the current one.
- **Accepting:** the host writes the file, records the approval and, under Custom access, adds the skill to the Bot's selection.

### L3 Corrections

The memory review gets `note_how_to`. When a person turn corrects how the Bot did something ("no, put the totals first"), the review records a how-to lesson for the whole Bot.

- **Kept apart from personal facts:** the lesson lives in `lessons.json`, never in `USER.md`.
- **Applied at once (D5):** a "Learned: … · Undo" line appears in the chat.
- **Where it shows up later:** in the Bot's guidance prompt section, under "How this person likes things done:". At most 12 are active per Bot.

### L4 Memory tidying

When `MEMORY.md` or `USER.md` passes 80% of its character limit or holds more than 56 entries, a tidy job runs. It waits for the Bot to be idle, runs at most once per 24 hours per Bot, and counts against the D6 budget.

- **What it may do:** replace or remove entries, and nothing else. The result must be smaller than the input and must pass the threat scan.
- **Undo:** the whole before-state is saved in the learning history, and the chat shows "Tidied memory · Undo".

### L5 Learning history and Undo

Every learning change is appended to `<profile>/bots/<dir>/learning-history.json`, keeping the newest 100 changes and at most 1 MiB. This includes memory review adds, tidies, lessons, skills and follow-ups.

- **What each entry holds:** a short summary, the before and after content, and the fingerprints before and after.
- **How Undo works:** it restores the before-state only when the current state still equals the after-state. Otherwise it reports `conflict` and changes nothing.
- **Where people see it:** a "What I've learned" page on the Bot profile (desktop first, then phones behind `bot:learning`). It lists active lessons, Bot-added skills, waiting follow-ups and recent changes, each with Undo or Remove.
- **Icons:** no brain icon (AGENTS.md).

## 8. Safety, privacy and network

- **Approval:**
  - Nothing a Bot learns can change its locked rules, its authority or its persona.
  - Lessons and skills are untrusted-data blocks in the prompt, below authority.
  - Skills and reflection lessons always need approval.
- **Provenance:** learning reads only person turns plus the Bot's own routine output, using the existing `memoryProvenance` and `personTurns` filters. Routine and intro inputs never become memory or corrections.
- **Untrusted input:** event payloads and webhook bodies are untrusted data. They never become instructions or memory.
- **Network:** beyond the existing posture, the only new calls are those in D1–D3. No new call happens at startup, during onboarding or during listing.
- **Spend:** background learning stops at the D6 caps for the day and resumes the next local day.
- **Pi:** no Pi pin changes. Everything uses existing Pi Durable hooks and `Models.completeSimple`.

## 9. Not in scope

- The Bot browser's sign-in state. Nothing can probe it today without starting the browser.
- A public webhook relay.
- Push notifications to phones. The phone feed stays pull-on-foreground.
- Mutating actions on unattended runs.
- Cross-Bot or cross-device lesson sharing.
- Live A/B tests of lessons.
- Showing the claim-check chip on attended replies on phones.
- CLI UI for issues, triggers and learning. The CLI Bot host shares the main-process modules and keeps working; its UI parity is a follow-up recorded in `packages/cli/README.md`.

## 10. Remote protocol

Each plan claims one Remote revision when it merges: the next one after `main`'s (40 as of 2026-10-27). Each plan updates iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `openapi.json` and `docs/aiden-remote-api-v1.md` together.

| Plan | Capabilities |
|---|---|
| A | `bot:issues`: issue cards and `issueCount`; routine failure kind on routine rows |
| B | `bot:routine-triggers`, `bot:proposal-reasons`, `bot:interruptions` |
| C | `bot:learning`: learning page reads, Undo, lesson and skill cards |
