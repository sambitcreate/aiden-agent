# Design Workspace Durable Projects and Handoff Plan

Status: Complete — Phases 0–6 implemented and verified 2026-09-01
Date: 2026-09-01
Implementation baseline: `feature/design-workspace` at `da1104bcdf1af48eb821ff4f76956e54868dcd6d`
Predecessor: [completed Design Workspace MVP](design-workspace-plan.md)

Research references:

- [Claude Design getting started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Claude Design product-design workflow](https://academy.claude.com/tutorials/using-claude-design-for-prototypes-and-ux)
- [Claude Artifacts code, download, MCP, and persistence surface](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [v0 Design Mode and code workflow](https://api2.v0.dev/docs/quickstart)
- [v0 code editing](https://v0.dev/docs/code-editing)
- [Onlook source-backed visual-edit architecture](https://docs.onlook.com/developers/architecture)

## Execution status

- [x] Phase 0 — contract, ADR, migration fixtures, and responsive IA
- [x] Phase 1 — durable projects, assets, exact canvas restore, and lifecycle recovery
- [x] Phase 2 — Preview / Code / History, deterministic clean export, and offline acceptance
- [x] Phase 3 — recoverable Continue in workspace handoff and restart UI
- [x] Phase 4 — explicit local design-system context, freshness, prompt use, and validation
- [x] Phase 5 — durable comments, bounded direct manipulation, and immutable prototype undo
- [x] Phase 6 — source graph, durable multi-file transactions, contained adapters, onboarding, and package acceptance

Acceptance receipt: [signed development package and operator evidence](../../testing/design-workspace-package-acceptance-2026-09-01.md)

## Executive decision

Keep Design Workspace, but change the next milestone from **more canvas tools** to **a durable local design project that can graduate into real code**.

Aiden should align with the useful Claude Design product loop:

```text
durable project
  → chat and visual exploration
  → inspectable code and versions
  → design-system-aware refinement
  → explicit engineering handoff
```

Aiden should not copy Claude Design's hosted product boundary. Its differentiation is:

- local-first project and source ownership;
- the user's existing provider and model rather than a dedicated model stack;
- generated prototypes with no implicit repository, command, network, or Git authority;
- source changes that always show an exact review and require approval;
- a managed-worktree-first path from design intent to inspectable code.

This is a priority pivot, not a product reset. The shipped generated-artifact and source-backed runtimes remain the foundation.

## Why this follow-on exists

The shipped UI looks like a project canvas, but its durable unit is still a chat-linked HTML artifact:

- generated HTML survives restart in `generative-ui-artifacts.json`;
- chat messages retain artifact metadata and media IDs;
- React Flow positions, viewport, selected revision, uploaded reference nodes, and visual-edit state live only in renderer memory;
- generated source has no native Code view;
- export produces one sandboxed standalone `.html`, not a clean source bundle;
- a connected app exposes only the selected before/after range in Designer Action review;
- the Design route does not expose the normal Files or Review surfaces;
- action history and preview ownership do not survive app restart.

That boundary is safe, but it is not yet the durable project, source visibility, and handoff experience people reasonably infer from the canvas.

## Product contract

### 1. Design Project becomes the durable user object

`DesignProjectId`, not `chatId`, becomes the public identity of Design Workspace.

Each project owns:

- one canonical attended design conversation;
- generated artboards and immutable revisions;
- optional connection to one authorized local workspace/app;
- reference images and bounded source/design-system context;
- the saved canvas arrangement and presentation state;
- comments, decisions, and action history introduced by later phases;
- explicit export and handoff records.

The backing chat remains reusable infrastructure, but it is no longer the product's visible storage model.

### 2. Two origins remain explicit

| Origin            | What is canonical                           | Mutation rule                                                                                   |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Prototype**     | Aiden-owned immutable HTML/CSS/JS revisions | A prompt, comment, or direct edit creates a new artifact revision; it never writes a repository |
| **Connected app** | Files in the authorized local workspace     | Every change becomes the same hash-bound Designer Action and requires exact review              |

The UI must visibly label the origin. A generated prototype never silently acquires workspace authority, and connecting an app never rewrites existing generated revisions.

### 3. Align behavior, not hosting

Match Claude Design where it improves the local workflow:

- persistent projects and project library;
- chat plus canvas refinement;
- reference images and code/design-system context;
- inline comments;
- direct visual controls for bounded changes;
- versions and history;
- code inspection and clean export;
- explicit coding-agent/workspace handoff.

Do not treat these as parity requirements:

- hosted sharing links or public publishing;
- simultaneous multiplayer editing;
- organization administration and analytics;
- PDF/PPTX/Canva/partner export matrix;
- one-click deployment, domains, or a hosted application runtime;
- an Anthropic-specific MCP dependency.

## Competitive alignment matrix

| Product expectation       | Current Aiden                                 | Delivery decision                                                         |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Durable named project     | Chat-linked artifacts only                    | **Immediate:** add a main-owned project store and Design library          |
| Reopen exact canvas       | Artifact bytes survive; layout does not       | **Immediate:** persist versioned canvas snapshots                         |
| Preview and code          | Preview plus standalone HTML export           | **Immediate:** add Preview, Code, and History surfaces                    |
| Clean source export       | One wrapper `.html`                           | **Immediate:** export canonical source and a deterministic ZIP bundle     |
| Design conversation       | Floating composer on canvas                   | Preserve; add a wide-layout collapsible project/conversation rail         |
| Reference assets          | Upload works for the current renderer session | Persist bounded assets and their canvas nodes                             |
| Design-system context     | Not implemented                               | Add explicit local snapshot/import after project durability               |
| Inline comments           | Not implemented                               | Add persistent element/artboard comments after source identity is durable |
| Direct manipulation       | Not implemented                               | Add narrow token/literal actions through the existing review transaction  |
| Engineering handoff       | Listed as later depth                         | Make **Continue in workspace** a primary milestone                        |
| Existing app visual edits | Narrow Vite/React path ships                  | Preserve and deepen after the project/code foundation                     |
| Sharing/deployment        | Not implemented                               | Deliberately defer; export and local handoff come first                   |

## Durable model

### `DesignProjectSnapshotV1`

Main owns an atomic, owner-only store under Electron `userData`. Renderer storage is never authoritative.

```ts
interface DesignProjectSnapshotV1 {
  version: 1;
  id: string;
  revision: number;
  title: string;
  chatId: string;
  workspaceId?: string;
  connectionState: "prototype-only" | "connected";
  createdAt: number;
  updatedAt: number;
  canvas: {
    viewport: "desktop" | "tablet" | "phone";
    flowViewport: { x: number; y: number; zoom: number };
    nodes: Array<{
      id: string;
      kind: "artboard" | "reference-image" | "source-preview";
      canonicalOrigin: "generated-artifact" | "connected-app" | "reference-asset";
      lineageId?: string;
      x: number;
      y: number;
      artifactMediaIds?: string[];
      activeMediaId?: string;
      assetId?: string;
    }>;
  };
  referenceAssetIds: string[];
  designSystemBinding?: {
    id: string;
    revision: number;
  };
}
```

Rules:

- Store updates use compare-and-swap revisions and the existing atomic `DataStore` safety contract.
- Cap projects, nodes, coordinates, titles, reference assets, and serialized bytes.
- Cap and normalize coordinates before persistence; reject `NaN`, infinity, and renderer-crafted oversized snapshots.
- Do not persist preview capabilities, process IDs, source-selection handles, temporary URLs, provider credentials, prompts, or file contents in the project snapshot.
- Reference images move to a bounded content-addressed asset store; project JSON holds IDs, not repeated base64 payloads.
- Artifact HTML remains in the authoritative Generative UI store until a separately tested migration proves a better layout.
- Opening an existing design chat lazily and idempotently creates a project using its committed `design:` artifacts.
- Existing routes redirect compatibly from `/design/$chatId` to the new project identity without breaking saved links.
- Every generated artboard receives a stable lineage ID during migration. Titles are labels, never revision identity; renaming or reusing a title cannot merge histories.
- `canonicalOrigin` is required for every node and must match its kind. `lineageId` and ordered `artifactMediaIds` are required for artboards, while reference-image and source-preview nodes forbid lineage fields.
- Connection state never grants mutation authority. Each artboard retains its canonical origin, and only a connected-app artboard with a live proven source binding can propose a Designer Action.
- Project duplication copies its referenced immutable artifacts and assets through the existing crash-recoverable preparation flow.
- Project deletion previews its cascade and removes the backing chat, project snapshot, unreferenced artifact records, assets, comments, and action history as one recoverable operation.
- Ordinary chat deletion cannot silently strand or remove a Design Project; route it through the project deletion confirmation.

## User experience target

### Design library

The persistent **Design** destination opens a project library with:

- New project;
- recent projects with title, origin, update time, and artboard count;
- Prototype and Connected App filters;
- duplicate, rename, export, and delete actions;
- a clear local-storage label;
- recovery states when a project or artifact needs repair.

Creating a project asks for one material choice:

1. **Prototype an idea** — repository-free generated design; or
2. **Connect a local app** — select/reuse an authorized workspace and review its detected app command.

### Project workbench

Wide layouts use a collapsible project rail and canvas:

- **Conversation** — prompts, decisions, and comments;
- **Canvas** — existing React Flow surface;
- **Inspector** — Preview / Code / History for the current selection.

Compact layouts keep the canvas primary and present conversation/inspector as accessible drawers. Do not reuse the narrow Environment overlay.

The elevated composer remains the model/context control plane. The selected provider, model, permission, and project origin remain visible and stable.

### Code surface

Phase 2 starts with an honest read-only view of the canonical generated document:

- syntax-highlighted source with line numbers and find;
- Copy source;
- Save standalone HTML;
- Download source bundle;
- content hash, byte size, revision, and provenance;
- no claim that inline CSS/JS are separate files when the canonical artifact is one document.

The deterministic source bundle initially contains:

```text
<project-title>/
  index.html
  README.md
  design-project.json
  references/            # only explicitly included, safe assets
```

`README.md` records the design brief, viewport expectations, revision identity, the immutable source revision timestamp, and that the output is a prototype requiring engineering review. The mutable save/export time lives only in Aiden's local export record, outside the bundle. ZIP entries use a fixed order, timestamp, and mode so identical inputs produce identical bytes. Host libraries are inlined or included from Aiden's verified vendored copies; no CDN is introduced.

For a connected app, Code shows the actual proven workspace file read through the existing authorized file service, plus the selected binding and current diff. Editing remains disabled until the same stale-snapshot and Designer Action boundaries can back it.

## Delivery phases

### Phase 0 — contract, ADR, and migration fixtures (2–4 days)

Deliverables:

- Write an ADR for project identity, chat ownership, artifact references, deletion, copy, export, and migration.
- Freeze `DesignProjectSnapshotV1`, IPC schemas, byte/count ceilings, and revision/CAS behavior.
- Add fixture stores for current generated-only chats, mixed generated/source projects, copied chats, deleted chats, corrupt artifacts, and interrupted migrations.
- Prototype the project library and Preview / Code / History information architecture at 390, 700, 1000, and 1280 px.
- Record terminology: **Design Project**, **Prototype**, **Connected App**, **Continue in workspace**, and **Designer Action**.

Exit gate:

- Every existing committed Design artifact has one deterministic migration outcome.
- Deleting, copying, or renaming cannot orphan or silently destroy artifact bytes.
- The project snapshot contains no transient capabilities, secrets, code, prompts, or absolute paths.

### Phase 1 — durable projects, assets, and exact canvas restore (6–10 days)

Deliverables:

- Add the main-owned project store, project library IPC, and renderer queries.
- Migrate existing design chats lazily and idempotently.
- Persist node positions, active revisions, viewport, project title, origin, and bounded reference assets.
- Restore the exact canvas after route changes, renderer reload, and app restart.
- Add optimistic local movement with debounced revisioned persistence and explicit conflict recovery.
- Add rename, duplicate, and recoverable delete.
- Keep preview processes stopped after restart; restore only the saved configuration and require explicit Start.

Exit gate:

- A project with 20 artboards and 10 references reopens with the same arrangement after a forced renderer crash and full app restart.
- Stale renderer writes cannot overwrite a newer project revision.
- Artifact, project, asset, and chat cleanup passes crash-boundary tests.

### Phase 2 — Preview / Code / History and clean export (5–8 days)

Deliverables:

- Add the selection inspector with Preview, Code, and History tabs.
- Show generated canonical source read-only with Copy and Save actions.
- Show connected-app source only through authorized workspace reads and stale snapshots.
- Add immutable revision history, labels, timestamps, model provenance, and comparison between two generated revisions.
- Export standalone HTML and a deterministic ZIP source bundle.
- Add **Reveal saved location** only for user-chosen exports; do not expose the internal JSON store as an editable project.

Exit gate:

- A user can answer where a project is saved, inspect its source, compare revisions, and export it without opening internal app data.
- Exported output runs offline, contains no credentials or absolute paths, and passes containment/package inspection.

### Phase 3 — Continue in workspace (7–12 days)

Deliverables:

- Add a primary **Continue in workspace** action for a selected generated revision.
- Default to an Aiden-managed worktree created from committed `HEAD`; clearly disclose that dirty source-checkout changes are not included.
- Let the user choose an existing authorized workspace only through a stronger warning and exact target preview.
- Create a bounded handoff packet containing the selected source bundle, reference asset IDs, design decisions, responsive states, and artifact hashes.
- Open a normal workspace chat/task with that packet as untrusted design context.
- Require ordinary file-tool approvals and Review for implementation; the handoff itself never writes application source.
- Link the resulting workspace task and branch back to the Design Project without granting the prototype ongoing authority.
- Journal worktree creation, chat creation, handoff-context installation, and project-link publication under one main-owned coordinator. Before publication, cancellation rolls back when that can be proven safe; after the boundary, Aiden preserves and surfaces the recoverable managed workspace rather than claiming the source repository is unchanged.

Exit gate:

- The handoff can produce a clean, reviewable implementation diff without copying hidden prompts, internal JSON, credentials, or unrelated chat history.
- Canceling before worktree creation leaves the source repository unchanged. Cancellation after creation either proves rollback or preserves an explicitly recoverable managed workspace.
- Project, task, worktree, and branch identities remain explicit and recoverable.

### Phase 4 — local design-system context (8–14 days)

Deliverables:

- Add explicit **Attach design system** from an authorized local workspace/package.
- Start with semantic tokens, typography, spacing, radii, shadows, icons, and a reviewed component catalog; do not execute arbitrary repository code during indexing.
- Store a bounded, versioned, path-free normalized snapshot under `userData`; retain source hashes and workspace-relative provenance in main only.
- Show exactly what will be sent to the selected model and allow detach/refresh.
- Use the snapshot in prototype prompts and validate output against named tokens/components where possible.
- Add monorepo package and route selection with explicit confirmation.

Exit gate:

- Refresh detects changed source and never serves a stale snapshot as current.
- A design-system attachment does not add repository write, command, network, or Git authority.
- Generated output visibly uses the selected semantic system in golden fixtures without bundling proprietary source files into exports.

### Phase 5 — comments and bounded direct manipulation (10–16 days)

Deliverables:

- Add persistent comments anchored to artboard revision plus exact React Grab selector/source identity.
- Resolve, reopen, and mark stale comments when their target revision or source binding changes.
- Add direct controls only for a proven literal matrix: spacing, size, alignment, color token, radius, and static text where safe.
- Prototype-origin direct edits create a new immutable artifact revision.
- Connected-app direct edits emit the same Designer Action proposal and exact review as model-generated edits.
- Add a layers tree only after it shares the exact selection/identity contract; never create a second DOM authority.

Exit gate:

- One gesture maps to one revision or one reviewable action and one exact undo step.
- Dynamic/localized/rich text, computed classes, ambiguous components, and shared repeated definitions fail closed.
- Keyboard, pointer, high-contrast, reduced-motion, and compact-layout paths have focused coverage.

### Phase 6 — source depth, adapters, and release acceptance (8–14 days)

Deliverables:

- Add durable multi-file Designer Actions with atomic rollback, crash recovery, and conflict review.
- Introduce a source manifest/runtime-instance graph for custom components and repeated instances.
- Add contained Vite WebSocket/HMR only after packaged orphan-process and navigation acceptance.
- Revalidate every HTTP redirect against the fixed loopback preview target before adding WebSocket/HMR proxying.
- Add Next.js behind separate App Router, Pages Router, webpack, Turbopack, server/client, and route fixtures.
- Update onboarding and the final feature-tour gallery with the durable-project and handoff mental model, including a new optimized 1024 × 1024 transparent asset if the existing tile no longer represents the product.
- Run signed/package inspection and real-client operator acceptance.

Exit gate:

- Supported source selections resolve correctly or explicitly fail; they never guess a file/range.
- Multi-file Apply/Undo survives app termination at every write boundary.
- A signed package starts, restores, edits, exports, hands off, and cleans up without orphaned preview processes.

## Mobile and remote contract

The interactive canvas remains Mac-only until a separate native design surface is approved.

iOS and Android may receive only a bounded project projection:

- project ID, title, origin, updated time, artboard count, and static thumbnail when available;
- an informational **Available on Mac** state for interactive preview/code/edit until a separate authenticated, consent-aware remote-open command is designed;
- no executable HTML, source paths, project JSON, comments with code snippets, preview URLs, or Designer Action payloads.

Changes to shared chat/artifact contracts require inspection and focused tests in both native clients. Unsupported HTML continues to render an explicit Mac-only state rather than a blank card.

## Security and privacy invariants

- All project, artifact, asset, comment, and action stores are device-local, owner-only, bounded, schema-validated, atomic, and recoverable.
- Generated guests keep their unique-origin sandbox and network-denying CSP.
- Design-system indexing is explicit, read-only, workspace-authorized, and does not execute package code.
- Raw code or design-system context goes only to the provider/model selected by the user for that accepted turn.
- Project selection, comments, and direct manipulation are context—not authority.
- Full permission never bypasses Designer Action review.
- Handoff never stages, commits, pushes, creates a PR, deploys, or writes source automatically.
- Remote URLs, hosted shares, and partner exports do not enter the local preview allowlist.
- Internal stores are not advertised as user-editable files; export creates an explicit portable copy.

## Verification matrix

### Storage and migration

- First launch, lazy legacy migration, duplicate migration, old-version read, schema rejection, corruption, unsafe file, disk full, and interrupted atomic publication.
- Concurrent canvas movements, stale CAS, rename/copy/delete races, chat deletion, artifact deletion, shared asset references, and garbage collection.
- Renderer crash, main crash, full restart, app update, and one-version rollback.

### Project UI

- Empty/new/recent/mixed-origin/recovery states.
- Exact canvas restore at 390, 700, 1000, and 1280 px.
- Conversation and inspector drawers, keyboard traversal, focus restoration, VoiceOver names, high contrast, and reduced motion.
- Large bounded projects without unbounded React Flow or source-render work.

### Code and export

- Source escaping, syntax rendering, copy, find, revision comparison, stale connected files, and unauthorized workspace access.
- Deterministic ZIP manifest, offline open, no CDN, no secrets/absolute paths, executable/symlink rejection, and export cancellation/overwrite behavior.

### Handoff and source changes

- Managed-worktree creation from committed `HEAD`, dirty-source disclosure, cancellation, branch identity, task linkage, and cleanup.
- Ask/Full/No Access behavior, exact before/after review, stale preimage/postimage, Deny, Apply, Undo, crash recovery, and multi-file rollback.

### Design systems and direct edits

- Token bounds, component-catalog bounds, refresh/staleness, detach, malicious files, symlink swaps, and no package execution.
- Exact selector/source identity, repeated instances, custom components, static/dynamic text, Tailwind literals, CSS custom properties, and ambiguous failure states.

## Delivery priority

1. **Now:** Phase 0 contract and Phase 1 durable projects.
2. **Next:** Phase 2 code/history/export and Phase 3 managed-worktree handoff.
3. **Then:** Phase 4 design-system context and Phase 5 bounded visual editing.
4. **After evidence:** Phase 6 broader source adapters and release acceptance.

Do not start sharing, multiplayer, deployment, or partner exports before Phases 1–3 prove that Aiden can preserve, expose, and hand off one local Design Project reliably.

## Definition of aligned

Aiden is sufficiently aligned with Claude Design for its chosen local-first position when a person can:

1. create or reopen a named Design Project;
2. see the same artboards, references, arrangement, and history after restart;
3. refine broadly through chat or narrowly through a selected element/comment;
4. inspect and copy the underlying generated source;
5. export a portable prototype bundle;
6. attach bounded context from a real local design system;
7. continue the chosen design in an isolated workspace with its intent and references intact;
8. review every repository change and undo exact accepted actions;
9. understand at every step what is stored locally, what is sent to a model, and what can mutate source.

Hosted collaboration and one-click deployment are separate product decisions, not blockers for this alignment milestone.
