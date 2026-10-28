# Aiden Remote API v1

Status: Phase 4 authenticated Bot application service implemented
Base path: `/api/aiden/v1`
Transport: HTTPS REST plus resumable Server-Sent Events
Schema: `protocol/aiden-remote/v1/openapi.json`
Fixtures: `protocol/aiden-remote/v1/fixtures/contract.json`

## 1. Contract rules

This is Aiden's native remote protocol. It is not Hermes WebUI compatibility. Aiden Agent remains the execution, persistence, permission, filesystem, and provider authority. The remote transport adapts authenticated commands to shared main-process application services; it never calls Electron IPC handlers or impersonates a `WebContents` owner.

The URL major version changes only for an incompatible wire break. Additive fields are forward compatible only where the schema marks an envelope extensible; new capability-gated endpoints/events do not require a new major version. Clients must ignore unknown fields on the extensible SSE envelope and unknown nonterminal SSE events. Known v1 payload and mutation DTOs remain allowlisted. Clients must fail closed and fetch an authoritative snapshot for an unknown terminal state, missing required identity, invalid sequence, or mutation-precondition mismatch.

All timestamps are RFC 3339 UTC strings. IDs are opaque strings and must not encode filesystem paths, credentials, provider details, or user names. JSON request bodies use UTF-8 and reject duplicate keys, non-finite numbers, and unknown mutation fields. Before writing headers, the server serializes and validates every JSON response as one UTF-8 document. A document above 1 MiB is not truncated or partially emitted; the server returns a `413 payload_too_large` error envelope instead.

## 2. Authentication and capabilities

`GET /health` is the only unauthenticated read. Its default body is exactly `{ok, protocolVersion}`. Since contract revision 19, `GET /health?detail=host` adds the non-secret host descriptor `instanceId`, `displayName`, optional `platform` (`mac` | `linux` | `windows`), `contractRevision` and `pairingRequests`, so a desktop controller can identify a host before it pairs. The descriptor is opt-in because older strict mobile decoders accept only the two default keys; any other query is `400 invalid_request`. `POST /pairing/manual-bootstrap` returns only a bounded AES-GCM sealed trust envelope while a local desktop pairing window is open; the locally displayed setup code is never sent in its request. `POST /pairing/exchange` is available only during that same window and requires its single-use 256-bit secret. Since contract revision 20, the desktop-only `/pairing/requests*` admission routes (see "Pairing requests" in section 5) also take no bearer credential; they are bounded, rate-limited, gated by the host's Accept connection requests setting, and issue nothing until the person at the host approves. A Bot event routine's link, `POST /hooks/bot-routines/{token}` (the Bot autonomy branch, no contract revision of its own), also takes no bearer credential: the 43-character base64url token in the path is the only credential and is compared by SHA-256 hash. It accepts `text/plain` or `application/json` bodies of at most 16 KiB, answers `202` with no body whether or not the routine runs, `404` for an unknown token or while Bots are closed, `405` for other methods, `413` and `415` for oversized or other bodies, and never logs the token. It is not a device credential and opens no other route. Every other request, including SSE, requires:

```http
Authorization: Bearer <device credential>
Aiden-Protocol-Version: 1
```

The desktop stores only a slow/strong digest of the credential plus device metadata. Revocation closes streams and rejects later requests. Credentials are installation-specific and must never be accepted by a different Aiden instance.

Server support and authenticated-device grants are separate authorities. Pairing and `GET /server` use `capabilities` for the exact grants held by that device. A device additionally receives `serverCapabilities`, the server-supported inventory, after pairing with `acceptsBotCapabilities: true` or after negotiating the progress capability vocabulary (either at pairing with `acceptsProgressCapabilities: true` or post-pairing through `POST /device/capabilities`). `bot:write` is invalid without `bot:read` in every grant or support projection. Bot eligibility requires `bot:read` in both values. Progress reads require `tasks:read` or `agents:read` in the device's exact grants; server support alone never authorizes a read. A missing `serverCapabilities` field is an ambiguous legacy projection and fails closed for Bots; it is never interpreted as a Bot grant.

Initial capability IDs:

| Capability | Authority |
| --- | --- |
| `server:read` | Read instance/version/capability projection, aggregate usage, and paired-Mac speech status. |
| `chat:read` | Read projected chats and stream status. |
| `chat:write` | Create/rename/delete chats; start/cancel turns; use and set up paired-Mac speech transcription. |
| `approval:respond` | Resolve approvals owned by this device/stream. |
| `workspace:read` | Read workspace registry projection. |
| `workspace:browse` | Navigate locally approved directory roots. |
| `workspace:manage` | Create/update/unregister workspace records, including permission changes. Granted by default for the confirmed full-CRUD mobile product and disclosed during pairing. |
| `files:read` | Read the bounded file index and text documents. |
| `files:write` | Perform expected-version file writes. |
| `git:read` | Review/diff/compare/branch/worktree projection. |
| `git:write` | Confirmed commit/push/checkout/branch/worktree mutations. |
| `schedule:read` | Read scheduled tasks/settings/run history. |
| `schedule:write` | Confirmed task/settings mutations and run-now. |
| `bot:read` | Read Bot identity and Bot-classified chats, streams, attachments, and approvals. Granted only after explicit client negotiation. |
| `bot:write` | Mutate Bot-classified chats and operate their turns, attachments, streams, and approvals. Requires `bot:read` as well as the existing route capability. |
| `bot:activity` | Opt-in, no authority (contract revision 30). Delivers the Bot session `activity` and `queued` frames and snapshot keys, the person's `submissionId` on their own user entries, and Bot detail `chatActivity`. Negotiable post-pairing by any device type through `POST /device/capabilities` while `/server.features` lists `bot-activity-v1` (`404 not_found` otherwise), advertised in `serverCapabilities` only then, never issued by pairing. See "Bot chat activity, revision 30". |
| `bot:handoffs` | Opt-in, no authority of its own (contract revision 37). Delivers the Bot session `handoff` field and frame, the `paused` session state, Bot `paused` flags and the `bot_paused` error code, and opens the hand-off answer, open-on-Mac and pause routes, which still need `bot:read` and `bot:write`. Negotiable post-pairing by any device type through `POST /device/capabilities` while the host lists it in `serverCapabilities` (`404 not_found` on a host without the routes), never issued by pairing. There is no `/server` feature token for it. See "Bot hand-offs and pause, revision 37". |
| `bot:handoff-notes` | Opt-in, no authority of its own (contract revision 40). Delivers `takesNote: false` on a hand-off card that takes no note, to a device that also holds `bot:handoffs`. Offered and negotiable exactly when `bot:handoffs` is, never issued by pairing. A host before revision 40 refuses the name, so devices ask for it only when the host lists it. |
| `bot:issues` | Opt-in, no authority of its own (contract revision 42). Delivers the Bot session `issues` list and `issues` frame, the summary `issueCount`, and issue items in the routine notification feed, and opens `POST /bots/{botId}/issues/{issueId}/act`, which still needs `bot:read` and `bot:write`. Negotiable post-pairing by any device type through `POST /device/capabilities` while the host lists it in `serverCapabilities` (`404 not_found` on a host without the issue route), never issued by pairing. There is no `/server` feature token for it. See "Bot issues on phones, revision 42". |
| `bot:handoff-on-mac` | Opt-in, no authority of its own (contract revision 43, provisional). Delivers `onMac: true` on an `action` card whose step is on the Bot's own browser or computer, to a device that also holds `bot:handoffs`. Offered, negotiated and refused by earlier hosts exactly like `bot:handoff-notes`. |
| `schedule:cards` | Opt-in, no authority (contract revision 39). Delivers the display-only `schedule` card on scheduled-task approvals, on `GET /streams/{streamId}/approval` and on a phone's run `approval_required` events and gap snapshots. The card is sent only to a device that also holds `schedule:read`. Negotiable post-pairing by any device type through `POST /device/capabilities` while the host lists it in `serverCapabilities` (`404 not_found` on a host without stream or run approvals), never issued by pairing. There is no `/server` feature token for it. See "Scheduled-task approval cards, revision 39". |
| `tasks:read` | Read the bounded chat task-progress projection and receive `task_update` events. Granted only after explicit client negotiation at pairing or post-pairing. |
| `agents:read` | Read the bounded delegated-agent roster projection and receive `agents_update` events. Granted only after explicit client negotiation at pairing or post-pairing. |
| `questions:respond` | Resolve `ask_user_question` prompts owned by this device/stream and receive `question_required` events. Granted only after explicit client negotiation at pairing or post-pairing. |
| `skills:invoke` | Read the chat-scoped invocable-skill catalog and redeem opaque skill invocation leases on turn start. Granted only after explicit client negotiation at pairing or post-pairing. |
| `host:events` | Desktop-only (contract revision 19). Subscribe to the host-wide `GET /host/events` feed of chat summaries, workspaces, Bots (with `bot:read`) and run states. Issued at pairing to `mac` and `linux` devices that opt into the progress vocabulary, or negotiated by `mac` and `linux` devices through `POST /device/capabilities`, and only while the host serves the feed. Phones and tablets are refused with `403 capability_denied` before the host reveals whether it serves the feed. |
| `runs:observe` | Desktop grant since contract revision 19: observe any run on the host through the run streams. Same issuance rule as `host:events`. Chat read access is still checked per run. Since contract revision 24, phones may also negotiate it (see "Phone run observation and control" in section 5); a phone's grant never widens what it may read. |
| `runs:control` | Desktop grant since contract revision 19: cancel a run, answer its approvals and questions, and steer or queue input through `/runs/{runId}/*`. Same issuance rule as `host:events`. Chat write access is still checked per run, so a Bot chat's run also needs `bot:write`. Since contract revision 24, phones may also negotiate it under the phone-scoped rules in section 5. |
| `simulators:control` | Desktop-only. List, open, shut down, configure and stream the serving Mac's iOS Simulators through `/simulators*`. Negotiable post-pairing only by `mac` and `linux` devices, advertised in `serverCapabilities` only to them, and effective only while the serving owner has turned on Share with paired Macs. Stripped from any persisted phone or tablet record. |
| `simulators:mobile` | Phone-only (contract revision 26). Watch, tap, open and shut down the serving Mac's shared iOS Simulators from Aiden On The Go through a narrower `/simulators*` scope. Negotiable post-pairing only by `iphone`, `ipad` and (since revision 31) `android` devices while `/server.features` lists `mobile-simulators-v1`, advertised in `serverCapabilities` only to them, never issued by pairing, and effective only while the serving owner has turned on Share with Aiden On The Go. Stripped from any persisted desktop record. See "Phone simulator viewer" in section 5. |

No capability can enable Computer Use, mint the reserved Assistant identity, select a hidden unattended mode, read provider/MCP credentials, accept a client-authored shell/Git command, or widen a regular Workspace chat's tool authority. This prohibits a generic remote terminal or command endpoint. It does not prohibit the existing Mac-owned agent runtime from invoking its shell tool during an authenticated Bot turn after the Bot policy, chat reduction, device grant, OS/global availability, approvals, and fresh effect lease all allow it.

## 3. Error envelope

Every non-2xx JSON response uses:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Safe user-facing summary.",
    "requestId": "req_opaque",
    "retryable": false,
    "details": {}
  }
}
```

`details` is optional and endpoint-allowlisted. Since revision 19 a run-control loser also receives the winner's `decision` (`allow` | `deny` | `expired` | `cancelled`) with `approval_resolved`, or `outcome` (`answered` | `expired` | `cancelled`) with `question_already_resolved`, plus `resolvedAt`. It never contains paths, credentials, request bodies, raw provider errors, raw Git output, or stack traces.

Required stable codes include:

- `invalid_request`, `payload_too_large`, `rate_limited`
- `authentication_required`, `credential_revoked`, `capability_denied`
- `pairing_closed`, `pairing_expired`, `pairing_already_used`, `server_identity_changed`
- `not_found`, `already_exists`, `revision_conflict`, `idempotency_conflict`, `idempotency_capacity`, `idempotency_in_flight`
- `bot_archived`, `workspace_unavailable`, `workspace_changing`, `permission_confirmation_required`
- `handle_invalid`, `handle_expired`, `handle_wrong_device`, `root_policy_changed`, `filesystem_identity_changed`, `path_outside_root`, `handle_capacity`
- `turn_already_active`, `stream_gone`, `approval_already_resolved`, `approval_expired`
- `run_gone`, `approval_resolved` (contract revision 19 run routes only)
- `question_already_resolved`, `question_expired`
- `skill_unavailable`
- `operation_in_progress`, `operation_stale`, `git_capability_denied`
- `bot_paused`, `handoff_expired` (contract revision 37; `bot_paused` reaches only devices holding `bot:handoffs`, and `handoff_expired` answers only the `bot:handoffs` routes)
- `schedule_disabled`, `schedule_run_in_progress`
- `server_interrupted`, `internal_error`

## 4. DTO allowlists

### Server

Allowed: instance ID/display name, app/protocol version, exact authenticated-device capability grants, optional negotiated server-supported capabilities, selected connection mode, minimum client version, server time.

The display name is a bounded, user-editable label persisted by the Mac and returned by `GET /server`; it is never an identity key. Clients scope credentials, caches, streams, App Intents, and navigation to `instanceId`, including when multiple installations use the same label or a label changes.

Forbidden: local usernames, config/user-data paths, environment values, provider credentials, logs, process arguments.

### Workspace

Allowed: `id`, `name`, `permission`, `hasFolder`, `isManagedWorktree`, optional branch/repository display names, small Git summary, `createdAt`, `updatedAt`, `revision`.

Forbidden: `folderPath`, repository/worktree/Git-admin paths, ownership token, device/inode identity, remote URL, created-from HEAD, config-store record.

### Chat/message

Allowed: IDs, workspace ID, optional Bot ID when the authenticated device has `bot:read`, visible title/provider/model selections, an optional `titlePending: true` hint while first-turn background naming is active, visible user/assistant messages, bounded attachments, safe parent reasoning/tool/timeline milestones, timestamps, and the parent turn's terminal provider-failure category. A Chat response carries `providerId` and `modelId` together or omits both; a partial pair is invalid. The separate Chat Summary projection is deliberately smaller: regular-chat ID, workspace ID, title, required title-pending Boolean, timestamps, revision, safe `idle|active` activity, and (since contract revision 18) the additive `rowState` and `unread` hints, plus (since contract revision 36) the additive `lastRunFailed` hint, only. Since contract revision 21, a Chat, a messages window and a Chat Summary row may carry the additive `forkedFrom` lineage `{chatId, messageId, position, at}` when the chat was created by Fork; Chat and the messages window also carry its optional `summary`, and rows never do (see "Fork" in section 5).

Regular-chat assistant messages may include up to 100,000 UTF-16 code units of already displayable parent `reasoning`; optional reasoning is removed from later messages first if the whole response would exceed 1 MiB. Version 3 Thinking milestones may include optional UTF-16 `reasoningStartOffset` and `reasoningEndOffset` fields, allowing clients to interleave readable Thinking stretches with prose and tool activity. The fields never contain private Pi journal content. When reasoning is omitted, its span offsets are omitted too. Bot chat history always omits reasoning; live `reasoning_delta` remains available.

Since contract revision 28, an assistant message may carry an additive `visuals` list (at most 40, in reply order): `{id, kind: "ui"|"html", title, toolCallId?, fallbackText?, snapshotAttachmentId?, layout?: "wide"}`. `toolCallId` names the timeline tool step that drew the visual, `snapshotAttachmentId` names an image attachment on the same message, and `fallbackText` (at most 4,000 characters) describes a native visual in words. The visual's markup, data and saved state never leave the Mac. Clients show the snapshot after the matching tool step, fall back to `fallbackText` and then the title, hide snapshot attachments from the ordinary attachment list, and drop any entry they cannot parse while keeping its message (see "Inline visuals, revision 28").

Subagents remain a Mac-local implementation detail of the parent Pi turn unless the authenticated device negotiated `agents:read`. A device without that grant receives only the ordinary parent messages, parent timeline and outcome, and parent stream state—never child/subagent IDs or counts, private histories, lifecycle snapshots, child controls, or child-specific endpoints. A negotiated device receives only the bounded public `ChatAgentRoster` projection described below; it still never receives private run/session/group/generation/child/workspace identifiers, child transcripts, prompts, or tool arguments/results. The only child control is the public-ID stop described under `POST /chats/{chatId}/agents/{agentId}/interrupt`, which is available only when the Mac advertises `chat-agent-interrupt-v1`. A child result may affect the parent's eventual visible reply through the normal parent runtime, but it is never projected as a separately addressable private object.

Within its documented 200,000-Unicode-scalar bound, visible parent `message.text` is opaque transcript data and is preserved exactly. Privacy filtering applies to DTO fields and metadata, not to the appearance of visible text: Unicode, path-like text, URLs, UUIDs, base64- or hexadecimal-looking strings, and credential-shaped text are not rewritten, encoded, or replaced with a redaction marker. This does not authorize separate credential metadata; credentials, authorization headers, provider/MCP secrets, and API-key fields remain forbidden outside the visible transcript. One kind of user-role message is projected differently: a follow-up notice that the host wrote into the chat (a background job ended, a followed pull request had news, or a done-when check ran; see [coding follow-through](coding-follow-through.md)) carries its one-line heading as `text`, for example `A check failed: #42 in acme/app · unit`. Its model-facing text, with fenced command output and CI logs, stays on the desktop. The wire shape and revision are unchanged.

Forbidden: Pi journals, raw diagnostics, raw tool arguments/results not already safe for renderer display, every child/subagent projection described above, hidden/system prompts, credentials or authorization headers outside visible parent message text, provider/MCP headers and API keys, filesystem/skill metadata, owned asset filenames, temporary asset URLs, and filesystem internals.

### Bot

Allowed: opaque Bot ID, bounded name and purpose, optional opening greeting, editable guidance in authenticated detail only, semantic avatar recipe, canonical raster metadata, safe health state, archive/timestamps/revision, favorite membership/order, bounded conversation previews, a plain-language access summary, and an optional audience-safe provider/model selection in authenticated detail. Capability catalogs expose only bounded labels, availability, and opaque selection IDs using the conservative `[A-Za-z0-9._:-]` grammar. A Custom policy or chat reduction exposes only the positive opaque selections needed to render and edit it.

Response discriminants are coherent and fail closed: `health: archived` requires `archivedAt`, while every other health state forbids it; Full Bot access and inherited chat access forbid a Custom selection, while Custom access requires one; a pending notice forbids acceptance metadata, while an acknowledged notice requires both acceptance timestamp and decision. Clients tolerate harmless additive response display fields after recursively rejecting private wire keys, but never reinterpret unknown fields as authority.

That recursive response check is context-aware. In Chat and Bot projections, clients normalize an additive field name by removing hyphens, underscores, periods, and whitespace and lowercasing it, then reject credential/secret/API-key/token, header, endpoint/path, prompt, instruction/greeting, tool argument/result, and reasoning variants enumerated by `x-aiden-context-private-response-fields`. The documented `BotDetail.instructions`, `BotDetail.openingGreeting`, and exact `messages[].reasoning` DTO property in a proven regular chat are exceptions; Bot chat reasoning and similarly named additive or nested fields remain private and fail closed.

Since contract revision 37, a device holding `bot:handoffs` also gets `paused`: on a summary only as `true` while the person paused the Bot, on a detail always as a Boolean. It travels with `sessionState: "paused"`. Every other device gets neither, and sees a paused Bot's `sessionState` as `unavailable`.

