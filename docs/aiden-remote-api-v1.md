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

`GET /health` is the only unauthenticated read. `POST /pairing/manual-bootstrap` returns only a bounded AES-GCM sealed trust envelope while a local desktop pairing window is open; the locally displayed setup code is never sent in its request. `POST /pairing/exchange` is available only during that same window and requires its single-use 256-bit secret. Every other request, including SSE, requires:

```http
Authorization: Bearer <device credential>
Aiden-Protocol-Version: 1
```

The desktop stores only a slow/strong digest of the credential plus device metadata. Revocation closes streams and rejects later requests. Credentials are installation-specific and must never be accepted by a different Aiden instance.

Server support and authenticated-device grants are separate authorities. Pairing and `GET /server` use `capabilities` for the exact grants held by that device. A Bot-aware device additionally receives `serverCapabilities`, the server-supported inventory, only after pairing with `acceptsBotCapabilities: true`. `bot:write` is invalid without `bot:read` in every grant or support projection. Bot eligibility requires `bot:read` in both values. A missing `serverCapabilities` field is an ambiguous legacy projection and fails closed for Bots; it is never interpreted as a Bot grant.

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

`details` is optional and endpoint-allowlisted. It never contains paths, credentials, request bodies, raw provider errors, raw Git output, or stack traces.

Required stable codes include:

- `invalid_request`, `payload_too_large`, `rate_limited`
- `authentication_required`, `credential_revoked`, `capability_denied`
- `pairing_closed`, `pairing_expired`, `pairing_already_used`, `server_identity_changed`
- `not_found`, `already_exists`, `revision_conflict`, `idempotency_conflict`, `idempotency_capacity`, `idempotency_in_flight`
- `bot_archived`, `workspace_unavailable`, `workspace_changing`, `permission_confirmation_required`
- `handle_invalid`, `handle_expired`, `handle_wrong_device`, `root_policy_changed`, `filesystem_identity_changed`, `path_outside_root`, `handle_capacity`
- `turn_already_active`, `stream_gone`, `approval_already_resolved`, `approval_expired`
- `operation_in_progress`, `operation_stale`, `git_capability_denied`
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

Allowed: IDs, workspace ID, optional Bot ID when the authenticated device has `bot:read`, visible title/provider/model selections, an optional `titlePending: true` hint while first-turn background naming is active, visible user/assistant messages, bounded attachments, safe parent reasoning/tool/timeline milestones, timestamps, and the parent turn's terminal provider-failure category. A Chat response carries `providerId` and `modelId` together or omits both; a partial pair is invalid.

Subagents remain a Mac-local implementation detail of the parent Pi turn. When the parent uses subagents, iOS and Android receive only the ordinary parent messages, parent timeline and outcome, and parent stream state. They never receive child/subagent IDs or counts, private histories, lifecycle snapshots, child controls, or child-specific endpoints. A child result may affect the parent's eventual visible reply through the normal parent runtime, but it is never projected as a separately addressable mobile object.

Within its documented 200,000-Unicode-scalar bound, visible parent `message.text` is opaque transcript data and is preserved exactly. Privacy filtering applies to DTO fields and metadata, not to the appearance of visible text: Unicode, path-like text, URLs, UUIDs, base64- or hexadecimal-looking strings, and credential-shaped text are not rewritten, encoded, or replaced with a redaction marker. This does not authorize separate credential metadata; credentials, authorization headers, provider/MCP secrets, and API-key fields remain forbidden outside the visible transcript.

Forbidden: Pi journals, raw diagnostics, raw tool arguments/results not already safe for renderer display, every child/subagent projection described above, hidden/system prompts, credentials or authorization headers outside visible parent message text, provider/MCP headers and API keys, filesystem/skill metadata, owned asset filenames, temporary asset URLs, and filesystem internals.

### Bot

