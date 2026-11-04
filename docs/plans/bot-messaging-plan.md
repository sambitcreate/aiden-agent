# Bots that work together: implementation plan

Status: implementation in progress (2026-11-04). A Tasks1–11 passed full-A review at `dc89b16ce`, and B Tasks1–10 passed both Gate3 reviewers at `494d6b39f`. C Tasks1–9 are implemented and locally verified across desktop, Remote56 and both native clients. C enforcement Gate4 accepted `054e953fa`; Gate5 accepted all C Tasks1–9 at `55678558e` after the payment-subdomain correction. D Tasks1–8 are implemented and locally verified on `feature/bot-allow-list`, including desktop controls, Remote57 host contracts and both native clients. Gate6 accepted whole-D source correctness at `eaa4ae9b0`; the main session also fixed its remaining display-only Low. Final whole-program source review accepted `803b50cfa` after the narrower inventory-proof recovery correction passed round 5. All mandatory read scope is complete cumulatively across rounds 2, 3 and 5. Two later PR #728 recovery findings are corrected locally and awaiting narrow Opus verification. The stack is `feature/bot-messaging` → `feature/bot-access-requests` → `feature/bot-plan-approval` → `feature/bot-allow-list`; main `581aee4f8` was merged into A and carried through B/C/D. The four stacked PRs are open as #727–#730, with exact-head CI in progress; no merge is authorized.

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

Phases A and B have passed their source review gates. C enforcement passed Gate4 at `054e953fa`; C Tasks1–9 passed both Gate5 reviewers at `55678558e`. D Tasks1–8 are implemented and locally verified on `feature/bot-allow-list`, including desktop controls, Remote57 host contracts and both native clients. Gate6 accepted whole-D source correctness at `eaa4ae9b0`; the main session also fixed its remaining display-only Low. Final whole-program Opus 5.5 medium review accepted `32fb46459`; a newly found recovery Low has since been fixed on B and merged upward, with narrow runtime re-check pending. The acceptance cases and review gates must pass before advancing each phase. Keep the earlier research as a dated design record; the master and corrected detailed contracts govern implementation.

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


### 2026-11-04 — Final source acceptance and interrupted-delete recovery Low

Opus accepted whole-program source correctness and conformance at `32fb4645991130618083de76b040612e16f75529`, based on round2’s completed production/client read plus round3’s full completion of histories, remaining renderer/art, deletion and raw fixture/OpenAPI reads. No required scope was waived. This is source acceptance only. Reports `/tmp/aiden-bot-program-final-opus-r3.md` and its identical REVIEWER copy retain all A–D limitations.

Root chose to fix the newly reproduced Low startup wedge before PRs. The B-owned correction `37ef50fb0` treats a genuine capability-unavailable exception as no root selection during folder recovery, allowing interrupted deletes to finish. Disk errors and same-name impostors remain fail-closed with unchanged evidence. B’s application/journal/root80, types and lint pass; merged through C`9bd81c398` and D without rewriting history. The one test append conflict retained both existing D observer assertions and all new recovery cases. On the integrated top: application/journal/root/protocol152, Bots1027, access110, whole TypeScript, scoped lint and full diff-check pass. RED3fail/2controls and all logs `/tmp/bot-program-r3-recovery-{red-final,b-green-final,b-types-final,b-lint-final,top-green,top-types,top-lint,top-bots,top-access}.log`. Prior CLI, native, Cua and full Remote results are unchanged-source prior evidence, not new runs. Narrow Opus verification of this runtime correction remains required.

R3’s receipt-description Low is fixed: `savedForFuture` explicitly records the earlier durable approval, including replay after Remove, and does not confirm current access or restore temporary authority. The pre-existing `accepts.maxItems`23 versus26 vocabulary discrepancy is retained as a documentation Low; shipped clients negotiate capabilities separately, and the runtime parser’s actual bounds remain authoritative. The unused `.oa-bots-bubble` CSS and import-before-header placement are retained cosmetic observations with no behavior effect. They are disclosed rather than expanded into unrelated UI changes.

The PR disclosures also carry the history details newly enumerated by round3: a person’s joined steer contributes to the answer routed back to the sending Bot; Bot message labels use the routine icon and previews omit message/status rows; Xcode diagnostics/main-thread/compiler warnings remain unclaimed; adding roots can invalidate other Bots’ leases; exact-root conversion may leave overlapping phone roots; one temporary folder per task is the accepted replacement design; failed journal recovery writes retain the lifecycle fence; B Task6’s initial RED was never captured; Compose UI tests were compiled, not executed; deleting a Bot can retain unselected hidden roots and committed path receipts on disk, with no grant. The CLI timing flake, generic sender timeout copy and corrupt tally blocking B Once/Not now remain explicit limitations.

