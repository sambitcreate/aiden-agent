# Aiden On The Go Plan

Status: Active foundation — Phases 0–4, 7, 9, 10, and 11 are complete; Phases 5/6/8 are implemented, LAN and real Tailscale are proven on a physical iPhone, and version 0.1.0 build 21 is `VALID` and `IN_BETA_TESTING` for Internal Testers with final-only Bot replies and expandable intermediate activity; physical-iPad and external/public-release acceptance remain open. The approved bot-first extension is now governed by `bot-first-aiden-on-the-go-plan.md`.
Date: 2026-08-18
Owners: Aiden Electron main process, the SwiftUI app under `ios/`, and the Jetpack Compose app under `android/`

Android UI follow-up 2026-08-24: the Compose shell now mirrors iOS's product-area hierarchy with the shared Aiden app icon opening a native Bots/Workspaces menu, replacing the persistent two-tab bottom control. Bots, Workspaces, chat, scheduled tasks, pairing, Git, Bot editing, and appearance surfaces use borderless tonal state instead of outlined components; list density, shared gutters, and toolbar touch targets are normalized. Nested shell insets and chat IME ownership were corrected; the composer now stays fully above Gboard, offers separate Android Photo Picker and document-picker actions, and delegates dictation to Google's native speech activity. The resulting debug build passed unit tests, lint, Android-test compilation, assembly, and physical Pixel 10 Pro XL interaction/visual checks.

Reasoning-presentation follow-up 2026-08-27: iOS and Android now mirror Aiden Agent's single exposed-reasoning lifecycle. The live label shimmers as `Thinking` without ellipses, settles to `Thought briefly/for …` once tool work begins, and an active `render_artifact` call uses a separate `Visualizing` shimmer. iOS removes duplicate thinking milestones from the simultaneous activity disclosure while retaining the authoritative timeline for history and reconciliation. The Remote wire contract is unchanged.

## Bot-first extension authority

This plan remains the source of truth for the shipped Remote API, Workspace experience, and historical phases 0–12. For new Bot behavior, `docs/plans/bot-first-aiden-on-the-go-plan.md` supersedes this document only where it explicitly changes navigation, Bot access, managed workspace behavior, shell availability, avatar creation, and delivery phases. All unrelated pairing, transport, credential, DTO, opaque-handle, streaming, privacy, and mutation-safety rules in this plan remain in force.

The approved extension redesigns iPhone/iPad now and defers a Mac UX redesign. The paired Mac remains authoritative for Bot identity, policy, execution, hidden managed homes, and canonical photos. Every Bot conversation must reuse the existing Swift `AidenChatDetailView` and its existing chat feature/view-model path; implementation may add Bot presentation and Access affordances around it, but must never fork or copy the conversation engine.

## Goal

Turn the imported Hermex SwiftUI application into **Aiden On The Go**, a native iPhone and iPad client for the locally running Aiden Agent desktop application.

The desktop app remains the execution authority. The mobile app connects over the local network or Tailscale, pairs to a specific Aiden installation, and controls Aiden through a narrow authenticated API. The complete product scope is deliberately limited to Aiden capabilities that have a real desktop equivalent:

- Pairing and connection management.
- Aiden chats: list, open, create, rename, delete, compose, stream, cancel, and approve or deny tool requests.
- A Bot-first iPhone/iPad area with reusable bot identities and conversations alongside the existing Workspace area.
- Aiden workspaces: list, create folderless or managed-scratch entries, explore approved folders on the paired Mac, register a selected folder, rename, change permission, and unregister.
- The provider/model choices required to start an Aiden chat, without exposing credentials.
- Aiden branding and the mobile-applicable Aiden appearance choices.
- Aiden workspace files, Git workflows, scheduled tasks, App Intents, Live Activities, and native or paired-Mac local-model voice controls, delivered after the core chat/workspace transport is stable.

Kanban and every other Hermex screen without a deliberate Aiden contract are removed rather than left disconnected or filled with placeholder behavior.

## Audited starting point

### Aiden desktop

Aiden does not currently expose an inbound application server. Its production control path is:

```text
React renderer
  -> sandboxed preload
  -> allowlisted Electron IPC
  -> Electron main process
  -> chat/workspace services and Pi runtime
```

The existing chat notifications (`chat:delta`, `chat:reasoning-delta`, `chat:tool`, `chat:timeline`, `chat:approval`, `chat:done`, and `chat:error`) are delivered only to the Electron renderer that owns the generation. Workspace operations are likewise tied to a live renderer document. An HTTP handler must not impersonate or bypass that ownership model.

Relevant sources:

- `main/services/renderer-document-owner.ts`
- `main/services/chat-generation-owner.ts`
- `main/services/llm-client.ts`
- `main/handlers/chat.ts`
- `main/handlers/chats.ts`
- `main/handlers/workspaces.ts`
- `main/services/chat-store-core.ts`
- `main/services/config-store-core.ts`

### Imported SwiftUI app

Hermex already provides a strong native shell, iPhone/iPad navigation, REST client, resumable SSE client, chat transcript, reasoning/tool rendering, approvals, Keychain storage, offline cache, and workspace-registry manager. It is currently coupled to the unrelated Hermes WebUI endpoint and event vocabulary.

Retain as foundations:

- `ios/HermesMobile/ContentView.swift`
- `ios/HermesMobile/Features/SessionList/`
- `ios/HermesMobile/Features/Chat/`
- `ios/HermesMobile/Networking/APIClient.swift`
- `ios/HermesMobile/Networking/SSEClient.swift`
- `ios/HermesMobile/Features/Workspace/WorkspaceManagerView.swift`
- `ios/HermesMobile/Features/Workspace/WorkspaceRegistryViewModel.swift`
- `ios/HermesMobile/Persistence/`
- `ios/HermesMobile/Config/AppTheme.swift`
- `ios/HermesMobile/Features/Shared/AdaptiveGlassModifier.swift`

The imported code remains MIT-licensed upstream work. Preserve its copyright and third-party notices while renaming and adapting it.

## Product boundary

### Ship in the first complete release

1. Desktop Remote Access settings and lifecycle.
2. QR/one-time-code pairing, per-device credentials, device list, and revocation.
3. Local-network discovery plus manual host entry.
4. Tailscale-compatible connection through a stable HTTPS address.
5. Chat and workspace registry surfaces that represent Aiden's real models and rules.
6. Resumable streaming with tool activity, reasoning, terminal state, and allow/deny approvals.
7. Aiden light/dark styling, presets, icons, naming, and iPad layouts.
8. Offline display of previously fetched chats; mutations remain disabled while disconnected.
9. Normal Workspace turns retain Aiden's server-side chat capabilities (including configured skills, MCP tools, and subagents where the existing permission model allows them) without adding separate Workspace management screens. Bot Access separately presents safe Mac-projected Connections, Skills, shell, Files, and other capability groups under the bot-first plan. Computer Use retains its existing explicit opt-in and safety boundary.
10. An approved-root Mac folder explorer for adding folder-backed workspaces without accepting free-form server paths.
11. Aiden's existing workspace file list/read/write and Git workflows, adapted to the retained Hermex native views.
12. Aiden scheduled-task list, create, edit, remove, pause, resume, run-now, preview, and run-history workflows.
13. App Intents, Live Activities, and native/paired-Mac voice dictation plus on-device read-aloud behavior that never grants background authority beyond the paired device and workspace permission.
14. Bot CRUD, profiles, favorites/recent threads, Full/Custom access, one hidden managed home per bot, shell-backed agent work, per-chat reductions, semantic/Image Playground avatars, and paired-Mac canonical-photo persistence under the bot-first plan.

### Remove from the mobile product

- Kanban models, endpoints, event stream, views, tests, scripts, and navigation.
- Hermes Skills, Memory, Insights, and server-panel screens.
- Hermes projects and path-as-workspace identity.
- Hermes personalities/profiles and server-specific commands.
- Hermes goals, Btw/background controls, clarification flows, and other actions without an Aiden equivalent.
- Hermes Cloudflare onboarding, branding, URLs, copy, icons, and gold theme settings.
- Generic Terminal UI and arbitrary client-authored shell controls. This does not disable the existing Mac-owned shell tool inside a Bot turn when the effective Full/Custom policy allows it.

### Defer until the core client is stable

- Share extension.
- Push notifications that require an external relay or cloud service.
- Voice-note upload and server TTS. The voice surface is dictation into the composer using native recognition or the explicitly selected paired-Mac local Parakeet model, plus optional on-device read-aloud.
- Computer Use controls.
- Subagent management UI.
- Chat copy/export, branching, pinning, archiving, and history truncation unless Aiden first ships matching service semantics.
- File create/rename/delete and generic Git/Terminal controls without an existing Aiden desktop service contract. Bot shell remains an agent capability rather than a phone-authored command endpoint and starts in the hidden managed home.

## Target architecture

```text
Aiden On The Go (SwiftUI)
  -> HTTPS REST for commands and snapshots
  -> resumable SSE for generation events
  -> device bearer credential from Keychain

Aiden Agent (Electron main)
  -> Remote API transport (off by default)
  -> remote device/session ownership
  -> shared chat/workspace/bot application services
  -> main-owned Full/Custom policy, managed-home, and avatar stores
  -> existing stores, mutation gates, llmClient, and Pi runtime
```

The API belongs to Aiden and is versioned at `/api/aiden/v1`. Do not permanently reproduce the entire Hermes `/api/*` protocol. Swift models and endpoint functions are converted to Aiden DTOs. Hermex code is reused for implementation patterns, not treated as the new protocol source of truth.

## Remote API contract draft

Before implementing handlers, add a checked-in protocol specification and JSON fixtures. The specification owns field names, nullability, limits, status codes, error codes, and event ordering. TypeScript and Swift tests consume the same fixtures.

### Public bootstrap surface

- `GET /health`
  - Minimal availability and protocol version only.
  - Must not expose paths, chats, providers, host usernames, or configuration.
- `POST /api/aiden/v1/pairing/exchange`
  - Accepts a short-lived single-use pairing secret and client public metadata.
  - Returns the Aiden instance ID, device ID, device credential, API capabilities, and server identity needed for pinning.
  - Rate-limited; pairing must already be open in the desktop app.

### Authenticated server/device surface

- `GET /api/aiden/v1/server`
  - Instance name, app/protocol version, capabilities, and connection mode.
- `GET /api/aiden/v1/devices`
  - Desktop Settings only unless a later capability explicitly grants it remotely.
- `DELETE /api/aiden/v1/devices/:deviceId`
  - Revokes the selected device and closes its streams.

### Workspace registry

- `GET /api/aiden/v1/workspaces`
- `GET /api/aiden/v1/workspaces/:workspaceId`
- `POST /api/aiden/v1/workspaces`
- `PATCH /api/aiden/v1/workspaces/:workspaceId`
- `DELETE /api/aiden/v1/workspaces/:workspaceId`
- `GET /api/aiden/v1/workspace-browser/roots`
- `GET /api/aiden/v1/workspace-browser/children?location=...&cursor=...`
- `POST /api/aiden/v1/workspace-browser/selections`

Mobile workspace DTOs use Aiden IDs, names, permission (`full`, `ask`, `none`), folder-presence metadata, a small Git summary, and timestamps. Managed-worktree projection is explicitly allowlisted to display-only state such as `isManagedWorktree` and branch/repository display names. Absolute paths, worktree Git/admin paths, ownership tokens, device/inode values, remote URLs, and other config-store internals never cross the API. Absolute filesystem paths are not identifiers or writable request fields.

The supported create modes are:

- `folderless`: create a named Aiden context without a folder.
- `scratch`: ask Aiden to create and own a scratch directory.
- `selected-folder`: register a directory chosen through the server-controlled workspace browser.

The phone never submits a free-form Mac path. Remote Access settings on the Mac own an explicit list of browsable roots, initially suggested from parents of already registered workspaces and extended only by a local desktop action. Each approved-root record stores a random root ID, canonical path, device/inode identity, policy revision, display label, and hidden/system-directory policy. Dedupe or reject nested roots. Broad roots such as the home directory require a specific local warning and confirmation; the filesystem root is disabled by default and cannot be enabled remotely.

The browser returns friendly root labels, high-entropy opaque location tokens, bounded/paginated directory children, and breadcrumbs; it does not return file contents or recursively index a root. Store only token digests server-side and bind each handle to the Aiden instance, authenticated device, root ID/policy revision, canonical internal location, device/inode identity, expiry, and maximum depth. Never embed or log paths in client-visible tokens. Cursors bind to the exact root and parent-location token; listing has deterministic ordering, fixed maximum page/depth limits, hidden/system filtering, and per-device rate limits.

Canonicalize every location with `realpath`, reject traversal and symlink escape, and re-check the approved-root boundary and device/inode identity after every navigation. A root, directory, or symlink replacement invalidates the handle and fails closed.

