# Desktop multi-host PR 2: contract revision 19 — host feed, run streams, control, paging

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired desktop controller can read one host's whole sidebar as a live feed. It can observe any run on that host, whoever started it, and control the run: stop it, approve tools, answer questions and steer. It can also page through a large transcript. Phones keep exactly the behaviour they have today.

**Architecture:**
- A shared cursor-only SSE pump (`aiden-remote-sse.ts`) handles framing, heartbeats, back-pressure and the drain timeout for the two new stream families. The existing `/streams/{id}/events` pump is left as it is.
- `AidenRemoteHostRunService` (`aiden-remote-host-runs.ts`) serves `/runs/*` straight from `HostRunRegistry` using wake-then-read. It also owns the four control routes and their in-memory idempotency ledger.
- `AidenRemoteHostFeedService` (`aiden-remote-host-feed.ts`) keeps a bounded, epoch-stamped feed journal of 1,000 events or 8 MiB. Three sources feed it: the existing `chats:changed`, `workspaces:changed` and `bots:changed` notify hooks, diffed against the last projection, plus `HostRunRegistry.onChange`. It never scans transcripts.
- First-responder atomicity comes from the existing one-shot coordinators. `ToolApprovalCoordinator` and `AskUserQuestionCoordinator` gain host-authority entry points that skip the owner-document check but still settle exactly once. `HostRunRegistry` remembers recent resolutions so that losers learn the winning decision.
- Every new route sits behind a new grant: `host:events`, `runs:observe` or `runs:control`. Like `simulators:control`, these grants are issued and negotiable only for `mac`/`linux` devices. Callers without them take exactly the code paths they take today.

**Tech stack:** TypeScript, Node `node:test` through `tsx --test`, the Electron main process, plus the Swift and Kotlin decoders for the shared error codes.

**Spec:** `docs/plans/desktop-multi-host-control-plan.md` (Architecture §3 "Host backend" and §4 "Contract", delivery row 2).

## Decisions taken in this PR

Where the master plan leaves a choice open, this PR takes the conservative option:

1. **The device journal stays independent.** The durable per-device stream journal and its mobile wire format are unchanged. `/runs/*` reads `HostRunRegistry` directly, so a run started anywhere can be observed without a device stream. Turning the device journal into a view over the registry is deferred. It would change persistence and replay for phones and needs its own replay evaluation.
2. **Run events are process-lifetime.** The run journal is in memory, as built in PR 1. After a host restart, `/runs/{runId}/events` answers `404 run_gone`. The run-control idempotency ledger is also in memory, because a key cannot outlive the run it controls.
3. **Run stream ids are plain decimal sequences.** The run's epoch travels in the `aiden-run-epoch` response header and in every snapshot payload. An epoch change can only coincide with `run_gone`, because run ids are never reused.
4. **Feed ids are `<epoch>:<sequence>`.** If a feed cursor is from another epoch, behind retention, ahead of the head or malformed, the client receives a fresh `snapshot` rather than an error.
5. **Approval and question resolution events keep their registry names.** These are `approval_resolved` and `question_resolved`, documented as run-stream-only types. `run.started` and `run.ended` are the only renamed or synthesized events.
6. **Losers learn the winner.** A losing approval control gets `409 approval_resolved` with `details.decision` (`allow`/`deny`/`expired`/`cancelled`) and `details.resolvedAt`. A losing question control gets `409 question_already_resolved` with `details.outcome` and `details.resolvedAt`. These come from a bounded recent-resolutions map in the registry: 512 entries, kept for 10 minutes.
7. **Host-UI card withdrawal is deferred to PR 7.** If a controller wins, the host's own approval card is not withdrawn yet. A later click on that card fails safely, because the coordinator is one-shot and the IPC handler reports "no longer pending". Atomicity holds either way.
8. **The messages window omits the turn stats, skill and subagent references** that `GET /chats/{id}` carries. PR 6 asks for them only if the remote view needs them, so the window stays small and the full-chat contract is untouched.
9. **Repository identity applies only to a workspace's root.** It is derived from the `origin` fetch URL that `git status` already reads, because the remote list is now read verbatim. It is never crawled, never sent for nested folders, and never included in the workspace revision. The projection is only emitted on the host feed, which is visible to `host:events` holders only.
10. **The Bot host-owner audience is read-only.** A `bot:read` desktop controller that holds `host:events` reads the host's Bot chats as the desktop audience (`desktop:local`). Writes keep the device-scoped audience.
11. **Run control still requires chat-level write access** (revised during implementation). It authorizes on `runs:control`, the run's current identity, and the same chat write access a device-scoped send would need. It is limited to the runs the host journal knows about. Dropping the chat check is deferred until a host-owner audience for writes exists.
12. **`pairingRequests` is advertised as `true`.** Hosts advertise the field now, and PR 4 adds the request/approve routes and the Settings switch. It carries no secret and gives no access.

