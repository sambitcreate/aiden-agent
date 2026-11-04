# Bots that work together: implementation plan

Status: implementation in progress (2026-11-04). A Tasks1–11 passed full-A review at `dc89b16ce`, and B Tasks1–10 passed both Gate3 reviewers at `494d6b39f`. C Tasks1–9 are implemented and locally verified across desktop, Remote56 and both native clients. C enforcement Gate4 accepted `054e953fa`; Gate5 accepted all C Tasks1–9 at `55678558e` after the payment-subdomain correction. D Tasks1–8 are implemented and locally verified on `feature/bot-allow-list`, including desktop controls, Remote57 host contracts and both native clients. Gate6 accepted whole-D source correctness at `eaa4ae9b0`; the main session also fixed its remaining display-only Low. Final whole-program Opus 5.5 medium round 1 found two Important consent gaps; corrections and a fresh complete review are in progress. The stack is `feature/bot-messaging` → `feature/bot-access-requests` → `feature/bot-plan-approval` → `feature/bot-allow-list`; main `581aee4f8` was merged into A and carried through B/C/D. Four PRs, final Opus 5.5 medium review and exact-head CI remain pending.

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

The main session owns implementation, integration, finding triage and commits. Follow each detailed plan's numbered tasks in order, in phases A, B, C and D. Keep commits focused. Under the owner’s 2026-11-04 update, the main session implements directly without implementation subagents. Only Opus 5.5 medium is used for reviews, including the final whole-program review. This workflow is self-contained and requires no `superpowers` skills.

Use T3 `delegate_task` for each review, with `role: "review"`, a fresh task per round and explicit model options from the live `orchestrator_capabilities` catalog. Record each returned task id and verify its returned model and options. The current selection, verified against the live catalog on 2026-11-04, is:

- Opus reviewer: provider `claudeAgent`, model `claude-opus-5-5`, options `{ "effort": "medium" }`. Emphasize authority, policy order, lifecycle and consistency between phases.

Each fresh Opus reviewer checks the frozen checkpoint SHA independently and read-only, including concurrency, persistence, replay, behavioral tests and native/CLI parity. Supply the master and phase plan, base SHA, checkpoint SHA, acceptance criteria, changed files, validation results and known limitations. The reviewer may report any concrete correctness issue, but does not edit, commit, open PRs or launch more agents. The checkout remains frozen during review.

Review gates:

1. A core: after Tasks 1-3 and 5-7. Task 4 still precedes Task 5; this gate reviews provenance, policy, ledger, courier and wiring before transcript and phone work.
2. A complete: after Task 11, including desktop, phones and CLI.
3. B complete: after Task 10, including stale-card validation, folder isolation and phone approvals.
4. C enforcement: after Tasks 2-5, including Task 1's shared contract. Review coverage, all matching rules, caps and crash recovery before card/UI work.
5. C complete: after Task 9, including Stop, native clients and permission lifetime.
6. D complete: after Task 8, including durable approval deduplication, revocation and native clients.

Each remaining gate launches a fresh Opus 5.5 medium reviewer. Earlier dual-provider reviews remain recorded as history. Before launching, run the narrow suites for completed tasks. The main session accepts or rejects each finding with source/test evidence. Resolve every blocking or important finding, rerun affected checks, then start a fresh review round for substantive fixes. Include the original brief, prior findings, fixes, rejected findings and unresolved objections. Never advance on an unresolved correctness finding or a failed relevant check. Re-review changes after a merge from `main` when they affect an accepted contract; CI must always be green on the exact PR head.

Before each PR opens:
- Run the narrow suites named in the plan, plus `npm run test:bots`, `npm run test:bot-runtime`, `npm run test:bot-rules`, `npm run type-check` and `npm run test:aiden-remote`.
- Run `npm run test:cli` for A, and for any change to files the CLI bundles.
- Run the iOS and Android suites for every step with phone work.
- Run window-opening tests through `npm run test:e2e:space`, plus the macOS-only checks required by `AGENTS.md` when a changed path has a darwin branch.
- Complete the phase gate's whole-branch Opus 5.5 medium review and the final whole-program Opus review. Record reviewed SHA, validation, findings and their dispositions in the PR description.

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

