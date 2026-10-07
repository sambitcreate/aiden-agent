# ADR-CI: Create Images on Pi image models

> **Reconciled with ADR-F (2026-10-07):** the shared studio asset store's record field is `mediaType` and `put` takes `{ bytes, declaredMimeType? }`; holder keys are `images-workflow:<id>` and `images-run:<id>`; grants come from `studioAssetGrants.issue(owner, assetId, rendition)` → `aiden-asset://grant/<token>`. The provider port keeps Pi's `mimeType` naming; the coordinator maps `mimeType` → `declaredMimeType` at `put`. Validation accepts PNG/JPEG/WebP.

Status: Proposed. Needs owner approval (Phase 0 gate).
Date: 2026-10-07
Baseline: `main` @ `bd232b85` (Pi 1.0.3)
Parent plan: [design-studio-create-images-rebuild-plan.md](design-studio-create-images-rebuild-plan.md), §6 ADR-CI and §9 Track CI
Depends on: [studio-foundation-adr.md](studio-foundation-adr.md). That ADR owns the `createImages` flag, the lazy `/images` route, the sidebar row, the `renderer/canvas/` kit, the `main/services/studio-assets/` store, the `aiden-asset:` protocol with document-bound grants, the reconcile-chain slot and the test-lane filing rule (F-D9: npm suites filed into the existing CI lanes through `scripts/ci-test-registry.json`; no new lane). This ADR uses those and does not redefine them.
Port source (read-only): `.claude/worktrees/ref-create-images` @ `1e3b3909`

## 1. Facts verified on current main

| Question | Answer (source) |
|---|---|
| Image entry point | `Models.generateImages(model, { input: (TextContent \| ImageContent)[] }, { signal, maxRetries, … })` resolves auth and **never rejects**. It returns `AssistantImages { output, usage?, stopReason: "stop" \| "error" \| "aborted", errorMessage?, responseId? }` (`pi-ai/dist/models.d.ts:190`, `types.d.ts:435-447`). |
| Cancellable? | Yes. `ImagesOptions.signal` goes through `retryProviderRequest` and the OpenAI SDK fetch. An aborted request returns `stopReason: "aborted"` (`api/openrouter-images.js`). |
| Hidden retries? | `retryProviderRequest` defaults to `maxRetries ?? 0`. The SDK is called with `maxRetries: 0`. The port still passes `maxRetries: 0` explicitly. |
| Usage and cost | `usage` comes from OpenRouter token counts × catalog `cost`. It is often 0 or missing: FLUX, for example, is priced per megapixel and has catalog cost 0, so `costStatus` resolves to `"unavailable"`. |
| Output bytes | Inline base64 `ImageContent { data, mimeType }`, taken from `message.images[]` `data:` URLs. There is no URL fetch. |
| Request parameters | `ImagesContext` has **no** aspect ratio, size, count or MIME parameter. Only prompt text and reference images go to the provider. |
| Catalog | 59 image models, **all `openrouter`** (`api: "openrouter-images"`), e.g. `google/gemini-3.1-flash-image` (Nano Banana 2), `openai/gpt-image-2`, `black-forest-labs/flux.2-pro`. The bundled `google` provider has **0** image models. |
| `registerImagesApiProvider` | It only feeds the static `generateImages()` in `images.js`. `Models.generateImages` dispatches through the **provider's** `images` map (`models.js:486`, `createProvider({ images })`). A direct Google path therefore means `models.setProvider(...)` with a provider that has image models. The precedent is `registerAidenBuiltinProviders` in `concentrate-provider.ts`. Registering the API alone is not enough, which corrects umbrella §6. |
| Existing chat path | `createPiModelTools` (`pi-model-tools.ts:404-600`). The tools are `list_operation_models` → `getAvailableOfType("image")` and `generate_image`, with ≤4 references, 8 MiB per image, 40 MP total (`resolvePiModelImageInputs`), and output checks in the private `validImages` (≤4 images, 8 MiB, magic and dimension check). Wired in `llm-client.ts:1554`. Approval disclosure: `modelImageReferences.disclosure` at `llm-client.ts:3125`. |
| Accounting | `modelOperationUsageRecord(record, providers, source)` → `usageStore.record`. `UsageRequestSource` and `REQUEST_SOURCES` live in `usage-store-core.ts:8,80`. |
| SQLite precedent | `durable-jobs/store.ts` (DatabaseSync, `O_NOFOLLOW` + nlink/uid checks, `user_version`, WAL) has no production instance yet. `memory-store.ts` is the production `node:sqlite` user. |
| Throttle | `createThrottledTrigger(run, ms)` in `portable-config-watch-core.ts:203` fires leading and trailing. Its `dispose()` drops a pending trailing call. |
| e2e boundary fakes | Fakes sit at the process or HTTP edge: a test-owned LM Studio server, `agent-device-fake.mjs`, and the fetch-origin redirect in `tests/e2e/electron-test-bootstrap.cjs`. Product code has no mock branches. |