Fresh main recheck still `581aee4f8`/Remote53; stack54–57 remain provisional until merge. No PR or merge yet. Root implements directly, only Opus5.5medium reviews; no implementation/OpenCode/Astra agents.


### 2026-11-04: Final round 4 recovery correction

Opus round 4 rejected `d35506d72` with Important R4-1. The earlier interrupted-delete fix incorrectly treated every `BotCapabilityUnavailableError` as proof that a policy was absent. Production also uses that error while its checkpoint is paused after an uncertain commit. In that state the broad catch could remove a root whose policy had already published, mark the journal rolled back and drop the service fence. The previous dated statements about compensation during that pause were incorrect and are superseded here.

The B correction `5d7f861be` now requires a fresh, readable inventory audit to name the exact Bot in `missingBotIds` before compensation can treat an unavailable policy or binding as absent. A poisoned checkpoint cannot provide that proof, so recovery retains the pending journal, root and lifecycle fence. Actual interrupted deletes still recover. The binding-deletion test now removes authority before throwing, rather than using the broad error class as its evidence.

A new test uses the real disk-backed capability store, checkpoint, key store, application service, folder journal and root service with a failing in-memory anchor. Its meaningful RED observed `rolled_back` where `pending` was required. GREEN verifies the original grant failure, retained root, zero removals and fenced mutations; reopening the real store and service then commits the receipt and replays the same operation as `already_allowed`. The simulated anchor failure is not live or signed Keychain evidence. Initial incomplete inventory, notice, error-message and audience fixtures were setup errors, not behavioral RED evidence.

B validation passed 125 tests, whole TypeScript and scoped lint. After clean merges through C `e0b25d3b9` and D `891c4a25a`, integrated application/checkpoint/store/roots/journal/protocol tests passed 197, Bots passed 1,028 and access passed 110. Whole TypeScript and scoped lint passed again. Logs are `/tmp/bot-program-r4-checkpoint-red-final.log`, `/tmp/bot-program-r4-b-{green-final,types,lint}.log` and `/tmp/bot-program-r4-top-{green,types,lint,bots,access}.log`. Prior native, Cua, full Remote and CLI counts remain prior-checkpoint evidence, not new runs.

A fresh narrow Opus 5.5 medium round must verify R4-1 and R4-2 before PR creation. Whole-program source scope otherwise rests on the completed round 2 and round 3 reads; no read requirement was waived. All retained A–D observations and the unresolved CLI timing flake remain PR disclosures. Remote revisions 54–57 require a fresh main check before the four stacked PRs. The main session implements directly and uses only Opus reviewers. No merge is authorized.


### 2026-11-04: Final source gate accepted and PR stack preparation

Opus 5.5 medium accepted `803b50cfa0455c63ede73c04abe2e71c9069c5f1` in round 5, with no Blocking, Important or Medium findings. R4-1 and R4-2 are fixed, and the original interrupted-delete recovery still works. This acceptance combines the completed round 2 and round 3 whole-program reads with round 5's narrow recovery review; it is not a fresh full reread or a merge authorization. Runtime and client sources are unchanged by this status update.

The reviewer independently passed 133 focused tests and TypeScript, plus eight real-store probes and three mutation checks. Real-store probes cover interrupted deletion, shared roots, publication failure, committed-head failure and repeated anchor failure across restart. The in-memory anchor is a test double, not live Keychain evidence. The reviewer made one unnecessary `git fetch --dry-run` despite the read-only review's no-network rule; its output was discarded and no ref moved. Root separately fetched main before PR preparation and confirmed `581aee4f8`, Remote 53. Stack revisions 54–57 remain valid for creation and must be rechecked at merge.

R5-1 is retained as a nonblocking defensive test gap, not an unresolved runtime defect. A mutant that ignores `missingBotIds` after a readable audit passes the suite, although the reviewer found no production path to an unavailable lookup followed by a readable audit naming that Bot as present. Current code still checks that exact ID and rethrows otherwise. R5-2 corrects the earlier dated wording: the grant rejects with the typed pause error. Recovery replaces the uncertain-commit subclass, so the test does not prove preservation of the original subclass or cause. No behavior relies on that distinction.

