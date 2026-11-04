# Bots that work together: implementation plan

Status: implementation in progress (2026-11-03). Phase A Tasks 1–11 are implemented, locally verified across desktop, Remote, CLI, iOS and Android, and accepted by Opus 5.5 medium and OpenCode Go DeepSeek V4.1 Flash high at `dc89b16ce` in full-A round 4. Phase B access requests are next; C and D remain pending. The A implementation is on `feature/bot-messaging`, with main `a5c5db8b1` merged. PRs, final Astra review and exact-head CI are still pending.

This is the master plan. It records the owner's decisions and how the four detailed plans fit together. Research and design: [bot-to-bot-messaging-research.md](bot-to-bot-messaging-research.md).

## What ships

| Step | PR | Plan | What the person gets | Tasks |
| --- | --- | --- | --- | --- |
| A | 1 | [`message_bot`](../superpowers/plans/2026-11-03-bot-messaging-a-message-bot.md) | A Bot sends another Bot a message and carries on. The reply comes back later as a new turn | 11 |
| B | 2 | [`request_access`](../superpowers/plans/2026-11-03-bot-messaging-b-request-access.md) | A Bot limited to its own folder asks to use another one: Allow once, Always for this folder, Not now | 10 |
| C | 3 | [Plan approval](../superpowers/plans/2026-11-03-bot-messaging-c-plan-approval.md) | One plain-language card approves a whole job, and its coverage list is enforced | 9 |
| D | 4 | [Allow list and nudge](../superpowers/plans/2026-11-03-bot-messaging-d-allow-list.md) | After three approvals of the same thing, Always allow appears, and each Bot has an Allowed without asking list | 8 |

Desktop and phones get each step together. The CLI serve daemon gets A's tool and courier; B, C and D are desktop-hosted, and the docs say so. There is no terminal UI work.

## Owner decisions

**Messaging**
1. v1 is send now, reply later. Each message gets at most one final reply, with silence/failure as quiet outcomes. A nested child completes its parent's single reply obligation; it never adds a second origin reply.
2. On by default. Each Bot has "Other Bots can message <Bot>" and "<Bot> can message other Bots", and Settings → Bots has a global switch.
3. One level of nesting. Hop 1 may message one more Bot; hop 2 and reply turns can't message anyone; nobody messages back up the chain.
4. Approvals on a Bot-started turn wait as Needs you in the asked Bot's chat. The sender is told at once. After 30 minutes the Bot gives up, and the sender is told.
5. Status lines ("COS is waiting…", "COS didn't answer") are quiet lines for the person. The sender's model doesn't see them.
6. "Hand off to me" rules block on a Bot-started turn. Approvals and Ask first rules wait for the person.
7. Cap: 30 messages a day per pair of Bots, both directions together. Also at most 3 in flight per sender and about 20 per 5 minutes, then a 10-minute cooldown.

**Access**

8. New Bots keep Full access. Each Bot works under its own folder, memory, connector bindings and browser sign-ins.
9. `request_access` is offered only to Bots limited to their own folder, not Bots with Files off.
10. Whole Mac is only ever Allow once.
11. Always for this folder can be answered from a phone.
12. A folder allowed for a Bot stays off paired phones' file browser (`botsOnly` root).

**Plan approval**

13. The person reads sentences. Enforcement uses the `covers` list, checked against the Bot's current access. A plan never widens access.
14. Per-item limit: 10 by default, 25 at most. A plan lasts for its run, at most 60 minutes.
15. Not now: the Bot stops and asks what the person would like.
16. A plan's one outside-folder grant is lost if Aiden quits, and the Bot asks again.
17. Never covered: locked rules, hand-off rules, and Computer Use on the person's Mac. An Ask first rule is covered only when the card names it.

**Allow list**

18. Aiden counts approvals, not a skill: 3 in 14 days with no recent denial.
19. Always allow is on phone approval cards too.
20. Entries apply on unattended turns as well. Locked rules and rule-made asks always win.
21. Folders from `request_access` appear in Allowed without asking, and Remove takes the folder away from that Bot.

## How the pieces connect

