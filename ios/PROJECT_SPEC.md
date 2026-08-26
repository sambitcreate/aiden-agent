# Aiden On The Go — iOS/iPadOS Project Specification

Status: Approved implementation specification
Protocol: Aiden Remote API v1 (`/api/aiden/v1`)
Product: Aiden On The Go
Platforms: iPhone and iPad, iOS/iPadOS 18+
Authority: `docs/plans/aiden-on-the-go-plan.md` and `docs/aiden-remote-api-v1.md`

## 1. Product contract

Aiden On The Go is the native mobile control plane for a user-owned Aiden Agent desktop installation. Aiden Agent remains the execution and persistence authority. The phone connects over an explicitly enabled local-network or Tailscale transport, pairs to one installation, and authenticates every command and event stream with a revocable per-device credential.

The app is not a Hermes WebUI client, a hosted service, a web view, or an agent runtime. Imported Hermex code is an implementation foundation only. New code must use Aiden Remote API v1 DTOs and events; do not add or preserve Hermes endpoints as a compatibility layer.

## 2. Confirmed scope

The complete planned product includes:

- Multiple paired Aiden installations with QR or 100-bit setup-code pairing, Keychain credentials, discovery, manual URL entry, switching, and revocation handling.
- Chat list/open/create/rename/delete, bounded attachments, provider/model/thinking selection, atomic turn start, resumable streaming, cancel, reasoning/tool/timeline status, and allow/deny approvals.
- Workspace registry list/create/update/unregister, including folderless, managed scratch, and folders selected through a server-approved desktop directory browser.
- Workspace Settings from the conversation toolbar ellipsis. Workspace permission is never a composer control.
- Device-local Aiden, Slate, Berry, and Moss appearance presets plus supported mobile appearance options.
- Aiden workspace file index/read/version-checked write and the existing Aiden Git review/diff/compare/branch/commit/push/managed-worktree operations.
- Aiden scheduled-task list/create/edit/remove/pause/resume/run-now/preview/history/settings.
- Cache-only App Intents, app-driven Live Activities, on-device dictation, and local read-aloud.
- Offline read-only display of previously fetched data. Mutations are disabled while disconnected.

Remove Kanban, Hermes projects/profiles/personalities, Skills/Memory/Insights panels, Cloudflare-specific onboarding, server TTS/transcription, voice-note upload, terminal, Computer Use, and every control without an Aiden service contract. Share Extension and cloud push remain deferred.

## 3. Security invariants

- Remote Access is off by default and has no listener until enabled on the desktop.
- Tailscale supplies reachability, never app authorization. Aiden manages only the exact non-Funnel Serve route it owns and never invokes `tailscale serve reset`.
- Local-network production transport is HTTPS. QR pairing pins the Aiden installation's stable P-256 SPKI SHA-256 fingerprint. Plain HTTP is development-build-only.
- Pairing secrets are high entropy, short lived, single use, rate limited, and never logged. The reviewed manual path uses a uniformly random 100-bit Crockford code only as a local HKDF input for authenticated decryption of the existing certificate-pinned trust envelope; lower-entropy human-sized codes still require a reviewed PAKE/SAS or explicit fingerprint confirmation.
- Device credentials are random, stored as digests on the desktop and in Keychain on iOS, capability scoped, revocable, and never placed in URLs, App Group data, App Intents, logs, or Live Activities.
- DTOs are allowlists. Absolute paths, provider/MCP credentials, raw diagnostics, Git admin paths/tokens, schedule runtime internals, and private agent history never cross the API.
- Directory and file handles are opaque server-side capabilities bound to instance, device, workspace/root identity, policy revision, expiry, and snapshot. The client never submits a free-form desktop path.
- Workspace selection consumption and workspace creation are atomic and idempotent. Filesystem identity and canonical root membership are revalidated immediately before mutation.
- Remote turns honor the workspace's saved `full`, `ask`, or `none` permission. The transport cannot mint Assistant/unattended modes or enable Computer Use.
- A dropped TCP/SSE connection does not resend a prompt or cancel server-owned work. The client reconciles by stable turn, stream, operation, and run IDs.

## 4. Navigation and interaction

Root destinations:

- Chats
- Workspaces
- Scheduled Tasks
- Settings / paired installations

Files and Git are workspace-scoped destinations, not global tabs. iPhone uses native navigation stacks. iPad uses `NavigationSplitView` and must remain useful in split view, rotation, and Stage Manager sizes.

