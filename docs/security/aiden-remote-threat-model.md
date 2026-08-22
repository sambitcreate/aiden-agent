# Aiden Remote Access Threat Model

Status: Phase 0 baseline
Scope: Aiden Agent desktop remote service and Aiden On The Go iPhone/iPad client
Protocol: `/api/aiden/v1`
Review trigger: any new route, capability, transport, background surface, credential store, filesystem projection, or execution owner

## 1. Security goals

1. A remote device cannot control Aiden until the Mac user explicitly enables Remote Access and completes pairing.
2. Network reachability is never authorization; LAN/Tailscale peers still need a valid, capability-scoped Aiden device credential.
3. The phone cannot gain more workspace/tool authority than the saved Aiden permission and explicit approvals allow.
4. No remote DTO, event, log, widget, App Intent, or error leaks credentials, absolute paths, private runtime state, or raw consequential-operation details.
5. Browser/file handles cannot escape approved canonical roots, survive policy/filesystem identity changes, cross devices, or be replayed after use/expiry.
6. Network loss/retry cannot duplicate prompts, approvals, workspace creation, Git mutations, or scheduled runs.
7. Revocation and shutdown terminate future authority predictably without corrupting persisted chats/workspaces/tasks.
8. Desktop IPC ownership remains renderer-scoped; network operations use separate explicit owners rather than forged `WebContents` identity.

## 2. Assets

- Aiden instance identity and LAN private key.
- Pairing secrets and issued device credentials.
- Provider/MCP credentials and provider configuration.
- Chats, messages, reasoning, attachments, and event journals.
- Workspace registry, permissions, filesystem contents, and approved-root policy.
- Git repositories, branches, commits, remotes, and managed-worktree ownership metadata.
- Scheduled task definitions, scripts, process environment, run output, and notification settings.
- Desktop process availability and user intent/approval state.
- iOS Keychain, App Group cache, offline chat cache, Live Activity, and local notification content.

## 3. Trust boundaries

```text
iOS UI / app process
  -> Keychain credential + pinned HTTPS
  -> LAN or Tailscale network
  -> Aiden Remote transport parser/limits/auth
  -> capability + revision/idempotency/owner gates
  -> shared Aiden application services
  -> stores, filesystem, Git, schedule service, Pi runtime

App Intent process -> App Group cached IDs only -> foreground app routing
Live Activity widget -> bounded last-known state only (no network)
Electron renderer -> preload allowlist -> IPC owner (separate from remote owner)
```

Untrusted inputs begin at discovery packets, URLs/QR data, every HTTP header/body/query, SSE resume position, opaque handle, attachment, user-visible name/text, App Group cache, and all filesystem state that can change between calls.

## 4. Adversaries

- Unpaired device or malicious browser on the LAN/tailnet.
- Paired but stolen/compromised phone.
- Paired user attempting to exceed capability or workspace permission.
- Network attacker performing interception, DNS redirection, replay, downgrade, or connection disruption.
- Local unprivileged process probing the listener or logs.
- Malicious workspace containing symlink races, replacement directories, enormous trees/files/diffs, hostile Git metadata, or secret-bearing output.
- Compromised/hostile provider, MCP server, tool result, scheduled script, or prompt content attempting exfiltration through remote projections.
- Accidental user retry, concurrent Electron/mobile edits, app suspension, desktop restart, or stale offline state.

## 5. Threats, mitigations, and required evidence

