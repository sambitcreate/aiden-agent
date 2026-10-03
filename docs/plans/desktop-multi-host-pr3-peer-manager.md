# Desktop multi-host PR 3 — controller supervisor and stream IPC

Status: In progress.
Parent plan: [Desktop multi-host control](desktop-multi-host-control-plan.md), delivery row 3.
Stack: PR 1 (#310) ← PR 2 (#313, contract revision 19) ← this PR.

## Goal

The desktop becomes a controller that stays connected to every enabled paired host. Main owns a
supervisor per host, one host-feed subscription per connected host, and reference-counted live run
streams. Renderers read host state over a typed IPC surface and never see credentials, pins or
endpoints.

## Scope

- `PeerHostManager` (`main/services/peer-host-manager.ts`). It has one supervisor per enabled host
  with the states `connecting`, `connected`, `backoff`, `blocked` (`auth`, `identity_changed` or
  `protocol`) and `disabled`.
  - Backoff waits 3, 4, 8, 16 and then 30 s, each with ±20 % jitter. The step resets after 30 s of
    stable connection.
  - A per-host generation counter fences every transition and late response.
  - A disabled host has no supervisor and makes zero requests.
  - Sleep/resume and network changes trigger one coalesced reconnect.
- Transport (`peer-transport.ts`):
  - Each host gets a pinned keep-alive `https.Agent`, which replaces `agent: false`. It is
    destroyed on disable, remove and shutdown.
  - Requests can send `Last-Event-ID`.
  - Hitting the 5-minute session cap ends a stream with a `capped` outcome instead of an error,
    so the caller resumes from its cursor.
  - A pin, chain or hostname mismatch is reported as `identity_changed`, separate from
    `unavailable`.
  - Non-2xx responses are parsed as a bounded error envelope (`remoteCode` plus sanitized
    `details`).
  - A bounded binary mode serves attachment content.
- Host feed:
  - There is one `/host/events` subscription per connected host that has `host:events` and
    `host-events-v1`.
  - A per-host cache (`peer-host-feed-cache.ts`) holds summaries (at most 2,000 chats), workspaces,
    Bots and run states.
  - The cache appends chunked snapshots and replaces state only on the final frame.
  - On an epoch change it resets to the new snapshot.
  - Rows are kept while the host is offline and marked `stale`.
  - Every applied change is broadcast once to all windows as
    `remote:host-feed {hostId, epoch, sequence, change}`, so windows share one subscription.
- Live runs:
  - `remote:peerRunSubscribe(hostId, target, afterSequence)` takes a target of `{chatId}` or
    `{runId}`. `remote:peerRunUnsubscribe(hostId, subscriptionId)` releases it.
  - Streams are shared and reference-counted per renderer document. A stream with no viewers is
    evicted after 5 minutes.
  - Frames are broadcast as `remote:peer-run-frame {hostId, runId, chatId, event}`.
  - A chat-targeted stream learns its `runId` and resumes on `/runs/{runId}/events` with
    `Last-Event-ID` after the 5-minute cap.
  - Events are deduplicated by sequence. The terminal `run.ended` repeats the last sequence and is
    still delivered.
- Operations:
  - The closed set now includes `messagesWindow`, `attachmentContent`, `markRead`, `skills`,
    `tasks`, `agents`, `interruptAgent`, `streamQuestion`, `respondQuestion`, `inputs`,
    `runCancel`, `runRespondApproval`, `runRespondQuestion`, `runInputs`, Bot reads (`bots`,
    `bot`, `botConversations`, `botCapabilities`, `botChatAccess`, `botFavorites`) and Bot writes
    (`createBotChat`, `updateBotFavorites`, `updateBotChatAccess`).
  - Every mutation carries a client-minted Idempotency-Key.
- Capabilities:
  - `verify()` persists the refreshed device grants and server features.
  - Hosts that were already paired negotiate the missing progress and host grants once per session
    through `POST /device/capabilities`, and only for capabilities that the host advertises.
- Budgets: feed and live streams have their own partition, separate from the unary budget of 8 per
  host and 32 in total. The partition allows 1 feed plus 16 live streams per host, and 64 streams
  in total.

## Out of scope

- Host-side pairing request and approve routes, discovery, and the settings and Connections UI
  belong to PR 4a and PR 4b.
- The `pairingRequest` and `manualBootstrap` client operations are deferred to PR 4b. They depend
  on PR 4a's routes and the pairing sheet, so they are not trivial here.
- Sidebar and transcript consumers of the feed and run frames belong to PR 5b and PR 6.

## Decisions

1. **The 5-minute cap is an outcome.** `PeerTransport.events()` resolves `{reason: "capped"}`
   when the session cap fires and `{reason: "eof"}` when the server ends the stream. Errors stay
   errors. The feed and run loops reconnect at once after `capped`, so the reconnect is not
   visible to renderers.
2. **Identity mismatch is not unavailability.** The transport raises `identity_changed` in these
   cases:
   - The SPKI pin fails.
   - The pinned CA does not sign the presented chain.
   - The hostname does not match.

   A `/server` read whose `instanceId` differs from the stored host ID raises it too. The
   supervisor moves to `blocked: identity_changed` and never retries on its own. Only re-pairing
   or disabling and re-enabling the host clears it.
3. **Authentication blocks the host.**
   - A `401`, or a `403` with `credential_revoked` or no envelope, blocks the host with
     `blocked: auth`.
   - A `403 capability_denied` is an answered per-operation refusal. It never blocks the host.
4. **Protocol mismatch blocks the host.** `protocolVersion !== 1` on `/server`, or a feed or run
   event with an unsupported envelope, gives `blocked: protocol`.
5. **"Progress" is unary.** The `tasks` and `agents` reads (`getChatTasks` and `getChatAgents`)
   cover progress in this PR. The per-chat progress SSE is not subscribed, because run streams
   already carry the `task_update` and `agents_update` events.
6. **Bot grants cannot be negotiated after pairing.** Contract revision 19 keeps Bot grants
   pairing-bound. Hosts that were paired before Bot opt-in must be re-paired to gain them, and
   negotiation never asks for them.
7. **Ambiguous mutations are never replayed.** A mutation that fails with a transport
   `unavailable` may already have reached the host.
   - Main does not retry it. It runs one read-only reconciliation, then rejects with a typed
     `outcome_unknown` error that carries the reconciled state.
   - A run-control operation reconciles from the feed cache's run state, with no network call. A
     chat-scoped mutation reconciles with `GET /chats/{id}`.
   - The renderer may retry with the same Idempotency-Key, which the host ledger deduplicates for
     ten minutes.
8. **Run frame payloads are validated, not projected.** Main checks the stream envelope:
   - the protocol version
   - a bounded `streamId` that matches the run
   - a positive sequence, which may be 0 only for the feed snapshot
   - a known event type
   - an object payload with no forbidden wire keys

   It then forwards the event. Unknown non-terminal event types advance the cursor but are not
   forwarded.
9. **Joiners are served from a bounded replay buffer.**
   - A renderer that subscribes to an existing stream receives the buffered events after its
     `afterSequence`.
   - The buffer holds the last 512 events or 1 MiB, whichever is smaller.
   - If the buffer no longer reaches back far enough, the reply has `truncated: true`, and the
     renderer refetches the chat window before it applies frames.
10. **Rows are evicted by age.** When the cache passes 2,000 chats, the summaries with the oldest
    `updatedAt` are dropped. Their run states are dropped with them.
11. **Network change detection is local only.** Service main watches power events (`resume`,
    `unlock-screen`) and fingerprints `os.networkInterfaces()` every 15 s, but only while a
    supervisor exists. A change calls `manager.wake()`, which reconnects every supervisor in
    `backoff` or `connected` once, within a 500 ms coalescing window. No network traffic is used
    to detect changes.
12. **`PeerHostView` stays the same shape.** The coarse `state` field is still derived for
    existing consumers (`connecting`, `connected` and `disabled` map directly; `backoff` and
    `blocked` map to `unavailable`). The richer supervisor status is a separate
    `PeerHostStatus`, served by `remote:peerHostStatuses` and broadcast on
    `remote:peer-host-state`.
13. **Run subscriptions are owned per document.** A renderer document's references are released
    when it navigates or is destroyed, so a crashed window cannot pin streams.

## Exit criteria (tests)

- A two-host fixture where both hosts share the same chat ID keeps their caches, broadcasts and
  run streams separate.
- An SPKI pin mismatch gives `blocked: identity_changed`, not `unavailable`.
- A feed and a run stream that cross the 5-minute cap resume with no gaps or duplicates.
- Late responses after a disable or reconnect are fenced by the generation counter.
- Run subscriptions are reference-counted, evicted 5 minutes after the last viewer leaves, and
  revived when a viewer returns within that window.
- A disabled host makes zero requests.
- The IPC surface is tested by register-and-invoke. Credentials never appear in any payload.

## Status

- [ ] Transport upgrades
- [ ] Feed cache and run subscriptions
- [ ] Supervisor and budgets
- [ ] Expanded operations, capability refresh and negotiation
- [ ] IPC, preload and renderer API
- [ ] Tests registered; local suites green; PR open; CI green
