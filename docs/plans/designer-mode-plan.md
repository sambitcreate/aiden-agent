# Designer Mode Plan

Status: revised implementation plan; Phase 0 is a go/no-go gate  
Date: 2026-07-22  
Aiden baseline: `b6b0eff6bb55e0113a05cc8d069fce2c1be67b40`  
Onlook baseline: `423e2e924366419e418ee049093872d535eea41a`

Source basis: current Aiden and Onlook source, Aiden's project memory and product/UI references, three independent architecture reviews, `../../4-3-plan.md`, and `../../gemini3.6-plan.md`.

## Verdict

The product direction is good: **point at real UI → ask in plain language → approve a concrete change → hand off a clean diff** is a natural extension of Aiden.

The earlier plan was not safe to implement as written. It assumed an unproven build-time identity path, treated an Electron `<webview>` as an ordinary panel, promised approval semantics that Aiden's current per-tool Ask hook cannot enforce, and copied Onlook's checkpoint strategy into real local repositories where it could absorb or overwrite unrelated work.

This revision makes five changes:

1. Prove preview containment and DOM↔source identity before building product UI.
2. Ship Vite + React + Tailwind only in the first supported slice; Next.js is post-MVP.
3. Use a main-owned, always-approved Designer Action transaction instead of ordinary agent writes.
4. Make exact, version-aware action undo the default; never stage, commit, or restore the whole worktree automatically.
5. Treat Onlook as an Apache-2.0 reference implementation, not a set of drop-in packages.

Do not begin Phase 1 until Phase 0 has a written GO decision.

## Outcome

Aiden should let a designer select rendered UI in a local app, describe a change, inspect one bounded proposal, approve it, see HMR update the preview, and open an action-specific code review without losing the conversation.

Aiden should not become Figma, Webflow, or a hosted Onlook clone. Preview is an opt-in work surface. Conversation, workspace identity, privacy, and approval remain primary.

Positioning: Onlook is a hosted visual editor with direct code write-back; Aiden should be the local, permissioned path from visual intent to engineer-grade source control.

## What the source actually says

### Onlook

| Layer            | Verified behavior                                                                                                                                                                                                                  | Consequence for Aiden                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview          | A project runs in a sandboxed browser iframe. A project-injected browser script and the editor communicate through Penpal. Both inspected Penpal endpoints allow `*` origins.                                                      | Reuse the interaction idea, not the bridge security model.                                                                                   |
| Source identity  | `CodeFileSystem` mutates JSX/TSX source on write, adding random `data-oid` attributes, then builds `.onlook/index.json`. The indexer only maps AST nodes that already contain an OID.                                              | A source-clean build transform and a separately run Onlook indexer cannot work together. Aiden needs one shared transform/manifest contract. |
| Runtime identity | Onlook distinguishes source OID, runtime DOM ID (`data-odid`), and component-instance ID (`data-oiid`).                                                                                                                            | Definition versus runtime instance is an MVP identity concern, not late toolbar polish.                                                      |
| Selection        | A transparent gesture layer hit-tests the iframe, including open shadow roots, then renders editor-side overlays.                                                                                                                  | The coordinate system and invalidation contract must cover host bounds, scroll, scale, HMR, resize, and device scale.                        |
| Writes           | Direct style actions are recorded in an in-memory history/transaction layer, written to source, and then reflected in the iframe.                                                                                                  | The earlier “instant CSS first, async persistence second” description was inaccurate. Aiden should design its own proposal-first order.      |
| AI context       | Selected elements become highlight context and their content is refreshed. Normal design chats do not automatically attach the style guide on every turn; the style guide is attached during create/resume or read through a tool. | Main must re-resolve the full selection and source version before send. Automatic bounded style context would be an Aiden improvement.       |
| Undo             | Toolbar actions have in-memory undo/redo. AI completion also creates broad Git checkpoints with `git add .` and `git commit --allow-empty --no-verify`; restore uses a safety commit and `git restore --source … .`.               | Do not copy the Git algorithm into a user's real checkout.                                                                                   |
| Local provider   | `NodeFsProvider`, its watcher, terminal, tasks, and commands are placeholders. Live editor sessions use CodeSandbox.                                                                                                               | Aiden should use its existing local services; there is no local Onlook provider to port.                                                     |
| License          | The repository is Apache-2.0 and has no `NOTICE` file in this checkout.                                                                                                                                                            | Copied/adapted code needs a provenance ledger, the license, preserved notices, and modified-file marking where required.                     |

