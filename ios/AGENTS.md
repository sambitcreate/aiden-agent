# AGENTS.md — Aiden On The Go working agreement

Aiden On The Go is the native SwiftUI iPhone/iPad companion for the Aiden Agent Electron app in this repository. The desktop app is the execution and persistence authority. The imported Hermex project is an implementation foundation, not a product/API compatibility requirement.

## Sources of truth

Read these before changing mobile behavior or contracts:

1. `../AGENTS.md` for repository-wide requirements.
2. `../docs/plans/bot-first-aiden-on-the-go-plan.md` for the active bot-first scope, delivery order, and phase gates.
3. `../docs/plans/aiden-on-the-go-plan.md` for the shipped mobile foundation and its still-open release gates.
4. `PROJECT_SPEC.md` for the approved mobile product contract.
5. `../docs/aiden-remote-api-v1.md` and `../protocol/aiden-remote/v1/openapi.json` for protocol behavior and exact wire shapes.
6. `../protocol/aiden-remote/v1/fixtures/contract.json` for cross-platform contract fixtures.

For bot behavior, the bot-first plan supersedes the older plan only where it says so explicitly; the older plan continues to govern the existing Workspace experience and unrelated security rules. If these disagree elsewhere, stop at the narrower safety boundary and resolve the documents together. Do not consult or preserve Hermes WebUI endpoints as a fallback.

## Delivery rules

- Keep the completed phases 0–12 foundation stable. Implement bot-first phases 0–8 in order; do not expose later production endpoints to make an earlier phase easier.
- Add or update focused XCTest and cross-platform contract coverage with every behavioral slice.
- Before advancing a bot-first phase, satisfy its evidence gate in `../docs/testing/aiden-on-the-go/`, run the applicable full suites, and have a different subagent perform a direct source-and-test review. Fix every P0/P1 finding, rerun affected checks, and repeat review until the phase is clear. The owner explicitly requested phased subagent implementation and review on August 22, 2026.
- Preserve unrelated user changes and imported MIT attribution.
- New third-party dependencies require explicit approval. Prefer Apple frameworks and the dependencies already locked by the imported project.
- Use terminal-based `xcodebuild`/`xcrun` verification against an explicitly selected physical device. The connected, unlocked iPhone 13 Pro is the default iPhone test destination where applicable; it proves the Image Playground-unavailable fallback, not a successful Apple Intelligence generation flow. The owner currently prohibits simulator use. A `CODE_SIGNING_ALLOWED=NO` build is compile/test-only and is not valid manual Keychain or entitlements evidence.

## Protocol and security rules

- Never invent endpoints or JSON shapes in Swift. Change the normative Aiden contract, shared fixture, TypeScript tests, and Swift tests together.
- Decode additive response fields tolerantly, but fail closed when required identity, authentication, capability, ownership, revision, sequence, expiry, or mutation-precondition fields are missing or invalid.
- Do not send or persist Aiden credentials in URLs, App Group data, App Intents, logs, Live Activities, fixtures, or source control. Device credentials belong in Keychain.
- LAN production traffic uses hostname/certificate validation plus the QR-pinned P-256 SPKI SHA-256 fingerprint. A matching pin alone never bypasses normal trust evaluation.
- The client never sends a free-form Mac path. Workspace-browser selections and workspace-file identities use separate opaque, server-issued capabilities.
- TCP/SSE loss never retries a turn creation or abandons server-owned work. Reconcile by stable IDs and sequence.
- Workspace remote controls cannot mint Assistant/unattended authority, enable Computer Use, add a terminal, or widen a Workspace chat's stored permission/tool contract.
- Bots use a separate main-owned Full/Custom policy. Full Access is an explicit valid record available only after the current versioned notice; Custom may reduce access per bot and per chat, and a chat can never exceed its bot. OS permissions, global disables, existing approvals, and Computer Use's existing explicit opt-in remain authoritative.
- Do not expose a generic terminal or client-supplied shell-command endpoint. The Mac-owned bot runtime may use its existing shell tool when the effective Bot policy allows it; commands start in the bot's managed home and are still subject to Aiden's ordinary safety gates.

## Product boundaries

- Retain native Hermex UI/behavior only where `PROJECT_SPEC.md` maps it to Aiden 1:1.
- Remove Kanban and every Hermes-only panel, profile/personality concept, server voice upload path, and Cloudflare-specific onboarding during the designated cleanup phases.
- Workspace permission belongs in Workspace Settings opened from the conversation-toolbar ellipsis, never in the composer.
- App Intents are App-Group-cache-only navigation. Live Activities are bounded last-known state without cloud push. Voice is on-device dictation/read-aloud only.
- Redesign the iPhone/iPad experience now around the Aiden-logo Workspaces/Bots switcher. Mac UI redesign is deferred; Mac changes in this scope are runtime/persistence integration and canonical bot-photo display in existing surfaces.
- Reuse the existing `AidenChatDetailView` and its chat feature/view-model path for every Bot conversation. Add bot-specific title, identity, and Access affordances around it; never fork, copy, or build a second transcript, composer, streaming, approval, attachment, or reconciliation implementation.
- Give every bot exactly one hidden Aiden-managed home. It is not initialized as a Git repository, shell starts there, and ordinary artifacts are saved there. Under Full Access, the bot may inspect other OS-accessible Mac locations when the task needs it. Only the Mac resolves and injects the private path and operating instructions.
- Use iPhone navigation stacks and an adaptive iPad `NavigationSplitView`; do not introduce a custom UI system for branding.
- Use the system Image Playground sheet when supported. Private Cloud Compute is acceptable; after explicit **Use this image**, upload only the accepted normalized image to the paired Mac as the canonical bot photo. Keep the semantic avatar path fully usable on unsupported devices.

## Approved Apple identity

- Automatic signing team: `5WP229CBB8`
- Main bundle: `sbtbiswas.AidenOnTheGo`
- Live Activity widget: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`
- App Group: `group.sbtbiswas.AidenOnTheGo`
- Keychain service: `sbtbiswas.AidenOnTheGo.pairing`
- URL scheme: `aiden-otg`

The shipping project, target, and scheme are `AidenOnTheGo`. Old Hermes project, target, scheme, bundle, service, and asset identifiers are not approved and must not be restored.
