# ADR: Durable Design Project identity and storage

Status: Implemented and covered by migration, restart, corruption, copy, and deletion fixtures.

Date: 2026-09-01

Related plan: [Design Workspace Durable Projects and Handoff](../plans/completed/design-workspace-claude-alignment-plan.md)

## Context

The shipped Design Workspace is entered through a chat. Generated HTML is durable in the Generative UI artifact store, but canvas positions, viewport, selected revisions, and uploaded reference nodes are renderer state. A chat ID is therefore an incomplete user-facing identity: it cannot represent a durable canvas, an explicit connected-app relationship, or future comments and history without making the chat document authoritative for unrelated state.

Design Project persistence also spans data with different safety properties:

- chat messages own conversation and prompt history;
- the Generative UI store owns generated HTML bytes;
- a future content-addressed asset store will own reference-image bytes;
- authorized workspace services own connected-app source reads and writes;
- the project store should own only the arrangement and opaque references needed to reopen the canvas.

Collapsing those bytes into one renderer-authored document would duplicate sensitive data, weaken size limits, and make deletion and copy failure-prone.

## Decision

### Project identity

`DesignProjectSnapshotV1.id` is the public identity of a Design Project. `chatId` is a unique owned relationship, not the project identity. At most one project may own a chat, and ordinary chat deletion is routed through project deletion.

The project-level `connectionState` records only whether a local app is bound:

- `prototype-only` has no workspace binding;
- `connected` has one opaque workspace ID.

It is a relationship fact, not an origin or authority claim, and grants no read or mutation authority. The library may derive a user-facing Prototype, Connected App, or combined filter from connection state plus canvas contents without persisting `mixed`. Every canvas node records its canonical data source independently as `generated-artifact`, `connected-app`, or `reference-asset`. Connected source access continues to require the existing workspace authorization and stale-snapshot checks. Full permission never bypasses Designer Action review.

### Artboard lineage

Artifact titles are display metadata and must not define history. Each generated artboard node owns:

- a stable `lineageId`;
- an ordered, bounded `artifactMediaIds` history;
- an `activeMediaId` that must be a member of that history.

Artifact media IDs may belong to only one lineage and one project. Rename, new revision, selection, history comparison, and export use lineage identity rather than title. Duplicate creates new node and lineage IDs while remapping every immutable artifact revision.

Generated revisions cross three durable stores through a main-owned publication protocol. The Generative UI record stages validated `{ projectId, lineageId }` ownership beside the immutable media ID. A selected-artboard revision additionally records its exact active base media ID; a new-artboard lineage and node ID are deterministic hashes of project and media identity. The renderer never supplies or reconstructs this ownership from a title.

During generation the record remains a candidate. Only a successfully completed terminal turn marks it eligible before the assistant-message append. An explicit user stop with partial Design output keeps the live preview open and asks the owning desktop renderer to choose **Keep draft** or **Discard** before terminal persistence: Keep crosses the same eligibility barrier as successful output, while Discard omits the descriptors and exact-deletes the staged rows. Dismissed prompts, failed turns, headless clients, and non-user cancellations (deletion, authority changes, scheduled cancellation, or shutdown) take the discard path without blocking for UI. After an eligible descriptor is durable, main commits the blob, atomically appends it to the project lineage, advances `activeMediaId`, and marks the ownership published. Interrupted or incomplete candidates are discarded during Design reconciliation and are excluded from generic HTML-artifact recovery. A selected revision uses semantic compare-and-swap: if its exact base is no longer active, publication fails without replacing the newer active revision.

Startup recovery inspects Design-owned records before generic interrupted-artifact recovery. It publishes an eligible record only when the exact full artifact descriptor—including content ID, media ID, title, MIME type, byte size, and revision parent—is already present in a durable assistant message; an uncommitted eligible record without that proof is discarded, while an anomalous committed record remains suppressed. A cleanup write with an ambiguous result is safe because restart discards any remaining candidate or suppressed row using its persisted generation identity. A crash after project publication but before the final marker is safe because replay recognizes an already-owned media ID and never rolls a lineage back from a newer active revision. Generic recovery handles only records without Design ownership. Legacy artifact records without ownership fields remain readable, and legacy chat migration installs their conservative project ownership as described below.

