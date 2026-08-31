# Design Workspace Plan

Status: Partial — spatial HTML/CSS MVP shipped; source-backed editing starts at Phase 4's go/no-go gate

Date: 2026-08-30

Product references: Open Design, MagicPath interaction material supplied by the product owner, React Flow, and React Grab

Source-backed research baseline: Aiden `b6b0eff6bb55e0113a05cc8d069fce2c1be67b40`; Onlook `423e2e924366419e418ee049093872d535eea41a`

## Product outcome

Design Workspace is one first-class Aiden product: an infinite canvas where a person and the existing AI backend create, inspect, and refine live interfaces. The shipped path owns app-generated, network-free HTML/CSS/JS artboards. Later phases add an explicit source-backed project path for local Vite/React apps, reviewed workspace writes, exact diffs, and undo.

The two document origins share the Design sidebar entry, spatial canvas, React Grab selection language, context chips, composer, and review concepts. They do **not** share authority:

| Document origin | Current state | Authority |
| --- | --- | --- |
| Generated design | Shipped MVP | App-owned artifacts only; no repository, command, network, or source authority |
| Source-backed app | Planned behind Phase 4 gate | Explicit project opt-in; main-owned preview lifecycle, source mapping, always-reviewed writes, action review, and exact undo |

This is intentionally one roadmap rather than a small chat feature plus a separate Designer Mode product. “Designer mode” is the visual-edit interaction inside Design Workspace, not another sidebar destination.

## Non-negotiable product contract

- Design remains a full-height, canvas-first destination from the persistent sidebar.
- React Flow owns spatial artboards, images, pan, zoom, marquee selection, placement, fit controls, and accessible canvas navigation. Rendered HTML elements never become React Flow nodes.
- React Grab owns element hit-testing inside each sandboxed or instrumented document.
- Visual edit mode selects the **exact single DOM `Element` returned by React Grab**. Aiden must not promote a nested text span, icon, button child, or layout container to the nearest `data-aiden-id` ancestor.
- One exact element may be selected per artboard. Shift may preserve selections across different artboards, within the existing bounded context limit.
- An exact element with its own valid `data-aiden-id` uses that stable identity; every other element uses React Grab's exact selector as bounded, untrusted prompt context.
- Selection is context, not authority. It never by itself permits file reads, writes, shell execution, network access, source changes, Git operations, or tool escalation.
- The selected provider and model remain unchanged. Design uses the current Aiden AI backend rather than a second agent stack.
- Generated-design edits return complete immutable HTML revisions. Source-backed edits use a main-owned, hash-bound proposal and approval transaction.
- GitHub import, plugin install, pull requests, deploy, sharing, multiplayer, and hosted collaboration are not MVP requirements.

## Shipped foundation

### Phase 1 — focused generated-design backend — complete

- `design: true` is an exact, main-validated attended-turn intent and cannot combine with `/visualize`.
- A positive capability allowlist leaves only the Design-owned `render_artifact` extension; coding, file, shell, web, MCP, schedules, skills, Computer Use, image generation, Telegram controls, and subagents remain unavailable.
- `render_artifact` accepts complete inline vanilla HTML/CSS/JS documents. Cross-turn results are immutable `design:` artifacts in app-owned, crash-recoverable storage.
- Main revalidates exact media IDs and content hashes, loads only app-owned HTML, caps combined context at 128 KiB, and marks prior designs and element descriptors as untrusted model reference data.
- The existing opaque-origin `sandbox="allow-scripts"` iframe, network-denying CSP, strict validator, storage quotas, export flow, and native transcript contract remain authoritative.
- The Design brief supports up to four requested screens, stable titles for revisions, distinct titles for new artboards, responsive semantics, keyboard states, and meaningful `data-aiden-id` markers.

### Phase 2 — first-class full canvas — complete

- `Design` appears beside Scheduled and Bots in the persistent sidebar.
- `/design` resolves an eligible ordinary chat in the active workspace and `/design/$chatId` owns the stable studio URL.
- The route replaces the conversation body with a full-height canvas while keeping the persistent app sidebar and the durable chat/provider/model owner.
- The prompt composer floats above the continuous canvas instead of sitting in a footer surface.
- Design cards deep-link to their route and revision. The Design route does not mount Environment, Terminal, a side workbench, or a compact modal.
- Empty, generating, ready, stale-preview, unavailable, desktop, tablet, phone, revision, and export states remain truthful.

### Phase 3 — spatial HTML/CSS studio — complete

