# AGENTS.md — Aiden On The Go working agreement

Aiden On The Go is the native SwiftUI iPhone/iPad companion for the Aiden Agent Electron app in this repository. The desktop app is the execution and persistence authority. The imported Hermex project is an implementation foundation, not a product/API compatibility requirement.

## Sources of truth

Read these before changing mobile behavior or contracts:

1. `../AGENTS.md` for repository-wide requirements.
2. `../docs/plans/aiden-on-the-go-plan.md` for scope, delivery order, and phase gates.
3. `PROJECT_SPEC.md` for the approved mobile product contract.
4. `../docs/aiden-remote-api-v1.md` and `../protocol/aiden-remote/v1/openapi.json` for protocol behavior and exact wire shapes.
5. `../protocol/aiden-remote/v1/fixtures/contract.json` for cross-platform contract fixtures.

If these disagree, stop at the narrower safety boundary and resolve the documents together. Do not consult or preserve Hermes WebUI endpoints as a fallback.

## Delivery rules

- Implement phases 0–12 in order. Do not expose later production endpoints to make an earlier phase easier.
- Add or update focused XCTest and cross-platform contract coverage with every behavioral slice.
- Before advancing a phase, satisfy its evidence gate in `../docs/testing/aiden-on-the-go/`, run the applicable full suites, and clear all P0/P1 findings in a direct source-and-test review. The owner currently prohibits subagent/reviewer delegation; do not use it unless that direction is explicitly reversed.
- Preserve unrelated user changes and imported MIT attribution.
- New third-party dependencies require explicit approval. Prefer Apple frameworks and the dependencies already locked by the imported project.
- Use terminal-based `xcodebuild`/`xcrun` verification against an explicitly selected physical device. The owner currently prohibits simulator use. A `CODE_SIGNING_ALLOWED=NO` build is compile/test-only and is not valid manual Keychain or entitlements evidence.

## Protocol and security rules

- Never invent endpoints or JSON shapes in Swift. Change the normative Aiden contract, shared fixture, TypeScript tests, and Swift tests together.
- Decode additive response fields tolerantly, but fail closed when required identity, authentication, capability, ownership, revision, sequence, expiry, or mutation-precondition fields are missing or invalid.
- Do not send or persist Aiden credentials in URLs, App Group data, App Intents, logs, Live Activities, fixtures, or source control. Device credentials belong in Keychain.
- LAN production traffic uses hostname/certificate validation plus the QR-pinned P-256 SPKI SHA-256 fingerprint. A matching pin alone never bypasses normal trust evaluation.
- The client never sends a free-form Mac path. Workspace-browser selections and workspace-file identities use separate opaque, server-issued capabilities.
- TCP/SSE loss never retries a turn creation or abandons server-owned work. Reconcile by stable IDs and sequence.
- Remote controls cannot mint Assistant/unattended authority, enable Computer Use, add a terminal, or widen a workspace's stored permission/tool contract.

## Product boundaries

- Retain native Hermex UI/behavior only where `PROJECT_SPEC.md` maps it to Aiden 1:1.
- Remove Kanban and every Hermes-only panel, profile/personality concept, server voice upload path, and Cloudflare-specific onboarding during the designated cleanup phases.
- Workspace permission belongs in Workspace Settings opened from the conversation-toolbar ellipsis, never in the composer.
- App Intents are App-Group-cache-only navigation. Live Activities are bounded last-known state without cloud push. Voice is on-device dictation/read-aloud only.
- Use iPhone navigation stacks and an adaptive iPad `NavigationSplitView`; do not introduce a custom UI system for branding.

## Approved Apple identity

- Automatic signing team: `5WP229CBB8`
- Main bundle: `sbtbiswas.AidenOnTheGo`
- Live Activity widget: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`
- App Group: `group.sbtbiswas.AidenOnTheGo`
- Keychain service: `sbtbiswas.AidenOnTheGo.pairing`
- URL scheme: `aiden-otg`

The shipping project, target, and scheme are `AidenOnTheGo`. Old Hermes project, target, scheme, bundle, service, and asset identifiers are not approved and must not be restored.
