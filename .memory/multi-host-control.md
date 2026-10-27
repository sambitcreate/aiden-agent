# Desktop multi-host control: shipped architecture — 2026-10-04

Plan: `docs/plans/completed/desktop-multi-host-control-plan.md` (with its PR 1–8 task plans beside it). All nine PRs are on main and ship in 0.53.0: #310, #311, then the stack #313 → #314 → #316 → #317 → #319 → #336 → #337, merged with merge commits on 2026-10-04. The side branches #315 and #318 conflicted with the main line alone; #337 carried their resolutions, so GitHub marked them merged with it. Per-PR notes: `.memory/multi-host-pr8-remote-new-chat.md`.

## Shape

- Symmetric peers. Every desktop is host and client. Pairing a desktop grants full chat authority (`host:events`, `runs:observe`, `runs:control`, chat/workspace/Bot grants); mobile grants are unchanged.
- Host side (main):
  - `HostRunRegistry` journals every generation, whatever started it (PR 1).
  - `AidenRemoteHostFeedService` serves `GET /host/events`: chunked 256 KiB snapshot, upserts/removes, `run.state`, `stale`; `epoch:seq` cursor, resumable with `Last-Event-ID`.
  - `AidenRemoteHostRunService` serves run streams and run controls; approvals are first-responder-wins.
  - Both stream through `openCursorSse` (`main/services/aiden-remote-sse.ts`), a wake-then-read pump over the source journal.
  - Pairing requests: `aiden-remote-pairing-requests.ts` (match code, sealed envelope, "Accept connection requests").
- Client side (main):
  - `PeerHostRegistry` stores hosts and credentials.
  - `PeerHostManager` (`peer-host-manager.ts`) supervises each enabled host: connecting → connected → backoff → blocked (`identity_changed`, auth, protocol) → disabled. It keeps one feed per host, capped at `PEER_FEED_MAX_CHATS` (2,000) newest chats, and reference-counted run streams.
  - `wake()` coalesces sleep, unlock and network changes within `PEER_WAKE_COALESCE_MS`. `reconnect(hostId, {repaired})` clears a block after re-pairing.
  - Closed operations are in `peer-operation.ts`. Credentials never reach the renderer.
- Renderer:
  - `renderer/lib/hosts/`: `peer-host-feed-state.ts` (per-host feed store plus a per-frame batcher), `remote-host-adapter.ts`, `remote-chat-session.ts` (frame-batched token renders), `chat-session-control.ts`, `remote-new-chat.ts`.
  - Sidebar projection: `sidebar-remote-groups.ts`.
  - Routes: `/host/$hostId/chat/$chatId` and `/host/$hostId/new`. A remote route never reaches a local API.

## Invariants