All retained A–D observations and the unresolved CLI reply-poll flake remain explicit in the PR descriptions. Local papercut notes stay untracked; repository-wide checks show no note changes on any layer. Four stacked PRs and their exact-head hosted CI are the remaining delivery work. No merge, rendered-native, physical-device, live-provider, package or release acceptance is authorized or claimed.


### 2026-11-04: Four stacked PRs opened

The source-accepted stack is now open as [messaging #727](https://github.com/sambitcreate/aiden-agent/pull/727) → [folder access #728](https://github.com/sambitcreate/aiden-agent/pull/728) → [plans #729](https://github.com/sambitcreate/aiden-agent/pull/729) → [remembered approvals #730](https://github.com/sambitcreate/aiden-agent/pull/730). Each layer targets the preceding branch; messaging targets main. Main was freshly fetched at `581aee4f8` before creation, with Remote 53, and all five branch revisions were checked as 53, 54, 55, 56 and 57. No branch history was rewritten. Every PR is linked to the parent T3 thread. Root will monitor exact-head hosted CI; no merge or auto-merge is enabled or authorized.

The PR descriptions disclose retained A–D observations, R5's defensive test gap, the typed pause-error wording, the unresolved CLI timing flake, and the distinction between current recovery validation and earlier native, CLI, Remote and Cua runs. Documentation changes after accepted `803b50cfa` do not alter runtime or client sources. The plan remains in progress until delivery checks finish, and merge, release, physical-device and live-provider acceptance remain separate.


### 2026-11-04: PR #728 recovery corrections awaiting Opus verification

The automatic repository review reported two B recovery defects after the accepted source checkpoint. Root reproduced both and corrected them on B `06ec5d652`, then merged into C and D. A committed folder replay now uses a distinct historical-stale error when its policy or target no longer matches. The issue service supersedes that exact old issue and returns the existing `not_open` result, without restoring or claiming current access. The pre-publication stale error keeps its original meaning. Transient saved-publication validation failures now fail the call while preserving the live publication for a fresh validated retry; genuine stale, aborted and expired owners remain revoked.

Three meaningful RED cases precede the production fixes. The real application/journal/root/issue-store integration covers interrupted settlement, later removal or directory replacement, service reopen, no republishing and a superseded status. A bound file-tool test covers an inner policy-read failure followed by successful retry without a new card. B checks passed runtime 351, access 87, issues 47, initial focused 122 and host 151, types and scoped lint. Existing mobile consumers accept `not_open`; focused checks passed iOS 4 and Android 106. Native sources, wire shapes and Remote revisions remain unchanged.

The previous Opus source acceptance remains evidence for unchanged code only. The corrected runtime needs a fresh narrow Opus 5.5 medium review before publication to the PR stack. No implementation subagents are used. All earlier retained observations, the unresolved CLI timing flake and obsolete-head CI infrastructure failure remain disclosed. No merge is authorized.

Integrated correction checks passed: focused application/access/issue/journal/Remote/router 353, access 113, runtime 487, Bots 1,030, plans 144 and allowed 122, with zero failures or skips. Whole TypeScript and seven-file scoped ESLint passed. CLI rebuilt 268 files with explicit Node 22.23.4 PATH, import-graph check and CLI types passed. No new CLI full-suite or timing-flake rerun was performed. Prior broad Cua/Remote/native counts remain historical evidence; the current focused native issue results are iOS 4 and Android 106. All commands for this correction are complete. Freeze for narrow Opus review before pushing.


### 2026-11-04 — PR recovery review accepted; plan reconciliation follow-up

Fresh Opus5.5 medium round6 accepted the B recovery runtime at `4cc396889` on the cumulative source basis. The two PR728 findings are fixed and B is pushed at `2ea3dae62`. A test-only follow-up replaces issue-repair tick/poll assumptions with observed error and durable-marker completions, adds committed-replay validation-I/O coverage and clarifies captured-snapshot wording. Both affected suites pass112 on B; TypeScript and lint pass. The reviewer exceeded the one-rerun instruction after the first issue-suite failure; repeated later passes are not a clean first-run result. The root fixed the timing bug rather than rerunning it unchanged.

Root also reproduced and corrected PR729’s identical-snapshot response race in both native clients. Equal plan values no longer invalidate the matching in-flight response; real replacements, status changes and connection generations retain their fences. A host409 clears the unchanged card and Send hold. Native23iOS/121Android pass, Android lint/instrumented compilation pass, and standalone plans144 pass from a fresh source archive after its pretest builds the file mutator. Release-policy20Ruby/42assertions+30Node and registry15 pass. No wire revision, DTO, UI layout or authority change. C=`55a13fff6`; merged into D with union of every D test script and the C helper prerequisite, and both C reconciliation prose and D Remote57 docs retained. Fresh narrow Opus review remains pending before C/D push. The CLI10-second replypoll failure recurred on A’s hosted CI and remains unresolved, with no further unchanged rerun or weakened limits. All earlier retained observations and acceptance limits remain.


### 2026-11-04 — PR729 correction source acceptance and standalone prerequisites

Opus5.5 medium round7 accepted `ffd1175cf` for the narrow correction on the cumulative source basis with no Blocking/Important/Medium finding. Both native identical-snapshot fixes and standalone plans prerequisite are source-accepted; no further runtime correction was requested. Root addressed Low R7-1 on B: clean-source access84pass/3fail before the helper build,87pass after; issues47pass with the helper absent. C/D retain both helper prerequisites and all D scripts. Low R7-2 wording now describes explicit response invalidation, not every transport reconnect. D integration native30iOS/123Android plus lint/instrumented compilation passed. No DTO, revision, authority or visual layout changed after the accepted checkpoint. PR pushes require fresh CI; A’s CLI delivery timing failure remains unresolved and no merge is authorized.


### 2026-11-04 — CLI delivery latency candidate awaiting narrow source review

All accepted PR728/729 corrections and standalone helper prerequisites are pushed. Root then reproduced an independent accepted-delivery problem: the courier’s identity checks could block on unrelated full-roster availability discovery. A-only correction `2f9ff8ad4` adds an optional identity-only dependency, wired only on the CLI to the Bot store; desktop callers retain the original fallback. Posting still checks the full roster, and session state/send retains fresh pause, permission, model and spending checks. No cached authority or retry loop is introduced. Five behavioral cases cover delivery under an unrelated discovery fault, absent/unreadable identities, deletion while an identity read is held, and a fresh send refusal after a positive identity result. Three genuine RED failures preceded production edits.

A checks passed messaging94/runtime346/wholetypes/scopedlint, rebuilt CLI268files27MiB/types and full183pass/3existingPTYskips/0fail on its first changed-source run. The original10-second final-reply poll is unchanged. Separate fake-provider timing traces showed five roster reads2673ms before versus one499ms roster and four0ms identity reads after. This proves redundant work was removed, not the exact cause of the original hosted timeout. The failure at run41889886501/job126785109246 and all retained observations remain disclosed. Integrated top checks and a fresh narrow Opus5.5 medium review are pending; no new runtime push or merge is authorized by these results.


### 2026-11-04 — Identity-only relay source acceptance and review dispositions

Opus5.5 medium round8 accepted `08a43712d` for narrow source safety on the cumulative program basis with zero Blocking/Important/Medium findings. The previous existence check already ignored availability flags; session state/send still enforce all fresh effect checks. The real-store/roster probes verified compatible identity filters and caught per-Bot availability errors. No runtime correction was requested. Root addressed all three Low dispositions with tests and corrected dated evidence, without changing runtime code: both target/reply tests hold the second immediately pre-send read and detect removal of the post-await guard; the CLI parity case detects removal of its identity port and refuses null identity before session inspection/model traffic.

Evidence correction: the original full-roster rejection was a fixture injection, not a production per-Bot error path, since `projectBotMessageRoster` catches those errors. The measured redundant admissions are real latency; a hang and the exact hosted timeout cause remain unproven. The earlier first-read deletion test did not independently prove the final guard. New tests do: both pass on HEAD and both fail on the recheck mutant; the negative CLI case passes and its wiring mutant fails1versus0 session reads. A follow-up messaging95, types and lint pass. Full candidate CLI runs183pass/3existingPTYskips on A and integrated D used unchanged timing assertions; the subsequent expanded parity case passes independently. This still does not erase the historical failures on A336fe65e4 or D311a63382. Their run links stay in PR descriptions. Source acceptance is not CI, physical/device/native-rendering, signedKeychain, liveprovider, package/release or merge authorization.

R7 B/C/D fixes are already pushed and Pullfrog reports no new issues on each current published head, with the four B/C finding threads resolved. The identity-only candidate and test-only follow-up are now ready for push after final merged checks. Fresh exact-head CI/review must run on all four new heads. The owner’s no-merge instruction, provisional Remote54–57 revision recheck and every prior retained observation remain.


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