Useful ideas to reimplement: deep element hit-testing, coordinate math, selection-context shape, parser fixture pairs, runtime DOM IDs, action grouping, and static token extraction.

Do not copy wholesale: Penpal bridge code, MobX/editor-engine React surfaces, the internal UI color picker, the roughly 3,500-line `// @ts-nocheck` Tailwind translator, or the source-wide Babel/Prettier write path.

### Aiden

- The main renderer is context-isolated, sandboxed, and has Node integration disabled. Guest content is not currently enabled.
- The current Environment surface is a 480–720px Review/Files work surface. At the default 1000px window width it becomes an inert overlay, so merely adding a Preview tab would break the point-then-type loop.
- Terminal sessions are interactive shells. They do not own a dev command, readiness URL, logs, or server lifecycle.
- Ask approval is per mutating Pi tool call and applies only in Ask mode. Full mode bypasses it. The current tools cannot batch N files or enforce a selected source region.
- Review shows the whole working tree against `HEAD`; it has no action baseline or action-specific summary.
- Git and Files already have strong workspace-ID authorization, stale-snapshot checks, safe path resolution, temporary-index commits, and atomic version-checked saves. Designer Mode must reuse those safety properties.

## MVP support contract

| Capability                    | MVP support                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Framework                     | Vite + React, JavaScript or TypeScript                                                                                   |
| Styling                       | Tailwind v3/v4 is the supported design-system path; static CSS context may be included, but no generic CSS visual editor |
| Preview-only fallback         | Other loopback web apps may load if their frame policy permits it, but receive no source mapping or writes               |
| Selection                     | One element at a time; maps to a source definition and clearly labels shared/repeated output                             |
| Multi-select / pinned context | Post-MVP, after stale-selection behavior is proven                                                                       |
| Next.js / Turbopack / SWC     | Post-MVP adapter with its own spike and fixture gate                                                                     |
| Direct manipulation           | Post-MVP; the first release is point → ask → approve                                                                     |
| Remote URLs                   | Not supported in Designer Mode MVP                                                                                       |

## Architecture decisions

### 1. Preview containment: prefer an instrumented sandboxed iframe

The first candidate is a sandboxed iframe plus a browser-only bridge injected by the Aiden Vite adapter. This keeps project code out of Electron's privileged preload world and follows the shape already proven by Onlook.

