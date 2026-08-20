# Aiden Remote API v1

Status: Phase 0 normative contract
Base path: `/api/aiden/v1`
Transport: HTTPS REST plus resumable Server-Sent Events
Schema: `protocol/aiden-remote/v1/openapi.json`
Fixtures: `protocol/aiden-remote/v1/fixtures/contract.json`

## 1. Contract rules

This is Aiden's native remote protocol. It is not Hermes WebUI compatibility. Aiden Agent remains the execution, persistence, permission, filesystem, and provider authority. The remote transport adapts authenticated commands to shared main-process application services; it never calls Electron IPC handlers or impersonates a `WebContents` owner.

The URL major version changes only for an incompatible wire break. Additive fields are forward compatible only where the schema marks an envelope extensible; new capability-gated endpoints/events do not require a new major version. Clients must ignore unknown fields on the extensible SSE envelope and unknown nonterminal SSE events. Known v1 payload and mutation DTOs remain allowlisted. Clients must fail closed and fetch an authoritative snapshot for an unknown terminal state, missing required identity, invalid sequence, or mutation-precondition mismatch.

All timestamps are RFC 3339 UTC strings. IDs are opaque strings and must not encode filesystem paths, credentials, provider details, or user names. JSON request bodies use UTF-8 and reject duplicate keys, non-finite numbers, and unknown mutation fields.

## 2. Authentication and capabilities

`GET /health` is the only unauthenticated read. `POST /pairing/exchange` is available only while a local desktop pairing window is open and requires its single-use secret. Every other request, including SSE, requires:

```http
Authorization: Bearer <device credential>
Aiden-Protocol-Version: 1
```

The desktop stores only a slow/strong digest of the credential plus device metadata. Revocation closes streams and rejects later requests. Credentials are installation-specific and must never be accepted by a different Aiden instance.

Initial capability IDs:

| Capability | Authority |
| --- | --- |
| `server:read` | Read instance/version/capability projection. |
| `chat:read` | Read projected chats and stream status. |
| `chat:write` | Create/rename/delete chats; start/cancel turns. |
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

No capability can enable Computer Use, mint the reserved Assistant identity, select a hidden unattended mode, read provider/MCP credentials, execute a generic shell/Git command, or widen a workspace's tool authority.

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
- `workspace_unavailable`, `workspace_changing`, `permission_confirmation_required`
- `handle_invalid`, `handle_expired`, `handle_wrong_device`, `root_policy_changed`, `filesystem_identity_changed`, `path_outside_root`, `handle_capacity`
- `turn_already_active`, `stream_gone`, `approval_already_resolved`, `approval_expired`
- `operation_in_progress`, `operation_stale`, `git_capability_denied`
- `schedule_disabled`, `schedule_run_in_progress`
- `server_interrupted`, `internal_error`

## 4. DTO allowlists

### Server

Allowed: instance ID/display name, app/protocol version, supported capabilities, selected connection mode, minimum client version, server time.

Forbidden: local usernames, config/user-data paths, environment values, provider credentials, logs, process arguments.

### Workspace

Allowed: `id`, `name`, `permission`, `hasFolder`, `isManagedWorktree`, optional branch/repository display names, small Git summary, `createdAt`, `updatedAt`, `revision`.

Forbidden: `folderPath`, repository/worktree/Git-admin paths, ownership token, device/inode identity, remote URL, created-from HEAD, config-store record.

### Chat/message

Allowed: IDs, workspace ID, visible title/provider/model selections, an optional `titlePending: true` hint while first-turn background naming is active, visible user/assistant messages, bounded attachments, safe reasoning/tool/timeline milestones, timestamps, terminal provider-failure category.

Forbidden: Pi journals, raw diagnostics, raw tool arguments/results not already safe for renderer display, subagent private history, hidden prompts, credentials, filesystem internals.

### File

Allowed: opaque file handle, safe workspace-relative display path/name, kind, bounded size/language metadata, version, truncation/warning state, text content for a selected readable document.

