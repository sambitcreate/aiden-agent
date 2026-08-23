# Aiden On The Go — iOS/iPadOS Project Specification

Status: Approved implementation specification; bot-first extension approved August 22, 2026
Protocol: Aiden Remote API v1 (`/api/aiden/v1`)
Product: Aiden On The Go
Platforms: iPhone and iPad, iOS/iPadOS 18+
Authority: `docs/plans/bot-first-aiden-on-the-go-plan.md`, `docs/plans/aiden-on-the-go-plan.md`, and `docs/aiden-remote-api-v1.md`

## 1. Product contract

Aiden On The Go is the native mobile control plane for a user-owned Aiden Agent desktop installation. Aiden Agent remains the execution and persistence authority. The phone connects over an explicitly enabled local-network or Tailscale transport, pairs to one installation, and authenticates every command and event stream with a revocable per-device credential.

The app is not a Hermes WebUI client, a hosted service, a web view, or an agent runtime. Imported Hermex code is an implementation foundation only. New code must use Aiden Remote API v1 DTOs and events; do not add or preserve Hermes endpoints as a compatibility layer.

The active product extension redesigns iPhone and iPad first around two areas, **Bots** and **Workspaces**, selected from the Aiden logo. Mac UX redesign is deferred. The paired Mac remains authoritative for bot identity, conversations, access policy, managed workspace, shell/tool execution, provider and capability catalogs, and the canonical bot photo.

## 2. Confirmed scope

The complete planned product includes:

- Multiple paired Aiden installations with QR or 100-bit setup-code pairing, Keychain credentials, discovery, manual URL entry, switching, and revocation handling.
- Chat list/open/create/rename/delete, bounded attachments, provider/model/thinking selection, atomic turn start, resumable streaming, cancel, reasoning/tool/timeline status, and allow/deny approvals.
- Workspace registry list/create/update/unregister, including folderless, managed scratch, and folders selected through a server-approved Mac directory browser.
- Workspace Settings from the conversation toolbar ellipsis. Workspace permission is never a composer control.
- Device-local Aiden, Slate, Berry, and Moss appearance presets plus supported mobile appearance options.
- Aiden workspace file index/read/version-checked write and the existing Aiden Git review/diff/compare/branch/commit/push/managed-worktree operations.
- Aiden scheduled-task list/create/edit/remove/pause/resume/run-now/preview/history/settings.
- Cache-only App Intents, app-driven Live Activities, on-device dictation, and local read-aloud.
- Offline read-only display of previously fetched data. Mutations are disabled while disconnected.
- A Bot-first Messages-like inbox with favorites, recent threads, search, bot profiles, and guided create/edit flows, alongside the retained Workspaces experience.
- Exactly one persistent chat per Bot. Every Bot entry point resumes it and creates it only when absent; legacy duplicate records are recoverable but not a second writable conversation.
- Bot Access with explicit **Full Access** by default after one versioned one-time notice, plus **Custom** reductions for Mac files, shell, configured Connections/MCPs, Skills, and other projected capability groups. A chat may narrow its bot but never exceed it.
- Exactly one hidden, durable, non-Git Aiden-managed home per bot. Shell and ordinary file creation start there; Full Access may inspect other OS-accessible Mac locations when the task needs it.
- Bot avatars using the existing semantic editor everywhere and the system Image Playground sheet where supported. Only a person-accepted image is sent to the paired Mac and stored as the canonical bot photo.
- Bot conversations presented through the existing `AidenChatDetailView` and its existing chat feature/view-model path, with bot identity and Access affordances added around that shared implementation.

Remove Kanban, Hermes projects/profiles/personalities, Hermes Skills/Memory/Insights panels, Cloudflare-specific onboarding, server TTS/transcription, voice-note upload, generic terminal UI, and every control without an Aiden service contract. Mac-projected Bot Access selectors for Skills and Connections are Aiden features, not retained Hermes panels. A bot may use the existing Mac-owned shell tool when its effective policy allows it, but the phone never gains a generic terminal or client-supplied command endpoint. Computer Use remains governed by its existing explicit opt-in and safety rules. Share Extension and cloud push remain deferred.

## 3. Security invariants