- React Flow provides the infinite canvas, multiple grouped-revision artboards, local image-reference nodes, pan/zoom/fit, artboard selection, and placement.
- The left rail provides Select (`V`), Visual edits (`E`), Preview, New design, Upload image, and Hand (`H`); Space-drag remains available.
- Image references are local, bounded vision attachments and may be combined with selected artboards for the next prompt.
- A pinned, vendored React Grab primitives bundle runs only inside Design guests. It keeps telemetry and network access absent and is excluded from exports and ordinary artifact previews.
- The guest bridge validates the parent command and per-preview capability. The host validates the exact iframe window, capability, schema, string bounds, media ID, artifact hash, and chat ownership.
- React Grab returns exact element context: tag, label, selector, optional own `data-aiden-id`, role, and safe short text. Form values, URLs, raw source, filesystem paths, IPC, and unrestricted HTML are excluded.
- Element, artboard, and image selections appear as removable chips in the elevated composer and apply to one accepted turn.
- Same-title output creates another revision of an artboard; distinct stable titles create new artboards without losing canvas state.

## Source-backed continuation

The following phases extend the same Design Workspace. They do not silently attach repository power to generated artboards.

### Phase 4 — containment, lifecycle, and identity proof — planned go/no-go gate (5–8 days)

Build disposable Vite + React + Tailwind fixtures. Do not add product writes.

1. Prove a sandboxed iframe with an Aiden-owned Vite adapter in development and a signed packaged app. Compare a main-owned `WebContentsView` only if iframe policy is unworkable; do not enable Electron `<webview>`.
2. Start a selected workspace dev script only after an explicit **Start preview** action. Use direct argv spawning, bounded logs, readiness probes, process-group cancellation, ownership tracking, and complete teardown.
3. Activate a temporary adapter/config outside the repository without editing source, dependencies, lockfiles, config, or Git status.
4. Have one transform emit both `SourceElementId` markers and an atomic versioned source manifest. Assign a separate runtime `DomInstanceId` to every rendered instance.
5. Test intrinsic elements, custom components with/without prop forwarding, fragments, maps, conditionals, portals, SVG, open shadow roots, HMR, inserted siblings, and stale selections.
6. Use a malicious fixture to test forged/oversized messages, navigation, permissions, popup/download attempts, floods, and probes for Node or Aiden APIs.
7. Prove a two-file, hash-bound no-op proposal with Allow, Deny, stale-preimage, cancellation, rollback, and ownership behavior without general file-write tools.

GO requires correct source definition or an explicit unsupported/ambiguous state, never a wrong mapping; byte-for-byte unchanged workspace before approval; contained guest code; no orphan process; and a written ADR for the chosen preview, adapter, ID schema, and limitations. Failure means Preview-only or a revised plan.

### Phase 5 — source-backed read-only preview — planned (5–8 days)

- Add main-owned preview server/config services and workspace/owner-scoped IPC.
- Canonicalize loopback URLs; reject credentials, unsafe schemes, remote redirects, renderer-origin collisions, arbitrary shell text, and external-process termination.
- Support loading, ready, HMR, compile error, timeout, crash, port conflict, externally owned, unsupported, and restart-required states with bounded logs.
- Add **Open local app** within the existing Design route. Generated and source-backed artboards can coexist visually, but source-backed mode must show its project identity and authority state.
- Keep Preview interactive with no source selection or writes in this phase.

### Phase 6 — exact source-backed element selection — planned (8–12 days)

- React Grab still identifies the exact runtime DOM node. The adapter supplies opaque runtime/source IDs and bounded geometry; it never returns canonical paths or code to the guest.
- Main owns `ElementSourceMap`, manifest revisions, workspace binding, and source resolution.
- Definition and instance remain separate. Repeated output may map many runtime nodes to one shared definition; UI labels that consequence before any proposed edit.
- If the exact selected element lacks a proven source mapping, keep it selected as visual/chat context and offer the nearest proven mapped ancestor as an explicit secondary action. Never silently replace the user's exact selection.
- Add pointer and keyboard selection, Escape, accessible announcements, shared/repeated badges, and stale/ambiguous states.
- Persist a source-backed selection only after main binds it to workspace, preview instance, manifest revision, source hash, and resolved definition.
- `View in Files` may use the main-resolved path/range. Delete and direct mutation remain unavailable.

### Phase 7 — Designer Action foundation — planned (6–10 days)

- Add a main-owned `DesignerActionService`. Designer generation receives read/search plus one structured `propose_design_action` tool, never general mutation tools.
- Every proposal binds workspace, chat, selections, expected SHA-256 values, permitted ranges, and exact replacements.
- Main re-resolves all identities and renders one approval with a plain-language label, shared/repeated consequences, exact files, and bounded hunks. Approval remains mandatory even when ordinary workspace permission is Full.
- Apply is a version-checked multi-file transaction that preserves modes and rolls back only when written postimages still match. Partial outcomes are explicit.
- Record an action-scoped ledger under `userData`. Undo applies only when every touched file still matches the action postimage; otherwise open review for reconciliation.
- Never automatically run `git add`, commit, stash, reset, checkout, `git restore .`, or whole-worktree checkpoint/restore operations.

