# Create Images — Node Banana Learnings Roadmap

Status: Active — implementation complete through Phase 6; release operations remain  
Started: 2026-08-21  
Aiden baseline: `107712a29c44902659aecab430d1fd17f421e008` plus the preserved working-tree Gemini/lightbox fixes  
Node Banana research revision: `5c0e0ae6150f29a6de819f8d6f1dedba15151f7c` (`master`, clean checkout)

## Purpose

This is the active follow-on plan for Create Images workflow polish and advanced creative workflows. It does not expand or rewrite the historical MVP plan. Node Banana remains a behavioral reference; Aiden implements the selected behavior with Aiden-owned schemas, main-process trust boundaries, durable journals, explicit paid consent, no automatic paid retry or fallback, semantic theme tokens, and accessible progressive disclosure.

No phase may weaken these invariants:

- Credentials, provider calls, asset bytes, native paths, rasterization, exports, and durable run state remain main-owned.
- Renderer contracts use validated, bounded values and opaque IDs. Graphs, clipboard fragments, diagnostics, and proposals contain no paths, credentials, provider payloads, image bytes, or raw responses.
- Paid submissions require the existing explicit consent path. Browsing, extraction, layout, pause inspection, and proposal application never submit provider work.
- Run snapshots remain immutable and journals remain monotonic, hash-chained, owner-scoped, and the authority for result history.
- Light, dark, high-contrast, reduced-motion, keyboard, focus-return, and screen-reader behavior are release gates.

## Delivery checkpoints

1. Close the existing clean Gemini live-acceptance gate only through an explicitly authorized in-app request.
2. Ship Phases 1–3 as an opt-in workflow-polish preview after source, package, update, migration, accessibility, and performance gates pass.
3. Ship Phases 4–6 behind per-device gates, then promote only after Phase 7 release evidence is complete.

## Phase status

| Phase | Scope | Status | Exit evidence |
| --- | --- | --- | --- |
| 0 | Stabilize and freeze the baseline | Source/package baseline frozen; live gate pending | Current source/package gates are green. The clean real-key Gemini acceptance remains an explicitly authorized, potentially billable release gate. |
| 1 | Canvas velocity and discoverability | Implemented and locally verified | Bounded clipboard/placement/layout/edge/scoped-run/export paths are keyboard-accessible and covered by source and packaged canvas acceptance. |
| 2 | Image iteration and output reuse | Implemented and locally verified | Recent outputs, galleries, lineage browsing, compare, extraction, presentation hiding, ZIP, restart, pruning, and zero-provider-traffic browsing contracts pass. |
| 3 | Presentation, performance, templates, and teaching | Implementation complete; preview release pending | Presentation, rendition, title/comment, preference, template, tutorial, diagnostics, accounting, accessibility, onboarding, and performance gates pass. The notarized opt-in preview, prior-release update, and populated-storage migration are release operations still pending. |
| 4 | Advanced creative structure | Implemented behind Power features | Packaged Konva integration, schema migrations, annotations/rasterization, prompt variables, groups, archive/import, undo, and bounds tests pass. |
| 5 | Durable pause and bounded batching | Implemented; live batch gate pending | Durable pause/resume, drift checks, Prompt List, eight-request admission, per-item journaling, cancellation, partial failure, and accounting tests pass. The explicitly authorized minimal live batch remains pending. |
| 6 | Prompt-to-workflow proposals | Implemented behind Power features | Selected-chat-model proposal generation, strict hostile-output validation, complete diff, provider-switch/drift handling, one-transaction apply, and no-auto-run contracts pass. |
| 7 | Broad release hardening | Local hardening complete; broad release pending | Current source, full-suite, build, signed development package, package verification, artifact fingerprint, and packaged acceptance gates are green. Notarization, prior-release update, populated-storage migration, minimum-hardware acceptance, and billable live gates remain. |

## Phase 0 — Stabilize and freeze the baseline