- Remote Access is off by default and has no listener until enabled on the Mac.
- Tailscale supplies reachability, never app authorization. Aiden manages only the exact non-Funnel Serve route it owns and never invokes `tailscale serve reset`.
- Local-network production transport is HTTPS. QR pairing pins the Aiden installation's stable P-256 SPKI SHA-256 fingerprint. Plain HTTP is development-build-only.
- Pairing secrets are high entropy, short lived, single use, rate limited, and never logged. The reviewed manual path uses a uniformly random 100-bit Crockford code only as a local HKDF input for authenticated decryption of the existing certificate-pinned trust envelope; lower-entropy human-sized codes still require a reviewed PAKE/SAS or explicit fingerprint confirmation.
- Device credentials are random, stored as digests on Mac and in Keychain on iOS, capability scoped, revocable, and never placed in URLs, App Group data, App Intents, logs, or Live Activities.
- DTOs are allowlists. Absolute paths, provider/MCP credentials, raw diagnostics, Git admin paths/tokens, schedule runtime internals, and private agent history never cross the API.
- Directory and file handles are opaque server-side capabilities bound to instance, device, workspace/root identity, policy revision, expiry, and snapshot. The client never submits a free-form Mac path.
- Workspace selection consumption and workspace creation are atomic and idempotent. Filesystem identity and canonical root membership are revalidated immediately before mutation.
- Workspace turns honor the workspace's saved `full`, `ask`, or `none` permission. Bot turns instead honor a main-owned, revisioned Full/Custom policy: Full is explicit after the current notice, Custom uses exact reductions, and corrupt, missing-after-migration, or future-version policy state fails closed. Neither transport can mint Assistant/unattended modes or silently enable Computer Use.
- Every bot has exactly one main-owned managed home. The Mac sets it as the shell/tool working directory and ordinary save location, does not initialize `.git`, and injects the operating contract after editable bot instructions so a phone, renderer, or prompt cannot replace it. Full Access may inspect other OS-accessible Mac locations only as needed and remains subject to OS permissions, global disables, approvals, and destructive-action safeguards.
- Regular chats continue to use their saved Workspace permission. A bot chat uses the Bot Full/Custom resolver as its only user-facing access policy. Its managed workspace has a main-owned internal runtime baseline that remote clients cannot view or edit and that can never add authority beyond the resolved Bot policy.
- The versioned Full Access notice must be accepted before a Full bot can act, and the Mac stores the acknowledgement by policy version. The notice explains shell, Mac files, currently enabled Connections/Skills, dynamic additions to Full, the private managed home, and the path to Custom. A per-chat policy can only reduce the bot ceiling.
- Image Playground may use Apple Intelligence and Private Cloud Compute on supported devices. Aiden uploads only the normalized image the person accepts, through an authenticated bounded asset route, and the Mac independently validates it before making it canonical. Rejected drafts, prompts, temporary URLs, credentials, and local paths are not sent in ordinary Bot DTOs or logs.
- A dropped TCP/SSE connection does not resend a prompt or cancel server-owned work. The client reconciles by stable turn, stream, operation, and run IDs.

## 4. Navigation and interaction

The Aiden logo is the product-area switcher with exactly two choices:

- **Bots** — reusable helpers and their conversations; the default when the paired Mac supports and grants `bot:read`.
- **Workspaces** — the retained project/folder-oriented experience.

Scheduled Tasks, Usage, appearance, and paired-installation Settings remain shared destinations rather than becoming a third product area. Older or ungranted Macs fall back honestly to Workspaces.

Keep the Bots and Workspaces navigation roots alive while switching areas so in-progress navigation, scroll position, selection, and unsent drafts survive the switch. Persist the last selected area and safe navigation identifiers per paired installation; retain message drafts through the shared device-local draft store rather than copying them into a second Bot chat model.

Use one device-local draft store keyed by paired installation and chat ID for both product areas. `AidenChatViewModel` remains the sole owner of composer behavior and synchronizes that shared draft record; there is no Bot-specific draft, composer, or chat view model.

Draft text stays in the app's protected private container, never the App Group, intent/widget cache, or logs. It is cleared after accepted send and purged with installation removal, revocation, or replacement-device pairing. Pending attachment references keep their existing bounded lifecycle and are not duplicated into draft persistence.

Server-supported Remote capabilities and the authenticated device's granted capabilities are distinct values. Bots is eligible only when both contain the required Bot read grant. A legacy installation whose single stored capability list is ambiguous fails closed for Bots until the Mac approves the upgrade or the phone re-pairs.

Files and Git are workspace-scoped destinations, not global tabs. iPhone uses native navigation stacks. iPad uses `NavigationSplitView` and must remain useful in split view, rotation, and Stage Manager sizes.