`POST /workspace-browser/selections` exchanges the current location handle for a separate short-lived, single-use selection nonce bound to the authenticated device, root/policy revision, canonical directory identity, and expiration. `POST /workspaces` accepts that nonce rather than a path. Selection consumption and workspace creation are one atomic/idempotent operation: immediately before mutation, re-check `realpath`, directory type, root boundary, policy revision, device/inode identity, and duplicate-workspace state; then consume the nonce exactly once. Concurrent reuse, a policy change, or a browse-to-register filesystem race fails closed. The new workspace uses Aiden's existing default `ask` permission unless the server contract deliberately changes that default. Existing folder-backed workspaces can be read, renamed, permission-changed, and unregistered. Deleting a workspace record never deletes its folder. Managed-worktree deletion stays a separate Git operation with its own confirmation.

Workspace mutation must reuse Aiden's existing cancellation, schedule-restoration, operation-registry, default-workspace, and safe-removal rules. A paired device receives `workspace:manage` by default to satisfy the confirmed full-CRUD behavior; pairing UI discloses that authority. Raising a workspace from `none`/`ask` to a stronger permission requires an explicit foreground confirmation and an audit event, but not a second Mac confirmation. Add authoritative workspace-created/updated/removed broadcasts for both Electron and mobile consumers; do not assume the current IPC handlers already broadcast, and do not carry over Hermex-only workspace reordering.

### Chats

- `GET /api/aiden/v1/chats?workspaceId=...`
- `POST /api/aiden/v1/chats`
- `GET /api/aiden/v1/chats/:chatId`
- `PATCH /api/aiden/v1/chats/:chatId` for supported metadata such as title
- `DELETE /api/aiden/v1/chats/:chatId`
- `POST /api/aiden/v1/chats/:chatId/move` only for an empty chat, matching Aiden's existing rule

The mobile projection includes Aiden's renderer-safe chat fields only: IDs, workspace ID, provider/model IDs, timestamps, visible messages, safe parent reasoning, parent timeline/tool milestones, attachments, and the parent turn's closed provider-failure metadata. Private Pi journals, raw diagnostics, provider credentials, subagent private history, and filesystem internals never cross the API.

Subagent execution follows Pi's parent-only mobile boundary. Even when the parent turn uses subagents, iOS and Android receive only the ordinary parent messages, parent timeline and outcome, and parent stream state. Child/subagent IDs and counts, private histories, lifecycle snapshots, controls, and endpoints remain Mac-local. The parent runtime may incorporate child findings into its own visible reply, but mobile never receives a separately addressable child object.

Visible parent `message.text` is opaque transcript data and remains exact within the 200,000-Unicode-scalar response bound. Filtering is structural: it excludes private fields and metadata, not strings because they resemble a path, URL, UUID, base64, hexadecimal data, or a credential. The clients must not display an encoded/redacted placeholder for such parent text. Separate credential fields, authorization headers, and provider/MCP secrets remain forbidden.

Ordinary remote Workspace chat creation cannot mint Aiden's reserved Assistant workspace identity or unattended modes. Remote Workspace turns follow the same main-owned capability composition and permission checks as an attended desktop Workspace chat; the transport cannot request hidden modes or widen tool authority. Bot chats use the separate explicit, revisioned Full/Custom policy defined by the bot-first plan. Full becomes usable only after the current versioned notice; Custom and per-chat settings may narrow authority but never exceed the bot, OS permissions, global configuration, or existing safety gates.

### Provider/model discovery

- `GET /api/aiden/v1/models`

Return only connected/configured provider identities, selectable models, capabilities needed by the composer, thinking-level choices, and the server's current defaults. Never return provider tokens, base authentication headers, credential payloads, or private provider configuration.

### Turns, streams, and approvals

- `POST /api/aiden/v1/chats/:chatId/turns`
  - Atomically validates the chat/workspace/provider/model, appends the user message, acquires the Aiden turn lease, and starts generation.
  - Returns `turnId`, `streamId`, accepted state, and the canonical appended message.
- `GET /api/aiden/v1/streams/:streamId`
  - Active/terminal status and authoritative chat ID.
- `GET /api/aiden/v1/streams/:streamId/events`
  - SSE stream; supports `Last-Event-ID` and explicit `after` sequence.
- `POST /api/aiden/v1/streams/:streamId/cancel`
  - Cancels the authenticated parent turn stream only. It is not a child/subtree control API; any child shutdown is an internal consequence owned by the Mac runtime.
- `POST /api/aiden/v1/approvals/:approvalId/respond`
  - First release accepts only `allow` or `deny`, matching Aiden's enforceable scope.

Every event has a monotonically increasing sequence number, stream ID, event type, timestamp, and typed payload. Initial vocabulary:

- `snapshot`
- `status`
- `text_delta`
- `reasoning_delta`
- `tool_started`
- `tool_finished`
- `timeline`
- `approval_required`
- `done`
- `error`
- `cancelled`
- `heartbeat`

The client never resends a user message because an SSE connection dropped. It asks stream status, reconnects with its last sequence, and reconciles the final authoritative chat snapshot.

### Attachments

Aiden already models bounded inline image and text attachments. The remote API should use bounded multipart upload or a bounded JSON upload step that produces a short-lived attachment reference, then translate that reference into Aiden's existing attachment model during the atomic turn operation.

Do not accept arbitrary server-side file paths from the phone. Enforce content type, byte size, decoded image size, text truncation, aggregate turn limits, expiry, and cleanup. Attachments are included only after the core text-turn path is stable.

### Workspace files and Git

Expose only operations already owned by Aiden's workspace and Git services:

- `GET /api/aiden/v1/workspaces/:workspaceId/files`
- `GET /api/aiden/v1/workspaces/:workspaceId/files/:fileId`
- `PUT /api/aiden/v1/workspaces/:workspaceId/files/:fileId`
- `GET /api/aiden/v1/workspaces/:workspaceId/git/review`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/diff`
- `GET /api/aiden/v1/workspaces/:workspaceId/git/branches`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/checkout`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/branches`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/commit`
- `GET /api/aiden/v1/workspaces/:workspaceId/git/push-capability`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/push`
- `POST /api/aiden/v1/workspaces/:workspaceId/git/compare` and `/comparison-diff`
- `GET|POST /api/aiden/v1/workspaces/:workspaceId/git/worktrees`
- `DELETE /api/aiden/v1/workspaces/:workspaceId/git/managed-worktree`

Match Aiden's current file-index semantics: one bounded recursive snapshot, currently capped by the service at 4,000 entries and depth 20, with explicit `truncated` metadata. Do not silently pretend it is a complete tree or reuse workspace-browser location tokens. The index may display safe workspace-relative names, but read/write requests use separate high-entropy, server-side opaque file handles bound to instance, device, workspace, canonical root identity, relative file identity, expiry, and index snapshot. Every operation re-resolves the handle under the current canonical workspace root and fails on root/file replacement or escape. Writes require Aiden's `expectedVersion` value and return the authoritative document or a stable conflict result. The first release matches desktop file semantics—index, read, and version-checked atomic write—and does not invent file create, rename, or delete actions.

Git DTOs use an explicit field allowlist for Aiden's review, bounded diff, comparison, branch, push-capability, and managed-worktree display results. They omit absolute paths, Git admin paths, credentials, remote URLs containing secrets, ownership tokens, device/inode values, head metadata, and raw command output. Managed-worktree deletion accepts only the persisted workspace ID and re-resolves server-owned metadata; it never accepts client-supplied filesystem/admin fields.

Commit, push, checkout, branch creation, worktree creation, and managed-worktree deletion require an explicit foreground confirmation in the phone UI and must not be callable from App Intents. Commit and push retain Aiden's repository-root-only rule; nested workspaces surface the server's read/diff-only capability reason. Reuse Aiden's workspace operation registry, mutation gate, canonical Git-common-directory serialization, cancellation rules, worktree ownership validation, rollback, and schedule restoration. Network operations return stable `operationId`/snapshot metadata and stale-conflict errors; a TCP disconnect does not implicitly invalidate the authenticated remote operation owner. The remote transport does not expose fetch, pull, stage/unstage, discard, a generic Git command, or a client-authored shell endpoint because Aiden has no matching service contract. This boundary does not remove the existing Mac-owned shell tool from Bot turns: when the effective Bot policy permits it, the agent invokes shell through the normal Aiden runtime, beginning in the hidden managed home and retaining ordinary approvals and safeguards.

### Scheduled tasks

Mirror Aiden's existing scheduled-task services rather than Hermes Cron payloads:

- `GET|POST /api/aiden/v1/scheduled-tasks`
- `GET|PATCH|DELETE /api/aiden/v1/scheduled-tasks/:taskId`
- `POST /api/aiden/v1/scheduled-tasks/:taskId/pause`
- `POST /api/aiden/v1/scheduled-tasks/:taskId/resume`
- `POST /api/aiden/v1/scheduled-tasks/:taskId/run`
- `GET /api/aiden/v1/scheduled-tasks/:taskId/runs`
- `POST /api/aiden/v1/scheduled-tasks/preview`
- `GET /api/aiden/v1/scheduled-tasks/scripts?workspaceId=...`
- `GET /api/aiden/v1/scheduled-tasks/mcp-servers`
- `GET|PATCH /api/aiden/v1/scheduled-tasks/settings`

Mobile supports list, create, edit, remove, pause, resume, run now, preview, and run history using Aiden's validated task schema, workspace/provider/model bindings, timezone rules, script inventory, global enable switch, permissions, notification preference, and selected MCP IDs. Remote task DTOs explicitly omit provider fingerprints, resolved MCP bindings, chat IDs, provider credentials, raw script paths, and other internal runtime metadata. Project run output/errors through a bounded, redacted display DTO because stored output can still contain paths or secrets. The client selects only server-inventoried script IDs; it never names a path.

Creating or editing unattended work is a consequential foreground action with a final review screen. Edits require `If-Match`/`expectedUpdatedAt`, and settings mutations require an equivalent revision or serialized mutation gate, producing stable conflict responses for concurrent Electron/mobile changes. `POST .../:taskId/run` is an idempotent accepted operation: an idempotency key returns one `runId`, execution is owned durably by the schedule service, status is observed through run history, and a TCP disconnect does not cancel it. Cancellation follows the existing task remove/pause/global-disable/revocation/shutdown policy; do not add a bespoke mobile cancellation action unless Aiden desktop first exposes matching semantics. App Intents cannot create, edit, remove, enable, or run tasks in the first release. Remote mutations broadcast the same authoritative updates used by the Electron UI.

## Shared desktop application services

Do not call Electron IPC handlers from the HTTP layer. Extract or introduce main-process application services whose inputs are already parsed and whose ownership is explicit:

- `ChatApplicationService`
  - list/get/create/rename/delete/move-empty
  - append-and-start as one transaction
- `WorkspaceApplicationService`
  - list/get/create-folderless/create-scratch/create-from-selection/update/remove
  - existing mutation and operation gates remain authoritative
- `WorkspaceBrowserService`
  - approved roots, bounded directory navigation, opaque location/selection tokens, canonical-path revalidation
- `WorkspaceFileApplicationService`
  - safe index/read/version-checked write over the existing file services
- `GitApplicationService`
  - review/diff/compare/branches/commit/push/worktrees over the existing operation and mutation gates
- `ScheduledTaskApplicationService`
  - validated list/save/remove/pause/resume/run/preview/history/settings operations and broadcasts
- `RemoteGenerationOwner`
  - stable device/session identity independent of `WebContents`
  - event journal and subscribers
  - cancellation and approval ownership
  - lifecycle invalidation on revocation or server shutdown
- `RemoteDeviceStore`
  - instance identity, paired device records, credential hashes, capabilities, revocation, and last-seen metadata

Electron IPC remains renderer-owned. Both IPC and the remote transport should call shared service operations where their semantics truly match; renderer-only actions keep their renderer requirements.

## Stream durability and concurrency

The remote owner is tied to a paired device and stream, not to one TCP connection. A temporary network loss must not cancel a turn.

- Maintain a bounded per-stream sequence journal for replay.
- Persist enough terminal metadata to reconcile after app or network restart.
- Persist the assistant response through the existing chat store as the authority.
- If Aiden restarts during an active remote turn, close it with an explicit interrupted terminal state; never silently retry the model call.
- Expire terminal journals after a documented retention window while keeping chat history.
- A replayed approval retains one approval ID and deadline; duplicate responses are idempotent or return a stable already-resolved result.
- Chat deletion, workspace mutation, cancellation, provider failure, renderer activity, and multiple paired devices need explicit race tests.
- Remote-started chat metadata changes must use the existing desktop broadcasts so the Electron sidebar stays current.

## Pairing, transport, and security

### Desktop controls

Add a Remote Access settings page using existing Aiden settings components and semantic tokens:

- Master enable switch, off by default.
- Listen mode: Tailscale, local network, or both.
- Port/status and reachable addresses.
- Explicit Tailscale `Connect` / `Disconnect` controls with a preview of the exact Aiden-owned Serve route.
- Approved workspace-browser roots, editable only on the Mac.
- `Pair device` action that shows a QR code and short code with expiration.
- Paired device list with name, type, last seen, and Revoke.
- Clear warnings about remote workspace authority and what each workspace permission means.

The service starts only after explicit enablement and valid configuration. It remains available while the Aiden process is running even when the main window is closed, and settles cleanly on app quit.

The production QR payload carries the instance ID, selected HTTPS endpoint, short-lived high-entropy pairing secret, protocol version, and pinned server public-key fingerprint. A human-sized numeric code is not sufficient authentication on an untrusted LAN by itself: its fallback flow must use a reviewed PAKE/SAS-style exchange or a separate fingerprint confirmation. Do not silently downgrade QR pairing to numeric-code-plus-plain-HTTP.

### Device credentials

- Generate one random credential per device.
- Store only a strong credential digest and device metadata on desktop; protect sensitive local material with Aiden's existing safe-storage patterns.
- Store the issued credential in the iOS Keychain.
- Authenticate every REST request and SSE connection.
- Bind stream/approval ownership to the authenticated device.
- Issue explicit device capabilities for chat, workspace browsing/registry, files, Git, and schedules; reject a route when the credential lacks its capability.
- Support revocation and rotation without changing provider credentials.
- Redact credentials and pairing secrets from logs and errors.
- Apply request body limits, endpoint-specific rate limits, timeouts, and a small maximum number of clients/streams.
- Do not enable permissive browser CORS; this is a native-client API.

### Tailscale

Tailscale supplies reachability and network encryption, not application authorization. Aiden binds to loopback behind Tailscale Serve HTTPS. The confirmed product behavior is an explicit `Connect` / `Disconnect` flow: before changing anything, inspect the current configuration, show the exact non-Funnel Serve route and command-equivalent action, record ownership of only the route Aiden creates, and on disconnect use the matching route-specific `off` operation. Never invoke `tailscale serve reset`, replace the whole Serve config, or modify unrelated routes. If the existing Tailscale configuration conflicts, stop and explain the conflict instead of taking over. If tailnet HTTPS certificates are not enabled, explain the prerequisite and let the user complete Tailscale's own authorization flow instead of enabling it silently. The desktop UI shows the exact stable HTTPS URL used for pairing and must never enable Tailscale Funnel.

### Local network

- Advertise availability with Bonjour/mDNS only while local-network access is enabled.
- Discovery publishes instance identity and port, never a pairing secret or bearer token.
- Add the required iOS local-network usage description and Bonjour service declaration.
- Production LAN transport should use HTTPS with a per-install server identity pinned during QR pairing. A Phase 0 transport spike must prove certificate generation, renewal, pinning, and recovery before the API is exposed broadly.
- Pin the stable server public key rather than a short-lived certificate when feasible. Certificate renewal may retain that key; key rotation requires an explicit re-pair/recovery flow.
- Plain HTTP is limited to an explicit development configuration and must not be the production default.

## SwiftUI conversion

### Project identity

Replace the imported identity throughout the main app, tests, configs, entitlements, localization, URL routes, and retained extensions:

- Product/display name: `Aiden On The Go`.
- Swift/Xcode targets and schemes: rename from `HermesMobile` after the first green protocol slice so the rename is mechanically isolated.
- Apple development team: `5WP229CBB8`, matching the checked-in Contact Sheet Generator Xcode project.
- Signing: automatic, with a Phase 0 physical-device provisioning check for the main app, Live Activity widget, and App Group.
- Main bundle ID: `sbtbiswas.AidenOnTheGo`.
- Test bundle IDs: `sbtbiswas.AidenOnTheGoTests` and `sbtbiswas.AidenOnTheGoUITests`.
- Live Activity widget bundle ID: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`.
- App Group: `group.sbtbiswas.AidenOnTheGo`.
- Keychain service: `sbtbiswas.AidenOnTheGo.pairing`.
- URL scheme: `aiden-otg`.
- App Store SKU: `aiden-on-the-go-ios`.
- New Aiden app icons and in-app brand assets; remove every Hermes/Hermex icon, banner, gold mask, and alternate icon.
- Rename Hermes-prefixed Swift types and files in bounded mechanical passes.
- Replace `ios/README.md`, `ios/PROJECT_SPEC.md`, and the Hermex-specific working agreement with Aiden-owned documentation after this plan is approved. Preserve required upstream attribution.