Allowed: opaque Bot ID, bounded name and purpose, optional opening greeting, editable guidance in authenticated detail only, semantic avatar recipe, canonical raster metadata, safe health state, archive/timestamps/revision, favorite membership/order, bounded conversation previews, a plain-language access summary, and an optional audience-safe provider/model selection in authenticated detail. Capability catalogs expose only bounded labels, availability, and opaque selection IDs using the conservative `[A-Za-z0-9._:-]` grammar. A Custom policy or chat reduction exposes only the positive opaque selections needed to render and edit it.

Response discriminants are coherent and fail closed: `health: archived` requires `archivedAt`, while every other health state forbids it; Full Bot access and inherited chat access forbid a Custom selection, while Custom access requires one; a pending notice forbids acceptance metadata, while an acknowledged notice requires both acceptance timestamp and decision. Clients tolerate harmless additive response display fields after recursively rejecting private wire keys, but never reinterpret unknown fields as authority.

That recursive response check is context-aware. In Chat and Bot projections, clients normalize an additive field name by removing hyphens, underscores, periods, and whitespace and lowercasing it, then reject credential/secret/API-key/token, header, endpoint/path, prompt, instruction/greeting, tool argument/result, and reasoning variants enumerated by `x-aiden-context-private-response-fields`. Only the documented top-level `BotDetail.instructions` and `BotDetail.openingGreeting` properties are exceptions; similarly named additive or nested fields remain private and fail closed.

Bot summaries never include instructions or opening greetings. Bot conversation pages never include reasoning, tool arguments/results, paths, attachment bytes, provider errors, or private journals. Raster metadata never includes an internal filename or path.

Forbidden: managed-home/workspace paths, provider/MCP credentials or headers, endpoint URLs, environment values, resolved MCP bindings or fingerprints, skill paths/content, internal capability leases/epochs beyond the opaque public policy epoch, asset filenames, Image Playground temporary URLs, and unbounded prompt/message content.

### File

Allowed: opaque file handle, safe workspace-relative display path/name, kind, bounded size/language metadata, version, truncation/warning state, text content for a selected readable document.

Forbidden: canonical/absolute path, symlink target, inode/device, recovery path, arbitrary binary bytes.

### Git

Allowed: safe review/diff/comparison fields, branch display names, counts, push capability/reason, managed-worktree display state, operation ID/status.

Forbidden: absolute paths, Git admin path, ownership token, device/inode, raw command line/stdout/stderr, credential-bearing remote URL, private refs not present in the desktop projection.

### Scheduled task

Allowed: task ID/revision, safe name/description, workspace/provider/model IDs, schedule/timezone, mode/permission, selected MCP IDs, notification preference, validated script ID/display name, enabled/running state, next/previous dates, bounded redacted run result.

Forbidden: provider fingerprint, resolved MCP bindings, chat ID, credentials, process environment, raw script path, unredacted stdout/stderr, internal cancellation handles.

### Speech

Allowed: the fixed local transcription engine identifier and readiness, a bounded allowlisted model catalog with installed/downloading state and progress, one model setup or removal command, and a final bounded transcript. Audio input is exact base64 PCM16: mono, signed 16-bit little-endian, 16 kHz, and no longer than 60 seconds.

Forbidden: server filesystem paths, arbitrary model URLs or archive names, provider credentials, partial recognition events, retained recordings, raw decoder diagnostics, or transcripts above the response bound.

## 5. Endpoint inventory

The OpenAPI document owns exact request/response shapes. This section owns behavior.

### Bootstrap/device

