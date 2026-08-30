# Aiden Remote Access Threat Model

Status: Phase 0 baseline extended for the owner-approved Bot-first access model (August 22, 2026)
Scope: Aiden Agent desktop remote service and Aiden On The Go iPhone/iPad client
Protocol: `/api/aiden/v1`
Review trigger: any new route, capability, transport, background surface, credential store, filesystem projection, or execution owner

## 1. Security goals

1. A remote device cannot control Aiden until the Mac user explicitly enables Remote Access and completes pairing.
2. Network reachability is never authorization; LAN/Tailscale peers still need a valid, capability-scoped Aiden device credential.
3. Bot access is explicit and main-owned: a valid Full Access record is usable only after the current versioned notice is acknowledged, while Custom can narrow a bot and each chat can narrow its bot but can never exceed it.
4. Effective authority is always the least-powerful intersection of OS/global availability, the authenticated device grant, the bot policy, the chat reduction, the surface's approval support, and a fresh effect lease.
5. Every bot receives one durable, main-owned, non-Git home workspace that is the shell working directory and ordinary save location. Full Access may inspect other OS-accessible Mac locations when the task needs it; the home is a default, not a security sandbox.
6. No remote DTO, event, log, widget, App Intent, or error leaks credentials, absolute paths, private runtime state, editable authoritative instructions, or raw consequential-operation details.
7. Browser/file handles cannot escape their effective Custom scopes, survive policy/filesystem identity changes, cross devices, or be replayed after use/expiry.
8. Network loss/retry cannot duplicate prompts, approvals, bot/home creation, avatar replacement, Git mutations, or scheduled runs.
9. Revocation, policy narrowing, and shutdown terminate future authority predictably without corrupting persisted bots/chats/workspaces/tasks.
10. Desktop IPC ownership remains renderer-scoped; network operations use separate explicit owners rather than forged `WebContents` identity.
11. An iOS-generated avatar becomes canonical only after explicit user acceptance, authenticated upload, independent Mac-side validation, and revision-checked storage.

## 2. Assets

- Aiden instance identity and LAN private key.
- Pairing secrets and issued device credentials.
- Provider/MCP credentials and provider configuration.
- Chats, messages, reasoning, attachments, and event journals.
- Bot identities, editable guidance, Full/Custom policies, chat reductions, notice acknowledgements, favorites, and archive state.
- Main-owned bot system instructions, managed-home bindings, private workspace paths, and files created there.
- Canonical bot avatar assets, semantic fallbacks, asset revisions, and Image Playground temporary results.
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
  -> device grant + revision/idempotency/owner gates
  -> main-owned Bot application service
  -> notice + Full/Custom bot/chat resolver + fresh effect lease
  -> authoritative bot prompt + managed-home binding
  -> shared Aiden application services
  -> stores, filesystem, shell/Git, MCPs/skills, schedules, Pi runtime

Apple Image Playground / Private Cloud Compute when used
  -> iOS temporary result + explicit Use this image
  -> local normalize/metadata strip
  -> authenticated revision-checked upload
  -> main-owned Mac decode/normalize/canonical avatar store