The main target already declares iPhone and iPad support. Keep that device-family setting and validate real split-view behavior rather than treating iPad as a scaled iPhone.

These values were derived from `/Users/sambitbiswas/projects/contactsheet/Contact-Sheet-Generator/ContactSheetGen.xcodeproj/project.pbxproj`, whose shipped targets use automatic signing, team `5WP229CBB8`, and the `sbtbiswas.*` namespace. The repository does not contain an App Store Connect SKU, App Group, or URL scheme, so the SKU/group/scheme above are new Aiden choices rather than copied metadata. The locally installed Apple Development certificate currently reports team `7EK65FX44E`; Phase 0 must refresh or select credentials that can provision the confirmed `5WP229CBB8` team before identity work proceeds.

### Networking

- Keep the generic URLSession and error-handling foundation.
- Replace cookie/password auth with pairing credential injection.
- Replace path-based Hermes endpoint definitions with Aiden `/api/aiden/v1` definitions.
- Replace Hermes session/workspace DTOs with tolerant Aiden DTOs.
- Keep the SSE parser/reconnect structure but decode the Aiden event vocabulary and sequence contract.
- Keep multi-server registry concepts only if they are reframed as multiple paired Aiden installations.
- Keep Keychain-backed per-server credentials and ensure credentials/cookies never cross between servers.
- Add Bonjour discovery and manual Tailscale URL entry.

### App navigation

The Aiden logo switches between exactly two product areas:

- **Bots** — reusable helpers and their conversations. It becomes the default when the paired Mac supports and grants `bot:read`.
- **Workspaces** — the retained project/folder-oriented chat experience.

Scheduled Tasks, Usage, appearance, and paired-installation Settings remain shared destinations rather than a third product area. Older, unsupported, or ungranted installations fall back honestly to Workspaces. Preserve independent navigation state for Bots and Workspaces per paired installation.

Files and Git are Workspace-scoped destinations opened from a workspace rather than new global tabs. On iPhone, use the retained navigation-stack patterns. On iPad, preserve adaptive `NavigationSplitView` behavior for both product areas, with the selected conversation in detail. Empty, disconnected, loading, and reconnecting states must work in compact and regular size classes.

### Chat surface

`AidenChatDetailView` and its existing chat feature/view-model dependencies are the single conversation implementation for both Workspaces and Bots. Do not fork, duplicate, or replace its transcript, composer, streaming, attachments, approvals, voice, outcome reconciliation, Live Activity handoff, or offline-history behavior. Bot work adds identity/title presentation, an effective-access summary, and Bot defaults/This chat sheets around that shared view only.

Retain Hermex's native components only where the Aiden contract supports them:

- Transcript and Markdown rendering.
- User and assistant messages.
- Streaming text and safe reasoning.
- Compact tool/timeline activity.
- Allow/Deny approval overlay.
- Composer, send, stop, model/provider selection, thinking level, and bounded attachments.
- Offline read cache.

Add a top-right ellipsis in the conversation toolbar. Its Workspace-backed menu opens `Workspace Settings` and the other Workspace-scoped destinations; the permission control lives inside that settings screen beside name, folder/managed-worktree status, Files, Git, and management links. A Bot-backed menu instead opens Bot defaults and This chat access while hiding workspace choice, Review, branch/worktree, and persistent Terminal chrome. Neither permission surface appears in the composer. The composer remains limited to message/voice input, attachments, model/thinking choices, send, and stop. Use the retained Hermex toolbar, menu, form, and sheet patterns rather than inventing a custom control.

Remove Hermes goals, Btw/background mode, clarification UI, server TTS, server commands, profiles/personalities, and unsupported message actions.

### Workspace surface

In the Workspaces product area, show Aiden workspaces by stable ID and name. Support:

- List and refresh.
- Create folderless workspace.
- Create Aiden-managed scratch workspace.
- Explore approved folders on the paired Mac and register a selected folder.
- Rename.
- Change permission with the same `full`, `ask`, and `none` meaning as desktop, from `Workspace Settings` reached through the conversation-toolbar ellipsis or workspace management screen—not from the composer.
- Unregister with explicit confirmation and copy that the folder is not deleted.

Build folder exploration from the existing Hermex list/navigation vocabulary: approved root picker, breadcrumb/back navigation, paginated directory rows, and a native `Use This Folder` action. Do not show an arbitrary absolute path field. A mobile mutation waits for server settlement and reconciles from the returned authoritative list.

### Files and Git surfaces

Retain and adapt `FileBrowserView`, `GitWorkspaceView`, `GitDiffView`, `GitCommitView`, `GitBranchPickerView`, and their existing native supporting components only where they map to Aiden's DTOs. Files support index, read, edit, save, conflict/reload, and offline read cache. Git supports repository review, diff, compare, branch switching/creation, commit, push when capability permits, worktree creation, and confirmed deletion of Aiden-managed worktrees. Consequential actions use native confirmation sheets and show authoritative success/error results. No terminal or arbitrary Git command field is introduced.

Bot conversations remain message-first and do not expose these Workspace Git/Review surfaces by default. A Bot's hidden managed home is not initialized as a repository. Shell may still be available as a Mac-owned agent capability under Full or selected Custom access, and Git may be used when an explicit task makes an existing or deliberately initialized repository relevant; neither behavior adds a phone-authored command field.

### Scheduled Tasks surface

Adapt the Hermex Tasks screen structure and native forms, but replace every Cron DTO, endpoint, label, and assumption with Aiden's scheduled-task model. Support list/filter, create/edit, pause/resume, remove, run now, previewed next runs, and run history. The editor exposes only server-projected provider/model/workspace, mode, permission, selected MCP, notification, timezone, schedule, prompt, and validated script choices. It must clearly label that enabled tasks can run while the phone is disconnected.

### App Intents, Live Activities, and voice

- Retain the imported App Intent deep-link/router idea and rename it for Aiden, but migrate away from the imported deprecated `openAppWhenRun` pattern to the current SDK's `OpenIntent`/`OpenURLIntent`/URL-representable navigation contract. Ship `New Chat`, `New Chat with Voice`, and `New Chat in Workspace` intents backed only by App Group-cached Aiden installation/workspace entities. Entity lookup is cache-only and stable-ID-only: the intent process does not read pairing credentials, call the network, create a chat, embed a path/token in a deep link, or send a prompt. A stale/revoked installation opens the connection UI. Intents otherwise open the app to the requested destination and cannot alter permissions, run Git, or mutate scheduled tasks in the first release.
- Retain the ActivityKit target and reconciliation architecture. Start a Live Activity for a turn initiated on this device; update its sub-4 KB state from authoritative status/tool/approval/stream events; mark it stale on loss; reconcile by `streamId` after relaunch using the selected paired installation's Keychain credential and pinned transport; and end on done, error, cancellation, revocation, or server interruption. The widget extension cannot access the network. With no cloud push relay in scope, it displays the last known stale state while the app is suspended/terminated and reconciles only when Aiden On The Go next runs. Default Lock Screen content to title and safe status; make assistant excerpts an explicit local privacy preference; never include paths, tool arguments, raw approval details, credentials, or provider errors.
- Composer dictation supports an explicit setting between native recognition and the paired Mac's local Parakeet model. Native mode uses the platform speech API and requests Speech/Microphone access only when dictation starts. Paired-Mac mode requests Microphone access, captures bounded 16 kHz mono PCM, sends it over the authenticated pinned-TLS Aiden Remote connection, and inserts only the final transcript after stop; neither endpoint persists the recording. Keep voice-note attachments and Aiden server TTS absent. Add optional on-device read-aloud of assistant text with system speech APIs. Permission denial or unavailable recognition must degrade to the text composer.

## Approved bot-first operating contract

- Bots default to an explicit **Full Access** policy only after one blocking, versioned notice. The notice explains access to OS-permitted Mac files, shell, currently enabled Connections/MCPs, Skills, and other ordinary Aiden capabilities, plus the fact that newly enabled capabilities join Full. **Customize first** opens the same editor without acting.
- **Custom** stores exact selections and may reduce Files, shell, Connections, Skills, and other safe projected groups per bot. A chat may reduce its bot further but can never exceed the bot. Missing, corrupt, or future-version policy state blocks and repairs rather than guessing Full. OS permissions, global disables, action approvals, and Computer Use's existing explicit opt-in remain authoritative in both modes.
- The main process provisions exactly one durable hidden home per bot and reuses it for new chats. Shell/tool work starts there and ordinary artifacts are saved there. Provisioning never creates `.git`, a branch, or a commit. Full may inspect or work in other OS-accessible Mac locations when the task needs it; files outside the home remain user-owned and existing destructive-action safeguards apply.
- The main process injects the resolved home and operating rules after editable bot instructions. The required meaning is: start and normally save in the bot home; inspect elsewhere only as needed; minimize outside changes; do not initialize or use Git merely because the home exists; disclose the private path only when the person asks; and do not expose credentials, private paths, or unrelated content unnecessarily. Mobile, renderer, and editable bot text cannot replace this section.
- The iPhone/iPad Bot UI uses the system Image Playground sheet on supported OS/device combinations. Private Cloud Compute is acceptable and copy must not promise universal on-device processing. Aiden uploads only the normalized candidate explicitly accepted with **Use this image**; the paired Mac validates and stores it as the canonical bot photo. The semantic Aiden avatar remains fully usable without Apple Intelligence.
- The connected iPhone 13 Pro proves the honest Image Playground-unavailable path. Successful system-sheet generation and paired-Mac persistence still require eligible Apple Intelligence hardware.