Do not enable Electron `<webview>` for the MVP. It is disabled in Aiden today, and Electron [currently recommends alternatives](https://www.electronjs.org/docs/latest/api/webview-tag) because of webview stability and event-routing concerns. Phase 0 must still compare the iframe with a main-owned `WebContentsView` if frame headers or compositor behavior make the iframe unworkable. Any alternative must satisfy Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

The iframe contract:

- Canonical loopback `http:`/`https:` origins only; reject credentials, non-loopback hosts, unsafe schemes, redirects away from the approved origin, and the Aiden renderer origin.
- No popups, downloads, top navigation, camera, microphone, geolocation, clipboard, or filesystem privileges.
- Add the narrow `frame-src` needed by Aiden's CSP; do not widen `script-src` for preview code.
- Use a per-preview random capability in a typed `postMessage` handshake. Validate `event.source`, origin, capability, method, payload size, and schema on every message.
- Treat every guest field as untrusted. The guest may return opaque source/runtime IDs and geometry only; main resolves IDs to workspace files.
- The guest bridge exposes DOM inspection and temporary visual-preview operations only. It never receives `window.aidenAPI`, arbitrary IPC, Node, paths, file contents, or command execution.

If an iframe requires changing `X-Frame-Options` or `frame-ancestors`, only the Aiden-owned local adapter may adjust the dev response. Never weaken a remote response.

### 2. One adapter owns instrumentation and the source manifest

The Vite adapter must emit both sides of identity from the same transform:

- `SourceElementId`: opaque ID injected into rendered JSX during development only.
- `DomInstanceId`: unique runtime ID assigned to each actual DOM node so repeated `.map()` output can be hit-tested independently.
- `SourceManifestEntry`: workspace-relative path, component, tag, AST locator, start/end offsets and lines, dynamic/shared flags, source hash, and adapter version.
- `ManifestRevision`: changes atomically whenever transformed source changes.

The adapter and main process may share a deterministic ID/manifest library, or the adapter may publish the manifest through an authenticated loopback side channel. They may not run independent random transforms.

No derived index or code block belongs in the user's repository. Keep it in memory and under Electron `userData`, keyed by workspace identity, canonical root, adapter version, and source revision. Never persist absolute paths or code in renderer storage.

The activation mechanism must be proven: Aiden should start the workspace's local Vite binary with a temporary wrapper/config outside the repository, preserving the user's config without editing it. If this cannot be made reliable, the Phase 0 decision is either:

1. allow reversible source instrumentation only inside an explicit disposable managed worktree, with crash-safe strip/recovery; or
2. stop at read-only Preview.

Never inject marker attributes into an arbitrary dirty checkout as an automatic fallback.

### 3. Definition and instance are separate concepts

A custom `<Button>` may not forward an injected data prop. An ID on the intrinsic `<button>` inside its implementation maps to the shared definition, not one call site. Repeated items may share one source definition while having many runtime DOM instances.

MVP behavior:

- Always identify the exact runtime node selected.
- Resolve to a source definition only when the manifest proves it.
- Label edits that affect a shared component or every repeated item before approval.
- If instance/call-site resolution is ambiguous, offer the nearest proven mapped ancestor or require re-selection; never silently guess.
- Instance-only source editing is out of scope until a separate call-site lineage design passes fixtures.

### 4. Designer writes use one main-owned transaction

The normal Pi `edit_file`/`write_file` path cannot enforce the product promise. Designer-scoped generation therefore receives read/search tools plus one structured `propose_design_action` tool.

```ts
interface DesignerActionProposal {
  id: string;
  workspaceId: string;
  chatId: string;
  selectionRefs: string[];
  label: string;
  files: Array<{
    path: string;
    expectedSha256: string;
    permittedRanges: Array<{ start: number; end: number }>;
    replacements: Array<{ start: number; end: number; text: string }>;
  }>;
}
```

Main re-resolves the workspace, chat, selections, paths, ranges, and current hashes; builds bounded patches; and shows one approval with a plain-language label plus exact files/hunks. Designer actions are always gated, even when the workspace's general permission is Full.

Allow applies the complete transaction through a shared version-checked writer. On any failure, roll back already-written files when their postimage still matches; otherwise report an explicit partial outcome and open Action Review. Deny writes nothing. Cancellation and workspace/permission changes invalidate the proposal.

Direct visual controls must eventually emit this same action format. They do not get a separate write bypass.

### 5. Undo is action-scoped, not whole-repository Git

Persist a bounded action ledger under `userData` with exact before/after hashes and reverse patches. Undo is available only while every touched file still matches the action's postimage; otherwise open Review for manual reconciliation.

Before the first mutation, offer Aiden's existing managed worktree flow as the safest playground. Explain that a new worktree starts from committed `HEAD` and therefore does not include dirty changes from the source checkout.

Do not run automated `git add`, `git commit --no-verify`, `git restore .`, stash, reset, or checkout operations. Optional Git-backed versions may be designed later for clean Aiden-owned worktrees only, using Aiden's existing snapshot and mutation-serialization rules.

## End-to-end data flow

```text
workspaceId
  → PreviewServerService (owned process + approved loopback URL)
  → Vite adapter (bridge + runtime IDs + versioned source manifest)
  → sandboxed iframe
  → typed selection ref (untrusted guest → validated host → main resolution)
  → composer chip
  → main refreshes source/hash at send time
  → model proposes one DesignerAction
  → main validates scope and renders approval diff
  → Allow performs version-checked transaction
  → HMR + manifest revision + selection re-resolution
  → Action Review + optional exact undo
```

## Phase 0 — architecture, security, and identity proof (5–8 days)

No product writes. Build disposable fixture apps and answer the hard questions first.

### Spikes

1. **Embedding and layout**
   - Prove a sandboxed iframe in development and a packaged signed app.
   - Compare `WebContentsView` only if frame policy blocks the iframe.
   - Prove preview and composer can remain interactive together at wide sizes; at compact sizes, “Add to chat” must transfer selection, close the preview overlay, and restore composer focus.
2. **Preview server ownership**
   - Detect package manager and Vite script as hints, show the exact script, and start it only from an explicit Start Preview action.
   - Use direct argv spawning, bounded logs, readiness probes, process-group cancellation, and ownership tracking.
3. **Adapter activation**
   - Load a temporary Vite wrapper/plugin from outside the workspace without modifying source, config, dependencies, lockfiles, or Git status.
4. **Identity**
   - Produce runtime IDs and a matching manifest from one transform.
   - Test intrinsic elements, custom components with and without prop forwarding, fragments, wrappers, `.map()`, conditionals, portals, SVG, shadow roots, inserted siblings, formatting, HMR, and stale selections.
5. **Bridge threat test**
   - Use a malicious fixture that forges messages, navigates, requests permissions, opens windows/downloads, floods payloads, and probes for Node/Aiden APIs.
6. **Proposal proof**
   - Generate one two-file, hash-bound no-op proposal and prove Allow, Deny, stale preimage, cancellation, rollback, and ownership behavior without exposing general writes.

### GO criteria

- Supported fixture selections always resolve to the correct definition or an explicit unsupported/ambiguous state; never a wrong file/range.
- HMR either rebinds the selection to the same definition or marks it stale.
- The workspace remains byte-for-byte and Git-status unchanged before an approved Designer Action.
- Malicious guest content cannot reach Electron/Node, escape the approved origin, or trigger filesystem/command work.
- The signed packaged app can start, inspect, stop, and clean up one preview without orphaning a process.
- The chosen layout preserves the point → prompt loop at the documented window sizes.

Deliver an ADR recording the embedding primitive, adapter bootstrap, ID algorithm/manifest schema, supported fixture matrix, and measured limitations. A failed gate means Preview-only or a revised plan, not optimistic continuation.

## Phase 1 — read-only Preview and lifecycle (5–8 days)

- Add `PreviewServerService` and workspace-scoped `preview:` handlers. Extract/reuse a shared main-process workspace authorization resolver.
- Store a versioned `PreviewConfig` per workspace: detected package manager, selected script, approved loopback origin, last path, adapter/version, and ownership state. Persist script identity/argv, not arbitrary shell text.
- Distinguish Aiden-owned servers from already-running servers; never kill an external process.
- Stop owned servers on explicit Stop, workspace removal/revocation, owner renderer destruction, app shutdown, and unrecoverable adapter failure.
- Add loading, ready, compile-error, crash, timeout, port-conflict, externally-owned, unsupported, and restart-required states with bounded logs.
- Add an opt-in Designer workspace layout, not just a third 560px Environment tab. Review and Files retain their existing shell. Preview may become a compact overlay only when side-by-side chat is impossible.
- In Preview mode, the app is interactive. No source selection or writes yet.

Done when an explicit local Vite preview starts, reloads, survives HMR, reports failure honestly, remains contained, and tears down cleanly in development and the signed package.

## Phase 2 — read-only element selection (8–12 days)

- Add the adapter/manifest service selected in Phase 0 and a main-owned `ElementSourceMap` cache.
- The browser bridge returns opaque IDs, tag/role/text snippets, geometry, computed box-model values, and shared/dynamic flags. It never returns canonical paths or code.
- Define one coordinate contract: guest viewport CSS pixels → preview content bounds → host CSS pixels, including scroll, zoom, iframe offset, device scale, and resize.
- Invalidate on relevant DOM child/attribute/text mutations, `ResizeObserver`, scroll, navigation, adapter reconnect, HMR, and manifest revision.
- Add Design/Preview modes. Design mode has hover and selected rectangles plus a quiet shared/repeated badge. Measurements and hatched margin/padding are polish after correct selection.
- Provide pointer selection and a keyboard path (cycle mapped candidates, select, Escape). Announce element label, shared scope, and stale/ambiguous state without relying on color.
- “View in Files” uses the proven main-resolved relative path and range. Do not add Delete or direct mutation actions.
- Start with one selection. Persist `DesignerSelectionRef` in chat/message data only after main binds it to workspace, manifest revision, and source hash.

Done when selection across the supported fixture matrix resolves correctly, stale IDs fail closed, and keyboard/pointer behavior works in light, dark, high-contrast, and reduced-motion modes.

## Phase 3 — Designer Action foundation (6–10 days)

- Add `DesignerActionService`, proposal persistence, ownership/cancellation rules, action ledger, and version-checked multi-file apply/recovery.
- Reuse the Files service's confinement, binary rejection, bounded reads, mode preservation, SHA-256 preconditions, and atomic replacement. Extract shared safe-write primitives rather than calling raw agent `fs.writeFile`.
- Enforce selected files/ranges. A proposal outside that scope is rejected until the user explicitly widens scope and receives a new proposal.
- Render one always-gated approval with action label, shared/repeated consequences, file count, exact paths, and bounded hunks.
- Add action-specific Review next to Working tree and Compare. It freezes the action baseline, distinguishes pre-existing workspace changes, and derives factual summaries from the transaction.
- Offer “Create design playground” before the first mutation when Git/worktree state supports it. Non-Git, nested, detached, unborn, dirty, and managed-worktree states remain explicit.
- Add exact undo with hash checks; conflicts never overwrite newer work.

Done when Allow/Deny, stale source, multi-file rollback, cancellation, external edits, and exact undo behave correctly without changing unrelated work or Git state.

## Phase 4 — selection → chat → approval → Action Review (5–8 days)

- Add one main-owned selection chip to the composer with a human label, file hint, and shared/repeated status. Selecting in a compact overlay transfers focus back to the composer.
- Before send, main re-resolves the selection, source range, containing context, and hash. Stale/ambiguous context asks for re-selection instead of sending guessed code.
- Attach bounded, statically read design context: Tailwind v3 config literals, Tailwind v4 `@theme`/CSS variables, relevant global CSS, and project guidance. Never import/execute a user's config and never include secrets.
- Delimit selected code, comments, style files, and project content as untrusted data, not model instructions; workspace prompt injection must not widen Designer Action scope.
- Make privacy explicit: selection inspection stays local; the bounded code/style context leaves the Mac only when the user sends to a configured remote model.
- Designer-scoped prompting uses read/search plus `propose_design_action`; general file/command mutations cannot masquerade as the approved Designer Action.
- After Allow, wait for write completion, HMR/adapter readiness, and manifest revision. Re-resolve or mark the selection stale, then open Action Review. A compile failure remains visible with an exact recovery path.

Done when the supported fixture and one real Vite workspace complete: select → prompt → proposal → one approval → version-checked apply → HMR → Action Review → exact undo.

This closes the MVP.

## Post-MVP

### Next.js adapter

Run a separate adapter spike for App/Pages Router, webpack versus Turbopack, server/client component boundaries, and development source transforms. Do not describe a Babel/SWC plugin as small or make it a release dependency until the fixtures pass.

### System-aware design (5–8 days)

- Static Tailwind v3/v4 and CSS-variable token discovery with provenance and light/dark pairing; never execute config.
- Brand/token suggestions in chat and approvals before adding a color picker.
- Deterministic before/after capture only after viewport, readiness, crop, privacy, storage, and action association are specified.
- Capability-detected light/dark preview; do not blindly toggle a `.dark` class.
- Screenshot/design-brief context through the existing attachment/privacy model.

### Direct manipulation (3–5 weeks for a narrow first slice)

- Start with a small support matrix: literal Tailwind `className` and statically understood `clsx`/`cn` calls. Template expressions, conditionals, arrays, CSS-in-JS, and dynamic values fall back to an AI proposal.
- Stage temporary visual CSS against `DomInstanceId`; on gesture end, translate one action and show one approval. Define cascade/specificity and cleanup rather than assuming attribute CSS is safe.
- Persist through offset/range edits plus parse validation. Never regenerate/Prettier-format an entire file for one style change.
- Scrubbing creates one transaction and one undo step. Keyboard increments, visible focus, and reduced motion are required.
- Inline text initially supports static JSX text only. Dynamic data, localization, rich text, and contenteditable ambiguity fail closed.
- Instance-only edits remain out until call-site lineage is proven.

### Depth, as prioritized

1. Multi-select and pinned selections.
2. Pages/routes panel.
3. Layers tree synchronized with selection.
4. Device frames exercising real media queries.
5. Design-system component insertion.
6. Image assets with safe reference rewriting and compression.
7. Comment-on-selection exported as an engineer task.
8. Error loop with compile/typecheck output and “Fix with AI.”
9. Project thumbnails.

## Explicitly out of scope

- Full Figma/vector/auto-layout canvas, Webflow-style freeform builder, or component marketplace.
- Source instrumentation in an arbitrary dirty checkout.
- Silent Designer writes, auto-approval in Full mode, or one approval assembled from unrelated Pi tool calls.
- Whole-worktree auto commits/restores, hook bypass, or hidden history rewrites.
- Remote URL browsing, hosted deploys/domains, GitHub App installation, or multiplayer.
- Next.js, universal framework support, responsive breakpoint editing, hover/focus state editing, drag reorder, and draw-to-insert in the MVP.

## Verification matrix

### Security and ownership

- URL policy: schemes, credentials, `localhost.attacker`, IPv4/IPv6 loopback, redirects, renderer-origin collision.
- Forged/stale/oversized bridge messages, wrong `event.source`, wrong capability, navigation/reconnect replay.
- No Node/Electron/Aiden API in the guest; denied permissions, popups, downloads, top navigation, and unsafe protocols.
- Workspace/chat/renderer ownership, No Access, workspace switch/removal, window close, app quit, and process-tree teardown.

### Identity and UI

- JSX/TSX, intrinsic/custom components, prop forwarding/no forwarding, fragments, maps, conditionals, wrappers, portals, SVG, shadow roots, HMR, formatting, inserted siblings, and stale manifest revisions.
- Scroll/zoom/resize/device-scale coordinates and iframe navigation.
- 390, 700, 1000, and 1280px windows; pointer and keyboard; Escape/focus layering; light/dark/high-contrast/reduced-motion.

### Actions and Git safety

- Deny, stale preimage, range escape, explicit scope widening, cancellation, external edit, multi-file partial failure/rollback, and exact undo conflict.
- Dirty/staged/untracked/nested/non-Git/detached/unborn/managed-worktree repositories with unrelated WIP unchanged.
- Action Review distinguishes the action from the total working tree.

### Release

- Focused unit/integration fixtures, full `npm test`, `npm run type-check`, `npm run lint`, and `npm run build`.
- Signed packaged build, artifact/asar inspection for the adapter, strict code-sign verification, packaged malicious-guest test, and orphan-process check.

## Implementation map

Likely new boundaries after Phase 0 chooses the exact adapter shape:

- `main/services/preview-server.ts` — owned dev process, readiness, URL policy, logs, teardown.
- `main/services/element-source-map.ts` — manifest revisions and main-owned selection resolution.
- `main/services/designer-actions.ts` — proposals, approval, transactional apply/recovery, ledger, undo.
- `main/handlers/preview.ts` and `main/handlers/designer.ts` — workspace/owner-scoped IPC.
- `renderer/components/designer-workspace.tsx` and `preview-panel.tsx` — split layout, preview states, overlay, focus.
- `renderer/lib/designer-selection.ts` — renderer-safe opaque view models only.
- a separately built Vite adapter/bridge artifact selected by the Phase 0 ADR.

Expected updates:

- `main/index.ts` and handler registration — preview lifecycle and shutdown.
- `main/services/types.ts`, `config-store.ts`, and chat persistence — versioned preview config, selection refs, action refs.
- `renderer/preload.ts`, `renderer/lib/ipc.ts`, and renderer types — allowlisted `preview:`/`designer:` contracts.
- `renderer/components/environment-panel.tsx`, `renderer/main/chat-layout.tsx`, and `composer.tsx` — Designer layout and context handoff.
- `main/services/llm-client.ts` and tool construction — designer-scoped toolset and action proposal flow.
- `main/services/workspace-files.ts` — extract reusable safe-write primitives without weakening current editor guarantees.
- `renderer/components/review-panel.tsx` and query invalidation — Action Review.
- `main-window.html` — narrow loopback `frame-src` policy.
- `scripts/build-electron.mjs` and packaging — adapter artifact build/inspection.
- `.memory/PROJECT-CONTEXT.md` and `.memory/PROJECT-HISTORY.md` — keep current after accepted architecture decisions and each implemented phase.

## Schedule

```text
Phase 0 — architecture/security/identity proof       5–8d  (go/no-go)
Phase 1 — read-only Preview and lifecycle            5–8d
Phase 2 — read-only selection                       8–12d
Phase 3 — trusted Designer Actions                  6–10d
Phase 4 — point → ask → approve → Action Review      5–8d  (MVP)
```

A trustworthy single-framework MVP is approximately **6–9 engineering weeks** for one experienced engineer, including integration, packaging, and stabilization—not two weeks. A two-week target is realistic only for read-only Preview plus an experimental picker. Re-estimate after Phase 0 with measured adapter and identity results. Next.js and direct manipulation are separate investments.

## License and provenance gate

Before copying any Onlook implementation:

1. Record the source path and audited commit in a third-party provenance ledger.
2. Prefer a clean reimplementation of behavior when the source is tightly coupled.
3. If code is adapted, preserve required copyright/attribution notices, include Apache-2.0 terms in distributions, and mark modified files as required.
4. Do not use Onlook names or marks as Aiden branding.
5. Verify licenses for every new dependency independently.
