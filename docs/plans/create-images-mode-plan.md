# Create Images Mode Plan

Status: active; Phases 0–3 complete, Phase 4 implementation complete with manual opt-in real-provider acceptance pending
Date: 2026-08-10
Aiden baseline: `c3d644485e543579bbf478bb1e7355ba6667ce65`
Node Banana baseline: `5c0e0ae6150f29a6de819f8d6f1dedba15151f7c` (`master`, version `1.9.0`)

Source basis: current Aiden and Node Banana source, Aiden's project memory and required desktop UI references, three parallel architecture reviews, and current primary provider documentation.

The inspected Node Banana checkout lives at `tmp/node-banana`. `tmp/*` is already ignored by Aiden's `.gitignore`, and `git check-ignore` verifies the checkout is excluded. The clone is research material only; it is not a vendored dependency or product source directory.

## Verdict

Build **Create Images** as a dedicated Aiden mode entered from the main sidebar and centered on a full visual node-workflow canvas. Do not reduce it to a prompt form with a gallery, and do not embed or port the Node Banana Next.js application.

The product idea and several interaction patterns are strong. The implementation needs to be Aiden-native:

1. Keep graph editing and viewport interaction in the renderer.
2. Keep credentials, provider requests, workflow persistence, binary assets, execution scheduling, and recovery in the Electron main process.
3. Store immutable asset references in graphs and history; never carry full-resolution base64 images through ordinary renderer state or IPC.
4. Ship a deliberately small image-only graph before annotation, loops, background removal, video, audio, 3D, or ComfyUI.
5. Cross each evidence gate in its owning phase: canvas packaging in Phases 1/5, durable assets in Phase 2, crash-safe runs in Phase 3, and explicit opt-in provider acceptance in Phase 4.

This is a new durable product surface, not a chat accessory. A trustworthy MVP is approximately **8–12 engineering weeks for one experienced engineer**, subject to the phase-owned evidence gates. Annotation and a broad multi-provider catalog are follow-on work.

## Product outcome

A user selects **Create Images** in Aiden's sidebar and lands on a persistent node canvas. They can create or open a workflow, connect typed prompt and image nodes, choose an image model, preview expected provider/cost information, run all or part of the graph, stop it, inspect progress by node, and retain generated outputs locally. Closing and reopening Aiden restores the workflow and its durable output references.

The canvas is the primary work surface. Templates, workflow history, model configuration, cost details, and Aiden-assisted graph creation are panels or canvas-adjacent actions; they are not a separate simplified image composer.

### MVP user journey

1. Open **Create Images** from the sidebar.
2. Choose a starter template or a blank workflow.
3. Add `Prompt`, `Image Input`, `Generate Image`, `Output`, or `Output Gallery` nodes from search or the add-node control.
4. Connect only compatible handles; get an immediate, accessible explanation for an invalid edge.
5. Configure the generation node with a connected image provider and supported model options.
6. Select **Run workflow** or **Run from here**.
7. Confirm provider, number of remote requests, and a best-effort cost estimate before paid work begins.
8. Observe queued/running/succeeded/failed/cancelled state on each node and stop outstanding work when needed.
9. Inspect, compare, download, or reuse durable results without re-running the graph.
10. Reopen Aiden and recover the saved graph, outputs, and terminal run record.

### First-release non-goals

- No video, audio, 3D, GIF, or ComfyUI nodes.
- No arbitrary user-authored JavaScript/Python nodes or shell execution.
- No hosted sharing/community workflow browser.
- No real-time collaboration.
- No unbounded provider/model marketplace.
- No loop edges, provider fallback chains, or automatic retries that can multiply paid requests.
- No silent model substitution.
- No automatic graph mutation by Aiden without a reviewable proposal and explicit approval.
- No reliance on a running local web server or Next.js API routes.

## What to use from Node Banana

Node Banana is MIT-licensed, but Aiden should use a clean, Aiden-native reimplementation by default. The following links are pinned to the inspected upstream revision so later upstream changes do not silently change this plan's evidence.