## 2. Decisions

### 2.1 Provider layer: `ImageGenerationPort`

The port lives in `main/services/create-images/image-port.ts`, with Electron-free types in `renderer/shared/images/port.ts`.

```ts
interface ImageModelOption { provider: string; providerLabel: string; model: string; label: string;
  acceptsReferences: boolean; textOutput: boolean }
interface ImageGenerationRequest { provider: string; model: string; prompt: string;
  references: readonly { mimeType: string; bytes: Uint8Array }[]; signal: AbortSignal }
type ImageGenerationResult =
  | { kind: "images"; images: { mimeType: string; bytes: Uint8Array; width: number; height: number }[];
      text?: string; usage?: Usage; responseId?: string }
  | { kind: "failed"; code: "aborted" | "unknown-model" | "references-unsupported" | "provider-error"
      | "output-invalid"; message: string; usage?: Usage };
interface ImageGenerationPort {
  listModels(signal?: AbortSignal): Promise<readonly ImageModelOption[]>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>; // never throws provider outcomes
}
```

- **Implementation.** `createPiImageGenerationPort({ models, providerLabel, onUsage })` takes `models: Pick<Models, "getAvailableOfType" | "getModelOfType" | "generateImages">`, the same `Pick` that `PiModelToolsHost` uses. Production passes `providerRegistry.models`.
- **Shared validation.** Extract `validImages` from `pi-model-tools.ts` into an exported `parseGeneratedImages()` in `main/services/pi-model-image-output.ts`. This is a behavior-preserving move, and `generate_image` keeps using it. References reuse `resolvePiModelImageInputs` bounds through an `ImageContent` adapter.
- **Usage.** Each provider call records exactly one usage entry through `modelOperationUsageRecord(..., "create-images")`. This adds `"create-images"` to `UsageRequestSource` / `REQUEST_SOURCES`. Status is `completed`, `failed` or `cancelled`, and the record carries no prompts or paths.
- **Picker source.** `getAvailableOfType("image")` returns only providers with complete auth, from last-known lists. The port **never** calls `models.refresh()`, so it adds no catalog network (AGENTS.md posture). It drops `openrouter/auto*`, because consent must name the real model. Without a configured provider, the picker shows "Add an OpenRouter key in Settings → Providers".
- **Direct Google: defer to CI-2, conditional.** It needs a wrapped `google` provider with hand-maintained image models plus an `@google/genai` image implementation. `@google/genai` 2.24.0 is already a dependency. Credentials would follow the `tts/credentials.ts` explicit-source pattern: a saved Google key reused only after the user opts in, or `aiden-internal:images-api-key`, failing closed. That edits `provider-registry.ts`, a shared core, and would add a second unvalidated provider before the first real image exists, which is the old branch's failure mode. Include it in CI-1 only if the owner has no OpenRouter key (Q2).
- **Test seam: no product mock.**
  - *Unit and integration:* `createModels()` + `setProvider(createProvider({ id: "test-images", auth, models: [imageModel], images: { "test-images": { generateImages } } }))`. The fake counts calls, records signals and can return images, errors, 429s, late results and over-limit outputs. This exercises the real `Models` auth and dispatch path.
  - *e2e:* a test-owned loopback server that speaks OpenRouter's chat-completions image response. The test-only bootstrap redirects only the `https://openrouter.ai` origin, extending the existing LM Studio redirect. A spec-scoped fake OpenRouter key is supplied through a fixture option. CI-1.9 verifies the env-versus-Settings key route.
  - Nothing ships in `main/`.

