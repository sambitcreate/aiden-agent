# Stitch-Inspired Design Studio Plan

Status: Active — Phase 1 complete; Phase 2 implementation in progress
Date: 2026-09-03
Branch: `feature/stitch-design-studio`
Predecessor: [Design Workspace Durable Projects and Handoff](completed/design-workspace-claude-alignment-plan.md)
Research notes: [Stitch product and interaction findings](../../stitch-ideas.md)

## Objective

Evolve Aiden Design from a conversation-attached canvas into a local-first, screen-centered studio:

```text
Brief → Explore → Choose → Refine → Prototype → Inspect → Export / Build
```

Preserve Aiden's main-owned storage, immutable revisions, semantic compare-and-swap publication, restart reconciliation, sandboxed previews, deterministic export, and permission-preserving engineering handoff. Conversation remains a contextual work surface rather than the product's organizing center.

## Delivery status

- [x] Phase 1 — coherent selection, canvas recovery, inspector layout, terminology, and responsive workbench
- [ ] Phase 2 — Project V2, title policy, per-screen surface semantics, and migration
- [ ] Phase 3 — durable generation intents, Explore, single-screen Refine, direction sets, and cancellation recovery
- [ ] Phase 4 — project-local Design Language and hardened deterministic `DESIGN.md`
- [ ] Phase 5 — bounded prototype graph and host verification
- [ ] Phase 6 — project export and handoff V2
- [ ] Final — combined review, full CI, packaged acceptance, and PR delivery

Each phase requires focused implementation tests, a fresh correctness/edge-case review, a UI/UX review where applicable, remediation, and rerun verification before the next phase begins.

## Product and vocabulary contract

- **Project** is the durable local Design object.
- **Screen** is the user-facing name for one stable generated lineage.
- **Revision** is one immutable media artifact within a Screen.
- **Direction set** groups one Explore operation's alternatives.
- **Chosen direction** is a reversible project decision and never deletes alternatives.
- **Prototype** is a bounded, verified graph between exact Screen revisions.
- **Connected preview** remains distinct from an Aiden-owned Screen.
- **Design Language** is a project-local semantic system with exact revision and content hash.

Existing persisted `artboard`, `lineageId`, `mediaId`, and `canonicalOrigin` identifiers remain unchanged. Renderer selection, conversation content, imported prose, and connection state are context rather than authority.

## Phase 1 — Workbench coherence

- Introduce one ephemeral selection projection shared by canvas, transcript artifacts, navigator, composer, History, Comments, and inspector.
- Make **Show on canvas** select, center, activate the requested preview revision, and restore canvas focus.
- Separate historical preview from the durable active revision; add explicit **Make current** and **Refine from this** actions.
- Keep every durable Screen visible as a preview, loading placeholder, or explicit error state; expose Fit recovery when the saved viewport is offscreen.
- Repair the Code rail so long source scrolls internally and cannot displace the inspector.
- Replace ambiguous creation controls with named Explore, Refine, Prototype, Inspect, and Export actions while keeping Select, Hand, Zoom, and Fit as canvas mechanics.
- Separate preview dimensions from surface translation.
- Measure workbench width and switch the context surface from inline rail to contained overlay/full-width sheet without hiding its close control.

Acceptance: every entry point resolves to one exact Screen/revision; reopening never appears to lose durable Screens; History inspection cannot silently mutate `activeMediaId`; narrow layouts pass keyboard, focus, and pointer-interception checks.

## Phase 2 — Project V2 and semantic ownership

- Add dual readers and atomic V1→V2 migration.
- Add durable title policy (`auto-eligible`, `auto-applied`, `manual`) so manual names always win.
- Create blank projects immediately and apply a title only after the first successful Screen publication.
- Add per-Screen surface/frame facts while retaining the project viewport as a preview preference during migration.
- Restrict the generic update endpoint to layout facts; use dedicated main-owned CAS operations for active revision, title, direction, language, prototype, and connection changes.
- Add optional versioned generation provenance before introducing Explore.

Acceptance: old projects preserve every ID, artifact byte, canvas position, timestamp, origin, reference, connection fact, and nonterminal recovery operation; renderer-forged semantic fields fail closed.

## Phase 3 — Explore and Refine

