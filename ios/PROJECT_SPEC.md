# Aiden On The Go — iOS/iPadOS Project Specification

Status: Approved implementation specification; bot-first extension approved August 22, 2026
Protocol: Aiden Remote API v1 (`/api/aiden/v1`)
Product: Aiden On The Go
Platforms: iPhone and iPad, iOS/iPadOS 18+
Authority: `docs/superpowers/specs/2026-10-07-bots-rework-design.md`, `docs/plans/bot-first-aiden-on-the-go-plan.md` (completed), `docs/plans/aiden-on-the-go-plan.md`, and `docs/aiden-remote-api-v1.md`

## 1. Product contract

Aiden On The Go is the native mobile control plane for a user-owned Aiden Agent desktop installation. Aiden Agent remains the execution and persistence authority. The phone connects over an explicitly enabled local-network or Tailscale transport, pairs to one installation, and authenticates every command and event stream with a revocable per-device credential.

The app is not a Hermes WebUI client, a hosted service, a web view, or an agent runtime. Imported Hermex code is an implementation foundation only. New code must use Aiden Remote API v1 DTOs and events; do not add or preserve Hermes endpoints as a compatibility layer.

The shipped product extension redesigns iPhone and iPad first around two areas, **Bots** and **Workspaces**, selected from the Aiden logo. Mac UX redesign is deferred. The paired Mac remains authoritative for bot identity, conversations, access policy, managed workspace, shell/tool execution, provider and capability catalogs, and the canonical bot photo.

Task progress and delegated-agent inspection are separately negotiated, read-only chat projections. The phone may request `tasks:read` and `agents:read` only after the authenticated server advertises the matching feature, then renders bounded snapshots and the standalone chat-scoped progress stream. These projections never grant turn control or expose child prompts, transcripts, private run identifiers, paths, credentials, or raw diagnostics; a public agent turn ID is only a selector for a bounded historical roster read.

## 2. Confirmed scope

The complete planned product includes:

- Multiple paired Aiden installations with QR or 100-bit setup-code pairing, Keychain credentials, discovery, manual URL entry, switching, and revocation handling.
- Chat list/open/create/rename/delete, bounded attachments, provider/model/thinking selection, atomic turn start, resumable streaming, cancel, reasoning/tool/timeline status, and allow/deny approvals.
- Workspace registry list/create/update/unregister, including folderless, managed scratch, and folders selected through a server-approved desktop directory browser.
- Workspace Settings from the conversation toolbar ellipsis. Workspace permission is never a composer control.
- Device-local Aiden, Slate, Berry, and Moss appearance presets plus supported mobile appearance options.
- Aiden workspace lazy directory pages, bounded source previews, explicit workspace-relative file links, index/read/version-checked write and the existing Aiden Git review/diff/compare/branch/commit/push/managed-worktree operations.
- Aiden scheduled-task list/create/edit/remove/pause/resume/run-now/preview/history/settings.
- Cache-only App Intents, app-driven Live Activities, native or paired-Mac local-model dictation, and desktop-configured read-aloud under the authenticated `tts-v1` contract.
- Offline read-only display of previously fetched data. Mutations are disabled while disconnected.
- A Bot-first inbox (a single Bots list with search), Bot profiles with Advanced settings and a Character card, and Bot creation from presets or scratch, alongside the retained Workspaces experience.
- Bot message attachments (`bot-attachments-v1`, contract revision 33): images and text files staged with `POST /bots/{botId}/attachments` and sent with `attachmentIds`.
- Bot hand-offs and pause (`bot:handoffs`, contract revision 37): negotiated in its own `POST /device/capabilities` call when the Mac lists it. The chat shows the step a Bot hands back to the person, answered with Done or Skip and an optional note, or finished on the Mac; a local notification announces a hand-off for a chat that is not on screen. Pause and Resume are on the Bot profile; a paused chat shows a calm card with Resume, and its composer explains why the Bot waits. Without the grant, a hand-off reads as an assistant notice and a paused Bot reads as unavailable.
- Web page extract recap (contract revision 38): a completed `web_fetch` step may carry the values an extract call read. The transcript shows them in a card under the step's activity line, each with its page line, a Guess label on uncertain values and "Not on the page" for absent ones. A malformed or misplaced recap is dropped and the step still shows.
- Exactly one persistent chat per Bot. Every Bot entry point resumes it and creates it only when absent; legacy duplicate records are recoverable but not a second writable conversation.
- A Bot's AI provider and model are required, revisioned Bot settings chosen during New Bot and changed only from Edit Bot. The one persistent chat mirrors that Bot-owned choice for execution and is repaired from it after interruption; Bot composers and access-reduction sheets never offer a competing model selector. Workspace chats retain their existing composer model controls.
- Bot Access with **Full Access** by default, plus **Custom** reductions for desktop files, shell, configured Connections/MCPs, Skills, and other projected capability groups, edited in the Bot's Advanced settings. There is no per-chat access override.
- Exactly one hidden, durable, non-Git Aiden-managed home per bot. Shell and ordinary file creation start there; Full Access may inspect other OS-accessible Mac locations when the task needs it.
- Bot avatars using the existing semantic editor everywhere and the system Image Playground sheet where supported. Only a person-accepted image is sent to the paired Mac and stored as the canonical bot photo.
- Durable Bot conversations presented through `AidenBotSessionChatView` on hosts advertising `bot-durable-session-v1`; legacy Bot chats and Workspace chats use `AidenChatDetailView`.