Since contract revision 42, a device holding `bot:issues` also gets `issueCount` on every summary and detail, but only while it is above zero: how many open "Needs you" issues the Bot holds. Settled issues never count, so the number is the person's open decisions (at most 8). Every other device gets no `issueCount`.

Bot summaries never include instructions or opening greetings. Bot conversation pages never include reasoning, tool arguments/results, paths, attachment bytes, provider errors, or private journals. Raster metadata never includes an internal filename or path.

Forbidden: managed-home/workspace paths, provider/MCP credentials or headers, endpoint URLs, environment values, resolved MCP bindings or fingerprints, skill paths/content, internal capability leases/epochs beyond the opaque public policy epoch, asset filenames, Image Playground temporary URLs, and unbounded prompt/message content.

### File

Allowed: opaque file handle, safe workspace-relative display path/name, kind, bounded size/language metadata, version, truncation/warning state, text content for a selected readable document.

Forbidden: canonical/absolute path, symlink target, inode/device, recovery path, arbitrary binary bytes.

### Git

Allowed: safe review/diff/comparison fields, branch display names, counts, push capability/reason, managed-worktree display state, operation ID/status.

Forbidden: absolute paths, Git admin path, ownership token, device/inode, raw command line/stdout/stderr, credential-bearing remote URL, private refs not present in the desktop projection.

### Chat task progress

Allowed: `version` (exactly 1), `chatId`, `availability` (`ready`/`unavailable`), opaque projection `epoch`, positive `revision`, `updatedAt`, and a bounded `tasks` array. Each task carries a positive numeric `id`, bounded `subject`, closed `status` (`pending`, `in_progress`, `completed`, `deleted`), optional bounded `activeForm`, and optional `blockedBy` references to distinct listed task ids. A ready projection contains at most one `in_progress` task, and its `blockedBy` relationships form an acyclic dependency graph. An `unavailable` projection carries a closed `unavailableReason` (`storage_not_enabled`, `invalid_snapshot`, `unsupported`) and always an empty task list; `ready` projections never carry `unavailableReason`.

Forbidden: task descriptions, owner data, private journal or reducer state, metadata, raw tool results, child/subagent identities, and every context-private field enumerated by `x-aiden-context-private-response-fields` (which applies to this schema).

### Chat agent roster

Allowed: `version` (exactly 1), `chatId`, optional `turnId` identifying the active or most recent public turn (required while agents are listed), optional `previousTurns` containing at most 16 unique `{turnId, startedAt}` selectors in newest-first order (excluding the current `turnId`), `availability`, `epoch`, `revision`, `updatedAt`, and a bounded `agents` array. Each agent carries a projection-minted `agentId` using the `[A-Za-z0-9._:-]` grammar, optional `parentAgentId` referencing an agent in the same roster, `depth` 1–8 (a parent is present exactly when depth is at least 2, and never the agent itself), positive `revision`, closed `role` (`scout`, `planner`, `reviewer`, `implementer`), bounded `label`/`taskPreview`, closed `state` (`queued`, `starting`, `running`, `needs_attention`, `completed`, `failed`, `timed_out`, `interrupted`, `stopped`, `unknown`), optional bounded `activity`, strict RFC 3339 `startedAt`/`updatedAt` (`updatedAt` never precedes `startedAt`), `finishedAt` exactly for terminal states, bounded `modelId`, non-negative `turns`/`tools`/`tokens`, optional closed `milestones` and `notices` lists (`report_truncated` is a terminal-only notice), and optional bounded `error`/`warnings` that may be non-empty only on terminal states.

Forbidden: private run/session/group/generation/child/workspace identifiers, child transcripts or histories, prompts or instructions, tool arguments or results, raw reasoning content, filesystem paths, credentials, and every context-private field enumerated by `x-aiden-context-private-response-fields` (which applies to this schema). The roster never grants access to another device's stream or cancellation endpoint; `turnId` is a public selection key, not a stream authority.

### Scheduled task

Allowed: task ID/revision, safe name/description, workspace/provider/model IDs, schedule/timezone, mode/permission, selected MCP IDs, notification preference, validated script ID/display name, enabled/running state, next/previous dates, bounded redacted run result.

Forbidden: provider fingerprint, resolved MCP bindings, chat ID, credentials, process environment, raw script path, unredacted stdout/stderr, internal cancellation handles.

### Speech

Allowed: the fixed local transcription engine identifier and readiness, a bounded allowlisted model catalog with installed/downloading state and progress (download phases `download`, `verify` and `extract`; each model may also carry the additive `languages`, `capabilities` and `license` fields, which clients decode tolerantly and need not display), one model setup or removal command, and a final bounded transcript. Audio input is exact base64 PCM16: mono, signed 16-bit little-endian, 16 kHz, and no longer than 60 seconds.

Forbidden: server filesystem paths, arbitrary model URLs or archive names, provider credentials, partial recognition events, retained recordings, raw decoder diagnostics, or transcripts above the response bound.

## 5. Endpoint inventory

The OpenAPI document owns exact request/response shapes. This section owns behavior.

### Bootstrap/device

Pairing accepts `iphone`, `ipad`, `android` (revision 31), `mac`, and `linux` device types. This additive request vocabulary does not change existing response DTOs, grant inventories, or device-owned stream authority. A desktop receives the same legacy grants unless it separately negotiates existing Bot capabilities; being a desktop does not authorize controlling another device's streams or terminals. Older servers reject desktop types, so desktop callers must report an update requirement rather than impersonating a phone.

- The locally displayed QR encodes the OpenAPI `PairingPayload` envelope as canonical JSON. Its `PairingBootstrap` contains protocol version, instance ID, HTTPS API endpoint, P-256 SPKI SHA-256 fingerprint, high-entropy single-use secret, and expiry; its trust member selects the bundled private LAN CA or system trust for Tailscale. The phone must decode and validate the complete envelope, configure hostname plus SPKI verification, and only then exchange the secret. A fingerprint learned from `/pairing/exchange` is confirmation, never the trust bootstrap.
- `POST /pairing/manual-bootstrap`: returns that exact canonical `PairingPayload` encrypted with AES-256-GCM. A uniformly random 100-bit Crockford Base32 setup code is shown only through local Electron IPC and derives the encryption key with HKDF-SHA256. The client sends `{}` to the selected exact endpoint, validates the bounded response, derives and authenticates the envelope locally, requires the decrypted endpoint and expiry to match, and then uses the normal pinned `/pairing/exchange`. The setup code never appears in a URL, request, log, persistent state, Bonjour record, or public status projection. LAN users select a discovered Mac; Tailscale users provide its canonical private endpoint. QR and manual entry share one window and one synchronously consumed exchange secret.
- `GET /health`: minimal readiness and protocol version.
- `POST /pairing/exchange`: exchange a high-entropy single-use secret for device/instance IDs, bearer credential, exact device capability grants, endpoint, and P-256 SPKI SHA-256 fingerprint. A client may set `acceptsDisplayName: true` to receive the optional bounded server display name; the server omits that additive key for strict legacy v1 decoders. A client must separately set `acceptsBotCapabilities: true` before the Mac may issue `bot:read` or `bot:write`, and `acceptsProgressCapabilities: true` before the Mac may issue `tasks:read` or `agents:read`. Absence or `false` preserves the complete legacy grant vocabulary and never upgrades an existing device. The display name is presentation metadata only and newer clients still verify `instanceId` as identity.
- `GET /server`: authenticated server projection. Its required `capabilities` array is the authenticated device's exact negotiated grants. The additive `deviceName` field is the presentation-only label currently stored for the calling device, allowing newer clients to refresh a stale generic label without writing on every connection. The bounded additive `features` array advertises optional API surfaces independently of device grants or vocabulary opt-in; `chat-summaries-v1` means the authenticated transcript-free summary route is available, `chat-tasks-v1`/`chat-agents-v1` mean the chat-scoped progress reads and event channel are implemented, `chat-run-input-v1` means the mid-flight stream-input mutation route is implemented, and `chat-question-prompts-v1` means the pending-question snapshot and response routes are implemented, `chat-skills-v1` means the chat-scoped skill catalog route and turn-start lease redemption are implemented, `chat-agent-interrupt-v1` (contract revision 16) means the single-agent stop route is implemented, and `chat-read-state-v1` (contract revision 18) means the Mac keeps shared read markers and accepts `POST /chats/{chatId}/read`. Since contract revision 19, `chat-messages-window-v1` means `GET /chats/{chatId}/messages` pages are implemented, and desktop devices alone may also see `host-events-v1`, `run-streams-v1` and `run-control-v1` (see Host feed, run streams and run control). Since contract revision 21, `chat-fork-v1` means `POST /chats/{chatId}/fork` is implemented and `chat-fork-summary-v1` means fork summaries and their `/fork-summary/*` actions are (see Fork). Since contract revision 23, `chat-messages-window-metadata-v1` means `GET /chats/{chatId}/messages` pages also carry the chat metadata a whole-chat read returns. Since contract revision 24, phones (`iphone`, `ipad`, and since revision 31 `android`) alone may see `phone-run-control-v1` (see Phone run observation and control). Since contract revision 28, `chat-visuals-v1` means chat messages may carry `visuals` (see Inline visuals, revision 28). Since contract revision 34, `speech-request-gzip-v1` means this host accepts a gzip body on `POST /speech/transcriptions` (see below). Since contract revision 41, paired desktops alone may see `chat-context-pressure-v1`, which means `GET /chats/{chatId}/context` is implemented (see Composer context pressure, revision 41). Feature tokens grant no authority: progress reads still require the matching negotiated grant, and stream inputs still require `chat:write`. The list is scoped to the calling device's audience and never holds more than 32 tokens, because shipped iOS, Android and desktop clients refuse a longer list. Paired desktops (`mac`, `linux`) are not told about the phone surfaces `chat-ui-panels-v1`, `chat-ui-panels-enabled-v1`, `tts-v1`, `speech-request-gzip-v1` and `providers-create-v1`; the routes behind them are unchanged. Desktop clients accept up to 64 tokens, so a newer host with a few more never makes them refuse the connection. Clients ignore other bounded feature values and retain the legacy full-chat list fallback when `chat-summaries-v1` is absent. `serverCapabilities` is emitted only when the paired device persistently opted into an additive capability vocabulary—`acceptsBotCapabilities: true` at pairing, `acceptsProgressCapabilities: true` at pairing, or a successful `POST /device/capabilities` upgrade; it contains the server-supported inventory independently of the device's grants. A Bot-aware device without `bot:read` may therefore learn that its Mac supports Bots but still cannot infer any Bot identity or chat. A legacy device that happens to contain a later grant never receives the additive field unless it negotiated the vocabulary.
- `PATCH /device/identity`: authenticated device-label refresh with exact body `{ "name": string }`. It requires `server:read`, updates only the calling credential's bounded display label, and returns the normalized label. The label is presentation metadata—not an authentication or cross-Mac identity key. Older Macs may omit this additive route, so clients treat an unavailable refresh as non-fatal.
- `POST /device/capabilities`: additive post-pairing capability negotiation with exact body `{ "accepts": ["tasks:read", "agents:read"] }` (either member may be omitted). It requires `server:read`, accepts only members of the progress vocabulary plus the desktop-only `simulators:control`—duplicates, unknown capabilities, and legacy or Bot capability names fail closed with `invalid_request`—and returns the calling device's complete updated `capabilities` grant list. Negotiating any progress capability also opts the device into the additive `serverCapabilities` projection on later `GET /server` reads. Legacy and Bot grants remain pairing-bound; this route can never add, widen, or remove them, and it never mints authority for another device. Older Macs may omit this additive route, so clients treat an unavailable upgrade as non-fatal and keep progress surfaces hidden. A paired `mac` or `linux` device may also request the desktop-only `simulators:control`; any other device type receives `403 capability_denied` (checked before the feature, so a phone never learns whether it exists), and a Mac without the simulator feature returns `404 not_found`. The device type is the one declared at owner-approved pairing, so "desktop-only" rests on that pairing trust plus the serving owner's sharing consent. Negotiating only `simulators:control` does not opt the device into the progress vocabulary. Downgrade note: an older Aiden cannot load a device record holding `simulators:control`, so downgrading the serving Mac after a desktop negotiated it requires re-pairing that desktop. Since contract revision 24, a phone may also request `runs:observe` and `runs:control` while `/server.features` lists `phone-run-control-v1`; it is still refused `host:events` with `403 capability_denied`. Since contract revision 26, a phone may request `simulators:mobile` while `/server.features` lists `mobile-simulators-v1` (`404 not_found` on a Mac without the simulator feature); a `mac` or `linux` device is refused it with `403 capability_denied`, and phones are still refused `simulators:control`.

Device enumeration/revocation remains desktop-local in v1 unless a later explicit capability is added.

### Workspaces and approved-root browser

- `GET /workspaces`, `GET /workspaces/{workspaceId}`
- `POST /workspaces`: `folderless`, `scratch`, or `selected-folder` with an idempotency key.
- `PATCH /workspaces/{workspaceId}`: revision-checked name/permission patch. Permission elevation requires explicit foreground confirmation evidence.
- `DELETE /workspaces/{workspaceId}`: revision-checked unregister only; never deletes the folder.
- `GET /workspace-browser/roots`
- `GET /workspace-browser/children?location=...&cursor=...`
- `POST /workspace-browser/selections`

Approved roots are server-side records containing random root ID, canonical path, filesystem identity, policy revision, display label, and hidden/system policy. Nested roots are deduplicated/rejected. Home requires explicit local warning/confirmation; filesystem root is disabled by default and never remotely enabled.

Location handles are random high-entropy nonces stored as digests and bound to instance/device/root/policy/canonical internal location/filesystem identity/expiry/depth. Cursors additionally bind the parent handle and ordering snapshot. Handle stores prune expired/consumed records, enforce a hard entry ceiling, and fail closed at capacity. Listings are deterministic, paginated, rate limited, directory-only, and nonrecursive. `GET /workspace-browser/roots` omits an approved root whose folder is missing or no longer verifies its identity, and fails only when no approved root can be listed.

Selection nonces are a separate type. Workspace creation atomically revalidates real path, directory type, root boundary, policy revision, filesystem identity, and duplicate state, then consumes the nonce once inside one synchronous storage transaction. Async mutation callbacks are prohibited; an escaped promise fails closed with the nonce consumed. Reuse or browse-to-register replacement fails closed. Selected-folder workspaces default to `ask`.

### Chats, turns, streams, approvals

- `GET /chat-summaries?limit=100&cursor=...`: authenticated transcript-free regular-chat metadata projection for mobile home/sidebar loading. It requires `chat:read`; defaults to 100 rows and rejects limits outside `1...200`.
- `GET|POST /chats`
- `GET|PATCH|DELETE /chats/{chatId}`
- `POST /chats/{chatId}/move`: empty chat only.
- `GET /chats/{chatId}/tasks`: authoritative `ChatTaskProgress` snapshot for one chat. Requires `chat:read` and the negotiated `tasks:read` grant; a device without the grant fails closed with `capability_denied`. Available only when `/server.features` advertises `chat-tasks-v1`.
- `GET /chats/{chatId}/agents?turnId=...`: authoritative `ChatAgentRoster` snapshot for the chat's active or most recent public turn when `turnId` is omitted, or for the requested opaque public turn identity when supplied. The response's optional `previousTurns` list lets a reopened client discover bounded historical selectors and request each prior roster with the same query. Requires `chat:read` and the negotiated `agents:read` grant. Available only when `/server.features` advertises `chat-agents-v1`.
- `POST /chats/{chatId}/agents/{agentId}/interrupt`: stops one delegated agent in the chat's current public turn through the same Mac stop path as the desktop agent panel, then returns the refreshed current-turn `ChatAgentRoster`. `agentId` is the opaque public ID from that roster; the Mac resolves the private run internally and never echoes it. Requires `chat:write` plus the negotiated `agents:read` grant (and `bot:write` for a retained Bot chat), no request body, and no `Idempotency-Key`: stopping an agent that is already terminal is a `200` no-op that returns the current roster. An agent ID that is not in the current turn fails with `404 not_found`; an agent that belongs to a legacy or unbound run the Mac can no longer address fails with `409 operation_stale`. Archived chats reject it as `mutation_blocked`. Only the addressed child stops—the parent run and other agents continue. Available only when `/server.features` advertises both `chat-agents-v1` and `chat-agent-interrupt-v1`.
- `GET /chats/{chatId}/skills`: bounded invocable-skill catalog for one chat. Requires `chat:read` and the negotiated `skills:invoke` grant; a device without the grant fails closed with `capability_denied`. Available only when `/server.features` advertises `chat-skills-v1`. The response is `{ "skills": [...] }` with at most 500 entries of exact keys `invocationId`, `name` (≤80), `description` (≤240, may be empty), `source: configured|workspace|global`, `available`, and `unavailableReason` (≤160, present exactly when `available` is false). `invocationId` is an opaque short-lived lease in the `sk1_` format, bound to the workspace and skill-registry revision; Bot chats are narrowed to the Bot's currently admitted skill policy, and desktop-only built-in skills (such as `aiden-artifacts`, whose tool phones never get) are left out. Entries carry display metadata only—never skill paths, instructions, fingerprints, or registry internals.
- `GET /chats/{chatId}/context?providerId=...&modelId=...` (contract revision 41, `chat-context-pressure-v1`, paired desktops only): the next-request context pressure the host's own composer meter shows for one workspace chat, as bounded counts only. Requires `chat:read`; Bot chats follow the usual `bot:read` rule and are then refused with `404 not_found`. See Composer context pressure, revision 41.
- `GET /chats/{chatId}/progress/events`: dedicated chat-scoped live snapshot channel for observing work started by any paired device or by desktop. The `streamId` is the chat ID. A subscription emits complete nonterminal `task_update`/`agents_update` projections filtered to the matching grants (`tasks:read` or `agents:read`); transport heartbeats are SSE comment frames and are not protocol events. `Last-Event-ID` and `after` remain accepted for client compatibility, but this channel has no durable replay journal: every connection hydrates current snapshots, and a reconnect/full snapshot resync supersedes any requested offset. A device needs `chat:read` plus at least one progress grant to open the channel.
- `GET /models`: configured provider/model projection without credentials.
- `GET /usage?range=7d|30d|90d|1y|all`: aggregate request, token, activity, and estimated-cost totals from the Mac's device-local usage store. Requires `server:read`; never returns content, chat/workspace identifiers, paths, raw usage records, or credentials.
- `POST /chats/{chatId}/turns`: atomic append/admit/start, idempotent by client key. The optional `skill` field carries one invocation lease of exact keys `version: 1`, `invocationId`, `displayName`, and `source`, obtained from `GET /chats/{chatId}/skills`; the host revalidates and redeems it through the same skill-preparation path desktop slash selection uses, so stale, malformed, unauthorized, unavailable, or registry-changed leases fail with `skill_unavailable` (or `invalid_request` for malformed envelopes) and the turn is released cleanly. Text or attachments are still required—a skill alone does not start a turn. The redeemed selection is persisted as safe provenance on the user message; skill instructions and paths never cross the wire.
- `POST /chats/{chatId}/attachments`: validate and stage one bounded image or UTF-8 text attachment.
- `DELETE /chats/{chatId}/attachments/{attachmentId}`: discard an unused staged attachment.
- `GET /chats/{chatId}/attachments/{attachmentId}/content`: return one authenticated, chat-scoped canonical PNG or JPEG for preview.
- `GET /streams/{streamId}`
- `GET /streams/{streamId}/events`: SSE replay via `Last-Event-ID` or `after`.
- `POST /streams/{streamId}/cancel`: request cancellation of the authenticated parent turn stream. This is not a child/subtree control endpoint; any internal child shutdown is a Mac-owned consequence of cancelling the parent and is never separately addressable by mobile.
- `POST /streams/{streamId}/inputs`: shared foreground admission for mid-flight input, advertised only when `/server.features` contains `chat-run-input-v1`. Requires `chat:write`, an `Idempotency-Key`, and an exact `{ "mode": "steer" | "queue", "text": string }` body bound to the displayed stream. The host derives the chat and turn from the stream record, revalidates device ownership and chat access, persists the user message durably, then admits it into the Pi runtime queue. Responses are domain receipts, not HTTP errors: `status: "admitted"` carries `queue: "steer" | "follow-up"`, `committed: true`, and `messageId`; `status: "rejected"` carries `reason: run_not_active | cancelled | capacity | invalid` plus `committed`. `committed: true` means the user message is already durable transcript history even when admission was rejected (e.g. the run finished mid-request); clients must surface it, never silently retry. The idempotency ledger replays the original outcome for a repeated request UUID—even after the stream record is evicted—and rejects conflicting payload reuse. Domain receipts replay verbatim; transport-level rejections (for example an access denial recorded mid-flight) replay as `internal_error` rather than their original code. Uncertain persistence stays `idempotency_in_flight`; control writes must not auto-retry. An admitted `steer` also stops the run's still-running subagents so the guidance is not held behind them; the run continues and those subagents report as interrupted. `queue` never stops subagents. The wire contract is unchanged.
- `POST /approvals/{approvalId}/respond`: `allow` or `deny` only. Allowing a
  `schedule_task` or `edit_automation` approval additionally requires the
  authenticated device's `schedule:write` grant. A device that can respond to
  approvals but lacks that mutation grant still receives the bounded approval
  with `canAllow: false` and may deny it; an attempted allow fails closed.
  Contract revision 17 adds an optional `scope` (`once` | `chat` | `always`)
  that is valid only with `allow` and only when the pending approval listed it
  in `scopes`; anything else is `invalid_request`, and the response echoes the
  chosen scope. `chat` and `always` remember only the same tool with the exact
  trimmed command or exact normalized workspace-relative path, in the same
  workspace; `chat` lasts for that chat until the Mac app quits and `always`
  persists on the Mac until revoked in Settings → Tool approvals. Omitting
  `scope` means `once`, so revision 16 clients are unchanged.
