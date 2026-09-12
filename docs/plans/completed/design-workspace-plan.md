# Design Workspace Plan

Status: Complete — generated and source-backed Design Workspace MVP shipped

Date: 2026-08-30

Product references: Open Design, MagicPath interaction material supplied by the product owner, React Flow, and React Grab

Source-backed research baseline: Aiden `b6b0eff6bb55e0113a05cc8d069fce2c1be67b40`; Onlook `423e2e924366419e418ee049093872d535eea41a`

## Product outcome

Design Workspace is one first-class Aiden product: an infinite canvas where a person and the existing AI backend create, inspect, and refine live interfaces. It supports app-generated, network-free HTML/CSS/JS artboards and an explicit source-backed path for a local Vite/React app with reviewed workspace writes, exact diffs, and undo.

The two document origins share the Design sidebar entry, spatial canvas, React Grab selection language, context chips, composer, and review concepts. They do **not** share authority:

| Document origin | Current state | Authority |
| --- | --- | --- |
| Generated design | Shipped MVP | App-owned artifacts only; no repository, command, network, or source authority |
| Source-backed app | Shipped MVP | Explicit project opt-in; main-owned preview lifecycle, exact proven source binding, always-reviewed single-file writes, action review, and exact undo |

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

## Shipped source-backed MVP

The following phases extend the same Design Workspace. They do not silently attach repository power to generated artboards.

### Phase 4 — containment, lifecycle, and identity proof — complete

- A real Vite/React fixture proves the chosen sandboxed-iframe architecture; Electron `<webview>` and remote browsing remain disabled.
- A person must explicitly start one detected root-package Vite script. Main launches direct argv with `shell: false`, assigns a loopback port, bounds logs and readiness time, scopes ownership to workspace and renderer document, and tears down the process group.
- A main-owned read-only reverse proxy strips unsafe response headers, injects the pinned React Grab bridge, and accepts only GET/HEAD requests to the owned loopback target.
- React Grab source context is treated as untrusted evidence. Main canonicalizes the workspace, resolves only supported source files, rejects ambiguous suffix matches, and verifies the exact intrinsic JSX tag before creating a binding.
- A stable `id`, `data-testid`, or `data-aiden-id` may recover an exact intrinsic JSX element only when that same tag/attribute/value match is unique in the uniquely resolved file. Otherwise selection is unsupported.
- Browser coverage proves exact nested-element binding, unchanged source before approval, one exact write, exact undo, and fail-closed handling for an unmapped child.

### Phase 5 — source-backed read-only preview — complete

- **Connect app** lives inside the existing full Design route and shows the exact detected command before Start.
- The running source app appears as a React Flow artboard and can coexist with generated artboards and image references.
- Preview lifecycle, script detection, capability, logs, loopback endpoint, and stop behavior are main-owned and exposed through bounded workspace/owner-scoped IPC.
- Unsupported roots, launch failures, timeouts, crashes, and stopped states remain explicit. The MVP supports root-package scripts whose command directly invokes Vite.

### Phase 6 — exact source-backed element selection — complete

- Visual edit mode uses React Grab for the exact single DOM element. The renderer receives a bounded descriptor; only main may turn it into a workspace path and JSX range.
- Main binds the selection to renderer owner, workspace, preview session, canonical file, exact range, source hash, and a two-hour opaque selection handle.
- Ambiguous files, unsupported extensions, custom-component-only positions, mismatched tags, missing source metadata, repeated stable selectors, and changed source fail closed.
- The source selection appears in the shared composer-chip language and excludes generated artboard/image context for the same turn.

### Phase 7 — Designer Action foundation — complete

- Source-backed Design generation gets one structured `propose_design_action` capability rather than general mutation tools.
- Each proposal is bound to workspace, chat, opaque selection, exact canonical file/range, source preimage hash, bounded replacement, and a plain-language label.
- Every proposal opens a mandatory floating Designer Action review with before/after source. Full workspace permission never bypasses this review.
- Apply rechecks ownership and preimage, uses the versioned workspace writer, and records the postimage hash. Undo proceeds only while that exact postimage remains on disk; external edits become an explicit stale action.
- Deny writes nothing. No Designer Action runs Git staging, commits, stash, checkout, reset, whole-tree restore, or a shell command.