Phases A and B have passed their source review gates. C enforcement passed Gate4 at `054e953fa`; C Tasks1–9 passed both Gate5 reviewers at `55678558e`. D Tasks1–8 are implemented and locally verified on `feature/bot-allow-list`, including desktop controls, Remote57 host contracts and both native clients. Gate6 accepted whole-D source correctness at `eaa4ae9b0`; the main session also fixed its remaining display-only Low. Final whole-program Opus 5.5 medium round 1 found two Important consent gaps; corrections and a fresh complete review are in progress. The acceptance cases and review gates must pass before advancing each phase. Keep the earlier research as a dated design record; the master and corrected detailed contracts govern implementation.

## Status

- [x] A: `message_bot`
- [x] B: `request_access`
- [x] C: plan approval
- [ ] D: allow list and nudge


## Owner workflow update, 2026-11-04

The owner asked the main session to implement directly and use only Opus5.5medium for reviews. Sol implementation workers are stopped and the OpenCode correction reviewer is cancelled. This supersedes the earlier optional implementation delegation, dual Opus/DeepSeek gates and final Astra request for remaining work. Prior review reports and dated records remain history. Finding fixes, a fresh read-only review per substantive correction, four stacked PRs, exact-head CI and no merge without authorization remain required.


## Integrated checkpoint before final review, 2026-11-04

All phase source gates passed, most recently D at eaa4ae9b0. Root fixed its display-only Low with an API-visible RED and86focusedpasses, then merged docs-onlymain581aee4f8 bottom-up without conflicts. A0dbffbd40, B5d46dd9a2 andC11d70ba4b retain their accepted runtime source with the main documentation update. Remote main53 still permits stack revisions54–57. No PRs or corresponding remote branches existed at the preflight check.

The integrated source passed Bots1013, wholetypes, registry15 and CLIbuild/types. Cua passed5 withretries0 in31.6s across messaging, access/allow-list, plans and onboarding. Logs /tmp/bot-program-final-{bots,types,registry,cua,cli-build,cli-types}.log. Earlier relevant current-source checks include runtime480/access110/allowed118/rules66 and plans144/messaging89, plus the fullRemote and native evidence recorded in the phase plans. The earlier standaloneCLI messaging timingflake remains unresolved and must be disclosed; no timeout/retry was increased. Final read-only whole-program Opus5.5medium review, PRcreation and exact-headCI remain pending. No device, live, package, release or hostedCI claim.


### 2026-11-04 — Final whole-program review round 1 corrections

Opus rejected `071e92e1c` with two reproduced Important findings. The main session fixed both directly: the production fixed-location write list now includes `tool-approval-rules.json` and `bot-folder-grants.json`; the same pure helper is used by production registration and behavioral tests. Direct, symlink and nested codemode writes/edits leave both files unchanged while application grant/revoke still works. D now refuses remembered classes for actual payment-provider hosts before host normalization. Real durable turns with existing saved entries still ask, and repeated approvals never produce an Always offer. Ordinary mail subdomains remain eligible. No shell sandbox claim is added.

Low L3 is fixed by allowing an expiry deny to settle a card while an automatic release awaits validation. The resumed release cannot win. Low L4 is fixed with host-owned turn routing: person decisions on Bot-message turns still count, but cannot consume or emit the weekly hint. Actual durable input metadata and real tally/service tests cover the boundary. No public DTO or Remote revision changes.

Low L1 is being corrected by untracking only papercut notes added by this stack, preserving them locally. The seven notes already on main remain tracked. Low L2 is accepted as a display-only limitation: an unanswered plan on a Bot-message turn can produce the sender’s generic “didn't answer” timeout rather than “gave up”; the actual plan deadline and effect fence still hold. No approval is implied, no step starts, and Stop remains available. A proposed courier/plan-state coupling was discarded rather than expanding the private lifecycle contract for this wording change. Carry this bounded observation into the PR and final review.

The final reviewer did not read the whole implementation, clients or contracts. The next fresh Opus5.5medium round must close every listed read gap before whole-program source acceptance. Four stacked PRs and exact-head CI remain pending; no merge is authorized. The CLI timing flake remains unresolved and must be disclosed without another targeted rerun or weaker limits.