The conversation toolbar has a top-right ellipsis. For a workspace-backed chat it opens Workspace Settings and workspace-scoped destinations. Workspace Settings contains name, permission, folder/worktree display state, Files, Git, and management links. The composer contains only message/on-device voice input, attachments, model/thinking controls, send, and stop.

Use retained Hermex native SwiftUI components where their behavior maps 1:1. Do not invent custom interaction systems for branding. Apply Aiden semantic tokens and native menus, lists, forms, sheets, alerts, toolbars, and split navigation.

## 5. Protocol source of truth

Normative contract documents and cross-platform fixtures live at repository root:

- `docs/aiden-remote-api-v1.md`
- `protocol/aiden-remote/v1/openapi.json`
- `protocol/aiden-remote/v1/fixtures/contract.json`

TypeScript and Swift tests must decode the same checked-in fixtures. Codable models are tolerant of unknown response fields but strict about required identity, ownership, sequence, and mutation-precondition fields. Unknown SSE event types are ignored and logged without including payload secrets; unknown terminal semantics fail closed and trigger snapshot reconciliation.

## 6. Streaming rules

- A turn starts through one atomic command and returns `turnId`, `streamId`, accepted state, and the canonical user message.
- Every SSE event has protocol version, stream ID, monotonically increasing sequence, timestamp, type, and typed payload.
- Initial events: `snapshot`, `status`, `text_delta`, `reasoning_delta`, `tool_started`, `tool_finished`, `timeline`, `approval_required`, `done`, `error`, `cancelled`, and `heartbeat`.
- Reconnect sends `Last-Event-ID` or `after`; duplicate sequences are ignored.
- The phone never retries turn creation solely because its stream disconnected.
- Approval IDs are device/stream bound and responses are idempotent. Only `allow` and `deny` are supported initially.
- Provider failure, cancellation, interruption, completion, and revocation are explicit terminal states.

## 7. Apple identity

Derived from the owner's Contact Sheet Generator project:

- Signing style: Automatic
- Apple team: `5WP229CBB8`
- Main bundle: `sbtbiswas.AidenOnTheGo`
- Unit tests: `sbtbiswas.AidenOnTheGoTests`
- UI tests: `sbtbiswas.AidenOnTheGoUITests`
- Live Activity widget: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`
- App Group: `group.sbtbiswas.AidenOnTheGo`
- Keychain service: `sbtbiswas.AidenOnTheGo.pairing`
- URL scheme: `aiden-otg`
- App Store SKU: `aiden-on-the-go-ios`
- Device families: iPhone and iPad

The installed Apple Development identity currently belongs to team `7EK65FX44E`. Do not claim release/signing readiness until a physical-device build provisions the identifiers above under team `5WP229CBB8`.

## 8. App Intents, Live Activities, and voice

- App Intents use current open/navigation protocols and App Group-cached installation/workspace IDs only. The intent process performs no network or Keychain access and never sends a prompt or mutation.
- Live Activity state is under 4 KB and excludes response text by default, paths, tool arguments, approval details, provider errors, and credentials. With no push relay, it shows honest last-known/stale state while the app is terminated and reconciles only when the authenticated app next runs.
- Voice is on-device dictation into an editable draft plus optional on-device read-aloud. Remove server STT, audio upload, voice-note attachments, and hold-to-record. If on-device recognition is unavailable, fall back to text rather than uploading audio.

## 9. Testing gates

Every phase adds or updates tests before review. Before a phase can advance:

1. Its focused TypeScript/XCTest suites pass.
2. Desktop type-check and applicable full tests pass.
3. Signed physical-device build/launch passes for iOS behavior changes; simulator use remains excluded by owner direction.
4. Physical-device verification runs when the phase acceptance explicitly requires hardware, LAN, microphone, signing, or ActivityKit behavior.
5. A direct source-and-test audit is completed without subagent/reviewer delegation while the owner's no-subagents direction remains active.
6. Every P0 and P1 finding is fixed and the affected tests are rerun.

Phase acceptance evidence belongs in `docs/testing/aiden-on-the-go/`. Evidence must distinguish automated proof, physical-device proof, and anything not yet verified.

## 10. Delivery order

Follow `docs/plans/aiden-on-the-go-plan.md` phases 0 through 12 in order. Do not expose production chat/workspace endpoints during Phase 0. Do not advance merely because code compiles: satisfy the phase acceptance gate and record evidence first.

## 11. Attribution

Preserve the imported Hermex upstream MIT license, copyright, and third-party notices while removing Hermes/Hermex product identity. New Aiden protocol and product documentation is owned by this repository.