- **Turn kinds come from A.** `renderer/shared/bot-messages.ts` owns `bot:<originBotId>:<hop>:<deliveryId>`, `botreply:<deliveryId>`, `botMessageTurnOf` and `isBotMessageRequestId`. B and C use those helpers and never check the prefix themselves.
- **Waiting cards.** A's courier watches approvals using host-owned run/input provenance, never an arbitrary first pending card. C's plan card calls `botMessages().announceWaiting(...)`, which deduplicates the notice and returns the durable delivery deadline plus expiry state, including on replay. B doesn't need it: nobody can answer `request_access` on a Bot-started turn, so it raises a Needs you issue.
- **Folders.** C's `BotPlanAccessPort` uses B's `resolveBotAccessTarget`, `coveredByBotLocations` and snapshot-validated `botRunAccess.grant`. Preserve read/write mode and plan ownership; every plan termination revokes its own ephemeral grant, and replay cannot recreate it. D's folder entries use B's `grantBotFolder` root and add `revokeBotFolder`.
- **Skipping a card.** C (plan coverage) and D (allow list) both use the `preapproved` path that "routines go ahead" uses in `bot-tool-assembly.ts`. D matches only where no rule applied. C matches a rule only when the card named it. Order in `checkPolicy`: fresh authority/ingress/deadlines, rules, existing routine go-ahead, plan coverage once, allow list, ordinary card/block. Every matching Ask first rule must be named for plan coverage.

## Order and branches

Stacked PRs, each with its own branch, in this order:

1. `feature/bot-messaging` (A), against `main`.
2. `feature/bot-access-requests` (B), on A.
3. `feature/bot-plan-approval` (C), on B.
4. `feature/bot-allow-list` (D), on C.

Each PR ships working software on its own. Merge bottom-up and let GitHub retarget. After every `main` merge, recheck the root `package.json` `test` chain (union) and the Remote revision.

**Remote.** `main` is at revision 53 today. Each PR claims the next revision after `main`'s when it merges, not when it was written, and updates iOS, Android, `contract.json`, `openapi.json` and `docs/aiden-remote-api-v1.md` together. New capabilities: `bot:messaging`, `bot:access-requests`, `bot:plans`, `bot:allowed`.

## How it gets built

The main session owns implementation, integration, finding triage and commits. Follow each detailed plan's numbered tasks in order, in phases A, B, C and D. Keep commits focused. A fresh implementation worker is optional; the two models below are independent review agents and must not review their own implementation. This workflow is self-contained and requires no `superpowers` skills.

Use T3 `delegate_task` for each review, with `role: "review"`, a fresh task per round and explicit model options from the live `orchestrator_capabilities` catalog. Record each returned task id and verify its returned model and options. The verified selections on 2026-11-03 are:

- Opus reviewer: provider `claudeAgent`, model `claude-opus-5-5`, options `{ "effort": "medium" }`. Emphasize authority, policy order, lifecycle and consistency between phases.
- DeepSeek reviewer: provider `opencode`, model `opencode-go/deepseek-v4.1-flash`, options `{ "variant": "high" }`. Emphasize concurrency, persistence, replay, behavioral test gaps and native/CLI parity.

Both review the same frozen checkpoint SHA independently and read-only. Supply the master and phase plan, base SHA, checkpoint SHA, acceptance criteria, changed files, validation results and known limitations. Both may report any concrete correctness issue. They do not edit, commit, open PRs or launch more agents. Reviewers can share this checkout only while the main session keeps it at that checkpoint.

Review gates:

1. A core: after Tasks 1-3 and 5-7. Task 4 still precedes Task 5; this gate reviews provenance, policy, ledger, courier and wiring before transcript and phone work.
2. A complete: after Task 11, including desktop, phones and CLI.
3. B complete: after Task 10, including stale-card validation, folder isolation and phone approvals.
4. C enforcement: after Tasks 2-5, including Task 1's shared contract. Review coverage, all matching rules, caps and crash recovery before card/UI work.
5. C complete: after Task 9, including Stop, native clients and permission lifetime.
6. D complete: after Task 8, including durable approval deduplication, revocation and native clients.

Each gate launches both reviewers, for 12 initial review runs across the program. Before launching, run the narrow suites for completed tasks. The main session accepts or rejects each finding with source/test evidence. Resolve every blocking or important finding, rerun affected checks, then start a fresh review round for substantive fixes. Include the original brief, prior findings, fixes, rejected findings and unresolved objections. Never advance on an unresolved correctness finding or a failed relevant check. Re-review changes after a merge from `main` when they affect an accepted contract; CI must always be green on the exact PR head.