Forbidden: canonical/absolute path, symlink target, inode/device, recovery path, arbitrary binary bytes.

### Git

Allowed: safe review/diff/comparison fields, branch display names, counts, push capability/reason, managed-worktree display state, operation ID/status.

Forbidden: absolute paths, Git admin path, ownership token, device/inode, raw command line/stdout/stderr, credential-bearing remote URL, private refs not present in the desktop projection.

### Scheduled task

Allowed: task ID/revision, safe name/description, workspace/provider/model IDs, schedule/timezone, mode/permission, selected MCP IDs, notification preference, validated script ID/display name, enabled/running state, next/previous dates, bounded redacted run result.

Forbidden: provider fingerprint, resolved MCP bindings, chat ID, credentials, process environment, raw script path, unredacted stdout/stderr, internal cancellation handles.

## 5. Endpoint inventory

The OpenAPI document owns exact request/response shapes. This section owns behavior.

### Bootstrap/device

- The locally displayed QR encodes the OpenAPI `PairingBootstrap` object as canonical JSON: protocol version, instance ID, HTTPS API endpoint, P-256 SPKI SHA-256 fingerprint, high-entropy single-use secret, and expiry. The phone must decode and validate this object, configure hostname plus SPKI verification, and only then make its first network request. A fingerprint learned from `/pairing/exchange` is confirmation, never the trust bootstrap.
- `GET /health`: minimal readiness and protocol version.
- `POST /pairing/exchange`: exchange a high-entropy single-use secret for device/instance IDs, bearer credential, capability list, endpoint, and P-256 SPKI SHA-256 fingerprint.
- `GET /server`: authenticated server projection.

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
- `GET /streams/{streamId}`
- `GET /streams/{streamId}/events`: SSE replay via `Last-Event-ID` or `after`.
- `POST /streams/{streamId}/cancel`
- `POST /approvals/{approvalId}/respond`: `allow` or `deny` only.

Turn start returns `turnId`, `streamId`, accepted state, and canonical appended message. The generation owner is the authenticated device/stream, not a socket. Disconnect never resends the prompt or cancels the turn. Restart during an active remote turn records one explicit interrupted terminal state and never retries the provider call.

First-turn title generation remains off the interactive response path. While it is active, chat list/get projections include optional `titlePending: true`; the field disappears only after the title job settles. Clients may use this hint for a bounded authoritative refresh and must not treat it as a revision or mutation precondition.

### Attachments

Uploads produce random, short-lived, single-use references bound to the authenticated device and exact chat. References expire after 10 minutes, are removed on device revocation, and are consumed atomically by a turn. A turn accepts at most 10 distinct references. The server retains at most 20 staged references per device/chat, 40 per device, 256 globally, and 64 MiB of staged representation data; capacity exhaustion fails closed.

Image uploads accept only PNG or JPEG, at most 8 MiB decoded, at most 16,384 pixels on either axis, and at most 40 million decoded pixels. Text uploads accept only the documented plain-text/source MIME allowlist, at most 100,000 Unicode scalars and 400,000 UTF-8 bytes. Display names are bounded to 255 Unicode scalars and reject separators and control characters. Upload envelopes never accept a local or server path. Chat and message responses project attachment ID, display name, MIME type, kind, and size only; inline bytes and text are never returned.

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

Edits use `If-Match`/`expectedUpdatedAt`; settings use an equivalent revision. `run` requires an idempotency key and returns `202` with a durable `runId`. Socket loss does not cancel execution. Status is observed in run history. Cancellation follows existing remove/pause/global-disable/revocation/shutdown policy; v1 adds no bespoke remote cancel action.

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

## 7. Idempotency, revisions, and operation ownership