- `GET /streams/{streamId}/approval`: current bounded approval snapshot, or `null` after resolution. Since revision 17 an allowable snapshot may carry `scopes` (starting with `once`, at least two entries); it is omitted when only a one-time allow is possible or `canAllow` is false. Scopes are offered only for plain parent workspace `write_file`, `edit_file`, and `run_command` calls in an Ask workspace, never for Bot turns, privileged or structured approvals, or schedule/automation tools. Since revision 39, a scheduled-task approval also carries the display-only `schedule` card for devices holding `schedule:cards` and `schedule:read` (see "Scheduled-task approval cards, revision 39").
- `GET /streams/{streamId}/question`: current bounded question-prompt snapshot, or `null` after resolution. Requires `chat:read` and is advertised only when `/server.features` contains `chat-question-prompts-v1`; any authenticated device may read its own stream's snapshot, while a response still requires the `questions:respond` grant. The snapshot carries `promptId`, `streamId`, `chatId`, `toolCallId`, the bounded `questions` array (1–4 questions, each with `question`, `header`, `multiSelect`, and 2–4 `options` of `label`/`description`), and `expiresAt`. `expiresAt` is the agent's own answer deadline, never more than five minutes after the prompt reached the stream; when it passes, the host tells the agent to proceed with its best judgement and the prompt resolves as expired. Clients should present an answer given after that point as an ordinary follow-up message. Question text is assistant-authored and already bounded by the host grammar; no host-only data is projected.
- `POST /questions/{promptId}/respond`: resolve one pending prompt owned by the authenticated device. Requires `questions:respond` and an `Idempotency-Key`. The exact body is `{ "cancelled": boolean, "answers": [...] }` where `cancelled: true` dismisses the entire prompt and each answer addresses one question index as `{ "questionIndex": n, "kind": "option" | "custom" | "multi", ... }`—`option` carries one selected `answer` label, `custom` carries free `answer` text (bounded to the shared custom-answer limit), and `multi` carries a unique `selected` label array for `multiSelect` questions. The host semantically validates answers against the stored prompt before settlement: wrong indices, unselectable options, single answers on multi-select questions, or malformed kinds return `invalid_request`. Success returns `{ "promptId", "resolvedAt" }`. A second response for a settled prompt returns `question_already_resolved`; an expired, cancelled, or terminated prompt returns `question_expired`. The idempotency ledger replays the original outcome for a repeated request UUID and rejects conflicting payload reuse. The stream leaves its waiting state and resumes generation once the host consumes the answer.

Turn start returns `turnId`, `streamId`, accepted state, and canonical appended message. The generation owner is the authenticated device/stream, not a socket. Disconnect never resends the prompt or cancels the turn. Restart during an active remote turn records one explicit interrupted terminal state and never retries the provider call.

The ordinary `GET /chats` Workspace projection is regular-chat only, and ordinary `POST /chats` rejects `botId`. The additive `GET /chat-summaries` route is also regular-chat only and reads the main-owned metadata index, title-pending registry, and safe per-chat activity registry without opening any transcript file. Each summary contains exact bounded `id`, `workspaceId`, `title`, required `titlePending`, `createdAt`, `updatedAt`, `revision`, and `activity: idle|active`, plus the revision-18 additive `rowState: needs_approval|needs_input|working|idle` and `unread` Boolean and the revision-36 additive `lastRunFailed: true`; it never carries messages, attachments, provider/model selections, Bot identity, reasoning, timeline, or transcript data.

`rowState` is the list-row state in display priority: `needs_approval` while a tool approval raised by the chat's own turn is waiting, `needs_input` while an ask-user question is waiting, `working` while a turn is running, and otherwise `idle`. Prompts raised by child or delegated streams are not attributed to the parent row. `unread` is true only when assistant output was persisted after the chat was last viewed on any surface; the desktop sidebar, the desktop chat view, and every paired device share one main-owned marker store, so viewing a chat anywhere clears it everywhere. Output older than the host's read-tracking baseline (stamped when the marker store is first created) is never unread, and hosts without `chat-read-state-v1` always report `false`. Clients that receive a summary without `rowState` fall back to `activity`. Since contract revision 36 (provisional; re-claimed at merge after whatever `main` holds then), a failed turn counts as assistant output for `unread` even when it produced no text, and a row whose newest assistant output is a failed turn (a terminal provider failure or a failed generation timeline; a Stop is a cancellation, not a failure) carries `lastRunFailed: true`. The key is absent otherwise and is never `false`. Clients show Failed in place of the unread dot while `unread` is true, so a background failure never reads as a fresh reply; older clients ignore the key and keep the dot.

- `POST /chats/{chatId}/read` (feature `chat-read-state-v1`): body `{}` or `{ "throughMessageId": "…" }`. Requires `chat:read` and read access to the chat, and returns `204`. Markers only move forward; an unknown or stale message id is a harmless no-op and can never advance the marker past output the device received. Without `throughMessageId` the marker covers the newest persisted message.

Summary pages sort by `updatedAt` descending and then safe ASCII chat ID ascending. The first request freezes a bounded five-minute snapshot; each short integrity-protected cursor addresses that snapshot rather than recomputing from live ordering. New or updated chats cannot enter later pages, deleted chats are skipped, and no surviving chat is emitted twice. Forged, malformed, expired, evicted, or restart-invalidated cursors fail closed with `invalid_request` instead of silently restarting. The terminal page omits `nextCursor`. Native clients use this route only when `/server.features` advertises `chat-summaries-v1`, retain their installation-scoped legacy `/chats` fallback for older Macs, and continue using `GET /chats/{chatId}` for detail reads.

Every direct read that resolves a Bot-classified chat—including its attachment content, stream, and approval snapshot—requires both its existing route grant and `bot:read`. Every mutation, turn, attachment write, stream cancellation, or approval response for a Bot chat additionally requires `bot:write`. Missing Bot authority returns the same unavailable/expired classification as an unknown scoped resource so a legacy device cannot infer Bot identity from a retained chat, stream, attachment, or approval identifier.

First-turn title generation remains off the interactive response path. While it is active, chat list/get projections include optional `titlePending: true`; the field disappears only after the title job settles. Clients may use this hint for a bounded authoritative refresh and must not treat it as a revision or mutation precondition.

Bot chats are persistent identity records and are not independently deletable through the generic `DELETE /chats/{chatId}` route. Archive the Bot to make it read-only; this prevents retained legacy duplicates from being promoted into a second active conversation.

### Paired-Mac speech transcription

- `GET /speech`: current local engine, selected model, readiness, and allowlisted model setup state. Requires `server:read`.
- `PATCH /speech`: select an installed allowlisted model. Requires `chat:write`.
- `POST /speech/models/{modelId}/download`: download and install one fixed-catalog model archive on the Mac. Requires `chat:write`.
- `DELETE /speech/models/{modelId}/download`: cancel that model's active setup. Requires `chat:write`.
- `DELETE /speech/models/{modelId}`: remove an installed model when it is not active. Requires `chat:write`.
- `POST /speech/transcriptions`: transcribe one exact PCM16 envelope locally and return one final transcript. Requires `chat:write`.

Speech setup and use map to the frozen v1 `server:read` and `chat:write` grants so shipped strict clients can continue pairing. A future protocol revision may split speech use from model administration; v1 clients must not infer such authority from unknown capability names.

The transcription request accepts only mono signed 16-bit little-endian PCM at 16 kHz, base64 encoded, with at most 60 seconds of samples. The Mac authenticates before buffering this larger body, repeats the credential mutation fence after buffering, validates the exact envelope, and admits at most one active decode plus one queued decode. A third concurrent request fails with retryable `429 rate_limited`. The local Parakeet engine emits final text only; recordings and transcripts are not persisted, included in diagnostics, or sent to Aiden's provider integrations.

Since contract revision 34, a host with speech transcription wired advertises `speech-request-gzip-v1` in authenticated `GET /server.features`. Only after seeing that token may a client gzip the **same JSON envelope** and send `Content-Encoding: gzip` with `Content-Type: application/json` to `POST /speech/transcriptions`. Older hosts receive identity JSON with no `Content-Encoding`; this host also accepts explicit `identity`. No other route accepts request compression through this feature. The host permits one valid gzip member only, rejects malformed members, concatenated members, trailing bytes and other or combined content codings, and caps both encoded and expanded request bodies at 2,561,024 bytes (`413 payload_too_large`). A malformed stream returns `400 invalid_request`; an unsupported content coding returns `415 invalid_request`. The existing PCM and exact-envelope checks apply after decompression.

Mobile-triggered setup may download only the fixed, hash-pinned URL compiled into Aiden for that model: a k2-fsa release archive, or, on an Apple silicon Mac, the Parakeet v3 GGUF at a fixed Hugging Face revision (`parakeet-v3-metal`, which `GET /speech` lists only on such a Mac). The Mac enforces an 800 MiB download ceiling and the model's exact pinned size and SHA-256, extracts an archive (or moves the single verified file) into a staging directory, requires the complete model manifest, then publishes the model. Callers cannot provide a URL or destination. Download, extraction, and recognition failures return only stable sanitized errors. A separate extracted-byte/file-count ceiling remains required before treating hostile-archive expansion as fully mitigated.

### Bots, Bot conversations, access, and avatars

These routes were frozen as contract in Phase 1 and implemented in Phase 4 through main-owned application and authority services: authenticated Bot identity, access, chat creation, favorite order, notice acknowledgement, bounded inbox projection, managed-home files, and canonical avatars. Each Bot operation carries `x-aiden-capabilities`; every listed capability is required conjunctively. `x-aiden-capability` remains the primary legacy annotation, not an alternative grant. A Bot mutation therefore always requires both `bot:read` and `bot:write`, plus the ordinary `chat:*` or `files:*` grant when it reuses those resource classes.

- `GET /bots`: at most 256 bounded summaries, matching the authoritative Bot-store ceiling, plus the fixed maximum and authoritative revisioned favorite order. `includeArchived=true` is explicit. Summaries never contain instructions, every summary has `updatedAt >= createdAt`, and favorite IDs never refer to archived Bots even when archived summaries are included.
- `POST /bots`: exact `BotCreateRequest`, including one required Full/Custom `access` update tied to the current catalog revision, device-scoped `Idempotency-Key`, and authoritative `BotDetail` response. Identity and initial access are created atomically. Any provider/model pair selected by the request or resolved by the Mac for creation must be currently available; unavailable selections fail closed without fallback.
- `GET /bots/{botId}`: authenticated detail with editable guidance, a safe access view, the Bot's optional current audience-safe provider/model selection, and its optional `visionModelSelection`. The latter is a separately bound image-inspection companion; private runtime identities never cross this boundary.
- `PATCH /bots/{botId}`: exact non-empty `BotIdentityPatch` plus `If-Match`.
- `DELETE /bots/{botId}`: `If-Match` soft archive returning the new authoritative detail; it never hard-deletes or mutates identity, history, home, semantic avatar, or avatar assets. Archive atomically removes the Bot from favorites.
- `POST /bots/{botId}/restore`: `If-Match` plus `Idempotency-Key`, returning the restored authoritative detail.
- `GET /bot-favorites` and `PATCH /bot-favorites`: at most 20 unique, non-archived Bot IDs; update is whole-list replacement under `If-Match`, so membership and order change atomically. A replacement may omit archived Bots and may still edit unrelated active favorites, but adding an archived Bot returns `bot_archived`. No successful favorites response retains an archived Bot ID.
- `GET /bot-conversations?cursor=…&query=…&botId=…&limit=…`: newest-first stable pages of at most 50 items, with a 200-scalar search query and 128-scalar cursor. Search is confined to Bot name/purpose, conversation title, and the bounded previews actually projected by the Mac. Every item has `updatedAt >= createdAt`. `canRespondToApproval: true` is valid only while `activityState` is `waiting_for_approval`; a waiting row may still be non-respondable when the paired device lacks authority.
- `POST /bots/{botId}/chats`: open-or-create the Bot's one persistent chat. The frozen v1 response remains `201` and the operation identifier remains `createBotChat` for compatibility with shipped clients, even when the existing chat is returned. When it already exists, the Mac returns it unchanged and ignores creation-only provider/model input. When absent, an empty body inherits the Bot provider/model; otherwise one exact providerId/modelId pair is required, plus `Idempotency-Key`. Partial pairs never fall back. The creation pair must be currently available; an unavailable selection fails closed without fallback. The Mac injects the authoritative `botId` and hidden managed-home workspace; neither identifier is accepted in the body, and every successful response includes that authoritative `botId`. Concurrent calls and retries converge on the same chat. Legacy duplicate chats remain readable for recovery, but only the deterministic canonical chat is writable or projected in the Bot inbox. From 0.60.0, while a host serves `bot-durable-session-v1`, `POST /chats/{chatId}/turns` on a Bot's chat answers `400 invalid_request` ("Update Aiden on this device to chat with this Bot…") and appends nothing: the Bot's conversation is its durable session, and a workspace-chat turn would run outside it. Paired desktops open a host's Bot through `GET /bots/{botId}/session`, its `/session/events` stream and the session routes, as phones do, and negotiate `bot:activity` when the host announces `bot-activity-v1` (they do not take `bot:cards`). A desktop that misses that answer (the host was briefly unreachable) asks again on its next reconnect; a refusal is final. Desktops offer Queue and Steer only while they hold `bot:activity`, because without it the host sends them no `queued` list. A desktop reads a newer host's session as far as it understands it, as phones do: an unknown session state reads as `unavailable`, an entry it cannot parse is left out, and a stream event it cannot parse makes it read `GET /bots/{botId}/session` again instead of dropping the stream. After a clean `closed` event it reopens the stream at once (up to twice in a row, then with backoff). `BotSession` and `BotMessageReceipt` compose the state fields from `BotSessionStateFields` and close with `unevaluatedProperties: false`; `BotSessionState` alone stays closed for Resume, Dismiss and Stop. A host error's own `message`, when short and printable, is what a paired desktop shows for a refused request.
- `GET /bot-capabilities?botId=…`: safe revisioned provider/model, image-input capability, file-scope, shell, connection/MCP, skill, and other-capability catalog plus the full notice status. The optional, exact `botId` selects an authenticated existing Bot so its saved unavailable choices can remain visible; omitting it returns the generic creation catalog. Unknown, duplicate, malformed, empty, and overlong query values fail closed. `supportsImages` is explicit and unknown capability fails closed. The response never returns display copy that the client could mistake for authority.
- The catalog’s additive `skillsEnabled` boolean defaults to `true` when omitted. When `false`, skill inventory discovery and incarnation reconciliation pause; target-Bot catalogs may retain that Bot’s authenticated saved skill IDs as unavailable choices. Clients may preserve or remove those saved choices during unrelated edits, but must not offer unavailable unselected skills as new choices. The Mac enforces exact saved ownership and per-chat narrowing, withholds skills from all runtime contexts, and restores unchanged selections when the global gate reopens. Invalid provided values fail decoding.
- `PATCH /bots/{botId}/capabilities`: `If-Match` Full/Custom update with the exact current `catalogRevision`. Full requires `confirmedForeground: true` and may carry one exact provider/model pair; omitting both preserves the saved choice for compatibility with older clients, while supplying only one is invalid. Custom contains exactly one currently available provider/model pair plus only exact positive opaque selections from that catalog. Optional `visionModel` uses three-state semantics: omitted preserves the companion, `null` clears it, and an exact provider/model object sets it only when the catalog marks that model image-capable. A supplied pair becomes revisioned durable authority, changing either primary or companion fences active turns, and the canonical persistent chat mirrors only the primary model. An unavailable model remains visibly blocked and is never replaced by fallback.
- `GET /chats/{chatId}/capabilities` and `PATCH /chats/{chatId}/capabilities`: authenticated authoritative inherit/Custom view, then an `If-Match` update carrying both the exact `catalogRevision` and `expectedBotPolicyRevision`. The server rejects policy drift or any selection outside the current Bot ceiling and returns the authoritative chat subset view.
- `GET /bot-access-notice`: Mac-owned acknowledgement status for this paired device. This v1 client recognizes only `bot-full-access-v1`; an unknown future version fails closed until matching copy ships. `POST /bot-access-notice/acknowledgement` accepts only that exact version, `continue_full` or `customize_first`, `confirmedForeground: true`, and an `Idempotency-Key`. Local dismissal never acknowledges it.
- `GET /bot-conversations/{chatId}/files` and `GET|PUT /bot-conversations/{chatId}/files/{fileId}`: reuse `FileIndex`/`FileDocument` and expected-version writes, but authorize every operation against the device grant, authoritative Bot/chat binding, current Bot policy, chat reduction, policy epoch, and managed-home identity. Ordinary Workspace file routes reject hidden Bot homes even if their opaque workspace ID is learned.
- `PUT /bots/{botId}/avatar`: one exact bounded PNG/JPEG source envelope under `If-Match` and `Idempotency-Key`; the Mac validates it, independently decodes it, and stores a canonical 512 × 512 PNG before returning canonical metadata. Before the first raster photo, `If-Match` is the Bot detail revision; afterward it is the current public `assetRevision`, so simultaneous photo edits conflict even though the semantic identity is unchanged. `DELETE /bots/{botId}/avatar` uses that same rule and returns the Bot to its semantic fallback.
- `GET /bots/{botId}/avatar/{assetRevision}`: authenticated canonical 512 × 512 PNG only, with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Bot ID and asset revision must match the current main-owned record.
- `POST /bots/{botId}/handoffs/{waitId}/answer`, `POST /bots/{botId}/handoffs/{waitId}/open-on-mac`, and `POST` / `DELETE /bots/{botId}/pause` (contract revision 37): need `bot:read`, `bot:write` and `bot:handoffs`, plus an `Idempotency-Key`. See "Bot hand-offs and pause, revision 37".
- `POST /bots/{botId}/issues/{issueId}/act` (contract revision 42): needs `bot:read`, `bot:write` and `bot:issues`, plus an `Idempotency-Key`. See "Bot issues on phones, revision 42".