| Upstream reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | What it demonstrates                                                                                                                        | Aiden decision                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`README.md`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/README.md) and [`prd-image-workflow.md`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/prd-image-workflow.md)                                                                                                                                                                                                                                                                                                                                                                              | A useful middle ground between a one-shot prompt box and ComfyUI: visible data flow, reference images, annotations, and reusable workflows. | Adopt the product shape and full-canvas emphasis. Keep Aiden image-first and locally durable.                                                                         |
| [`WorkflowCanvas.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/WorkflowCanvas.tsx), [`NodeSearchMenu.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/NodeSearchMenu.tsx), and [`FloatingActionBar.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/FloatingActionBar.tsx)                                                                                                                                                                            | React Flow canvas composition, add-node discovery, selection actions, fit/zoom controls, and workflow-level run affordances.                | Use as interaction references. Implement new Aiden components with semantic tokens and Aiden keyboard/focus behavior.                                                 |
| [`ConnectionDropMenu.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/ConnectionDropMenu.tsx)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Dropping a connection on empty canvas proposes nodes compatible with the source media type.                                                 | Reimplement from Aiden's central typed-port registry. This is a high-value graph interaction after ordinary add/search is stable.                                     |
| [`types/nodes.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/types/nodes.ts) and [`components/nodes`](https://github.com/shrimbly/node-banana/tree/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/nodes)                                                                                                                                                                                                                                                                                                                                                                      | A broad node catalog and reusable base-node conventions.                                                                                    | Use the catalog to sequence Aiden's scope. Define Aiden's own discriminated, versioned node contracts and typed ports.                                                |
| [`workflowStore.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/workflowStore.ts) and [`executionUtils.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/utils/executionUtils.ts)                                                                                                                                                                                                                                                                                                                                              | Dependency grouping, topological execution, run/stop state, save/load, migrations, grouping, undo, and autosave requirements.               | Reuse the behavioral requirements, not the roughly 3,300-line renderer store. Split graph editing, persistence, scheduler, assets, providers, and ephemeral UI state. |
| [`nanoBananaExecutor.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/execution/nanoBananaExecutor.ts) and [`runWithFallback.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/execution/runWithFallback.ts)                                                                                                                                                                                                                                                                                                                    | Resolve upstream inputs, run one node, poll async work, record history/cost, propagate failure, and abort.                                  | Reimplement in main. Defer fallback and loops until cost/cancellation semantics are proven.                                                                           |
| [`providers/gemini.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/app/api/generate/providers/gemini.ts), [`providers/openai.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/app/api/generate/providers/openai.ts), [`providers/replicate.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/app/api/generate/providers/replicate.ts), and [`providers/fal.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/app/api/generate/providers/fal.ts) | Concrete request mapping, reference-image handling, async polling, output normalization, and provider-specific model parameters.            | Use as test-oracle research beside current official docs. Build narrow main-owned adapters; never forward renderer-supplied credentials or arbitrary URLs.            |
| [`AnnotationModal.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/AnnotationModal.tsx) and [`AnnotationNode.tsx`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/nodes/AnnotationNode.tsx)                                                                                                                                                                                                                                                                                                                            | A Konva-based reference-image annotation loop.                                                                                              | Use as a Phase 6 interaction reference after the core asset model ships. Keep annotation layers separate from flattened raster assets.                                |
| [`quickstart`](https://github.com/shrimbly/node-banana/tree/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/components/quickstart), [`lib/chat`](https://github.com/shrimbly/node-banana/tree/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/lib/chat), and [`api/quickstart`](https://github.com/shrimbly/node-banana/tree/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/app/api/quickstart)                                                                                                                                                                                                                                                | Templates and natural-language graph proposal/edit operations.                                                                              | Use templates early. Defer Aiden-assisted graph proposals until Aiden's graph schema and diff validator are stable.                                                   |
| [`undoHistory.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/undoHistory.ts) and [`CHANGELOG.md`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/CHANGELOG.md)                                                                                                                                                                                                                                                                                                                                                                            | Snapshot history required special handling to preserve base64 string references and avoid memory growth.                                    | Treat this as a warning. Use graph operation patches that reference immutable asset IDs and place a strict history bound.                                             |
| [`mediaStorage.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/utils/mediaStorage.ts), [`lib/images/store.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/lib/images/store.ts), and [`thumbnailCache.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/thumbnailCache.ts)                                                                                                                                                                                                             | Externalizing inline media, deduplication, thumbnails, TTL, and memory bounds are necessary.                                                | Reimplement with SHA-256 content-addressed disk assets, lazy object URLs, and a bounded decoded-thumbnail cache. Never hydrate an entire workflow into base64.        |
| [`localStorage.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/utils/localStorage.ts) and [`buildApiHeaders.ts`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/src/store/utils/buildApiHeaders.ts)                                                                                                                                                                                                                                                                                                                                        | Browser persistence currently includes provider settings/API keys and renderer-constructed request headers.                                 | Explicit anti-pattern for Aiden. Credentials remain main-only in `safeStorage`; the renderer sees only provider connection/capability status.                         |

### Upstream patterns to defer or reject

| Pattern                                     | Decision | Reason                                                                                                                                                 |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Next.js API routes                          | Reject   | Aiden already has an Electron main/preload/renderer split; adding a localhost server creates lifecycle and attack-surface costs without product value. |
| One all-purpose Zustand store               | Reject   | Graph edits, durable storage, assets, remote runs, and ephemeral UI have different consistency and failure semantics.                                  |
| Base64 media inside nodes and save payloads | Reject   | It inflates IPC, undo snapshots, JSON writes, heap use, and crash-recovery time.                                                                       |
| Renderer-held API keys/provider headers     | Reject   | It conflicts with Aiden's context-isolated trust boundary and credential design.                                                                       |
| Browser download as workflow persistence    | Reject   | Aiden can provide atomic, main-owned local persistence and explicit export.                                                                            |
| Dynamic arbitrary model schemas on day one  | Defer    | The UI, validation, cost, safety, and migration contract must first work for a curated capability set.                                                 |
| Loop edges and provider fallback            | Defer    | Both can unexpectedly multiply requests and cost; they need independent budgets and cancellation semantics.                                            |
| Background removal/ONNX                     | Defer    | Native/WASM packaging, model weight, CPU/GPU, and memory behavior require a separate spike.                                                            |
| ComfyUI, video, audio, 3D, GIF              | Defer    | They multiply media, preview, dependency, execution, and support contracts before the image graph is proven.                                           |

## Aiden integration contract

### Route and shell

- Add two routes under `chatLayoutRoute` in `renderer/main/router.tsx`: `/create-images` for the workflow library/empty state and `/create-images/$workflowId` for a durable canvas. The sidebar label remains **Create Images**.
- Add the sidebar row in `renderer/components/chat-sidebar.tsx` immediately after **New Agent** and before **Scheduled**. It uses the existing sidebar row semantics, keyboard focus, tooltip, and selected-state tokens.
- Keep the existing application sidebar and window controls. The canvas consumes the entire main-content region.
- Hide the terminal drawer and Environment review/files panel on `/create-images*`. Update route-capability decisions in `renderer/main/chat-layout.tsx` and `renderer/lib/command-system-core.ts`; a hidden panel must not retain focus or intercept shortcuts.
- Hide the global Aiden Assistant dock on `/create-images*` because its bottom-right position conflicts with canvas controls, the minimap, and inspector affordances. Phase 8 returns assistance as a route-owned proposal panel with graph-aware layout.
- Add route-aware command entries (`images.open`, then `images.newWorkflow` when implemented) through `renderer/shared/keybindings.ts` and the existing command catalog. Do not steal `Cmd+N` globally from chat in the first slice.
- Add a main-exposed `createImages` capability/feature flag. During development the sidebar entry may be gated; it must not lead to a half-initialized canvas in production.

Use Aiden's existing fail-closed application-capability pattern. The initial environment gate should be `AIDEN_CREATE_IMAGES_ENABLED=1`, default-off. Main must check it in every Create Images handler as well as renderer navigation. When disabled, Aiden must not open, migrate, clean, or mutate the Create Images store and must not contact an image provider.

The existing app navigation/footer should become shared sidebar structure with a route-specific body. Chat routes keep chat search, workspaces, and history. Create Images routes show **New workflow**, workflow search, and recent image workflows. Profile, Settings, Scheduled, update state, and collapse behavior remain shared. This avoids presenting “Search chats…” beneath a selected image-workflow mode.

### Visual design and accessibility

The required references are `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Create Images should adapt their workbench hierarchy to Aiden rather than copy specimens:

- stable shell and restrained chrome;
- canvas-first center with one compact top toolbar;
- quiet elevation, 1px semantic borders, and tokens from `renderer/styles.css` and `renderer/shared/appearance.ts`;
- 150–200 ms control transitions and 250–300 ms panel transitions with no more than 4–8 px movement;
- `prefers-reduced-motion` coverage and no decorative continuous canvas animation;
- visible keyboard focus, DOM-backed node labels/actions, screen-reader run-state announcements, and no status conveyed by color alone;
- an accessible node-list/inspector alternative for operations that are difficult on a spatial canvas;
- responsive acceptance at 390, 700, 1000, and 1280 px widths. At narrow widths the inspector becomes a sheet; the canvas is not replaced by a simplified composer.

### Proposed renderer module boundary

```text
renderer/create-images/
  create-images-view.tsx       Route-level workbench and loading/recovery states
  workflow-canvas.tsx          React Flow boundary and viewport interaction
  graph-controller.ts          Typed edits, selection, undo/redo, validation hints
  graph-store.ts               Renderer graph + ephemeral view state only
  node-registry.ts             Node definitions, ports, inspectors, renderer views
  nodes/                       Aiden-owned node components
  panels/                      Workflow library, node search, inspector, run details
  commands.ts                  Route-scoped command definitions
  accessibility.ts             Announcements and node-list projection
  create-images-view.test.tsx
```

Do not allow node components to call providers or filesystem IPC directly. They emit typed edit/run intents through one controller.

### Proposed shared contract boundary

```text
renderer/shared/create-images/
  schema.ts                    Versioned workflow, node, edge, and asset DTOs
  ports.ts                     text/image/mask/metadata compatibility rules
  migrations.ts               Pure forward migrations and validation reports
  execution.ts                Run/node state DTOs and event types
  providers.ts                Capability/model option DTOs; never secrets
  ipc.ts                      Request/response schemas and payload limits
```

Every union is discriminated and exhaustive. Unknown node types are preserved as disabled placeholders during import/load, not silently discarded. Graph document revision, run ID, node ID, and event sequence are mandatory on state-changing IPC.

### Proposed main-process boundary

```text
main/services/create-images/
  workflow-store.ts            Atomic manifests, index, autosave, recovery
  asset-store.ts               Content-addressed binaries, metadata, thumbnails, GC
  graph-validator.ts           Typed edges, required inputs, cycles, limits
  execution-coordinator.ts     Run snapshots, scheduling, cancellation, recovery
  run-store.ts                 Durable run/node journal and terminal summaries
  provider-registry.ts         Image-specific provider capability registry
  providers/gemini.ts          First real adapter
  providers/openai.ts          Later adapter
  providers/replicate.ts       Later async adapter
  providers/fal.ts             Later async adapter
  archive.ts                   Portable import/export with hostile-input defenses
main/handlers/create-images.ts  Narrow, owner-checked IPC registration
```

Register handlers through `main/handlers/index.ts`. Add an exact `imageWorkflows:` invoke prefix and only necessary event names to `renderer/preload-channels.ts` and `renderer/preload.ts`; update `main/handlers/ipc-contract.test.ts` in the same change. The preload exposes narrow methods, not a generic invoke or filesystem bridge.

Reuse `main/services/renderer-document-owner.ts` to bind every request/subscription to the active main frame and invalidate stale document epochs. Add typed renderer calls/subscriptions through `renderer/lib/ipc.ts` and centralize workflow/run query keys in `renderer/lib/queries.ts`; TanStack Query holds main-owned server state, while high-frequency graph drag/selection state stays out of the query cache.

## Architecture decisions

### 1. Canvas library: spike `@xyflow/react`, then adopt if the gate passes

Node Banana demonstrates that React Flow supports the required custom nodes, handles, editable edges, groups, selection, minimap, viewport controls, and keyboard interactions. Aiden already uses React 19, but not React Flow.

Phase 0 pins and audits `@xyflow/react` and proves dependency feasibility in a release-mode, sandboxed Electron fixture with 100 and 250 mixed nodes. Phase 1 repeats the measurements against Aiden's real production-built node components, light/dark tokens, keyboard edit path, and 1000×650 workbench; Phase 5 repeats them in the final distributable on minimum supported hardware. If either product gate fails, stop and evaluate a thinner SVG/HTML canvas boundary before enabling the feature.

Do not add Konva/react-konva until annotation begins. Avoid Zustand unless the spike proves it materially simpler than Aiden's existing external-store patterns; if used, keep separate graph/view stores and prohibit provider, binary, and persistence logic in them.

### 2. The graph is a versioned document, not live execution state

`WorkflowDocumentV1` contains stable graph metadata only:

```ts
type WorkflowDocumentV1 = {
  schemaVersion: 1;
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  viewport?: { x: number; y: number; zoom: number };
  nodes: WorkflowNodeV1[];
  edges: WorkflowEdgeV1[];
  assetRefs: string[];
  settings: { defaultProviderId?: string; concurrency: 1 | 2 | 3 | 4 };
};
```

Node configuration stores model-independent intent plus an explicit provider/model binding where needed. An image field stores an `assetId`, never bytes, a data URL, a remote URL, or an absolute path. Run state, errors, progress, provider job IDs, and transient previews live in run records, not in the graph document.

Undo/redo stores bounded semantic graph operations or structural patches. Asset import creates an immutable asset once, then the edit references its ID. A 50-operation default is acceptable for the first spike; the final limit is decided by measured heap behavior.

### 3. Use typed ports and immutable run snapshots

MVP port kinds are `text`, `image`, `image[]`, and `metadata`. Each node definition declares input cardinality, required inputs, output kinds, whether it is pure/local/remote, and its versioned configuration schema.

When a run begins, main validates the current graph revision and records an immutable run snapshot. Edits after that point produce a newer workflow revision but do not change the active run. Every completion event carries `{ workflowId, workflowRevision, runId, nodeId, sequence }`; the renderer ignores stale or duplicate events.

Cycles are invalid in the MVP. Validation returns structured node/edge issues and never repairs the graph silently. **Run from here** includes the selected node's required ancestors and selected downstream path according to an explicit UI choice; it does not infer a paid fan-out invisibly.

### 4. Main owns scheduling and remote work

The coordinator performs a stable topological schedule:

1. validate typed DAG and provider readiness;
2. materialize a run snapshot and journal it before network work;
3. mark nodes ready only when all required dependencies succeeded;
4. run ready local nodes and remote nodes under separate concurrency gates;
5. publish a node as succeeded only after every output is durably copied into the asset store;
6. mark required descendants blocked when an ancestor fails or is cancelled;
7. journal terminal run state and release asset/run leases.

Default remote concurrency is 1 for the first paid release, with an advanced user range of 1–4 and provider-specific ceilings. Phase 0 may justify a higher default only with cost UX and provider-limit evidence. Rate limits use bounded exponential backoff with jitter and a retry budget. Paid retries require idempotency guarantees or renewed consent; no automatic provider fallback ships in the MVP.

Cancellation is a durable intent, not merely an `AbortController`:

- stop admitting new ready nodes;
- abort local HTTP/poll operations;
- call a provider's cancel endpoint when supported;
- persist `cancel_requested` and the remote job ID before the call;
- accept that some providers may finish after cancellation, but never attach a late result to a newer run;
- offer recovery of a valid late result only when it belongs to the same cancelled run and is safely persisted.

On application restart, the coordinator reconciles nonterminal runs. Synchronous requests without a recoverable provider job ID become `interrupted`; durable async jobs are polled by their persisted ID. No run restarts from the beginning without explicit user approval.

A route change inside the same renderer document does not cancel main-owned work; remounting the canvas queries and resubscribes to the run. Renderer reload/crash invalidates the document owner and triggers best-effort cancellation while preserving enough durable state to reconcile an already-submitted async job. Application quit joins Aiden's quit barrier and offers wait or cancel; forced/interrupted shutdown never causes silent resubmission on next launch.

### 5. Main owns a content-addressed asset store

Suggested layout under Electron `userData`:

```text
create-images/
  index.json
  workflows/<workflow-id>/workflow.json
  workflows/<workflow-id>/autosave.journal
  runs/<run-id>/run.json
  assets/sha256/<first-two>/<digest>.<validated-extension>
  thumbnails/<digest>/<size>.webp
  quarantine/
```

Use the existing `DataStore` atomic-write/protected-file patterns for small indexes and manifests. Do not pass binary images through it. Phase 0 must compare the specialized JSON+journal design with SQLite using realistic workflow/run/asset counts; prefer Aiden's existing JSON foundation unless measured indexing or recovery needs justify a new native packaging dependency. Asset ingestion streams to a temporary file, computes SHA-256, validates magic bytes/MIME/dimensions/decoded pixel count, fsyncs as appropriate, and atomically publishes by digest. Deduplication is content-based. A manifest records byte length, media type, dimensions, timestamps, origin (`import`, provider/model/run, annotation), and optional safe generation metadata.

The renderer receives a bounded thumbnail or selected full asset through an opaque, document-bound mechanism. Phase 0 must compare:

- narrow IPC returning `ArrayBuffer`, followed by renderer-created/revoked object URLs; and
- an `aiden-asset://` protocol that accepts short-lived opaque tokens and validates the requesting webContents.

Do not expose absolute paths, `file://` URLs, arbitrary custom-protocol paths, or a general read-file method. Revoke object URLs on node unmount/asset change. Keep decoded thumbnails in a byte-bounded LRU; graph swapping and zooming must release them.

Define quotas before launch: configurable total asset budget, warning threshold, per-import byte/pixel limits, per-provider-response limit, and a safe garbage collector. GC only deletes an asset after an atomic reference scan proves it is unreferenced by every workflow, run, export lease, and open preview. Provide a repair/index rebuild path.

### 6. Workflow persistence and portability are explicit products

Autosave graph edits after a 1–2 second debounce and on route/app-close flush. Use optimistic revisions: a save with stale `expectedRevision` fails with a structured conflict instead of overwriting a newer renderer or recovery state. Keep a small recovery journal and last-known-good manifest. A corrupt workflow opens in a recovery view with exportable diagnostics, never as an empty canvas that overwrites the damaged file.

Portable export should be a versioned `.aiden-images` ZIP containing a manifest, graph JSON, referenced assets, and optional terminal run metadata. Import treats the archive as hostile:

- reject absolute paths, `..`, symlinks, duplicate normalized names, encrypted members, unsupported compression, excessive file count, zip bombs, and declared/actual size mismatches;
- parse and migrate in quarantine;
- validate hashes, MIME, dimensions, graph counts, port compatibility, and provider/model identifiers;
- never execute, connect a provider, or fetch a URL during import;
- publish atomically only after full validation.

Add a **Node Banana JSON importer** after Aiden's native format is stable. It maps only the supported image subset (`imageInput`, `prompt`, `nanoBanana`/image generation, `output`, `outputGallery`, later annotation), externalizes inline images, strips provider credentials/settings, and reports every unsupported or rewritten node. Unknown nodes remain disabled placeholders where possible. This importer is compatibility code, not permission to copy upstream storage architecture.

### 7. Image providers need a separate capability registry

Aiden's current provider/model types are LLM-oriented. Do not force image capabilities into `ProviderModelType = "llm" | "embedding"` or assume every chat credential can authorize an image endpoint. Introduce an image-specific registry contract:

```ts
interface ImageProviderAdapter {
  getCapabilities(auth: MainOwnedAuth): Promise<ImageProviderCapabilities>;
  validate(
    request: ImageGenerationIntent,
    capabilities: ImageProviderCapabilities,
  ): ValidatedImageRequest;
  estimate?(request: ValidatedImageRequest): Promise<CostEstimate>;
  submit(request: ValidatedImageRequest, context: RunContext): Promise<ProviderJob>;
  poll?(job: ProviderJob, context: RunContext): Promise<ProviderJobState>;
  cancel?(job: ProviderJob, context: RunContext): Promise<void>;
  collect(job: ProviderJob, context: RunContext): Promise<StagedAsset[]>;
}
```

Create Images workflow/run authority remains global device-local Aiden data and is never tied to the active coding workspace. On first entry, however, the user must explicitly choose a separate image workspace through a main-owned native folder picker. Aiden keeps its protected content-addressed store authoritative while materializing non-overwriting, Finder-visible copies under `Imports/` and `Generated/`; it verifies the chosen directory identity and writability before imports or runs. Switching coding workspaces must not make a top-level creative workflow appear lost, and Aiden never writes generated assets into the active repository implicitly.

Hostile image decoding stays outside privileged application logic. PNG/JPEG are validated byte-exactly; other bounded static rasters first use a disposable sandboxed Electron decoder and, on macOS only, may fall back to fixed-argument `/usr/bin/sips` conversion inside a private temporary directory. Every converted PNG is revalidated against the same byte, dimension, and pixel ceilings before canonical ingest. SVG/vector, animated, malformed, mismatched, oversized, or over-dimension inputs remain unsupported rather than weakening the boundary for format parity.

Provider API keys remain in Aiden's main-owned `safeStorage` credential path. Reuse an existing provider credential only when its exact auth kind and scope are compatible; do not silently reuse OAuth/session credentials intended for chat. Renderer DTOs expose connected/disconnected, display name, capability options, and safe error codes only.

Provider order:

1. **Gemini** for the first vertical slice, subject to current model access and capability verification. The inspected Node Banana mapping contains preview-era IDs and is already susceptible to API drift. Its request construction is useful research, but Phase 0 must select the current stateless image API versus the newer provider interaction/state mechanism deliberately and pin only verified model IDs. Implementation follows the current [Gemini image-generation guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) and [GenerateContent API](https://ai.google.dev/api/generate-content).
2. **OpenAI GPT Image 2** after the adapter contract is stable. Use the current [image generation guide](https://developers.openai.com/api/docs/guides/image-generation) and [GPT Image 2 model contract](https://developers.openai.com/api/docs/models/gpt-image-2), not upstream's older model assumptions.
3. **Replicate** as the first durable async adapter. The official API returns prediction IDs/get/cancel URLs, supports `Cancel-After`, and removes API prediction data after one hour by default; Aiden must persist IDs and copy outputs immediately. See [create a prediction](https://replicate.com/docs/topics/predictions/create-a-prediction) and [data retention](https://replicate.com/docs/topics/predictions/data-retention/).
4. **fal** after async recovery is proven. Its queue exposes durable request IDs/status/result/cancel operations, and cancellation may be advisory once processing starts. See [fal asynchronous inference](https://fal.ai/docs/documentation/model-apis/inference/queue).

Kie and WaveSpeed remain out of scope until there is demand, a documented auth/lifecycle contract, and a security review.

Preserve every valid provider output as an asset variant. Several inspected upstream adapters select only the first returned image; Aiden's normalized result must not silently discard paid outputs.

Every adapter must use fixed HTTPS origins and a reviewed redirect/output-host policy; validate DNS/IP targets where URLs are provider-controlled; bound headers, bodies, decoded pixels, redirects, polling time, and total job lifetime. Logs redact credentials, prompts, inline media, signed URLs, and raw provider bodies. Provider safety refusals are normalized without weakening or bypassing the provider's policy.

### 8. Cost, privacy, and consent are workflow states

Before paid remote work, show provider/model, number of scheduled remote node invocations, image count/quality/size, whether images/prompts leave the device, and a best-effort estimate with its timestamp/source. If a precise estimate is unavailable, say so; never show false precision.

User input and assets are sent only after **Run** confirmation. First cloud use states that prompts/reference images leave the Mac, provider terms and retention apply, cost may be incurred, the user must have rights/consent for uploaded material, and cancellation may not prevent completion or billing. Outputs are copied to Aiden's local store. Do not put prompt/image contents in telemetry. Provide provider-policy links and a clear per-workflow default provider. A provider/model change invalidates the previous estimate. Any retry or fan-out beyond the confirmed plan requires a bounded policy and visible accounting.

## Node catalog and sequencing

### MVP nodes

The first new workflow opens with an editable `Prompt → Generate Image → Output` starter graph and a visible **Blank workflow** alternative. This lowers the canvas learning cost without introducing a separate prompt composer.

| Node             | Inputs                                      | Outputs             | Execution         | Acceptance                                                                                      |
| ---------------- | ------------------------------------------- | ------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `Image Input`    | local file/drop/paste                       | `image`             | main asset ingest | Shows bounded thumbnail, metadata, replace/remove, and an explicit invalid-file error.          |
| `Prompt`         | optional upstream text                      | `text`              | local             | Multiline editor, variable insertion deferred, no execution side effects.                       |
| `Generate Image` | required text; optional image or image list | `image[]`, metadata | remote provider   | Capability-driven options, estimate, progress, cancellation, durable result, normalized errors. |
| `Output`         | image                                       | metadata/reference  | local publication | Marks a selected result, allows inspect/download/reuse, never duplicates bytes.                 |
| `Output Gallery` | image or image list                         | metadata/reference  | local publication | Displays many bounded thumbnails with keyboard navigation and lazy full preview.                |

### Phase 6 image-workflow nodes

- `Annotation`: non-destructive vector layer plus explicit flatten action.
- `Image Compare`: accessible before/after slider plus side-by-side fallback.
- `Resize/Crop`: deterministic local transform with a new immutable output asset.
- `Split Grid`: validated rows/columns and bounded output fan-out.
- `Array`: explicit bounded values/fan-out with cost preview.
- `Prompt Constructor`: structured text composition.
- `Router/Switch`: deterministic data routing; no paid retries.
- `LLM Prompt`: only after a clear boundary between chat model credentials/cost and image generation.

### Later candidates

Loops, provider fallback, background removal, video/audio/3D/GIF, ComfyUI, community sharing, and custom nodes each require a separate plan or explicit addendum with new threat, lifecycle, cost, and packaging gates.

## Delivery plan

### Phase 0 — architecture contracts and dependency feasibility

Review correction (2026-08-11): the original Phase 0 checklist incorrectly pulled live-provider, durable-asset, crash-journal, and final distribution acceptance ahead of the phases that build those boundaries. A live paid call also cannot be an unattended development gate without a user-supplied credential and explicit data/cost consent. Those requirements are not removed: they remain blocking exits for Phases 2–5 below. Phase 0 is limited to non-network architecture contracts and deciding whether it is safe to begin the hidden canvas shell.

Deliverables:

1. Pin/audit `@xyflow/react`; build a release-mode, sandboxed Electron dependency fixture with custom nodes and 100/250-node datasets. The real Aiden canvas must pass the packaged gate at the end of Phase 1 and again in Phase 5.
2. Threat-model bounded IPC versus an opaque custom asset protocol and implement a document-owned, expiring, authorization-checked grant core. Phase 2 performs real image delivery, byte/pixel/heap measurements, CSP integration, and lifecycle tests.
3. Implement a pure typed DAG validator/scheduler contract with deterministic ordering, bounded concurrency, explicit paid paths, failure propagation, non-cooperative cancellation, immutable snapshots, run/revision/sequence identity, and stale completion rejection.
4. Prototype atomic workflow metadata manifests with Aiden's existing `DataStore` patterns, compare-and-swap revisions, structured corrupt/future-schema health, and renderer-document publication liveness. Run journals and crash recovery are Phase 3.
5. Verify the current official Gemini API/model/request contract without sending a paid request. The real text-to-image and reference-image acceptance is Phase 4 after the durable output boundary and explicit user consent exist.
6. Write an ADR selecting the canvas dependency, graph schema v1, scheduler contract, metadata store, proposed binary-delivery boundary, and first provider.
7. Record dependency licenses/provenance, add notices for the installed runtime subtree, and decide whether any Node Banana code—rather than ideas—will be adapted.

GO gates:

- the CSP-clean Electron dependency fixture initializes the exact graph counts and dimensions, stays within recorded 100/250-node render/viewport/selection/heap thresholds, and reports renderer errors;
- exact dependency versions, peer compatibility, licenses, lockfile provenance, and packaged-notice configuration are recorded;
- no credential, absolute path, full-size base64, or arbitrary URL crosses the preload contract;
- graph/schema bounds, port compatibility, cycles, manifest asset reconciliation, immutable plans, explicit downstream paths, deterministic execution, failure, cancellation, and late-result behavior pass focused tests;
- corrupt/future workflow metadata is distinguishable from an empty first run and cannot be overwritten;
- opaque grants bind the actual renderer-document owner format, check live authorization, expire, and revoke on invalidation;
- the current fixed Gemini request serializer accepts only curated models/options and contains no credential, renderer-selected endpoint, path, remote URL, or provider conversation state;
- focused tests, type-check, lint, build, scoped React diagnostics, and two fresh-context reviews pass after all validated findings are fixed.

Deferred but still blocking gates:

| Gate                                                                                            | Blocking phase |
| ----------------------------------------------------------------------------------------------- | -------------- |
| Real asset IPC/protocol comparison with large/high-pixel-count media, cleanup, and CSP          | Phase 2        |
| Workflow/asset corruption, autosave, reopen, and crash recovery                                 | Phase 2        |
| Run journal crash boundaries and duplicate-submission prevention with mock provider             | Phase 3        |
| Opt-in real Gemini generation/edit, response validation, and durable-before-success publication | Phase 4        |
| Release-representative packaged performance, `npm run dist`, notices/SBOM, and clone exclusion  | Phase 5        |

Stop and revise this plan if any current-phase gate fails. Do not enable a provider or durable side effect earlier than its owning phase.

### Phase 1 — route, sidebar, canvas, and graph editor (1–2 weeks)

- Add the gated `/create-images` and `/create-images/$workflowId` routes and sidebar **Create Images** entry.
- Add route-aware terminal/environment behavior and command catalog entries.
- Implement blank/loading/recovery/error workbench states.
- Add React Flow boundary, Aiden-themed grid, pan/zoom/fit, minimap toggle, selection, multiselect, delete, duplicate, connect/disconnect, and bounded undo/redo.
- Implement registry and renderer nodes for the five MVP types using fixtures only.
- Add typed connection rules, cycle prevention, structured validation, node search, inspector, and accessible node-list projection.
- Persist only an in-memory fixture graph in this phase; no real provider button is enabled.

Exit: a keyboard-accessible, theme-correct packaged canvas edits 100-node fixtures without product network or filesystem access.

### Phase 2 — durable workflows and assets (1–2 weeks)

- Implement workflow index/store, version/revision contract, atomic autosave, last-known-good recovery, and route/close flush.
- Implement main-owned asset ingest, SHA-256 dedupe, validation, thumbnails, byte-bounded cache, preview delivery, reference accounting, and repair/GC dry run.
- Wire Image Input, workflow create/rename/duplicate/delete, recent workflow reopening, and conflict/recovery UI.
- Define native `.aiden-images` archive export/import and hostile-archive fixtures.

Exit: workflows with large imported images survive app restart and corruption simulations without graph base64, lost assets, silent overwrite, or unbounded heap growth.

### Phase 3 — durable scheduler with mock provider (1–2 weeks)

- Implement main graph validation, immutable run snapshots, coordinator, run journal, event sequencing, concurrency gates, run all/from-here/stop, and restart reconciliation.
- Add a deterministic local mock image provider with controllable delay, failure, rate limit, crash, duplicate/out-of-order events, and late completion.
- Build node/run progress UI, blocked descendants, actionable errors, retry rules, and terminal run history.
- Add cost/consent UI using mock estimates.

Exit: all execution/recovery gates pass under deterministic tests before any billable adapter is enabled.

### Phase 4 — Gemini vertical slice (1–2 weeks)

- Add image-provider connection/capability status without exposing credentials.
- Implement curated Gemini models/options, current capability validation, request bounds, reference-image handling, response validation, output persistence, usage metadata, rate-limit handling, and refusal/error normalization.
- Require the explicit run consent summary and prevent duplicate submissions on renderer refresh/reconnect.
- Add mocked contract tests plus manual opt-in acceptance with a real user-supplied key.

Exit: text-to-image and reference-image workflows run, cancel as far as the provider permits, recover safely, persist outputs, and account for requests without leaking secrets.

### Phase 5 — MVP completion and release hardening (1–2 weeks)

- Add starter templates, native import/export, download/reveal, workflow deletion/GC experience, a first-open image-workspace chooser with Finder reveal/sync/reconnect, first-run empty state, and documentation.
- Complete accessibility, responsive, reduced-motion, light/dark/high-contrast, keyboard, screen-reader announcement, and canvas performance passes.
- Add feature telemetry limited to non-content operational counters only if Aiden has an approved telemetry path; otherwise ship without it.
- Add the durable feature to onboarding's final bento gallery with its own optimized 1024×1024 transparent PNG in `renderer/assets/onboarding/` and update the hardcoded onboarding asset contract test.
- Complete CSP, packaging, asar, dependency/license, signed/notarized build, update-from-prior-release, and storage-migration acceptance.
- Roll out behind `createImages` capability: internal → opt-in preview → default when quality gates pass.

Exit: every MVP acceptance criterion below passes in a packaged production-like build.

### Phase 6 — annotation and local image utilities

- Spike/pin Konva and react-konva only now.
- Add non-destructive annotation layers with versioned shapes and a flattened immutable output.
- Add compare, resize/crop, split-grid, array, prompt-constructor, and deterministic router/switch nodes.
- Re-run heap, decoded-pixel, undo, import/export, and packaging gates.

### Phase 7 — provider expansion

- Add OpenAI GPT Image 2 through the established synchronous adapter contract.
- Add Replicate and fal only after durable remote-job recovery and cancellation tests pass.
- Add curated model catalogs with capability timestamps, safe refresh, deprecation handling, and reproducible provider/model snapshots in runs.
- Add per-provider concurrency, rate-limit, output-retention, cancellation, estimate, and content-policy UX.

### Phase 8 — Aiden-assisted workflows

- Define a strict graph proposal schema and graph-diff validator.
- Let Aiden propose a workflow or bounded edit from plain language using the existing connected LLM system.
- Show nodes/edges/options/cost implications before apply.
- Apply as one undoable graph transaction only after confirmation.
- Never let generated output contain raw executable code, provider credentials, absolute paths, or unsupported node types.

## Concrete implementation map

| Area        | Existing Aiden files to change                                                                                                                                          | New files/modules                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Capability  | `main/handlers/app.ts`, `renderer/lib/app-capabilities.tsx`                                                                                                             | fail-closed `createImages` capability and handler guard |
| Route/shell | `renderer/main/router.tsx`, `renderer/main/chat-layout.tsx`, `renderer/main/root-view.tsx` to suppress the global dock                                                  | `renderer/create-images/create-images-view.tsx`         |
| Sidebar     | `renderer/components/chat-sidebar.tsx`, `renderer/components/chat-sidebar.test.tsx`                                                                                     | none                                                    |
| Commands    | `renderer/shared/keybindings.ts`, command registry/menu/palette tests, `renderer/lib/command-system-core.ts`                                                            | `renderer/create-images/commands.ts`                    |
| Canvas      | `renderer/styles.css`, `renderer/shared/appearance.ts` only for reusable missing semantic tokens                                                                        | renderer module tree described above                    |
| IPC/preload | `renderer/preload-channels.ts`, `renderer/preload.ts`, `renderer/lib/ipc.ts`, `renderer/lib/queries.ts`, `main/handlers/index.ts`, `main/handlers/ipc-contract.test.ts` | `main/handlers/create-images.ts`, shared IPC schemas    |
| Persistence | reuse patterns from `main/services/data-store.ts`; do not change chat attachment storage                                                                                | workflow/run/asset services described above             |
| Credentials | reuse `main/services/secrets.ts` and exact compatible provider-registry credential retrieval                                                                            | image provider registry/adapters                        |
| Onboarding  | `renderer/components/onboarding-flow.tsx`, `renderer/components/onboarding-flow.test.tsx`                                                                               | `renderer/assets/onboarding/features/create-images.png` |
| Packaging   | `package.json`, lockfile, `THIRD_PARTY_NOTICES.md`, build/license checks                                                                                                | dependency provenance entry/ADR                         |

## Test and verification matrix

Add a focused `test:create-images` script and register every new test file in the correct aggregate scripts so CI runs it.

### Pure graph tests

- discriminated schema parsing and every forward migration;
- typed port compatibility/cardinality;
- duplicate/orphan edges and unknown nodes;
- stable topological ordering;
- cycle/self-loop rejection;
- run-all and every run-from-here boundary;
- failure/cancel/block propagation;
- bounded fan-out, node/edge counts, and graph depth;
- undo/redo transactions without asset byte duplication.

### Persistence and asset tests

- atomic save, stale expected revision, concurrent autosave, interrupted rename/write, corrupt current file, last-known-good recovery;
- content dedupe, reference count/rebuild, leases, delete/GC race, quota exhaustion, low disk, read-only directory, and repair dry run;
- MIME/magic mismatch, truncated image, EXIF edge cases, decompression/image bombs, extreme dimensions/pixel count, malicious SVG rejection, duplicate digest, and thumbnail failure;
- object URL/token ownership, expiry, renderer destruction, graph swap, and cache byte bounds;
- native and Node Banana import fixtures, unsupported-node reports, no credential import, zip traversal/symlink/bomb/file-count/size rejection.

### Scheduler tests

- concurrency limits and deterministic readiness;
- renderer reload/disconnect during a run;
- main crash at every submission/journal/output-publication boundary;
- duplicate and out-of-order provider events;
- rate limit/backoff budget;
- cancellation before submit, queued, polling, downloading, and after remote completion;
- late completion against cancelled/older revisions;
- restart reconciliation with and without durable remote IDs;
- no duplicate paid request after ambiguous submit response.

### Provider/security tests

- renderer payload cannot supply credentials, auth headers, absolute paths, or arbitrary request/output URLs;
- fixed origins, redirect limits, private/local IP rejection where applicable, DNS rebinding-safe fetch policy, response byte/time/pixel limits, and MIME validation;
- 401/403/429/5xx/timeout/malformed body/refusal/cancel normalization;
- signed URLs and prompt/image/API-key data are redacted from logs and errors;
- per-model capability drift disables incompatible saved options visibly;
- renderer/document ownership on every IPC and asset request;
- CSP is not widened to permit arbitrary remote content.

### Renderer/accessibility tests

- route and selected sidebar state;
- terminal/environment commands hidden and focus released on `/create-images*`;
- add/connect/move/select/delete/duplicate/undo/redo and node inspector behavior;
- keyboard-only node creation/connection alternative and screen-reader announcements;
- focus trap/return for panels and dialogs;
- non-color run states, reduced motion, zoom controls, and high contrast;
- empty/loading/recovery/offline/unconfigured/running/cancelled/partial-failure/quota-full states;
- 390/700/1000/1280 px layouts.

### Performance and release tests

- 100/250-node fixtures with representative thumbnails in packaged Electron;
- pan/zoom/connect latency and long-task count;
- heap/decoded-image cache after repeated open/close, run, graph swap, and preview cycles;
- 20 MB image and high-pixel-count rejection/handling;
- app quit during autosave/run/output publication;
- `npm run test`, typecheck, lint, production build, `npm run dist`, packaged smoke, prior-version migration, signed/notarized launch, and update path;
- packaged app contains required third-party notices and excludes `tmp/node-banana`, provider credentials, prompts, imported assets, run journals, and research-only fixtures.

## Security and privacy threat boundaries

| Boundary                      | Principal risk                                                              | Required control                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| renderer → main IPC           | forged IDs, giant payloads, path/URL injection, stale writes                | schema and size validation, webContents/document ownership, opaque IDs, expected revisions, narrow methods |
| main → provider               | secret leakage, SSRF/redirect abuse, unbounded responses, duplicate billing | main-only auth, fixed origins, redirect/host policy, byte/time limits, idempotency/reconciliation journal  |
| provider output → asset store | malicious/mislabeled or huge media                                          | stream to quarantine, magic/MIME/pixel validation, hash, atomic publish, safe thumbnail decoder            |
| archive → local store         | traversal, bombs, credential/executable smuggling                           | hostile ZIP policy, quarantine, full validation, no URL fetch or execution, atomic publish                 |
| graph → scheduler             | cycles, fan-out/cost explosion, unsupported configs                         | typed validation, hard graph/fan-out/concurrency limits, immutable run snapshot, consent summary           |
| event stream → renderer       | stale/duplicate/out-of-order completion                                     | run/revision/node/sequence identity and idempotent reducer                                                 |
| storage GC                    | deleting live or previewed assets                                           | atomic reference rebuild, leases, quarantine/grace period, repair tooling                                  |

## Licensing and provenance

Node Banana's [`LICENSE`](https://github.com/shrimbly/node-banana/blob/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c/LICENSE) is MIT and identifies William Falloon as copyright holder. Product concepts and independently implemented behavior do not require code copying, so the default is a clean reimplementation.

The upstream dependency tree is not uniformly MIT. In particular, the inspected background-removal path pins `@imgly/background-removal`, whose bundled package declares AGPLv3 rather than MIT. Do not add, adapt, or distribute that dependency in Aiden without explicit legal approval or a separately reviewed permissive/commercial replacement.

If any source, tests, text, templates, or assets are copied or adapted:

1. record the exact upstream commit, path, symbol, and adaptation in the Create Images ADR/provenance ledger;
2. preserve the MIT copyright and license in `THIRD_PARTY_NOTICES.md` and any required distribution location;
3. mark Aiden modifications clearly;
4. do not copy Node Banana branding, logo, community assets, example media, or prompts without separate rights review;
5. run a license audit for React Flow, optional Zustand/Konva, provider SDKs, image decoders, archive libraries, and all transitives;
6. verify the packaged artifact rather than assuming `package.json` notices are sufficient.

## MVP acceptance criteria

The MVP is complete only when all are true:

- **Create Images** is a sidebar entry and opens a full persistent node canvas, not a simple prompt page.
- Five MVP node types can create a valid image workflow with typed edges and actionable validation.
- At least one real provider supports text-to-image and reference-image input through main-owned credentials and requests.
- The confirmation surface identifies destination provider/model, request count, data leaving device, and best-effort cost.
- Run all, run from here, stop, partial failure, rate limit, provider refusal, offline, and restart states are understandable and tested.
- Generated outputs are locally durable before success, and reopening Aiden restores graph/output references.
- Graph JSON, undo history, IPC, and logs contain no full-size base64 images, API keys, signed URLs, or absolute asset paths.
- Corrupt saves, low disk, quota exhaustion, app kill, stale events, and ambiguous provider submission do not silently lose work or duplicate paid execution.
- Native import/export rejects hostile archives; no import triggers network or execution.
- Packaged canvas performance passes the 100-node gate and remains functionally usable at 250 nodes.
- Keyboard, screen reader, reduced-motion, light/dark/high-contrast, and responsive gates pass.
- Onboarding's final feature gallery includes the shipped capability and its required 1024×1024 transparent PNG.
- Dependency/provenance notices are correct, and the ignored Node Banana clone is absent from source control and release artifacts.

## Decisions locked by this plan

- The sidebar label is **Create Images**; `/create-images` is the workflow library and `/create-images/$workflowId` is the durable canvas route.
- The primary UI is a full node-workflow canvas.
- Workflow/run authority and canonical assets are global device-local Aiden data. First entry requires an explicitly chosen, identity-bound image workspace containing non-overwriting Finder-visible import/generated mirrors; it is never inferred from the active coding repository.
- The MVP is image-only and ships five node types.
- Renderer owns interaction; main owns trust, durability, providers, and execution.
- Assets are content-addressed files referenced by IDs, not graph base64.
- Graph documents and run state are separate and versioned.
- Cycles, loops, fallback, arbitrary custom code, and broad dynamic model catalogs are not MVP features.
- Gemini is the planned first provider, subject to the Phase 0 capability spike.
- React Flow is the selected canvas library after the Phase 0 dependency-feasibility gate, subject to the real product-canvas gate in Phase 1 and final distributable gate in Phase 5.
- Node Banana is a pinned MIT research reference, not vendored application code.

## Phase-owned evidence questions

1. **Phase 1/5:** does the real Aiden canvas meet packaged 100/250-node performance and accessibility thresholds on supported hardware?
2. **Phase 2:** is bounded IPC or `aiden-asset://` safer and more performant for selected full images and many thumbnails?
3. **Phase 4:** is Aiden's current Google credential record an exact API-key match for Gemini image generation, or does Create Images need a separate connection flow?
4. **Phase 4:** which current Gemini image models/options are available to target accounts, and how is capability drift represented?
5. **Phase 2:** what total storage quota and per-image decoded-pixel limit fit supported hardware?
6. **Phase 1:** does React Flow's controlled store meet Aiden's interaction/undo needs without another direct state dependency?
7. **Phase 3/4:** what ambiguity strategy prevents a duplicate paid request when a provider accepts work but the connection fails before Aiden receives a durable result?
8. **Phase 2:** which local image decoder/metadata pipeline is safe, sandbox-compatible, packaged reliably, and bounded against decompression bombs?
9. **Phase 2/3:** do bounded JSON metadata plus separate journals meet measured scale, or does evidence justify SQLite's native dependency and migration surface?

Each owning phase must answer its questions with measurements before crossing that boundary. The Phase 0 ADR records only the non-network foundation decision needed to start Phase 1.

Phase 0 evidence, both fresh-context reviews, the resulting fixes, and the GO decision are recorded in [`create-images-phase-0-adr.md`](create-images-phase-0-adr.md).