Remove Kanban, Hermes projects/profiles/personalities, Hermes Skills/Memory/Insights panels, Cloudflare-specific onboarding, uncontracted server TTS, voice-note upload, generic terminal UI, and every control without an Aiden service contract. The bounded paired-Mac transcription endpoint is a remote speech exception: it invokes the desktop's selected local speech model and never stores audio. Mac-projected Bot Access selectors for Skills and Connections are Aiden features, not retained Hermes panels. A bot may use the existing Mac-owned shell tool when its effective policy allows it, but the phone never gains a generic terminal or client-supplied command endpoint. Computer Use remains governed by its existing explicit opt-in and safety rules. Share Extension and cloud push remain deferred.

## 3. Security invariants

- Remote Access is off by default and has no listener until enabled on the desktop.
- Tailscale supplies reachability, never app authorization. Aiden manages only the exact non-Funnel Serve route it owns and never invokes `tailscale serve reset`.
- Local-network production transport is HTTPS. QR pairing pins the Aiden installation's stable P-256 SPKI SHA-256 fingerprint. Plain HTTP is development-build-only.
- Pairing secrets are high entropy, short lived, single use, rate limited, and never logged. The reviewed manual path uses a uniformly random 100-bit Crockford code only as a local HKDF input for authenticated decryption of the existing certificate-pinned trust envelope; lower-entropy human-sized codes still require a reviewed PAKE/SAS or explicit fingerprint confirmation.
- Device credentials are random, stored as digests on the desktop and in Keychain on iOS, capability scoped, revocable, and never placed in URLs, App Group data, App Intents, logs, or Live Activities.
- DTOs are allowlists. Absolute paths, stored provider/MCP credentials, raw diagnostics, Git admin paths/tokens, schedule runtime internals, and private agent history never appear in API responses. Providers settings may submit a new write-only provider key through the authenticated pinned Mac connection using the feature-gated, foreground-only creation endpoint; the Mac encrypts it and never returns it.
- Task and agent progress DTOs remain read-only and separately authorized from the parent transcript. The app keeps only a bounded local roster history, refetches a selected public turn by opaque ID, and fences snapshots by projection epoch and revision. A warm progress reconnect retains the last applied cursor and projection epoch; the host rehydrates when that epoch or cursor is unknown. Cold views start with full hydration.
- Directory and file handles are opaque server-side capabilities bound to instance, device, workspace/root identity, policy revision, expiry, and snapshot. The client never submits a free-form desktop path.
- Workspace selection consumption and workspace creation are atomic and idempotent. Filesystem identity and canonical root membership are revalidated immediately before mutation.
- Workspace turns honor the workspace's saved `full`, `ask`, or `none` permission. Bot turns instead honor a main-owned, revisioned Full/Custom policy: Full is explicit after the current notice, Custom uses exact reductions, and corrupt, missing-after-migration, or future-version policy state fails closed. Neither transport can mint Assistant/unattended modes or silently enable Computer Use.
- Every bot has exactly one main-owned managed home. The Mac sets it as the shell/tool working directory and ordinary save location, does not initialize `.git`, and injects the operating contract after editable bot instructions so a phone, renderer, or prompt cannot replace it. Full Access may inspect other OS-accessible Mac locations only as needed and remains subject to OS permissions, global disables, approvals, and destructive-action safeguards.
- Regular chats continue to use their saved Workspace permission. A bot chat uses the Bot Full/Custom resolver as its only user-facing access policy. Its managed workspace has a main-owned internal runtime baseline that remote clients cannot view or edit and that can never add authority beyond the resolved Bot policy.
- Full Access is the default Bot policy (the Bots rework removed the `bot-full-access-v1` notice wall); Custom reductions are stored by the desktop as a revisioned policy and fail closed when corrupt or from a future version.
- Image Playground may use Apple Intelligence and Private Cloud Compute on supported devices. Aiden uploads only the normalized image the person accepts, through an authenticated bounded asset route, and the Mac independently validates it before making it canonical. Rejected drafts, prompts, temporary URLs, credentials, and local paths are not sent in ordinary Bot DTOs or logs.
- A dropped TCP/SSE connection does not resend a prompt or cancel server-owned work. The client reconciles by stable turn, stream, operation, and run IDs.