An authorized archived Bot remains readable but read-only until restored: list/detail, conversation/history, existing attachment and managed-home file reads, access views, and the current canonical avatar remain available. Chat open-or-create, new turns, uploads, writes, approval effects, identity/access/avatar mutations, and attempts to add the archived Bot to favorites return `bot_archived`; restore remains allowed. Archiving atomically removes favorite membership. Bot reads without `bot:read`, mutations without the full conjunctive grant, cross-Bot/chat references, corrupt bindings, unavailable records, and unknown IDs retain the same non-inferential unavailable classification. Catalog or policy revision drift returns `revision_conflict` with only the current safe revision; invalid/removed opaque selections fail closed and never fall back to Full. Authoritative Custom views may retain selected catalog tombstones marked `available: false` so drift is visible, but new mutations may select only entries currently marked available.

### Attachments

Uploads produce random, short-lived, single-use references bound to the authenticated device and exact chat. References expire after 10 minutes, are removed on device revocation, and are consumed atomically by a turn. A turn accepts at most 10 distinct references. The server retains at most 20 staged references per device/chat, 40 per device, 256 globally, and 64 MiB of staged representation data; capacity exhaustion fails closed.

Image uploads accept only PNG or JPEG, at most 8 MiB decoded, at most 16,384 pixels on either axis, and at most 40 million decoded pixels. Text uploads accept only the documented plain-text/source MIME allowlist, at most 100,000 Unicode scalars and 400,000 UTF-8 bytes. Display names are bounded to 255 Unicode scalars and reject separators and control characters. Upload envelopes never accept a local or server path. Chat and message responses project attachment ID, display name, MIME type, kind, and size only; inline bytes and text are never returned. A client may fetch a projected raster by its opaque attachment ID through the authenticated content route. The server re-resolves it inside the requested chat, fails closed on duplicate IDs or mismatched size/MIME/signature, and returns only bounded canonical image bytes with `no-store` and `nosniff` headers. Text and filesystem content are never exposed through that route.

At turn admission the Mac computes the image route from main-owned Bot authority. A vision-capable primary receives pixels natively. A text-only primary may use only its explicitly saved companion through the built-in `inspect_image` tool; the tool accepts generation-scoped attachment aliases, performs one bounded tool-free model call, and returns text to the primary. Without either route, admission fails before staged uploads are consumed. Neither the client nor the primary model can supply arbitrary paths, URLs, provider credentials, or chat identifiers to image inspection, and Aiden never silently falls back to another provider.

Assistant message history also carries a closed exceptional outcome when a stored generation failed or was cancelled. Failure metadata is restricted to Aiden's fixed provider category, bounded attempt count, and retry-exhausted flag; provider-authored errors and diagnostics remain forbidden. Completed messages omit this field. This makes terminal state durable across SSE disconnects and app restarts without exposing the private generation journal.

### Files and Git

- `GET /workspaces/{workspaceId}/files`: legacy recursive snapshot with maximum 4,000 entries and depth 20 plus `truncated`.
- `GET /workspaces/{workspaceId}/files?tree=1[&directory=<file handle>][&cursor=<cursor>]`: opt-in lazy browsing using the same `files:read` grant. Each response contains at most 200 direct children, a workspace-relative `directoryPath` (empty for root), and optional `nextCursor`. The Mac scans at most 8,000 directory records and captures at most 4,000 eligible entries, without descending into children or listing symlinks. Enumeration uses the packaged Mac helper with inode-bound root/target descriptors, component-wise `openat(O_NOFOLLOW)`, and `fdopendir`; a path swap cannot redirect names or pagination counts. The lazy service requires a canonical configured root/ancestor chain (apart from fixed macOS system aliases) on every request and binds each directory handle, file handle, and cursor to the root identity it was issued under; after a root replacement those fail closed, as does a request that observes the root change while it runs. A fresh root listing admits a folder re-created at the configured path (for example a re-clone, restore, or remount). Persisted workspace records do not contain registration-time inode identity, so a regular-directory replacement is not distinguished from such a re-creation. Lazy handles take file device/inode identities directly from native enumeration. Their reads and saves use the pinned root and file identities with descriptor-relative no-follow traversal. Successful saves return a fresh file handle (clients bind the response to the requested `displayPath` rather than the old handle, and rebind that tree entry to the returned handle) and retain the displaced version in a `.aiden-recovery-*` file; at most 16 such copies per folder are admitted under a directory lock, and further saves require reviewing/removing unneeded copies on the Mac. Lazy enumeration, reads and saves reject multiply-linked regular files, including link-count changes detected during descriptor verification. This protects source-file admission; it does not prevent a local actor with workspace read access from copying a staged or saved draft. A post-install verification or output failure may require reopening the file to reconcile the save result; the original recovery copy is retained. Legacy snapshot handles retain their existing list/read/write behavior. Non-Mac hosts return 404 for this opt-in route so clients retain the legacy snapshot fallback. `truncated` reports scan limits/omissions separately from page continuation. Cursors bind the device, workspace revision, directory identity, and captured ordering; they expire after ten minutes or when their bounded inventory is evicted. The cache retains at most 16 unfinished inventories. Expired pages require refresh. File reads/writes continue to use opaque file handles and expected versions; this endpoint accepts no paths and creates no authority.
- Native source previews render up to 2,000 lines and 2,000 characters per line, with explicit clipping markers. Opening a preview never writes or fetches images. Explicit `./` chat references resolve through these directory pages (at most 40 requests) before an opaque read. Absolute/home paths, traversal, and encoded separators escaping the workspace are rejected locally. Existing system URL actions remain available for non-file links.
- `GET|PUT /workspaces/{workspaceId}/files/{fileId}`: opaque file handle; write requires `expectedVersion`.
- Git review/diff/compare/comparison-diff/branches/checkout/create-branch/commit/push-capability/push/worktrees/create-worktree/delete-managed-worktree under `/workspaces/{workspaceId}/git/...`.

File handles are separate from browser handles and bind instance/device/workspace/canonical root identity/relative file identity/index snapshot/expiry. Read/write re-resolves within the canonical root. Snapshot and lazy file handles are never issued or resolved for multiply-linked regular files, because another name for the inode may lie outside the root; snapshot reads verify the issued device/inode and single-link status on the descriptor that supplies the bytes. Writes retain Aiden's atomic replacement and expected-version conflict behavior; a snapshot-handle save rebinds the same handle to the installed inode. When the file-handle store is full, never-used handles from a device's superseded snapshot listing of the same workspace or Bot conversation are reclaimed before a listing fails with `handle_capacity`. There is no file create/rename/delete in v1.

Git mutations reuse the workspace operation registry and mutation gate plus canonical common-directory serialization. Commit/push remain repository-root-only; nested workspaces expose a read/diff-only reason. A review or comparison omits a changed path that cannot be projected safely (control characters or over 4,096 characters) instead of failing; it gets no file handle, still counts toward `uncommitted`, and a review that omitted one reports commit `allowed: false` and refuses commit with `git_capability_denied`, so a device never commits a change it was not shown. Consequential actions carry an explicit foreground-confirmation field and return stable operation/snapshot IDs. Disconnect does not abandon an operation owner. There is no fetch, pull, stage/unstage, discard, generic Git, or terminal endpoint.

### Paired-Mac simulators

Desktop-to-desktop, except for the phone scope in "Phone simulator viewer" below. Every desktop route requires `simulators:control` on a `mac` or `linux` device; a device without the grant receives `403` before any `404 not_found` for a Mac without the simulator feature. The serving Mac's owner must turn on Share with paired Macs (which requires simulator streaming consent); until then the listing reports `sharing: false` with no devices and every control fails closed. Device-scoped requests must name a simulator in the current listing.

- `GET /simulators`: sharing flag, host status, bounded detail, and at most 256 simulators.
- `POST /simulators/open|shutdown|settings`: body `{ "deviceId": string }`.
- `POST /simulators/action`: one control action; the serving Mac always runs it on its own simulators.
- `GET|HEAD /simulators/hub/{hubPath}`: relays the Simulator tab's allowlisted loopback hub paths (stream page, frames, device list). `hubPath` spans several path segments. A WebSocket upgrade on this path reaches the per-device helper socket (`vendor/serve-sim/helper/ws?device=`) or the device list socket (`api/devices/ws`); it authenticates the same bearer credential, rejects any `Origin` header, and is admitted only for listed devices. Redirect `Location` headers are never relayed. A device may hold at most 8 open relays; more return `429 handle_capacity`.
- `POST /simulators/hub/vendor/serve-sim/api/screenshot`: body `{ "udid": string }` bounded to 1 KiB; only `udid` is forwarded.

The hub's exec route is never relayed and the hub stays bound to loopback. Relayed streams close when the owner turns sharing off, revokes streaming consent, or revokes the device. The calling Mac contacts paired Macs only from a user-driven refresh or open, never from background polling, and its agent tools stay local-only.

### Scheduled tasks