- Complete explicitly authorized live Gemini text-to-image and reference-edit acceptance without automatic submissions.
- Update Phase 4/5 evidence, project memory, the plan index, and this follow-on plan.
- Capture source/package fingerprints and the exact Node Banana research revision.
- Freeze existing schema, run, asset, accessibility, and packaged-performance results as regression baselines.
- Exit only after Gemini produces a validated durable output in a clean run and all current source gates pass.

## Phase 1 — Canvas velocity and discoverability

- Create and connect a compatible node as one undoable transaction when a connection is dropped on empty canvas.
- Add double-click and right-click contextual node search plus drag-from-palette exact placement.
- Add bounded cross-workflow graph-fragment copy/paste using a versioned Aiden MIME payload with graph data and opaque asset IDs only.
- Enforce paste precedence: valid Aiden fragment, image clipboard, then non-empty text creating a Prompt node.
- Add horizontal, vertical, and grid arrangement for multi-selection.
- Add a canvas-shortcuts help surface and direct shortcuts without conflicting with Aiden's command system.
- Add a selected-edge inspect/delete toolbar. Pause controls arrive in Phase 5; loop edges remain excluded.
- Add contextual Run this node through the existing scoped-run and consent path.
- Add native Save to output, image input, and lightbox surfaces through authorized main-owned export.

## Phase 2 — Image iteration and output reuse

- Add a device-wide Recent Images shelf derived from the latest 50 retained generated outputs. Show fan preview, count, prompt/model/time-safe metadata, an overflow drawer, presentation-only clear, and secure drag-back-to-canvas.
- The shelf never pins assets. Pruned outputs disappear; drag-back creates a durable Image Input reference.
- Complete Output Gallery count/grid, keyboard/lightbox navigation, download, presentation-only hide/restore, and selected/all extraction into collision-aware Image Input nodes.
- Add per-generator navigation across the latest 50 retained outputs in that node's lineage. Browsing submits no provider work.
- Add an Image Compare node with exactly two authorized image inputs and a draggable accessible A/B divider.
- Add bounded collision-safe ZIP export for selected images through native IPC.

## Phase 3 — Presentation, performance, templates, and teaching

- Add bounded node resizing, media-aspect fit on double-click, persisted dimensions, and accessible resize alternatives.
- Add adaptive rendition buckets with single-flight requests and byte-bounded `{assetId, rendition}` caching.
- Add custom node titles, bounded comments, unread navigation, and focus-safe editing.
- Add device-level canvas navigation preferences that preserve existing defaults.
- Add a main Settings → Create Images surface for the device-level autosave, Power features, and canvas-navigation preferences. Autosave remains the default; turning it off reveals an explicit workflow Save control, while Run deliberately saves the exact graph before review.
- Treat drag and resize updates as transient editor state. Publish one committed document after the gesture ends, and reject resize drafts that did not begin from an explicit node edit gesture so renderer layout observers cannot exhaust the main-owned mutation budget.
- Replace the text template list with an offline visual explorer with search, categories, tags, previews, and keyboard navigation.
- Add a disposable local-mock Create Images tutorial for add/connect/run/inspect/extract/save. It never bills or modifies the library unless the user explicitly keeps the result.
- Add safe diagnostic summary copy actions containing only codes, IDs, model, timestamps, and states.
- Distinguish estimate, reported actual cost, and unknown cost. Estimates require a main-owned source-stamped pricing snapshot; stale or unsupported values show Unknown.
- Produce the first notarized opt-in preview after light/dark/high-contrast/reduced-motion, 100/250-node, thumbnail-memory, onboarding, prior-update, and populated-storage migration gates pass.

## Phase 4 — Advanced creative structure