## Aiden appearance on iOS/iPadOS

Use semantic Swift theme tokens, not colors scattered through views. Port the canonical Aiden, Slate, Berry, and Moss palettes from `renderer/shared/appearance.ts` into a versioned shared appearance fixture that both platforms test.

Mobile-applicable parity:

- System, Light, and Dark modes.
- Aiden, Slate, Berry, and Moss presets.
- Separate light/dark accent, background, and foreground configuration if custom themes are in scope.
- System, rounded, and humanist UI font choices.
- SF Mono, Menlo, and Monaco code font choices where available.
- Contrast, reduced-motion preference, UI size, and code size.
- Sidebar translucency mapped to the iPad navigation shell.
- Diff marker preference for the retained Git diff surface.

Desktop-only settings do not become fake mobile controls:

- Pointer cursor mode.
- macOS dock icon selection. If alternate mobile icons ship, expose only real Aiden and Monochrome iOS icons.
- Browser font-smoothing toggle.

Appearance is confirmed to be independent and device-local on iPhone/iPad. Do not add a desktop appearance endpoint, implicit mirroring, or silent bidirectional synchronization. A later explicit `Follow desktop` mode would require its own contract and product decision.

## Desktop onboarding and documentation

Remote access is a durable, setup-critical feature, so update Aiden onboarding:

- Add a concise Remote Access explanation and opt-in path.
- Explain that Aiden must be running and that Tailscale is optional transport.
- Explain workspace permissions and paired-device revocation.
- Add a data-driven final-tour tile with its own optimized 1024 x 1024 transparent PNG.
- Keep all network actions behind the user's explicit enable/pair action.

Document local-network setup, Tailscale Serve setup, no-Funnel policy, device revocation, offline behavior, and troubleshooting without adding a normal-startup network dependency.

## Delivery phases and acceptance gates

The phases below remain the implementation and evidence history for the existing Aiden On The Go foundation. Do not restart or reinterpret them for Bots. Active Bot delivery follows `docs/plans/bot-first-aiden-on-the-go-plan.md` phases 0–8 in order. Between every Bot phase, a different subagent must review source and tests; fix all P0/P1 findings, rerun affected checks, and repeat review until clear before recording evidence and advancing.

### Phase 0 — Freeze decisions and prove transport

1. Record the confirmed product decisions below in the shared protocol and iOS project specification.
2. Write the API schema, event vocabulary, capability document, error envelope, DTO allowlists, opaque-handle claims/storage, idempotency/revision rules, remote-operation ownership, and shared fixtures.
3. Prove Tailscale Serve HTTPS against a loopback test endpoint.
4. Prove LAN HTTPS identity generation, QR fingerprint transfer, URLSession pinning, renewal, and recovery on a physical device.
5. Verify that Xcode can automatically provision `sbtbiswas.AidenOnTheGo`, its Live Activity widget, and `group.sbtbiswas.AidenOnTheGo` under team `5WP229CBB8`; resolve the currently installed `7EK65FX44E` Apple Development identity mismatch.
6. Threat-model pairing, device theft, replay, revocation, LAN interception, malicious browser requests, approved-root browsing, selection-token replay, path/symlink escape, and approval races.

Acceptance: reviewed protocol/threat model plus a correctly team-signed physical-device transport spike; no chat/workspace production endpoint yet.

### Phase 1 — Shared Aiden service boundary

1. Extract chat and workspace application operations from IPC-specific handlers where semantics match.
2. Add a remote owner abstraction without weakening renderer ownership.
3. Preserve all mutation, deletion, reconciliation, and approval gates.
4. Add focused unit tests showing IPC behavior is unchanged.

Acceptance: desktop type-check, focused tests, full `npm run test`, and normal Electron chat/workspace smoke remain green.

### Phase 2 — Remote service, pairing, and desktop UI

1. Add the off-by-default server lifecycle.
2. Add device store, one-time pairing, credential verification, revocation, limits, and redacted diagnostics.
3. Add health/server/capability endpoints.
4. Add explicit Aiden-owned Tailscale Serve Connect/Disconnect with preview, conflict detection, ownership tracking, and unrelated-route preservation.
5. Add Remote Access Settings, approved browser roots, onboarding, feature-tour asset, and documentation.

Acceptance: disabled means no listener; paired test client authenticates; unpaired/revoked clients fail; packaged Aiden keeps the service alive with the window closed and stops it on quit; disconnect removes only the route Aiden created and Funnel is never enabled.

### Phase 3 — Workspace registry and safe folder-browser API

1. Add list/get/create-folderless/create-scratch/create-from-selection/update/remove endpoints.
2. Use existing Aiden mutation gates and default-workspace rules.
3. Add desktop-approved roots, opaque location navigation, bounded directory listing, and short-lived device-bound selection tokens.
4. Exclude raw path mutation and disk deletion; canonicalize and revalidate root membership at navigation and registration time.
5. Add concurrency, stale-ID, active-chat, schedule, managed-worktree, traversal, symlink-escape, root-policy-change, and replay tests.

Acceptance: full supported registry CRUD and approved folder selection work from a contract test client; paths outside approved roots cannot be selected; the Electron workspace UI reconciles immediately.

### Phase 4 — Chat CRUD and remote generation

1. Add chat list/get/create/rename/delete and optional empty-chat move.
2. Add atomic remote turn start and stable remote ownership.
3. Add resumable SSE journal, status, cancellation, reasoning/tool/timeline events, terminal reconciliation, and allow/deny approvals.
4. Add provider/model read projection.
5. Add desktop refresh broadcasts for remote mutations.

Acceptance: a network test client completes, reconnects to, cancels, approves, and denies real mocked turns without duplicate messages or cross-device ownership leaks.

### Phase 5 — Swift cleanup and Aiden identity

1. Remove every out-of-scope feature and test from the Xcode project.
2. Replace product docs and the protocol source of truth.
3. Apply the confirmed Contact Sheet-derived team/bundle namespace plus the new Aiden app-group/keychain/URL/SKU identities; rename targets, schemes, symbols, and retained resources.
4. Install Aiden icons/assets and preserve license notices.
5. Keep the project buildable after each mechanical rename slice.

Acceptance: no Hermes/Hermex user-facing identity remains; the signed app launches on iPhone and iPad; retained unit tests are green.

### Phase 6 — Swift connection and workspace client

1. Add discovery, manual URL, QR/short-code pairing, Keychain credential storage, multiple Aiden installations, switching, and revoke handling.
2. Implement Aiden workspace DTOs and full supported registry CRUD.
3. Implement approved-root folder exploration and registration with breadcrumbs, pagination, selection-token expiry recovery, and no editable absolute-path field.
4. Add the conversation-toolbar ellipsis and `Workspace Settings`; keep workspace permission out of the composer.
5. Add offline/error/retry states and local-network permission copy.

Acceptance: physical iPhone and iPad pair over LAN and Tailscale, switch installations without credential leakage, explore only approved Mac roots, register a selected folder, and perform supported workspace CRUD.

### Phase 7 — Swift chat client

1. Implement chat list/detail/create/rename/delete.
2. Implement atomic turn send, stream replay, status reconciliation, stop, tool/timeline rendering, reasoning, and approvals.
3. Add model/provider/thinking selection.
4. Add bounded attachments after text turns are stable.
5. Rework offline cache keys around Aiden instance and chat IDs.

Acceptance: disconnect/reconnect never resends a prompt; terminal history matches desktop; chat/workspace changes appear in both clients; revoked devices stop receiving events.

Completed 2026-08-19. Chat CRUD, provider/model/thinking selection, resumable SSE, approvals, cancellation, authoritative reconciliation, instance-scoped caching, and bounded attachments now ship. Attachment uploads mint ten-minute, one-use references bound to the exact device and chat; turns consume at most ten unique references and translate them into Aiden's canonical image/text attachment model. The server caps formats, bytes, dimensions, Unicode scalars, retained memory, and counts; cleans references on discard, consumption, expiry, and revocation; and projects metadata only. The native composer uses system Photos/file pickers, bounded image transcode and text-prefix reads, attachment-only turns, fail-closed reference validation, and exact-request idempotency-key reuse. The signed iPhone 13 Pro suite executes 64 tests: 59 pass, five environment-gated live proofs skip, and zero fail. Production-router HTTP tests cover attachment upload, discard, turn creation, replay, and projection. An additional opted-in physical-iPhone test proves upload, discard, one-use consumption, replay rejection, authoritative metadata, streaming reconnect, approval, duplicate-approval rejection, cancellation, and cleanup over real LAN HTTPS. Phase 12 later proves real Tailscale pairing, authenticated workspace transport, and canonical route cleanup on the same phone. Evidence is in `docs/testing/aiden-on-the-go/phase-7.md` and `docs/testing/aiden-on-the-go/phase-12.md`.

### Phase 8 — Appearance and iPad polish

1. Introduce Swift semantic tokens and shared preset fixtures.
2. Apply Aiden branding without redesigning retained Hermex controls.
3. Implement the confirmed independent, device-local mobile appearance options.
4. Validate Dynamic Type, VoiceOver, keyboard navigation, Reduce Motion, contrast, split view, rotation, Stage Manager sizing, and offline states.

Acceptance: visual and accessibility matrix passes for all four presets in light/dark on iPhone and iPad; no desktop appearance setting is mutated.

### Phase 9 — Workspace files and Git

1. Extract Aiden workspace-file and Git application services from IPC-only ownership without changing desktop behavior.
2. Add remote index/read/version-checked-write plus review/diff/compare/branches/commit/push/worktree endpoints and device capabilities.
3. Adapt the retained Hermex file and Git views to Aiden DTOs and move their entry points into workspace navigation/settings.
4. Add device/workspace-bound opaque file handles, snapshot/operation IDs, confirmations, conflict handling, disconnect-safe ownership, bounded output, explicit DTO allowlists, worktree ownership, rollback, and multi-client race tests.

Acceptance: mobile can inspect the bounded/truncation-aware file index, version-safely edit files, complete supported Git workflows, reconnect to operation state, and reconcile with Electron; path escape, stale writes/snapshots, cross-workspace tokens, internal Git metadata projection, and unconfirmed consequential operations fail safely.

### Phase 10 — Scheduled Tasks

1. Extract/share Aiden scheduled-task application operations and authenticated remote routes.
2. Adapt the Hermex Tasks list/detail structure to Aiden task DTOs, validation, settings, preview, script inventory, and run history.
3. Implement create/edit/remove/pause/resume/run-now workflows with final review for unattended execution, revision-checked edits/settings, and idempotent durable `runId` ownership across disconnects.
4. Test timezone/DST behavior, workspace deletion/permission changes, provider/MCP projection, redacted run output, global disable, concurrent desktop/mobile edits, duplicate run retries, disconnect during execution, and offline UI.

Acceptance: the phone exposes every supported Aiden scheduled-task operation without leaking internal metadata/credentials or accepting arbitrary script paths; a duplicate retry creates one run; execution survives phone disconnect; edit conflicts are explicit; and authoritative desktop/mobile state converges.

### Phase 11 — App Intents, Live Activities, and voice

1. Rename and adapt App Intent entities, shortcuts, deep links, phrases, and cold/warm launch routing for installations/workspaces using the current non-deprecated SDK navigation APIs.
2. Rename/sign the Live Activity widget; adapt its bounded state, reducer, privacy controls, deep links, last-known/stale behavior, stream reconciliation, and terminal states to Aiden events.
3. Retain dictation only where on-device recognition is available, remove every server/cloud/audio-upload path and hold-to-record gesture, and add optional on-device response read-aloud with correct microphone/speech/privacy lifecycle behavior.
4. Verify background execution cannot bypass pairing, workspace permission, approval, Git confirmation, or scheduled-task review.
5. Replace Hermex privacy strings and remove the imported production HTTP exception; any plain-HTTP allowance is development-build-only and narrowly scoped.

Acceptance: App Intents open the correct Aiden destination using cached IDs without network or credential access; voice is on-device-only and degrades safely to text; and a Live Activity shows honest last-known/stale state while disconnected, then authenticates, reconciles, and ends correctly when the app next runs, without exposing response text by default.

Historical note: the voice portion of this Phase 11 acceptance describes the 2026-08-19 build. The explicit paired-Mac local-model follow-up dated 2026-08-24 supersedes that on-device-only constraint while preserving user-started capture, bounded/no-retention audio handling, and text fallback.

Completed 2026-08-19. The shipping app now has cache-only installation/workspace App Intent entities and current-SDK deep-link navigation; a signed, embedded Aiden Live Activity widget with bounded private-by-default state and authenticated relaunch reconciliation; explicit on-device-only composer dictation; and system read-aloud. Stable IDs are separated by installation, stale or revoked destinations fail closed, response excerpts default off, and neither App Intents nor the widget receive endpoints or credentials. The final shipping bundle contains generated shortcut metadata, the required privacy strings, and no production ATS exception. The full signed physical-iPhone suite passed 56 tests with four expected environment-gated skips, the focused Phase 11 suite passed 6/6 after the final reducer cleanup, and the clean app installed and launched on the iPhone 13 Pro. No simulator or iPhone 16 Pro Max was used. Evidence is in `docs/testing/aiden-on-the-go/phase-11.md`.