### 2.2 Consent: separate from tool approval, enforced in main

Create Images runs are UI actions the user starts, not agent tool calls, so they do **not** go through `llm-client` `beforeToolCall` approvals. That system stays the gate for chat `generate_image`. The two share the disclosure facts: provider and model labels, plus reference count and bytes.

```ts
interface ImageRunConsentPlan { consentId: string; workflowId: string; workflowRevision: number;
  scope: { kind: "all" } | { kind: "from-node"; nodeId: string };
  requests: { nodeId: string; variant: number; provider: string; providerLabel: string;
    model: string; modelLabel: string; referenceCount: number; referenceBytes: number }[];
  totalRequests: number; estimate: { kind: "unknown" };   // see Q4
  createdAt: number; expiresAt: number }                  // expiresAt = createdAt + 5 min
```

- **`prepare-run`** loads the **saved** document at `workflowRevision` and rejects a stale revision, so the renderer flushes autosave first. It builds the plan with the scheduler's planner. It stores the plan in an in-memory, single-use map keyed by a random `consentId` and bound to the requesting `rendererDocumentOwner`. It sends nothing to a provider.
- **`start-run`** consumes the consent. It re-checks expiry, document owner, document revision, plan digest and model availability, then creates the run with `request_limit = totalRequests`.
  - The port wrapper increments `runs.requests_sent` and refuses when the limit would be exceeded. That is the hard counter from umbrella §3.4.
  - An expired or unused consent sends nothing, and there is no "discard" channel.
- **No automatic paid retry or fallback.** The port passes `maxRetries: 0`, and the coordinator never substitutes another model. "Retry failed" is a new `prepare-run` scoped to the failed attempts, with fresh consent.
- **Run from here** runs the node and its descendants. Upstream Generate outputs come from their latest succeeded attempt. If an upstream output is missing, `prepare-run` returns an issue ("Run upstream first") instead of silently adding paid requests.
- **Cancel.** Queued attempts become `cancelled` with no request sent. A running attempt is aborted through its signal, recorded `cancelled`, and keeps `submitted_at`, so the UI says "may have been billed".
  - If a provider result settles successfully before the abort is observed, its images are **kept** and the attempt is `succeeded` with `cancel_requested=1`. Paid output is never silently discarded.
  - If a model returns more than 4 images, the first 4 valid ones are kept and the attempt is flagged `truncated`. The paid attempt is not failed. This reflects the old branch's Gemini interim-image lesson.
- **Quit.** `shutdownAndQuit` calls `imageRuns.shutdown()`: abort all, then mark `cancelled` with reason `app-quit`. This is a one-line orchestrator registration in the `main/index.ts` hotspot.
  - *Adjustment:* CI-1 also adds a main-side in-flight check to `confirmProtectedAction` with honest copy: "N image requests in progress. Quitting cancels them; requests already sent may still be billed." CI-4 keeps only the copy polish.

### 2.3 Persistence

**Workflow documents.**
- One file per workflow at `userData/create-images/workflows/<id>.json`, plus `index.json` holding `{ id, title, revision, updatedAt }`. Both are written with `writeJsonAtomic`.
- Schema **v1 only** (`schemaVersion: 1`), with no migration code. Documents hold no outputs or base64. The cap is 2 MiB.
- Main serializes saves per workflow on a promise chain. Optimistic concurrency uses `baseRevision`: a mismatch returns `conflict`, and the renderer reloads.
- Renderer autosave: 800 ms idle debounce, flushed on route leave and before `prepare-run`. A dirty or saving document sets the existing renderer close guard (`closeGuard.dirty` / `saving`).

**Run ledger.**
- File: `userData/create-images/runs-v1.sqlite`. It is opened in the reconcile chain before `openProcessStartupIpcAdmission()`. File-safety checks and `user_version` handling copy `durable-jobs/store.ts`.
- Mode: `journal_mode=WAL`, `synchronous=NORMAL`. A commit survives an app crash. An OS crash can lose the last transactions, which only loses history, because restart never resubmits.