- `GET|POST /scheduled-tasks`
- `GET|PATCH|DELETE /scheduled-tasks/{taskId}`
- `POST /scheduled-tasks/{taskId}/pause|resume|run`
- `GET /scheduled-tasks/{taskId}/runs`
- `GET /scheduled-tasks/notifications?since=<epoch-ms>` — completed runs across all tasks, newest first (max 100 per poll). The cursor is inclusive so same-millisecond runs are never skipped; when the window overflows, the oldest runs are returned and the remainder arrives on the next poll rather than being dropped. The response carries `now` (the server's epoch-ms clock) — clients baseline their first-poll cursor to it instead of the device clock, mark the returned ids delivered, and suppress the history so neither clock skew nor a fresh install can replay or permanently skip runs. Per-item `summary` is redacted and bounded (2,000 chars) so the feed stays under the 1 MB response cap.
- `POST /scheduled-tasks/preview`
- `GET /scheduled-tasks/scripts?workspaceId=...`
- `GET|PATCH /scheduled-tasks/settings`

Edits and task actions (`pause`, `resume`, and `run`) use `If-Match`/`expectedUpdatedAt`; settings use an equivalent revision. `run` also requires an idempotency key and returns `202` with a durable `runId`. Older clients that omit `If-Match` fail closed with `400` and must refresh before starting a run. Reusing one run key with a different revision returns `409 idempotency_conflict`, allowing clients to discard the stale key instead of retrying an ambiguous operation. Socket loss does not cancel execution. Status is observed in run history. Cancellation follows existing remove/pause/global-disable/revocation/shutdown policy; v1 adds no bespoke remote cancel action.

### Host feed, run streams and run control (contract revision 19)

These routes serve desktop controllers. Phones and tablets never receive the grants, are never told the grants exist, and see no change in any existing route, projection or fixture. Feature tokens `host-events-v1`, `run-streams-v1`, `run-control-v1` and `chat-messages-window-v1` appear in `GET /server.features` only for desktop devices (and, for the messages window, for every device once the host implements it). A host without the services answers these paths with `404 not_found` and offers none of the grants.

- `GET /host/events` (`host:events`, SSE). Event IDs are `<epoch>:<sequence>`; `streamId` is always `host`. The stream opens with a `snapshot` whose payload is `{epoch, sequence, summaries, workspaces, bots}`, then carries `chat.upsert`/`chat.remove`, `workspace.upsert`/`workspace.remove`, `bot.upsert`/`bot.remove` and `run.state {chatId, runId, state, unread}`. Upserts carry the same projection the matching list route returns; removals carry `{id}`. Resume with `Last-Event-ID` or `?after=`. A cursor from another epoch, or one that fell more than 1,000 events or 8 MiB behind, gets a fresh snapshot instead of a replay. A snapshot larger than 256 KiB is split into consecutive `snapshot` frames so no frame approaches the 1 MiB limit: every frame but the last carries `partial: true` and no SSE id, and only the final frame carries the id. Clients append each chunk's `summaries`, `workspaces` and `bots` and replace their host state only on the final frame; a connection lost mid-snapshot resumes from the previous cursor and receives the snapshot again. The host re-checks the device's authorization immediately before it registers a host-feed or run-stream subscription (for the feed, after the opening read), so a revocation that lands while a subscription is opening refuses it with `403 credential_revoked`. The host sends the response headers as soon as it accepts the subscription, before any event, so a resume with nothing to replay is open at once rather than at the next change or heartbeat; run streams behave the same. A 15 s heartbeat comment keeps the connection alive. The feed never scans transcripts: it is fed by the chat activity registry, the chat and workspace change hooks and the host run registry. Bot entries and Bot-chat run states reach only devices that also hold `bot:read`, which read Bots with the host-owner audience. Since contract revision 37 a desktop that also holds `bot:handoffs` reads a paused Bot as `sessionState: "paused"` with `paused: true`; other desktops read it as `unavailable`. Host-feed workspaces may carry an optional `repository {canonicalKey, relativePath}` built from cached Git data: `canonicalKey` is a credential-free `host/owner/name` (no scheme, userinfo, port or query) and `relativePath` is the POSIX path of the workspace inside the repository, `""` at the root. It is never produced by crawling the disk.
- `GET /chats/{chatId}/runs/current/events` and `GET /runs/{runId}/events` (`runs:observe`, SSE). They reuse the `/streams` envelope with `streamId` set to the run ID, and add `run.started {runId, chatId, origin}` (`renderer` | `remote` | `headless`), `approval_resolved {approvalId, decision?}`, `question_resolved {promptId, outcome?}` and a terminal `run.ended {runId, chatId, state}`. `run.ended` repeats the sequence of the last event, so clients must not drop it as a duplicate. Event IDs are decimal sequences and the `aiden-run-epoch` response header names the run journal epoch. Resume with `Last-Event-ID` on `/runs/{runId}/events`; the current-run route accepts no cursor. A cursor behind retention yields a `snapshot {runId, chatId, reason: "gap", epoch, state, pendingApprovalIds, pendingQuestionIds, approvals, questions, nextSequence}` at sequence `nextSequence - 1`; a journal reset yields `snapshot {runId, chatId, reason: "reset", nextSequence}`. An unknown or evicted run is `404 run_gone`. Observers without `runs:control` receive `approval_required` without tool details.
- `POST /runs/{runId}/cancel`, `POST /runs/{runId}/approvals/{approvalId}/respond`, `POST /runs/{runId}/questions/{promptId}/respond` and `POST /runs/{runId}/inputs` (`runs:control`). Each takes an `application/json` body, which for cancel is always `{}`, and requires an `Idempotency-Key` of 16 to 128 visible ASCII characters; a replay within ten minutes returns the original result or error, and the ledger does not survive a restart. The run must still be the one named (`409 operation_stale` otherwise, `404 run_gone` once it is evicted). Approvals and questions are first-responder-wins across every surface: a loser receives `409 approval_resolved` or `409 question_already_resolved` with the winning `decision` or `outcome` and `resolvedAt`. Controllers see full tool details; allowing an approval whose details were withheld is `403 capability_denied`. Cancel returns `202`. Revocation closes the device's host feeds and run streams; it never cancels a run.
- `GET /chats/{chatId}/messages?before=&limit=` (`chat:read`, `chat-messages-window-v1`). Returns `{chatId, revision, messages, hasOlder}`, oldest first, ending just before `before` (or at the newest message). `limit` defaults to 50 and is at most 200; a page never exceeds 1 MiB. An unknown `before` is `409 revision_conflict`. `GET /chats/{chatId}` is unchanged. Since contract revision 23 (`chat-messages-window-metadata-v1`) every page also carries the chat metadata a whole-chat read returns: `workspaceId`, optional `botId`, `title`, `titlePending` (only when `true`), `providerId`/`modelId` (both or neither), `createdAt` and `updatedAt`. Phones refresh an open transcript from the newest window only when the host advertises both tokens, so a desktop rename or model change reaches them without a whole-chat read; without the metadata token they keep the whole-chat read.

### Phone simulator viewer (contract revision 26, `mobile-simulators-v1`)

Aiden On The Go can watch and touch a simulator that runs on the paired Mac, for example one the desktop opened in the current chat. The phone draws the MJPEG stream natively and sends input over the helper socket; it never loads a WebView, so the pinned TLS trust applies to every byte.

- **Discovery and negotiation.** The server lists `mobile-simulators-v1` in `GET /server.features` for `iphone`, `ipad` and (since revision 31) `android` devices only, and only while this Mac has the simulator feature. The token says nothing about the owner's consent. A phone that sees it may send `POST /device/capabilities {accepts: ["simulators:mobile"]}`. Pairing never issues the grant, and negotiating it alone does not opt the phone into the progress vocabulary. A Mac older than revision 26 omits the token and refuses the negotiation with `400 invalid_request`.
- **Consent.** The serving owner turns on Share with Aiden On The Go in Settings → Simulator. It is off by default, needs simulator streaming, and is separate from Share with paired Macs: either may be on without the other. While it is off, `GET /simulators` returns `{sharing: false, status, devices: []}` to phones and every other phone route is `404 not_found`. Turning it off, revoking streaming, or revoking the phone closes the phone's open streams and sockets; paired Macs stay connected.
- **Scope.** Every `/simulators*` route accepts `simulators:control` on a desktop or `simulators:mobile` on a phone. A phone may call `GET /simulators`, `POST /simulators/open` (iOS Simulators only; any other platform is `403 capability_denied` because only iOS Simulators serve MJPEG) and `POST /simulators/shutdown`, which the phone confirms with the user first. Through the hub relay it may `GET` only `vendor/serve-sim/helper/{udid}/stream.mjpeg`, `.../config` and `.../health`, and upgrade only `vendor/serve-sim/helper/ws?device={udid}`. `POST /simulators/settings`, `POST /simulators/action`, the screenshot capture, the H.264 stream, the accessibility tree, the event log, the device list and its socket are `403 capability_denied` for phones, with the message in the fixture's `mobileSimulators.refusal`. The 8-relay cap per paired device applies to phones too.
- **Chat devices.** `GET /simulators?chatId=<chatId>` is the only accepted query. It needs `chat:read` and a chat the device can see (Bot chats keep the device's Bot audience; an invisible chat is `404 not_found`), and adds `chatDeviceIds`: the listed simulators the desktop attached to that chat. A chat-scoped listing never starts the Mac's hub, so a phone may make it when a chat opens; the plain listing may start an already-installed hub and is for explicit user actions. Phones also receive `toolVersions {hub, agent}`. Other platforms in the listing (for example `android` emulators, which stream H.264 only) appear with their `platform`, and phones show them as "Open on your Mac to view".
- **Stream and input.** The MJPEG body is `multipart/x-mixed-replace; boundary=frame`, each part `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n`. A client honours `Content-Length` (JPEG bytes may contain the boundary) and otherwise ends a part at the next boundary. Start the stream before the input socket: the helper accepts input only while capture runs. The socket carries `[tag][UTF-8 JSON]` packets: on open `0x0D {enabled: false}`; touch `0x03 {type: "begin"|"move"|"end", x, y}` normalized to the frame and remapped into raw portrait space for a rotated portrait-shaped frame; button `0x04 {button: "home"|"lock"|"app_switcher"}`; orientation `0x07 {orientation}` cycling `portrait`, `landscape_left`, `portrait_upside_down`, `landscape_right`. The helper answers with `0x82` screen configs `{width, height, orientation, …}`. The upgrade sends the bearer credential and protocol header and no `Origin`. The relay negotiates no WebSocket extension for phones and checks every phone frame: masked binary messages whose first byte is `0x03`, `0x04`, `0x07` or `0x0D`, their continuations, and ping, pong and close frames pass. Any other tag, a text or empty message, an unmasked frame, or set RSV bits closes the socket with `1008` (policy violation), and the offending frame never reaches the helper. The fixture's `mobileSimulators` section pins these vectors, and a desktop test checks them against the Simulator tab's own encoder.

### Phone run observation and control (contract revision 24, `phone-run-control-v1`)

Phones can follow and steer runs that started on the Mac, in Telegram or from the scheduler, using the revision-19 run routes above with a phone-scoped subset of their grants.

- **Discovery and negotiation.** The server lists `phone-run-control-v1` in `GET /server.features` for `iphone`, `ipad`, and since revision 31 `android` devices only, and only while it serves the host run registry. A phone that sees the token may send `POST /device/capabilities {accepts: ["runs:observe", "runs:control"]}`; when the phone's response opts into the support vocabulary, `serverCapabilities` lists the same pair. Pairing never issues these grants to a phone, and `host:events`, `run-streams-v1` and `run-control-v1` stay desktop-only. A Mac older than revision 24 omits the token, and a phone must then keep its own `/streams` behaviour; such a Mac refuses the negotiation with `403 capability_denied`.
- **Per-chat authorization.** A phone's run grants never widen what it may already do in a chat. Each run route also requires the phone's own grant for that chat: `chat:read` to observe, `chat:write` to cancel or send input, `approval:respond` for approvals and `questions:respond` for questions. Bot chats keep the phone's own Bot audience, so they also need `bot:read` to observe and `bot:write` to control. A missing grant is `403 capability_denied`, and an invisible chat is `404 not_found`, the same as on the phone's other routes.
- **Phone projection.** Run events carry the same text, status, `tool_started {toolId, name}` and `tool_finished {toolId, status}` rows as a phone's own stream; tool arguments and results never travel. `approval_required` reaches a phone as `{approvalId, summary, toolCallId, toolName, canAllow, scopes?}`, and gap-snapshot `approvals` use the same shape. It never carries `details` or `detailsOmitted`. `canAllow` follows the policy for the phone's own approvals: it is `false` when the approval carries host-only details (anything but a scheduled-task summary) or when its details were too large to send. `scopes` appears only when `canAllow` is `true`. Since revision 39, a phone holding `schedule:cards` and `schedule:read` also gets the display-only `schedule` card on scheduled-task approvals, live and in gap snapshots; it never changes `canAllow` (see "Scheduled-task approval cards, revision 39"). A phone may always deny; allowing a `canAllow: false` approval is `403 capability_denied` with no effect. Desktop approvals never expire, so run approvals carry no `expiresAt`; run questions carry it only when the host set one.
- **First responder wins.** A phone that loses a race receives the revision-19 `409 approval_resolved` or `409 question_already_resolved` envelope with the winning `decision` or `outcome` and `resolvedAt`. It shows that the prompt was answered elsewhere, for example "Answered on Mac". An attached phone also sees `approval_resolved` and `question_resolved` on the run stream when another surface answers first.
- **Revocation.** Revoking a phone closes its run streams, as it does for desktops; it never cancels the run.

### Pairing requests (contract revision 20, `pairing-requests-v1`)

A `mac` or `linux` desktop can ask a host to pair without a QR code or setup code. The person at the host compares a six-digit match code and chooses Allow or Deny. Allow issues exactly the credential and grants that `POST /pairing/exchange` gives a desktop that accepts Bot, progress and display-name negotiation (plus `host:events`, `runs:observe` and `runs:control` where the host serves them), sealed to the requester's X25519 key. Deny, expiry and cancellation issue nothing. Phones keep the QR and setup-code flow, which proves physical presence; nothing in this section changes `/pairing/exchange`, `/pairing/manual-bootstrap` or any phone-visible shape.

**Discovery and flag.** A requester holds no credential, so it learns support from `GET /health?detail=host` `pairingRequests`. That field is `true` only while the request service runs and the host's **Accept connection requests** setting (default on) is on. Plain `/health` is unchanged. Paired desktops also see `pairing-requests-v1` in `GET /server.features`. The routes arrived in revision 20: a revision-19 host carries `pairingRequests` in its descriptor but serves none of them, so a requester also requires the descriptor's `contractRevision` to be 20 or newer. A host built without the service answers every route below with `404 not_found`; clients treat that as "unsupported".

**Routes.** All four are unauthenticated: they take no bearer credential and no `Aiden-Protocol-Version` header, refuse any `Origin` header, and accept no query string. The poll secret travels only in the `Aiden-Pairing-Secret` header, never in a URL. It is compared as a SHA-256 digest in constant time, and a wrong or missing secret is indistinguishable from an unknown request (`404 not_found`).

- `POST /pairing/requests` with exact body `{deviceName, deviceType, publicKey, clientVersion?}` returns `201 {requestId, pollSecret, expiresAt, hostCommitment}`.
  - `deviceName`: 1–80 characters after trimming; control and bidirectional-override characters are rejected. It is the requester's unauthenticated claim and the host presents it as such.
  - `deviceType`: `mac` | `linux`. `iphone` and `ipad` get `403 capability_denied`; anything else is `400 invalid_request`.
  - `publicKey`: the requester's X25519 public key, 32 raw bytes as unpadded base64url.
  - `clientVersion`: up to 40 printable characters (default `unknown`).
  - `requestId` matches `^pairreq_[A-Za-z0-9_-]{32}$`; `pollSecret` and `hostCommitment` are 32 bytes of unpadded base64url. `expiresAt` is 120 s after creation.
- `POST /pairing/requests/{requestId}/reveal` with exact body `{requesterNonce}` (32 random bytes, unpadded base64url) returns `{hostNonce}`. It is one-shot: a second reveal is `409 pairing_already_used`, a reveal after expiry is `403 pairing_expired`, and a reveal of a denied or cancelled request is `403 pairing_closed`. The host shows its prompt only after this call; a request that is never revealed expires silently.
- `GET /pairing/requests/{requestId}` long-polls for at most 25 s and answers early on any state change. It returns `{requestId, state, expiresAt, envelope?}` where `state` is `pending` | `approved` | `denied` | `expired` | `cancelled`. Only `approved` carries `envelope`, and it always does. A new poll replaces an older one, which answers immediately. Terminal records are kept for 60 s and then answer `404 not_found`. While the record is kept, the envelope can be fetched again by the holder of the poll secret. An approved envelope that is never fetched before the record retires has its device revoked.
- `DELETE /pairing/requests/{requestId}` cancels and returns `{requestId, state}`. A denied, expired or cancelled request reports its state unchanged. A cancel that lands after the host committed an Allow revokes the new device and reports `cancelled`, whether or not the envelope was already fetched: only the requester can open it, so a requester that cancels after fetching it is withdrawing a pairing it could not confirm or save. A requester that installed the pairing does not cancel. The host acknowledges that cancel only after the revocation is recorded. If it cannot record it, it answers `500 internal_error` and the cancel can be retried; a withdrawn device that is still live is also revoked when its record retires.

**Admission and errors.** Every error uses the existing envelope and codes, so strict decoders need no new cases.

| Condition | Response |
| --- | --- |
| Setting off, Remote access stopped, or the transport identity is unavailable | `403 pairing_closed` |
| `iphone` / `ipad` requester | `403 capability_denied` |
| Malformed body, unknown field or unknown `deviceType` | `400 invalid_request` |
| More than 5 creates per source or 20 overall per minute; more than 8 open requests overall or 2 per source | `429 rate_limited`, `retryable: true`, `details.retryAfterSeconds` |
| Second reveal | `409 pairing_already_used` |
| Unknown or retired request, or a wrong or missing `Aiden-Pairing-Secret` | `404 not_found` |

The source is the socket's remote address; forwarded headers are never trusted, so every Tailscale request shares the loopback bucket. Turning the setting off, stopping Remote access or disabling it cancels every open request.

**Match code (commit/reveal).** Both screens show the same six digits only if they agree on the requester key, the host's TLS identity, the request and both nonces. Because the host commits to its nonce before it sees the requester's, an attacker in the middle cannot grind a colliding code: each attempt costs one visible host prompt and succeeds with probability 10⁻⁶.

```
hostCommitment = SHA-256("aiden-pairing-commit-v1" || 0x00 || requestId(ASCII) || hostNonce(32))
digest         = SHA-256("aiden-pairing-match-v1" || 0x00 || requesterPublicKey(32 raw)
                         || serverSpki(32 raw, decoded from "sha256/<base64>") || requestId(ASCII)
                         || requesterNonce(32) || hostNonce(32))
matchCode      = big-endian uint64(digest[0..8]) mod 1_000_000, zero-padded to 6 digits
```

The requester verifies `hostCommitment` against the revealed `hostNonce` and aborts on a mismatch. It computes the code with the SPKI it observed on its own TLS connection. Vectors live in the shared fixture under `pairingRequests.matchCodeVectors`, for example:

| requestId | requesterPublicKey | serverSpkiSha256 | requesterNonce | hostNonce | matchCode |
| --- | --- | --- | --- | --- | --- |
| `pairreq_AwgNEhccISYrMDU6P0RJTlNYXWJnbHF2` | `BwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSY` | `sha256/cXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5A=` | `09bZ3N_i5ejr7vH09_r9AAMGCQwPEhUYGx4hJCcqLTA` | `Q0xVXmdweYKLlJ2mr7jBytPc5e73AAkSGyQtNj9IUVo` | `483342` |
| `pairreq_NjtARUpPVFleY2htcnd8gYaLkJWan6Sp` | `fn-AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ0` | `sha256/Tk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG0=` | `jpGUl5qdoKOmqayvsrW4u77BxMfKzdDT1tnc3-Ll6Os` | `ZG12f4iRmqOstb7H0Nni6_T9Bg8YISozPEVOV2Bpcns` | `086098` |

The second vector shows the leading zero that clients must keep.

**Sealed grant envelope.** `envelope` is `{kind: "aiden-pairing-request-v1", protocolVersion: 1, requestId, expiresAt, hostPublicKey, salt, nonce, ciphertext, tag}`. Every binary member is unpadded base64url: `hostPublicKey` 32 bytes, `salt` 16, `nonce` 12, `tag` 16, and `ciphertext` at most 8,192 bytes.

```
shared = X25519(hostEphemeralPrivate, requesterPublicKey)      // an all-zero result is rejected
key    = HKDF-SHA256(ikm = shared, salt = salt, length = 32,
           info = "aiden-pairing-request-v1\n" + requestId + "\n" + requesterPublicKey + "\n" + hostPublicKey)
plain  = AES-256-GCM-Open(key, nonce, ciphertext, tag,
           aad = "aiden-pairing-request-v1\n" + requestId + "\n" + expiresAt)
```

Public keys in `info` are their base64url strings. The host uses a fresh ephemeral key for every envelope. The plaintext is UTF-8 JSON `{kind: "aiden-pairing-grant-v1", requestId, trust, exchange}`: `trust` is the QR payload's `PairingTrust` (`{mode: "private-ca", caCertificateDerBase64}` for LAN, `{mode: "system"}` for Tailscale), and `exchange` is a `PairingExchangeResponse`. The client must check that `requestId` matches, that `exchange.serverSpkiSha256` equals the SPKI it pinned on the connection, and, when it knows one, that `exchange.endpoint` is the endpoint it called. The desktop helper is `openPeerPairingRequestGrant(envelope, {requestId, publicKey, privateKey, serverSpkiSha256, endpoint?})` in `main/services/peer-pairing.ts`.

**Host behaviour.** The host persists the new device before it publishes the envelope; if sealing fails, or the request is cancelled or expires after commit, it revokes the device. Allow and Deny resolve exactly once: a decision on a request that is no longer pending reports the current state without acting. The host's system notification names the device but never shows the match code.

### Fork (contract revision 21, `chat-fork-v1`, `chat-fork-summary-v1`)

Fork creates a new regular chat in the same workspace from one message of an existing one. The source is never changed. Bot chats are not forked (`404 not_found`). A host that implements forking advertises `chat-fork-v1`; one that can also summarize the rest of the source advertises `chat-fork-summary-v1`. Without a feature its routes answer `404 not_found`.

- `POST /chats/{chatId}/fork` (`chat:write`; requires `If-Match` with the chat revision and an `Idempotency-Key`). The body is `{messageId, position, summary?}`:
  - `position: "after"` keeps everything through `messageId`, which must be a settled assistant reply.
  - `position: "before"` keeps everything before `messageId`, which must be a user prompt that is not the first. The response's `prefill` returns that prompt's text, and its attachments are restaged as this device's pending attachments for the fork. Each is valid like an uploaded one until its `expiresAt` and is consumed by the fork's next turn. Attachments that cannot be restaged are omitted.
  - `summary: {focus?}` (`chat-fork-summary-v1` only; `focus` is at most 1,000 characters) starts the fork with a pending summary of what followed the cut in the source.

  The `201` response is `{chat, prefill?}`, where `chat.forkedFrom` names the source. The errors are:
  - a stale revision returns `409 revision_conflict`;
  - an unknown message returns `404 not_found`;
  - an ineligible message returns `400 invalid_request`;
  - a busy source, or another copy already running, returns retryable `409 operation_in_progress`;
  - a copy that would be too large returns `413 payload_too_large`.

  A replay with the same key and body returns the first fork.
- **Summary lifecycle.** `forkedFrom.summary` is `{state: "pending" | "ready" | "failed", afterMessageId, focus?, text?, error?}`. `error` is one of Aiden's own failure messages; a provider's error text, and the files the summarized turns touched, stay on the Mac. Messages sent to the fork wait for a pending summary. A failed summary blocks new turns until it is retried or skipped. The fork's chat-summary row updates through the existing feeds as the state changes.
- `POST /chats/{chatId}/fork-summary/retry` and `POST /chats/{chatId}/fork-summary/skip` (`chat:write`, `chat-fork-summary-v1`) return the updated Chat:
  - retry asks for a failed summary again with the same focus;
  - skip drops the summary, which turns the chat into a plain fork.
- `POST /chats/{chatId}/fork-summary/cancel` (`chat:write`, `chat-fork-summary-v1`) stops a running summary, which then fails. It returns `{cancelled}`, which is `false` when nothing was running.

  For all three summary routes, a chat without a fork summary returns `404 not_found`, and a summary that has already moved on returns `409 revision_conflict`.

## 6. SSE envelope and ordering

Every SSE `id` is the decimal sequence. `data` decodes as:

```json
{
  "protocolVersion": 1,
  "streamId": "stream_opaque",
  "sequence": 12,
  "timestamp": "2026-08-18T19:00:00.000Z",
  "type": "text_delta",
  "terminal": false,
  "payload": { "text": "hello" }
}
```

Initial event types:

- `snapshot`: authoritative projected turn/chat state and next sequence.
- `status`: `queued`, `running`, `waiting_for_approval`, or `reconciling`.
- `text_delta`, `reasoning_delta`.
- `tool_started`, `tool_finished`: safe name/status/milestone only.
- `timeline`: renderer-safe generation milestone. Completed first-party `write_file`/`edit_file` steps may include `producedFile` (`relativePath`, `operation: written|edited`, `bytes`). This is host-confirmed historical provenance; it never grants file-read authority. Relative paths are bounded to 240 Unicode code points and reject absolute paths (including ASCII Windows drive prefixes), traversal, backslashes, control characters and empty segments. POSIX colon filenames are accepted. Spill handles and private output text are not projected into Activity or added to remote endpoints. Since contract revision 29, a completed `ask_user_question` step on a version 3 timeline may include a display-only `questionnaire` recap (`version: 1`, `outcome: answered|dismissed|expired`, and one to four items of `question`, `header`, `kind: option|multi|custom|skipped` and `answers`). `dismissed` and `expired` recaps hold only skipped items. Lengths count Unicode code points (question 1000, header 16, option and multi labels 60, custom text 1000), and strings are non-blank with no control characters other than tab and newline. Clients only render it; older clients ignore it. Since contract revision 38, a completed `web_fetch` step on a version 3 timeline may include a display-only `extraction` recap of the values an extract call read; see "Web page extract recap, revision 38".
- `approval_required`: approval ID, safe summary, deadline; no raw command/path/arguments.
- `question_required`: prompt ID, the bounded `questions` array, deadline. Emitted only to devices that negotiated `questions:respond`; older clients ignore it as an unknown nonterminal event.
- `done`: terminal persisted completion.
- `error`: terminal stable category and safe message.
- `cancelled`: terminal cancellation source.
- `heartbeat`: no semantic state change.

The `terminal` bit is required. Known `done`, `error`, and `cancelled` events set it to `true`; every other known event sets it to `false`. An unknown nonterminal event is ignored for forward compatibility only after its required bounded payload object and envelope safety fields validate. An unknown terminal event fails closed and triggers authoritative reconciliation. Individual SSE frames are limited to 1 MiB before JSON decoding. Ordinary parent-turn journal sequences are monotonically increasing and unique within a stream; replay validates the caller's expected stream identity and includes only events after the acknowledged sequence. Duplicate/lower sequences are ignored. A stream mismatch or gap triggers snapshot/status reconciliation; it never triggers turn creation. Terminal events are immutable. Expired ordinary journals return `stream_gone` with the chat ID needed for snapshot recovery.

Progress updates are complete authoritative projections, never deltas. Within one projection `epoch`, a client applies only updates whose `revision` exceeds the applied revision; an `epoch` change resets that comparison and forces adoption of the new snapshot. The progress sequence is process-local and has no durable continuity across reconnects, so clients reset sequence tracking on reconnect; a process restart also changes the projection epoch. A client joins progress through the chat-scoped reads (`GET /chats/{chatId}/tasks`, `GET /chats/{chatId}/agents`) and the dedicated `GET /chats/{chatId}/progress/events` channel, so it can observe desktop-started or other-device work. `task_update` and `agents_update` appear only on that chat-scoped channel, always use the chat ID as `streamId`, and are delivered only when the matching negotiated read grant is present. On disconnect the last applied projection is labelled last-known and never treated as success; on reconnect the client refetches both snapshots before trusting a live update. The `Last-Event-ID`/`after` values on this channel do not imply missing-change detection or replay; the fresh snapshots are authoritative.

When a stream reports `waiting_for_approval`, clients fetch its separate approval snapshot. This additive endpoint preserves the closed v1 stream-status contract while making reconnect authoritative. It returns approval, stream, and chat IDs; a safe summary; tool identity; expiry; and whether the mobile client may offer Allow. Exact privileged command, path, and external-mutation details remain host-only, so mobile renders those requests as deny-only. The snapshot becomes `null` as soon as the approval resolves, expires, is cancelled, or the stream terminates.

A pending `ask_user_question` prompt reuses the same `waiting_for_approval` stream status so the closed status vocabulary stays backward compatible. Capable clients distinguish the wait through the `question_required` event or the `GET /streams/{streamId}/question` snapshot; the snapshot is `null` as soon as the prompt resolves, expires, is cancelled, or the stream terminates, and resolution emits a `status` event returning the stream to `running` (or `reconciling` when the host declined settlement).

## 7. Idempotency, revisions, and operation ownership

- Create/start/run endpoints require `Idempotency-Key` (random client value, scoped to authenticated device + route + resource). The server durably stores only a bounded scope digest/request digest/state/safe-result record plus a non-secret stable operation reference; raw keys are never persisted. Fulfilled and safely classified rejected outcomes are replayable until expiry. In-flight entries never expire or evict into duplicate work and restore after restart as a fail-closed `idempotency_in_flight` state until the authoritative operation store finalizes that exact reference. Settlement starts the replay TTL; a long-running operation does not lose its replay window. Same key and same canonical request returns the original outcome; same key with different input returns `idempotency_conflict`. Capacity exhaustion fails closed rather than evicting any unexpired or in-flight record.
- Workspace, chat metadata, file, task, settings, and task pause/resume edits require server revision or content version. Stale mutation returns `revision_conflict` with current safe revision only.
- Turns and Git/file/schedule operations have stable owners independent of TCP. Revocation/shutdown/cancel policy is explicit per operation; socket close alone is never authority to mutate state.
- Approval response is idempotent by approval ID and decision. A conflicting second decision returns `approval_already_resolved`.

## 8. Limits and logging

The implementation must set explicit defaults and expose safe capability metadata for request bytes, JSON depth, attachment totals, active devices, streams, replay journal events/bytes/retention, browser pages/depth, file index bounds, text read/write bytes, diff bytes, schedule output bytes, rate limits, and timeouts. Ordinary JSON requests and JSON responses are limited to 1 MiB. A Chat contains at most 10,000 messages in addition to that byte ceiling. Attachment uploads have a dedicated 12 MiB JSON-envelope limit. Bot avatar uploads have a separate 6 MiB JSON-envelope limit.

Bot wire limits are: Bot ID 160 scalars; remote chat/revision/policy-epoch/cursor IDs 128; Chat title 1,024; provider/model IDs 256/512; name 80; purpose/access summary 280; opening greeting 2,000; instructions 32,000; conversation preview 500; at most 256 Bots, 20 favorites, and 50 conversations per page. Search is 200 scalars. The safe catalog permits at most 64 providers with 256 models each and 512 models total, 64 file scopes, 128 connections, 256 skills, and 128 other capability choices. File scopes use the explicit kinds `full_mac`, `bot_home`, and `approved_location`; Custom Full Mac access is never disguised as an approved folder. Opaque file-scope, connection, skill, and other-capability IDs reject slashes, backslashes, whitespace, percent-encoding, and other characters outside `[A-Za-z0-9._:-]`. A selected source raster is at most 4 MiB decoded, 4,096 pixels on either axis, and 16 million decoded pixels; its base64 field is at most 5,592,408 characters. The persisted and served canonical result is always a 512 × 512 PNG. Arrays use unique opaque IDs and reject duplicates.

Diagnostics may include only a closed route category, outcome or status class, bounded latency, and a stable Aiden-owned error code. Successful production traffic is reduced to daily aggregate counts. Durable records never include request IDs, instance/device suffixes, Authorization, pairing secrets, idempotency keys, opaque handles or capability selections, request/response bodies, search queries, Bot names/purpose/greetings/instructions/previews, managed-home or other paths, avatar bytes or temporary asset references, policy records, connection/skill/provider details, prompts, message text, attachment data, tool arguments/results, provider errors, Git output, schedule output, or App Group/Keychain contents.

## 9. Transport identity

LAN transport uses an installation-local P-256 CA and a server-only leaf with a stable P-256 key. The server presents the leaf plus CA chain; the QR payload carries the HTTPS endpoint and `sha256/<base64-leaf-SPKI-digest>`. Certificate renewal keeps the leaf key and pin. Key rotation is explicit, invalidates the old pin, and requires recovery/re-pairing. The iOS trust path anchors only the presented local CA, validates hostname, validity, certificate signature, server-auth usage, and the expected leaf SPKI digest; a matching pin alone must not accept an expired or wrong-host certificate.

When LAN access is enabled, discovery advertises `_aiden-agent._tcp` over Bonjour. The service label uses the bounded Mac display name plus a stable short suffix derived from the public instance identifier so same-named installations remain distinguishable. Its TXT record may expose only `v=1` and the full public Aiden instance identifier; the service port comes from Bonjour. Pairing secrets, device credentials, pins, paths, capability grants, and user content are never discovery metadata. The iOS app declares `_aiden-agent._tcp` in `NSBonjourServices` and provides `NSLocalNetworkUsageDescription`; disabling LAN access withdraws the advertisement.

Tailscale mode uses the server-owned loopback Aiden HTTP listener behind Tailscale Serve HTTPS plus the same Aiden device credential. Because `--set-path=/api/aiden/v1` strips that public mount prefix before reverse proxying, the target must restore the exact canonical base: `http://localhost:<port>/api/aiden/v1`, IPv4 loopback, or IPv6 loopback, with no credentials, additional path, query, or fragment. Before connect, inspect current config. An explicitly incompatible or Funnel-enabled HTTPS listener is a connect conflict. When Serve status is empty, first-connect eligibility comes from an exact normalized match between the node's stable DNS name and its Tailscale certificate domains; Aiden never completes Tailscale's HTTPS authorization flow for the user. Add one exact Aiden-owned non-Funnel route. Disconnect uses its matching route-specific `off`; never use Serve reset or replace unrelated configuration. A pre-acceptance origin-only target may be recognized solely for exact persisted-ownership cleanup before replacement with the canonical target; it is never accepted for a new connection.

### Operating multiple devices and Aiden installations

- One Aiden installation accepts multiple paired phones and iPads. Each device receives a distinct credential and has independent activity, streams, approvals, attachment references, scheduled-task operations, and revocation. Revoking one device must not interrupt or re-authorize another.
- Aiden On The Go stores each Mac as a separate installation keyed by its public `instanceId`. The display name is only a label, so same-named Macs remain distinct. Credentials, caches, navigation work, App Intents, and Live Activities stay scoped to that identifier during repeated switching and removal.
- Multiple fresh Aiden profiles on one physical Mac may use distinct persisted LAN/loopback port pairs. A profile with paired devices never moves its endpoint automatically; a collision is reported as `remote_port_in_use` with recovery guidance.
- Only one profile on a physical Mac may own the canonical Tailscale Serve path. A live incumbent cannot be taken over. A stale exact Aiden handler may be replaced only after an explicit review and immediate verification; unrelated Serve handlers and Funnel state remain unchanged.
- If the Tailscale CLI returns an ambiguous result or route visibility is delayed, Aiden records an unknown outcome before mutation and blocks ordinary route actions and pairing. Use **Verify update** in Remote Access after Tailscale settles. Verification either commits the exact route owner or proves the old state is unchanged; it never guesses or resets Serve.
- The desktop connection summary may show active, inactive, pending, and revoked device labels plus bounded activity times. It never includes bearer credentials, pairing secrets, certificate material, opaque handles, approved folder paths, prompts, or attachment contents.

When moving a phone between Macs, select the intended saved Mac before starting work. If a Mac is offline, the saved entry and its credential remain isolated and another installation can be selected. Removing a saved Mac from the phone deletes only that installation's local credential and caches; pairing again creates a new device credential. Removing or revoking a device from the Mac invalidates only that device. Removing an Aiden workspace does not delete its folder from disk.

## 10. Contract change process

Change this document, OpenAPI, TypeScript contract constants/types, shared fixtures, and Swift/TypeScript fixture tests in one phase. Additive changes increment `contractRevision`. Breaking changes require `/v2`. No handler may ship an undocumented route or field.


## Desktop-configured Read Aloud (`tts-v1`)

This additive feature is advertised by authenticated `GET /server`. It is separate
from `/speech` (Parakeet transcription). It uses the desktop's opt-in, voice,
model, reading policy and encrypted Google credential. There is no remote
settings, key, voice-management, preview or cache-clear endpoint. TODO: mobile
configuration is a future feature requiring its own reviewed authority contract.

- `GET /read-aloud`: read-only readiness (`enabled`, `ready`, `settingsRevision`,
  null `source`/`job`), requiring `chat:read`.
- `GET /chats/{chatId}/read-aloud`: readiness, latest main-issued source reference,
  and this device/chat session's current or retained job; requires chat read and
  retained Bot-chat authorization where applicable.
- `POST /chats/{chatId}/read-aloud`: explicit Play. The strict body is
  `{requestId, source: {chatId, messageId, sourceRevision}, settingsRevision}`.
  Requires `chat:write` and Bot write authorization when applicable. Canonical
  desktop text is resolved in main; arbitrary text is never accepted. Returns
  the job snapshot, not audio. POSTs are not automatically retried.
- `POST /chats/{chatId}/read-aloud/stop`: `{requestId}` cancels only that device's
  current matching playback intent. Earlier/later requests cannot stop each
  other. Stop-before-start is remembered so request reordering cannot rebill.
- `GET /chats/{chatId}/read-aloud/audio/{jobId}/{segment}/{offset}`: owner- and
  chat-authorized continuation reads. Returns `bytesBase64`, `mimeType`,
  `sampleRate`, `channels`, `segmentBytes`, `nextOffset`, `complete`. WAV is
  24 kHz mono; each read is at most 64 KiB, a segment at most 8 MiB, and the
  whole server session cache at most 32 MiB. No audio URLs or disk caches.

Each source is revalidated before generation dispatch and remote audio reads;
paired-device revocation and retained Bot authorization remain authoritative.
Remote playback cannot take over another owner's active playback slot. Native
clients release it after audible completion, Stop, navigation or backgrounding;
server inactivity also releases it after two minutes without requests. Server
transport restarts preserve request/soundbite identities; process/session
invalidation is a retention boundary. A revoked session cannot be revived.

Replay reuses a completed soundbite for the same canonical response and effective
speech settings, with no extra provider call or usage record. Stop preserves
completed bytes. Evicted, cleared, cancelled or possibly-billed failed identities
never silently regenerate. Clients poll bounded status, validate each continuation,
keep only a bounded segment in memory, and stop on stale source, access change,
interruption or microphone use. Settings on both clients show desktop setup guidance,
not an enable toggle. Existing native transcription controls are unchanged.


### Review hardening: accounting and bounded playback sessions

Every dispatched synthesis segment is recorded once in the desktop usage store
as `text-to-speech`, including failed/timed-out/cancelled in-flight requests.
Replay and preflight rejection do not add usage. Missing/incomplete token reports
remain unmetered and speech cost stays unavailable, never inferred as free.
Native usage totals disclose unknown hosted costs using existing coverage fields.

Unary synthesis accepts only the 24 kHz mono PCM16 WAV format consumed by all
three clients; raw L16 and incompatible WAV layouts fail before retention.
Native waiting uses a 120-second no-progress watchdog, reset when another segment
becomes ready, rather than imposing a 15-minute total-job limit.

Status and missing-audio reads do not allocate playback sessions. The active
session map is capped at 256; capacity pressure reclaims sessions idle for more
than two minutes, and revocation immediately releases its records/audio. Separate
bounded SHA-256 intent ledgers (16,384 entries each for sources, requests and
cancellations) preserve anti-rebilling protection across reclamation. A previously
accepted or uncertain source from a reclaimed session returns unavailable,
conservatively even if speech settings changed. Known unbilled preflight
rejections release their reservations, allowing a corrected request after
reclamation. Reservations are reference-counted: one rejected concurrent start
cannot erase another pending or accepted start's protection. Ledger exhaustion
fails closed for new intents; it never forgets a billed attempt merely to admit
another one.

## Custom provider creation, revision 22

`POST /providers` is available only when `/server.features` advertises `providers-create-v1`. It requires `workspace:manage`, `server:read`, `Idempotency-Key`, and explicit `confirmedForeground: true`. The request has `{label, baseUrl, kind, deployment, needsKey, apiKey?, models, confirmedForeground}`. Each of 1–32 unique model IDs declares `vision`, `reasoning`, and `toolCall`; optional positive `contextLength` and `outputLimit`, and nonnegative `maxImages` follow the desktop override rules. Models are manually entered; creating a provider makes no provider or catalog network request.

The optional API key is a write-only credential submitted over the existing pinned authenticated transport. It is bounded to 4096 characters, required for `needsKey: true`, forbidden otherwise, stored through the host's existing encrypted credential-rotation transaction, and never returned or logged. Endpoints follow the desktop HTTP(S) URL policy and cannot embed credentials, query strings, fragments, or metadata-service destinations. Loopback endpoints refer to the Mac, not the phone.

The response is `201 {id, label, models}`. The host derives a custom-only ID from authenticated device identity and creation key. A retry with the same key and connection recovers that receipt, including after restart, without altering its stored credential. A different connection under the same key is `409 idempotency_conflict`. To change a key or endpoint, use the desktop editor; this route cannot overwrite an existing provider. Native clients keep one key for a submitted draft, replace it only when the draft changes, and never automatically retry a mutation. Read-only devices and legacy hosts cannot create providers. Switching installations or revoking the device fences late UI results and host writes.

## Chat messages window metadata, revision 23

`GET /chats/{chatId}/messages` pages carry the chat's metadata only when `/server.features` advertises `chat-messages-window-metadata-v1` alongside `chat-messages-window-v1`. Every page then also has the fields a whole-chat read returns: `workspaceId`, optional `botId`, `title`, `titlePending` (only when `true`), `providerId`/`modelId` (both or neither), `createdAt` and `updatedAt`, held to the same rules as `GET /chats/{chatId}`. The page `revision` covers them as well as the messages. iOS and Android refresh an open transcript from the newest window only when the host advertises both tokens, so a desktop rename or model change reaches them without a whole-chat read; against a revision 19–22 host that has only `chat-messages-window-v1`, they keep reading whole chats.

## Inline visuals, revision 28

Aiden draws inline visuals in desktop replies: native visuals from its component catalog (`render_ui`) and sandboxed HTML visuals (`render_artifact`). A host that projects them advertises `chat-visuals-v1`. Each assistant message's `visuals` list names them in reply order, as described under "Chat/message" in section 4.

After a reply commits, the Mac renders each visual offscreen and stores the image as an ordinary PNG or JPEG attachment on the same message. Its `snapshotAttachmentId` appears once that attachment exists, which changes the chat `revision`, so clients that refetch on a revision change pick it up. Snapshot bytes are read through the existing attachment content route; nothing new is fetched.

Clients place each visual after the timeline tool step whose `toolCallId` matches, or at the end of the reply when no step matches. They show the snapshot image when one is named, otherwise `fallbackText`, otherwise the title alone, and never show snapshot attachments a second time in the attachment list. Older clients that ignore `visuals` see the snapshots as ordinary image attachments. Phase 3 projects no markup; interactive native rendering on phones is a later, opt-in revision.

## Bot chat activity, revision 30 (`bot-activity-v1`, provisional)

Revision 30 is provisional and is re-claimed at merge, after whatever `main` holds then.

Phones show what a Bot's running turn is doing ("Reading", "Running a command"), the person's own waiting messages, and the Bot's Chat activity choice. The Mac projects only a coarse phase: never a step, detail, path, command, query, argument or thinking text.

**Discovery and negotiation.** A host lists `bot-activity-v1` in `GET /server.features` only while the session `activity` and `queued` frames, `whenBusy`, and `chatActivity` on Bot detail and `PATCH` are all wired together. Older phones refuse unknown session keys and event types, so the token alone does not gate what the host sends. A device sends `POST /device/capabilities {accepts: ["bot:activity"]}` (offered in `serverCapabilities` to Bot-aware devices while the token is announced, like revision 27's `bot:cards`). The capability carries no authority and any device type may hold it; a host without the feature answers `404 not_found`. Pairing never issues it. A Mac older than revision 30 omits the token and refuses the negotiation, so phones keep today's behaviour and hide the Chat activity row.

**Session stream** (`GET /bots/{botId}/session` and `/session/events`, for devices holding `bot:activity`).
- The `snapshot` gains `activity`: `{ phase, app?, startedAt }` or `null`, and `queued`: a list.
- Two new events carry the same shapes: `activity` with payload `{ activity: {…} | null }` and `queued` with payload `{ queued: […] }`. Frames keep the one-seq-after-the-last rule and are published after `state`, then `queued`.
- `activity` has exactly the keys `phase`, `app` and `startedAt`. `phase` matches `^[a-z][a-z_]{0,31}$`; a client that does not know the id renders `working`. `app` is present only for the `app` phase, the connection's display label cut to 40 Unicode code points. `startedAt` is the Mac's clock in milliseconds since 1970, an integer from 0 to 2^53-1; clients show elapsed time after 20 seconds and hide it when their own clock reads behind the Mac's. It is when the run started, not when this stream or projector opened: a device that opens mid-run, or reconnects after the Mac closed an idle projector, gets the same `startedAt` as everyone else (a run already going when Aiden itself started is timed from when the Mac first saw it). The words and marks each phase maps to are pinned by the `botActivity.phases` fixture; the Mac's `renderer/shared/bot-activity.ts` is the source.
- `queued` lists the person's own waiting messages: `{ submissionId, mode: "steer" | "queue", text }`, at most 20, unique ids, text at most 32,000 code points. `steer` joins the running turn; `queue` runs after it. Routine and hidden inputs never appear, and a message that is only a photo has no text and is omitted. There is no remove route in this revision.
- **Byte caps.** Every frame is bounded on its own below the 1 MiB SSE frame limit: a `partial` or entry text is at most 100,000 code points (600,000 JSON bytes with every character escaped), a `question` at most four questions of five options (about 266 KB), a `queued` list at most 256 KiB, and an `approval` about 14 KB. A snapshot's serialized `session` is kept under the frame limit less a 64 KiB margin for the SSE lines and envelope, by allocating that budget in this order: (1) identity, `state`, `question`, `approval` and `activity` ship whole (at their maxima they take about 280 KB); (2) the `partial` ships whole, or, if it no longer fits, is cut from its front to its newest words, on a code-point boundary, which phones accept because a `partial` replaces the previous text wholesale and the next partial frame replaces it again; (3) `queued` takes at most 256 KiB and what is left, oldest first, and the first message that would overflow ends the list, so the rest are omitted and no text is ever cut (phones keep their own outbox copies); (4) the transcript window takes what is left, never more than 768 KiB, keeping the newest entries that fit, so it can be empty. When older entries are left out, `hasOlder` is `true`.
- A user `message` entry may carry `submissionId` (pattern `^[A-Za-z0-9._:-]{1,64}$`): the id the same message had in its send receipt and in `queued`, so a phone settles its optimistic bubble exactly. It is never on a routine input (an entry with `label`) or a question answer, and it is omitted when the Mac no longer knows the id. The tag stays on an entry while the entry is in the projected view.
- Stop and Resume reach the projection the same way as on the Mac: a phone Stop reads "Stopping" (and clears if the Stop fails), and a Resume reads "Picking up where it left off".
- **Non-holders.** A device without `bot:activity` receives a no-op `state` frame (the projector's current state view) at every seq an `activity` or `queued` frame would use, and no `activity`, `queued` or `submissionId` anywhere, so its decoder never sees a new key or event and its seq chain stays unbroken.

**Sending while busy.** `POST /bots/{botId}/messages` accepts the optional `whenBusy: "steer" | "queue"` on hosts announcing the token (the runtime maps `queue` to a follow-up). Without it the message queues, as before. A host that does not announce the token rejects the unknown field with `400 invalid_request`, so phones send it only to hosts that do. The receipt is unchanged, and carries the `submissionId` the entry and queued list later reuse. Idempotency is per key: replaying a request must send the same body, including `whenBusy`, or the host answers `409 idempotency_conflict`. A send, Resume, Dismiss or Stop that the Mac refuses from the Bot's state before doing anything (`409 operation_stale` for no model, a model that can't run right now, Bots held by another Aiden process or an interrupted turn waiting for Resume; and, since revision 37, a Bot the person paused, which is `409 bot_paused` for devices holding `bot:handoffs`) records nothing for its key, so the same key is evaluated again once the Bot is fixed. Any other outcome is recorded and replayed for that key.

**Chat activity setting.**
- `GET /bots/{botId}` detail gains `chatActivity: { level: "quiet" | "summary" | "detailed", wording: "follows" | "thinking" }` for devices holding `bot:activity`. A Bot that never chose has the default Quiet and Follows. Every route that returns a Bot detail (create, get, patch and avatar DELETE) strips the field for other devices; avatar PUT returns the asset metadata, not a detail.
- `PATCH /bots/{botId}` accepts `chatActivity` with exactly those two keys and known values, next to the other identity fields and under `If-Match`. An update that leaves it out keeps the stored value. It is rejected as an unknown field on hosts that do not announce the token. Choosing a level changes the Bot revision, so a phone's next identity edit may get `revision_conflict` and must refresh.

**Phone behaviour (not wire).** Phones apply every Bot action at once and reconcile later, keep unsent messages in a local per-Bot outbox for up to 24 hours (file-protected, excluded from backup, purged on unpair and access loss), and bound each Bot request to 12 seconds. Those are client rules recorded in `.memory/bot-chat-activity.md`; the host sees only ordinary idempotent requests.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds `botActivity` (sessions, frames, queued bounds, accepted and rejected samples, `phases`, Chat activity and detail samples) and `botActivityPrivacy` (a frame never carries a key outside the allow-list; `rejectedNullLiterals` pins that an optional key sent as the literal `null`, such as `app`, `queued` or `label`, is refused rather than read as absent). TypeScript, Swift and Kotlin decode them.

## Connection reliability, revision 31

`POST /pairing/exchange` accepts `android` alongside `iphone`, `ipad`, `mac`,
and `linux`. Android has the phone grant rules, including opt-in phone run
observation/control; it never receives desktop host-feed or simulator authority.
Persisted Android device records require a revision-31 or newer host; downgrading
requires revoking/re-pairing those devices.

Authenticated `GET /server` may advertise `peer-routes-v1` and `peerRoutes` only to
paired `mac`/`linux` devices. It is absent from phone responses, public health,
discovery records and pairing QR payloads. The array contains at most two HTTPS
routes, each with `endpoint` and `serverSpkiSha256`. LAN routes use a canonical
`.local` hostname and include the private `caCertificateDerBase64` (at most 8,192
characters); Tailscale routes use `.ts.net` and system certificate trust, with no
private CA. A LAN route may include up to eight RFC1918 IPv4 `addresses` as lookup
hints. These hints never replace the canonical TLS hostname.

Advertisements are partial observations, not an authoritative removal list. LAN
identity reads never wait for optional Tailscale discovery. One bounded refresh
updates a 30-second positive/negative cache. A previously validated observation
may remain available during refresh only under the same ownership/lifecycle key;
a failed refresh or changed key clears it. This observation does not promise current
reachability, and clients verify the route before use. Clients retain previously
validated omitted routes within their two-route bound; a new observation replaces
trust for the same endpoint. Explicit removal/suppression remains authoritative.
A connected LAN client with this feature, no known Tailscale route, and no suppressed
routes performs at most two authenticated follow-ups, after 25 and 100 seconds,
to collect deferred observations. The second is skipped once a Tailscale route is
known or routes are suppressed. The final delay covers the aggregate discovery
budget: three attempts with two sequential 15-second CLI reads each, two 75ms retry
pauses, and a 5-second TLS check (95.15 seconds). Each follow-up has its own 5-second
deadline. It retains its feed, cancels both timers when the connection changes,
and does not poll repeatedly while idle. Failed discovery may leave no alternate;
these bounded reads do not guarantee a route that becomes available later.

The existing authenticated, identity-verified channel delivers each alternate
route's trust material. A client verifies CA/system trust, hostname and SPKI before
sending credentials on that alternate route, then checks the authenticated
`instanceId` before accepting its projections. Verification and pooled connections
are scoped to endpoint, pin and CA revision. Credentials stay host-scoped in main;
route addresses, certificates and pins never enter renderer projections. A renewed
Tailscale pin may be replaced only after WebPKI verifies the exact saved hostname
and authenticated `/server` confirms the same installation.

A desktop persists learned routes and LAN hints in its encrypted host registry.
LAN is preferred; failed read-only connection establishment may try the next route.
A mutation is never replayed during failover. Revocation/authentication or protocol
failure stops the host; an invalid learned route does not block another trusted
route. A dead active route is exempt from preference cooldown. While using a
fallback, a better LAN route is preflighted at most once per 30 seconds; failed
preflights leave the working connection intact. Removed learned routes remain
suppressed across refresh/restart until the user restores them or re-pairs.

Unlock/network wakeups perform a bounded authenticated health check and retain
healthy feeds/run streams. A failure retires the connection and resumes existing
journal cursors on reconnect. Settings receives only route kind/origin/active
state, last synchronized time, and a sanitized failure category.

Progress SSE additionally accepts the optional `Aiden-Progress-Epoch` header
(the snapshot's bounded opaque epoch, `[A-Za-z0-9._:-]{1,64}`). The cursor is used
only for the matching projection lifetime. `Aiden-Progress-Resumed: true` confirms
that current retained state resumed; `false` means fresh snapshots follow. An epoch
mismatch cannot suppress new-host events with a coincidentally equal integer
sequence. Older clients without the header retain existing snapshot hydration.


Initial LAN discovery may publish a bounded canonical `.local` `hostname` TXT
hint beside `v` and `instance` for native clients whose DNS-SD API returns an IP
instead of the SRV target name. This hint is untrusted UI/connection discovery;
it carries no CA, pin, alternate-route inventory or credential. Pairing still
requires the owner-approved code/QR trust bootstrap and final TLS identity check.
Malformed or absent hints leave manual/QR pairing available.

## Conversation app controls, revision 32

`chat-ui-panels-v1` advertises inert assistant `appPanels` (up to four per message). Native clients render the closed Appearance, Memory, Web Search and Skills vocabulary. A panel carries its original opaque workspace ID and readable fallback, never a view script or authority. Malformed additive panels are omitted while ordinary text remains readable. Old clients without `app-controls:read` receive text fallbacks instead of interactive descriptors.

The desktop owner must explicitly allow **Paired-device chat controls** in Appearance. Only then does `/server` advertise `chat-ui-panels-enabled-v1`; capable clients may negotiate `app-controls:read` and `app-controls:respond` through the existing additive capability endpoint. Chat write access alone grants neither. Disabling owner consent blocks future reads/changes even when old grants remain on the device record.

`GET /chats/{chatId}/controls/{panelId}` requires `chat:read`, `app-controls:read`, current canonical chat access and owner consent. It returns bounded, current host-owned labels, options, values, revisions and disabled reasons. `POST` on that same path additionally requires `app-controls:respond` and the exact four-field `AppControlOperation` in OpenAPI. Memory writes retain the existing `workspace:manage` requirement. Bot panels and changed workspace targets are unavailable. Preferences always affect the paired host; phone appearance remains device-local.

The host persists an operation intent before entering its domain service and returns a verified receipt after persistence/effects. Repeating the same actor/target/operation ID returns its original receipt, including `outcome_unknown`; it cannot repeat an uncertain effect. A changed request under the same ID is rejected. Failed/offline clients do not queue writes. Re-read current state after a conflict or uncertain receipt. The revision represents the control's current value and policy, not an ordered event sequence. Confirmed receipts expire after 30 days; unresolved intents remain, and the ledger rejects new operations at 500 records instead of silently discarding replay protection.

## Bot message attachments, revision 33 (`bot-attachments-v1`, provisional)

A host announces `bot-attachments-v1` only while it stages phone uploads for Bots. A phone then attaches images and text files to a Bot message the same way it does in a workspace chat:

- `POST /bots/{botId}/attachments` takes the chat `AttachmentUpload` body (PNG or JPEG images, or the listed text types) and returns a single-use `AttachmentReference` that expires after ten minutes. It needs `bot:read`, `bot:write` and `chat:write`, like sending a message.
- `DELETE /bots/{botId}/attachments/{attachmentId}` drops an upload the person removed before sending. An unknown reference is already gone.
- `POST /bots/{botId}/messages` accepts `attachmentIds` (1–10 unique references). With them the text may be empty. The references are spent once inside the idempotency ledger, so a retried request replays its receipt without spending them again.

References are scoped to the uploading device and Bot: another device's send is `handle_wrong_device`, and a Bot reference can never be spent in a workspace chat (or a chat reference in a Bot). Images reach the Bot as image input, exactly as the desktop Bot chat sends them; text files follow the words as `name:` and their contents. A host without the feature refuses `attachmentIds` as `invalid_request` and answers the upload routes with `not_found`.

## Phone visual viewer, revision 35 (`chat-visual-viewer-v1`, provisional)

A host announces `chat-visual-viewer-v1` when it ships the viewer bundle (`npm run build:visual-viewer`, part of `npm run build`). Phones keep the inline snapshot and open a visual full screen on tap:

- `GET /chats/{chatId}/visuals/{visualId}/document?scheme=light|dark&theme=<preset>` needs `chat:read` and read access to the chat. `visualId` is any id the chat projection lists in a message's `visuals`; anything else is `not_found`. Both query keys are optional (`light`, `aiden`); a preset id the host does not know falls back to `aiden`, and a malformed value or any other key is `invalid_request`.
- The body is one self-contained `text/html` document of at most 12 MiB: the viewer page, its payload, and for an HTML visual the sandboxed guest with only the host libraries its source names (Chart.js, Plotly, KaTeX) inlined. It loads nothing from the network. Responses are `no-store`, carry a strong ETag (`If-None-Match` gets 304) and are gzip-compressed when the client accepts it.
- Native hosts load it with no base URL, deny every other navigation and window, and turn off file access and persistent storage. The page talks to them only through iOS `window.webkit.messageHandlers.aidenVisual` or Android `window.AidenVisualBridge`, with `{"type":"ready"}`, `{"type":"prompt","text":…}` (at most 2,000 characters, one per 3 s) and `{"type":"openUrl","url":"https://…"}`. A prompt is never sent by itself: the phone shows its own confirmation and only adds the text to the composer. A link opens only after the phone asks.
- Visual entries are unchanged, so older phones keep showing snapshots. Phones may cache a document per host, chat, visual, scheme and theme and show it while the Mac is unreachable.

## Bot hand-offs and pause, revision 37 (`bot:handoffs`)

The host keeps the revision in one constant (`AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION`). Revision 40 (provisional; re-claimed at merge after whatever `main` holds then, in `AIDEN_REMOTE_BOT_HANDOFF_NOTE_CONTRACT_REVISION`) adds `takesNote` to the card, below, behind its own opt-in, `bot:handoff-notes`. Revision 37 shipped in v0.61.0, whose closed card decoder refuses a key it does not know, so the host sends `takesNote` only to a device that holds both `bot:handoffs` and `bot:handoff-notes`; every other holder gets the revision 37 card, and the password-or-code rule still refuses a note sent with its answer. A host lists `bot:handoff-notes` in `serverCapabilities` exactly when it lists `bot:handoffs`, and changing what a device holds changes its session streams only when they next open. Revision 43 (provisional, in `AIDEN_REMOTE_BOT_HANDOFF_ON_MAC_CONTRACT_REVISION`) adds `onMac` the same way, behind `bot:handoff-on-mac`: a Bot may hand over a step in its own browser or on its own computer (the `hand_off` tool's `where`, or a rule that stopped its browser or computer tool), and such a card never carries `open` for any device, because the page is the Bot's, not the person's.

A Bot can hand a step back to the person ("Your turn: Enter the 2FA code your bank sent you"), and the person can pause a Bot. Phones that opt in answer hand-offs and pause or unpause a Bot; other devices keep their revision-35 view.

**Negotiation.** The host lists `bot:handoffs` in `serverCapabilities` to Bot-aware devices while the hand-off bridge, the Mac opener and the pause routes are all wired; there is no `/server` feature token. A device sends `POST /device/capabilities {accepts: ["bot:handoffs"]}` in its **own** call, after any other negotiation, so a host that refuses it (`404 not_found` from a host without the routes, `400 invalid_request` from a host older than revision 37, which does not know the capability) never costs the device its other grants. Any device type may hold it; pairing never issues it.

**Before revision 37, and for every device without `bot:handoffs`.**
- A Bot the person paused reads as `unavailable` (`interrupted: false`); the snapshot keeps its transcript. Messages, Resume and Dismiss for it return `409 operation_stale`. Bot summaries and details carry `sessionState: "unavailable"` and no `paused`.
- A waiting hand-off is the newest entry of the snapshot: an assistant `message` with id `handoff-notice:<waitId>` and text `<Bot name> needs you on your Mac: <action>`, without `createdAt`. On the stream it arrives as an `entry` frame at the seq a holder's `handoff` frame uses. When the hand-off settles (answered, skipped or withdrawn) or another takes its place, that seq is a `snapshot` of the session as a fresh read shows it: no stream frame removes an entry, and a `snapshot` replaces a client's whole transcript, so the old line goes and a replacement's line is the newest entry again. The person must answer it on the Mac.
- On a host that does not serve `bot-durable-session-v1` (the CLI host until durable Bot sessions are enabled), `POST /chats/{chatId}/turns` on a paused Bot's chat is `409 operation_stale` for every device, also when the pause lands while the turn is being admitted. It records nothing, so the same `Idempotency-Key` runs once the Bot is unpaused. A Mac serving durable sessions answers `400 invalid_request` to every Bot-chat turn, paused or not (see "Bots, Bot conversations, access, and avatars"). A turn already streaming in a Bot's chat when the Bot pauses is stopped where it is: its run ends `cancelled` and keeps the partial answer. Both a Mac and the CLI host record `cancellationOrigin: "user_stop"` on it, as for Stop. A CLI host with durable Bot sessions pauses them as a Mac does, and, since it doesn't serve `bot:handoffs`, every device sees the paused Bot as `unavailable`. It doesn't give Bot-chat turns the Mac's `400` answer: a turn for a paused Bot is `409 operation_stale`, and one for any other Bot is `500 internal_error`.
- A pause or unpause made on the Mac, from a phone, or with `aiden bots pause` on a CLI host reaches every open session stream at once as a `state` frame, at the same seq for every device. A pause reads `unavailable` to these devices and `paused` to holders.

**Session stream, for devices holding `bot:handoffs`.**
- `state` may be `paused` (`interrupted: false`). `interrupted` still means a turn that stopped part-way and waits for Resume or Dismiss; a Bot can be paused with such a turn, and reads `interrupted` again after unpause.
- The snapshot always carries `handoff`: `{ waitId, kind: "action" | "sign_in", action, why?, open?: { url }, takesNote?, onMac? }` or `null`. Since revision 43, `onMac` is present, and `true`, only on an `action` card without `open` whose step is on the Bot's own browser or computer, and only for a device that holds `bot:handoff-on-mac`; clients decode a missing `onMac` as `false`, and refuse any other value or combination. Since revision 40, `takesNote` is present, and `false`, only on a card whose answer may carry no note (one the Bot's password-or-code rule opened), and only for a device that holds `bot:handoff-notes`. Clients decode a missing `takesNote` as `true`, and refuse any other value. `action` is at most 160 characters, `why` at most 400, and `open.url` an https URL without credentials, at most 2,048 characters. The host sends `open.url` as the WHATWG URL parser prints it (lowercase scheme and host, default port dropped, punycode host, percent-encoded path), so a client with a stricter check reads the same page the Mac would open; a bare origin keeps its form, and a page whose printed form is not a valid `open.url` is sent without `open`. At most one hand-off waits per Bot.
- A `handoff` frame with payload `{ handoff: {…} | null }` is published after `approval` when the waiting hand-off changes.
- Answering a hand-off puts the person's side in the transcript for **every** device: a user `message` reading `You did this: <action>`, `You skipped this: <action>` or `You signed in to <host>`, followed by a blank line and the person's note when they wrote one.

**Routes.** Each needs `bot:read`, `bot:write` and `bot:handoffs` (`403 capability_denied` otherwise; `404 not_found` on a host without them) and an `Idempotency-Key` matching `^[\x21-\x7e]{16,128}$`. A repeat with the same key replays the first result. A refusal (`409 handoff_expired`, `400 invalid_request`) records nothing for its key, so a repeat is checked again and gets the answer that is true then. The Bot session's question answers (`POST /bots/{botId}/questions/{waitId}/answer`) and approval answers (`POST /approvals/{id}/respond`) treat their refusals (`409 question_expired`, `403 capability_denied`, `400 invalid_request` and the like) the same way.
- `POST /bots/{botId}/handoffs/{waitId}/answer` with `{ outcome: "done" | "skipped", note? }` (a note is not blank and at most 4,000 characters) returns `{ waitId }`. A hand-off that is no longer waiting is `409 handoff_expired`. A malformed answer, and `done` on a `sign_in` hand-off (signing in happens on the Mac, in the Bot's browser or on the Bot's own computer), are `400 invalid_request`. So is any note with the answer to a hand-off the Bot's password-or-code rule opened: that card takes no note, so a password or code typed as one never reaches the Bot. Since revision 40 the card says so with `takesNote: false`, and clients hold their composer for it rather than send a note; a note sent anyway still gets the `400`, and the hand-off keeps waiting for Done or Skip.
- `POST /bots/{botId}/handoffs/{waitId}/open-on-mac` with `{}` brings the hand-off forward on the Mac (the Bot's chat, and for a sign-in, or since revision 43 a step on the Bot's own screen, the Bot's own browser when it has one, or the Bot's own computer, taken over for the person, when the card names it) and returns `{ waitId, opened }`. A hand-off that is no longer waiting is `409 handoff_expired`.
- `POST /bots/{botId}/pause` with `{}` pauses the Bot and returns the session state (`paused`). A running turn is closed and left interrupted; its question, hand-off and approval are withdrawn and asked again after unpause and Resume. Pausing a paused Bot keeps the first pause.
- `DELETE /bots/{botId}/pause`, without a body, clears the pause and returns the session state.
- While a Bot is paused, a message, Resume or Dismiss from a holder is `409 bot_paused`, which records nothing for its key.
- The routines that came due while the Bot was paused are listed on the Mac after unpause (the `routines_skipped` entry); this revision sends that entry to no device.

**Bot summaries and detail.** See "Bot" in section 4: holders get `paused` and `sessionState: "paused"`. The host feed follows the same split: a paired desktop holding `bot:handoffs` gets holder rows in its snapshot and `bot.upsert` events, so its sidebar can show a paused Bot as paused, and any other desktop gets the revision-35 rows. A change both audiences read alike is one event; a pause or resume is one event for each audience.

**Clients.** Aiden On The Go for iOS and Android, and a Mac opening a paired Mac's Bot, ask for `bot:handoffs` only when the host lists it in `serverCapabilities`, in a `POST /device/capabilities` call of its own after their other negotiations (with `bot:handoff-notes` and `bot:handoff-on-mac` in the same call when the host lists them too; a device that already holds `bot:handoffs` asks for the missing ones alone once its host offers them; a Mac asks for each in a call of its own), and treat a `400` or `404` as a host that does not offer it (the pairing keeps its other grants). The phones keep the grant only once the refreshed `/server` lists it; a Mac keeps the grants named in the host's `/device/capabilities` answer, and one whose call answers `401` counts the offer as unanswered and asks again on its next connection. Because the host fixes a session stream's audience when the stream opens, a Bot chat opened while the device is still negotiating reopens its stream once the grants it holds change, so a hand-off card, cards and activity reach it without leaving the chat. Holders show the waiting hand-off as a "Your turn: <action>" card beside the question and approval cards. An `action` card offers Done, Skip and Open (for its `open.url`), and a note typed into the composer is sent as Done with that note, under the same conditions as the card's own Done (on iOS, only while connected). For a card with `takesNote: false` (revision 40) the composer holds instead, reading "Enter it yourself, then tap Done." on the phones and naming why on a Mac, and Done and Skip answer it without a note. With photos or files staged, Send keeps the draft and says to send them after answering the card. A card a rule opened for a step in the Bot's own browser carries no `open`: its page is the Bot's tab on the Mac, and the device's browser would act on the person's own session. A `sign_in` card offers Finish on your Mac (`open-on-mac`) and Skip, and never sends `done`; a Mac titles it "Sign in to <host> for <Bot>". An `action` card with `onMac: true` (revision 43) offers Finish on your Mac, Skip and Done, and reads "This step is on the Bot’s own screen on your Mac." on the phones; `open-on-mac` then focuses the Bot's chat on the Mac and opens its browser tab (or its computer) there. On the Mac that hosts the Bot, the same card offers "Open in <Bot>’s browser" or "Open <Bot>’s computer" instead of a link to the person's own browser. Every answer is sent under one Idempotency-Key per answer (its wait id, outcome and note), which is reused while the outcome is unknown, and a `409 handoff_expired` removes the card. A Mac shows the card, and a question or approval it answered, again when Resume asks the same wait id again; while its answer to the card is on its way, its composer sends no second answer. Pause Bot and Resume Bot (the phone's Bot profile menu, the desktop chat's ••• menu) use `POST` and `DELETE /bots/{botId}/pause`. A paused chat shows Resume and holds the composer. A phone enables Resume only while it may change Bots and is connected; a Mac whenever no pause or unpause of its own is on its way, also while the stream reconnects. No client shows a pause or an unpause before the host confirms it. Tapping a hand-off alert on a host serving durable sessions opens the Bot's chat where the card waits. Phones read a paused Bot's list row as "Paused" and an interrupted one as "Interrupted — tap to resume", and post one local notification when a hand-off arrives for a Bot chat that is open but not on screen. Clients decode a missing `paused` as `false` and do not write it back.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds `botHandoffs`: a session waiting on a hand-off, its frames, the answer, open-on-Mac, pause and unpause shapes, paused session, summary, detail and refusal, and the same moments as a device without `bot:handoffs` sees them (`legacy`). The desktop parser reads the section only when `contractRevision` is 37 or newer.

## Image placement, revision 44

The host keeps the revision in one constant (`AIDEN_REMOTE_IMAGE_PLACEMENT_CONTRACT_REVISION`). Revision 44 is provisional: it is re-claimed as the next free revision when the change merges.

An assistant message's image attachment may carry `toolCallId`, the public `call-N` id (`^call-[1-9][0-9]*$`) of the timeline tool step that produced it: `display_image`, `share_image` or `generate_image`. It is display-only and needs no capability. User attachments and text attachments never carry it.

- The host sends the placement it stored with the reply. For a reply saved before every image recorded its call, it pairs unplaced images with their completed calls in order, per source: `shared_` ids with `share_image` calls and other images with `display_image` calls. A source pairs only when its images and calls match one for one, and shown images are not paired while any `generate_image` call has no placed image; an unpaired image gets no `toolCallId`.
- An image whose `toolCallId` names no step on the message's projected timeline, or that has none, trails the reply as before.

**Clients.** The desktop transcript draws each placed image after the activity row that holds its step. Aiden On The Go for iOS and Android split a run of same-offset steps there instead, as they already do for visuals, so the image sits right beneath its own step line. Every client keeps only unplaced images in the strip after the reply. A malformed `toolCallId`, or one of the wrong type, is dropped without dropping the image. Older clients ignore the key. Images still reach phones only when the reply is saved, not while it streams; while it streams, the phones draw a running `generate_image` call's placeholder beneath its step, split the same way, so the image takes the placeholder's spot. With revision 44 the phones' arrival reveal plays on the image a `generate_image` call produced, found by its `toolCallId`.

## Web page extract recap, revision 38

The host keeps the revision in one constant (`AIDEN_REMOTE_WEB_EXTRACT_CONTRACT_REVISION`).

When the agent reads a page with `web_fetch` in extract mode, the completed step on a version 3 timeline may carry `extraction`, so every client can show each value next to the page line it came from. It is display-only. It never holds the page, the request, a credential or the model's raw answer, and it grants nothing.

- `extraction` is `{ version: 1, host, cut, error?, fields }`. Only a `tool` step with `toolName: "web_fetch"` and `status: "completed"` may carry it, and version 1 and 2 timelines never do.
- `host` is the page's host, at most 253 characters. `cut` is `true` when only the first part of the page was read.
- `error` is one of `setup`, `auth`, `quota`, `timeout`, `unavailable` or `invalid-response`. It means extraction failed and the agent got the page text instead. A recap with `error` has no fields; one without it has one to sixteen.
- Each field is `{ name, status, value?, confidence?, sourceLine?, notFound? }`. `name` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and is unique within the recap.
  - `extracted`: typed, confident and found on the page. `value`, `confidence` and `sourceLine` are all present.
  - `uncertain`: a guess, never a value read from the page. `value` is the guess, and `sourceLine` is present only when the guess appears on the page. `notFound: true` marks a guess that appears nowhere on the page.
  - `null`: the page has no value. No other keys.
- `value` is a display form of at most 200 characters (scripts get the whole value from the tool result, not from the timeline). `sourceLine` is the matched page line, or a window of it with ellipses, at most 200 characters. `confidence` is between 0 and 1.
- `host`, `value` and `sourceLine` are single-line strings: non-empty, counted in Unicode code points, with no control characters and no whitespace other than single U+0020 spaces, and none at either end.

**Clients.** The desktop transcript, Aiden On The Go for iOS and Android show the recap as a card under the step's activity line. Each field shows its name as words (`pro_monthly` reads "pro monthly"), then its value. A guess carries a "Guess" label, and a `null` field reads "Not on the page". The page line is quoted under the value, or "Not found on the page" for a `notFound` guess. A failed recap says why and that the page was read instead, and `cut` adds "Only the first part of the page was read." Clients drop a malformed or misplaced recap and keep the step. Older clients ignore `extraction`.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds a `web_fetch` step on the timeline event with one extracted, one uncertain (`notFound`) and one `null` field.

## Scheduled-task approval cards, revision 39 (`schedule:cards`)

The host keeps it in one constant (`AIDEN_REMOTE_SCHEDULE_CARDS_CONTRACT_REVISION`).

A scheduled-task approval reaches a phone as a one-line `summary`. With this opt-in it also carries `schedule`: the facts a person decides on, so the phone can show a structured card (what runs, when, where, with what access and model) instead of the summary text.

**Negotiation.** The host lists `schedule:cards` in `serverCapabilities` (to devices that accept the Bot or progress vocabulary) while it serves stream approvals or run approvals; there is no `/server` feature token. A device sends `POST /device/capabilities {accepts: ["schedule:cards"]}` in its **own** call, after any other negotiation, so a host that refuses it (`404 not_found` from a host without approvals wired, `400 invalid_request` from a host older than revision 39, which does not know the capability) never costs the device its other grants. Any device type may hold it; pairing never issues it.

**Where it travels.** The card is added only for a device holding both `schedule:cards` and `schedule:read`, because it carries the task's instructions or script:

- `GET /streams/{streamId}/approval`, on the pending approval.
- A phone's run `approval_required` payload and the `approvals` of a run gap snapshot (`phone-run-control-v1`).

Paired desktops get the full run projection with `details` and never get the card. Only `schedule_task` approvals whose host-side details pass validation get one, whether an ordinary chat proposes the task or the Assistant proposes a new one (sent as `action: create`, `enabled: true`); `edit_automation` approvals and every other tool keep the summary alone.

**Rules.**

- It never changes `canAllow` or `scopes`: a device without `schedule:write` still gets `canAllow: false` with the card shown.
- It is never part of `details`, so a phone's approval keeps the summary-only shape the phone may allow.
- Clients that cannot validate the card drop it and show the summary card. An invalid card never fails the approval.

**Shape.** Exact keys, no ids, no cron syntax:

| Key | Notes |
| --- | --- |
| `action` | `create` \| `update` \| `pause` \| `resume` \| `remove` \| `run_now` |
| `name` | 1–120 characters |
| `cadence` | 1–200 characters of human cadence, such as "Weekdays at 9:00 AM", with the zone in parentheses when it differs from the host's own; "Custom schedule" when the host cannot describe it |
| `timezone` | IANA zone, 1–128 characters |
| `nextRunAt` | Optional RFC 3339 UTC (`Z`) date-time, present only while the task will run on its own once approved: enabled (as `enabled` says), scheduling on, not being removed |
| `mode` | `llm` \| `script` |
| `permission` | `read-only` \| `full` |
| `workspaceName` | Optional project name, 1–120 characters |
| `connectors` | Connector (MCP server) display names, at most 16, each 1–120 characters; empty for a project task |
| `providerName`, `modelName` | Optional, `llm` only; 1–120 and 1–256 characters |
| `notify`, `enabled`, `schedulerEnabled` | Booleans. `enabled` is the task's state once the approval goes through, so a `resume` card is `true` and a `pause` card is `false`; `enabled: false` on any other action is a task saved or run while paused. `schedulerEnabled: false` means scheduling is off on the host, so the task will not run automatically |
| `prompt` / `script` | Optional, at most 2,000 characters, line breaks allowed; `prompt` only in `llm` mode, `script` only in `script` mode |
| `truncated` | Optional `true` when the `prompt` or `script` was shortened to fit; only with one of them |

Every text value is trimmed, non-empty and free of control and bidirectional-override characters (only `prompt` and `script` may hold line breaks). The host cuts long instructions at a character boundary.

**Clients.** Aiden On The Go for iOS and Android ask for `schedule:cards` only when the host lists it in `serverCapabilities`, in a call of their own, and treat a `400` or `404` as a host that does not offer it. They title the card by its action ("Save this scheduled task?"), then show the name, cadence and next run, rows for where the task runs, its access (Full access on a warning fill), model or script, notifications and time zone, the instructions or script (with "Shortened to fit. The full text is on your computer." when `truncated`), and a note when scheduling is off or the task stays paused. Cancel and Approve task are unchanged, and without a valid card they show the summary card.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds `scheduleCards`: the capability, a stream approval with a card, phone run events where only the scheduled-task approval carries a card, valid cards (project read-only, full access with connectors, scheduling off, a paused edit, a shortened prompt) and rejected cards. The desktop parser reads the section only when `contractRevision` is 39 or newer.

## Composer context pressure, revision 41 (`chat-context-pressure-v1`, provisional)

The host keeps the revision in one constant (`AIDEN_REMOTE_CHAT_CONTEXT_PRESSURE_CONTRACT_REVISION`); it is provisional and is re-claimed at merge after whatever `main` holds then. A Mac viewing a chat that runs on a paired Mac shows the same composer context meter a local chat shows, from the host's own next-request projection (the one behind its `chats:contextPressure` meter, which also decides when the host compacts). Nothing is re-estimated on the viewing Mac.

- `GET /chats/{chatId}/context` prices the next request with the chat's own model. `GET /chats/{chatId}/context?providerId=...&modelId=...` prices it with a model the device picked but has not sent with yet; the pair must be one the host has configured (as `GET /models` lists it), or the answer is `400 invalid_request`. Either id alone, a repeated or unknown key, or an id over 256 characters is also `400 invalid_request`. An id may hold only letters, digits and `._~:@/!$()*,;-`, sent literally or percent-encoded (see "Request query encoding" below); clients do not send a pair outside that set and show no meter for it.
- Requires `chat:read`. A Bot chat needs `bot:read` and passes the retained Bot-chat check like every other chat read, and is then refused with `404 not_found`: Bot chats have no composer meter on a paired Mac. A host without the projection wired answers `404 not_found` and does not announce the feature.
- The answer is `{ chatId, pressure }`. `pressure` is `null` when the host cannot project the chat now (it has no model, or its history cannot be opened), and the client then shows no meter. Otherwise it holds exactly `contextTokens`, `contextWindow` (at least 1), `inputBudgetTokens`, `reservedTokens`, `percentOfWindow`, `percentOfUsableInput`, `messageTokens`, `staticTokens` and `computedAt` (epoch milliseconds), each a finite number from 0 to 2^53 − 1, plus `shouldCompact` (boolean) and `source` (`provider-anchored` | `estimated`). The schema is closed. The host's per-category `breakdown`, its prompt cache window, provider-anchor detail, tool and MCP server names, paths, prompt text and the device's unsent draft never cross the wire.
- `chat-context-pressure-v1` is announced to `mac` and `linux` devices only, so it never counts against the phones' 32-token feature budget. Phones do not use the route.

**Cost and cadence.** Each read runs the host's projection once: it reads the chat's Pi journal (cached for 1.5 s) and, for a chat that has not generated in this process, assembles the ambient system prompt and tool list (cached per chat until its workspace, model window or instructions change). Clients read it when the chat opens, when a run settles, and when the composer's model choice changes, not on a timer.

**Clients.** A Mac derives the `contextPressure` adapter capability from the feature and its `chat:read` grant, sends the `contextPressure` peer operation, and validates the answer against this schema in main before the renderer sees it. iOS and Android ignore the token.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds `chatContextPressure`, and its `contractRevision` is 41.

### Request query encoding (revision 41)

Before revision 41 the host refused any request URL containing `%`, so a query value that needed percent-encoding (a Bot inbox search with a space, an accent or `&`, or Android's encoded `since` timestamp) failed with `400 invalid_request`, whichever client sent it. From revision 41:

- **Paths** still refuse `%`. Path segments are never percent-decoded, so an encoded segment cannot hide a traversal or a second route.
- **Query strings** may carry `%XX` escapes. Every `%` must start a two-digit hex escape, the escapes must decode as UTF-8, and the decoded query must hold no ASCII control character; anything else is `400 invalid_request`. Values are read as `URLSearchParams` reads them: `+` is a space, then escapes decode. Routes whose ids have a fixed character set still validate the decoded value against it.
- **Clients** (desktop, iOS, Android) send a space as `+`, which every host already decoded, and leave the separators ids, dates and cursors use (`: @ / $ , ; =`; iOS also keeps `! ( ) ~ ? '` and Android `! ( ) ~`, as their URL stacks did before) as they are. They percent-encode only what cannot travel literally (`& + # %`, accents, emoji). A query that worked against an older host still has no `%`; a search that needs an escape works only against a revision 41 host.
- No feature token: a client cannot tell, and does not need to. Against an older host a search that needs an escape is refused as before.

## Bot issues on phones, revision 42 (`bot:issues`)

The host keeps it in one constant (`AIDEN_REMOTE_BOT_ISSUES_CONTRACT_REVISION`).

A Bot's host code raises a **Bot issue** when the person is needed and no tool call is waiting: a routine failed or was paused after repeated failures, a pre-flight check found a sign-in or access problem, or a run stopped making progress. The desktop's Bot chat shows one card per issue, writing `aiden.bot-issue` and `aiden.bot-issue-status` entries into the durable conversation. Phones receive the same cards as a session field, not as transcript entries, because the shipped phones decode a closed set of entry types and session keys. The Bot's own model never raises an issue.

**Negotiation.** The host lists `bot:issues` in `serverCapabilities` to Bot-aware devices while the issue service is wired; there is no `/server` feature token. A device sends `POST /device/capabilities {accepts: ["bot:issues"]}` in its **own** call, so a host that refuses it (`404 not_found` from a host without the issue route, `400 invalid_request` from a host older than revision 42, which does not know the capability) never costs the device its other grants. Any device type may hold it; pairing never issues it. Like `bot:cards` it grants no authority: every session read still needs `bot:read` and `chat:read`, and the act route needs `bot:read`, `bot:write` and the Idempotency-Key.

**Card shape.** `BotSession.issues` is present only for a holder, oldest first, and at most 20 cards (the host keeps at most 8 open and 50 settled; older ones fall off). Each card is exactly `{ id, kind, title, body, routineId?, actions, createdAt, resolved }`:

| Key | Notes |
| --- | --- |
| `id` | Opaque issue id, `^[A-Za-z0-9._:-]{1,160}$` |
| `kind` | `preflight_failed` \| `routine_failed` \| `routine_paused` \| `run_stalled` |
| `title` | 1–80 characters, one line |
| `body` | 0–280 characters, may carry a line break |
| `routineId` | Optional: the routine the card asks about |
| `actions` | At most two, in card order, the last one primary. Each is exactly `{ kind, routineId? }` with `kind` one of `open_chat` \| `resume_routine` \| `stop_run` \| `keep_waiting`; `routineId` is present exactly on `resume_routine` |
| `createdAt` | RFC 3339 UTC date-time |
| `resolved` | `true` on a settled card; a settled card carries no actions |

`open_settings` is the desktop's own surface (the Bot's Advanced page or the app's Providers settings) and never crosses the wire. A card that offered only that arrives with `actions: []`, and clients read it as "Open on your Mac". A card that offers no action a phone may take keeps its title and body.

**Stream.** The host folds the issue list into the projector like queued messages: a `session` frame (`payload` `{ session }`) carries it on a fresh read, and an `issues` frame with payload `{ issues }` replaces the list when a card is raised, settled or superseded. Both travel only to a device holding `bot:issues`; every other device gets a `state` frame at that seq instead, so its sequence still advances. Because the host fixes a stream's audience when the stream opens, a device that negotiates `bot:issues` after opening a Bot chat reopens the stream once its grants change, as it does for the other Bot opt-ins.

**Route.** `POST /bots/{botId}/issues/{issueId}/act` with `{ action: { kind, routineId? } }` returns `200 { result: "done" | "not_open" }`. The action must be one the card itself offers:

- `done`: the host carried the action out. `resume_routine`, `stop_run` and `keep_waiting` settle the card; `open_chat` only opens the Bot's chat on the Mac and leaves the card open.
- `not_open`: nothing is open under that issue id (it was answered, settled, superseded or the Bot was deleted). The card should be removed.

An unknown or malformed `action` is `400 invalid_request`. An action the card never offered is `409 operation_stale` ("This card changed. Refresh it before trying again."). A repeat with the same `Idempotency-Key` replays the first receipt and never runs the host action twice; a refusal records nothing for its key, so a retry after a refresh is evaluated again.

**Notifications.** For a holder, the routine notification feed (`GET /bots/routine-notifications?since=`) also carries issue items: `{ id, kind: "issue", botId, botName, routineName, finishedAt, preview }`, where `routineName` is the card's title and `preview` is its body (redacted, at most 160 characters). A routine result keeps its revision-27 shape and never carries `kind`; its `routineId` and `status` stay required there and are absent on an issue item. Devices without `bot:issues` receive routine results only, so their decoders see the fields they always did.

**Fixtures.** `protocol/aiden-remote/v1/fixtures/contract.json` holds `botIssues`: the capability, a session carrying an open card with actions, an open card with no phone action, and a settled card, the `issues` frame that settles one, the act request and receipt, the `not_open` receipt, a summary with `issueCount`, and a phone-feed issue item. The desktop parser reads the section only when `contractRevision` is 41 or newer.