- The locally displayed QR encodes the OpenAPI `PairingPayload` envelope as canonical JSON. Its `PairingBootstrap` contains protocol version, instance ID, HTTPS API endpoint, P-256 SPKI SHA-256 fingerprint, high-entropy single-use secret, and expiry; its trust member selects the bundled private LAN CA or system trust for Tailscale. The phone must decode and validate the complete envelope, configure hostname plus SPKI verification, and only then exchange the secret. A fingerprint learned from `/pairing/exchange` is confirmation, never the trust bootstrap.
- `POST /pairing/manual-bootstrap`: returns that exact canonical `PairingPayload` encrypted with AES-256-GCM. A uniformly random 100-bit Crockford Base32 setup code is shown only through local Electron IPC and derives the encryption key with HKDF-SHA256. The client sends `{}` to the selected exact endpoint, validates the bounded response, derives and authenticates the envelope locally, requires the decrypted endpoint and expiry to match, and then uses the normal pinned `/pairing/exchange`. The setup code never appears in a URL, request, log, persistent state, Bonjour record, or public status projection. LAN users select a discovered Mac; Tailscale users provide its canonical private endpoint. QR and manual entry share one window and one synchronously consumed exchange secret.
- `GET /health`: minimal readiness and protocol version.
- `POST /pairing/exchange`: exchange a high-entropy single-use secret for device/instance IDs, bearer credential, exact device capability grants, endpoint, and P-256 SPKI SHA-256 fingerprint. A client may set `acceptsDisplayName: true` to receive the optional bounded server display name; the server omits that additive key for strict legacy v1 decoders. A client must separately set `acceptsBotCapabilities: true` before the Mac may issue `bot:read` or `bot:write`. Absence or `false` preserves the complete legacy grant vocabulary and never upgrades an existing device. The display name is presentation metadata only and newer clients still verify `instanceId` as identity.
- `GET /server`: authenticated server projection. Its required `capabilities` array is the authenticated device's exact grants. The additive `deviceName` field is the presentation-only label currently stored for the calling device, allowing newer clients to refresh a stale generic label without writing on every connection. `serverCapabilities` is emitted only when the paired device persistently opted into the Bot capability vocabulary with `acceptsBotCapabilities: true`; it contains the server-supported inventory independently of the device's grants. A Bot-aware device without `bot:read` may therefore learn that its Mac supports Bots but still cannot infer any Bot identity or chat. A legacy device that happens to contain a later grant never receives the additive field unless it negotiated the vocabulary.
- `PATCH /device/identity`: authenticated device-label refresh with exact body `{ "name": string }`. It requires `server:read`, updates only the calling credential's bounded display label, and returns the normalized label. The label is presentation metadata—not an authentication or cross-Mac identity key. Older Macs may omit this additive route, so clients treat an unavailable refresh as non-fatal.

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

Location handles are random high-entropy nonces stored as digests and bound to instance/device/root/policy/canonical internal location/filesystem identity/expiry/depth. Cursors additionally bind the parent handle and ordering snapshot. Handle stores prune expired/consumed records, enforce a hard entry ceiling, and fail closed at capacity. Listings are deterministic, paginated, rate limited, directory-only, and nonrecursive.

Selection nonces are a separate type. Workspace creation atomically revalidates real path, directory type, root boundary, policy revision, filesystem identity, and duplicate state, then consumes the nonce once inside one synchronous storage transaction. Async mutation callbacks are prohibited; an escaped promise fails closed with the nonce consumed. Reuse or browse-to-register replacement fails closed. Selected-folder workspaces default to `ask`.

### Chats, turns, streams, approvals

- `GET|POST /chats`
- `GET|PATCH|DELETE /chats/{chatId}`
- `POST /chats/{chatId}/move`: empty chat only.
- `GET /models`: configured provider/model projection without credentials.
- `GET /usage?range=7d|30d|90d|1y|all`: aggregate request, token, activity, and estimated-cost totals from the Mac's device-local usage store. Requires `server:read`; never returns content, chat/workspace identifiers, paths, raw usage records, or credentials.
- `POST /chats/{chatId}/turns`: atomic append/admit/start, idempotent by client key.
- `POST /chats/{chatId}/attachments`: validate and stage one bounded image or UTF-8 text attachment.
- `DELETE /chats/{chatId}/attachments/{attachmentId}`: discard an unused staged attachment.
- `GET /chats/{chatId}/attachments/{attachmentId}/content`: return one authenticated, chat-scoped canonical PNG or JPEG for preview.
- `GET /streams/{streamId}`
- `GET /streams/{streamId}/events`: SSE replay via `Last-Event-ID` or `after`.
- `POST /streams/{streamId}/cancel`: request cancellation of the authenticated parent turn stream. This is not a child/subtree control endpoint; any internal child shutdown is a Mac-owned consequence of cancelling the parent and is never separately addressable by mobile.
- `POST /approvals/{approvalId}/respond`: `allow` or `deny` only. Allowing a
  `schedule_task` or `edit_automation` approval additionally requires the
  authenticated device's `schedule:write` grant. A device that can respond to
  approvals but lacks that mutation grant still receives the bounded approval
  with `canAllow: false` and may deny it; an attempted allow fails closed.