App Intent process -> App Group cached IDs only -> foreground app routing
Live Activity widget -> bounded last-known state only (no network)
Electron renderer -> preload allowlist -> IPC owner (separate from remote owner)
```

The iOS access editor is a remote control, not an authority source. It submits opaque catalog selections and expected revisions; the Mac resolves all IDs, policies, prompts, paths, credentials, and executable tools.

Untrusted inputs begin at discovery packets, URLs/QR data, every HTTP header/body/query, SSE resume position, opaque handle, attachment or avatar byte stream, bot name/purpose/editable guidance, access selection, App Group cache, Image Playground temporary result, MCP/skill/provider output, and all filesystem state that can change between calls. Apple-controlled generation, including Private Cloud Compute when the system chooses it, is an external privacy and content boundary; only the image the person accepts is sent to the Mac.

## 4. Adversaries

- Unpaired device or malicious browser on the LAN/tailnet.
- Paired but stolen/compromised phone.
- Paired user or stale client attempting to exceed its device grant, bot policy, chat reduction, or policy revision.
- Network attacker performing interception, DNS redirection, replay, downgrade, or connection disruption.
- Local unprivileged process probing the listener or logs.
- Malicious workspace containing symlink races, replacement directories, enormous trees/files/diffs, hostile Git metadata, or secret-bearing output.
- Compromised/hostile provider, newly enabled MCP server, skill, tool result, scheduled script, bot guidance, or prompt content attempting to weaken the home-workspace instructions or exfiltrate Mac data through a Full bot.
- Malformed or adversarial image output attempting decompression/resource exhaustion, metadata leakage, parser exploitation, cross-bot replacement, or arbitrary-path writes.
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
| Stolen paired device | Desktop device list/revoke; explicit `bot:read`/`bot:write` device grants; last-seen audit; approval ownership; revoke closes streams and rejects commands. The Full Access notice explains authority but never substitutes for authentication or a device grant. | Revocation during bot stream/approval/tool/avatar operations; revoked device cannot read bot metadata or reconnect. |
| Browser cross-origin attack | No permissive CORS, cookies, or ambient auth; Authorization bearer required; reject browser origins as policy; content types/limits. | Origin/CORS/preflight and auth tests. |
| Request smuggling/parser abuse | One vetted HTTP stack; header/body/count/time limits; reject duplicate JSON keys, ambiguous transfer framing, invalid UTF-8, deep JSON. | Malformed/body/header/timeout tests. |
| Secret/path leakage | DTO allowlists; stable safe errors; log redaction; bounded sanitized Git/schedule/provider/tool projection; Bot DTOs omit managed paths, provider/MCP credentials, skill contents/paths, internal fingerprints, and avatar filenames. | Forbidden-field fixture/route/log tests for regular and Bot routes, inbox previews, policy views, and avatar errors. |
| Full Access is enabled without informed intent | Every valid new/migrated bot gets an explicit `full` record, but no Bot action is admitted until the paired installation acknowledges the current blocking, versioned notice or chooses Custom first. Material expansion of Full's meaning bumps the notice version. Persistent UI labels keep the mode inspectable. | Fresh/migrated/re-paired installation, stale notice, Customize-first, material-version bump, offline, retry, and concurrent-acknowledgement tests. |
| Missing/corrupt policy fails open to Full | Full is never inferred. Creation/migration writes a versioned valid record atomically; missing, corrupt, future-version, or unreconciled policy/home state blocks new Bot effects and exposes only a safe repair state. | Missing/truncated/future-version store, interrupted migration/create, duplicate home, and repair tests. |
| Bot/chat access elevation or stale-policy use | Mac resolves the least-powerful intersection at admission and immediately before each effect; bot updates use optimistic revisions; chats persist reductions/subsets only and cannot mint grants; narrowing invalidates active leases. Custom-to-Full requires explicit confirmation and applies on the next turn without retrying work. | Forged catalog/grant ID, bot-vs-chat mismatch, stale revision, concurrent edit, active narrowing, archive, global disable, and no-running-tool-retry tests. |
| Full's dynamic MCP/skill inventory surprises the user | The notice states that Full follows currently enabled ordinary Aiden capabilities, including later-enabled connections and skills. OS/global disables and existing approvals remain authoritative. Custom binds exact opaque resource identities, schemas/effects or skill fingerprints and fails closed on drift; it never grows silently. | Add/change/remove/disable MCP and skill fixtures for Full and Custom; prompt/schema/effect inventory must match the effective UI summary. |
| Mobile access controls bypass main ownership | Remote routes require the relevant device grant, exact-key DTOs, expected revisions, safe Mac-projected catalog IDs, and authenticated operation ownership. iOS cannot submit paths, credentials, prompt fragments, fingerprints, raw tool names, or internal bot/chat IDs outside its authorized objects. | Route authorization, mass-assignment, cross-device/cross-bot ID, stale catalog, optimistic-conflict, and safe-projection tests. |
| Directory traversal or handle-store exhaustion | No free-form path; hashed device-bound location handles; canonical `realpath`; approved-root boundary + device/inode + policy revision checks; expired/consumed pruning and hard fail-closed capacity. | `..`, encoding, symlink, mount/root replacement, cross-device, expired/replayed handle, pruning, and capacity tests. |
| Browse-to-register TOCTOU | Separate selection nonce; synchronous atomic revalidate-and-consume with workspace creation; async callbacks prohibited and promise escapes consume/fail closed; fail on identity/policy/duplicate change. | Concurrent consume, async-callback, and filesystem replacement tests. |
| Broad-root data exposure | The blocking notice makes Full Mac-file reach explicit; managed home is the `cwd` and ordinary save location; main-owned instructions require task-relevant, minimal outside-home inspection. Custom root additions remain desktop-controlled, canonical, and scope-bound. Neither mode bypasses macOS permissions or Aiden's global disables. | Full notice and task-relevant external-read/write tests; Custom Bot-folder/chosen-location/off tests; remote inability to invent roots or paths. |
| Managed-home escape, collision, or implicit repository | Main alone provisions one durable, private, opaque home per bot with restrictive ownership/mode and stable binding. Provisioning is idempotent, creates no `.git`, and never accepts a client path. The path is hidden from normal DTOs/UI and disclosed only when the person asks. | Symlink/replacement/collision/restart/concurrent-create tests; no `.git`/branch/commit after create or ordinary chat; path omission and ownership tests. |
| Editable guidance overrides authoritative operating rules | Main injects the resolved home path and operating contract after editable persona content on every Bot turn. The authoritative section sets `cwd`/default save location, permits only task-needed outside inspection, requires minimal user-owned-file changes, and forbids automatic Git setup. Hard access remains resolver-enforced rather than relying on prose. | Prompt-order/escaping tests, malicious bot instruction and tool-result injection tests, fresh path resolution, and proof that Custom restrictions hold even if prompt text requests more. |
| File handle escape/staleness | File handles separate from browser handles; bind instance/device/workspace/root/file/snapshot/expiry; re-resolve; expected-version atomic writes. | Cross-workspace/device, root/file replacement, stale version, symlink tests. |
| Hidden Bot home reached through Workspace Files | Managed Bot homes are omitted from the Workspace registry and ordinary Workspace file routes reject them even when a client learns an opaque workspace ID. Bot file routes are chat-scoped and bind every handle to instance, device, bot, chat, policy epoch, managed-home identity, snapshot, and expiry; admission re-resolves the current Full/Custom and chat reduction. | Direct Workspace-route probe, forged bot/chat IDs, cross-chat handle replay, policy narrowing/epoch change, archive, revocation, symlink/replacement, and Custom Files-off tests. |
| File/diff resource exhaustion | 4,000/depth-20 index, read/write/diff byte/time limits, streaming/backpressure where needed. | Boundary and cancellation tests. |
| Shell or Git destructive misuse | Shell appears only when the effective Full/Custom policy permits it and starts in the managed home. Provisioning never initializes Git. An explicit task may use Git in an existing repository or initialize it only when requested, under ordinary Aiden approval, destructive-action, process, and repository safeguards; mobile receives activity/approval projections rather than credentials or a raw terminal channel. | Shell-off/lease tests; `cwd` proof; command cancellation/limits/redaction; no implicit Git; explicit existing-repo and requested-init confirmation/concurrency/rollback tests. |
| Managed-worktree deletion escape | Accept persisted workspace ID only; re-resolve ownership token/filesystem identity; cancel/settle operations; schedule restoration; rollback. | Replacement and partial-failure tests. |
| Duplicate prompt/model call | Atomic append/admit/start; bounded durable idempotency digest with fulfilled/rejected/in-flight states; no TTL/capacity eviction of in-flight work; stable turn/stream owner independent of socket; client never retries on SSE loss. | Disconnect/retry/concurrent start, rejected outcome, in-flight expiry, and restart tests. |
| Cross-device stream/approval | Owner bound to authenticated device/stream; approval deadline/idempotent decision; other devices denied. | Ownership and duplicate/conflicting decision tests. |
| Event replay/gap confusion | Per-stream monotonic sequence; bounded journal; Last-Event-ID/after; gap -> snapshot; immutable terminal event. | Replay, duplicate, gap, expiry, restart tests. |
| Restart silently retries provider | Persist terminal metadata; restart marks interrupted once; never retries call. | Crash/restart fixture/integration test. |
| Workspace or Bot permission elevation/bypass | `workspace:manage` and `bot:write` are separate device grants; stronger Workspace permission and Custom-to-Full changes require the applicable foreground confirmation/audit. A regular chat uses its saved Workspace permission. A bot chat uses the Bot resolver as its sole user-facing access authority; its hidden managed workspace is provisioned with an internal runtime baseline that can never widen the Bot result. Remote input cannot select or mutate that baseline, request hidden modes, or exceed its safe catalog. | Device-grant and elevation tests; none/ask/full regular-Workspace tests; Full/Custom Bot tool-contract tests proving the internal managed-workspace baseline neither unexpectedly narrows nor widens the presented Bot policy. |
| Scheduled task duplicate/run cancellation | Revision/CAS edits; idempotent durable `runId`; schedule service owns execution across TCP loss; bounded redacted output. | Duplicate retry, disconnect, concurrent edit, DST, output redaction tests. |
| Scheduled script exfiltration | Only existing server-inventoried script IDs; no raw paths; pairing warns about scheduled authority; no App Intent schedule mutations. | Script-ID/path rejection and DTO tests. |
| Attachment bomb/content abuse | MIME/size/count/dimensions/text limits; short-lived references; cleanup; no server paths. | Oversize, decompression dimension, expiry, aggregate tests. |
| Avatar upload poisoning, leakage, or cross-bot replacement | Image Playground is system-owned and may use PCC, but iOS uploads only after **Use this image**. iOS normalizes a square image and strips metadata; the Mac independently authenticates, bounds, decodes, normalizes, strips metadata, stores atomically under an owned opaque filename, checks bot/device/revision/idempotency, and serves authenticated `no-store`/`nosniff` content. Semantic avatar remains fallback. | Cancel/rejected-candidate/temp-file cleanup, malformed/oversize/decompression/metadata fixtures, cross-device/bot/revision/replay, partial write/restart, content-header, fallback/rollback, and log tests. |
| Lock Screen/App Intent leak | Live Activity under 4 KB, safe status only by default, no path/args/errors/credentials; intents cache ID-only and foreground. | Payload size/allowlist and stale/revoked entity tests. |
| Voice privacy leak | Native recognition remains device-local. Paired-Mac mode is explicit, uses the authenticated pinned-TLS Aiden channel, accepts only bounded 16 kHz mono PCM, performs local Parakeet transcription, and does not persist audio. Voice-note attachments remain absent. | Codec bounds, capability/auth, contract, lifecycle, and permission-fallback tests. |
| Denial of service | Per-device/global rate limits; active stream/device caps; bounded journals/uploads/browse; timeouts; revoke/disable. | Limit and recovery tests. |

Speech setup and use deliberately map to the existing `server:read`/`chat:write` grants so already-paired v1 clients can opt into the new mode without credential migration. Model download and selection are therefore exposed only to paired devices that can already mutate chats; the Mac does not expose these routes to read-only or unauthenticated peers. A future protocol revision should split speech use from model administration if per-device least-privilege controls are added.

## 6. Operation ownership and revocation policy

- Chat turns survive socket loss. Explicit cancel, device revocation, workspace mutation/deletion, or server shutdown follows the generation owner's settlement policy.
- Bot creation, managed-home provisioning, chat creation, and avatar replacement use device-scoped idempotency plus main-owned revisions so retry/restart cannot create duplicate identities, homes, files, or assets.
- File writes, shell/Git effects, and avatar mutations use stable remote operation IDs and the existing workspace operation/mutation gates. Socket loss alone does not cancel after server acceptance.
- Switching Full to Custom, removing a Custom grant, archiving a bot, revoking a device, or disabling/changing a resource invalidates affected leases immediately; the next effect must be re-authorized and removed authority must not be restored by retry. Added authority starts with the next turn.
- Full follows the ordinary enabled inventory at the next turn. Custom is an exact ceiling and remains disabled on connection schema/effect drift, skill content/source drift, or provider binding change until the person reviews it.
- Scheduled `run now` survives socket loss and is observed by `runId`; remove/pause/global disable/revocation/shutdown use the schedule service's documented policy.
- Pairing/device revocation immediately prevents new requests, closes SSE subscribers, resolves pending approvals as denied/expired according to service policy, and prevents reconnect. It must not blindly kill unrelated desktop-owned work.

## 7. Privacy and logging

Remote-access diagnostics are metadata-minimal. Permitted fields: closed route category, outcome or status class, bounded duration, and stable Aiden-owned error code; successful production traffic is aggregated by day. Forbidden fields: request IDs, instance/device suffixes, Authorization, pairing/idempotency secrets, opaque handles, QR contents, URLs, request/response bodies, managed or external paths, prompts/messages/reasoning, authoritative bot instructions, editable bot guidance, policy fingerprints, skill contents, attachments/avatar bytes or metadata, Image Playground prompts/rejected candidates/temporary URLs, tool details, provider/MCP failures, Git/shell/schedule output, Keychain/App Group data.

Offline caches are scoped by Aiden instance ID and use platform data protection. They may retain safe Bot identity/inbox/access summaries and canonical-avatar cache entries, never managed paths, credentials, internal bindings, or Image Playground temporary results. Shared unsent composer drafts are additionally keyed by chat ID, remain in the app-private container (not App Group, widget, intents, or logs), clear after an accepted send, and purge on removal, revocation, or replacement pairing. Pending attachment references are not copied into draft persistence. Revocation makes other cached data read-only until the user explicitly removes the installation/cache. Lock Screen response excerpts are off by default.

## 8. Residual risks and non-goals

- A fully compromised paired phone with `bot:write` can exercise the granted Bot surface until revoked. For an acknowledged Full bot this includes ordinary enabled shell, Mac files, connections/MCPs, and skills, subject to OS permissions and existing approvals. The versioned notice makes that delegation informed; it is not containment. Custom is the containment option.
- The managed bot home reduces accidental scattering and supplies a stable `cwd`; it is not a sandbox in Full mode. A malicious prompt, MCP, skill, provider output, or shell command may still attempt to read or change other data available to Aiden. Hard resolver checks, task-scoped instructions, approvals, OS permissions, and Custom reductions mitigate but cannot eliminate that risk.
- Main-owned system instructions guide location and minimal-change behavior but are not themselves an authorization boundary. Security must not depend on the model obeying prose when a tool or resource is disabled by policy.
- Image Playground is Apple-controlled and may use Private Cloud Compute on supported devices/OS versions. Aiden does not control that processing; it minimizes its own exposure by sending the Mac only the user-accepted, normalized image and retaining no generation prompt or rejected candidate.
- A malicious scheduled script or agent tool already authorized on the Mac may access data available to the Aiden process. Triggering an existing task remains consequential and continues to require the surface's supported approval behavior.
- Tailscale/Bonjour availability and certificates depend on their respective system services. Aiden must fail closed and explain prerequisites.
- No external push relay means Live Activities cannot receive fresh terminal updates while the app is terminated.
- No standalone mobile terminal, remote provider/MCP credential editor, raw managed-path editor, user-editable authoritative system prompt, or arbitrary-path Remote API is introduced. Bot shell use occurs inside the existing Mac-owned chat/tool runtime. Existing Computer Use opt-in and safety behavior remain authoritative even for Full bots.

## 9. Review checklist

Before each phase gate:

- Compare new routes/DTOs to this model and the protocol allowlists.
- Identify every new bearer secret, opaque handle, policy/catalog ID, owner, lease, mutation precondition, and terminal state.
- Add negative tests before accepting a new consequential action.
- Verify logs and user-visible errors with adversarial inputs.
- Verify notice versioning, explicit-Full persistence, fail-closed policy/home corruption, Custom drift, chat ceilings, and dynamic Full inventory against the effective tool set.
- Verify managed-home ownership/`cwd`, no automatic `.git`, task-needed outside-home access, and authoritative prompt ordering without treating the prompt as enforcement.
- Verify Image Playground unavailable/cancel/PCC disclosure, accepted-image-only upload, Mac-side decode/normalization, asset isolation, and temporary-file cleanup on physical supported and unsupported devices.
- Run two independent fresh-memory security/architecture reviews and clear all P0/P1 findings.