### Persistence and bounds

Main owns `design-projects.json` under Electron `userData`. The `DataStore` writes it atomically with mode `0600`, rejects corrupt or unsupported input, detects external replacement, and refuses writes while the original file is unsafe. Renderer state is never authoritative.

The V1 schema has exact keys and explicit ceilings for:

- projects and store bytes;
- nodes and artifact revisions per artboard;
- reference-asset IDs;
- title characters and bytes;
- opaque ID lengths;
- finite canvas coordinates and millipixel normalization;
- per-project serialized bytes.

The snapshot has no fields for source code, HTML, prompts, base64 data, absolute paths, capabilities, credentials, process IDs, temporary URLs, or source-selection handles. References are bounded opaque IDs using a path-ineligible alphabet.

Every mutation is compare-and-swap against the project revision. A successful change increments the revision and writes a monotonic timestamp. A stale caller receives the current revision and cannot overwrite the newer project.

### Migration

Opening a legacy `/design/$chatId` route asks an injected main-owned adapter for bounded facts about that chat and its committed `design:` artifacts. Missing/deleted chats do not create projects. An unreadable artifact store or malformed facts block migration without replacing either source store.

Legacy storage has no stable lineage fact. Migration therefore never groups by artifact title: each committed artifact becomes one conservative artboard and one explicit lineage. This may initially show multiple artboards that the old renderer grouped by same-title display text, but it cannot silently invent a false revision history.

- project ID is a deterministic hash of the chat ID;
- node and lineage IDs are deterministic hashes of that artifact's media ID;
- the lineage history contains only that proven media ID and it is active;
- desktop positions reproduce the shipped 1,200 px artboard plus 120 px gap.

The installation is a single atomic project-store mutation that rechecks chat ownership. Concurrent or interrupted first opens therefore converge on one project. A later migration version may merge lineages only if a legacy source gains a stable lineage identifier; titles remain display metadata.

### Copy and deletion

Project copy is a preparation protocol. An injected main-owned coordinator first prepares the target chat plus immutable artifact and asset copies, returning complete old-to-new ID mappings and a scoped rollback. The project row is installed only if the source revision is still current and every reference is mapped. A failed installation invokes rollback.

Deletion is deliberately split:

1. the store produces an exact project- and database-revision-bound cascade plan covering the chat, every artifact in every lineage, reference assets detached from the project, reference assets that become globally unreferenced, and injected comment/action IDs;
2. a future main-owned recoverable coordinator durably journals and executes cross-store deletion;
3. the project-store delete primitive removes only the project row and returns the same plan.

The coordinator journals the exact plan before asking the store to consume it. Any project-database change invalidates the plan, including a concurrent project beginning to reference the same content-addressed asset. The primitive is not, by itself, permission to delete another store. Integration must not expose it directly to renderer IPC before the recoverable coordinator exists.

Removing a missing reference uses the asset store's serialized snapshot guard around the project CAS. An upload already admitted to the asset writer queue therefore restores the content identity first and makes repair fail closed instead of detaching a newly available reference.

## Consequences

- Reload and restart can restore the same durable project state without making renderer state or chat JSON authoritative.
- Phase 2 can implement History without guessing lineage from mutable titles.
- Project connection state cannot be interpreted as write authority because canonical source and authorization remain separate.
- Artifact HTML and reference bytes remain in their purpose-built stores and can retain independent validation and recovery.
- IPC and renderer integration project these main-owned contracts into renderer-safe schemas rather than importing storage internals.
- Chat creation, artifact/asset copy, and cascade deletion run through recoverable coordinators with crash-boundary coverage.