- A resumed SSE stream must flush its headers at open (`response.flushHeaders()` in `openCursorSse`). Otherwise a resume with nothing to replay never fires the client's `onOpen`, and the host stays "syncing" and stale until the next change or the 15 s heartbeat. The acceptance test reproduces this because its feed heartbeat is one hour.
- The renderer applies feed messages once per animation frame. More than 512 queued for one host collapse into one resync.
- A connection-request pairing keeps withdrawal ownership until the host is saved locally: `requestPeerPairing` takes an `install` callback (the registry's `/server` confirmation plus `storage.save`) and sends `DELETE /pairing/requests/{id}` if it throws or is cancelled. The host revokes the issued device on that cancel even after the envelope was delivered, so a pairing this device never saved leaves no working credential on the other Mac. The host acknowledges that cancel only after the revocation is durable (otherwise `500 internal_error`, retryable); a withdrawn device still live is revoked at record retirement or `close()`. Setup-code pairing (`/pairing/exchange`) has no such rollback.
- Remote chat footers must not wrap the `Composer` or `AskUserQuestionComposer` in `aiden-dock-inset chat-content-column`: both carry that inset themselves. Wrapping them (as `remote-chat-view.tsx` and `remote-new-chat-view.tsx` did from 2026-10-03 to 2026-10-27) applied the 6rem dock gutter twice, so the remote composer was 192px narrower than a local one and hit the composer's compact container queries. Cards and notices go in their own inset wrapper; the remote view tests check that no `.chat-content-column` surrounds the composer.
- The remote chat header names the host with `RemoteHostChip` (`sidebar-remote.tsx`) in `titleAccessory`, where a local chat shows `WorkspaceChip`. It is not a `workspace-chip`, so it does not hide in narrow toolbars. The old "Studio · Connected" subtitle is gone.
- A host's wire cost does not depend on how many other hosts are paired. Before revision 31, a wake cost 2 requests per host (`GET /server` plus a feed resume) and no new snapshot. Revision 31 retains healthy streams and costs one bounded identity/health check per healthy host.

## Tests

- **Acceptance:** `main/services/peer-multi-host-acceptance.test.ts`, one real-TLS pass. It covers:
  - pairing by setup code
  - the sidebar
  - opening a chat
  - approve, deny and stop
  - send
  - a new chat and a Bot chat
  - drop and resume
  - key rotation, block and re-pair

  It runs in about 1 s.
- **Fixtures:**
  - `peer-pairing-test-host.ts` is a real HTTPS host. Its `services` option takes `chats`, `bots`, `hostFeed` and `hostRuns`; it also has `dropConnections()`, `rotateLeaf()` and `impersonate()`.
  - `peer-remote-chat-test-host.ts` provides `rendererIpc()` and the fake-host harness.
- **Budgets at 1, 5 and 10 hosts.** The numbers are in the plan's Efficiency budgets table.
  - `peer-host-manager.test.ts`: snapshot frames and wake fan-out
  - `peer-host-feed-state.test.ts`: frame batching
  - `sidebar-remote-groups.test.ts`: row reads within 12·n·log₂n
  - `peer-remote-chat-view.test.ts`: tokens rendered per frame

## Outstanding

- The packaged Mac↔Mac run over LAN and Tailscale.
- Idle CPU, wakeups and memory measurements.
- Linux↔Mac acceptance, which waits for the Linux branch.


## Connection reliability implementation — 2026-10-06

- Revision 31 adds authenticated desktop-only `peer-routes-v1` advertisements.
  Verified paired channels deliver route-specific LAN CA/SPKI and bounded private
  address hints; Tailscale remains WebPKI plus SPKI. All route trust stays in main.
- `peer-routes.ts` validates canonical LAN/Tailscale route hints. Registry stores
  alternate routes encrypted, prefers LAN, fails over during connection admission,
  and preflights return to LAN at a 30-second cadence on fallback only. It never
  retries a mutation on another route. Learned route removal persists suppression;
  explicit restore or re-pair clears it. Legacy single-route registries still load.
- Registry verification/pools are scoped to route trust revision. Tailscale repin
  verifies the exact saved hostname and instance even for a learned route.
- Wake/unlock/network notifications health-check a connected host instead of
  reopening a healthy feed. Failed probes retain the existing backoff/block rules.
  Renderer status adds sanitized failure, last synced time, and route summaries.
- Android now pairs as `android`, under phone grants. Progress cursor resumes are
  fenced by `Aiden-Progress-Epoch` and confirmed through `Aiden-Progress-Resumed`.
- Focused behavioral tests cover learning CA trust, fallback, cooldown, suppression,
  revocation across routes, keeping healthy streams, and withholding HTTP request
  bytes from a wrong-pin endpoint. Packaged physical-device acceptance and measured
  idle CPU/wakeups remain outstanding; unit/TLS fixtures do not close those gates.

- Deferred-advertisement follow-up: a connected LAN peer with route support, no
  known Tailscale route, and no suppression makes at most two authenticated identity
  reads after 25 and 100 seconds; each has a 5-second deadline. The final delay covers
  three attempts of two sequential 15-second CLI reads, two 75ms retry pauses, and
  a 5-second TLS check (95.15s). Both timers are generation-bound, skipped after
  discovery/suppression, and never become idle polling. Failed discovery can leave
  no route; these reads do not guarantee later availability.
  Same-ownership validated observations remain available during bounded server
  refresh; failure/key change clears the observation. It is still independently
  verified before use. Tests cover delayed collection, retained feeds, and failover
  after LAN loss without incidental wake.


## Feature-token budget and the Bot split — 2026-10-20

- 0.59.0 regression: a fully wired host announced 33 `/server.features` to a paired Mac (32 after `chat-visual-viewer-v1`, plus `chat-ui-panels-enabled-v1` when **Paired-device chat controls** is on). The desktop parser (`peerStrings(server.features, 32)`) threw "Invalid peer capabilities." and the host showed as unavailable. Phones topped out at 30.
- Fix: `aidenRemoteServerFeatures(device, support)` in `aiden-remote-router.ts` scopes tokens by audience. Desktops are not told about phone surfaces (`chat-ui-panels-v1`, `chat-ui-panels-enabled-v1`, `tts-v1`, `speech-request-gzip-v1`, `providers-create-v1`); fully wired counts are 28 (desktop) and 30 (phone). The desktop client now accepts up to `PEER_MAX_SERVER_FEATURES` (64). Router test "a fully wired host tells every device type at most the server feature budget…" turns every support flag on through a Proxy and checks each device type, plus that a Mac keeps every `remoteHostCapabilities` gate. The old protocol test only counted exported `*_FEATURE` constants and missed literal tokens; it was removed.
- Was open, fixed in the same PR (#560): the desktop peer client never used the durable Bot session API. `POST /bots/{id}/chats` returned the emptied canonical row and `/chats/{id}/turns` ran a legacy `llmClient` Bot turn (a separate transcript; in practice it 404'd "This Aiden chat no longer exists." because the write authorizer admits as the device id, which has no stored Bot notice). The acceptance fixture stubs `authorizeRetainedBotChat`, so tests never saw it.
- Desktop Bot client now: peer operations `botSession`, `botSend`, `botResume|Dismiss|Stop`, `botAnswerQuestion`, `botConnectionRequest`, `uploadBotAttachment`/`removeBotAttachment` (approvals reuse `respondApproval` with the waitId). Ambiguous Bot mutations reconcile with one `botSession` read. `PeerBotSessionStreams` (`peer-bot-sessions.ts`, owned by `PeerHostManager`) keeps one `/bots/{id}/session/events` stream per host+Bot shared by windows, broadcasts on `remote:peer-bot-session`, reconnects with backoff (every connection opens with a snapshot; no cursor), 4xx other than 409 = `gone`. IPC `remote:peerBotSessionSubscribe/Unsubscribe`. Renderer: `remote-bot-session.ts` maps the Remote session onto `BotLiveSnapshot` (no `bot:cards`, so memory/proposal cards are skipped), `RemoteBotSessionFollower` reads then applies `(epoch, seq)` events and re-reads on a gap, `RemoteBotChatView` at `/host/$hostId/bots/$botId/chat` reuses `TranscriptEntries` and the cards. `useRemoteBots.open` uses it when `hostSharesBotSessions(view)`.
- Host: `AidenRemoteChatService` option `durableBotSessions()` refuses `/chats/{id}/turns` on Bot chats with 400 "Update Aiden on this device…". Desktops negotiate `bot:activity` (gated by `bot-activity-v1`). Malformed `peerRoutes` hints are ignored instead of failing the connection. macOS `extendInfo` gained `NSLocalNetworkUsageDescription` and `NSBonjourServices: ["_aiden-agent._tcp"]` (packaged builds only; the dev runtime script does not set them).
- Still open: durable Bot turns are absent from `HostRunRegistry`, so remote sidebars show no Bot run state; the CLI daemon serves no host feed, runs or durable Bot sessions (desktops cannot see its Bots; documented in packages/cli/README.md); packaged Mac-to-Mac acceptance has never been run; no remote "remove queued message" or "dismiss connect card" route.

## Paired-Mac composer context meter, revision 41 (provisional) — 2026-10-27

- Host: `GET /chats/{chatId}/context[?providerId=&modelId=]` (route label `chatContext`), feature `chat-context-pressure-v1`, announced to desktops only (phones' 32-token budget). `AidenRemoteChatService.contextPressure` reuses main's `chatContextPressure` (the `chats:contextPressure` path, wired in `aiden-remote-service-main.ts`), validates a picked pair with `models.resolve` (unknown = 400), refuses Bot chats (404, like forks), and reduces the projection with `projectAidenRemoteContextPressure` to 11 allowlisted counts (`AIDEN_REMOTE_CONTEXT_PRESSURE_FIELDS`). `pressure: null` when the host cannot project. No breakdown, prompt cache, anchor detail, names, paths or draft text.
- Request query encoding (revision 41): the router used to refuse any `%` in a URL, which broke every client's Bot inbox search with a space (desktop `encodeURIComponent`, iOS `URLQueryItem` → `%20`, Android raw interpolation) and Android's encoded `since=`. Now paths still refuse `%`, query strings accept well-formed UTF-8 `%XX` that decode to no control (`isSafeEncodedQuery` in `aiden-remote-router.ts`). Clients encode with a host-safe encoder (`hostQueryValue` in `peer-operation.ts`, `AidenHostQuery` on iOS and Android): space → `+`, id/date/cursor separators stay literal so older hosts still read them, only `& + # %`/non-ASCII get escaped. The context model ids keep their fixed charset (`AIDEN_REMOTE_CONTEXT_MODEL_ID`) but may arrive encoded.
- Client: peer operation `contextPressure` (fields `providerId`/`modelId`), OpenAPI `getChatContextPressure`; `HostChatCapability` `"contextPressure"` (feature + `chat:read`); `RemoteHostAdapter.contextPressure(chatId, model?) → HostChatResult<RemoteContextPressure | null>`. The local adapter omits it (the local pane uses `chatsApi.contextPressure`).
- `ContextMeter` takes a full `ChatContextPressureV1`; the wire lacks `compressibleHistoryMessages`, which only the breakdown dialog's `compactionNote` reads. The view decides how to bridge that.
- Tests: `peer-remote-chat-context.test.ts` (end to end through main's peer IPC), router, chats service, protocol and peer-operation suites.

## Remote chat composer parity — 2026-10-27

- The open remote chat's composer now matches a local one: model picker (`RemoteModelPicker` over the host's `GET /models`), effort (`ThinkingControl` from each model's `thinkingLevels`/`defaultThinkingLevel`), context meter (revision 41 `GET /chats/{id}/context`), queue and Try again.
- Model and effort travel per turn in `POST /chats/{id}/turns` (`providerId`/`modelId`/`thinkingLevel`). The host saves the model as the chat's model on append. Rules live in `renderer/lib/hosts/remote-turn-selection.ts`: only what differs from the chat's own is sent; picks are kept in memory per host+chat while Aiden runs. The chat's model comes from the messages-window metadata (revision 23), now carried on `RemoteTranscript.model`.
- A saved (outcome-unknown) send must replay its exact body: `peer-intent-store.ts` `savedOperation` includes the model/effort fields, otherwise main refuses admission.
- `mapHostModelCatalog` now keeps hidden models with `hidden: true` so a chat on one still names it; new chats use `findOfferedHostModel`/`defaultHostModel`, which skip hidden ones.
- Queue: remote Queue no longer posts `mode: "queue"` to the host. Messages wait on this Mac in the shared `ChatMessageQueue`/`QueuedMessages` (keyed by `hostResourceKey`), and are sent one at a time as new turns. After each send the pane waits until it has seen that run (`runId === receipt.streamId`) end, with a 2-minute fallback, because the run reaches this Mac over the run stream after the receipt. Steer still goes to the host's run.
- `run` in the remote snapshot is never null: an idle view with no run has `ended: false`, so "a run is active" is `!ended && runId != null`.
- A disabled React Query still returns cached data: the context meter also checks the `contextPressure` capability before rendering.
- `ProviderFailureActions.supports` limits a failure card's primary action; remote supports `try_again` and `continue` (compaction and provider sign-in happen on the host). Switch model opens the remote picker.
- `ContextMeter` takes `ContextMeterPressure` (the 11 wire fields plus optional breakdown/anchor), so a remote projection renders without inventing `compressibleHistoryMessages`.