- Gate Annotation on a packaged Konva/react-konva dependency, license, memory, and interaction spike. A failed spike blocks Annotation until this plan is amended.
- Support rectangle, ellipse, arrow, freehand, and text shapes; selection/move/resize; semantic stroke/fill controls; undo/redo; and immutable flattened PNG output.
- Persist bounded shape specifications only. Validated shape data and opaque source assets cross into main-owned rasterization; renderer paths never do.
- Add Prompt `${name}` tokens with autocomplete, escaped literals, stable variable IDs, unique bounded names, at most 32 variables, one typed input per variable, and missing-value validation.
- Add resizable colored groups with rename, group/ungroup, semantic presets, and layout-only locking. Deleting a group preserves its members; locks never skip execution.
- Keep controls behind the per-device Power features setting, while revealing required controls for workflows that already contain them.

## Phase 5 — Durable pause and bounded batching

- Add edge breakpoints that pause after required upstream publication and before downstream provider submission.
- Persist a recoverable `paused` run state. Resume continues the same immutable snapshot and run ID without rerunning completed nodes.
- Revalidate credentials, capabilities, pricing/consent drift, assets, and graph/run identity before resume; Stop remains available while paused.
- Add a Prompt List node accepting newline items or a validated JSON string array.
- Limit a confirmed batch to eight provider invocations including output-count multipliers; preserve order and stable item IDs.
- Journal each item's queued/submitted/succeeded/failed/blocked/cancelled/output/usage/cost state.
- Consent shows the exact maximum request count and available estimate. Paid batch retries and fallbacks are never automatic.
- Cancellation blocks queued submissions. Already submitted work may finish or incur cost and remains attached only to the originating run.

## Phase 6 — Prompt-to-workflow proposals

- Use the currently selected Aiden chat model, never the image credential, to propose workflows.
- Send only a bounded user-authored request and require a strict graph proposal with no tools, credentials, paths, asset IDs, executable code, or provider requests.
- Limit proposals to 50 nodes, 200 edges, and shipped Create Images node types. Image inputs are empty placeholders.
- Validate with production schema, ports, graph limits, model capabilities, and request/cost analysis.
- Show the complete graph diff and request/cost implications before Apply.
- Apply as one undoable transaction. Apply never runs or contacts an image provider.
- Fail closed on malformed, unsupported, oversized, cyclic, or ambiguous proposals and leave the workflow unchanged.

## Phase 7 — Broad release hardening

- Run the full source, migration, accessibility, security, performance, packaging, update, notarization, and artifact-inspection matrix.
- Prove old workflows migrate without execution-meaning changes; future/corrupt schemas remain read-only and recoverable.
- Map supported Node Banana additions or report unsupported behavior without importing secrets or unsafe paths.
- Inspect ASAR, SBOM, and notices and prove research files, prompts, assets, credentials, journals, and fixtures are excluded.
- Promote advanced gates only after their phase evidence is complete.
- Broaden availability only after minimum-hardware 250-node, 50-image history, annotation, eight-item batch, crash recovery, and prior-release update gates pass.

## Contract evolution

- Version the workflow schema with migrations for node dimensions/titles/comments, groups, Image Compare, Annotation, Prompt variables, and Prompt List. A phase never writes a future field before its implementation gate is active.
- Add narrow main-owned APIs for recent outputs, rendition grants, asset extraction, native save/ZIP, presentation hiding, run pause/resume, and proposals. Inputs remain size-bounded and document-owner scoped.
- Extend run contracts with paused checkpoints and batch-item events while retaining immutable snapshots, monotonic sequences, hash chains, and no-duplicate-paid-request recovery.
- Store navigation and Power features as device preferences, not execution settings.
- Keep run journals authoritative; shelves, carousels, and galleries remain derived presentations.

## Test and release gates