The existing `AidenChatDetailView` is the only iOS conversation implementation. Bot work may adapt it and its existing feature/view-model dependencies, but must never fork or copy the transcript, composer, streaming, attachments, approvals, outcome reconciliation, voice, or offline-history path. Bot-specific identity, title, access summary, and per-chat Access sheet wrap that shared view.

The conversation toolbar has a top-right ellipsis. For a workspace-backed chat it opens Workspace Settings and workspace-scoped destinations. Workspace Settings contains name, permission, folder/worktree display state, Files, Git, and management links. For a bot chat it opens Bot defaults and This chat access; workspace pickers, branch/worktree controls, Review, and persistent Terminal chrome stay hidden. The composer contains only message/on-device voice input, attachments, model/thinking controls, send, and stop.

Bot managed homes never appear in the Workspace registry. Bot Files reuse the existing native file presentation through bot-chat-scoped Remote routes; the Mac binds every handle to the device, bot, chat, policy epoch, managed-home identity, and snapshot. Ordinary Workspace file routes reject managed Bot homes, so an opaque workspace ID cannot bypass Custom Files or per-chat reductions.

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

## 8. Bot avatars and Apple image creation

- The semantic Aiden avatar editor remains the universal creation, offline, unsupported-device, and rollback path.
- On iOS/iPadOS 18.1 or later, use the system SwiftUI Image Playground sheet only when `supportsImagePlayground` is true. Do not use the deprecated programmatic `ImageCreator` path or promise that generation is universally on-device; Private Cloud Compute is acceptable.
- Prefill only visible bot identity/purpose, keep personalization disabled, support the explicit non-personalized illustration/animation/sketch styles, and provide honest cancel, restriction, model-download, usage-limit, and unavailable states.
- Preview and normalize locally. Nothing is uploaded until the person chooses **Use this image**. Then send the bounded accepted image to the paired Mac, which validates and stores the canonical bot photo with semantic fallback.
- The connected iPhone 13 Pro is valid physical-device evidence for the unsupported fallback and absence of dead controls. A supported Apple Intelligence iPhone or iPad is still required to prove successful system-sheet generation and paired-Mac persistence.

## 9. App Intents, Live Activities, and voice

- App Intents use current open/navigation protocols and App Group-cached installation/workspace IDs only. The intent process performs no network or Keychain access and never sends a prompt or mutation.
- Live Activity state is under 4 KB and excludes response text by default, paths, tool arguments, approval details, provider errors, and credentials. With no push relay, it shows honest last-known/stale state while the app is terminated and reconciles only when the authenticated app next runs.
- Voice is on-device dictation into an editable draft plus optional on-device read-aloud. Remove server STT, audio upload, voice-note attachments, and hold-to-record. If on-device recognition is unavailable, fall back to text rather than uploading audio.

## 10. Testing gates

Every phase adds or updates tests before review. Before a phase can advance:

1. Its focused TypeScript/XCTest suites pass.
2. Desktop type-check and applicable full tests pass.
3. Signed physical-device build/launch passes for iOS behavior changes; simulator use remains excluded by owner direction.
4. Physical-device verification runs when the phase acceptance explicitly requires hardware, LAN, microphone, signing, or ActivityKit behavior.
5. A different subagent completes a direct source-and-test audit between bot-first phases. Every P0/P1 finding is fixed, affected checks are rerun, and review repeats until clear, as explicitly requested by the owner on August 22, 2026.
6. Every P0 and P1 finding is fixed and the affected tests are rerun.

Phase acceptance evidence belongs in `docs/testing/aiden-on-the-go/`. Evidence must distinguish automated proof, physical-device proof, and anything not yet verified.

## 11. Delivery order

The original `docs/plans/aiden-on-the-go-plan.md` phases 0 through 12 remain the shipped mobile foundation and release-evidence record. Implement the active bot-first extension through `docs/plans/bot-first-aiden-on-the-go-plan.md` phases 0 through 9 in order. Do not expose later Bot endpoints during an earlier phase or advance merely because code compiles: satisfy the phase acceptance gate, complete independent review, fix findings, rerun affected checks, and record evidence first.

## 12. Attribution

Preserve the imported Hermex upstream MIT license, copyright, and third-party notices while removing Hermes/Hermex product identity. New Aiden protocol and product documentation is owned by this repository.
