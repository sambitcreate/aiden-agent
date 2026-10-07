# Desktop multi-host control

Status: Complete in code; packaged two-machine acceptance outstanding. All nine PRs are implemented. PR 1 (#310) is on main. PRs 2–9 are open as a stack (#313, #314, #315, #318, #311, #316, #317, #319, #336 and #337) and merge in that order. PR 9 added the end-to-end acceptance test over real TLS, the 1/5/10-host budgets below, per-frame coalescing of feed and token updates, and a fix that makes a resumed host-feed stream report itself open at once. Not yet done: the packaged Mac↔Mac run over LAN and Tailscale, and measured idle CPU, wakeups and memory on real machines.
Date: 2026-09-09; revised 2026-10-02.
Source baseline: `d724ff76d` (origin/main, 2026-10-02). Remote contract revision 18.

## Intended outcome

Any Aiden desktop can use its sidebar to control its own work and the work of every paired Aiden installation. Users can:

- open and continue chats and Bot chats on other machines
- watch and control live runs, wherever those runs started
- start new chats on another machine, in one of that machine's projects

Chats, providers, tools, files and execution stay authoritative on the machine that owns them. The client aggregates authorized views and sends each action to the owning host. Every machine is both host and client (symmetric peers). There is no primary machine and no central account. macOS and Linux share the protocol, and the actions available depend on the capabilities of each host.

## Decisions recorded on 2026-10-02

The user approved these after three research lanes covered Aiden's backend and protocol, Aiden's renderer integration, and the t3code/OpenCode/remodex/litter/hermes-webui reference repos:

| Topic | Decision |
| --- | --- |
| Topology | Symmetric peers. Every Mac or Linux install can control, and be controlled by, every other paired install. |
| v1 depth | Full chat parity: browse chats and projects, open transcripts, send, stream, stop, approve, answer questions, steer, and start new chats in a remote project. This includes runs started on the host's own screen, its phone, Bots or schedules. Terminal, browser/Environment and computer use are out of v1. |
| Authority | Pairing a desktop is full consent. A paired Mac/Linux controller may observe, stop, answer and approve any run on the host, including "always" scopes, with no extra per-host consent toggle. Mobile grants are unchanged. |
| Pairing | Simpler than QR, and Tailscale is mandatory. The flow is tailnet discovery, one-click request, approve on the host, with a setup-code fallback when nobody is at the host. LAN Bonjour browsing and pasted payloads are secondary. |
| Sidebar | Several organizations, inspired by t3code: Projects / Recent / Needs attention views; sort orders; cross-machine project grouping; a machine filter. |
| Chat types | Regular chats and Bot chats. The Assistant stays host-local in v1. |
| Onboarding | No tour tile and no illustration. Connections settings is the entry point. Optional pairing adds no onboarding step. |

The approved 2026-09-09 decisions stand unless this table overrides them:

- the Connections/sidebar/composer proposal in `docs/design/desktop-connections-proposal.html`
- host-bound existing chats
- no global IPC destination toggle
- execution-host models, skills and tools
- the efficiency rules

## Current state (verified 2026-10-02)

### Client foundation (PR #104, main process only)

- **Registry.** `main/services/peer-host-registry.ts` provides a safeStorage-encrypted `paired-hosts.json` registry. Limits: 32 hosts, 8 pending requests per host, 32 in total. Per-host epochs fence stale work, and self-pairing is rejected (`:180-292`).
- **Stale capabilities.** `verify()` re-reads `/server` but discards capabilities and features (`:144-161`), so grants stay frozen at their pairing-time values.
- **Pairing.** Only the full QR JSON payload is accepted (`peer-pairing.ts:45-83`). `decryptPeerPairing` (`:94-141`) has no caller. Nothing calls `POST /pairing/manual-bootstrap`. Desktops do not send `acceptsBotCapabilities` or `acceptsProgressCapabilities`, so they receive only the 13 legacy grants.
- **Transport.** `peer-transport.ts` always pins the SPKI and uses `agent:false`, which means a TLS handshake on every request. Responses, JSON bodies and SSE frames are capped at 1 MiB. SSE sessions have a 30 s inter-frame deadline and a 5-minute absolute cap (`:337`).
- **Operations.** `peer-operation.ts:56-134` defines 20 operations: 12 reads and 8 writes. Missing: SSE events, progress, questions, run inputs, attachments, skills, read markers, Bots.
- **IPC.** `main/handlers/peer-hosts.ts` exposes list, pair, setEnabled, remove and operation. It never passes `onFrame`, so no stream reaches the renderer. `peerHostsApi` (`renderer/lib/ipc.ts:236-244`) has no renderer consumer. Simulator sharing is the only real user of the registry.

### Host-side blockers (all still present)

| # | Blocker | Location | Size |
| --- | --- | --- | --- |
| a | Streams, approvals, questions and cancel are scoped to the creating device | `aiden-remote-streams.ts:876-882`, `:1367`, `:1387`, `:1412`, `:1451`, `:1521-1560`, `:1766` | M |
| b | Generation events go to a single owner, so runs started locally on the host never enter a remote stream journal | `chat-generation-owner.ts`; `llm-client.ts:611-632` | L |
| c | Whole chat returned in one ≤1 MiB / ≤10,000-message response, with 413 above that. `GET /chats` loads every transcript. | `aiden-remote-chats.ts:388-480`, `:1002-1007` | M |
| d | Every stream append re-snapshots and rewrites the whole stream store (SDR-3/4 deferred) | `aiden-remote-streams.ts:651-657`, `:966`; `aiden-remote-service-main.ts:338-350` | M |
| e | No host-wide change feed. Change hooks reach only the local renderer. | `aiden-remote-service-main.ts:469-471` | M |
| f | Summaries exclude Bot and Assistant chats, and Bot chats are audience-scoped per device | `aiden-remote-chats.ts:359-373`, `:1475`; `aiden-remote-router.ts:693-722` | M (Bots) |

Existing precedents to build on:

- Subagent interrupt is already chat-scoped (`aiden-remote-router.ts:2552-2571`).
- The host can already answer remote-started approvals (`respondApprovalFromHost`, `aiden-remote-streams.ts:1507-1519`).
- Sending a turn into a busy chat returns `409 turn_already_active` (`aiden-remote-chats.ts:1488-1492`).

### Tailscale

- Aiden publishes itself with `tailscale serve --https=443 --set-path=/api/aiden/v1 http://localhost:<port>/api/aiden/v1` (`aiden-remote-tailscale.ts:632-633`). It never uses Funnel.
- Status reads use `status --json --peers=false` (`:463`), so there is no discovery. Bonjour is publish-only (`aiden-remote-service.ts:326-422`).
- **Pin risk.** Tailscale pairing pins the live `*.ts.net` leaf SPKI (`aiden-remote-service.ts:1131-1134`). When the certificate renews with a new key, the client fails as `unavailable` instead of prompting for re-pairing.

### Renderer

- **Bare local IDs.** Everything is keyed by bare local IDs: about 155 touch points across about 25 files.
  - `/chat/$chatId` (`router.tsx:66`)
  - the single global workspace (`workspace-context.tsx`)
  - `queries.ts:46-106` keys
  - drafts (`chat-draft.ts`, `composer-draft-store.ts`)
  - module stores (`chat-terminal-sync.ts`, `chat-message-queue.ts`, `chat-deletion-cache.ts`)
- **Chat pane.** `chat-pane.tsx` is one 2,967-line function.
- **Reusable seams:**
  - `StreamCallbacks` (`ipc.ts:1354`)
  - `MessageList` (`chat-pane.tsx:2937`)
  - `projectSidebarWorkspaces`
  - the existing Organize menu (`chat-sidebar.tsx:1243-1262`, `workspace` | `recent`)
  - `chatRowStateFor` row states
- **Remote stream events.** The server derives SSE from the same local channels (`aiden-remote-streams.ts:1015-1110`). Most events map one-to-one onto `StreamCallbacks`. Artifact events and context pressure are not projected.

## Patterns adopted from reference repos

| Pattern | Source | Use in Aiden |
| --- | --- | --- |
| Identity independent of route | t3code `packages/contracts/src/environment.ts`, `docs/internals/remote.md` | Hosts are keyed by authenticated `instanceId`. LAN and Tailscale endpoints are alternative routes to one host, never two entries. OpenCode's URL-keyed servers are the anti-pattern. |
| Collision-safe composite keys | t3-swiftui `FeatureModels.swift:541-561`; t3code `client-runtime/src/environment/scoped.ts` | `HostResource {hostId, resourceId}` for every remote cache key, route, draft and mutation |
| Shell feed separate from detail streams | t3code `orchestrationV2.ts:1666-1801`, `threadRetention.ts` | One `/host/events` feed per host drives the sidebar. Per-chat live streams are reference-counted. |
| Snapshot + sequence, replay or snapshot | t3code `apps/server/src/ws.ts:587-838`, `shellReducer.ts:103`; hermes-webui SSE contract | Feed and live streams carry epoch + sequence. Small gaps replay, large or stale gaps send a snapshot event. |
| Wake-then-read journal | OpenCode `packages/core/src/event.ts:585-603` | Live subscribers wake on append and read from the durable journal after their cursor, so no subscriber needs its own unbounded buffer |
| Client-minted IDs, no blind replay | t3code `Orchestrator.ts:9278-9300`; t3-swiftui `NativeFeatureClient.swift:870-905` | Every remote mutation carries an Idempotency-Key. Ambiguous failures reconcile against host state and are never queued for a later replay. |
| First responder wins | t3code `Orchestrator.ts:6588-6640` (and OpenCode `permission.ts:220-258` as the race to avoid) | Approval and question resolution is atomic across the host UI, phones and desktop controllers |
| Supervisor per host | t3code `client-runtime/src/connection/supervisor.ts` | Backoff ladder, `blocked` state for auth/pin failures, generation counter, last-known rows kept while offline |
| Sidebar organizations | t3code `LegacySidebar.tsx:221-240`, `Sidebar.logic.ts` | Sort by last activity / created / manual. Project grouping by repository / repository+path / separate. Status priority (pending approval > awaiting input > working > completed). |

Not adopted:

- Effect RPC Chunk/Ack backpressure. It does not fit SSE.
- Hosted relays.
- OpenCode's shared password, its mDNS-as-trust, and its full refetch on every reconnect.
- Header trust from Tailscale Serve identity headers. A local process could forge them on the loopback upstream.

## Architecture

### 1. Pairing over Tailscale

**Discovery (client A).**
- A new `PeerDiscovery` service in main runs `tailscale status --json` with peers, through the existing fixed-path CLI resolver.
- The output is bounded, parsed only for online peers' MagicDNS names and OS, and never persisted.
- For each candidate, with at most 4 probes at a time and a 3 s timeout, A requests `GET https://<magicdns>/api/aiden/v1/health` with WebPKI trust.
- `/health` gains additive, unauthenticated, non-secret fields: `instanceId`, `displayName`, `platform`, `contractRevision` and `pairingRequests: boolean`.
- Discovery runs only while the "Add device" sheet is open. There is no background polling.
- A Bonjour `_aiden-agent._tcp` browse feeds the same list for LAN machines. Results are de-duplicated by `instanceId`, so a host reachable by both routes appears once.

**Request and approve (new contract surface).**

1. A creates an ephemeral X25519 key pair. It sends `POST /pairing/requests {deviceName, deviceType, publicKey}`. This route is unauthenticated and rate-limited (per source and globally), and is accepted only when "Accept connection requests" is on in B's Control this device settings (default on).
2. B returns `{requestId, pollSecret, expiresAt}`, with a 2-minute TTL. B shows an in-app sheet and a system notification: "MacBook Air wants to control this Mac."
3. Both screens show a 6-digit match code derived from `SHA-256(A publicKey ‖ B TLS SPKI ‖ requestId)`.
4. When the user clicks Allow, B issues the same device credential and grants as `/pairing/exchange` would. It seals the canonical pairing payload to A's public key with ECDH + HKDF + AES-GCM, reusing the existing manual-bootstrap envelope helpers.
5. A long-polls `GET /pairing/requests/{id}` with the poll secret (≤25 s per poll), opens the envelope, and completes the normal pinned exchange path in `PeerHostRegistry.pair()`. Deny, expiry or cancellation ends the request with no credential.
6. Credential persistence happens before the registry entry is published, with rollback on failure. This keeps the existing rule.

**Setup-code fallback.** When nobody is at B, A uses "Enter setup code" with the discovered address prefilled. A new unpinned bootstrap session calls `POST /pairing/manual-bootstrap`, then `decryptPeerPairing`. iOS precedent: `AidenSealedBootstrapSessionDelegate`, `ios/AidenOnTheGo/Networking/AidenServerTrust.swift:219`. "Paste pairing link" remains an advanced fallback.

**Tailscale certificate rotation.** For hosts paired through the Tailscale route (`trust: system`), the client accepts a WebPKI-valid leaf for the exact paired MagicDNS name. When the leaf SPKI changes, A re-pins automatically after `/server` confirms the same `instanceId` with A's credential, and records a diagnostics event. LAN private-CA routes keep strict pinning. A pin mismatch on a LAN route moves the host to `blocked: identity_changed` and shows a re-pair prompt, not `unavailable`.

### 2. Authority — contract revision 19

The revision is claimed at merge time, per `AGENTS.md`. New grants are issued at pairing to `mac`/`linux` devices only, mirroring `simulators:control` (`aiden-remote-protocol.ts:77-88`). Existing desktops can negotiate them through `POST /device/capabilities`.

- `host:events`: the host-wide feed.
- `runs:observe`: the live stream of any run in a visible chat, whatever its origin.
- `runs:control`: cancel any run, answer its approvals (all scopes) and questions, and post steer/queue input.
- Desktop pairing also opts into the progress grants and Bot grants (`acceptsProgressCapabilities` and `acceptsBotCapabilities`). The Bot audience gains a host-owner audience that `mac`/`linux` controllers with `bot:read` share, so the host's own Bot chats become visible to them.

Device-scoped checks stay in force for every caller without the new grants, so mobile behaviour and legacy fixtures do not change.

Approvals are resolved atomically, and the first decision wins. Losers receive `409 approval_resolved` carrying the winning decision. `runs:control` holders receive full tool details: tool name, target, arguments preview and scope options, the same projection the host UI shows. Mobile keeps the summary projection.

Revoking a controller drains its subscriptions and in-flight controls without cancelling runs it did not start.

### 3. Host backend

- **Run observer bus.** `llm-client.ts` keeps one generation owner, but every generation event is also appended to a `HostRunRegistry`. This covers local renderer, remote device, Bot, schedule, Telegram and child-run origins. The registry owns an in-memory, per-run journal with `runId`, a per-process epoch, contiguous sequences and bounded retention: 4,096 events or 4 MiB per run, 32 MiB in total, 128 runs, and 10 minutes after a run ends. A host restart changes the epoch, which tells observers to take a fresh snapshot. Both journals produce events through one shared content projection (`run-event-projection.ts`), so the durable device stream journal keeps its current mobile wire format. Making the device journal a view over the registry is deferred to PR 2, where the `/runs/*` routes need it.
- **Persistence fix (blocker d).** PR 1 coalesces non-boundary stream-journal writes (deltas, timeline, tool progress) into at most one write per 250 ms, and writes immediately at terminal, approval, question, cancel, snapshot and state-change boundaries. Per-run append-only segments remain an option if measurements in PR 9 show the coalesced checkpoint is still too costly. If text batching is used, the amount of RAM-only text that can be lost is bounded and documented. Wake-then-read delivery means slow subscribers read from the journal rather than growing their own buffers.
- **Host feed.** `GET /host/events` (SSE, `host:events`) emits:
  - `snapshot {epoch, sequence, summaries, workspaces, bots}`
  - upserts and removals for `chat`, `workspace` and `bot`
  - `run.state {chatId, runId, state: working|needs_approval|needs_input|done|failed|cancelled, unread}`
  - a heartbeat every 15 s

  A gap beyond replay retention (1,000 events or 8 MiB) produces a fresh `snapshot`. The feed is fed by `ChatActivityRegistry` and the existing `chats:changed` hooks, not by scanning transcripts.
- **Live stream.** `GET /chats/{chatId}/runs/current/events` and `GET /runs/{runId}/events` (SSE, `runs:observe`) resume through `Last-Event-ID`. They use the same event types as `/streams/{id}/events`, plus `run.started` and `run.ended`. A run that has gone returns `404 run_gone`, documented and fixture-tested. This also resolves the existing `stream_gone` vs `not_found` mismatch.
- **Control routes.** `POST /runs/{runId}/cancel`, `/runs/{runId}/approvals/{id}/respond`, `/runs/{runId}/questions/{id}/respond` and `/runs/{runId}/inputs` require `runs:control` and an Idempotency-Key. Each checks the current run identity and revision.
- **Transcript paging (blocker c).** `GET /chats/{chatId}/messages?before=&limit=` (feature `chat-messages-window-v1`) returns a recent window of at most 1 MiB plus a `hasOlder` cursor. The existing `GET /chats/{id}` stays as-is for old clients. The projection adds `turnStats`, `skill` and subagent references when the feature is negotiated.
- **Repository identity.** The workspace projection gains an optional `repository {canonicalKey, relativePath}`. `canonicalKey` is the normalized origin remote URL with credentials stripped. It is computed only from data already cached for the Git display, never by crawling.
- **Bots (blocker f).** Bot summaries and Bot chats enter the feed and summaries for `bot:read` controllers through the host-owner audience.

Every new route, field and feature is added to `docs/aiden-remote-api-v1.md`, the OpenAPI schema, the TypeScript contract constants and the shared fixtures in one phase. Swift and Kotlin decoders must tolerate it, with tests.

### 4. Controller main process

- **`PeerHostManager`.** One supervisor per enabled host, with states `connecting → connected → backoff(3,4,8,16,30 s ±jitter) → blocked(auth|identity_changed|protocol) → disabled`. Backoff resets after 30 s of stable connection, and a generation counter fences each transition. Disabled hosts produce zero traffic. Sleep/resume and network changes trigger one coalesced reconnect.
- **Connections.** A keep-alive `https.Agent` per host replaces `agent:false`. SSE sessions reconnect transparently with `Last-Event-ID` across the 5-minute transport cap.
- **Feed.** Each connected host keeps one `/host/events` subscription. The manager maintains a bounded per-host summary cache, which renderers receive as `remote:host-feed {hostId, epoch, sequence, change}` broadcasts. Several windows share one subscription.
- **Live streams.** `remote:peerRunSubscribe(hostId, chatId|runId, afterSequence)` and `remote:peerRunUnsubscribe` are reference-counted and evicted 5 minutes after the last viewer leaves. Running chats stay subscribed while their row is visible. Frames are broadcast as `remote:peer-run-frame {hostId, runId, event}`.
- **Operations.** The closed operation set gains:
  - `messagesWindow`, `attachmentContent`, `markRead`, `skills`, `progress`
  - `respondQuestion`, `inputs`
  - `runCancel`, `runRespondApproval`, `runRespondQuestion`
  - Bot reads and writes
  - `pairingRequest` and `manualBootstrap`

  `verify()` now persists refreshed capabilities and features.
- **Limits.** Raise or partition the request limits so feed and live subscriptions do not use up the 8-per-host pending budget for unary requests. Long-lived subscriptions get their own cap: 1 feed plus 16 live streams per host, and 64 in total.
- **Credentials.** Credentials never reach the renderer.

### 5. Renderer

- **Keys and routes.** Local keys, routes and stores stay unchanged; they are the local fast path. Remote data lives in a parallel namespace:
  - `renderer/lib/hosts/host-query-keys.ts` with `["host", hostId, …]` keys
  - the route `/host/$hostId/chat/$chatId`
  - host-qualified draft and queue keys (`hostResourceKey`)
- **Adapters.** `HostChatAdapter` exposes capabilities, `getMessagesWindow`, send, observe, cancel, `respondApproval`, `answerQuestion`, steer, rename, remove and `markRead`.
  - `local-host-adapter.ts` wraps `chatsApi` and `startGeneration` with no behaviour change.
  - `remote-host-adapter.ts` wraps the peer IPC.
  - `remote-chat-mapper.ts` maps a remote projection to `Chat`.
  - `remote-stream-translator.ts` maps remote events to `StreamCallbacks`, using a reset on `snapshot`.
- **Chat pane.** Extract a `useChatSession(adapter, ref)` hook from `chat-pane.tsx`, so that a single pane serves both local and remote chats. Local-only panels read adapter capabilities instead of calling local APIs unconditionally. Extraction happens in the PR that needs it, not as a separate refactor.
- **Host binding and fencing.** An operation captures its `hostId` when it starts. Late responses are fenced by the supervisor generation, and switching selection never retargets in-flight work.
- **Capability treatment for remote chats.**
  - Works: transcript, send, stop, approvals, questions, steer/queue, read markers, rename, delete, models, skills, attachments.
  - Read-only: files and Git through the remote reads.
  - Hidden: terminal, Environment/browser, computer use, open-in-editor, reveal in Finder, BTW card, compact, context meter.
  - Unsupported actions are hidden or disabled with a reason. They never fall back to running locally.
- **Composer.** For new chats, the static "Local" label (`composer.tsx:~1814-1821`) becomes a machine picker. Choosing a host loads that host's projects and folder browser (roots → children → selectFolder → createWorkspace), models and skills. Drafts are kept per host. Existing chats stay bound to their host, and the picker is not shown for them.
- **Bots.** Remote Bots appear in the Bots area with the globe marker and route through the same adapter.
- **Offline host.** Last-known rows stay visible. They are marked stale and read-only, the host status shows `Offline · Reconnect`, and mutations are disabled. There is no offline mutation queue.

### 6. Sidebar organization

This extends the existing **Organize sidebar** menu. Preferences are client-local and persisted in the existing sidebar preferences.

- **View.**
  - *Projects*: existing workspace groups, now multi-host.
  - *Recent*: the existing flat chronological buckets.
  - *Needs attention*, a new triage view. It orders chats as needs approval > needs input > working > unread done > everything else, then by last activity.
- **Sort.**
  - Chats: *last activity* (default) or *created*.
  - Projects: *last activity*, *created* or *manual*. Manual order is keyed by host-qualified project key.
- **Group projects across machines.**
  - *Keep separate* (default): each host's project is its own group, labelled with the machine.
  - *Same repository*: projects with the same `repository.canonicalKey` merge into one group with machine badges. New chats from that group ask which machine to use, and default to the machine that already has the project.
  - *Same repository and path*: groups only when `relativePath` also matches.

  Projects without a repository identity never merge.
- **Machine filter.** All machines (default), This Mac, or each paired host. It sits in the Organize menu, and a compact chip in the sidebar header shows when it is not "All". Remote rows get the soft globe marker. Its tooltip and accessible name are the host's display name, with the instance suffix added when two hosts share a name. Host status uses existing semantic fills.

The sidebar filter, the selected chat's host and the composer's host remain three separate pieces of state.

### 7. Settings — Connections

- Keep the `remoteAccess` section id, which tests and deep links use. Retitle it **Connections**, with two segments:
  - **Control this device**: the existing inbound content plus the "Accept connection requests" toggle and the pending-request sheet.
  - **Control other devices**: paired hosts with status, Reconnect, an enable toggle and a "···" menu (Rename locally, Re-pair, Forget), plus an **Add device** sheet with tailnet/LAN discovery, Connect, Enter setup code and Paste pairing link.
- Follow `docs/settings-design-system.md`, `docs/design-guide.md` and the two ChatGPT reference documents:
  - squircle actions
  - no accent focus ring on text inputs
  - soft status fills
  - no borders on choice cards

## Delivery sequence

Nine PRs, each mergeable on its own, with the narrow suites green locally before review.

| # | PR | Scope | Exit criteria |
| --- | --- | --- | --- |
| 1 | Run observer bus + persistence ([task plan](desktop-multi-host-pr1-run-observer-bus.md)) | `HostRunRegistry`, fan-out from `llm-client`, shared content projection, coalesced stream-journal persistence (blocker d) | Local renderer behaviour unchanged. Mobile stream tests pass unmodified. Streaming no longer rewrites the journal on every token. |
| 2 | Contract rev 19 — host feed, run streams, control, paging ([task plan](desktop-multi-host-pr2-host-contract.md)) | `/host/events`, `/runs/*`, `/chats/{id}/messages`, `/health` descriptor fields, repository identity, new grants, first-responder approvals with full details, Bot host-owner audience; docs + OpenAPI + fixtures; iOS/Android decoder tests | Two controllers racing an approval resolve once. Mobile isolation unchanged. Swift and Kotlin suites pass. |
| 3 | Controller supervisor + stream IPC ([task plan](desktop-multi-host-pr3-peer-manager.md)) — in progress | `PeerHostManager`, keep-alive agent, feed and run subscriptions over IPC, expanded operations, capability refresh, subscription budgets | Colliding-ID two-host fixture. A pin mismatch blocks the host. 5-minute cap crossed without loss. Late responses after a switch are fenced. |
| 4 | Pairing + Connections UI | Tailscale/Bonjour discovery, request/approve routes and sheet, match code, setup-code bootstrap client, Tailscale re-pin rule, Connections settings | Real two-Mac tailnet pairing in one click. Deny, expiry and rate-limit paths. Self-pair rejected. Credentials never reach the renderer. |
| 5 | Sidebar | Remote rows from the feed, machine filter, globe marker, the three views, sorts, cross-machine grouping, offline/stale state | Behavioural tests on the pure projection, with fixtures for identical names and IDs across hosts. `renderToStaticMarkup` for the menu and states. |
| 6 | Remote chat view + live observation | Host route, mapper, translator, messages window with "load older", observing runs started on B's screen | A run started on B's screen streams on A. Gap → snapshot recovery. Large chat opens. |
| 7 | Control | `useChatSession` extraction, send/stop/approve/answer/steer through adapters, composer capability gating | Same pane drives local and remote. Lost acknowledgement + retry yields no duplicate turn. Stop of a run started on B. Approval race. |
| 8 | New chat on a remote machine + Bots | Composer machine picker, remote projects/folder browser, createWorkspace/createChat, remote models/skills, attachment upload, per-host drafts, remote Bots | New chat runs on B in B's project. No remote path reaches a local API. |
| 9 | Acceptance + docs | 1/5/10-host performance budgets, packaged Mac↔Mac LAN + Tailscale run, `.memory/` notes, plan index | Wire bytes, request fan-out and renderer work recorded (see [Efficiency budgets](#efficiency-budgets)). Local-only behaviour with no peers is unchanged. Outstanding: the packaged run and idle CPU, wakeups and memory. |

Linux→Mac and Mac→Linux acceptance waits for the reconciled Linux branch (PR #71/#89 lineage). The protocol and platform seams are built against current main, and Linux completion is not claimed from historical CI.

## Efficiency budgets

The budgets are enforced by deterministic tests at 1, 5 and 10 paired hosts. No test reads the clock to judge speed; each counts bytes, requests, messages or row reads.

| Budget | Rule | Measured in PR 9 | Test |
| --- | --- | --- | --- |
| Feed connections | One `/host/events` subscription per enabled, connected host. Disabled hosts send nothing. Live run subscriptions only for visible, running or open chats. | 1 per host at every host count. | `main/services/peer-host-manager.test.ts` |
| Sidebar reads | No transcript, list or Git read to build the sidebar. | The only request per host is `/host/events`. | `main/services/peer-host-manager.test.ts` |
| Feed cache | At most 2,000 chats per host (`PEER_FEED_MAX_CHATS`); the newest are kept and older rows page in on demand. | A host with 2,500 chats keeps its newest 2,000. | `main/services/peer-host-manager.test.ts` |
| Snapshot size | Snapshots are split into 256 KiB chunks; each frame stays within one chunk plus a 4 KiB envelope, and only the last carries an event id. A host's wire cost does not depend on how many other hosts are paired. | 2,500 chats: 3 frames of 262,286, 262,211 and 40,436 bytes (564,933 in total) per host; one renderer reset of about 453 KB per host. | `main/services/peer-host-manager.test.ts` |
| Wake fan-out (revision 25) | Sleep, unlock and network changes within 500 ms (`PEER_WAKE_COALESCE_MS`) coalesce into one bounded identity/health check. Healthy feeds remain open; failed connections resume their cursor. | 1 request per healthy host at 1, 5 and 10 hosts; 0 for a disabled host. A fallback may add one preferred-route preflight per 30 seconds. | `main/services/peer-host-manager.test.ts` |
| Renderer feed updates | Feed messages are held per host and applied once per animation frame; more than 512 queued for one host (a hidden window) collapse into one resync. | A 200-message burst per host renders once per host in one frame. | `renderer/lib/hosts/peer-host-feed-state.test.ts` |
| Token rendering | The open remote chat re-renders streamed tokens once per frame; the end of a run renders at once. | 60 streamed tokens render once, in one frame. | `main/services/peer-remote-chat-view.test.ts` |
| Sidebar organize | Organizing all hosts' rows stays within 12·n·log₂n row reads for every view and grouping. | 10 hosts × 2,000 chats: projects 751,338, recent 1,402,676, needs attention 1,920,902 reads, against a budget of 3,429,051 (about 7·n·log₂n). | `renderer/lib/sidebar-remote-groups.test.ts` |

Idle CPU, wakeups and resident memory need the packaged two-machine run and are not yet measured.

## Acceptance

`main/services/peer-multi-host-acceptance.test.ts` runs one Mac controlling another over real TLS. The host side uses the real router, run registry, host feed and run services; the client side uses the real registry, `PeerHostManager`, renderer IPC, sidebar projection, `RemoteHostAdapter`, `RemoteChatSession`, `ChatSessionControl` and `RemoteNewChatControl`. In one pass it:

1. pairs by setup code;
2. builds the sidebar from the feed alone (project, repository, both chats, no transcript reads);
3. opens a remote chat and reads its messages window;
4. watches a run, shows Needs approval in the sidebar, approves one request, denies another, then stops the run;
5. sends a message and follows the reply to its end;
6. starts a new chat in the host's project and opens a Bot chat, which is reused on the second open;
7. drops every connection, shows the host offline, and resumes the feed from its cursor;
8. serves a new key, blocks the host as `identity_changed` with stale rows, refuses a plain reconnect, and recovers after re-pairing.

Step 7 found a real bug: Node does not send response headers until the first body write, so a resumed feed with nothing to replay stayed "syncing" and stale until the next change or the 15 s heartbeat. `openCursorSse` now flushes the headers when it opens the stream. The host feed and run streams are the only users, and both are desktop-only, so the native clients are unaffected.

The per-flow suites from PRs 2–8 stay the detailed coverage: `peer-host-pairing.test.ts` and `main/handlers/peer-pairing.test.ts` (pairing paths), `peer-host-manager.test.ts` (supervisor, budgets), `sidebar-remote-groups.test.ts` (sidebar), `peer-remote-chat-view.test.ts` (observation), `peer-remote-chat-control.test.ts` (control and races) and `peer-remote-new-chat.test.ts` (new chats, uploads and Bots).

## Verification matrix

- **Registration.** Register new tests in the root `package.json` test chain, resolving conflicts by union.
- **Host-scoping and pairing:**
  - two in-process hosts with identical chat, workspace, provider and host names and IDs
  - host rename
  - the same host at a LAN and a Tailscale address
  - self-pair
  - A→B→A late responses
  - forget/revoke then re-pair
  - Tailscale leaf rotation re-pin
  - LAN pin mismatch blocks the host
- **Runs and control:**
  - runs started locally, by a phone, by a Bot, by a schedule and by Telegram, all observed and controlled by A
  - the mobile device-scoped denial still holds
  - controller races on stop, approval and question
  - an "always" approval granted from A is honoured on B
- **Recovery:**
  - lost acknowledgement then same-key retry
  - a host crash mid-run reports the actual interrupted state
  - sleep/resume
  - feed gap → snapshot
  - a slow consumer does not grow host memory
- **Boundaries:**
  - remote paths, attachments and artifacts never reach local handlers
  - attachments upload to the chosen host
  - Quick View/Environment state stays local and scoped to its source
- **Clients:**
  - Playwright against a fake peer covering sidebar, remote chat, send/stop/approve and new remote chat
  - iOS and Android suites for the rev 19 fixtures

Tests stay behavioural, following the `AGENTS.md` rules: no source-grep contracts and no snapshot change-detectors.

## Out of scope for v1

- Remote interactive terminals: they need a new security contract.
- Remote browser viewing.
- Remote computer use and microphone.
- Full remote Settings administration.
- Assistant chats from other hosts.
- Chat migration, replication and failover.
- SSH routes.
- Keep-awake.
- A headless host daemon (the CLI daemon is a separate track).
- Any onboarding tour tile.

## History

- 2026-09-09: Original plan. Three exploration lanes and two planning lanes. Peer foundation merged in PR #104 (`900af0c2a`, `5ef3d28dd`). Connections/sidebar/composer proposal approved (`6397b4863`).
- 2026-10-02: Re-scoped after three research lanes covered current Aiden backend/renderer state and the t3code/OpenCode reference implementations. The user approved symmetric peers, full chat parity including runs started elsewhere, full authority on pairing, Tailscale-first one-click pairing, t3code-style sidebar organizations, Bots in scope, and no tour tile. The nine-PR sequence above replaces the earlier seven-milestone sequence.
- 2026-10-04: PR 9 added the acceptance pass and the 1/5/10-host budgets, and moved this plan and its task plans to `completed/`. The packaged two-machine run and idle measurements remain.
