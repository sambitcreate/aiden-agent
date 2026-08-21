# Create Images Phase 1 Evidence

Status: **GO** — implementation, frozen-artifact verification, and both fresh-context reviews complete
Date: 2026-08-11
Feature gate: `AIDEN_CREATE_IMAGES_ENABLED=1`

## Implemented surface

- Lazy, fail-closed `/create-images` library and `/create-images/$workflowId` canvas routes under Aiden's shared split-view shell.
- Capability-gated **Create Images** sidebar entry between **New Agent** and **Scheduled**.
- Route-specific workflow search/list in place of chat search, workspace switching, and chat history.
- Route-aware shell that removes Environment and Terminal while keeping the Assistant dock mounted but hidden, inert, and interaction-blocked so route changes cannot cancel an active response or discard its draft.
- Capability-aware `images.open` command and shortcut Settings entry with chat-only navigation shortcuts disabled on the canvas route.
- Full React Flow workbench with pan, zoom, fit, minimap toggle, selection, multiselect, delete, duplicate, connect/disconnect, bounded undo/redo, searchable modal add-node palette, and container-responsive inspector.
- Five Aiden-owned fixture nodes: Image Input, Prompt, Generate Image, Output, and Output Gallery.
- Central typed-port validation, connection cardinality, duplicate/cycle rejection, run-readiness details, accessible invalid-drop reasons, and a non-spatial keyboard connection/disconnection editor.
- Unique accessible node/control names, deterministic focus restoration, repeatable polite announcements, modal shortcut isolation, compact visible port rails, bounded prompt editing, responsive validation details, reduced-motion behavior, and light/dark semantic-token styling.

The implementation remains fixture-only. The run control is disabled and this phase registers no Create Images IPC, protocol, persistence, asset, credential, or provider side effects.

## Signed packaged-app acceptance

`npm run test:create-images:packaged` launches the hardened, signed development `.app` from its ASAR with the real preload, CSP, shared shell, capability gate, and production route. Its one-shot private acceptance profile establishes a stable pre-route product-file baseline, instruments product network requests and durable files, drives native keyboard/pointer input, writes a nonce-bound private receipt, and exits cleanly.

Final frozen-artifact receipt:

- route `/create-images/stress-100`; node history `100 → 101 → 102 → 101 → 102`;
- real spatial disconnect/reconnect, keyboard-only **Connect nodes**, and two identical invalid drops with repeat live-region mutation;
- native edge Delete/Undo/Redo and connected-node cascade Delete/Undo/Redo restore exact node and edge counts in one history transaction;
- duplicate → Arrow move → Undo, toolbar Undo/Redo, modal focus trap/return, deletion focus restoration, and unique repeated-node names;
- responsive/overflow checks at 1280, 1000 with maximum sidebar, 700, and 390 px; narrow validation navigation and fully visible new-node bounds at 390 px;
- reduced-motion fit behavior, 38 observed live-region mutations, and 38 observed native keyboard actions;
- 0 renderer errors, 0 HTTP/HTTPS/WS/WSS requests, and 0 Aiden product-file mutations after route entry;
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
- 6,035.0927919999995 ms measured acceptance duration and clean bounded process exit.

The durable attestation is `build/create-images-packaged-acceptance/attestation.json` and binds that receipt to:

- source HEAD `c3d644485e543579bbf478bb1e7355ba6667ce65`;
- embedded/current package-input fingerprint `4eb47d56d26ef98ea608f5ac8980419384cd11f975946737904a590d9773cc3b`;
- ASAR SHA-256 `68c73146985f0a3f4c9abf624aaa733fc8d01861f374b5308ca214b158c91da3`;
- code-signature CDHash `043360e3b1be15fe5e8a4a1175b3fce0c457daa7`;
- bundle identifier/version `com.sambitcreate.aiden-agent` / `0.28.0`.

The fingerprint is captured before source-consuming builds, verified unchanged after compilation, embedded in the ASAR, and compared with the working tree before and after acceptance. Mutable evidence/status paths (`docs/`, `.memory/`, and `.papercuts/`) are excluded because they are not package inputs.

## Product-canvas performance gate

`npm run test:create-images:canvas-product` bundles the production `WorkflowCanvas`, five real node renderers, fixture factory, and compiled Aiden renderer CSS. It launches a 1000×650 sandboxed, context-isolated, Node-disabled Electron window under `connect-src 'none'`. Measurements use a contemporaneous empty-frame baseline and separate long-task budget, assert visible-node culling, inspect node AABBs for overlap, bound a near-maximum prompt editor by internal scrolling, and run the edit and repeated-announcement paths.

Final measurements:

| Fixture | Edges | Initial render | Viewport avg. | Adjusted selection median | Visible / graph | Long tasks | JS heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 nodes | 75 | 99.30 ms | 1.25 ms | 0.00 ms | 2 / 100 | 0 | 9,465,508 B |
| 250 nodes | 186 | 116.40 ms | 1.25 ms | 0.00 ms | 2 / 250 | 1 / 53 ms | 16,363,660 B |

Heap growth was 6,898,152 bytes. Both fixtures measured eight visible node bounds with zero overlapping pairs, kept the long prompt internally scrollable, and passed edits, repeated announcements, and semantic theme-surface checks. The launchers fail on both Electron 43 structured console errors and legacy numeric error severity, independent of message wording. Their shared bounded child lifecycle settles spawn errors and waits for stdio `close` after process exit, escalates timeout from `SIGTERM` to `SIGKILL`, and guarantees a final rejection instead of hanging or parsing truncated output.

## Frozen-tree verification

- `npm run test:create-images`: 54/54 (43 TypeScript cases plus the notice, source-fingerprint, Electron console-severity, and bounded child-lifecycle contracts).
- `npm run test:preflight`: 243/243 across its Artificial Analysis, Model Pad, shell/sidebar, appearance, composer, transition, accessibility, and shared renderer contracts.
- `npm run test:command-system`: 62/62, including capability-hidden Create Images shortcuts and modal/scope guards.
- `npm run type-check`: pass.
- `npm run lint`: pass.
- `npm run package` and `npm run package:verify`: pass for the hardened, fused, signed development `.app`.
- `npm run test:create-images:packaged`: pass against that exact signed artifact and clean process exit.
- `npm run test:create-images:canvas-product`: pass for the 100/250 production component cases.
- Production lazy-boundary gate: fixture builders/schema and Create Images CSS are absent from the eager renderer; the packaged acceptance driver is absent from eager main-process code and emitted as a separate dynamic chunk.
- ASAR inspection: one JS and one CSS lazy Create Images chunk plus `THIRD_PARTY_NOTICES.md`; zero packaged `@xyflow`, D3, Zustand, classcat, or Node Banana research files.
- Scoped React Doctor reported no unresolved Create Images correctness, accessibility, or security error; its remaining large-component warning describes the deliberate canvas orchestration boundary.

## Node Banana provenance

No Node Banana source, assets, templates, branding, prompts, or dependencies were copied. The clean implementation uses the pinned upstream `WorkflowCanvas.tsx`, `NodeSearchMenu.tsx`, and `FloatingActionBar.tsx` only as behavioral references for the canvas/search/action-bar shape; Aiden's typed ports, bounded history, accessible connection editor, route shell, nodes, fixtures, and styles are independently implemented.

## Review gate

Both Phase 1 fresh-context reviewers returned unconditional GO with no actionable findings on fingerprint `4eb47d56…773cc3b`. They independently confirmed the source, signed artifact, close-safe receipt, package contents, and this evidence document.