| Threat | Mitigations | Required tests/evidence |
| --- | --- | --- |
| Listener enabled without consent | Master switch off by default; no bind/discovery until enabled; packaged lifecycle check. | Disabled port probe and packaged smoke. |
| Pairing secret guessing/replay | 256-bit random QR secret, short TTL, single-use atomic exchange, rate limit, pairing window required, digest-only storage, redacted logs. Manual entry uses a uniformly random 100-bit Crockford code that is never transmitted and locally decrypts the canonical pinned trust envelope with HKDF-SHA256 plus AES-256-GCM; QR and manual entry share the same consumed secret. Low-entropy numeric fallback remains prohibited without PAKE/SAS or explicit fingerprint confirmation. | Expiry, replacement, duplicate, QR/manual concurrency, wrong-code authenticated-decryption, endpoint binding, rate-limit, and log/wire-secrecy tests. |
| MITM/wrong Aiden server | HTTPS; QR carries endpoint + P-256 SPKI SHA-256 pin; hostname/time/signature + pin validation; explicit key rotation/re-pair. | Same-key renewal accepted, changed key/wrong host/expired cert rejected on macOS and physical iOS device. |
| Plain-HTTP downgrade | Production config rejects HTTP; development exception compile/config gated and clearly labeled. | Release/config contract tests. |
| Tailscale mistaken for auth | Bearer credential on every route/SSE; capability checks after auth. | Tailnet request without credential fails. |
| Tailscale config takeover | Inspect current config; Funnel-enabled listener fails connect; exact owned Serve route; matching `off`; never Funnel/reset/global replacement; conflict stops. | Fixture/parser tests plus live loopback route proof showing before/after config equality. |
| Credential theft from server storage | Store credential digest only using memory-hard/slow verifier; safe-storage-protected instance key material; restrictive file permissions. | Store format and migration tests. |
| Credential leakage from phone | Keychain only; no UserDefaults/App Group/URL/log/widget/intent; per-install isolation. | Swift storage and no-network/no-Keychain intent-process tests. |
| Stolen paired device | Desktop device list/revoke; capability scopes; last-seen audit; revoke closes streams and rejects commands. | Revocation during stream/approval/operation tests. |
| Browser cross-origin attack | No permissive CORS, cookies, or ambient auth; Authorization bearer required; reject browser origins as policy; content types/limits. | Origin/CORS/preflight and auth tests. |
| Request smuggling/parser abuse | One vetted HTTP stack; header/body/count/time limits; reject duplicate JSON keys, ambiguous transfer framing, invalid UTF-8, deep JSON. | Malformed/body/header/timeout tests. |
| Secret/path leakage | DTO allowlists; stable safe errors; log redaction; bounded sanitized Git/schedule/provider/tool projection. | Forbidden-field fixture/route/log tests. |
| Directory traversal or handle-store exhaustion | No free-form path; hashed device-bound location handles; canonical `realpath`; approved-root boundary + device/inode + policy revision checks; expired/consumed pruning and hard fail-closed capacity. | `..`, encoding, symlink, mount/root replacement, cross-device, expired/replayed handle, pruning, and capacity tests. |
| Browse-to-register TOCTOU | Separate selection nonce; synchronous atomic revalidate-and-consume with workspace creation; async callbacks prohibited and promise escapes consume/fail closed; fail on identity/policy/duplicate change. | Concurrent consume, async-callback, and filesystem replacement tests. |
| Broad-root data exposure | Root addition desktop-only; nested-root dedupe; home warning/confirmation; filesystem root disabled by default; hidden/system policy. | Settings policy tests and remote inability to add roots. |
| File handle escape/staleness | File handles separate from browser handles; bind instance/device/workspace/root/file/snapshot/expiry; re-resolve; expected-version atomic writes. | Cross-workspace/device, root/file replacement, stale version, symlink tests. |
| File/diff resource exhaustion | 4,000/depth-20 index, read/write/diff byte/time limits, streaming/backpressure where needed. | Boundary and cancellation tests. |
| Git destructive misuse | Explicit `git:write`, foreground confirmation, repository-root-only commit/push, operation snapshots/stale errors, canonical repo serialization, managed metadata server-owned. No generic Git/shell. | Nested workspace, confirmation, concurrency, rollback, metadata projection tests. |
| Managed-worktree deletion escape | Accept persisted workspace ID only; re-resolve ownership token/filesystem identity; cancel/settle operations; schedule restoration; rollback. | Replacement and partial-failure tests. |
| Duplicate prompt/model call | Atomic append/admit/start; bounded durable idempotency digest with fulfilled/rejected/in-flight states; no TTL/capacity eviction of in-flight work; stable turn/stream owner independent of socket; client never retries on SSE loss. | Disconnect/retry/concurrent start, rejected outcome, in-flight expiry, and restart tests. |
| Cross-device stream/approval | Owner bound to authenticated device/stream; approval deadline/idempotent decision; other devices denied. | Ownership and duplicate/conflicting decision tests. |
| Event replay/gap confusion | Per-stream monotonic sequence; bounded journal; Last-Event-ID/after; gap -> snapshot; immutable terminal event. | Replay, duplicate, gap, expiry, restart tests. |
| Restart silently retries provider | Persist terminal metadata; restart marks interrupted once; never retries call. | Crash/restart fixture/integration test. |
| Permission elevation/bypass | `workspace:manage`; explicit foreground confirmation + audit for stronger permission; server saved permission composes tool set; remote cannot request hidden modes. | Elevation, approval, none/ask/full tool-contract tests. |
| Scheduled task duplicate/run cancellation | Revision/CAS edits; idempotent durable `runId`; schedule service owns execution across TCP loss; bounded redacted output. | Duplicate retry, disconnect, concurrent edit, DST, output redaction tests. |
| Scheduled script exfiltration | Only existing server-inventoried script IDs; no raw paths; pairing warns about scheduled authority; no App Intent schedule mutations. | Script-ID/path rejection and DTO tests. |
| Attachment bomb/content abuse | MIME/size/count/dimensions/text limits; short-lived references; cleanup; no server paths. | Oversize, decompression dimension, expiry, aggregate tests. |
| Lock Screen/App Intent leak | Live Activity under 4 KB, safe status only by default, no path/args/errors/credentials; intents cache ID-only and foreground. | Payload size/allowlist and stale/revoked entity tests. |
| Voice privacy leak | On-device recognition required; remove server/cloud/audio upload and voice-note path; permission at first use. | Code-path absence and permission fallback tests. |
| Denial of service | Per-device/global rate limits; active stream/device caps; bounded journals/uploads/browse; timeouts; revoke/disable. | Limit and recovery tests. |