## 4. Navigation and interaction

The Aiden logo is the product-area switcher with exactly two choices:

- **Bots** — reusable helpers and their conversations; the default when the paired Mac supports and grants `bot:read`.
- **Workspaces** — the retained project/folder-oriented experience.

Scheduled Tasks, Usage, appearance, and paired-installation Settings remain shared destinations rather than becoming a third product area. Older or ungranted Macs fall back honestly to Workspaces.

Keep the Bots and Workspaces navigation roots alive while switching areas so in-progress navigation, scroll position, selection, and unsent drafts survive the switch. Persist the last selected area and safe navigation identifiers per paired installation; retain message drafts through the shared device-local draft store rather than copying them into a second Bot chat model.

Use one device-local draft store keyed by paired installation and chat ID for both product areas. `AidenChatViewModel` remains the sole owner of composer behavior and synchronizes that shared draft record.

Draft text stays in the app's protected private container, never the App Group, intent/widget cache, or logs. It is cleared after accepted send and purged with installation removal, revocation, or replacement-device pairing. An ambiguous send is stored separately from the editable draft, with its exact request, attachment references, device scope, idempotency key and first-attempt time. Retry is explicit and permitted only inside the conservative 24-hour replay window; it never substitutes a new key for an unresolved attempt. Removal and revocation purge both records.

Server-supported Remote capabilities and the authenticated device's granted capabilities are distinct values. Bots is eligible only when both contain the required Bot read grant. A legacy installation whose single stored capability list is ambiguous fails closed for Bots until the Mac approves the upgrade or the phone re-pairs.

Files and Git are workspace-scoped destinations, not global tabs. iPhone uses native navigation stacks. iPad uses `NavigationSplitView` and must remain useful in split view, rotation, and Stage Manager sizes.

Workspace chats and legacy (pre-durable-session) Bot chats use `AidenChatDetailView`. On hosts advertising `bot-durable-session-v1`, each Bot's single durable conversation uses `AidenBotSessionChatView` with `AidenBotSessionModel`, which shares the attachment picker, transcript rendering components, and offline-history rules rather than reimplementing them.

The conversation toolbar has a top-right ellipsis. For a workspace-backed chat it opens Workspace Settings and workspace-scoped destinations. Workspace Settings contains name, permission, folder/worktree display state, Files, Git, and management links. For a bot chat it opens the Bot's profile (Advanced, Memory, Routines, Character); workspace pickers, branch/worktree controls, Review, and persistent Terminal chrome stay hidden. A Workspace composer retains message/voice input, attachments, model/thinking controls, send, and stop. A Bot composer uses the same shared implementation but omits model selection entirely; its provider/model are changed only in Edit Bot.

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
- Task and agent progress use a standalone chat-scoped SSE channel whose stream ID is the chat ID. The server sends authoritative full snapshots. Warm reconnects send the last applied cursor plus Aiden-Progress-Epoch; only Aiden-Progress-Resumed confirms an unchanged snapshot is live. A rejected/unknown epoch or cursor receives full hydration. Offline progress observers park until the network returns, and transport loss retains last-known state.

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

Apple Distribution signing and App Store profiles for the app and Live Activity widget are provisioned under team `5WP229CBB8` (see `TESTFLIGHT.md`). Every exported IPA must still be checked for `get-task-allow=false` and the exact identifiers above before upload.

