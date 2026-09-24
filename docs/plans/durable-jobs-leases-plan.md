# Durable Bot and chat runs — OpenMuse adoption

Status: PR 1 foundation implemented for review; production Bot runtime, desktop controls and Remote/native rollout remain pending. Implementation authorized in the follow-up request.
Verified: 2026-09-23. Priority: P0.

Adopt OpenMuse's SQL ownership leases and durable controls for **Mac-owned Bot/chat runs**, using SQLite around Aiden's existing Pi runtime. Start with accepted Bot chat turns, then regular workspace chats. Do not add Comfy, image-generation workflows, or Design integration in this scope.

A run is one accepted user request, potentially spanning several model/tool steps. It is not the whole conversation, a scheduled-task definition, a subagent, or an SSE connection. Keep `jobId`, user-message ID, logical turn ID, execution-attempt ID, Pi operation IDs and delivery stream IDs distinct and durably linked.

**Main finding:** Aiden already has durable sessions, remote request/delivery receipts, generation ownership, effect evidence and conservative no-replay recovery. The missing layer is a SQL claim for accepted work, durable lifecycle/control state and an explicit recovery decision. This should wrap existing runtime authority, not replace it.

## Evidence and scope

- Aiden local HEAD and remote default HEAD both resolved to [`7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62`](https://github.com/sambitcreate/aiden-agent/tree/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62).
- OpenMuse default tip is [`8c09be01b4114e76ec9fbc5df337e85f5e010b7d`](https://github.com/CopilotKit/openmuse/tree/8c09be01b4114e76ec9fbc5df337e85f5e010b7d), unchanged from the [prior Notion research](https://app.notion.com/p/3e480314a1c48117bb64fdf5bf4027d3). Read that memo first and verified the relevant code against tip. The suggested local mirror was not found in the searched project/Codex directories.
- User scope correction: focus on Bots and chats now. Comfy/Design/image workflow integration is excluded, not a prerequisite or a follow-up deliverable in this plan.
- Research was source-only. Follow-up implementation adds the isolated ledger/service/worker and fake-runtime tests, including SIGKILL after a committed dispatch marker. No production bootstrap, real provider/tool execution or native device testing. Optional OpenCode/Hermex audits were unnecessary for this lease decision.
- Source keys below resolve to immutable URLs at the end. New paths/APIs are proposals.

## Gap analysis

| OpenMuse mechanism | Aiden today, verified at tip | Proposed Aiden shape / file/API hints |
| --- | --- | --- |
| Durable `AgentTask` with state, attempts, lease and result, independent of chat [O1] | Pi JSONL session history survives; Remote stream journals recover delivery and mark interrupted streams after restart [A1, A2]. | `renderer/shared/durable-jobs.ts` plus `main/services/durable-jobs/{store,service,worker}.ts`. One durable Bot/chat run per accepted request, linked to existing transcript and Pi session. |
| JSONB record CAS in SQL; PGlite default, optional Postgres [O2] | Guarded JSON `DataStore`; `MemoryStore` already uses `node:sqlite`, WAL and `BEGIN IMMEDIATE` [A3]. | Dedicated profile-local `jobs-v1.sqlite`, indexed typed columns, bounded JSON checkpoint data and SQL CAS. Leave chats/memory/effects in their current stores. |
| Poll ~1s, 60s lease, heartbeat at lease/3, up to three selected runs per tick [O3] | Active generation/turn admission and Cron execution maps/controllers are process-owned; schedule definitions/history persist [A4, A11]. | Main-owned worker, initial 60s lease / 20s heartbeat, bounded global concurrency, one unresolved run per chat in the pilot. Timed SQL claim supplements existing turn admission. |
| Expired lease takeover and status + lease-ID CAS on results [O3] | Bot policy/inventory/MCP “leases” fence permission/config generations, not resumable work [A5]. | Retain all authority leases and add work lease + monotonic fence. Check ownership at each provider/tool admission and durable run publication. Takeover means reconcile before execution. |
| Lost-lease cleanup conditionally requeues its own still-running task [O3] | Pi prepared effects recover as cancelled-before-dispatch; dispatched never-replay effects become `unknown`; safe effects become interrupted, not automatically resumed [A6]. | Requeue only proven not-started work. Otherwise classify durable tail/effects; resume only at a proven safe boundary, unknown outcomes require attention. Never reset Pi effect evidence to gain retry. |
| Stored task checkpoints plus review-gated uncertain writes [O2, O4] | Managed Pi runtime flushes tool plans/results before external effect/next provider step, and reconstructs no-repeat evidence after rollback [A12]. | Link a run checkpoint to exact Pi session head, input/turn and effect-operation evidence. Resume through managed runtime and current policy checks; never replay the original prompt as a recovery shortcut. |
| Pause/resume/cancel/retry task control [O4] | Desktop `chat:cancel` and Remote `/streams/:id/cancel` stop the exact turn. Schedule pause also settles/cancels current execution and disables the schedule [A4, A7]. | Separate `jobs:control` IPC and `/jobs/:id/control`, durable intent and revision CAS. Stop remains turn interrupt; a stopped linked run becomes interrupted and cannot auto-restart. |
| Activity + task cards show history, controls and results [O5] | Transcript activity, scheduled-task views, subagent detail and read-only chat todo/agent progress already exist [A9, A10]. | Compact run status/detail attached to the existing Bot/chat surface; list recent runs for that chat. No new universal workflow dashboard. Clearly separate run controls from composer Stop and todo/subagent controls. |
| Server owns work; client projects it [O3, O5] | Swift/Kotlin call Mac APIs, consume snapshots/SSE and cancel streams. Remote owner survives socket/SSE disconnect [A10, A11]. | Add negotiated durable-run snapshots/events/controls with current pairing and ACL. No phone leases, provider calls or offline command queue. |
| Background tasks retain independent ownership [O1, O3] | Subagents already have persisted background lifecycle/effects; restart reconciles active snapshots to interrupted [A13]. | Preserve child ownership. First run slice must block automatic parent resume when child state/effects are unresolved; do not relaunch children from a replayed parent tool call. |

OpenMuse nuances: the three selected runs are awaited as one tick batch, not a continuously refilled pool. Guard/checkpoint checks status and lease identity but does not itself require `leaseUntil > now`; Aiden should enforce expiry on writes/admission. A SQL lease cannot make a tool mutation or provider request exactly once.

## PR 1 implementation evidence

- Implemented `main/services/durable-jobs/{contract,store,service,worker}.ts` and the internal `renderer/shared/durable-jobs.ts` types. No production consumer constructs these services yet.
- SQLite admission/control receipts, one unresolved run per chat, distinct execution attempts, bounded events, private files, CAS claims and explicit expired-owner fencing. Pi effects remain behind a trusted runtime evidence port, with no duplicate effect store.
- The lease clock retains a durable high-water mark even when a stale mutation is rejected. Control revocation invalidates old callbacks; a live predecessor must settle through the runtime port before takeover. Failed settlement retains the unresolved reservation.
- Local validation: 71 focused tests passed, including two-connection contention, corruption/write-failure preservation, control/Stop recovery, unknown parent/child effects, resumed-head mismatch and real SIGKILL/reopen. Type-check, lint, 16 CI registry/routing tests and diff whitespace validation passed.
- Registered in `test:durable-jobs`, full `npm test` and the CI core-git lane. Existing changed-area routing runs all affected platform checks. No Remote DTO/event or transcript UI changes; native feature integration and physical acceptance are explicitly pending.
- Review corrections: shutdown/lease-loss preserves authoritative recovery; checkpoint hashes use canonical field order; admission/control capacity counts unresolved work while terminal receipts remain retained for deduplication. Disk/history compaction is deferred and must preserve receipts before any production retention feature.
- Pre-dispatch checkpoint recovery requires an exact stored session/head match. Missing SQL checkpoint evidence remains needs-attention; production recovery must prove the original input/head binding before extending this path.
- Foundation tests do not establish real managed Pi continuation. Real Bot ingress (including Telegram), durable Stop/approval hooks, production-store lifecycle, packaged restart and native control gates remain PR 2/3 work.

## Recommended first product slice

**Durable accepted Bot chat turns, through the existing Mac chat runtime.** Reuse the canonical Bot chat, provider/model binding and Full/Custom policy. Do not add a second Bot chat, a new agent loop, or a new workflow editor. Ordinary workspace chats follow after the same ownership invariants pass. Their current behavior stays unchanged in the first slice.

The product promise is concrete: once the Mac acknowledges a Bot request, its run record and input survive; the user can see whether it is queued, running, paused, interrupted, finished or needs review. Pre-dispatch work can recover automatically. Work already executing resumes only from verified durable evidence, and never after an explicit Stop without an explicit user action.

Initial scope is one outstanding run per Bot chat, no durable multi-message queue. A paused/interrupted/unknown run retains the chat reservation until resumed or explicitly closed/cancelled; the UI directs the user to that run instead of silently starting another turn. A completed or cancelled run releases admission after runtime settlement. This avoids resuming an old run against a newer conversation head. Existing Bot tools remain governed by existing policy; resumability is conditional, not a promise that every tool can be suspended.

Stage the work as small PRs:

1. **PR 1 — ledger and recovery decision contract.** SQLite store/service/worker with a fake managed-runtime port; accepted-input/run mapping, claims/fences, controls and deterministic crash tests. No production startup, public API, UI or changed send behavior. Implementer prompt below.
2. **PR 2 — Bot runtime integration and desktop controls.** Route eligible Bot admissions through the ledger, create a Mac run owner, bridge input/transcript/Pi receipts, and add pause/interrupt/recovery hooks to the existing managed runtime. Add the compact Bot/chat run detail and honest unavailable-resume reasons. Gate release on actual restart and tool-effect tests; a fake worker is not product acceptance.
3. **PR 3 — Remote + native controls.** Update Remote v1 capabilities/DTOs/events and both Swift/Kotlin clients. Existing mobile Bot sends must join the same admission owner, not a parallel path. Until native controls land, do not advertise complete On The Go durable-run support. Preserve older-client stream Stop behavior throughout.
4. **Later, within this feature family:** ordinary workspace-chat admission using its existing scope/permissions, only after Bot gates pass. Cron and subagent ownership migrations remain excluded.

## SQLite and Mac ownership

Use existing `node:sqlite` in a new private database under the active profile's user-data root. Aiden already packages this runtime. A dedicated store avoids coupling job retention/migrations to MemoryStore. JSON DataStore remains appropriate for existing records, but implementing atomic claim/control/events across several records there would recreate transaction machinery. PGlite/Postgres adds deployment/runtime complexity without benefit for one Mac authority.

Use WAL, foreign keys, `synchronous=FULL`, short `BEGIN IMMEDIATE` transactions, bounded busy handling and private directory/database/WAL/SHM permissions. Sample claim time after acquiring the write lock. Never hold a transaction across model/tool execution, transcript writes or network. SQLite has one writer; measure main-loop stalls before introducing a DB worker thread. See [SQLite transactions](https://www.sqlite.org/lang_transaction.html) and [WAL](https://www.sqlite.org/wal.html).

| Table | Minimum contract |
| --- | --- |
| `jobs` | Version, job ID, profile/host scope, Bot/workspace/chat IDs, stable accepted input/message/turn IDs, provider/model binding references, state/phase/reason, desired control, public revision, timestamps, lease ID/owner/until and monotonic fence. |
| `job_attempts` | Execution-attempt ID, job ID, linked stream and Pi operation IDs, start/end/outcome. Lease reacquisition/reconciliation is not itself a fresh model attempt. |
| `job_checkpoints` | Exact Pi session/head revision, transcript/input receipt, referenced effect operations, child-run references and checkpoint kind/version. No copied provider credentials or second transcript. |
| `job_controls` | Actor/resource/action, idempotency key + request digest, expected revision and durable response. Control admission and job state change commit together. |
| `job_events` | Bounded ordered public lifecycle events committed with job state. Terminal output references point to existing chat/artifact storage. |

Pi effect storage remains authoritative for tool effects. **Do not introduce a second independently writable SQL effect ledger for the same tool call.** The job holds references and conservative recovery classification. Preserve required referenced evidence until the run has been resolved; if effect/session evidence is missing, fail closed. A future migration would need its own atomic ownership handoff and is not proposed here.

Claim eligible work with SQL CAS and increment the fence. Heartbeat, checkpoint and completion require exact lease/fence and unexpired ownership. Public revisions change on lifecycle/control changes, not heartbeats. The same per-chat reservation must constrain desktop, Remote and any other ingress to that Bot chat, including Telegram; unsupported ingress fails busy rather than bypassing ownership. Do not make Telegram's existing memory queue durable incidentally.

Both durable lease and existing runtime/turn admission must agree. During a live-process stall, lease expiry must not launch a second runtime while the predecessor can still mutate tools or the Pi journal: revoke, abort and settle/quarantine the old owner first. A DB fencing token does not fence the existing JSONL/effect stores or external tools by itself. In production retain one main-process execution authority; use two DB connections to prove claims, not to imply multi-process Pi execution support.

Closing a chat, renderer or phone connection does not cancel accepted work. Desktop delivery ownership and remote approval audience remain scoped; a new main-owned run owner must not inherit unchecked privileges from a vanished window. Explicit device/policy revocation still revokes authority. Quitting Aiden/sleep suspends local execution; recovery happens on relaunch/wake. No daemon or cloud executor is implied.

## Admission and recovery across existing stores

SQLite and the chat/Pi stores cannot share one transaction. Define a recoverable commit sequence before wiring Send:

1. Main authenticates the caller, resolves Bot/chat/provider policy, checks the current chat revision and stages bounded input/attachments under existing private storage rules.
2. Persist `admitting` run with stable job/message/turn IDs and request idempotency record. Do not call the provider yet. Any accepted receipt names this stable run, even if response delivery fails.
3. Reuse `chat-append-commit.ts` reconciliation to append exactly that message ID. After a crash, inspect the durable chat for that ID rather than appending a new copy. Retain attachment references until admission resolves.
4. Record the append receipt and move to queued. Worker claims and revalidates policy/session ownership before invoking the existing managed generation path. Persist execution-start intent before provider dispatch.
5. After a flushed Pi boundary, commit its exact reference into the job checkpoint. If the job write fails, recover from Pi evidence; never assume the provider/tool did not run. Deduplicate final transcript/artifact publication by stable identities, then mark the job terminal.

A crash between any two stores must have a named recovery path. Never acknowledge a durable run whose input exists only in renderer memory. Never call a read operation that starts generation as part of reconciliation. Preserve existing attachment limits and regular-chat privacy.

`pi-agent-runtime-harness.ts` exposes a legacy `continueFromDurableTail()` that calls `runLegacy`; durable runtimes reject that path. Resume must go through the managed runtime contract (`runManaged`) and its journal, policy, compaction and effect protections. Do not wire a job worker to the convenient legacy method.

Recovery classifier:

| Evidence | Recovery action |
| --- | --- |
| Accepted input, proven no provider/tool dispatch | Finish admission/claim and start once, unless a Stop/pause/cancel or authority change intervened. |
| Verified durable model/tool-result boundary, no pending tool calls/effects/children, unchanged session head | Can be resumed through a tested managed continuation after policy checks. First release requires explicit Resume once execution has begun; do not auto-restart model generation. |
| Complete final assistant/result exists but job terminal receipt is missing | Reconcile to completed without model/tool execution or duplicate transcript output. |
| Provider request in flight, partial text, incomplete assistant tool plan or unsettled persistence | Mark interrupted/needs attention. Partial text is not a resume checkpoint. Wait for live predecessor settlement; after crash reconcile exact stored evidence before allowing continuation. |
| Any unknown external tool effect, unresolved child mutation, missing/corrupt referenced evidence | `needs_attention`, reason `outcome_unknown` or specific missing evidence. Disable Resume/Retry until authoritative reconciliation. No prompt-only “do not repeat” guarantee. |
| User stopped the turn | Persist interrupted/user_stop; never eligible for automatic restart. Preserve partial response, input and effect evidence. Explicit safe Resume or closing the run is required. |

Even explicit Resume does not authorize repeating an unknown mutation. Do not synthesize successful tool results or mark a pending tool complete to create a resumable tail. If managed continuation cannot safely represent a boundary at implementation time, return an honest unavailable-resume reason instead of replaying the request. Verifying one real safe continuation is a release gate.

## Controls and Stop separation

Initial states: `admitting`, `queued`, `running`, `pause_requested`, `paused`, `interrupted`, `needs_attention`, `succeeded`, `failed`, `cancel_requested`, `cancelled`. Persist control intent/reason separately from observed execution state. Add waiting-for-input/approval as explicit blocking projections linked to existing request IDs; do not let UI show a run as actively generating while awaiting the user. No automatic approval on resume.

| Control | Required semantics |
| --- | --- |
| Composer **Stop response** | Existing exact-stream/turn interrupt API and authorization. If that turn belongs to a durable run, runtime settlement records interrupted/user_stop. It does not cancel the Bot, all chat runs, schedules or unrelated work. No automatic retry or reclaim restarts the stopped turn. |
| **Pause run** | Durable run intent. Before dispatch, pause immediately; while active, stop before the next provider/tool admission and settle at a verified durable boundary. Show pause requested until safe. An in-flight mutating tool may finish; never label it suspended just because its signal was aborted. |
| **Resume run** | Only safe paused/interrupted boundaries; current run revision, chat head, Bot policy, audience, provider/model and tool configuration must revalidate. New delivery stream/attempt may be needed; keep the same job and user input. No duplicated user message or original-prompt replay. |
| **Cancel run** | Terminal intent to stop continuation, separate from interrupting one attempt. Abort the linked active attempt through current runtime authority, settle its effects, and preserve history/results. Unknown tool outcomes remain needs-attention even if future execution is cancelled. |
| **Retry failed run** | Explicit new attempt only with proof that repeating the failed step is safe. Never resets unknown effects. Explain potential new inference cost; no silent model-request retries after ambiguous failure. |
| Tool/approval/input wait | Persist the wait identity; hold no unnecessary execution slot/lease while parked. Approval/input routes retain existing authority and idempotency. On reply, reacquire and revalidate. Pause/Stop/cancel invalidates stale continuation grants without granting or losing an already executed effect. |

A lease reaper must honor persisted user intent. Resume and cancel use expected revision; stale controls conflict with a fresh snapshot. A job cancelled before dispatch cannot later become running. A completion racing cancellation preserves the true completed result and records “finished before cancellation” rather than overwriting success. Unknown effects survive control retries, cleanup and retention.

Pause/Stop also need a durable interruption receipt before the system treats the interrupt as fully acknowledged; add it at the owning runtime boundary, not by converting the composer into a generic job-control caller. A crash after acknowledged Stop must not requeue the linked turn. Keep existing immediate abort responsiveness while failing closed if the receipt cannot be persisted.

## Remote and native shape

New negotiated feature `durable-chat-runs-v1`, with proposed `jobs:read` / `jobs:control` capabilities; preserve pairing/TLS/SPKI and existing workspace/Bot ACLs. Do not silently upgrade a paired read-only device. Remote creation stays through the existing authenticated Bot-turn submission, augmented with an additive durable `jobId` receipt for capable clients. No generic arbitrary-job creation endpoint.

| API under `/api/aiden/v1` | Contract |
| --- | --- |
| `GET /chats/:id/jobs` | Bounded authorized run history for this chat. |
| `GET /jobs/:id` | Snapshot: state, phase/wait reason, revision, last durable update, linked turn/stream, safe result references and allowed actions with reasons. No lease IDs, private journal paths, credentials or raw tool arguments. |
| `GET /jobs/:id/events` | Dedicated lifecycle replay stream with bounded retention/cursor and snapshot-reset behavior. Disconnection never cancels work. |
| `POST /jobs/:id/control` | `{action, expectedRevision}` and existing idempotency-header convention. Same key/body returns recorded result; changed body conflicts. Durable accepted intent is not a false claim that an external effect stopped. |

Do not reuse `/chats/:id/tasks`: it is read-only todo progress. Do not keep an old terminal chat stream open to represent a resumed job; map a fresh stream/attempt to the same durable run. Existing `/streams/:id/cancel` still interrupts the exact current turn, including on older clients. Reauthorize reads, controls, awaited continuations and SSE publications against revocation.

Swift: extend `Networking/AidenRemoteClient.swift`, add `Models/AidenDurableJob.swift` and a compact detail in the existing Bot/chat feature. Kotlin: corresponding `networking/AidenRemoteClient.kt`, model and shared chat detail. Keep the existing transcript/composer; no forked Bot chat implementation. Task/agent progress views remain separate.

Phones cache last-known status and stable control-request identity for reconciliation only. Offline controls show Mac unavailable; no command outbox and no automatically minted replacement mutation on reconnect. Last-known job state and host availability are separate facts. The phone never owns a lease, provider loop or tool executor.

For desktop, use an inline run-status entry plus detail/history in the existing chat/Environment surface. Read the mandated design references before implementation; use semantic tokens/squircle actions and accessible motion/focus. Update concise onboarding and the shipped feature-tour asset/test only when the durable capability actually ships. Do not advertise the substrate-only PR.

Chat/Bot/workspace deletion must use existing lifecycle services, cancel/settle or explicitly block active runs, and retain unresolved effect evidence; archive/navigation is not deletion or cancellation. Paused runs must stay reachable. Bind a run to the original ownership scope, never a reused chat/Bot ID.

## Acceptance criteria

1. Two real SQLite connections race: exactly one claim wins. Expired owner cannot heartbeat/checkpoint/complete/append lifecycle events. Pause/cancel/reclaim races preserve the current owner and user intent.
2. Kill/reopen before input append, after append, before/after dispatch intent, after tool-plan flush, after tool result, and after final transcript publication. One accepted input and one final result; no duplicate generation at a completed boundary.
3. Fake external tool performs its mutation then loses its response. Restart, lease expiry, Retry and a fresh control key cause **zero repeat mutations**; run requires review. Missing effect evidence fails closed. Test pending child effects too.
4. Durable pause before execution prevents dispatch; pause during a safe read-only run reaches an actual managed checkpoint; explicit resume uses that checkpoint without repeating the user message or completed calls. Mutating/incomplete boundaries accurately refuse resume until resolved.
5. Stop remains exact-turn interrupt and is durably honored across crash/restart. Cancel-run cannot affect an unrelated chat/turn/schedule. Closing renderer, changing chats, disconnecting SSE or backgrounding the phone never cancels an accepted run.
6. One runtime owns each chat. Expired SQL claim cannot start a replacement until a still-live prior runtime and non-abortable persistence settle or are quarantined. All Bot-chat ingress obeys the same reservation; no new durable multi-message queue.
7. Provider/model/tool/permission changes, device revocation, altered session head and Bot/workspace deletion reject stale resume/control. Waiting approval/input cannot be bypassed by lease reclaim, pause or reconnect.
8. Disk full, failed dispatch/Stop receipt, DB corruption, unsupported schema and clock jumps preserve accepted work and block unsafe dispatch. Database/file permissions, production/development isolation, bounded retention and rollback/reopen are covered.
9. Remote duplicate control, stale revision, wrong owner, denied capability, response loss and SSE-retention gaps are covered in server + Swift + Kotlin fixtures. Older clients preserve stream Stop and tolerate feature absence. Phones issue no automatic new submit after disconnect.
10. Packaged Mac demo: accept a Bot turn, navigate away/reconnect, crash/relaunch, recover visibility, resume one proven safe boundary and reconcile a completed response. Verify interrupted/unknown states remain honest. Exercise both native controls on supported devices; compiled tests alone do not establish physical acceptance.

Register new tests in `package.json` and applicable CI changed-area routing. PR 1: proposed `test:durable-jobs`, type-check and lint; use temporary real SQLite databases and a fake managed-runtime port. PR 2: relevant Bot/chat/effect/compaction/attachment/subagent regression suites, renderer/IPC checks and `test:onboarding` when copy changes; packaged restart validation. PR 3: `test:aiden-remote`, canonical OpenAPI/fixtures, Android `:app:testDebugUnitTest` plus applicable instrumentation and iOS `AidenOnTheGoTests` on an explicitly selected supported device per `ios/README.md`. `test:ios-release` is policy validation, not native UI acceptance. Report local, hosted and physical evidence separately.

## Pasteable implementer prompt — scoped PR 1

```text
Implement only PR 1 from docs/plans/durable-jobs-leases-plan.md: a Mac-owned
SQLite ledger/lease/control substrate for accepted Bot/chat runs, with a fake
managed-runtime port. Read AGENTS.md, relevant .memory and the plan first;
revalidate tip (research baseline Aiden 7a4d9d0b, OpenMuse 8c09be01).

Create a feature/ branch and one scoped PR. Use existing node:sqlite in a new
private profile-local jobs-v1.sqlite. Add pure store/service/worker modules under
main/services/durable-jobs/ and a versioned renderer/shared/durable-jobs.ts
contract. Inject clock, root and runtime ports; no Electron imports in pure tests.

Model a run as one accepted input in a Bot/chat, with separate job/message/turn/
attempt/stream/Pi-operation identities. Implement admitting -> queued receipt
reconciliation, exact-ID input deduplication, one unresolved run per chat, bounded
claims, 60s leases/20s heartbeat, monotonic fencing, expiry checks, checkpoints,
events, lifecycle states and revision/idempotency-safe pause/resume/cancel/retry.
Persist user_stop intent so acknowledged Stop can never auto-restart its run.

Pi session/effect stores remain authoritative. Reference their evidence through
a recovery-classifier port; do not copy or migrate effects into SQL. Reclaim means
reconcile first. Only proven not-dispatched work may start automatically. Started
work requires explicit safe Resume; unknown external outcomes, pending children,
missing evidence or incomplete boundaries block continuation/retry. A live prior
runtime must settle/quarantine before a replacement may start even after expiry.

Test acceptance 1-3, 5-8 at the service/port level with real temporary SQLite files,
two connections, deterministic clocks and crash/fault seams. Count fake provider
and external-tool calls. Include input-append/receipt gaps, accepted mutation with
lost response, completed transcript with missing terminal receipt, Stop/restart,
stale callbacks, approval waits, failed writes and duplicate controls. A fake port
is not proof of real managed Pi continuation; document that PR 2 release gate.

Register test:durable-jobs and CI routing as needed; run focused tests, type-check
and lint. No production bootstrap, changed Send/Stop behavior, actual Pi execution,
network routes, phone/UI changes or external effects in this PR. No Comfy, images,
Design, workflow editor, gateway, daemon, PGlite/Postgres, client-only outbox or
drive-by refactors. Do not migrate Cron, subagents, chat or memory stores.

Update the plan index to foundation implemented / Bot runtime and native rollout
pending only after checks pass. Log friction in .papercuts. Prepare one PR with
concrete changes and validation; do not merge/release or advertise shipped jobs.
```

## Explicit non-goals

- Comfy workflows, image-generation adapters and Design Studio integration.
- Hermes gateway/tickets/WebUI compatibility, bot mesh or broad gateway work.
- Expo rewrite, CopilotKit/AG-UI/Intelligence dependency or phone execution.
- Client-only queue/outbox, keep-app-open delivery or a durable multi-message queue.
- Replacing Pi, duplicating effect ownership, migrating all chats/schedules/subagents.
- Blind replay of uncertain tool effects, universal exactly-once execution, or resume from arbitrary partial tokens/tool stacks.
- Always-on daemon, cloud failover, cross-Mac takeover, unrelated dashboard/Live Activity redesign or refactors.

## Source index

OpenMuse:

- [O1 — AgentTask/domain](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/packages/domain/src/agent.ts)
- [O2 — SQL store, CAS, interrupted-action recovery](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/server/src/db.ts)
- [O3 — TaskWorker](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/server/src/engine/worker.ts)
- [O4 — task controls](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/server/src/engine/service.ts), [routes](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/server/src/engine/routes.ts), [review decisions](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/server/src/actions.ts)
- [O5 — Activity/TaskCard](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/mobile/src/agent-ui.tsx), [TaskThreadCard](https://github.com/CopilotKit/openmuse/blob/8c09be01b4114e76ec9fbc5df337e85f5e010b7d/apps/mobile/src/thread-artifacts.tsx)

Aiden:

- [A1 — Pi session repository](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/pi-session-repository-port.ts)
- [A2 — Remote stream durability/recovery](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-streams.ts)
- [A3 — SQLite MemoryStore](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/memory-store.ts), [DataStore](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/data-store.ts)
- [A4 — scheduler ownership/controls](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/schedule-service-core.ts), [schedule persistence](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/schedule-store.ts)
- [A5 — Bot policy leases](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/bot-capability-lease.ts), [inventory lease](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/bot-runtime-inventory-lease.ts), [MCP config lease](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/mcp-config-lease.ts)
- [A6 — Pi effect recovery](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/pi-runtime-effect-store.ts), [effect states](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/pi-runtime-effect-core.ts), [replay policy](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/pi-runtime-tool.ts)
- [A7 — desktop Stop authority](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/handlers/chat.ts), [Remote routes](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-router.ts), [Remote scheduled controls](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-schedules.ts)
- [A9 — transcript activity](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/renderer/components/activity-feed.tsx), [Environment](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/renderer/components/environment-panel.tsx), [scheduled tasks](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/renderer/components/scheduled-tasks-view.tsx)
- [A10 — Mac progress projection](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-chat-progress.ts), [capabilities/DTOs](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-protocol.ts), [Swift client](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/ios/AidenOnTheGo/Networking/AidenRemoteClient.swift), [Kotlin client](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt)

- [A11 — generation ownership](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/chat-generation-owner.ts), [Remote accepted-turn path](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/aiden-remote-chats.ts), [main generation/admission](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/llm-client.ts)
- [A12 — managed Pi boundaries and continuation](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/pi-agent-runtime-harness.ts), [chat append reconciliation](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/chat-append-commit.ts)
- [A13 — persisted subagent/background restart recovery](https://github.com/sambitcreate/aiden-agent/blob/7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62/main/services/subagents/subagent-run-store-v2-core.ts)