- Persist a strict main-resolved generation intent with the user turn.
- Explore creates 2–4 new lineages from a blank brief or one exact base revision.
- Refine advances exactly one selected lineage from an exact immutable base.
- Persist Direction sets with requested/actual counts, creative range, selected aspects, members, source revision, chosen direction, archive presentation state, and partial/complete status.
- Choose direction never deletes siblings; archive does not recover artifact quota.
- A cancelled user generation with usable candidates asks **Keep draft** or **Discard**. A kept partial Explore remains visibly incomplete and can retry missing members.
- Extend publication ownership and startup reconciliation so artifact and Direction-set stages converge idempotently.

Acceptance: stale bases cannot publish; Explore never advances the selected lineage; partial/cancel/restart cannot create phantom or duplicate members; each new revision exposes exact content-free intent provenance.

## Phase 4 — Project-local Design Language

- Add authored, imported, derived, and workspace-snapshot provenance without weakening the existing workspace freshness contract.
- Store bounded immutable normalized snapshots behind a small owner-only project index.
- Support describe, derive, import, export, apply, compare, reviewed merge, refresh, and detach.
- Bind the exact language revision/hash into generation intent and artifact provenance.
- Define a deterministic Aiden `DESIGN.md` subset. Reject unsafe YAML features, raw HTML, embedded resources, executable directives, paths, credentials, unsupported encodings, control characters, and oversized/deep input.
- Treat all imported human guidance as inert untrusted model context.

Acceptance: prototype-only projects work without Connect App; canonical import/export round trips preserve the normalized hash; malicious fixtures and stale workspace snapshots fail closed.

## Phase 5 — Prototype graph

- Store exact Screen/revision nodes and whitelisted interaction edges separately from HTML.
- Allow bounded click, submit, change, and keyboard triggers with validated destinations and transitions.
- Keep static, unverified, verified, broken/stale, and connected-preview states distinct.
- Verify through the existing network-denied preview host, recording exact source hashes and bounded check evidence.
- Make missing states, keyboard/focus, reduced motion, and link validity explicit checks rather than unverified claims.

Acceptance: no legacy or generated Screen is labeled interactive without verification; stale/remapped revisions visibly invalidate affected edges; the bridge cannot navigate outside its exact project/iframe capability.

## Phase 6 — Export and handoff V2

- Preserve existing single-Screen export.
- Add a versioned deterministic project bundle containing a Project Brief, `DESIGN.md`, exact Screen sources, prototype graph, and bounded references.
- Extend the existing recoverable handoff journal with chosen direction, reviewed Screen subset, Design Language hash, prototype summary, responsive intent, accessibility notes, and exact source hashes.
- Integrate every new project-owned record into duplicate, delete, recovery, and health-check lifecycles.
- Keep export, Connect App, and Continue in Workspace as distinct authority boundaries.

Acceptance: identical reviewed scope produces byte-identical output; stale preview digests require re-preview; no prompt, transcript, credential, absolute path, implicit permission, or rejected source crosses the boundary without explicit review; all V1 journals remain recoverable.

## Cross-cutting verification

- Exact-key parsing, bounds, Unicode, future-version, migration, rollback, and corruption fixtures.
- Store CAS, two-window conflict, crash-boundary, restart reconciliation, duplicate, delete, and feature-disable tests.
- Electron E2E for new project, Show on canvas, History preview, Code rail, offscreen recovery, Explore/cancel, exact-base Refine, Design Language, Prototype, export, relaunch, and preview cleanup.
- Accessibility coverage for roles, names, focus-visible, text-entry focus rules, keyboard-only operation, VoiceOver, reduced motion, high contrast, and forced colors.
- A 20-Screen/10-reference/100-revision fixture with a hard live-iframe cap and truthful offscreen placeholders.
- Full Generative UI, Design recovery, remote exclusion, type-check, lint, build, and exact-head CI gates. Shared chat/remote schema changes trigger iOS and Android contract suites even though the Design canvas remains Mac-only.
- Signed packaged-app acceptance remains separate from source/CI completion.

## Explicit non-goals

- Stitch runtime, code, or asset dependency
- Cloud storage, hosted sharing, or multiplayer
- Public MCP, Figma export, QR/LAN preview, or deployment partners
- Heatmaps, animation generation, or marketing/App Store assets
- Multi-Screen Refine before exact per-output attribution exists
- Five alternatives before measured quota and memory changes
- Automatic repository writes or permission escalation
- Exposing Design Projects or executable artifacts to native clients