- `GET /streams/{streamId}/approval`: current bounded approval snapshot, or `null` after resolution.

Turn start returns `turnId`, `streamId`, accepted state, and canonical appended message. The generation owner is the authenticated device/stream, not a socket. Disconnect never resends the prompt or cancels the turn. Restart during an active remote turn records one explicit interrupted terminal state and never retries the provider call.

The ordinary `GET /chats` Workspace projection is regular-chat only, and ordinary `POST /chats` rejects `botId`. Every direct read that resolves a Bot-classified chat—including its attachment content, stream, and approval snapshot—requires both its existing route grant and `bot:read`. Every mutation, turn, attachment write, stream cancellation, or approval response for a Bot chat additionally requires `bot:write`. Missing Bot authority returns the same unavailable/expired classification as an unknown scoped resource so a legacy device cannot infer Bot identity from a retained chat, stream, attachment, or approval identifier.

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

Mobile-triggered setup may download only the fixed release URL compiled into Aiden. The Mac enforces an 800 MiB compressed-archive download ceiling, extracts into a staging directory, requires the complete model manifest, then publishes the model. Callers cannot provide a URL or destination. Download, extraction, and recognition failures return only stable sanitized errors. A separate extracted-byte/file-count ceiling remains required before treating hostile-archive expansion as fully mitigated.

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
- `POST /bots/{botId}/chats`: open-or-create the Bot's one persistent chat. The frozen v1 response remains `201` and the operation identifier remains `createBotChat` for compatibility with shipped clients, even when the existing chat is returned. When it already exists, the Mac returns it unchanged and ignores creation-only provider/model input. When absent, an empty body inherits the Bot provider/model; otherwise one exact providerId/modelId pair is required, plus `Idempotency-Key`. Partial pairs never fall back. The creation pair must be currently available; an unavailable selection fails closed without fallback. The Mac injects the authoritative `botId` and hidden managed-home workspace; neither identifier is accepted in the body, and every successful response includes that authoritative `botId`. Concurrent calls and retries converge on the same chat. Legacy duplicate chats remain readable for recovery, but only the deterministic canonical chat is writable or projected in the Bot inbox.
- `GET /bot-capabilities`: safe revisioned provider/model, image-input capability, file-scope, shell, connection/MCP, skill, and other-capability catalog plus the full notice status. `supportsImages` is explicit and unknown capability fails closed. The response never returns display copy that the client could mistake for authority.
- `PATCH /bots/{botId}/capabilities`: `If-Match` Full/Custom update with the exact current `catalogRevision`. Full requires `confirmedForeground: true` and may carry one exact provider/model pair; omitting both preserves the saved choice for compatibility with older clients, while supplying only one is invalid. Custom contains exactly one currently available provider/model pair plus only exact positive opaque selections from that catalog. Optional `visionModel` uses three-state semantics: omitted preserves the companion, `null` clears it, and an exact provider/model object sets it only when the catalog marks that model image-capable. A supplied pair becomes revisioned durable authority, changing either primary or companion fences active turns, and the canonical persistent chat mirrors only the primary model. An unavailable model remains visibly blocked and is never replaced by fallback.
- `GET /chats/{chatId}/capabilities` and `PATCH /chats/{chatId}/capabilities`: authenticated authoritative inherit/Custom view, then an `If-Match` update carrying both the exact `catalogRevision` and `expectedBotPolicyRevision`. The server rejects policy drift or any selection outside the current Bot ceiling and returns the authoritative chat subset view.
- `GET /bot-access-notice`: Mac-owned acknowledgement status for this paired device. This v1 client recognizes only `bot-full-access-v1`; an unknown future version fails closed until matching copy ships. `POST /bot-access-notice/acknowledgement` accepts only that exact version, `continue_full` or `customize_first`, `confirmedForeground: true`, and an `Idempotency-Key`. Local dismissal never acknowledges it.
- `GET /bot-conversations/{chatId}/files` and `GET|PUT /bot-conversations/{chatId}/files/{fileId}`: reuse `FileIndex`/`FileDocument` and expected-version writes, but authorize every operation against the device grant, authoritative Bot/chat binding, current Bot policy, chat reduction, policy epoch, and managed-home identity. Ordinary Workspace file routes reject hidden Bot homes even if their opaque workspace ID is learned.
- `PUT /bots/{botId}/avatar`: one exact bounded PNG/JPEG source envelope under `If-Match` and `Idempotency-Key`; the Mac validates it, independently decodes it, and stores a canonical 512 × 512 PNG before returning canonical metadata. Before the first raster photo, `If-Match` is the Bot detail revision; afterward it is the current public `assetRevision`, so simultaneous photo edits conflict even though the semantic identity is unchanged. `DELETE /bots/{botId}/avatar` uses that same rule and returns the Bot to its semantic fallback.
- `GET /bots/{botId}/avatar/{assetRevision}`: authenticated canonical 512 × 512 PNG only, with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Bot ID and asset revision must match the current main-owned record.