Before each PR opens:
- Run the narrow suites named in the plan, plus `npm run test:bots`, `npm run test:bot-runtime`, `npm run test:bot-rules`, `npm run type-check` and `npm run test:aiden-remote`.
- Run `npm run test:cli` for A, and for any change to files the CLI bundles.
- Run the iOS and Android suites for every step with phone work.
- Run window-opening tests through `npm run test:e2e:space`, plus the macOS-only checks required by `AGENTS.md` when a changed path has a darwin branch.
- Complete the phase gate's whole-branch reviews with both selected models. Record reviewed SHA, validation, findings and their dispositions in the PR description.

The main session owns each stacked PR and links it to this T3 thread. Merge only when explicitly authorized, bottom-up, after fresh exact-head CI. Live-model and physical-device checks below are separate acceptance evidence; passing local or hosted tests does not substitute for them.

## Hand checks the owner should do

Automated tests can't cover these:
- Jester and COS on a real model: does Jester pass the reply on naturally, and does COS treat the framed message as a request rather than an instruction from you?
- Do Bots actually reach for `propose_plan` before a multi-step job, or do they fall back to single cards? This depends on the tool description and may need tuning.
- A Needs you card from a Bot-started turn, answered on a physical iPhone and Android phone.

## Out of scope

Group rooms, Bots talking across machines, A2A, shared memory between Bots, routines or Telegram turns sending messages, and terminal UI. All are possible later on top of this.

## Correctness review, 2026-11-03

GPT-6 Astra reviewed the master, all four detailed plans, research and current runtime seams. This revision addresses its 15 initial findings and eight follow-up findings in the corresponding tasks:

- A Tasks 2-7: host-free tool acceptance, atomic quota reservation, independent counters/cooldowns/replay receipts, recoverable external effects, owned approval deadlines, and one parent reply across nesting. Task 9 retains paused reply text on phones.
- B Tasks 2-7: immutable card/issue authorization snapshots, policy and directory revalidation, rollback-safe persistent grants, and read/write-aware ephemeral locations.
- C Tasks 2-6: fresh versus replayed approval, owner-bound access revocation, durable task identities for caps, named matching rules, valid ingress fixtures and one decision sequence.
- D Tasks 1-5: durable decision receipts with person/expiry/allow-list provenance. Tasks 7-8 page the combined rule/folder list without hiding grants.
- Follow-up corrections bind decisions to authorization attempts and current requirements, preserve Remove through publication/revocation receipts, enforce Stop at plan execution admission, distinguish read/change on folder cards, register every suite in `test:serial`, scope settlement caches to the current authorization attempt, and let a read-only grant request a separately approved write upgrade.
- The self-contained execution workflow above supplies both requested reviewers and explicit model settings at each gate.

After four Astra review rounds and the corrections above, the final focused review found no blocking or important plan issues. This is acceptance of the written contracts, not runtime acceptance. Local document checks passed for whitespace, links, fenced blocks and task numbering.

These remain plans, not implemented features. The acceptance cases in each task must be implemented and run before that phase is accepted. Keep the earlier research as a dated design record; the master and corrected detailed contracts govern implementation.

## Status

- [ ] A: `message_bot`
- [ ] B: `request_access`
- [ ] C: plan approval
- [ ] D: allow list and nudge


### 2026-11-04: Idle reply preparation avoids outbound roster discovery

Hosted PR #727 head `a819a54d2` again failed the unchanged 10-second final-reply poll in run 41899862714, job 126819265824. Beta's answer was saved about 5.9 seconds after Alpha's initial result, but the reply effect remained unacknowledged. The exact hosted cause remains unproven; no unchanged CI rerun was requested.

The real CLI parity case reproduced two outbound-roster reads while preparing a reply that cannot use `message_bot`. Session preparation now passes the already validated Bot request identity to registry refresh only when the Bot is idle. Posting, current state, admission, model, pause, spending, deadline and per-call ingress checks remain fresh. Resume and compaction retain their existing preparation. No cache, public contract, native change or timeout change was added.

The first candidate also passed a queued reply's context while a person was running. A new real runtime case failed with zero person-tool executions instead of two. Restricting the context to idle preparation restores both executions and the queued reply. The original CLI assertion still requires the final reply within 10 seconds, and now independently requires zero roster reads in reply preparation.

Final local validation: runtime 347 passed; messaging 95 passed; rebuilt CLI 183 passed with three existing PTY skips; whole TypeScript and scoped lint passed. Behavioral RED logs are `/tmp/bot-pr727-reply-preparation-red.log` and `-queue-red.log`; final logs use `/tmp/bot-pr727-reply-preparation-{runtime,cli,build}-final.log`, plus `-queue-green.log`, `-types.log` and `-lint.log`. Setup failures are recorded separately in the ignored papercut log. Opus review and exact-head CI remain pending for this runtime correction. All earlier retained observations and the no-merge instruction remain.