```sql
CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL,
  scope TEXT NOT NULL, from_node_id TEXT, state TEXT NOT NULL CHECK(state IN
  ('running','succeeded','partial','failed','cancelled','interrupted')),
  request_limit INTEGER NOT NULL, requests_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, finished_at INTEGER, end_reason TEXT);
CREATE INDEX runs_by_workflow ON runs(workflow_id, created_at DESC);
CREATE TABLE attempts (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, variant INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN
  ('queued','running','succeeded','failed','skipped','cancelled','interrupted')),
  provider TEXT, model TEXT, submitted_at INTEGER, finished_at INTEGER, error_code TEXT,
  error_message TEXT CHECK(length(error_message) <= 1024), cancel_requested INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0, cost_usd REAL, cost_status TEXT, output TEXT, -- JSON: ≤4 {assetId,w,h,mime}
  UNIQUE(run_id, node_id, variant));
CREATE INDEX live_attempts ON attempts(state) WHERE state IN ('queued','running');
```

- **One row per node attempt.**
  - An append is a single prepared `INSERT` or `UPDATE` with no reads, so the cost is O(1).
  - Provider attempts commit `submitted_at` in their own transaction **before** the request is sent.
  - Local-node transitions are coalesced into one transaction per scheduler tick.
- **Restart.** In the reconcile chain:
  - Run `UPDATE attempts SET state='interrupted' WHERE state IN ('queued','running')`, plus the matching `runs` update.
  - Attempts with `submitted_at` show "may have been billed". There is no resubmit.
- **Retention.** Keep the 100 newest runs **plus**, for each workflow, the run holding each node's latest succeeded output. Pruning runs after each run finishes and once at startup.
- **Assets** go to the shared store (ADR-F). Each output asset is retained by holder `images-run:<runId>`, and each Image Input asset by `images-workflow:<id>`. Prune and delete release holders. If ADR-F lands plain ref-counts, use one increment per output row. GC belongs to F.
- **Perf target.** A synthetic 500-node run against a zero-latency fake port must spend **< 1 s total** inside ledger calls, measured by wrapping the ledger. It runs as a separate `test:create-images:perf` npm script filed into an existing CI lane (ADR-F: no new lanes), not in the default pretest chain. The old branch took 114 s.

### 2.4 Scheduler and coordinator (main)

**`scheduler-core.ts`** is pure and Electron-free, with a target of ≤ 300 lines.
- `planRun(doc, scope, priorOutputs)` uses `ports.ts` `validateWorkflowGraph` and `topologicalWorkflowOrder`. It yields ordered steps and the provider request list that feeds consent.
- `runPlan(plan, { execute, concurrency, signal })` uses ready-set dispatch.
  - Local nodes (Prompt, Image Input, Output) resolve inline.
  - Generate attempts run under a semaphore: `settings.concurrency`, default 2, max 4.
  - A failure marks only that node's descendants `skipped`, and independent branches continue.
  - An abort drains the queue to `cancelled`.

**`run-coordinator.ts`** must stay under 600 lines and be provider-agnostic. It wires the ledger, `ImageGenerationPort`, studio assets, the consent counter and notifications.

**Data flow between nodes:**
- Values are `{ kind: "text"; text }` or `{ kind: "images"; assetIds: string[] }`.
- Image bytes are read from the asset store only at the Generate boundary and then released. Bytes are never held for a whole run.
- A Generate node takes 1 prompt and ≤ 4 references, which is the Pi bound. The old branch allowed 14.
- `count` N becomes N independent attempts (`variant` 0..N-1), and each one counts in consent.

### 2.5 Progress delivery

- There is one notification, `imageWorkflows:run-changed`, which carries a **full run snapshot**: a run summary plus every attempt's compact state, about 150 B per attempt and ≤ 128 KiB at 500 nodes.
- It is driven by `createThrottledTrigger(flush, 250)`, so at most about 4 per second for each active run.
- Terminal transitions call `flush()` directly, so the trailing event is never lost to `dispose()`.
- The snapshot has a per-run monotonic `version`, and the renderer drops older snapshots.
- **Snapshot on subscribe.** On mount, the renderer calls `get-run`, then applies notifications.
- **No projection cache and no revision fences.** The ledger is the source of truth. A snapshot is one indexed `SELECT` of ≤ 500 rows, under 2 ms. The renderer replaces state wholesale, so replaying a snapshot is harmless. Nothing derived can drift.