### Phase 8 — point → ask → approve → review — planned (5–8 days)

- A source-backed selection uses the same composer chip language as generated artboards, with file/shared hints added only after main resolution.
- Before send, main refreshes source range, relevant containing context, manifest revision, and hashes. Stale or ambiguous targets ask for re-selection.
- Attach bounded static design context such as Tailwind v3 literals, Tailwind v4 `@theme`/CSS variables, relevant global CSS, and project guidance. Never execute project configuration to inspect it.
- Treat workspace code, comments, styles, and selection text as untrusted data that cannot widen action scope.
- After approval, wait for write completion, HMR, and the new manifest revision; then re-resolve the exact element or mark it stale and open Action Review.
- Action Review distinguishes the action from pre-existing working-tree changes and offers exact undo when hashes permit it.

This completes the first source-backed MVP. A trustworthy Vite/React/Tailwind slice is estimated at 6–9 engineering weeks after the shipped canvas foundation; re-estimate from measured Phase 4 results.

## Later depth

1. Layers tree synchronized with exact React Grab selection.
2. Bounded style/property inspector whose changes become the same reviewed Designer Action.
3. Static text editing for proven JSX literals; dynamic/localized/rich text fails closed.
4. Design-system component insertion, safe image asset rewriting, routes/pages, and responsive state editing.
5. Direct manipulation for a narrow literal Tailwind/`className` matrix, one gesture per action/undo step.
6. Multi-select within an artboard after stale-selection and shared-definition behavior is proven.
7. Optional explicit **Build app / Continue in workspace** handoff from a generated artifact.
8. Next.js adapters only after separate App/Pages Router, webpack/Turbopack, and server/client fixture gates.
9. GitHub/IDE handoff, pull-request preparation, and repository design-system import as explicit post-MVP actions.

## Explicitly out of scope for the current MVP

- Silent background app creation or repository writes based only on a design prompt.
- GitHub App installation, repository upload, pull requests, deployment, domains, or hosted previews.
- Remote URL browsing inside Designer mode.
- Full Figma/vector/auto-layout parity, Webflow-style freeform authoring, component marketplaces, image mixing, variants, sketch-to-code, comments, queues, agent cursors, multiplayer, or sharing.
- Source instrumentation in an arbitrary dirty checkout.
- Automatic approval in Full mode or approval assembled from unrelated ordinary tool calls.
- Whole-repository commits/restores or hidden history rewrites.

## Verification matrix

### Shipped generated studio

- Exact nested React Grab hit remains the selected element; no `closest([data-aiden-id])` promotion.
- Pointer, focused-element Enter, Escape, Preview, Select, Hand, Shift-across-artboards, and context-chip removal.
- Wrong frame source/capability/media/hash, oversized/unknown payloads, stale revisions, and non-Design previews fail closed.
- Network, parent DOM, Node, Electron, Aiden IPC, navigation, forms, downloads, and popups remain unavailable to the guest.
- React Flow pan/zoom/fit and desktop/tablet/phone frames work without iframe remount during ordinary movement.
- Empty, generating, ready, stale, unavailable, image, multi-artboard, revision, and export states at compact and wide widths.

### Source-backed gates

- URL and process ownership, packaged teardown, malicious guest, HMR/stale manifest, supported identity fixture matrix, exact/ambiguous/shared mapping.
- Deny, stale preimage, range escape, scope widening, cancellation, external edit, multi-file failure/rollback, exact undo conflict, and pre-existing WIP unchanged.
- Keyboard and pointer paths, light/dark/high contrast/reduced motion, and 390/700/1000/1280px windows.
- Focused unit/integration/browser suites, `npm test`, `npm run type-check`, `npm run lint`, `npm run build`, signed package inspection, and orphan-process check.

## License and provenance

- MagicPath and Open Design are behavior references, not sources of copied code or assets.
- React Flow and the vendored React Grab primitives are MIT licensed and recorded in `THIRD_PARTY_NOTICES.md`.
- Onlook is an Apache-2.0 reference for interaction and identity research. Before adapting implementation, record the exact source path/commit, preserve required notices, mark modifications, and verify every dependency independently.

## Open decisions (not blockers for the shipped MVP)

- Confirm the product default that source-backed mode is explicit per-project opt-in rather than auto-started from repository detection. This plan assumes explicit opt-in.
- Decide whether the first generated-to-source handoff creates an Aiden managed worktree by default or offers the current checkout first with a stronger warning. The safer default is a managed worktree.
- Decide whether a later exact-element style inspector should first support Tailwind literal edits or CSS custom-property edits. Both must use the same approval transaction.