### 2026-11-04: Round 9 source acceptance and CI test follow-up

Opus 5.5 medium accepted integrated `555ad4c86` for narrow source safety on the cumulative round 2/3/5–8 basis. There were no Blocking, Important or Medium findings. Its session-service probes confirm idle-only preparation, hop-1 messaging, reply/hop-2 withholding, restoration for a later person, failed preparation and Pause/Resume. This does not diagnose the recurring hosted CLI timeout or authorize merge. Final integrated CLI validation passed 183 tests with three existing PTY skips; messaging 95 and TypeScript passed.

Root added an ordinary-person action test for Low R9-1. It passes with the queued-reply case, and an all-idle-input context mutant fails the new execution assertion. Low R9-2 comments and project memory now distinguish ordinary attended preparation from idle Bot-message narrowing; per-call ingress remains authoritative. Low R9-3 is disclosed: no new desktop Bot-message Cua case exercises `bot-tool-sources-main.ts`; desktop branch equivalence was checked by source reading, while the real CLI and session-service tests are the current behavioral evidence.

Linux CI on A `a819a54d2`, run 41899862714/job 126819265893, passed builds, keyring checks and installed GUI smoke, but failed the E2E flake gate. The chat-width test read a missing settings file before its debounced first write, then passed on retry. Root corrects only the poll's ENOENT handling, preserving all saved-value, geometry and relaunch assertions, timeouts and retry settings. This matches the existing inline-visuals persistence test. Other I/O and JSON errors still propagate. Cua Linux validation passed the full chat-width case 1/1, including saved wide value and relaunch, without a flaky retry. Whole TypeScript, scoped lint and E2E TypeScript passed. The failed x64/arm64 summary jobs are downstream results, not separate compiler failures. All CI failures and earlier source observations remain disclosed.


### 2026-11-04: iOS chat-observation test synchronization

C head `caf63916d` failed XCTest in run 41899861109/job 126820252860 after both hardware-target compilation and simulator build passed. The held-first-roster test exceeded its three-second request expectation. The progress-owner reload test counted three requests rather than one. The latter used a finished event stream and assumed both reloads beat the half-second reconnect, so a correctly reconnecting observer could violate its count. The exact cause of the held-roster scheduling delay is not established by the log. No unchanged hosted job was rerun.

Root changes only the existing XCTest fixture and tests. The single-owner case keeps its live event channel open, so the exact one-snapshot/one-channel assertions test reload ownership without a legitimate reconnect. The two late-registration cases complete the opening lookup, transcript, draft and catalog setup before starting and holding the first roster request. They still register the run only after the opening lookup answered and before that first roster is delivered, retain the three-second held-request expectation, exact request/read counts and live-versus-transcript assertions, and explicitly stop the observer. Native application code, contracts, revisions and Android are untouched.

All three focused cases passed on iPhone 17 Pro with iOS 27 Simulator, destination `BD8018AF-7C14-4729-BDE1-775E29EA4FBD`, using Xcode-beta and `CODE_SIGNING_ALLOWED=NO`. Log `/tmp/bot-pr729-chat-sync-focused.log` and result bundle of the same prefix record three passes and no skips. Full `AidenChatTests` verification is running once at this changed source. These are simulator checks, not physical-device or release evidence. Exact-head hosted CI remains required, and the earlier CLI timing failure and retained observations remain open disclosures.


### 2026-11-04: Delivery test follow-up complete locally

The changed-source iOS full `AidenChatTests` run passed 361 tests with zero failures and skips, confirmed by `/tmp/bot-pr729-chat-sync-full.xcresult` and its JSON summary. The focused late-registration/reload run passed three. These tests used iPhone 17 Pro / iOS 27 Simulator with unsigned development artifacts; no physical-device, native rendering or release claim follows. The Linux Cua chat-width case passed once with no retry, and root TypeScript, scoped lint, E2E TypeScript and merged ordinary/queued runtime cases passed. The original hosted failures remain disclosed; local passes do not establish exact-head hosted CI or prove the original scheduling cause.

All executable runtime changes remain those accepted in Opus round 9 at `555ad4c86`; subsequent changes are tests, comments and records. R9's desktop `messageTurn` direct-Cua coverage gap is retained explicitly. No assertion, retry, timeout or flaky-test gate was weakened. Root will push the four layers and await new checks/reviews with no merge or auto-merge.