### Phase 12 — End-to-end hardening and release readiness

1. Run Electron unit/integration/full test suites, type-check, lint, build, packaged smoke, and listener-disabled verification.
2. Run the full retained XCTest suite and signed physical-device build/launch; simulator use remains excluded by user direction.
3. Run shared contract fixtures against TypeScript and Swift decoders.
4. Run physical-device LAN and Tailscale scenarios, sleep/wake, IP change, token rotation/revocation, server restart, duplicate approval, and multi-device concurrency.
5. Complete privacy strings, Local Network/Bonjour/Speech/Microphone descriptions, ActivityKit/App Group/Keychain entitlements, team provisioning, App Store metadata, and third-party notices.

Acceptance: release checklist is green with no Hermes-only endpoint, brand asset, localization, or dead navigation remaining.

Progress 2026-08-19: Desktop type-check, lint, canonical tests, production build, strengthened Remote Access Electron E2E, hardened package/verification, and an isolated packaged listener-off smoke pass. The final focused Remote Access run passes 119/119 production tests plus 7/7 deterministic transport tests, including production-service revoke-and-pair-again coverage, first-time Tailscale Serve setup from an empty configuration, and cleanup-only migration of the exact origin-only target persisted by pre-acceptance builds. Real-tailnet testing exposed and fixed two production blockers: HTTPS eligibility now comes from the exact certificate domain instead of a pre-existing listener, and the loopback target restores `/api/aiden/v1` after Tailscale strips the public mount prefix. A 1.611-second physical iPhone 13 Pro proof used system trust plus the live Tailscale leaf SPKI pin, paired, authenticated, browsed an approved root, completed workspace CRUD, rejected selection replay, and removed only Aiden's route back to `{}`. Phase 7's bounded-attachment requirement is implemented end to end with one-use device/chat-bound references, canonical Aiden attachment translation, native Photos/file selection, attachment-only turns, path-free metadata, and retry-safe exact-request idempotency. The complete signed iPhone suite executes 70 tests: 65 pass, five live-environment tests are expected skips, and zero fail. One opted-in physical-iPhone proof passed the attachment upload/discard/consume/replay/history flow plus streaming reconnect, approval, duplicate-approval rejection, cancellation, and cleanup over real LAN HTTPS. A second 105.983-second proof passed authenticated reconnection after same-endpoint process replacement, typed `403 credential_revoked` durable revocation, explicit local re-pair with an independent one-use secret, replay rejection, a distinct replacement credential, and another process restart where the new credential remained authoritative and the old one remained revoked. Persisted spike state contains only the active credential SHA-256 digest and a bounded set of prior revoked SHA-256 digests; restart does not reopen pairing, and the deterministic transport suite proves atomic digest replacement plus owner-only marker/state cleanup. A fresh test-free attachment build passed strict deep code-sign verification, contained no XCTest bundle, installed, and launched on the physical iPhone 13 Pro. A fresh generic-hardware attachment Release archive passed store validation, App Intent generation, strict deep code-sign verification, and no-test-bundle inspection. It is development-signed with `get-task-allow=true`, so distribution signing/export is still open. Physical iPad, sleep/wake/address-change/multi-device acceptance, Siri/dictation/direct server-streamed Live Activity system-UI acceptance, and App Store Connect owner metadata/review assets remain open. Evidence is in `docs/testing/aiden-on-the-go/phase-12.md`.

Desktop Tailscale inspection repair 2026-08-25: Settings no longer combines
two independent node/Serve command pairs for one refresh. One atomic inspection
now supplies node identity, HTTPS eligibility, Serve state, and route
classification, and requests `status --json --peers=false` so irrelevant peer
inventory cannot consume the bounded status budget. A transient inspection
still fails closed and never authorizes a route mutation. Live acceptance on
the affected Mac returned the healthy existing route as `other_aiden_live`, the
correct ownership-safe state because that production profile has no persisted
Tailscale ownership record.

Release-readiness follow-up 2026-08-19: the CI mobile gate no longer references the removed Hermex project or an iOS Simulator; it compiles the shipping Aiden app/test bundle for generic iOS hardware and passes locally. The active Aiden shell now includes the reused `AppConfig` foundation and exposes native Privacy Policy and Support links. The canonical live destinations are locked by the focused physical-iPhone integration suite. Contact Sheet's owner identity plus Aiden's live site/repository resolve the public metadata values. Hermex's separate internal/external export-option, manual workflow, and App Store build-selector patterns are adapted for Aiden: separate protected environments, exact confirmation gates, main-only execution, pinned checkout, closed-version-train protection, generic-hardware archive/upload, and upload-only external behavior are locked by 20 Ruby tests/42 assertions plus three deterministic policy tests registered in `npm test`. The published privacy policy still needs mobile-specific copy and the support page needs a visible working contact; no workflow was dispatched and no distribution credential, App Store record, export, upload, tester assignment, or external-review action was created implicitly.

ASC/metadata follow-up 2026-08-19: current Apple definitions resolve the store draft to Developer Tools / Productivity, no developer-collected data, and a conservative 13+ override matching the published under-13 policy. Four additional registered policy tests lock metadata limits/links, manifest/SDK privacy alignment, ASC credential ignores, and telemetry-off strict command guidance. The stable local Rork `asc 3.4.0` client was used read-only: the main app bundle ID and App Groups capability exist under team `5WP229CBB8`, but the active Parsely-named profile exposes no Aiden App Store record, widget identifier, or Aiden distribution profile. Aiden's live website links to an active public **Aiden - Quick AI** TestFlight beta outside that profile's scope; its page describes the existing macOS product and says it is available on iOS, but does not expose the numeric App ID or bundle ID. The correct Aiden credential must reconcile that record before any new record is created. One remote iOS Distribution certificate exists while no local Apple Distribution private-key identity does, and no Apple web session is authenticated. A provisional physical-iPhone `1170 × 2532` pairing-screen capture converted to opaque JPEG passes ASC screenshot validation, proving the real-device pipeline without using a simulator; final distribution-candidate iPhone/iPad assets remain open. No ASC mutation or Codex automation was created because no exact reviewed Aiden App ID/build exists. The owner-gated ASC and future read-only automation runbook is `ios/ASC_CLI.md`.

ASC automation follow-up 2026-08-19: a registered `ios:asc-monitor` repository command now provides the exact future Codex-automation boundary. It requires a named Aiden Keychain profile, a numeric App Store Connect App ID, and an exact build resource ID for processing/TestFlight modes; sets telemetry off; uses strict authentication and read-only CLI verbs; and summarizes TestFlight crashes/feedback as counts, newest timestamps, and fingerprints without persisting tester identity, feedback text, screenshot URLs, or crash content. Processing uses exact `builds info --build-id` rather than an app-wide latest-build dashboard. Six focused tests lock command scope, identifier/profile validation, telemetry policy, read-only review behavior, and privacy-safe output. No automation was created because the authoritative Aiden record/build remains unresolved.

Internal TestFlight follow-up 2026-08-19: the owner-authorized distinct Aiden On The Go App Store record, widget identifier, Apple Distribution identity, and App Store profiles are now provisioned. The train is `0.1.0`; build `1` was rejected before processing with `ITMS-90717` for an alpha-bearing icon. Build `2` replaces it with the exact opaque RayChat Icon Composer package, passes release tests plus archive/export bundle, entitlement, signing, internal-only, and compiled-icon inspection, and App Store Connect reports the exact build `VALID` and `IN_BETA_TESTING`. The internal group contains the account holder. External TestFlight, App Review, and public release were not enabled.

Compact-navigation follow-up 2026-08-19: build `3` replaces the always-on `NavigationSplitView` shell with the retained Hermex adaptive pattern: a value-driven `NavigationStack` on compact iPhone and a split view with a stacked detail column on regular iPad layouts. Workspace taps, creation, folder registration, deep links, deletion, and compact/regular transitions now reconcile explicit selection and path state. Five focused navigation/appearance tests and nine chat tests pass on the physical iPhone 13 Pro; the exact `0.1.0 (3)` app was installed and launched without using a simulator. Its internal-only distribution IPA passed identity, entitlement, signing, widget, and opaque-icon inspection, and App Store Connect build `e5f0ae7e-35aa-451e-be87-bc039885b2de` is `VALID` and `IN_BETA_TESTING` for `Internal Testers`.

ASC localization/privacy follow-up 2026-08-19: canonical `en-US` App Info and version-localization JSON now exist under `ios/app-store/metadata` for the shipping `1.5` draft. Rork ASC's offline validator reports zero errors and zero warnings, and registered policy tests lock the canonical files to the documented name, subtitle, privacy/marketing/support URLs, keywords, description limits, and intentionally omitted optional fields. `ios/app-store/MOBILE_PRIVACY_SUPPORT_COPY.md` supplies ready-to-review live-site replacement/addition copy for mobile pairing/transport, Keychain and device-local caches, attachments and provider forwarding, Apple permission surfaces, App Intents, Live Activities, external media, and a visible support email. Version confirmation, owner/legal approval, and publication on the separately owned website remain external gates; no metadata was applied.

Shipping-target/package follow-up 2026-08-19: the app, test, and widget `PBXSourcesBuildPhase` memberships are now locked by a registered exact-allowlist test that also rejects imported product identity and non-Aiden `/api/*` literals in shipping Swift. At this checkpoint, unlinked packages retained from the Hermex import were removed and KeychainAccess 4.2.2 was the only resolved and linked Swift package. The later Markdown parity follow-up deliberately restored Hermex's MarkdownUI 2.4.1 rendering foundation plus its locked NetworkImage 6.0.1 and swift-cmark 0.8.0 transitive dependencies and notices. A clean generic-hardware Release compile and the focused signed integration suite on the physical iPhone 13 Pro passed after the cleanup without using a simulator.

Native-shell refresh follow-up 2026-08-19: onboarding is now a concise Aiden welcome, Mac preparation, and secure QR-pairing flow. The adaptive home places Scheduled Tasks, privacy-safe Mac Usage, all workspaces, and globally chronological chats behind a Hermex-informed native list; its profile control opens the single App Settings surface, while per-workspace permission/files/Git remain in Workspace Settings. New Agent creates an Aiden-managed scratch workspace, the compact composer restores Hermex's attachment/model/thinking/voice rhythm with the Aiden logo, and transcript activity groups reasoning and tool calls without brain/sparkle identity. Berry dark uses an accessible berry accent shared exactly by Electron, protocol fixture, and Swift. The top-level iOS project is Aiden-owned MIT while required upstream notices remain bundled. All 215 non-shipping imported Swift/test files and their 430 isolated Xcode objects were removed; a registered gate now enforces the exact 31-file app/test tree, brand asset hash, shell ordering, composer affordances, and absence of brain/sparkle glyphs. The new `/usage` route uses existing `server:read` authority and projects aggregate Mac totals only. The full physical iPhone 13 Pro suite executed 73 tests: 68 passed, five environment-gated live proofs skipped, and zero failed. A clean `0.1.0 (5)` app installed and launched on that phone. A cold real connection proved successful `chats`, `scheduledTasks`, and `usage` loads after correcting the connected-state trigger discovered in build 4. The internal-only Apple Distribution IPA passed app/widget identity, App Group, entitlement, no-test-bundle, and strict deep-signature inspection; App Store Connect build `6173d5e2-0e58-4d0a-92fa-fc804fc82c37` is `VALID` and `IN_BETA_TESTING` for `Internal Testers`, with external testing `NOT_APPLICABLE`.

Final shell follow-up 2026-08-19: build `6` closes the remaining locally actionable migration defects found by a fresh source and physical-device audit against `/Users/sambitbiswas/projects/opp/hermex`. New Agent now creates a managed scratch workspace before creating its chat. Cold navigation requests are retained until the coordinator is connected instead of cancelling their own task, and handoff chats have an explicit native Close action. The Live Activity extension now embeds the exact tintable Aiden sidebar artwork and uses it for starting/thinking in every size instead of brain/sparkle glyphs. The registered shipping-target test locks all four behaviors. The complete physical iPhone 13 Pro suite again executed 73 tests with 68 passes, five expected live-environment skips, and zero failures; no simulator or iPhone 16 Pro Max was used. The iOS release suite passes 20 Ruby tests/42 assertions plus 23 Node tests, and the desktop Remote Access suite passes 120 production tests plus seven transport proofs. The internal-only local IPA reports `0.1.0 (6)`, exact app/widget/App Group identities, `TFInternalTestingOnly=true`, Apple Distribution team `5WP229CBB8`, `get-task-allow=false`, no XCTest content, the widget Aiden logo resource, and a valid strict deep signature. Exact App Store Connect build `aa994233-1bf3-4482-86f5-b8b0356eee25` is `VALID`, assigned to `Internal Testers`, `IN_BETA_TESTING`, and external testing remains `NOT_APPLICABLE`.