- Register each new test in `test:create-images` or its owning aggregate.
- Cover migrations, hostile clipboard fragments, limits, undo, compatible creation, layout, dynamic ports, asset grants, pruning, gallery extraction, hiding, rendition pressure, exports, and hostile ZIP input.
- Cover keyboard/focus/screen-reader/shortcut/reduced-motion/theme/contrast/tutorial/responsive behavior.
- Cover annotation bounds, malformed shapes, raster failure, variable validation, groups, import/export, and reference accounting.
- Cover pause/restart, drift, stop, partial batches, eight-item admission, cancellation, ambiguity, and cost reconciliation.
- Cover hostile proposals, unsupported graphs, diff accuracy, zero automatic execution, and atomic apply.
- After React phases run React Doctor, focused tests, `test:create-images`, onboarding, type-check, lint, build, package/verify, and packaged acceptance.
- At release checkpoints also run the full suite, `dist`, notarized launch, prior-release update, populated-storage migration, and artifact inspection.

## Provenance ledger

| Reference | Audited revision | Use | Product-source adaptation |
| --- | --- | --- | --- |
| Node Banana | `5c0e0ae6150f29a6de819f8d6f1dedba15151f7c` | Behavioral research for canvas, image reuse, gallery, templates, compare, annotation, grouping, and batching interactions | None. Implementations are clean Aiden-native code unless a later row names an exact upstream path, symbol, license, and adaptation. |

Excluded from adaptation: raw data-URL persistence, renderer-held credentials, direct filesystem paths, dark-only styling, automatic provider fallback, automatic billable retry, auto-run-on-connect, and execution-skipping group locks. Also out of product scope: video, audio, 3D, arbitrary providers/models, loop edges, and community templates.

## Implementation and verification record — 2026-08-21

Phases 1–6 are implemented as Aiden-native code. Advanced creative and proposal controls remain progressively disclosed behind the device-level Power features setting. Phase 7 local hardening is complete, but this plan remains active because release operations and explicitly billable acceptance cannot be inferred from implementation approval.

Current exact-tree evidence:

- Source fingerprint: `54d38be108eb245d275ba27c4e0b5869fbd719acd34bfb5991a798e58dbc0a13`; the signed development package was reverified against it after the final autosave and gesture-publication fixes.
- Create Images aggregate: 11/11 pretests, 490/490 functional tests, 2/2 performance tests, and 15/15 native/source-integrity checks.
- Performance journal gate: 100/250/500-node append measurements of 20,209/51,953/109,068 ms; 1,502-event replay in 184 ms; 635,757-byte current journal.
- Output-rich restart gate: 1,000 terminal journals with 250 output IDs per run; 4,563 ms restart, 4,441 ms admission, 20,554 ms product path, and 69 ms retention.
- Repository gates completed during hardening: full `npm test`, onboarding tests, type-check, lint, build, package, package verification, source-fingerprint verification, and `git diff --check`.
- React Doctor reported no critical errors and an advisory score of 63/100. Its warnings are recorded rather than suppressed: the changed surface includes deliberately serialized durability/security work, the existing large canvas component, stable duplicate-output rendering, and packaged-evidence loops.
- Signed development package acceptance used `/create-images/stress-100`: 0 renderer errors, 0 network requests, 1/1 renderer-egress probe blocked, 39 keyboard actions, 38 live-region mutations, reduced-motion/focus/responsive checks, durable reload, opaque asset delivery, no graph base64, and exact configured-workspace storage mutations all passed.
- Exact packaged workflow acceptance also passed durable prompt autosave and renderer-restart persistence. Device-local manual save remains opt-in through Settings → Create Images; only high-frequency gestures defer publication until commit.
- Packaged Phase 2 storage acceptance imported and previewed a 21,033,819-byte 4000 × 4000 image through an authorized main-owned asset protocol and validated the exact 12-file configured-workspace contract.
- Acceptance attestation: `build/create-images-packaged-acceptance/attestation.json`.

Release gates intentionally not executed:

- No real-key Gemini text-to-image/reference acceptance or minimal live batch was submitted. Each remains potentially billable and requires explicit, per-run user authorization in the app.
- The development package is signed, but notarization was intentionally skipped. The first notarized opt-in preview, update from the prior release, populated-storage migration, and minimum-hardware release matrix remain Phase 3/7 release operations.