- Create/start/run endpoints require `Idempotency-Key` (random client value, scoped to authenticated device + route + resource). The server durably stores only a bounded scope digest/request digest/state/safe-result record plus a non-secret stable operation reference; raw keys are never persisted. Fulfilled and safely classified rejected outcomes are replayable until expiry. In-flight entries never expire or evict into duplicate work and restore after restart as a fail-closed `idempotency_in_flight` state until the authoritative operation store finalizes that exact reference. Settlement starts the replay TTL; a long-running operation does not lose its replay window. Same key and same canonical request returns the original outcome; same key with different input returns `idempotency_conflict`. Capacity exhaustion fails closed rather than evicting any unexpired or in-flight record.
- Workspace, chat metadata, file, task, settings, and task pause/resume edits require server revision or content version. Stale mutation returns `revision_conflict` with current safe revision only.
- Turns and Git/file/schedule operations have stable owners independent of TCP. Revocation/shutdown/cancel policy is explicit per operation; socket close alone is never authority to mutate state.
- Approval response is idempotent by approval ID and decision. A conflicting second decision returns `approval_already_resolved`.

## 8. Limits and logging

The implementation must set explicit defaults and expose safe capability metadata for request bytes, JSON depth, attachment totals, active devices, streams, replay journal events/bytes/retention, browser pages/depth, file index bounds, text read/write bytes, diff bytes, schedule output bytes, rate limits, and timeouts. Ordinary JSON requests are limited to 1 MiB. Attachment uploads have a dedicated 12 MiB JSON-envelope limit.

Logs may include request ID, route template, status, latency, instance/device ID suffix, and stable error code. Logs never include Authorization, pairing secrets, idempotency keys, opaque handles, request/response bodies, paths, prompts, message text, attachment data, tool arguments/results, provider errors, Git output, schedule output, or App Group/Keychain contents.

## 9. Transport identity

LAN transport uses an installation-local P-256 CA and a server-only leaf with a stable P-256 key. The server presents the leaf plus CA chain; the QR payload carries the HTTPS endpoint and `sha256/<base64-leaf-SPKI-digest>`. Certificate renewal keeps the leaf key and pin. Key rotation is explicit, invalidates the old pin, and requires recovery/re-pairing. The iOS trust path anchors only the presented local CA, validates hostname, validity, certificate signature, server-auth usage, and the expected leaf SPKI digest; a matching pin alone must not accept an expired or wrong-host certificate.

When LAN access is enabled, discovery advertises `_aiden-agent._tcp` over Bonjour. Its TXT record may expose only `v=1` and the public Aiden instance identifier; the service port comes from Bonjour. Pairing secrets, device credentials, pins, paths, capability grants, and user content are never discovery metadata. The iOS app declares `_aiden-agent._tcp` in `NSBonjourServices` and provides `NSLocalNetworkUsageDescription`; disabling LAN access withdraws the advertisement.

Tailscale mode uses the server-owned loopback Aiden HTTP listener behind Tailscale Serve HTTPS plus the same Aiden device credential. Because `--set-path=/api/aiden/v1` strips that public mount prefix before reverse proxying, the target must restore the exact canonical base: `http://localhost:<port>/api/aiden/v1`, IPv4 loopback, or IPv6 loopback, with no credentials, additional path, query, or fragment. Before connect, inspect current config. An explicitly incompatible or Funnel-enabled HTTPS listener is a connect conflict. When Serve status is empty, first-connect eligibility comes from an exact normalized match between the node's stable DNS name and its Tailscale certificate domains; Aiden never completes Tailscale's HTTPS authorization flow for the user. Add one exact Aiden-owned non-Funnel route. Disconnect uses its matching route-specific `off`; never use Serve reset or replace unrelated configuration. A pre-acceptance origin-only target may be recognized solely for exact persisted-ownership cleanup before replacement with the canonical target; it is never accepted for a new connection.

## 10. Contract change process

Change this document, OpenAPI, TypeScript contract constants/types, shared fixtures, and Swift/TypeScript fixture tests in one phase. Additive changes increment `contractRevision`. Breaking changes require `/v2`. No handler may ship an undocumented route or field.