### Phase 8 — point → ask → review → apply → undo — complete

- Selecting a proven source element adds an exact source/path chip to the elevated composer and sends only an opaque main-resolved selection handle to generation.
- The model proposes a replacement; it cannot apply it. The user reviews and chooses Apply or Deny in the canvas.
- Apply or Undo advances the source artboard revision and reloads the preview. The review remains available for exact undo after apply.
- Unit, IPC-contract, renderer-contract, vendor, and real Chromium/Vite coverage exercise the shipped flow and its failure boundaries.

This completes the first source-backed MVP. The implementation deliberately ships a narrow, auditable path rather than claiming universal DOM-to-source editing.

## MVP limitations carried forward

- Root `package.json` only; no monorepo package picker, nested app discovery, route chooser, or arbitrary command entry.
- Vite/React only; no Next.js, webpack, Turbopack, Vue, Svelte, or remote URL adapter.
- One proven intrinsic JSX range and one file per Designer Action. Custom-component definitions, repeated instances, fragments, portals, shadow roots, and multi-file edits fail closed or remain preview-only.
- React Grab/sourcemap evidence plus exact tag or unique stable selector replaces a repository source transform in this slice. There is no source manifest or runtime-instance graph yet.
- Action history is scoped to the running app session. It is not a durable cross-restart ledger.
- The proxy is intentionally read-only and does not proxy Vite WebSocket HMR. Aiden forces an iframe revision reload after Apply/Undo; the dev server may still perform its own client-side HMR.
- Static Tailwind/global-CSS context, layers, property editing, direct manipulation, component insertion, and generated-to-repository handoff remain later depth.

## Later depth

1. Root/package/route selection for monorepos and multiple Vite apps.
2. A durable action ledger and versioned multi-file transaction with crash recovery and conflict review.
3. A source manifest/instance graph for custom components, lists, repeated definitions, fragments, portals, SVG, and open shadow roots.
4. A contained Vite WebSocket/HMR path with packaged-app and orphan-process acceptance.
5. Layers tree synchronized with exact React Grab selection.
6. Bounded style/property inspector whose changes become the same reviewed Designer Action.
7. Static text editing for proven JSX literals; dynamic/localized/rich text fails closed.
8. Design-system component insertion, safe image asset rewriting, routes/pages, and responsive state editing.
9. Direct manipulation for a narrow literal Tailwind/`className` matrix, one gesture per action/undo step.
10. Multi-select within an artboard after stale-selection and shared-definition behavior is proven.
11. Optional explicit **Build app / Continue in workspace** handoff from a generated artifact.
12. Next.js adapters only after separate App/Pages Router, webpack/Turbopack, and server/client fixture gates.
13. GitHub/IDE handoff, pull-request preparation, and repository design-system import as explicit post-MVP actions.

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

### Shipped source-backed path

- Script detection, loopback URL and process ownership, readiness, stop, renderer invalidation, bounded logs, and direct-argv launch.
- Exact nested source mapping, ambiguous and unmapped failures, ownership, preimage hash, bounded range, Deny, Apply, stale postimage, and exact Undo.
- Keyboard and pointer paths, light/dark/high contrast/reduced motion, and 390/700/1000/1280px windows.
- Focused unit/integration/browser suites, `npm test`, `npm run type-check`, `npm run lint`, and `npm run build`. Signed package inspection and physical-process acceptance remain release gates, not open implementation work.

## License and provenance

- MagicPath and Open Design are behavior references, not sources of copied code or assets.
- React Flow and the vendored React Grab primitives are MIT licensed and recorded in `THIRD_PARTY_NOTICES.md`.
- Onlook is an Apache-2.0 reference for interaction and identity research. Before adapting implementation, record the exact source path/commit, preserve required notices, mark modifications, and verify every dependency independently.

## Open decisions (not blockers for the shipped MVP)

- Decide whether the first generated-to-source handoff creates an Aiden managed worktree by default or offers the current checkout first with a stronger warning. The safer default is a managed worktree.
- Decide whether a later exact-element style inspector should first support Tailwind literal edits or CSS custom-property edits. Both must use the same approval transaction.
- Decide whether nested-package discovery should be automatic with confirmation or begin with an explicit package/route picker.