## 6. Operation ownership and revocation policy

- Chat turns survive socket loss. Explicit cancel, device revocation, workspace mutation/deletion, or server shutdown follows the generation owner's settlement policy.
- File writes and Git operations use stable remote operation IDs and the existing workspace operation/mutation gates. Socket loss alone does not cancel after server acceptance.
- Scheduled `run now` survives socket loss and is observed by `runId`; remove/pause/global disable/revocation/shutdown use the schedule service's documented policy.
- Pairing/device revocation immediately prevents new requests, closes SSE subscribers, resolves pending approvals as denied/expired according to service policy, and prevents reconnect. It must not blindly kill unrelated desktop-owned work.

## 7. Privacy and logging

Remote-access logs are metadata-minimal. Permitted fields: request ID, route template, status, duration, stable error code, and truncated instance/device ID. Forbidden fields: Authorization, pairing/idempotency secrets, opaque handles, QR contents, URLs with query data, request/response bodies, paths, prompts/messages/reasoning, attachments, tool details, provider/MCP failures, Git/schedule output, Keychain/App Group data.

Offline caches are scoped by Aiden instance ID and use platform data protection. Revocation makes cached data read-only until the user explicitly removes the installation/cache. Lock Screen response excerpts are off by default.

## 8. Residual risks and non-goals

- A fully compromised paired phone can exercise granted capabilities until revoked. Pairing disclosure, least capability, foreground confirmations, and desktop revocation reduce but cannot eliminate this.
- A malicious scheduled script or agent tool already authorized on the Mac may access data available to the Aiden process. Mobile does not create new shell/script path authority, but triggering an existing task remains consequential.
- Tailscale/Bonjour availability and certificates depend on their respective system services. Aiden must fail closed and explain prerequisites.
- No external push relay means Live Activities cannot receive fresh terminal updates while the app is terminated.
- No generic terminal, Computer Use, remote provider credentials, file create/rename/delete, or arbitrary Git command is in scope.

## 9. Review checklist

Before each phase gate:

- Compare new routes/DTOs to this model and the protocol allowlists.
- Identify every new bearer secret, opaque handle, owner, mutation precondition, and terminal state.
- Add negative tests before accepting a new consequential action.
- Verify logs and user-visible errors with adversarial inputs.
- Run two independent fresh-memory security/architecture reviews and clear all P0/P1 findings.