### 2.6 Renderer architecture (`renderer/images/`, lazy route only)

| Module | Role | Budget |
|---|---|---|
| `images-home.tsx` | Workflow library (list, new from Blank/Starter, rename/duplicate/delete) | ≤ 300 |
| `workflow-editor.tsx` | Composes `<StudioCanvas>` from `renderer/canvas/`, the tool rail and the panels | ≤ 400 |
| `nodes/registry.ts` | `type → { definition (ports.ts), component, defaults, minSize }` | ≤ 120 |
| `nodes/{prompt,image-input,generate-image,output}-node.tsx` | One file per node type, built on the kit's node chrome | ≤ 250 each |
| `use-workflow-controller.ts` | Document state, `editor-core` history, connection rules, debounced autosave, close-guard flags | ≤ 400 |
| `use-image-run.ts` | Snapshot subscription and run actions | ≤ 200 |
| `run-panel.tsx` | Attempts list, Stop, cost and "may be billed" notes, retry-failed | ≤ 300 |
| `consent-sheet.tsx` | Provider, model, request count, references and estimate; Cancel / Generate | ≤ 250 |
| `model-picker.tsx` | Image models grouped by provider | ≤ 200 |
| `images.css` | Tokens only; imported only by the lazy route | – |

UI rules:
- The shared squircle `Button` and the semantic tokens.
- No bordered or accent selection cards.
- Neutral focus ring on non-text controls; no ring on text inputs.
- The client is `renderer/lib/create-images-ipc.ts`; no edits to `renderer/lib/ipc.ts`.

### 2.7 IPC (12 invoke channels plus 1 notification; ≤ 15 budget)

| Channel | Request | Response |
|---|---|---|
| `imageWorkflows:list` | `{}` | `{ workflows: { id, title, revision, updatedAt }[] }` |
| `imageWorkflows:create` | `{ template: "blank" \| "starter", title? }` | `{ workflow: WorkflowDocV1 }` |
| `imageWorkflows:get` | `{ workflowId }` | `{ workflow, latestOutputs: Record<nodeId, OutputRef[]> }` |
| `imageWorkflows:save` | `{ workflowId, baseRevision, document }` | `{ ok: true, revision } \| { ok: false, reason: "conflict" \| "invalid", issues? }` |
| `imageWorkflows:mutate` | `{ op: "rename", workflowId, title } \| { op: "duplicate" \| "delete", workflowId }` | `{ ok, workflowId? }` |
| `imageWorkflows:list-models` | `{}` | `{ models: ImageModelOption[] }` |
| `imageWorkflows:import-image` | `{ source: "dialog" } \| { source: "bytes", name, mimeType, data: Uint8Array /* ≤ 8 MiB */ }` | `{ assetId, mimeType, width, height, bytes } \| { cancelled: true }` |
| `imageWorkflows:prepare-run` | `{ workflowId, revision, scope }` | `{ plan: ImageRunConsentPlan } \| { issues: GraphIssue[] }` |
| `imageWorkflows:start-run` | `{ consentId }` | `{ runId } \| { error: "expired" \| "stale" \| "model-unavailable" }` |
| `imageWorkflows:cancel-run` | `{ runId }` | `{ ok }` |
| `imageWorkflows:get-run` | `{ runId } \| { workflowId /* active or latest */ }` | `{ snapshot: RunSnapshot \| null }` |
| `imageWorkflows:list-runs` | `{ workflowId, limit ≤ 50 }` | `{ runs: RunSummary[] }` |
| `imageWorkflows:run-changed` (notify) | – | `RunSnapshot` |

- All channels use `ipcMain.handle` with `main/shared/guards.ts` exact-key validators and the `rendererDocumentOwner` check.
- Handlers live in `main/handlers/create-images/`.
- Asset display URLs come from ADR-F's grant API. Create Images adds no asset channel and no paths cross IPC: the dialog runs in main.