Interaction and streaming follow-up 2026-08-19: the retained Hermex implementation was audited and confirmed to stream through resumable Server-Sent Events, not WebSockets. Aiden On The Go keeps its stricter SSE path with event IDs, replay cursors, reconnect, reasoning/tool/approval events, and authoritative terminal reconciliation. The exact dependency-free Thinking Orbs `0.3.1` iOS SwiftUI port is vendored with its MIT notice and maps queued, reasoning, tool, approval, token, and completion phases to the same visual states used by Aiden Agent, including reduced-motion behavior. New Agent is now a native Liquid Glass action offering an existing workspace, a new reusable workspace, or a managed scratch workspace; selecting an existing workspace creates only the chat and avoids registry bloat. Chat send, rename, delete, approval, cancellation, and workspace mutations render hopeful local state immediately, then replace it with the server's canonical result or roll back/reconcile on failure. Home and workspace chat timestamps update from `just now` through minutes, hours, and days; home message counts and top-level workspace/scheduled-task badges are removed. The shipping-target suite passes 6/6, Thinking Orbs passes its 72-case/70,115-value golden-vector suite, and the signed physical iPhone 13 Pro suite executes 74 tests with 69 passes, five expected environment-gated skips, and zero failures. A separate clean test-free build passed strict deep-signature inspection, installed, and launched on that phone. No simulator, iPhone 16 Pro Max, App Store Connect mutation, archive, or TestFlight upload was used for this local refresh.

Composer-overlay follow-up 2026-08-19: screenshot review exposed that the chat used an opaque `.bar` safe-area inset beneath a material composer, cutting the selected Aiden canvas off above the control, while the send arrow relied on the system `.background` role and lost contrast when disabled. The chat now follows the retained Hermex overlay geometry: its transcript remains the full theme canvas and scrolls beneath a bottom-aligned composer, with a measured transparent tail spacer keeping the latest content reachable above the control. The composer uses native interactive Liquid Glass on supported iOS versions, a theme-raised opaque fallback under Reduce Transparency, and regular material on older systems. Send states are explicit Aiden palette roles: active uses accent/canvas contrast, disabled uses foreground/secondary contrast, and stop uses foreground/canvas. A registered source regression rejects an opaque `.bar` return and locks the overlay/glass/theme roles. All six shipping checks and the complete physical iPhone 13 Pro suite pass: 74 total, 69 passed, five expected environment skips, and zero failed. A clean test-free app passed strict signing inspection, installed, and launched on that phone; no simulator or TestFlight upload was used.

Composer-focus/model follow-up 2026-08-19: composer focus is owned by the chat shell so tapping anywhere in the transcript dismisses the keyboard, while interactive downward scrolling retains native swipe-to-dismiss behavior. The model menu now makes every model with declared `thinkingLevels` a submenu whose children are those exact server-projected levels; selecting a child atomically updates provider, model, and thinking level. Models without levels remain direct actions. The separate thinking sibling control is removed, and the model trigger shows the Aiden thinking mark plus the selected level when applicable, including a combined accessibility value. Registered source checks lock focus handoff, tap/swipe dismissal, nested thinking menus, and absence of the former sibling picker. All six shipping checks and the full physical iPhone 13 Pro suite pass at 74 total, 69 passed, five expected environment skips, and zero failures. A clean test-free build passed strict signing inspection, installed, and launched on that phone. No simulator, iPhone 16 Pro Max, ASC mutation, archive, or TestFlight upload was used.

Internal TestFlight build 7 follow-up 2026-08-19: after explicit owner authorization, the project build number advanced to `7` while the internal train remained `0.1.0`. The release gate passed 20 Ruby tests/42 assertions plus 23 Node tests, and the latest physical iPhone 13 Pro suite remained green at 74 total with 69 passes, five expected environment skips, and zero failures. A generic-iOS Release archive was exported with the internal-only policy and the resulting IPA reported `TFInternalTestingOnly=true`, exact app/widget/App Group identities, Apple Distribution team `5WP229CBB8`, `get-task-allow=false` for both targets, no XCTest content, valid strict deep signing, and opaque compiled iPhone/iPad icons. The exact IPA was uploaded through telemetry-off strict authentication with the named `Parsely ASC` profile. App Store Connect build `717b6381-4dec-4cce-85d1-72b503c28590` processed as `VALID`, is related to exact group `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), reports `internalBuildState=IN_BETA_TESTING`, and keeps `externalBuildState=NOT_APPLICABLE`. No external group, Beta App Review, App Review, public availability, metadata, pricing, or screenshot mutation occurred.

App Intent handoff follow-up 2026-08-19: a cold physical-iPhone launch through `aiden-otg://new-chat` exercised the same bounded URL emitted by the New Chat App Intent. With no paired installation, the installed app failed closed before creating or sending a chat and presented the correct connect-first action. Physical screenshot review exposed a misleading “Couldn’t Pair” alert title inherited from the pairing shell; the title is now the neutral Aiden product name, an eighth focused integration assertion locks the copy, and a repeated cold launch confirmed the corrected result. Temporary screenshots and DerivedData were moved to Trash. Siri/Shortcuts phrase invocation itself remains a manual system-UI gate.

ActivityKit follow-up 2026-08-19: a real signed physical-iPhone lifecycle test exposed that ActivityKit's rendered `activity.content` can lag an awaited update. The production manager previously derived each event from that public rendered snapshot, so rapid tool/token/stale events could overwrite semantic state. It now maintains canonical MainActor-isolated state per Activity ID, adopts persisted state only during reconciliation, refuses updates to ended/dismissed activities, and clears terminal cache entries. One regression performs a real request, fires rapid tool → token → stale transitions, confirms private-by-default responding/stale state, and immediately removes the activity. A second physical regression releases the original manager, creates a fresh manager in the same test host, adopts the system-persisted activity, and verifies the exact bearer-authenticated, protocol-versioned stream-status request and reconciled rendering through `AidenRemoteClient`. The guarded `ios:activitykit-process-proof` command then builds once, starts a unique activity in one host process, proves that host has exited, reuses the installed destination artifacts without app reinstallation, and passes the same authenticated adoption and terminal cleanup in a distinct host process. It validates matching physical CoreDevice/Xcode identities, has failure cleanup, and is locked by four registered Node tests. The focused suite passes 11/11 and the full physical target passes 70 total with 65 passes, five intentional live-environment skips, and zero failures. Only direct system-UI observation of a real server-driven activity remains manual for this path.

Post-proof release-gate refresh 2026-08-19: the complete canonical `npm test` lifecycle passes after the ActivityKit runner registration, including the Aiden Remote pretest matrix, iOS release policy suite, Electron tests, and native helper suites. A telemetry-off, strict-auth ASC refresh remains unchanged: only the Parsely-named Keychain profile is active; the exact Aiden bundle query exposes no App Store Connect record; filtered Developer Portal results contain the main identifier but not the Live Activity widget; no Aiden iOS App Store profile exists; and the local Keychain has no Apple Distribution identity. No ASC mutation or Codex automation was created. The owner authorizes using `Parsely ASC` for Aiden within its visible scope, with explicit profile selection and exact identifiers; its zero-app result remains insufficient authority to create a duplicate record.

Hermex Markdown parity follow-up 2026-08-19: transcript inspection against `/Users/sambitbiswas/projects/opp/hermex` found that Aiden On The Go was parsing completed replies with inline-only `AttributedString`, leaving block headings and lists visible as punctuation. The same assistant layout used a trailing spacer that could squeeze long content and clip the stored leading `I` from `I'll explore…`. Completed and streaming replies now use the exact Hermex `swift-markdown-ui` 2.4.1 renderer, receive the full proposed transcript width, and retain Aiden palette typography. User prompts remain literal content-sized bubbles like Hermex rather than being stretched by the full-width renderer. Parsing is bounded to 80,000 characters and 2,000 lines with literal-text fallback; Markdown images are deliberately suppressed through a no-network provider. Required MarkdownUI, NetworkImage 6.0.1, and swift-cmark 0.8.0 notices are bundled and release tests lock the resolved graph. Fourteen focused chat tests pass, and the complete physical iPhone 13 Pro target passes 78 total with 73 passes, five expected environment-gated skips, and zero failures. A generic physical-iOS compile and the release policy suite (20 Ruby tests/42 assertions plus 23 Node tests) also pass. The app was launched on the phone for visual confirmation. This is a local follow-up after TestFlight build 7; no simulator, archive, ASC mutation, or upload occurred.

Markdown/attachment correction follow-up 2026-08-20: fresh device screenshots showed a first assistant glyph still touching the renderer boundary and exposed that the `+` menu embedded a `PhotosPicker` directly inside `Menu`, unlike Hermex's state-driven external presentation. The assistant row now owns full width while the MarkdownUI renderer keeps its intrinsic block layout without a root `fixedSize`; both completed and live text continue through the same locked MarkdownUI 2.4.1 path. The composer now uses Hermex's deferred UIKit menu bridge to open external Photos and Files presentations. A separate send-path defect was also corrected: the turn request is built from the captured uploaded references before hopeful UI clearing, so attachment IDs reach the Aiden server and remain single-use. Source checks reject nested `PhotosPicker` wiring and lock request construction order. Sixteen focused chat tests pass, including rendered first-glyph bounds and attachment-reference preservation, and the complete physical iPhone 13 Pro suite passes 80 total with 75 passes, five expected environment-gated skips, and zero failures. No simulator, archive, ASC mutation, or TestFlight upload was used.

Home glass-navigation follow-up 2026-08-20: the provided `/Users/sambitbiswas/Downloads/CustomTB/CustomTB` reference established a separate prominent bottom action with an anchored popover, while Hermex established native interactive Liquid Glass with reduced-transparency and pre-iOS-26 fallbacks. Aiden's New Agent action now opens an anchored, compact-popover-preserving three-row chooser for an existing workspace, reusable new workspace, or managed scratch workspace; its existing creation and server-confirmation flows are unchanged. The chooser hides during search and uses a zoom transition from the prominent action. The search/settings capsule now uses native interactive `.glassEffect(.regular.interactive())` on supported devices, ultra-thin material on older systems, and an opaque palette-raised surface under Reduce Transparency. Registered source coverage locks the popover and glass path, and XCTest locks the exact three choices. The iOS release suite passes 20 Ruby tests/42 assertions plus 23 Node tests, and the complete physical iPhone 13 Pro suite passes 81 total with 76 passes, five expected live-environment skips, and zero failures. No simulator, archive, ASC mutation, or TestFlight upload was used.

Compact approval follow-up 2026-08-20: the live iOS approval card now mirrors Aiden Agent Mac's reviewed hierarchy instead of using oversized default SwiftUI controls. It uses the `shield` SF Symbol in a 32-point warning badge, a small-semibold approval title, caption helper copy, a compact monospaced summary well, and right-aligned `Deny` / `Allow once` actions. Both actions render as native interactive Liquid Glass on supported devices; older and Reduce Transparency modes retain themed material/opaque fallbacks. Visible action capsules are 34 points tall while outer padding preserves a 44-point touch target. Registered source coverage locks the shield, typography, labels, and both native glass paths. The iOS release suite passes 20 Ruby tests/42 assertions plus 23 Node tests, and the complete physical iPhone 13 Pro suite remains 81 total with 76 passes, five expected live-environment skips, and zero failures. No simulator, archive, ASC mutation, or TestFlight upload was used.

## Test inventory

### Electron

- Remote service disabled/listen lifecycle.
- Pairing expiry, single use, rate limits, token digest, rotation, and revocation.
- Authorization on every route and SSE reconnect.
- DTO projection excludes secrets and unsafe paths.
- Workspace CRUD invariants, approved-root identity/policy changes, token-digest isolation, cursor binding, atomic selection consumption, expiry/replay, traversal/symlink/root-replacement escape, permission elevation audit, broadcasts, and mutation races.
- Chat CRUD/deletion/reconciliation races.
- Atomic append/start behavior.
- SSE ordering, replay bounds, heartbeat, terminal persistence, and restart interruption.
- Approval ownership, expiry, duplicate decision, device revocation, and desktop/remote overlap.
- Request size, attachment, malformed JSON, path injection, CORS/origin, and log-redaction tests.
- Workspace file-handle instance/device/workspace isolation, 4,000-entry/depth-20 truncation projection, root replacement, read bounds, expected-version conflicts, and save reconciliation.
- Git allowlist projection, nested-workspace capability, bounded diff, stale snapshots, canonical-repository serialization, branch/commit/push confirmation, disconnect-safe ownership, worktree ownership/rollback, and concurrent desktop/mobile operations.
- Scheduled-task schema validation, revisions/CAS, DST/timezone preview, internal-field/credential/output projection, idempotent durable run ownership, settings, lifecycle actions, run history, disconnect behavior, workspace/provider changes, and concurrent edits.
- Tailscale Serve conflict/ownership tests proving that unrelated routes and Funnel state are untouched.
- Onboarding and 1024 x 1024 asset contract.

### Swift