### Decisions recorded during implementation

13. **The `/health` descriptor is opt-in through `?detail=host`.** The strict iOS health decoder rejects unknown keys, so the plain `/health` body is unchanged. Any other query string returns `400 invalid_request`.
14. **Repository identity appears only on host-feed workspaces** (revises decision 9's scope). It is built from cached Git data, has credentials stripped, and never contributes to the device-scoped workspace projection or revision.
15. **Feed chat summaries exclude Bot chats.** Bots travel as `bot.*` entries, and a Bot chat's `run.state` reaches only desktops that hold `bot:read`. Devices without `bot:read` get `bots: []` in the snapshot.
16. **The run-control idempotency ledger is in memory with a 10-minute TTL.** Keys match `^[\x21-\x7e]{16,128}$`. Errors are recorded as outcomes, so a replay returns the same error. A key reused with a different body returns `409 idempotency_conflict`, not `approval_resolved`.
17. **`run.ended` repeats the sequence of the terminal event it follows.** It is synthesized and carries no new journal entry. PR 3 clients must not discard it as a duplicate id.
18. **Host grants are negotiable without the progress opt-in.** Pairing issues them only with `acceptsProgressCapabilities`, but a paired `mac`/`linux` device can request them later through `POST /device/capabilities`. Phones are refused with 403 before the host reveals whether it serves the feed. A host without the services answers 404.
19. **The messages window is advertised to every device.** `chat-messages-window-v1` is read-only and uses the device's existing chat read access. The host feed, run-stream and run-control features are desktop-only.
20. **Revocation closes SSE subscriptions only.** In-flight controls are refused by the access check, and runs are never cancelled.
21. **`x-aiden-sse-event`** is a new OpenAPI extension naming each SSE event type and its payload schema.
22. **The shared SSE pump keeps one drain timer per blocked period.** Repeated writes against a full socket no longer stack timers.
23. **The fixture `capabilities` array stays mobile-only.** The pairing response enum is every capability except `simulators:control`.

## Global constraints

- Mobile behaviour must not change:
  - The `capabilities`, `events` and `chatProgressEvents` arrays in the legacy fixture stay byte-identical.
  - The fixture `health` object keeps its existing keys. New descriptor keys are added beside it in `hostHealth`.
  - Callers without the new grants take the existing device-scoped checks.
- The two fixtures (`protocol/aiden-remote/v1/fixtures/contract.json` and `android/app/src/test/resources/contract.json`) stay byte-identical.
- Bump the contract revision to 19 everywhere in one commit:
  - the docs
  - the OpenAPI document
  - the TS constant
  - both fixtures
  - the iOS and Android assertions
- Tests are behavioural:
  - Use register-and-invoke for routes.
  - Call real services with fixtures.
  - Do not grep source, write tautologies or add change detectors.
- Register every new test file in **both** `test:aiden-remote` and `scripts/ci-test-registry.json` (the same lane as `aiden-remote-streams.test.ts`).
- `/health` stays unauthenticated and exposes nothing secret: no secrets, paths, pins, account data or tokens.
- A repository `canonicalKey` never contains credentials or a local path.
- Verification commands:
  - `npm run type-check`
  - `npx eslint <touched files>`
  - `npm run test:aiden-remote`
  - `npm run test:ci-policy`
  - the Swift and Kotlin suites where the toolchains exist

## Review focus

1. **Approval race.** Two controllers plus the host UI respond at once. Exactly one decision reaches the tool, and every loser gets the same `409 approval_resolved` carrying the winning decision. A replayed Idempotency-Key returns the original outcome, including an original 409.
2. **Grant isolation.** A phone (`ios`/`android`) can never obtain `host:events`, `runs:observe` or `runs:control`, whether through pairing, `POST /device/capabilities` or persisted state. Without `runs:control`, approval `details` are stripped from run streams.
3. **Feed correctness without scans.** The feed derives every upsert and removal from the existing notify hooks plus a diff of the projection. A gap beyond retention or across an epoch produces a snapshot, never a silent skip.
4. **Revocation.** Revoking a controller closes its feed and run streams and refuses its in-flight controls. It never cancels a run that the controller did not start.
5. **Window bounds.** `GET /chats/{id}/messages` never exceeds 1 MiB, always reports `hasOlder` truthfully, and an unknown `before` is a typed conflict.

---

### Task 1: Grants, error codes and revision constant

**Files:**
- Modify:
  - `main/services/aiden-remote-protocol.ts`
  - `aiden-remote-state.ts`
  - `aiden-remote-pairing.ts`
  - `aiden-remote-router.ts`
  - `peer-host-registry.ts`
- Tests: extend `aiden-remote-protocol.test.ts`, the pairing and state suites, and the router capability tests.

**Interfaces (produces):**

```ts
export const AIDEN_REMOTE_CONTRACT_REVISION = 19;
export const AIDEN_REMOTE_HOST_CAPABILITIES = ["host:events", "runs:observe", "runs:control"] as const;
export type AidenRemoteHostCapability = (typeof AIDEN_REMOTE_HOST_CAPABILITIES)[number];
// error codes: "run_gone" (404), "approval_resolved" (409)
// error details: decision?, resolvedAt?, outcome?
export const AIDEN_REMOTE_FEATURES += "chat-messages-window-v1", "host-events-v1", "run-streams-v1", "run-control-v1"
```

- [ ] Pairing issues host grants only when `deviceType` is `mac`/`linux`. Persisted host grants on a phone record are stripped.
- [ ] `POST /device/capabilities` refuses host grants for phones with 403.
- [ ] The desktop exchange client sends `acceptsBotCapabilities` and `acceptsProgressCapabilities`.

### Task 2: Host-authority resolution in the registry and coordinators

**Files:**
- Modify:
  - `host-run-registry.ts` (`resolveAttention(id, resolution?)`, `resolution(id)`, `runForPrompt(id)`)
  - `tool-approval-coordinator.ts` (`decideAsHost`)
  - `ask-user-question-coordinator.ts` (`respondAsHost`)
  - `llm-client.ts` (`approveAsHost`, `answerQuestionnaireAsHost`)
  - `host-runs.ts`
- Tests: extend `host-run-registry.test.ts` and the coordinator suites.

- [ ] Two `decideAsHost` calls on one approval settle once, and the second reports `false`.
- [ ] The registry records the winning decision and returns it for losers.

### Task 3: SSE pump, run streams and run control

**Files:**
- Create:
  - `main/services/aiden-remote-sse.ts`
  - `aiden-remote-host-runs.ts`
  - `aiden-remote-host-runs.test.ts`
- Modify:
  - `aiden-remote-router.ts`
  - `aiden-remote-service-main.ts`
  - `aiden-remote-streams.ts` (`respondQuestionFromHost`)

**Interfaces (produces):**

```ts
GET  /runs/{runId}/events                  runs:observe   SSE, Last-Event-ID / ?after=
GET  /chats/{chatId}/runs/current/events   runs:observe   SSE from 0 for the chat's current run
POST /runs/{runId}/cancel                  runs:control   Idempotency-Key  {}                           -> {runId, state}
POST /runs/{runId}/approvals/{id}/respond  runs:control   Idempotency-Key  {decision:"allow"|"deny"}    -> {runId, approvalId, decision, resolvedAt}
POST /runs/{runId}/questions/{id}/respond  runs:control   Idempotency-Key  {value}                      -> {runId, promptId, outcome:"answered", resolvedAt}
POST /runs/{runId}/inputs                  runs:control   Idempotency-Key  {text, mode:"steer"|"follow_up"} -> {runId, accepted, position}
```

- [ ] Resume with `Last-Event-ID` replays only later events. A gap produces `snapshot`. An unknown run returns `404 run_gone`.
- [ ] A terminal event is followed by `run.ended`, and then the stream closes.
- [ ] Two controllers race one approval and one wins. The loser gets 409 `approval_resolved` with the winner's decision. A replay of either key is identical.
- [ ] 403 without `runs:observe`/`runs:control`. Approval details are stripped without `runs:control`.
- [ ] A phone-owned approval resolves through `respondApprovalFromHost`, so the phone's stream sees the resolution.

### Task 4: Host feed

**Files:**
- Create: `main/services/aiden-remote-host-feed.ts`, `aiden-remote-host-feed.test.ts`
- Modify: `aiden-remote-router.ts`, `aiden-remote-service-main.ts`

**Interfaces (produces):**

```ts
GET /host/events   host:events   SSE, id "<epoch>:<sequence>", 15 s heartbeat
events: snapshot | chat.upsert | chat.remove | workspace.upsert | workspace.remove | bot.upsert | bot.remove | run.state
```

- [ ] A snapshot comes first. Each change produces exactly one upsert or removal. `run.state` carries `{chatId, runId, state, unread}`.
- [ ] A cursor behind retention, from a foreign epoch or ahead of the head produces a fresh snapshot.
- [ ] Revoking the device closes its feed.

### Task 5: Transcript paging

**Files:** modify `aiden-remote-chats.ts` and `aiden-remote-router.ts`, and extend `aiden-remote-chats.test.ts`.

- [ ] `?limit` defaults to 50 (maximum 200). `before` is an exclusive message id. The window is at most 1 MiB, and oldest messages are dropped first. `hasOlder` is accurate.
- [ ] An unknown `before` returns 409 `revision_conflict` with `currentRevision`. An archived Bot chat stays hidden.

### Task 6: `/health` descriptor and repository identity

**Files:**
- Create: `main/services/repository-identity.ts`, `repository-identity.test.ts`
- Modify: `git.ts` (`status` reads `remote -v`), the router `/health`, and the workspace projection

- [ ] `canonicalRepositoryKey`:
  - strips userinfo
  - lowercases the host
  - normalizes scp-style URLs
  - drops the scheme and `.git`
  - rejects local paths and `file:`
- [ ] `/health` adds `instanceId`, `displayName`, `platform`, `contractRevision` and `pairingRequests`. Nothing it returns is secret.

### Task 7: Bot host-owner audience

- [ ] A desktop controller holding `bot:read` and `host:events` sees the host's Bot chats in the feed snapshot and can read them. A phone keeps its device audience.

### Task 8: Revocation

- [ ] `revokeAidenRemoteRuntimeDevice` closes feed and run subscribers and refuses in-flight controls for the device. Runs continue.

### Task 9: Contract artefacts and native clients

- [ ] Update `docs/aiden-remote-api-v1.md`, `openapi.json`, both fixtures (with the desktop-only `hostHealth`, `runEvents`, `hostFeedSnapshot`, `messagesWindow` and `runControlErrors` keys) and the TS fixture parser.
- [ ] iOS and Android:
  - know `run_gone` and `approval_resolved`
  - decode `decision`, `resolvedAt` and `outcome` details
  - assert revision 19
