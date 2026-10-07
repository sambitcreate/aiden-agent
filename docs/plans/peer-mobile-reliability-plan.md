# Peer and mobile reliability; subagent result delivery

Status: Active — mobile agent ancestry and connection reliability are implemented; physical-network acceptance, idle measurements, and background delivery slices remain open.

The reviewed decisions below supersede the historical research recommendations where they differ.
> Research snapshot: 2026-10-05 ~2 PM ET. Aiden `origin/main` = `43d8adb0` (past v0.53.0 `7e339cf1`; includes #343–#347). Upstream refs: t3code `3e6b45028`, pi-subagents tag `v0.76.0` = `99ccd391` (main `6826b054`), Pi `v1.0.3`.
> **Sequencing:** this series lands **after** the Pi 0.87.1 → 1.0.3 upgrade (separate prompt: `pi-1.0.3-upgrade-prompt-2026-10-05.md`, built on PR stack #299–#307). See §2.

---


## Approved implementation decisions (2026-10-05)

User approved saving this plan and starting implementation after source review.
Default scope is delivery/wake infrastructure with model-facing background launches
still disabled, no automatic restart wake, and no manual-route or mobile-route UI.
Agent notification deep links are deferred. Those follow-ups do not block this series.

Start item 3 now, independently of the Pi upgrade and #346. Keep its implementation
in a separate commit from this plan. Items 4a/4b retain their Pi merge dependency;
item 2 waits for #346. Recheck #350 (peer chat forks) alongside #349 and #312.
Do not mark existing physical-device acceptance gates complete based on simulator tests.

### Implementation progress

- 2026-10-05: plan committed as `1c992a82` on `feature/peer-mobile-reliability-plan`.
- Item 3 navigation foundation: Swift and Kotlin public-roster navigation state,
  serializable scope/path, full ancestor entry, Back, direct children, bounded/cycle-safe
  ancestry and live-roster reconciliation implemented. Behavioral cases added to the
  existing native progress/chat suites. iOS build and all 235 AidenChatTests pass on
  iPhone 17 Pro / iOS 27 simulator `9F4FDF41-3FE3-477D-B92B-127C43FE927E`
  (Xcode-beta, `CODE_SIGNING_ALLOWED=NO`). All 25 Android AidenChatProgressTest
  cases pass; Android `lintDebug` and `compileDebugAndroidTestKotlin` also pass.
  No physical-device or UI-restoration acceptance is claimed.
- Item 3 UI wiring is implemented: iOS uses a bound NavigationStack and Android
  uses one sheet with a saved, scoped navigation model and the dialog's system-Back
  dispatcher. Both show Started by and Sub-agents actions, update from the selected
  roster and prune vanished details. Pairing/read-access changes fence the inspector.
  Scrim/drag dismissal closes the sheet; the parent chat stays mounted.
  Review follow-up: the Android inspector owner remains composed while server
  negotiation and roster reads load. Its scoped saved path waits without displaying
  cached agent content before confirmed access; denial or unpairing discards it.
  Emulator tests exercise delayed hydration after saved-state restoration and the
  child → parent → roster Back sequence, plus denial and unpairing while loading.
  Verification: all 25 Android progress unit tests, `lintDebug`, instrumentation
  compilation and all 10 `AidenChatProgressUiTest` cases pass on
  `Medium_Phone_API_36.1` (Android 16). iOS test build and the final 235-test
  chat suite pass on the simulator recorded above. `npm run test:ci-policy`
  passes. Physical-device acceptance remains open.
- Items 1, 2 and 4 were not implemented by the initial navigation work. No background activation,
  Remote revision change, new network call, or onboarding capability is introduced.

### Connection implementation follow-up (2026-10-06)

Desktop route learning, encrypted persistence, LAN preference, failover, preference
preflight, route suppression/restore, and authenticated LAN CA delivery are implemented
in the connection-reliability change. Healthy wake notifications probe before replacing
feeds. Contract revision 25 adds desktop-only route trust, explicit Android phone
identity, and epoch-fenced progress resumes. Behavioral/TLS fixtures cover both initial
pairing directions, key renewal, rejected identity before request bytes, suppression,
and retaining healthy streams. Physical packaged LAN/Tailscale acceptance and idle
CPU/wakeup measurements remain open; this plan stays Active pending those gates.

Approved initial-discovery clarification: Bonjour may publish one bounded canonical
`.local` hostname hint for Android pairing because its DNS-SD API can expose only the
IP address. This is not trusted learned-route advertising: no endpoints list, pins,
CA material or credentials appear in TXT, and setup-code/QR trust remains mandatory.

Desktop and native uncertain turn/run-input requests now retain their original request
identity across recreation, require explicit retry inside the replay window, and retain
expired ambiguity for review. Desktop records are encrypted and admission checks the
original pairing. Native recovery parks offline and preserves epoch-scoped progress
cursors and credential-scoped conditional-read caches. Connection UI distinguishes
transport readiness from chat synchronization and provides recovery guidance.

### Required design corrections and gates

- **Route trust bootstrap:** system-trust/Tailscale pairing does not supply the LAN
  private CA. Before 1a, define bounded CA delivery over the already verified paired
  channel, with route-specific certificate/hostname/SPKI validation; otherwise require
  explicit LAN pairing and label automatic Tailscale-to-LAN learning unsupported.
  Never assume the CA exists. Test both initial pairing directions.
- **Verification order:** TLS validates trust, hostname and pin before credentials.
  `instanceId` is checked in authenticated `/server`, before accepting advertisements
  or subsequent operations; it cannot be checked in the TLS handshake. Scope verification
  caches to route plus trust revision. Refresh advertisements on bounded reconnect/wake
  verification. Keep all probe costs in the request budget.
- **Route removal and failover:** persist suppression of a removed learned route until
  explicitly restored or pairing is reset. Exempt recovery from a dead active route from
  the 30-second preference-switch limit. A failed preferred route cannot prevent recovery.
- **Mobile retry gate:** prove exact attempt correlation before treating GET chat as proof
  of acceptance; message-text matching is forbidden. The current request has no client
  message ID. Same-key replay is for ambiguous attempts inside the guaranteed replay
  window (ledger default: 24 hours after settlement). Definitively uncommitted, cached
  rejections require a new explicit attempt, not endless replay of the rejection.
  An unresolved or expired attempt must never silently become a fresh send. If a bounded
  receipt lookup/correlation contract is needed, revise the no-contract-change claim and
  update every contract consumer together. Keep the exact request and original stream ID
  for run-input retry. Clear only the matching restored draft, preserving later edits.
  Say “Couldn't confirm delivery” for ambiguous failures. Queue only requests representable
  by the existing text-only run-input contract; attachments/skills need explicit recovery.
- **Host-authored admission:** the current `createChatRunInputAdmission` writes `role:user`.
  Add an internal host-result path sharing admission/cancellation invariants without
  exposing host-authored message authority through public Remote input.
- **Delivery protocol:** use a stable result/message ID, idempotent journal insertion,
  acknowledgment of consumption of that specific message, and reservation-generation
  fencing. A busy parent's existing turn-start event is not delivery acknowledgment.
  Reject delayed wake callbacks after lease expiry/replacement. Test crashes between
  result commit, journal append, consumption and acknowledgment. Preserve completed
  child outcomes on quit; interrupt active execution separately from pending delivery.
- **Wake authority and liveness:** revalidate workspace/Bot policy and revocation at
  admitted wake time. Do not inherit unattended privilege merely from current model/tools;
  approvals remain required even with a closed window. Separate pending-delivery retention
  from running-generation admission/capacity. After restart, waiting for the next user turn
  must not hold an execution lease or manufacture an active run indefinitely.

These gates are part of acceptance, not optional follow-ups. In particular, items 1a,
2 and 4b cannot claim completion until their trust/correlation/authority choices and
behavioral tests are documented. Do not activate background launches as a shortcut.

## 0. Goal and scope

Ship four upgrades as a sequence of small, reviewable PRs. Adapt the upstream ideas to Aiden's architecture. Do not copy T3 Code or pi-subagents code wholesale.

1. **Multi-route reachability for paired peer Macs** (adapted from T3 #15467 + #15468). This is the next step for the multi-host stack (0.53.0, #313–#337, HostRunRegistry / run observer bus #310). A desktop should reach a paired peer over several routes (LAN, Tailscale, plus the simulator relay that exists today). It should learn and persist the peer's routes and LAN addresses, pick the best working route, fail over, and move back to the better route when it returns.
2. **Mobile in-thread send-failure reasons with Retry** (adapted from T3 #15807) on iOS (Swift) and Android (Kotlin).
3. **Mobile subagent back-navigation** (adapted from T3 #15068 + follow-up #15844). Backing out of a child agent returns to its parent agent, then the roster, then the parent chat, on iOS and Android.
4. **Subagent results keep the session alive until they reach the parent, and wake an idle parent** (adapted from pi-subagents v0.76.0, plus the related post-tag fix #2689). Build this into Aiden's native host-managed subagent implementation. **Do not** add the pi-subagents plugin.

### Aiden stance (non-negotiable)
- The Mac is the authority for Remote / On The Go. Clients render host projections and never invent state or endpoints.
- Subagents are host-managed Pi `Agent` children inside Electron main. OpenCode is a provider, not a child runtime.
- Hermex is UX inspiration only. No Hermes gateway.
- Private child transcripts stay on the Mac. Mobile shows bounded public agent projections only.

### Before you start (required reading)
- `AGENTS.md` (root), `ios/AGENTS.md`, `android/` notes if present, and `.memory/` (especially `.memory/multi-host-control.md` and the subagent notes). Update `.memory/` notes as you go.
- `docs/aiden-remote-api-v1.md` (§5 `GET /server` ~L182, §7 idempotency, §9 Transport identity ~L469, "Operating multiple devices" ~L477, §10 Contract change process).
- `docs/plans/README.md`, `docs/plans/subagent-orchestration-expansion-plan.md` (Phase 7B and the verification matrix ~L779+), `docs/plans/mobile-task-progress-and-subagents-plan.md`, `docs/plans/completed/desktop-multi-host-control-plan.md` (efficiency budgets ~L259), `docs/plans/completed/aiden-native-subagents-plan.md`.
- UI: `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md`, `docs/chatgpt-ui-element-specimen.html`, and the settings design system. No decorative colored borders. Keep focus-visible rings. Use soft semantic status fills.

### Upstream references (read-only; clone or use `gh`)
- T3 Code `pingdotgg/t3code`:
  - #15467 (`979ca66ce`), multi-route: `packages/client-runtime/src/connection/routes.ts`, `driver.ts` (`connectOverRoutes`, `preflight`), `supervisor.ts` (better-route checks, `BetterRouteAvailable`, cooldown), and the settings route list.
  - #15468 (`745c225f9`), learned routes: server `DirectEndpoints.ts` (`resolveBoundEndpoints`, virtual-interface filter, Tailscale Serve probe), `packages/contracts/src/server.ts` (`ServerConfig.directEndpoints`), and client `mergeLearnedRoutes` / `routesAfterRemoving`.
  - #15807 (`a1d9d72ae`), send failure in the thread: `apps/mobile/src/state/thread-composer-error.ts`, `use-thread-outbox-drain.ts`, `ComposerErrorNotice.tsx`.
  - #15068 (`01f894e23`) and #15844 (`1604ccc9d`), subagent back navigation: `thread-subagent-group.tsx` and `thread-work-log.tsx` switched from `navigate("Thread")` (which replaced the screen) to `StackActions.push`. The Agents sheet keeps `replace` on purpose.
- pi-subagents `nicobailon/pi-subagents`:
  - **v0.76.0** (`99ccd391`):
    - #2683 (`50412418`), owed-result ledger. Session liveness stays active until Pi `message_start` of the wake turn: `src/extension/index.ts` (`owedResultRunIds`, `deliveredRunIds`, `holdOwedResult`, `onJobTerminal`, `onResultDelivered`), `src/runs/background/notify.ts` (`unstartedWakes`, `messageStarted()`, `hasPendingDelivery()`), `async-job-tracker.ts` (`onJobCleanup`). Test: `test/unit/session-liveness-delivery.test.ts`.
    - #2666 (`3bb9b203`), a headless turn end drains finished results before settling: `result-watcher.ts` (`deliverPendingResults`), notifier `flush`. Test: `test/unit/agent-end-auto-drain.test.ts`.
  - **Post-tag, unreleased on main (not in v0.76.0, but relevant):**
    - #2689 (`65dff229`) `src/shared/parent-wake.ts` `createParentWake`. For an idle parent it appends the notice with `triggerTurn:false`, then sends a steer user message so the run passes `before_agent_start`. It holds a 10 s `WAKE_PENDING_MS` reservation per session that survives reload, plus `isPending`. Test: `test/unit/parent-wake.test.ts`.
    - #2687 (`7fd88df8`) keeps queued wake ownership across reload, scoped to the session UUID.
    - Root cause behind #2689: Pi issue earendil-works/pi#5581 (`sendMessage({triggerTurn})` bypasses `before_agent_start`) is **still open**.

---

## 1. Start state to verify (do this first; numbers drift)

```bash
git fetch origin && git log -1 origin/main
grep -n "AIDEN_REMOTE_CONTRACT_REVISION" main/services/aiden-remote-protocol.ts   # rev 20 at research time
gh pr list --state open --limit 50
```

Overlapping open work (as of research; re-check):

| PR / issue | What | Impact on this series |
|---|---|---|
| **#299–#307** (`codex/pi-1-*`) | Pi 1.0 stack, being reconciled and bumped to 1.0.3 by the parallel prompt. Touches `main/services/pi-agent-runtime-harness.ts`, `main/services/subagents/child-agent-runtime.ts`, `generation-context.ts`, `llm-client.ts`, subagent env, CLI | **Item 4 depends on it.** Start item 4b only after it merges. Item 4a (pure core) can be written earlier but must merge after it |
| **#346** `feature/unified-send-control` | Unifies the busy Steer/Queue pill and removes Redirect. Touches iOS `AidenChatFeature.swift` (`runInputPill`, `offersRunInput`, `canSubmitRunInput`), `Models/AidenChat.swift`, Android `AidenComposerView.kt` (`AidenRunInputPill`), `AidenChatViewModel.kt` (`runInputMode`), `AidenChatDetailScreen.kt` | **Item 2 conflicts.** Build item 2 on top of #346 (after it merges, or merge its branch in) |
| **#349** chat fork from paired devices | Claims contract **rev 21** (`chat-fork-v1`, `chat-fork-summary-v1`) | Item 1a claims the **next revision after main at merge time** (likely 22, or higher if #312 or #349 merge first) |
| **#312** app controls | Changes the iOS and Android contract plus `AidenChatFeature.swift`, `AidenChatViewModel.kt`, `AidenChatDetailScreen.kt`, both coordinators, revision-assertion tests | Possible revision race and textual conflicts with items 1a and 2. Merge `origin/main` before claiming a revision |
| #341, #348, #340 | Compaction and others | No direct overlap found. Re-check files |
| Issues #87 (TLS endpoint verification timeout in `remote:beginPairing`), #86 (`tailscale_permission_denied`), #88, #118 | Pairing/Tailscale reliability | Not duplicates. Item 1 must not make #87/#86 worse. Mention them in PR bodies if the route probe touches the same code |

None of the open PRs or issues implement any of the four items.

---

## 2. Ordering and PR split

| # | PR | Depends on | Contract bump |
|---|---|---|---|
| 1 | **4a. Subagent owed-result ledger + wake planner (core, production-inert)** | Pi 1.0.3 merged (merge after it; write it anytime) | No |
| 2 | **4b. Host wiring: liveness, quit guard, idle/busy parent wake** | 4a, and the Pi 1.0.3 stack merged | No (Remote projection unchanged) |
| 3 | **3. Mobile agent-detail ancestry + back stack (iOS + Android)** | None (client-only) | No |
| 4 | **2. Mobile in-thread send-failure notice + Retry (iOS + Android)** | #346 merged | No |
| 5 | **1a. Host advertises routes on authenticated `GET /server`** | main at merge time | **Yes: next revision** |
| 6 | **1b. Desktop route store, selection, failover, come-home** | 1a | No (consumes 1a) |
| 7 | **1c. Connections settings route UI + docs + `.memory`** | 1b | No |

Why this order:
- Item 4 risks the most correctness problems (lost or duplicate results, stale agent state) and is entangled with the Pi upgrade's harness changes. Land it right after that upgrade, while the harness is fresh in reviewers' minds.
- Items 3 and 2 are client-only and independent of Pi. Item 3 is smallest. Item 2 waits for #346.
- Item 1 is the largest and is security-sensitive (TLS trust and pinning). It also needs a contract revision, which should be claimed after #349 / #312 settle.
- Items 2 and 3 may be developed in parallel branches. Keep each PR focused and never stack unrelated items.

Branch and PR hygiene (from `AGENTS.md`):
- On shared branches, merge `origin/main`. Never rebase or force-push.
- Register every new test file in the right `package.json` script, and union-merge conflicts in the root test chain.
- A PR is mergeable only with green CI at the exact head. Run the narrow local suites before requesting bot reviews.
- Rerun a flaky failure at most once, then document it.
- Shared server contract or transcript changes must be checked against both native clients, with their suites run.

### Interaction with the Pi 0.87.1 → 1.0.3 upgrade
- **Same files:** `pi-agent-runtime-harness.ts` (`queueSteer`, `queueFollowUp`, `queueAdmissionBlocked`, `takeUndeliveredQueuedMessages`, `waitForIdle`), `subagents/child-agent-runtime.ts`, `generation-context.ts`, the `package.json` test chain, and `docs/plans/README.md`. Expect textual conflicts if both are in flight, so do not start 4b until the upgrade is on main.
- **Semantics to recheck on 1.0.3:** `Agent.steer()`, `Agent.followUp()`, `followUpMode` (`PendingMessageQueue`, default `"one-at-a-time"`), and idle detection still exist in `packages/agent/src/agent.ts` at v1.0.3. Confirm their delivery timing against Aiden's harness before relying on them for the busy-parent path.
- **CLI:** pi#5581 is still open, so a CLI-side wake must **never** use `sendMessage({triggerTurn:true})`. It would skip Aiden's `before_agent_start` hooks (`packages/cli/src/extensions/subagents.ts`, memory, advisor, session-parity, `daemon-chats.ts`).
- The legacy `@aiden/pi-legacy-harness` (0.87.1 alias) boundary from the upgrade stays as is. Item 4 must not import journal or compaction helpers from the 1.0.3 package.
- Items 1–3 don't depend on Pi. The only conflicts are in the shared `package.json` test chain and docs index, plus mobile provider-icon files from the Azure rename (different files from the ones items 2 and 3 touch).

---

## 3. Item 4: subagent results keep the session alive and wake an idle parent

### 3.1 What upstream does
- **v0.76.0 #2683:** each background job whose result is owed to the parent goes into an owed set (`owedResultRunIds`). Session liveness (the "don't exit / still working" signal) stays true while any result is owed **or** a wake has been queued but not started (`unstartedWakes`). A result counts as delivered only when Pi emits `message_start` for the turn that carries it (`messageStarted()` → `onResultDelivered`). Job cleanup does not drop an owed result.
- **v0.76.0 #2666:** when a headless/print turn ends, finished results are drained into the parent (`deliverPendingResults`, notifier `flush`) before the session settles, so a CLI `-p` run doesn't exit with results stranded.
- **Post-tag #2689/#2687 (adopt the idea, not the code):** waking an idle parent with `sendMessage(triggerTurn)` skipped `before_agent_start` (prompt, tool and memory injection). The fix is to append the notice without triggering, then start a real user-path turn, keep a 10 s pending reservation per session, and survive reloads. A busy parent gets a steer.

### 3.2 What Aiden has today (verify)
- Production children are **foreground-only**:
  - `main/services/subagents/subagent-tool-assembly.ts` throws `"Background subagent tool assembly is unavailable."`
  - `subagent-supervisor-core.ts` `SubagentSupervisor.execute` awaits children, and descendants drain before their ancestor completes.
  - So foreground results already reach the parent inline as tool results. **The upstream bug cannot happen on today's foreground path. Don't "fix" it there.**
- The background lifecycle exists but is **production-inert**:
  - `subagents/background-lifecycle-v2.ts` defines `BackgroundSubagentLifecycleV2`, `BackgroundSubagentRunV2 {manifest, snapshot, events, steering, waitCount, waitedMs}`, event kinds `accepted|transition|wait|steer|stop_requested|reconciled`, `BackgroundSubagentHooksV2 {stop, steer}`, and accept/manage/transition/`reconcileStartup`/`chatDeleted`/`workspaceRevoked`/`shutdown`.
  - `subagents/background-subagent-coordinator-v2.ts` defines `BackgroundSubagentCoordinatorV2`, which nothing instantiates.
  - `subagents/feature-flag.ts` `subagentBackgroundEnabled()` is unused.
  - Tests: `test:subagents:phase7a`.
- The plan says "Phase 7B coordinator activation is next" (7A, 7B1, 7B2 done). The verification matrix requires:
  - result commit before terminal publication and notification
  - no repeated wakes for an unchanged status
  - crash-point tests
  - notifications and deep links
  - app quit → interrupted
- Host seams to reuse:
  - `main/services/host-run-registry.ts` (`HostRunRegistry`)
  - `chat-turn-admission.ts` (`ChatTurnAdmission`)
  - `conversation-surface-generation.ts` (`scheduledGenerationSurface`, `remoteGenerationSurface`, `startSurfaceGeneration`): the model for a host-started turn
  - `chat-generation-owner.ts`
  - `chat-run-input-admission.ts` (`createChatRunInputAdmission`)
  - `renderer/shared/chat-row-state.ts` (used by `aiden-remote-chats.ts`)
  - `main/index.ts` before-quit → `requestApplicationQuit`
  - `telegram/telegram-turn.ts` (Telegram Bot path)
  - `pi-agent-runtime-harness.ts` queue APIs

### 3.3 Design
This is the "result delivery + parent wake" slice of Phase 7B, built so that activating background launches later is safe. **Do not** expose a model-facing background launch tool in this series unless Sambit explicitly approves turning on Phase 7B (see §11). With the launch hidden, 4b's wiring is reached only through tests and an internal or dev path. Say so plainly in the PR body.

**4a: core (pure, injected clock/IO, no Electron):**
- Add an owed-delivery state to `BackgroundSubagentRunV2`: `delivery: "none" | "owed" | "waking" | "delivered" | "discarded"`. Include `owedAt`, `wakeReservation?: {id, chatId, reservedAt, expiresAt}`, and `deliveredTurnId?`.
- Add event kinds (`result_owed`, `wake_reserved`, `wake_started`, `result_delivered`, `result_discarded`). Keep the strict parser backward-compatible: an old record with no delivery fields parses as `"none"`.
- The terminal transition and the owed result commit **atomically** in one CAS-guarded write, before any terminal publication or notification (this matches the plan's matrix).
- Wake planner (pure function or class), inputs: owed runs per parent chat, parent state (`busy` | `idle` | `closed` | `deleted` | `revoked`), and existing reservations. Outputs:
  - one batched wake per parent chat, deduped across runs; no repeated wake for an unchanged status
  - busy parent: queue a follow-up at the next safe boundary
  - idle or closed parent: start a host turn
  - deleted chat: discard
  - workspace revoked or user stop: settle as stopped, no wake
- Reservation timeout (default 10 s, injectable). If the wake turn hasn't started by then, the result goes back to `owed`, not dropped, and is retried with bounded backoff on the next idle signal. **Never drop an owed result silently.**
- A result becomes `delivered` only when the wake turn has actually started (Aiden's equivalent of Pi `message_start`) **and** the host-authored result message is durable in the chat journal.
- `reconcileStartup`:
  - `waking` → `owed`
  - `owed` stays owed and gets delivered with the next turn of that chat
  - no automatic restart wake unless Sambit decides otherwise (§11)
  - runs still executing at quit → `interrupted` (per plan), and the parent is told on its next turn

**4b: host wiring (after the Pi upgrade):**
- Liveness: chat `rowState` "working", `HostRunRegistry` presence, the before-quit guard (`requestApplicationQuit`), and the headless paths (Bot/Telegram, scheduled, CLI daemon chats) treat `owed` and `waking` as live. Quit while results are owed: follow the existing quit-confirmation pattern, preserve completed child outcomes and owed delivery, and interrupt only active execution.
- **Busy parent:** deliver through the shared run-input admission (`createChatRunInputAdmission` / harness `queueFollowUp`) at a safe boundary. Don't call `agent.followUp()` directly.
- **Idle or closed parent:** start a new host-started turn through `ChatTurnAdmission` with a new generation surface (modelled on `scheduledGenerationSurface`, e.g. `subagentResultGenerationSurface`). That turn rebuilds the system prompt, tools, skills, MCP and model catalog like any turn. **Never** resume a stale `Agent` instance with `continue()` or `followUp()`. Insert the result as a **host-authored** message (the subagent-result kind), never as a user message, and keep it bounded (summary plus reference, not a raw child transcript).
- Respect turn admission: if a user turn grabs the chat first, the owed result rides along on that turn's boundary (busy path) instead of starting a second turn.
- Bots and scheduled tasks: same planner. A Bot with no foreground UI still gets its wake turn. Telegram replies go through the existing Bot outbound path.
- CLI (`packages/cli`): if the CLI daemon later hosts background children, use the same ledger semantics with a `sendUserMessage`-style wake through `before_agent_start`, never `sendMessage(triggerTurn)` (pi#5581). If the CLI has no background children today, add no CLI code. Just document it.
- Remote / mobile projection stays **parent-only**: no child transcript, no new contract fields. The parent row simply shows working while results are owed.

### 3.4 Edge cases to cover
- Parent idle, then closed (window or chat closed), then the app relaunches: the result is delivered once, on the next turn, with no duplicate.
- Two children finish within milliseconds: one batched wake with both results.
- A wake is reserved but the turn fails to start (provider error or admission rejection): back to owed, retried on the next idle signal, liveness kept.
- A user sends a message while a wake is pending: no second turn, the result rides with the user turn, delivered exactly once.
- Parent chat deleted mid-wake: discard, liveness released.
- Workspace revoked: settle as stopped, no wake.
- Crash between the terminal commit and the publication or wake: on restart the result is still owed (crash-point test).
- Duplicate `result_delivered` after a replayed event: idempotent.
- The model changed in the parent between child start and finish: the wake turn uses the parent's current settings.

### 3.5 Files (expected)
- `main/services/subagents/background-lifecycle-v2.ts` (+ `.test.ts`), `background-subagent-coordinator-v2.ts` (+ `.test.ts`), and a new `subagents/subagent-result-delivery-core.ts` (+ test) if the planner is cleaner as its own module.
- 4b: `conversation-surface-generation.ts`, `chat-turn-admission.ts`, `chat-run-input-admission.ts`, `host-run-registry.ts`, `chat-generation-owner.ts`, `renderer/shared/chat-row-state.ts`, `main/index.ts` (quit guard), the Bot/Telegram turn path, and `subagents/feature-flag.ts` (gate).
- Tests go into `test:subagents:phase7a` (or a new `test:subagents:phase7b` lane included in `test:subagents` and in the root chain).

---

## 4. Item 3: mobile subagent back-navigation (iOS + Android)

### 4.1 What upstream does
In T3 mobile, tapping a subagent card or a "Subagent finished" work-log row used `navigate("Thread")`, which replaced the parent thread. Back then skipped the parent. They now `push`, so back returns to the parent at its scroll position. The Agents sheet still uses `replace` on purpose.

### 4.2 What Aiden has (big adaptation)
- Mobile has **no subagent threads**. Per `docs/plans/mobile-task-progress-and-subagents-plan.md`, "Private child transcripts stay on the Mac". Agent rows open a bounded public detail view.
- **iOS** `ios/AidenOnTheGo/Models/AidenChatProgress.swift`:
  - The agents sheet `agentList` is a `NavigationStack` with `NavigationLink(value: agent.agentId)` and `.navigationDestination(for: String.self)` → `AidenAgentDetailView` (~L575: Stop agent, Assignment/Run/Usage sections).
  - Roster rows are `AidenAgentRosterRow` (~L504), grouped flat by `AidenProgressPresentation.agentGroups`.
  - The sheet opens from `AidenChatFeature.swift` (`@State progressSheet: AidenProgressSheet?` ~L4094, `.sheet(item:)` ~L4221, `openAgents` ~L4419).
- **Android** `features/chat/AidenChatDetailScreen.kt`:
  - `progressSheet` uses `rememberSaveable` (~L183), but `selectedAgent` uses plain `remember` (~L184), so it is **lost on configuration change or process recreation**.
  - `AidenAgentRosterSheet` (`AidenChatProgressControls.kt` ~L441–449) sets `onAgentClick = { selectedAgent = it }`, and `AidenAgentDetailSheet` (~L549) stacks on top.
- App navigation: Android `navigation/AidenNavigationStack.kt` (`AidenScreen`, push/pop/resetTo, `MAX_DEPTH` 16, Saver). Deep links: Android `notifications/AidenDeepLink.kt` (chat, botChat), iOS `LiveActivities/AidenDeepLink.swift`.
- Both clients already decode `parentAgentId` (depth ≥ 2; iOS `AidenRemoteContract.swift` ~L1739, Android `models/AidenChatProgress.kt` ~L109), but **no UI uses it**.

### 4.3 Design (client-only, no contract change)
- Agent detail gains:
  - a "Started by <parent label>" row when `parentAgentId` resolves in the current progress snapshot
  - a "Sub-agents" section listing direct children (same `AidenAgentRosterRow` / Compose row style)
  - optional indentation of children under their parent in the roster, if it reads cleanly per the design guide (no colored borders)
- Explicit navigation path of agent IDs:
  - iOS: `NavigationStack(path: $agentPath)` with `[String]`
  - Android: `rememberSaveable` `List<String>` path (fixes the lost `selectedAgent`), plus `BackHandler` that pops one level
- Back behavior:
  - back or swipe-back from a child goes to its **parent agent detail**, then the roster, then the chat at its preserved scroll position
  - swipe-down or scrim dismiss of the sheet goes straight back to the chat (sheet semantics)
  - opening a child from a parent's "Sub-agents" section pushes
  - opening a parent through "Started by" pops back to it if it is already on the path, otherwise pushes its full ancestor chain
- Any entry point that opens a specific agent (a roster row, or a future notification or Live Activity) builds the **full ancestor path** (root → … → agent) from `parentAgentId`, so back always walks up the tree.
- Robustness:
  - when a snapshot update removes an agent on the path, pop to the nearest surviving ancestor
  - reset the path on turn change, chat switch, Mac switch, revocation or unpair
  - guard against cycles (visited set) and enforce max depth (reuse 16)
  - unknown `parentAgentId` → treat the agent as a root
- **No new deep link in this PR.** If one is added later it must be client-URL only (e.g. `aiden-otg://chat?instance=…&chat=…&agent=…`), resolving chat → open the agents sheet → build the ancestor path → agent, and falling back to the chat when the agent is gone. No contract change, no credentials in the URL.
- Accessibility: "Started by" is a button with a label like "Open parent agent <name>". VoiceOver and TalkBack announce depth ("Sub-agent of <parent>").

### 4.4 Files (expected)
- iOS: `Models/AidenChatProgress.swift` (`AidenAgentDetailView`, `AidenAgentRosterRow`, `AidenProgressPresentation` — add a pure `ancestorPath(for:in:)` / `children(of:)` helper), `Features/Remote/AidenChatFeature.swift` (sheet host only if needed). Tests: `ios/AidenOnTheGoTests/AidenChatTests.swift`, or the existing progress tests there.
- Android: `features/chat/AidenChatDetailScreen.kt`, `features/chat/AidenChatProgressControls.kt`, and a pure helper in `models/AidenChatProgress.kt`. Tests: `app/src/test/.../AidenChatProgressTest.kt` plus `androidTest/.../features/chat/AidenChatProgressUiTest.kt` (back from child → parent, then roster).

---

## 5. Item 2: mobile in-thread send-failure reasons + Retry (iOS + Android)

### 5.1 What upstream does
T3 keeps a per-thread composer error map `{message, messageId}`, filled by the outbox drain instead of a global pairing error. It is cleared on resend, dismiss, delivery of that message id, or environment removal. `ComposerErrorNotice` shows the error above the composer with Dismiss and a screen-reader announcement, and the text goes back into the composer. It is mobile-only with no contract change.

### 5.2 What Aiden has
- **iOS** `ios/AidenOnTheGo/Features/Remote/AidenChatFeature.swift`:
  - `send()` (~L2153) inserts an optimistic `local-` message and calls `coordinator.remoteClient(for:).startTurn(chatId:request:idempotencyKey:)`.
  - On failure it removes the optimistic message, restores the text and attachments through `AidenDraftSendReconciliation.failedDraft/failedAttachments`, and sets `presentedError = error.localizedDescription`, shown as a **modal alert** (~L4225).
  - `AidenTurnAttemptTracker` (~L275) reuses the idempotency key for an identical request.
  - `submitRunInput` (~L2721) sends `AidenRunInputPresentation.rejectionMessage(result.reason)` to the same alert. The image-model preflight also uses `presentedError`.
- **Android** `features/chat/AidenChatViewModel.kt`:
  - `send()` (~L895) clears the stored draft before the request, then on failure restores and flushes it and sets `_presentedError.value = e.localizedMessage`.
  - `turnAttempts.key(request)` reuses the idempotency key.
  - `submitRunInput` (~L1530) behaves the same way.
  - `AidenChatDetailScreen.kt` (~L596) renders `presentedError` as a generic **error banner card**: no Retry, no Dismiss, not tied to a message or chat, and shared with read-aloud errors.
- Error envelope, decoded by both clients:
  - `code` from `AIDEN_REMOTE_ERROR_CODES` (`main/services/aiden-remote-protocol.ts` ~L295: `turn_already_active`, `rate_limited`, `payload_too_large`, `capability_denied`, `workspace_unavailable`/`workspace_changing`, `skill_unavailable`, `handle_expired`/`handle_invalid`, `idempotency_in_flight`/`idempotency_conflict`, `credential_revoked`, `server_interrupted`, `internal_error`, …)
  - plus `message`, `requestId`, `retryable`, `details.retryAfterSeconds`
  - iOS: `AidenRemoteClientError.server(statusCode:body:)` (`AidenRemoteClient.swift` ~L435), `AidenRemoteErrorEnvelope` (`AidenRemoteContract.swift` ~L773). Android: `networking/AidenRemoteClient.kt`.
- Idempotency (API doc §7): the same key with the same request replays the outcome, and the replay TTL starts at settlement.
- Mobile has **no outbox**; an offline outbox is a separate backlog item. `ios/AGENTS.md`: "TCP/SSE loss never retries a turn creation."

### 5.3 Design (client-only; no contract bump)
- Replace the modal alert (iOS) and the generic banner (Android) **for send and run-input failures** with a per-chat **in-thread failure notice** at the transcript tail, just above the composer. Other errors keep their current surfaces.
- Notice content:
  - a short mapped reason title
  - the server `message` when it adds information
  - **Retry**, when allowed
  - **Dismiss**
  - an optional "Details" disclosure with `code` and `requestId` (never a credential, URL or token)
- State: a coordinator-scoped store keyed by `(instanceId, deviceId, chatId)` holding `{reason, code?, requestId?, retryable, retryAfter?, attempt: {request fingerprint, idempotencyKey, kind: turn|runInput}}`. Because it lives on the coordinator, it survives leaving and re-entering the chat. Process death may clear it; don't persist a credential-adjacent payload.
- Clear the notice on:
  - a successful send or Retry
  - Dismiss
  - the user editing the restored draft into a different request (the fingerprint changes, so Retry gets a new key)
  - chat deletion
  - revocation or unpair
  - switching Macs (scoped by instanceId)
- Keep restoring the text and attachments to the composer exactly as today. The notice is in addition to that, not a replacement.
- **Retry** for an ambiguous attempt sends the **same request with the same idempotency key**, subject to the correlation and replay-window gate above (`AidenTurnAttemptTracker` / `turnAttempts`). For transport-level or ambiguous failures (timeout, connection reset, no response), first **reconcile once** with the existing chat fetch (`GET /chats/{id}` / `reconcileChat`). If the turn actually landed, clear the notice and the restored draft. Only otherwise resend with the same key. **Never auto-retry.** Retry is always a user tap.
- Reason mapping (one table shared in spirit across both clients; strings in each platform's localization):

| Code / condition | Notice | Retry |
|---|---|---|
| network unreachable / offline / timeout | "Couldn't confirm delivery to <Mac name>." | Yes, after reconcile |
| `server_interrupted`, `internal_error` (`retryable:true`) | "<Mac> hit a problem sending this." | Yes |
| `rate_limited` | "Too many requests. Try again in Ns." | Disabled until `retryAfterSeconds` elapses (countdown) |
| `turn_already_active` | "A reply is already running." | Offer **Queue** when run input is supported (post-#346 unified control). Otherwise Retry |
| `payload_too_large` | "This message or attachment is too large." | No; edit first |
| `handle_expired` / `handle_invalid` | "An attachment expired. Re-attach it." | No; re-attach |
| `workspace_unavailable` / `workspace_changing` / `skill_unavailable` / `capability_denied` | Specific reason | Only if `retryable` |
| `idempotency_in_flight` | "Still sending…" | Reconcile, no resend |
| `idempotency_conflict` | "This retry no longer matches; send again." | New key on the next send |
| `credential_revoked` | Existing revocation flow (no in-thread notice) | — |
| run-input rejection with `committed:true` | "Saved but not delivered to the running reply." | No |

- Accessibility: post a VoiceOver announcement (`AccessibilityNotification.Announcement`) when the notice appears. Use a TalkBack `liveRegion = Polite`. Retry and Dismiss get labels and are reachable by focus order. Keep focus-visible rings. Use a soft semantic danger fill, not a colored border.
- Offline: show the reason with Retry. Never queue for automatic send.

### 5.4 Files (expected)
- iOS: `Features/Remote/AidenChatFeature.swift` (`send`, `submitRunInput`, the alert host), a new `Models/AidenSendFailure.swift` (pure mapping + store), `Features/Remote/AidenRemoteCoordinator.swift` (store ownership and clearing on revoke or switch). Tests: `AidenChatTests.swift`, `AidenRemoteClientTests.swift` (envelope → reason mapping from fixtures).
- Android: `features/chat/AidenChatViewModel.kt`, `features/chat/AidenChatDetailScreen.kt` (notice composable replaces the send-error use of the banner), a new `models/AidenSendFailure.kt`, `features/remote/AidenRemoteCoordinator.kt`. Tests: `AidenChatTest.kt`, `AidenRunInputTest.kt`, `androidTest/.../AidenComposerUiTest.kt` (notice renders, Retry fires once with the same key, Dismiss clears it).
- Use the shared error fixtures in `protocol/aiden-remote/v1/fixtures/contract.json` as test input. Don't invent new JSON shapes.

---

## 6. Item 1: multi-route reachability for paired peer Macs

### 6.1 What upstream does
- **T3 #15467:** each environment has an ordered route list ranked loopback < lan < tailnet < public < ssh < relay (`routes.ts`: `insertRoute`, `upsertRoute`, `findRouteToSameAddress`).
  - `connectOverRoutes` runs parallel **unauthenticated** descriptor checks (2.5 s, no credential sent). Silent routes are tried last. Only an "unsupported" result stops the walk. Transient errors are reported over blocked ones.
  - The supervisor checks for a better route only while on a fallback: every 60 s, on network change, and on foreground. `BetterRouteAvailable` swaps the session and moves durable subscriptions.
  - A route that failed after a switch gets a 5 min cooldown. One check runs at a time. The establishment timeout scales with the route count.
  - Settings show "via LAN · Connected · N routes" with an expandable list (reorder, remove, add). Pairing refuses an address that reaches a different machine.
- **T3 #15468:** the server reports bound LAN and tailnet IPv4 addresses (skipping docker/br-/veth/bridge, loopback and link-local), plus the Tailscale Serve name after a 3 s probe, in an optional **post-auth** `ServerConfig.directEndpoints`.
  - The client merges them as learned routes (`mergeLearnedRoutes`) that borrow the active credential. Routes the server stops reporting are dropped. User routes are never touched. Loopback is skipped, and so is http on https pages.
  - A route-list change never replaces the live session.
  - T3's learned routes are **plain HTTP**. **Aiden must not copy that.**

### 6.2 What Aiden has (verify)
- `main/services/peer-host-registry.ts`:
  - `StoredPeerHost extends PeerTrust { endpoint, serverSpkiSha256, caCertificateDerBase64? }` plus `id`, `credential`, `enabled`, `capabilities`, `features`, parsed by `parseStoredPeerHosts`. **One endpoint per host.**
  - One keep-alive `https.Agent` per hostId (`agents` map). `client()` passes `lookup: lanAddresses.lookupFor(instanceId)` for `.local` endpoints.
  - `verify()` (~L336) already calls **authenticated `GET /server`** once per host (cached in `verified`/`negotiated` sets), checks `protocolVersion`, and treats an `instanceId` mismatch as `identity_changed` (never repinned). Features are parsed with `peerStrings(server.features ?? [], 32)`.
  - `run()` retries once on `identity_changed` via `repin` → `confirmRepin`, which only works for system-trust (Tailscale) hosts. Private-CA LAN hosts stay strictly pinned.
  - `rememberLanAddress(id, address, spki)` accepts an address only when the SPKI matches the pin. `relayTarget()` serves the simulator relay. `PeerPairingTarget.route: "tailscale" | "lan"`.
- `peer-lan-addresses.ts` `PeerLanAddresses`: Bonjour IPv4 per instanceId, **in memory only**, max 64. `lookupFor` falls back to them only when system DNS fails for `.local`. TLS still validates the `.local` name, the private CA and the SPKI pin. **This is already a learned-LAN-address mechanism. Extend and persist it rather than adding a parallel one.**
- `peer-discovery.ts` / `peer-discovery-main.ts`: Bonjour `_aiden-agent._tcp` plus `tailscale status --json` desktop peers. `PEER_PROBE_TIMEOUT_MS` 3000, concurrency 4, `lanAddress` callback.
- `peer-transport.ts`: `PeerTransport`, `PeerTransportError` codes (`identity_changed`, `unavailable`, `request_failed`, `unsupported_protocol`, …), `createPeerAgent`.
- `peer-host-manager.ts` `PeerHostManager`:
  - states connecting → connected → backoff (`PEER_BACKOFF_STEPS_MS` [3s, 4s, 8s, 16s, 30s], jitter 0.2) → blocked (`auth` | `identity_changed` | `protocol`) → disabled
  - `wake()` coalesced over `PEER_WAKE_COALESCE_MS` 500, plus `reconnect(hostId, {repaired})`
  - one feed per host, resumable via `epoch:seq` / `Last-Event-ID`; run streams are reference-counted
- Renderer: `renderer/shared/peer-host.ts` (`PeerHostView`, `PeerSupervisorState`, `PeerHostStatus`, "Credentials and endpoints never appear here"), `renderer/components/settings/connections-settings.tsx` (+ test), `renderer/lib/peer-connections.ts`.
- **Host** `aiden-remote-service.ts`:
  - LAN HTTPS listener on `::` with the private-CA leaf. SANs: localhost, `<name>`, `<name>.local`, 127.0.0.1, ::1. **There are no LAN IP SANs**, so IP routes must keep TLS servername `<name>.local` and use the lookup override, never `https://<ip>`.
  - Tailscale route: loopback HTTP behind `tailscale serve` at `https://<dnsName>/api/aiden/v1` with **system (webpki) trust** and a different SPKI (`tailscalePinCache`, `fetchTlsServerSpkiSha256`).
  - `transportEndpoint(transport)` / `transportTrust` give private-ca vs system. `connectionMode` is lan | tailscale | both. Both listeners share `routerDependencies` and the device store, so **one device credential works on both routes** when the mode is "both".
- `GET /server` (`aiden-remote-router.ts` ~L1613, `AidenRemoteServerProjection` ~L98) returns protocolVersion, instanceId, name, appVersion, capabilities, serverCapabilities, deviceName, connectionMode, features, serverTime. Desktop-only features already exist (`host-events-v1`, `run-streams-v1`, `run-control-v1`).
- Budgets: `docs/plans/completed/desktop-multi-host-control-plan.md` ~L259 says a wake costs ≤ 2 requests per host and 0 for disabled hosts, enforced in `peer-host-manager.test.ts`.
- Acceptance test: `peer-multi-host-acceptance.test.ts`, with fixtures `main/services/peer-pairing-test-host.ts` (`dropConnections()`, `rotateLeaf()`, `impersonate()`) and `peer-remote-chat-test-host.ts`.
- Mobile stores one endpoint per Mac (iOS `Models/AidenInstallation.swift`, `Networking/AidenServerTrust.swift`; Android `models/AidenInstallation.kt`, `persistence/AidenInstallationStore.kt`). **Mobile multi-route is out of scope.** List it as a follow-up.

### 6.3 Design

**1a: host advertises its routes (contract revision bump)**
- Add an additive field on authenticated `GET /server`, e.g. `peerRoutes`, gated by a new feature string `peer-routes-v1`. Emit it **only** to desktop peer devices (mac/linux device kinds, like the existing desktop-only features). Never put it on unauthenticated `/health`, Bonjour TXT (which stays `v=1` + instanceId), or the QR.
- Shape (finalize in the doc first, then OpenAPI, fixture, TS and mobile tolerance):
  ```jsonc
  "peerRoutes": [
    { "kind": "lan", "endpoint": "https://<name>.local:<port>/api/aiden/v1",
      "trust": "private-ca", "serverSpkiSha256": "sha256/…",
      "addressHints": ["192.168.1.20"] },
    { "kind": "tailscale", "endpoint": "https://<dnsName>/api/aiden/v1",
      "trust": "system", "serverSpkiSha256": "sha256/…" }
  ]
  ```
  - Bounded to ≤ 4 routes and ≤ 4 IPv4 hints. https only.
  - LAN hints come from bound interfaces, using T3 `resolveBoundEndpoints`-style filtering: skip loopback, link-local (169.254/16), and virtual interfaces (docker*, br-*, veth*, bridge1xx, utun used by VPNs if identifiable, vmnet*).
  - Include the Tailscale route only when Serve ownership is verified (reuse the existing Serve verification state). Never probe synchronously inside the request; serve the cached state.
  - Leave out a route whose listener is disabled by `connectionMode`.
  - LAN-paired clients hold the private CA; Tailscale-paired clients do not. Finalize the authenticated CA bootstrap described in the approved decisions before freezing this shape.
- Bump `AIDEN_REMOTE_CONTRACT_REVISION` to **main's revision + 1 at merge time**. Update together: `docs/aiden-remote-api-v1.md` (§5 `/server`, §9 Transport identity, §10), `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json`, and the Android test copy `app/src/test/resources/contract.json` if it mirrors it, `aiden-remote-protocol.ts` (+ test), and the iOS/Android revision assertions (`AidenRemotePhase0Tests.swift`, `AidenBotContractTest.kt` / `AidenRemotePhase0Test.kt`). Mobile ignores the field. Verify Android's decoder tolerates unknown `/server` keys. iOS looked tolerant; Android wasn't checked.
- `features` is capped at 32 by the peer client's parser. Count the current list before adding.

**1b: desktop route store, selection, failover**
- `StoredPeerHost` gets an optional bounded `routes?: PeerRoute[]` (≤ 4): `{id, kind: "lan"|"tailscale", endpoint, trust: "private-ca"|"system", serverSpkiSha256, origin: "paired"|"learned", addressHints: {address, lastOkAt?, lastFailAt?}[] (≤ 4), lastOkAt?, lastFailAt?, cooldownUntil?}`.
  - The legacy `endpoint` / `serverSpkiSha256` / `caCertificateDerBase64` stays the **paired route**, and its `kind` is inferred from `PeerPairingTarget.route`.
  - `parseStoredPeerHosts` must accept old records unchanged (no migration step) and reject malformed or oversized route lists without dropping the host.
- **Learning:** reuse the existing authenticated `verify()` `/server` call. **This adds zero requests.**
  - Merge `peerRoutes` into learned routes only when the answering channel has already passed pin and identity checks (SPKI pin + `instanceId === host.id`).
  - Learned routes drop out when the host stops advertising them. Never modify the paired route.
  - Learned LAN routes must use the paired private-CA DER. Learned Tailscale routes use system trust plus the advertised SPKI.
  - Persist LAN IP hints, which absorbs `PeerLanAddresses`' in-memory map: Bonjour `rememberLanAddress` feeds the same store, only when the SPKI matches.
- **Transport:** keep one `https.Agent` per `(hostId, routeId)`.
  - LAN IP hints are used **only** through the `lookup` override, keeping the TLS servername `<name>.local` and private-CA + SPKI validation. Never connect to `https://<ip>`, and never add IP SANs.
  - The certificate trust, hostname and pin checks happen in the TLS handshake **before any request byte**; application instance identity is checked in the authenticated `/server` response (verify in `peer-transport.ts` that the credential header can't be written before the `checkServerIdentity`/pin callback; add a test with `peer-pairing-test-host.ts` `impersonate()`).
- **Selection:**
  - Rank LAN > Tailscale (relay stays simulator-only and isn't a chat route).
  - On connect, probe candidate routes in parallel with a short budget (~2.5 s per route). A probe is the pinned TLS handshake plus the authenticated `/server` the manager already does, so there is no unauthenticated descriptor step.
  - Pick the best-ranked route that verifies. If every probe is silent, still try each route serially within the existing establishment timeout × route count.
  - Report the most actionable error (transient over blocked), as T3 does.
- **Failover:** when the active route's feed drops or a unary call fails with `unavailable` or a transport error, move to the next healthy route straight away (no backoff step for the first alternate). Resume the host feed with `Last-Event-ID` (`epoch:seq`) and re-attach referenced run streams on the new route. Let in-flight unary calls finish or fail on their own. Never replay a non-idempotent write on another route unless it carries its idempotency key.
- **Come-home:**
  - Only while on a non-best route: preflight better routes on `wake()` (network change, resume, foreground) and at most every 60 s.
  - A route that failed within 5 min of a switch gets `cooldownUntil`. Require one successful preflight before switching back (hysteresis), and allow at most one switch per 30 s, against flapping.
  - Run one route check at a time per host (coalesce or drop overlapping checks).
- **identity_changed per route:**
  - A learned route or stale IP hint that answers with the wrong pin or instanceId is **removed** (hint) or put on cooldown (route). Raise a security log event without endpoint or credential in the renderer.
  - The host goes `blocked: identity_changed` only when the **paired** route fails identity and no other route verifies.
  - Tailscale repin stays per route and system-trust only (`repin`/`confirmRepin`). Private-CA routes are never repinned.
- **Budget:** no extra requests on a wake when already on the best route, and 0 for disabled hosts. While on a fallback, a wake may add ≤ 1 preflight per better route. Update the budget table in the plan doc and assert it in `peer-host-manager.test.ts`.
- Renderer projection (`PeerHostView`): add `activeRouteKind`, `routeCount`, maybe `routes: {id, kind, origin, state}`. **Never endpoints, IPs, pins or credentials.**

**1c: settings UI + docs**
- `connections-settings.tsx`: the status line reads "Connected via LAN · 2 routes". A disclosure lists routes by kind and origin (Paired / Learned) with state, and offers **Remove** for learned routes only.
  - No drag-reorder and no manual "Add route" in v1. Pairing a second transport stays the existing pairing flow; if Sambit wants manual adds later, they go through the pairing trust path.
  - Show a soft semantic status (connected / standby / cooling down / unreachable).
- Docs and `.memory` per §10.

### 6.4 Edge cases
- Route flapping (Wi-Fi roaming, sleep or wake): hysteresis and cooldown stop ping-pong. Test with fake timers and `dropConnections()`.
- Stale DHCP address now owned by another device or another Aiden: the pin or instanceId mismatch drops that hint. The host must not block. Test with `impersonate()`.
- Leaf rotation on LAN (`rotateLeaf()` keeps key and pin per §9): the LAN route stays valid. An explicit key rotation fails every private-CA route, so recovery or re-pairing follows the existing flow.
- Peer switches `connectionMode` from both to lan: the Tailscale learned route disappears on the next verify, and an active Tailscale session fails over to LAN.
- Credential revoked on the peer: auth failure on any route blocks with `auth` (the credential is per host, not per route). Don't try other routes in a loop.
- Network change mid-run: the run stream resumes on the new route without duplicating transcript deltas (seq dedupe).
- A host with only the legacy single endpoint (old peer, or no `peer-routes-v1`): behaves exactly like today.
- Linux peers: same logic; skip the Tailscale route if Serve isn't owned.

---

## 7. What not to do
- Don't copy T3 Code or pi-subagents code wholesale; adapt the patterns.
- No plain-HTTP routes. No routes on unauthenticated `/health`, Bonjour TXT or QR. No IP SANs or `https://<ip>` hack. Never send a credential before the pin and identity check passes.
- No mobile multi-route in this series. No mobile outbox or auto-resend. Never auto-retry a turn creation (`ios/AGENTS.md`).
- Don't expose private child transcripts on mobile. Don't add a subagent thread surface to mobile.
- Don't add the pi-subagents plugin or any upstream Pi extension. Don't use `sendMessage({triggerTurn})` for wakes (pi#5581).
- Don't resume a stale `Agent` with `continue()` or `followUp()` for an idle or closed parent. Start a fresh admitted turn.
- Don't activate the model-facing background subagent launch without Sambit's explicit go-ahead.
- No Hermes gateway. Hermex is UX inspiration only. OpenCode is a provider, not a child runtime.
- Don't invent Swift or Kotlin JSON shapes or endpoints. Change the normative doc, OpenAPI, fixture, TS, Swift and Kotlin together.
- No new third-party dependencies (iOS or Android) without approval. No credentials in URLs, logs, notifications or Live Activities.
- Don't re-port anything already shipped (single-route LAN fallback via `PeerLanAddresses`, Tailscale repin, the optimistic-send draft restore, idempotency-key reuse).
- No tautological, change-detector or `readFileSync` source-grep tests.
- Don't rebase or force-push shared branches.

---

## 8. Tests and verification

Follow `AGENTS.md` test guidance:
- Behavioral tests through fixtures, rendering, and register-and-invoke.
- Bug-fix regression tests must reproduce a user- or API-visible failure.
- House examples: `renderer/lib/chat-message-queue.test.ts`, `main/services/portable-config-core.test.ts`, `main/services/data-store.resilience.test.ts`.
- Register every new test file in the matching `package.json` script, and in the root chain where the lane is included.

### Required test scenarios
- **4a/4b:**
  - result committed with terminal state, crash-injected at each step, still owed after restart
  - two children finishing at once → one wake
  - idle parent → host turn started, result delivered once, liveness released only after the turn starts and the message is durable
  - busy parent → follow-up at a boundary, no second turn
  - reservation timeout → owed again, retried on idle
  - chat deleted → discarded
  - quit → interrupted, delivered on next turn
  - old run records parse
- **3:**
  - pure ancestor-path and children helpers (cycles, unknown parent, depth cap)
  - Android UI test: open child → back → parent detail → back → roster
  - iOS test on the path model
  - Android `rememberSaveable` survives recreation
- **2:**
  - envelope fixtures → reason mapping, including `rate_limited` countdown and `committed:true`
  - Retry reuses the same idempotency key
  - transport failure reconciles before resending, and clears the notice if the turn landed
  - notice survives leaving and re-entering the chat, clears on Mac switch or revoke
  - Android Compose UI test for Retry and Dismiss
  - accessibility announcement hook invoked
- **1a:**
  - `/server` includes `peerRoutes` only for desktop devices, never on `/health`
  - interface filter on synthetic `os.networkInterfaces()` fixtures
  - contract fixture and revision assertions updated on TS, iOS and Android
- **1b:**
  - legacy store parses
  - learned routes merge and expire
  - pin mismatch on a learned IP drops the hint without blocking (`impersonate()`)
  - the credential is never sent to a wrong-pin endpoint (assert at the test host: no request bytes were received)
  - LAN preferred over Tailscale
  - failover resumes the feed from `Last-Event-ID` without duplicates
  - come-home after cooldown, with flapping suppressed (fake timers)
  - wake request budget unchanged on the best route
  - end-to-end in `peer-multi-host-acceptance.test.ts`
- **1c:** `connections-settings.test.tsx` renders route kind and count, Remove works for learned routes only, and no endpoint text appears.

### Commands
```bash
# Node 22.22.3 (see .github/workflows/ci.yml; this checkout has no .nvmrc)
npm run type-check
npm run lint
npm run test:ci-policy

# Item 4
npm run test:subagents:phase7a      # + new phase7b lane if added
npm run test:subagents
npm run test:subagents:soak:contracts
npm run test:cli                    # only if packages/cli touched

# Item 1
npm run test:peer-hosts
npm run test:aiden-remote           # includes test:peer-hosts
npm run test:remote-chat

# Renderer/settings touched
npm run test:sidebar                # if sidebar/row state touched
npx tsx --test renderer/components/settings/connections-settings.test.tsx

# Broad gate before merge
npm test                            # scripts/run-ci-tests.mjs --parallel

# iOS (items 1a, 2, 3) — record the simulator UDID/name in the PR body
xcodebuild build-for-testing -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -configuration Debug -destination 'platform=iOS Simulator,id=<udid>' CODE_SIGNING_ALLOWED=NO
xcodebuild test-without-building -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -configuration Debug -destination 'platform=iOS Simulator,id=<udid>' CODE_SIGNING_ALLOWED=NO
#   focused: -only-testing:AidenOnTheGoTests/AidenChatTests  (and AidenRemoteClientTests, AidenRemotePhase0Tests)
#   CODE_SIGNING_ALLOWED=NO is compile/test only.

# Android (items 1a, 2, 3)
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:compileDebugAndroidTestKotlin
./gradlew :app:connectedDebugAndroidTest   # emulator; at least AidenComposerUiTest, AidenChatProgressUiTest
```

### Manual verification
- **Item 1:**
  - two Macs paired over LAN with `connectionMode: both`
  - confirm "via LAN · 2 routes"
  - turn Wi-Fi off on the viewer (with Tailscale still up via another link): failover to Tailscale within seconds, and the run stream continues
  - Wi-Fi back on: comes home to LAN after the preflight
  - change the peer's DHCP address: the hint is relearned
  - point a stale hint at another machine: dropped, the host does not block
  - capture idle CPU and request counts (`.memory/multi-host-control.md` lists the packaged Mac↔Mac LAN+Tailscale run as outstanding, so do it here)
- **Item 2:** in airplane mode on the phone, send → notice + restored draft. Back online, Retry → one turn on the Mac (check for no duplicate). Force `rate_limited` and `turn_already_active` via the test host.
- **Item 3:** a chat with nested agents (depth 2): roster → parent → child → back → parent → back → roster → dismiss → same scroll position.
- **Item 4 (dev gate on):** parent idle, the background child finishes → the parent wakes once with the result. Quit mid-run → interrupted, and the next turn carries the notice.

---

## 9. Acceptance criteria
- [ ] Each PR is small and single-item, merges `origin/main` (no rebase), and is green on CI at the exact head. The narrow suites listed are run locally and named in the PR body.
- [ ] **4a:** owed-delivery state, events and planner are covered by behavioral tests, including crash points. Old records parse. Production stays inert.
- [ ] **4b:** owed or waking results keep the chat live (row state, HostRunRegistry, quit guard). An idle or closed parent wakes once through a fresh admitted turn with a rebuilt prompt and tools. A busy parent gets a boundary follow-up. No lost or duplicate results across restart. No model-facing background launch unless approved.
- [x] **3:** on iOS and Android, back from a child agent returns to its parent agent, then the roster, then the chat with its scroll preserved. "Started by" and "Sub-agents" navigation works. Android state survives recreation. No contract change.
- [ ] **2:** send and run-input failures show an in-thread notice with a mapped reason, Retry (same idempotency key, reconcile first for ambiguous failures) and Dismiss on both clients. No modal alert or generic banner for these. VoiceOver and TalkBack announce it. No auto-retry. No contract change.
- [ ] **1a:** authenticated `/server` advertises bounded https routes to desktop peers only. Doc, OpenAPI, fixture, TS, iOS and Android revision assertions are updated in one PR. The revision is main + 1 at merge.
- [ ] **1b:** routes and IP hints are persisted (backward-compatible). LAN is preferred, with automatic failover and come-home, hysteresis and cooldown. Wrong-pin learned addresses are dropped without blocking the host, and no credential is ever sent to them. The wake budget is unchanged on the best route.
- [ ] **1c:** Settings shows the active route kind and count, with Remove for learned routes. The renderer never sees endpoints or pins.
- [ ] Docs, plans, `.memory` and the changelog are updated (§10).

## 10. Docs to update
- `docs/aiden-remote-api-v1.md`: §5 `/server` (`peerRoutes`, `peer-routes-v1`), §9 Transport identity (multi-route trust rules, LAN IP hints via servername), "Operating multiple devices", and the revision history.
- `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json` (+ Android test resource copy).
- `docs/plans/README.md`. Add `docs/plans/peer-multi-route-plan.md` (budget table, trust rules, flapping policy) and move it to `completed/` when 1c lands. Update the efficiency budgets in `docs/plans/completed/desktop-multi-host-control-plan.md` or reference the new plan.
- `docs/plans/subagent-orchestration-expansion-plan.md` (Phase 7B result delivery and wake, matrix rows ticked), `docs/plans/mobile-task-progress-and-subagents-plan.md` (agent ancestry navigation).
- `docs/chat-composer-busy-controls.md` (Queue offered from the `turn_already_active` notice), `docs/aiden-on-the-go-remote-access.md` (send-failure notice and Retry semantics), `docs/devices.md` "Paired Macs" if route behavior affects simulator relay notes.
- `.memory/multi-host-control.md` (routes, outstanding packaged run results), plus new or updated `.memory` notes for subagent result delivery and mobile send failures. `ios/CHANGELOG.md` and the Android changelog if present.
- Onboarding and the bento tour: no change (none of these is a new durable core feature).

## 11. Deferred product decisions (defaults approved above; do not block item 3)
1. **Phase 7B activation:** should this series turn on model-facing background subagents (behind `subagentBackgroundEnabled()`), or ship delivery and wake inert (recommended)?
2. **Restart wake:** after a relaunch, should owed results start a turn automatically, or only ride along on the next user or scheduled turn (recommended)?
3. **Manual routes:** allow a user-added endpoint in Settings later? (v1: no. Learned + paired only.)
4. **Mobile multi-route** follow-up: same `peerRoutes` for iOS/Android later, with the QR-pinned SPKI and hostname rules preserved?
5. **Agent deep link** (`aiden-otg://chat?…&agent=`) for notifications: wanted now or later?

## 12. Facts not verified during research (check while implementing)
- Whether Pi 1.0.3's `Agent.followUp`/`steer` delivery timing differs from 0.87.1 in ways that affect the busy-parent path (the APIs still exist at v1.0.3).
- Whether the parallel Pi upgrade lands by extending #299 or by a replacement branch (its prompt prefers extending #299).
- The exact point in `peer-transport.ts` where the pin is checked relative to sending request headers (relied on the registry comment that TLS identity failure comes before any request byte). Prove it with a test.
- Whether Android's `/server` decoder tolerates unknown keys (iOS appeared tolerant).
- What `requestApplicationQuit` offers today (confirmation vs immediate).
- The idempotency replay TTL value (doc says it starts at settlement; the duration wasn't checked).
- Which revision #312 claims, and the merge order of #312 / #349.
- Existing mobile UI tests for the agents sheet beyond `AidenChatProgressUiTest.kt`.
- The desktop renderer's own send-failure UX (out of scope here, but keep it consistent if touched).