An authorized archived Bot remains readable but read-only until restored: list/detail, conversation/history, existing attachment and managed-home file reads, access views, and the current canonical avatar remain available. Chat open-or-create, new turns, uploads, writes, approval effects, identity/access/avatar mutations, and attempts to add the archived Bot to favorites return `bot_archived`; restore remains allowed. Archiving atomically removes favorite membership. Bot reads without `bot:read`, mutations without the full conjunctive grant, cross-Bot/chat references, corrupt bindings, unavailable records, and unknown IDs retain the same non-inferential unavailable classification. Catalog or policy revision drift returns `revision_conflict` with only the current safe revision; invalid/removed opaque selections fail closed and never fall back to Full. Authoritative Custom views may retain selected catalog tombstones marked `available: false` so drift is visible, but new mutations may select only entries currently marked available.

### Attachments

Uploads produce random, short-lived, single-use references bound to the authenticated device and exact chat. References expire after 10 minutes, are removed on device revocation, and are consumed atomically by a turn. A turn accepts at most 10 distinct references. The server retains at most 20 staged references per device/chat, 40 per device, 256 globally, and 64 MiB of staged representation data; capacity exhaustion fails closed.

Image uploads accept only PNG or JPEG, at most 8 MiB decoded, at most 16,384 pixels on either axis, and at most 40 million decoded pixels. Text uploads accept only the documented plain-text/source MIME allowlist, at most 100,000 Unicode scalars and 400,000 UTF-8 bytes. Display names are bounded to 255 Unicode scalars and reject separators and control characters. Upload envelopes never accept a local or server path. Chat and message responses project attachment ID, display name, MIME type, kind, and size only; inline bytes and text are never returned. A client may fetch a projected raster by its opaque attachment ID through the authenticated content route. The server re-resolves it inside the requested chat, fails closed on duplicate IDs or mismatched size/MIME/signature, and returns only bounded canonical image bytes with `no-store` and `nosniff` headers. Text and filesystem content are never exposed through that route.

At turn admission the Mac computes the image route from main-owned Bot authority. A vision-capable primary receives pixels natively. A text-only primary may use only its explicitly saved companion through the built-in `inspect_image` tool; the tool accepts generation-scoped attachment aliases, performs one bounded tool-free model call, and returns text to the primary. Without either route, admission fails before staged uploads are consumed. Neither the client nor the primary model can supply arbitrary paths, URLs, provider credentials, or chat identifiers to image inspection, and Aiden never silently falls back to another provider.