### 2026-11-04 — Final round 1 correction validation and local-note cleanup

The main session committed the consent corrections at `2aa8b3136`. Validation passed: focused file-router/assembly/extension231, allow-list122, runtime487, access110, plans144, messaging89, rules66, Bots1022, whole TypeScript and registry15. Full Remote passed1300 with2 existing conditional skips. The rebuilt CLI passed183 with3 existing PTY skips and its own types. The CLI build first caught a desktop helper import reaching Electron; the helper was split into a desktop-only module, the shared CLI policy stayed unchanged, and the rebuilt CLI graph check passed. Root suites used Node22.23.4; the CLI shell resolved Node26.12.1 for this run, so that count is not new pinned-CI-runtime evidence. No test assertion, timeout or retry was weakened. Earlier standalone CLI messaging timing flake remains unresolved and reportable.

Cua passed5 withretries0 in24.9s across messaging, access/Always+Manage+Remove, plan/checklist/Stop and onboarding. Logs `/tmp/bot-program-r1-{allowed,runtime,access,plans,messaging,rules,bots,registry}-final.log`, `/tmp/bot-program-r1-types-final2.log`, `/tmp/bot-program-r1-lint-final2.log`, `/tmp/bot-program-r1-remote.log`, `/tmp/bot-program-r1-cli-{build,tests,types}-final.log`, `/tmp/bot-program-r1-cua.log`. This remains fake-provider/headless/Cua evidence, not native rendering, physical-device, live-provider, package or hosted-CI acceptance. No public/native contract changed; earlier native evidence remains prior-checkpoint evidence.

Papercut cleanup is complete at every stack layer without rewriting history. Actual tracked inventory before cleanup was41 versus7 on main, so34 added notes were preserved locally and untracked. All four branch diffs against main now have no `.papercuts` changes; the7 main notes remain tracked. Backup manifest and copies are under `/tmp/bot-program-papercut-preserved`, and local ignored copies remain in `.papercuts`. A=`5514e28a7`, B=`b0c0550b6`, C=`3f2def1f5`; D’s runtime tree is unchanged from the validated correction after the cleanup merges. Historical entries about previously staged notes remain history. Final fresh complete Opus5.5medium review and PR/CI work remain pending, with Low L2 explicitly retained.


### 2026-11-04 — Final round 2 cleanup correction and remaining review scope

Opus round2 found no Blocking, Important or Medium findings and no runtime, consent, replay, privacy or contract defect at `dad62ed83`. Whole-program acceptance is still withheld because required historical reports and several small source/contract sections were not fully read. A fresh narrow Opus5.5medium round will read those remaining sections, verify this correction and carry the existing retained observations; the main session has not waived any read requirement.

The earlier cleanup record was too broad: it counted only the root `.papercuts` directory. Its41tracked/34added counts were correct for that directory, but omitted `ios/.papercuts/bot-messaging-task9-native.md`. Across the repository the original inventory was42tracked/35added. The nested note is now also preserved locally and in `/tmp/bot-program-papercut-preserved/nested/ios/.papercuts/`, untracked on A and merged upward through B/C/D without rewriting history. A repository-wide path-component check now finds no `.papercuts` changes against main on any of the four layers; the7 baseline notes remain unchanged. This corrects, rather than silently rewriting, the previous dated “complete” claim.

The OpenAPI plan response route now describes `planId` as the exact plan ID returned by the Bot session; the access route keeps its correct waitId description. Only a description changed, with no schema, wire shape, revision or native behavior change. Runtime validation remains the round1 correction evidence. The unresolved CLI timing flake and all accepted A–D observations, including the generic plan-timeout sender copy and corrupt tally blocking B Once/Not now, remain explicit PR disclosures. No merge is authorized.

Correction validation: existing Remote protocol/schema suite64passed, JSON decoded successfully, full-stack diff-check clean. No behavior test was added for a description-only edit. Runtime/client sources are unchanged from `dad62ed83`; prior runtime/native/Cua counts are not new reruns. The remaining full-history, small renderer/art, delete-path and exact fixture/OpenAPI reads are assigned to the next fresh Opus review rather than waived.