## 8. Bot avatars and Apple image creation

- The semantic Aiden avatar editor remains the universal creation, offline, unsupported-device, and rollback path.
- On iOS/iPadOS 18.4 or later, use the system SwiftUI Image Playground sheet only when `supportsImagePlayground` is true. Do not use the deprecated programmatic `ImageCreator` path or promise that generation is universally on-device; Private Cloud Compute is acceptable.
- Prefill only visible bot identity/purpose, keep personalization disabled, support the explicit non-personalized illustration/animation/sketch styles, and provide honest cancel, restriction, model-download, usage-limit, and unavailable states.
- Preview and normalize locally. Nothing is uploaded until the person chooses **Use this image**. Then send the bounded accepted image to the paired Mac, which validates and stores the canonical bot photo with semantic fallback.
- The connected iPhone 13 Pro is valid physical-device evidence for the unsupported fallback and absence of dead controls. A supported Apple Intelligence iPhone or iPad is still required to prove successful system-sheet generation and paired-Mac persistence.

## 9. App Intents, Live Activities, and voice

- App Intents use current open/navigation protocols and App Group-cached installation/workspace IDs only. The intent process performs no network or Keychain access and never sends a prompt or mutation.
- Live Activity state is under 4 KB and excludes response text by default, paths, tool arguments, approval details, provider errors, and credentials. With no push relay, it shows honest last-known/stale state while the app is terminated and reconciles only when the authenticated app next runs.
- Voice input is an editable draft using either native on-device recognition or the user-selected paired-Mac mode. Paired-Mac mode records at most 60 seconds of 16 kHz mono PCM, sends it only over the authenticated pinned-TLS Aiden connection, transcribes with the speech model selected on the paired desktop (Parakeet v3 by default), and does not persist the recording. It currently returns final text after stop; native recognizers may provide partial text. Voice-note attachments remain absent. The September 2026 Read Aloud extension uses native audio playback of the paired Mac's bounded `tts-v1` output. The Mac alone enables/configures cloud speech; mobile settings are read-only. Selected response text is sent by the Mac to Google only after explicit Play, and replay reuses session audio.

## 10. Testing gates

Every phase adds or updates tests before review. Before a phase can advance:

1. Its focused TypeScript/XCTest suites pass.
2. Desktop type-check and applicable full tests pass.
3. Signed physical-device build/launch passes for iOS behavior changes; simulator builds and XCTest runs are allowed for development and regression checks; hardware-dependent behavior and release acceptance require a signed physical-device build.
4. Physical-device verification runs when the phase acceptance explicitly requires hardware, LAN, microphone, signing, or ActivityKit behavior.
5. A different subagent completes a direct source-and-test audit between bot-first phases. Every P0/P1 finding is fixed, affected checks are rerun, and review repeats until clear, as explicitly requested by the owner on August 22, 2026.
6. Every P0 and P1 finding is fixed and the affected tests are rerun.

Phase acceptance evidence belongs in `docs/testing/aiden-on-the-go/`. Evidence must distinguish automated proof, physical-device proof, and anything not yet verified.

## 11. Delivery order

The original `docs/plans/aiden-on-the-go-plan.md` phases 0 through 12 remain the shipped mobile foundation and release-evidence record. The bot-first extension (`docs/plans/bot-first-aiden-on-the-go-plan.md` phases 0–9) is complete; the Bots rework (`docs/superpowers/specs/2026-10-07-bots-rework-design.md`, Remote contract revision 25 and later) supersedes its access and conversation model. New Bot work follows that spec and the Remote API's current contract revision.

## 12. Attribution

Preserve the imported Hermex upstream MIT license, copyright, and third-party notices while removing Hermes/Hermex product identity. New Aiden protocol and product documentation is owned by this repository.


### September 2026 approved Read Aloud extension

The user's desktop-configured Gemini Read Aloud request supersedes older
on-device-only/server-TTS exclusions specifically for `tts-v1`. See
`docs/aiden-remote-api-v1.md` (repository root) for the normative endpoint and
ownership rules. No mobile speech setup mutations, arbitrary transcripts, direct Google
requests or speech-provider credentials are permitted. Legacy servers fail closed with
update/setup guidance; there is no silent alternate-model or on-device fallback.