Assistant message history also carries a closed exceptional outcome when a stored generation failed or was cancelled. Failure metadata is restricted to Aiden's fixed provider category, bounded attempt count, and retry-exhausted flag; provider-authored errors and diagnostics remain forbidden. Completed messages omit this field. This makes terminal state durable across SSE disconnects and app restarts without exposing the private generation journal.

### Files and Git

- `GET /workspaces/{workspaceId}/files`: one recursive snapshot with maximum 4,000 entries and depth 20 plus `truncated`.
- `GET|PUT /workspaces/{workspaceId}/files/{fileId}`: opaque file handle; write requires `expectedVersion`.
- Git review/diff/compare/comparison-diff/branches/checkout/create-branch/commit/push-capability/push/worktrees/create-worktree/delete-managed-worktree under `/workspaces/{workspaceId}/git/...`.

File handles are separate from browser handles and bind instance/device/workspace/canonical root identity/relative file identity/index snapshot/expiry. Read/write re-resolves within the canonical root. Writes retain Aiden's atomic replacement and expected-version conflict behavior. There is no file create/rename/delete in v1.

Git mutations reuse the workspace operation registry and mutation gate plus canonical common-directory serialization. Commit/push remain repository-root-only; nested workspaces expose a read/diff-only reason. Consequential actions carry an explicit foreground-confirmation field and return stable operation/snapshot IDs. Disconnect does not abandon an operation owner. There is no fetch, pull, stage/unstage, discard, generic Git, or terminal endpoint.

### Scheduled tasks

- `GET|POST /scheduled-tasks`
- `GET|PATCH|DELETE /scheduled-tasks/{taskId}`
- `POST /scheduled-tasks/{taskId}/pause|resume|run`
- `GET /scheduled-tasks/{taskId}/runs`
- `POST /scheduled-tasks/preview`
- `GET /scheduled-tasks/scripts?workspaceId=...`
- `GET|PATCH /scheduled-tasks/settings`

Edits and task actions (`pause`, `resume`, and `run`) use `If-Match`/`expectedUpdatedAt`; settings use an equivalent revision. `run` also requires an idempotency key and returns `202` with a durable `runId`. Older clients that omit `If-Match` fail closed with `400` and must refresh before starting a run. Reusing one run key with a different revision returns `409 idempotency_conflict`, allowing clients to discard the stale key instead of retrying an ambiguous operation. Socket loss does not cancel execution. Status is observed in run history. Cancellation follows existing remove/pause/global-disable/revocation/shutdown policy; v1 adds no bespoke remote cancel action.

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
- `timeline`: renderer-safe generation milestone.
- `approval_required`: approval ID, safe summary, deadline; no raw command/path/arguments.
- `done`: terminal persisted completion.
- `error`: terminal stable category and safe message.
- `cancelled`: terminal cancellation source.
- `heartbeat`: no semantic state change.

The `terminal` bit is required. Known `done`, `error`, and `cancelled` events set it to `true`; every other known event sets it to `false`. An unknown nonterminal event is ignored for forward compatibility only after its required bounded payload object and envelope safety fields validate. An unknown terminal event fails closed and triggers authoritative reconciliation. Individual SSE frames are limited to 1 MiB before JSON decoding. Sequences are monotonically increasing and unique within a stream. Replay validates the caller's expected stream identity and includes only events after the acknowledged sequence. Duplicate/lower sequences are ignored. A stream mismatch or gap triggers snapshot/status reconciliation; it never triggers turn creation. Terminal events are immutable. Expired journals return `stream_gone` with the chat ID needed for snapshot recovery.

When a stream reports `waiting_for_approval`, clients fetch its separate approval snapshot. This additive endpoint preserves the closed v1 stream-status contract while making reconnect authoritative. It returns approval, stream, and chat IDs; a safe summary; tool identity; expiry; and whether the mobile client may offer Allow. Exact privileged command, path, and external-mutation details remain host-only, so mobile renders those requests as deny-only. The snapshot becomes `null` as soon as the approval resolves, expires, is cancelled, or the stream terminates.

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