- Pairing and certificate/token storage.
- Multi-installation credential isolation.
- Aiden endpoint request and tolerant response decoding.
- SSE sequence, replay, reset/snapshot, duplicate suppression, and terminal convergence.
- Chat list/detail/mutation/send/cancel/approval.
- Workspace list/create/update/remove and authoritative reconciliation.
- Approved-root folder navigation, pagination, selection-token expiry, and registration.
- Offline cache scoping.
- Theme preset/token fixtures and accessibility settings.
- iPhone/iPad navigation-state coverage.
- Workspace-settings ellipsis routing and absence of permission controls in the composer.
- File index/read/edit/version-conflict and Git review/diff/branch/commit/push/worktree flows.
- Scheduled-task list/editor/preview/lifecycle/run-history flows.
- Bot DTOs/capabilities, disjoint Workspace/Bot chat projection, per-installation mode/cache, versioned Full notice, Full-to-Custom changes, per-chat reductions, and effective-access summaries.
- One durable non-Git managed home per bot, shell starting there, ordinary artifacts saved there, outside-home inspection only when needed, and resistance to editable-instruction override.
- Shared `AidenChatDetailView` use for Workspace and Bot conversations, with no duplicate transcript/composer/stream/approval implementation.
- Semantic avatar fallback plus Image Playground availability, cancel/failure, accepted-image upload, paired-Mac canonical persistence, and temporary-file cleanup.
- Cache-only App Intent entities/current-SDK navigation/deep links/cold/stale launch with assertions that the intent process makes no network/Keychain access; Live Activity sub-4 KB reducer/stale/reconciliation/privacy behavior; native and explicit paired-Mac dictation authorization/lifecycle; absence of voice-note paths; bounded no-retention paired-Mac audio; and read-aloud lifecycle.

Retain and adapt the useful Hermex API, auth, session, chat, SSE, cache, navigation, appearance, workspace, Git, file, Tasks, App Intents, Live Activity, and voice tests. Remove Kanban, Skills, Memory, Insights, and other deleted-feature tests from the target rather than leaving skipped suites. Hermes Cron fixtures do not survive unchanged; only the native Tasks UI/test patterns are reused against new Aiden DTOs.

## Research inputs