### 2.8 CI-1 node set (schema v1)

- **Document:** `{ schemaVersion: 1, id, title, revision, createdAt, updatedAt, viewport?, nodes ≤ 500, edges ≤ 2000, settings: { concurrency: 1–4 } }`.
- **Node base:** `{ id, type, position, title?, dimensions? }`.
- **Edge:** `{ id, source, sourcePort, target, targetPort }`.
- **Port kinds:** `text`, `image`, `images`.

| Node | `data` | Ports |
|---|---|---|
| `prompt` | `{ text: string /* ≤ 16 KiB, matches generate_image */ }` | out `text:text` |
| `image-input` | `{ assetId?: sha256hex, label? }` | out `image:image` |
| `generate-image` | `{ model?: { provider, id }, count: 1 }` (CI-1 owner cap: 1 request per node; widen the union when batching lands) | in `prompt:text` (required, 1); `references:image/images` (≤ 4); out `images:images` |
| `output` | `{ label? }`; inline mini-gallery shows `latestOutputs` from the ledger | in `images:images` (required, 1) |

**Dropped from the old schema:**
- schemaVersions 1–5 and all migrations; `assetRefs`, which is derived; `settings.defaultProviderId: "gemini"`.
- `providerId: "gemini"`, `aspectRatio`, `imageSize` and `outputMime`. Pi has no such parameters. They return only through a justified per-API `onPayload` adapter.
- Node `comment`, edge `breakpoint`, `text-list` and `metadata` ports.
- Node types `prompt-list`, `output-gallery`, `image-compare`, `annotation` and `group`, which move to CI-2/CI-3.
- `CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES`, which F owns.

### 2.9 Port, rewrite, drop (old paths)

| Old path | Action | Notes |
|---|---|---|
| `renderer/shared/create-images/ports.ts` | **Port** (CI-1.1) | Trim to 4 node types and 3 port kinds; keep `validateWorkflowGraph` and `topologicalWorkflowOrder` with their tests |
| `renderer/create-images/editor-core.ts`, `node-dimensions-core.ts` | **Port** (CI-1.1) | History, connection decisions, arrange, fit-to-media |
| `renderer/shared/create-images/schema.ts` | **Rewrite** (CI-1.1) | v1 only, as in §2.8, using `guards.ts` |
| `renderer/shared/create-images/templates.ts` | **Port**: Blank/Starter in CI-1, explorer in CI-3 | Remove "Gemini" copy |
| `main/services/create-images/scheduler-core.ts` (1,219 lines) | **Port the core** | Keep plan and ready-set dispatch. Drop retry policy and jitter, the `remote` lane and job IDs, submission-prepared durability, the event cursor and reducer, renderer-disconnect handling and the 8 restart categories (replaced by one SQL sweep) |
| `run-service.ts`, `run-journal-store.ts`, `workflow-manifest-store.ts`, `image-provider-execution-core.ts` | **Rewrite** | §2.2–2.4; the consent HMAC token and fingerprint are replaced by a main-held single-use `consentId` |
| `main/handlers/create-images.ts`, `renderer/shared/create-images/ipc.ts`, `run-contract.ts` | **Rewrite** | §2.7 |
| `workflow-canvas.tsx`, `create-images-view.tsx`, `workflow-node.tsx`, `run-ui.tsx` | **Rewrite as a split** | §2.6 |
| `image-lightbox-core.ts`, `recent-output-core.ts`, `graph-fragment-core.ts` | **Port in CI-2** | |
| `prompt-variables.ts`, `prompt-list.ts`, `node-banana-import.ts`, `archive.ts` | **Port in CI-3** (sub-flags) | Keep the hostile-ZIP tests |
| `asset-image-validation-core.ts`, `asset-delivery-core.ts` | Ported **by Track F** | Not here |
| `providers/gemini-*`, `gemini-provider-status-core.ts`, `mock-image-provider-core.ts`, `packaged-canvas-acceptance-*`, `renderer-egress-core.ts`, `mutation-rate-limit-core.ts`, `workspace-store.ts`, `macos-image-normalizer.ts`, `electron-asset-image-utility.ts`, `fixtures.ts`, `feature-surface.test.ts`, `retry-policy.ts`, `run-ambiguity-confirmation.tsx`, `run-degraded-discard-confirmation.tsx`, plus CSP edits, the global egress guard, the favicon exception, source fingerprints, stress routes and `sips` | **Drop** | Umbrella §6 drop list |

### 2.10 Phase boundaries (confirmed, with adjustments)

- **CI-1.** Tasks 1.1–1.10 as in the umbrella plan, plus:
  - (a) the `parseGeneratedImages` extraction and the `"create-images"` usage source in CI-1.5;
  - (b) the quit in-flight confirm in CI-1.6;
  - (c) direct Google excluded unless Q2 says otherwise.
- **CI-1.10.** Owner-attended. Run one real Starter image through OpenRouter with the owner's key and record it in `docs/plans/create-images-ci-1-evidence.md`: the model, request count = 1, the ledger row, the asset hash and dimensions, and the usage record status and cost. Also record one Stop during a live request and the resulting row. **No CI-2 work starts before it passes.**
- **CI-2.** Lightbox and compare, recent outputs and reuse-as-input, Download/Reveal (`hostPlatformCapabilities()`), history pruning UI, copy/paste and drop-to-menu, a keyboard and VoiceOver pass, Settings → Images, and direct Google (if deferred). Plus the **chat bridge**:
  - "Open in Images" on a chat `generate_image` artifact imports its bytes into studio assets as an Image Input. It never re-runs anything.
  - "Send to chat" from an Output node attaches the asset through the existing attachment path.
  - Both checked against iOS/Android only if the transcript artifact contract changes, which is not expected.
- **CI-3 / CI-4.** Unchanged, except that the quit-copy item shrinks to polish.

## 3. Owner decisions (2026-10-07)

- **Q1/Q2:** OpenRouter in CI-1 with default `google/gemini-3.1-flash-image`; direct Google deferred to CI-2. The owner has an OpenRouter key for CI-1.10.
- **Q3:** **tighter caps** — 1 request per Generate node and **≤ 4 provider requests per run** in CI-1. Concurrency default 2 (max 4). Raise only with CI-3 batching and a fresh owner decision.
- **Q4–Q6:** the recommendations below are adopted.

## 3a. Original open questions (for the record)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Default model for new Generate nodes | `openrouter / google/gemini-3.1-flash-image` (Nano Banana 2): references plus text output, and catalog pricing present. If it is not available, use the first available model. Always shown in consent. |
| Q2 | Do you have an OpenRouter key for CI-1.10, or should direct Google be in CI-1? | Use OpenRouter in CI-1 and direct Google in CI-2. Pull Google forward only if OpenRouter is not an option for you. |
| Q3 | Caps | Concurrency default 2 and max 4; `count` ≤ 4 per node; **≤ 16 provider requests per run** in CI-1. Raise this with CI-3 batching. |
| Q4 | Cost estimate | Show "Estimate unavailable" in CI-1, because catalog token pricing does not model per-image pricing, and show the reported cost after each attempt. In CI-2, consider "last reported cost for this model" from local usage history. |
| Q5 | Where generated images live | userData asset store only in CI-1, with Download/Reveal in CI-2. No auto-export folder (the old branch's forced external folder and Finder sync are dropped). |
| Q6 | Aspect ratio | Leave it out of CI-1 and use prompt wording. Revisit only through a per-API `onPayload` adapter (OpenRouter `image_config`) if live use shows a need. |

## 4. Risks

| Risk | Mitigation |
|---|---|
| OpenRouter image output varies by model: interim images, text-only replies, missing usage | `parseGeneratedImages` validates the bytes; more than 4 images are truncated instead of failing a paid attempt; CI-1.10 records actual behavior |
| A key-less e2e profile conflicts with the fake OpenRouter key | The key is scoped to the images spec through a fixture option; existing specs keep `assertNoPersistedProviderCredentials` |
| `synchronous=NORMAL` loses the last transactions on an OS crash | Only history is affected; restart never resubmits, and the usage store holds the billing record |
| Hotspots (`main/index.ts` quit and reconcile, `usage-store-core.ts`, `preload-channels.ts` prefix) | Orchestrator registration commits, per umbrella §5 |