- Local Apple identity baseline: `/Users/sambitbiswas/projects/contactsheet/Contact-Sheet-Generator/ContactSheetGen.xcodeproj/project.pbxproj`.
- Current App Intents navigation APIs: [AppIntent](https://developer.apple.com/documentation/appintents/appintent) and [OpenIntent](https://developer.apple.com/documentation/appintents/openintent).
- Live Activity lifecycle and extension limits: [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
- Speech authorization and privacy behavior: [Asking Permission to Use Speech Recognition](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition).
- Current Serve lifecycle, status, route-specific `off`, and destructive reset semantics: [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Device-only workspace archive follow-up — 2026-08-20

Workspace rows now use Hermex's reviewed long-press plus bidirectional swipe pattern with full-swipe disabled. Archive state is local to each paired installation on the current iPhone/iPad, persists across relaunch, and presents a one-time disclosure before the first archive. Active and archived workspaces have separate searchable views; archived workspace chats, New Agent choices, adaptive navigation destinations, deep links, and cached App Intent entities are hidden on that device until unarchived.

Rename keeps the existing hopeful revision-checked server mutation, retains a failed quick-rename draft, and explicitly distinguishes the shared Aiden display name from the unchanged disk-folder name. Remove from Aiden Agent reconciles revision conflicts and ambiguous completions against a fresh canonical registry and explains that folders, files, and chat data remain on the Mac while removed-workspace chats become unlisted. Managed scratch workspaces retain the separate managed deletion path because generic record removal would discard crash-recovery authority, and ordinary removal is hidden for the sole registry workspace to match the desktop invariant.

Fresh-memory iOS, persistence, and server reviews closed cross-installation response races, optimistic-pruning rollback loss, authoritative-empty pruning, archived-row navigation, pre-shell App Intent filtering, sole-workspace removal, and operational-server-error state gaps. Coordinator loads and mutations are installation-generation-bound; archive pruning happens only inside a confirmed authoritative snapshot. Eleven focused archive/navigation/coordinator tests pass on the physical iPhone 13 Pro, including rejected-removal rollback, empty-snapshot pruning, and reversed installation completion. The filesystem-boundary HTTP test now proves unregister leaves a real file intact. No simulator was used.

## Usage dashboard and home continuity follow-up — 2026-08-20

The privacy-safe Mac Usage destination now presents the server's real 30-day aggregate as an Aiden-native dashboard: request/token summaries, active-day and streak metrics, a token heatmap, token and activity breakdowns, and top-model rows. Every surface uses the selected appearance palette and accessible semantic labeling. Reference-only fields that Aiden does not expose—such as longest task, skills, and plugins—remain absent rather than being fabricated.

The home list now owns a palette-backed bottom safe-area inset for New Agent instead of adding a synthetic clear list row. This preserves the action's scroll clearance without exposing a mismatched white band after the final chat. Shipping source checks pass 6/6, the signed app/test bundle builds for the connected physical iPhone 13 Pro, and focused tests cover usage decoding and presentation math. No simulator, archive, App Store Connect mutation, or TestFlight upload was used.

## Provider identity and reply-copy follow-up — 2026-08-20

The iOS asset catalog now mirrors all 40 reviewed provider SVGs from Aiden Agent. A shared resolver preserves desktop aliases, model-specific Claude/Grok identities, numbered local-provider fallbacks, multicolor rendering, and a neutral initial fallback. Usage model rows, the chat composer model menu, and scheduled-task provider/model selectors now present provider icons with provider-grouped model names.

Completed and streaming assistant replies expose a Hermex-style long-press Copy action plus an accessibility action; the clipboard receives the original Markdown rather than rendered text. A requested GPT-5.6 Terra xhigh review verified byte-for-byte asset parity and found the scheduled-task, streaming-copy, and iOS-notice gaps; all three were corrected. The registered source/asset gate passes 7/7, a signed build-for-testing succeeds, and 23 focused chat, scheduling, and usage tests pass on the physical iPhone 13 Pro. No simulator, archive, ASC mutation, or TestFlight upload was used.

## Confirmed product decisions

1. **Workspace scope:** Mobile has full Aiden workspace-registry CRUD, including folderless and managed-scratch creation, may explore approved folders on the paired Mac and register a selected folder, and later gains Aiden's existing file index/read/version-checked-write capabilities. It does not accept free-form Mac paths or invent file create/rename/delete operations.
2. **Remote permissions:** Mobile turns honor the workspace's saved `full`/`ask`/`none` permission and show approvals on the phone. Permission lives in `Workspace Settings` under the conversation-toolbar ellipsis, never in the composer.
3. **Workspace creation:** The phone uses a server-controlled approved-root directory browser and a short-lived opaque selection token. New selected-folder workspaces default to `ask`.
4. **Appearance:** Aiden On The Go appearance is independent and stored locally on the phone/iPad.
5. **Expanded native scope:** App Intents, Live Activities, voice, Aiden Git/files, and scheduled tasks are planned after the stable chat/workspace core. Share Extension, generic Terminal UI, Computer Use controls, and cloud push remain deferred; the Mac-owned shell tool inside an authorized Bot turn is separately approved.
6. **Apple identity:** Use automatic signing with team `5WP229CBB8`, the `sbtbiswas.*` bundle namespace, `group.sbtbiswas.AidenOnTheGo`, URL scheme `aiden-otg`, and SKU `aiden-on-the-go-ios`, subject to the Phase 0 provisioning preflight.
7. **Tailscale ownership:** Aiden provides explicit Connect/Disconnect, previews the exact non-Funnel Serve change, records ownership, and removes only the route it created without altering unrelated routes.
8. **Bot-first platform:** Redesign iPhone/iPad now around the Aiden-logo Bots/Workspaces switcher. Defer the Mac inbox/shell/Access redesign; Mac work is limited to authoritative runtime/persistence integration and canonical-photo display in existing surfaces.
9. **Shared chat:** Every Bot conversation reuses the existing Swift `AidenChatDetailView` and its existing chat feature/view-model path. Bot identity and Access affordances wrap it; no second chat engine or copied transcript/composer is allowed.
10. **Bot access:** Every valid new or migrated bot defaults to explicit Full Access after one versioned notice. Custom may reduce Files, shell, Connections/MCPs, Skills, and other capabilities per bot; a chat may narrow but not exceed its bot.
11. **Bot home and shell:** Every bot has one hidden, durable Aiden-managed home. Shell is allowed and starts there, ordinary artifacts are saved there, and Full may inspect other OS-accessible Mac locations as needed. The main-owned system instructions enforce this behavior.
12. **Git boundary:** Bot home provisioning creates no Git repository, branch, or commit. Git is not categorically blocked when the task makes an existing or explicitly initialized repository relevant, but mobile still exposes no generic terminal or command endpoint.
13. **Bot photo:** System Image Playground, including Private Cloud Compute where Apple uses it, is acceptable on supported phones. Only the accepted normalized image is sent to the paired Mac and stored as the canonical bot photo; semantic avatars remain the fallback.

The foundation phases above remain historical. Bot-first implementation begins with Phase 0 of `bot-first-aiden-on-the-go-plan.md`; later Bot phases remain gated by its acceptance criteria and independent review rather than unresolved product decisions.

## First-class pairing choices follow-up — 2026-08-22

The iOS pairing surface now exposes the same connection choices as Aiden Agent's Add Device flow. The primary list presents Scan QR Code, Nearby Mac + Setup Code for local Wi-Fi/Bonjour, and Private Address + Setup Code for Tailscale; Paste Pairing Payload remains an advanced camera-unavailable fallback. Each route reuses the reviewed five-minute, one-use trust protocol rather than defining a second authentication mechanism. The QR path explicitly states that it already carries the Mac-selected Local Network or Tailscale endpoint, while manual paths request the exact address and setup code shown on the Mac.

Focused contract tests lock the complete method inventory and Mac/iOS labels, while the shipping-source gate requires both canonical endpoint forms. The full Remote Access, release, repository, type, lint, build, generic iPhoneOS, and signed physical-iPhone gates pass. Remaining physical-iPad and hands-on cross-network acceptance stay open under the existing Phase 12 gates.

## Progressive iOS onboarding and pairing follow-up — 2026-08-22

First launch now introduces Aiden On The Go through three concise, swipeable capability pages derived from Aiden Agent's Mac onboarding groups: Build in your workspace, Choose and extend, and Automate and stay in control. The pages reuse the reviewed Mac workspace, model-freedom, and scheduled-automation PNGs byte for byte, omit provider setup because credentials remain Mac-owned, and follow the focused-page, dominant-artwork, single-bottom-action pattern reviewed in `LPOnBoarding`. Completion is device-local and recorded only after the user reaches connection setup, so an interrupted introduction resumes while settings-based Add Device remains direct.

Connection setup now progressively discloses the three primary paths in a native segmented tab bar backed by a swipeable page container: QR, Nearby, and Tailscale. Each page retains its existing one-use pairing protocol and validation. Full-payload paste remains available from the overflow menu as a recovery path rather than competing with primary setup. Source contracts lock the three-tab order, swipe container, one-time onboarding behavior, Liquid Glass primary action, exact artwork parity, and the advanced fallback. A generic iPhoneOS test build, the complete iOS release-policy gate, and 14 focused native integration tests pass on the physical iPhone 13 Pro without using a simulator. Physical-iPad and hands-on visual acceptance remain open.

All onboarding identity now uses the actual shipping Aiden app icon rather than the sidebar thinking mark. The capability Continue/Set Up Connection action, Prepare Your Mac's Choose How to Connect action, and QR setup's Open Camera action share one native Liquid Glass prominent-button primitive on supported systems with the reviewed bordered fallback on older iOS versions.

The onboarding tour is window-adaptive rather than device-branched: compact and narrow Stage Manager widths use all available space, while wide iPad windows center a stable maximum 620-point content measure and 760-point height. Artwork is stable across slides, copy stays within a readable measure, the primary action caps at 360 points, and a vertical `ViewThatFits` falls back to scrolling for constrained height or larger Dynamic Type. QR's Open Camera action now sits centered at the bottom safe area outside Form rows with no surrounding list container.

All onboarding primary actions now use one shared 360-point bottom-safe-area layout with identical 24-point horizontal and 12-point bottom spacing. The capability pager keeps its page indicator above the action without moving the button baseline, so Continue/Set Up Connection, Choose How to Connect, and Open Camera remain visually stationary between steps.

## Bidirectional chat-image and terminal-outcome follow-up — 2026-08-22

Chat attachment metadata remains path-free and inline-data-free, while a new authenticated `chat:read` content route returns only the exact PNG or JPEG bytes for an attachment already present in that authoritative chat. The route binds chat and opaque attachment identity, fails closed on duplicate projected identifiers, verifies MIME signatures, stored sizes, and the 8 MiB bound, and never exposes text attachments or local paths. iOS stores validated images in a protected installation/device/chat-scoped cache with bounded pruning and corrupt-entry eviction.

Sent text keeps its own compact message bubble, while image media is a separate sibling beneath it on the chat background. One image renders aspect-fit without a surrounding message container. Multiple images use a bounded, interactive native SwiftUI card deck adapted from BigUIPaging's CardDeck example: every selected photo remains fully visible in an aspect-fit viewport, one neighbor per side stays visibly offset, scaled, and rotated, horizontal movement tracks the finger directly with resisted edge over-drag, and a short interruptible spring snaps the chosen card into place. Only two or three masked images remain in the live render tree, only the selected card casts a reduced shadow, and a content-addressed 32 MiB thumbnail cache prevents repeat 960-pixel decoding while paging. Tapping the selected card opens the system page viewer. Saving is user-initiated, requests add-only Photos permission at the action point, stages one bounded image at a time, and commits Save All as one Photos transaction. PNG bytes and transparency are preserved when possible. Large Photos selections use a bounded file transfer instead of first materializing the entire source in memory, and view dismissal cancels preparation and decode work. The unmaintained BigUIPaging package is not a dependency; only its interaction model informed Aiden's native implementation, and its temporary checkout was removed after review.

Remote terminal outcomes now survive disconnect and replay. Mac initialization cancellation carries an explicit cancellation signal even when no generation timeline exists; completed, failed, and cancelled assistant messages expose only a fixed renderer-safe outcome projection. iOS consumes the terminal SSE event before cleanup, retains the durable cursor/live response when authoritative reconciliation is temporarily unavailable, and retries reconciliation without presenting cancellation as success. Provider diagnostics, reasoning, tool payloads, and raw errors remain Mac-private.

If a retained stream is definitively gone after a Mac restart or journal expiry, iOS falls back to the authoritative chat instead of retrying the missing stream forever. It resolves only the assistant response after the latest user turn; when that response was never persisted, the current run is marked interrupted rather than borrowing an older turn's outcome. Photos transfers preserve the original display filename independently of their extensionless temporary file.

## Sender-edge image-deck refinement — 2026-08-22

The inline deck now preserves the sender-side spatial anchor during interaction: user media stays trailing, assistant media stays leading, and only the selected front card consumes live drag progress. Rear cards remain fixed until selection commits, eliminating whole-stack drift and reducing per-frame transforms while preserving edge resistance, flick selection, reduced-motion behavior, rounded media, and the full-screen viewer.

The fitted-image mask is applied before the sender-aligned layout frame expands. Portrait and landscape images therefore keep all four continuous corners instead of allowing the frame boundary to square off the edge opposite the sender.

The complete repository suite, type-check, lint, production build, generic iPhoneOS build, iOS release policy, Remote Access and attachment suites, and the full Apple Development-signed XCTest target pass. The final native run used the connected physical iPhone 13 Pro; no simulator or iPhone 16 Pro Max was used.

## Client-device identity follow-up — 2026-08-24

Connected iPhone and iPad clients now publish a bounded presentation identity instead of relying on UIKit's privacy-era generic `iPhone`/`iPad` value. iOS prefers a specific user-assigned device name, falls back to the cleaned local hostname, and finally uses a stable typed display suffix derived from the vendor-scoped installation identifier. The authenticated server projection returns the Mac's current label for only the calling device; a newer client refreshes it only when stale through `PATCH /device/identity`, so existing pairings heal without repeated state writes or re-pairing.

This label never becomes an authentication key. Remote `deviceId` and credential identity remain Mac-pair-specific. Future iCloud sync should reconcile an account-scoped display record separately, as recorded beside the iOS identity builder, without widening or replacing Remote authentication.

## Bot final-reply projection follow-up — 2026-08-24

Bot chats now separate the persisted assistant transcript at the last tool activity boundary: intermediate narration is deduplicated and kept inside the collapsed activity disclosure, while only the terminal answer is rendered as a normal assistant bubble or copied from the Bot reply. Direct Bot answers without tool activity remain visible. Workspace chats preserve their existing completed and streaming presentation.

The Remote stream projection can reset before sending a cumulative replacement. Bot reconciliation now clears the old ephemeral accumulator at that reset so replacement text cannot be appended to an earlier copy. Three focused projection tests cover UTF-16 boundaries, repeated progress, direct replies, and Bot-versus-Workspace copy behavior; the focused physical-device chat suite passes 63/63 and the complete physical iPhone 13 Pro suite passes 281 tests with six expected environment-gated skips and zero failures. Version `0.1.0 (21)` was archived from commit `e457df9d8`, uploaded with the internal-only policy, processed as `VALID`, and assigned only to Internal Testers as `IN_BETA_TESTING`; external testing remains `NOT_APPLICABLE`.

## Android Workspace-home and cache parity follow-up — 2026-08-24

The Android Workspace root now follows the shipped iOS structure with the exact Aiden app-icon product switcher, search/profile capsule, Scheduled Tasks, Usage, and Workspaces destinations, globally recent chats, and the same Existing Workspace, New Workspace, and Managed Scratch Workspace creation choices. The Active/Archived workspace browser is a nested directory rather than a peer tab. Compose spacing is normalized around a single system-inset owner, and visible borders are removed from buttons, chips, fields, and selection surfaces.

Product switching keeps both Workspace and Bots roots mounted. Activity-scoped ViewModels publish cached data immediately and refresh once for each authenticated Remote client; Bot lists, conversations, and avatars are scoped by Mac installation plus paired-device identity. Workspace chat cache observations are constrained to the active workspace inventory. Chat ViewModels carry the same installation/device identity in their lifecycle key. SSE uses a cancellable `callbackFlow` on `Dispatchers.IO` and closes the underlying OkHttp call when collection ends, preventing product/navigation changes from retaining obsolete readers.

The Android debug unit suite passes 77 tests, including installation/device cache isolation, warm selection fallback, relative timestamps, and cancellation of a never-ending SSE response. Lint and debug assembly pass. The APK was installed in place on the USB Pixel 10 Pro XL (`54241FDCQ00033`), preserving pairing and caches; the landing page, creation sheet, directory, and immediate cached return to Bots were visually verified on-device.

## Android image showcase parity follow-up — 2026-08-24

Android now shares iOS's image-media hierarchy for both Workspace and Bot conversations. Safe PNG/JPEG media is removed from text bubbles: one image becomes a transparent sender-aligned aspect-fit showcase, while two through twenty images use the selected-plus-neighbors stacked deck with mirrored sender-edge geometry, resisted edge drag, one-card flick selection, selected-only shadow, and TalkBack next/previous/open actions. Invalid, duplicate, unsupported, zero-byte, and oversized descriptors remain ordinary fallback attachment rows.

The full-screen black Compose pager opens at the exact selected attachment, activates selected ±1 pages only, exposes filename or `X of N`, dots, retry, close, Save Image, and Save All Images, and retains original PNG/JPEG bytes. Inline thumbnails decode to at most 960 pixels and viewer images to at most 2,560 pixels through a content-and-resolution-keyed, 24-entry/32 MiB memory cache. Raw bytes remain under the installation/device/chat/attachment-scoped 96 MiB disk cache and now write atomically. Cache misses coalesce, use only the bound authenticated Remote client, reject stale-installation publication and MIME/size mismatch, and bound both network and picker streams before allocation.

The full JVM suite passes 84 tests, including iOS-matching deck math, selected-neighbor activation, safe-image admission, resolution-aware keys, raw-cache scope, and bounded authenticated attachment responses. Lint and debug assembly pass. A Compose instrumentation test on the USB Pixel 10 Pro XL proves a three-image deck advances one page and opens `2 of 3`; a real cached single-image chat and viewer also passed visual inspection. The Gradle connected-device lifecycle removed the debug package after its test and therefore cleared the app-private pairing credential; after the final APK was installed, the user manually re-paired it and the live Connected state plus Workspace landing were verified.

## Android post-pair loading and Usage parity follow-up — 2026-08-24

Live USB-Pixel and Mac server evidence isolated the connected-but-empty Bots/Usage report to a missed post-pair feature-home load: the persisted installation had the correct Mac instance and Bot/server grants, the Mac held two Bots plus tracked Usage, and no feature requests were issued until a cold relaunch. The Android ViewModels now own authenticated client/CONNECTED observation, synchronously deduplicate overlapping Compose/lifecycle triggers, preserve independently successful Bot segments, request archived Bot identities like iOS, and distinguish absent/error snapshots from an authoritative empty list. Usage failures remain retryable and can fall back to a bounded installation/range-scoped local summary instead of requiring a relaunch.

The bare Usage list is replaced by the shipping iOS information architecture in native Compose: a large dismissible sheet, activity/date hero, two-column overview and total-token cards, a zero-filled 10-column 30-day token heatmap with matching intensity math, token mix, completion/local/failure/cost insights, the first five model rows with provider artwork, and the privacy-safe aggregate disclosure. Semantic raised surfaces replace visible outlines. The JVM suite, Android lint, and debug assembly pass; the APK is installed in place on the exact USB Pixel so the repaired pairing remains intact, and live Workspace chats, two Bots, non-zero Usage, metric accessibility descriptions, and the dashboard sheet were verified against the active Mac profile.

Long-form Android modal sheets now disable the sheet-level drag connection and let their internal scroll container own vertical gestures. This removes the expanded-boundary jitter reproduced in Usage and prevents the same nested-scroll conflict in Scheduled Tasks, Settings, pairing, folder browsing, Bot access, and the scroll-heavy Git sheets; compact action sheets remain draggable. The misleading drag handle is omitted, while scrim, Back, and explicit dismissal controls remain available. Repeated boundary pulls on the installed Pixel kept the Usage sheet bounds fixed.

## Native and paired-Mac speech-input follow-up — 2026-08-24

The external Android recognition activity is removed. Android now owns `android.speech.SpeechRecognizer` in process, requires an available on-device service, publishes partial results directly into the composer, and destroys the recognizer on completion, navigation, submission, lifecycle stop, or replacement. iOS retains its native on-device Speech path. Both composers snapshot one draft per generation, reject stale callbacks from earlier sessions, prevent concurrent manual edits from being overwritten, cancel capture when the app backgrounds, and keep typed input available on every failure. iOS deliberately preserves the transient inactive state used by native permission sheets.

App Settings on both clients chooses **On this device** or **Paired Mac**. Paired-Mac mode can inspect, download, cancel, and select the existing Mac-local Parakeet models without desktop setup. It records at most 60 seconds of 16 kHz mono PCM, sends the closed payload over the authenticated pinned-TLS Aiden Remote connection, and inserts the final transcript after stop; raw audio is not persisted. The existing Parakeet binding is an offline/batch ASR model rather than a speech synthesizer or streaming recognizer, so native modes provide partial text while paired-Mac mode truthfully returns final text. Read-aloud remains native/on-device.

The Remote contract adds authenticated status/model-management/transcription routes, a shared revision-9 fixture, a 60-second exact body bound, pre-body credential rejection, a two-job admission bound, privacy-safe errors, usage accounting, and staged full-manifest model installation with an 800 MiB compressed-archive download ceiling. Android/iOS add bounded clients, 120-second transcription timeouts, settings and lifecycle state, and route/PCM/mode tests. Two independent reviews covered backend/security and both mobile controllers; their findings drove session fencing, background cancellation, queue/body bounds, staged model validation, accessibility selection semantics, and privacy-copy reconciliation. Moving synchronous Sherpa decode out of Electron main, bounding extracted archive bytes/files, and signing model archives remain explicitly tracked follow-ups.

## Mobile chrome polish follow-up — 2026-08-24

- Android’s app-icon product switcher now uses text-only Bots and Workspaces menu rows. Workspace creation uses a plain plus on the accent fill, and chat history uses a 32 dp visual arrow-only jump-to-latest control inside a 48 dp touch target.
- The Android chat transcript extends behind a foreground composer surface with soft elevation, while measured Scaffold bottom padding keeps the latest message reachable and Compose remains the sole IME/navigation-inset owner.
- iPhone and iPad expose the same scroll-aware downward-arrow action in a 34-point circular Liquid Glass surface inside a 44-point touch target. Tapping dismisses it immediately before scrolling to the latest message.
- The product-switcher coachmark uses a continuous rounded glass card in a transparent presentation host, and prominent accent-filled mobile actions use the palette’s semantic on-accent foreground to retain contrast across every appearance preset.
- UI contracts cover the Android arrow-only action/menu state and the iOS scroll threshold. Android unit tests, lint, assembly, Android-test compilation, live Pixel IME/scroll inspection, and the 288-test signed physical-iPhone suite pass; the final normal apps were installed in place on both devices.

## Unified mobile pull request and Android artifact — 2026-08-24

iOS, Android, the shared Remote contracts, and the completed Bot companion-vision implementation are consolidated on one review branch based directly on `main`. Create Images/Banana, Gemini Live, and the Pi inline proposal remain intentionally separate so this pull request has one mobile-companion release boundary.

Pull-request CI now gives Android its own Java 21/SDK 36 job. It runs the complete debug JVM tests, lint, debug assembly, and Android-test Kotlin compilation, then publishes the installable debug APK plus its SHA-256 checksum as a 14-day workflow artifact. Hosted CI continues to compile the iOS app and test bundle for generic physical hardware without using a simulator; signed XCTest acceptance remains a recorded physical-device gate.
