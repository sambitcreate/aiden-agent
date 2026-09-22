# Create Images Phase 0 Architecture Decision

Status: GO; two fresh-context reviews completed and all validated findings fixed
Date: 2026-08-11
Aiden baseline: `c3d644485e543579bbf478bb1e7355ba6667ce65` plus the uncommitted Create Images planning artifacts
Node Banana reference: `5c0e0ae6150f29a6de819f8d6f1dedba15151f7c`

## Decision

Proceed with the non-network Create Images shell and canvas foundation using:

- exact `@xyflow/react@12.9.3` for the renderer canvas;
- Aiden-owned, dependency-light workflow schema, typed-port registry, graph validator, and deterministic scheduler;
- bounded JSON manifests built on Aiden's existing `DataStore` safety properties for workflow metadata;
- separate run journals and content-addressed binary assets in later phases;
- opaque, renderer-document-bound grants for an `aiden-asset` protocol rather than `file://`, absolute paths, remote URLs, or repeated full-image IPC;
- a fail-closed `AIDEN_CREATE_IMAGES_ENABLED=1` capability until release gates pass;
- Google's current Interactions API and a curated release-pinned image-model list for the future Gemini adapter;
- stateless image requests (`store: false`) for the MVP rather than provider-hosted `previous_interaction_id` chains.

This GO does not enable a user-facing route or issue a billable provider request. A real Gemini smoke test requires a user-supplied compatible API key, explicit cost/data consent, and the Phase 4 output-ingestion boundary. It is deliberately not performed during this architecture phase.

## Evidence

### Canvas dependency and Electron feasibility harness

Registry evidence for `@xyflow/react@12.9.3`:

- license: MIT;
- React peer range: `>=17`, compatible with Aiden's React 19;
- unpacked package size: 1,173,257 bytes;
- direct runtime dependencies: `@xyflow/system@0.0.73`, `classcat@5.0.5`, and `zustand@4.5.7`;
- the complete code-bearing installed runtime closure, including `use-sync-external-store` and the D3 drag/selection/zoom/transition descendants, uses MIT, ISC, or BSD-3-Clause licenses and is inventoried in `THIRD_PARTY_NOTICES.md`.

The Phase 0 harness bundles a custom-node React Flow surface in production mode, launches it in a context-isolated, sandboxed, Node-disabled Electron window at 1000×650, and measures 100/250-node initial render, 40 viewport updates, and 20 selection frames. Its stylesheet is external and CSP-compliant; it fails on CSP/renderer errors, wrong host dimensions, wrong graph population, no visible nodes, excessive long tasks, or threshold overruns. Command: `npm run test:create-images:canvas-spike`.

Measured on the development Mac:

| Fixture   | Edges | Initial render | Viewport avg. | Selection-frame avg. | Visible / graph nodes | Long tasks |      JS heap |
| --------- | ----: | -------------: | ------------: | -------------------: | --------------------: | ---------: | -----------: |
| 100 nodes |    99 |        80.5 ms |       1.25 ms |             16.77 ms |              28 / 100 |          0 |  5,721,133 B |
| 250 nodes |   249 |        65.9 ms |       2.51 ms |             16.67 ms |              49 / 250 |  1 / 92 ms | 20,172,885 B |

Observed heap growth between cases was 14,451,752 bytes, below the 64 MB feasibility ceiling. These measurements prove library feasibility, not finished or packaged UI performance. The plan was corrected after review so the real Aiden canvas owns the packaged interaction/accessibility gate in Phase 1 and the minimum-hardware production-package gate remains in Phase 5.

### Graph and execution kernel

Implemented contracts:

- `renderer/shared/create-images/schema.ts`: exact schema version, five-node MVP union, finite coordinates, bounded dense arrays/prompts/graphs/assets, asset-manifest reconciliation, no unknown fields, no inline media/paths/credentials, starter workflow.
- `renderer/shared/create-images/ports.ts`: stable semantic ports, media compatibility, cardinality, orphan/direction/duplicate/cycle checks, and run-readiness diagnostics.
- `renderer/shared/create-images/execution.ts`: schema-validated deep-frozen workflow snapshot, stable topological order, explicitly enumerated downstream paths, required-ancestor closure, run/workflow/revision/sequence identity, stale/out-of-order reduction, concurrency 1–4, discriminated settlement, failure blocking, immediate non-cooperative cancellation, stale-plan rejection, and late-completion suppression.

The focused suite covers schema failure, sparse/oversized arrays, credential fields, future versions, asset-manifest mismatch, port errors/cycles, incomplete drafts, stable scheduling, concurrency, independent branches, downstream blocking, empty rejection reasons, immutable snapshots, explicit paid paths, non-cooperative cancellation, transition identity/order, scoped runs, and late completion after cancellation.

### Workflow persistence

The Phase 0 `WorkflowManifestStore` uses `DataStore` with:

- an 8 MB metadata ceiling;
- strict database/document parsing;
- atomic staged publication and directory sync inherited from `DataStore`;
- corrupt-file and unsafe-future-schema write refusal;
- structured `healthy` / `corrupt` / `unsafe` load health so recovery never looks like an empty first run;
- exact revision compare-and-swap semantics;
- renderer-document liveness checked before publication;
- own-property lookup so valid IDs such as `constructor` cannot collide with `Object.prototype`;
- metadata-only summaries that do not expose prompts.

Decision: retain bounded JSON for workflow manifests rather than add SQLite now. Aiden already has unusually strong JSON publication/recovery behavior, the expected MVP workflow index fits comfortably inside the bound, and a native database would add packaging, migration, backup, and corruption surfaces before evidence requires it. Run history and asset metadata remain separate so this decision can be revisited without changing the graph schema. Phase 2 must load-test realistic workflow/run counts and reopen the decision if index latency, write amplification, or recovery evidence fails.

### Asset delivery

Decision: use a narrowly registered `aiden-asset` protocol backed by opaque, short-lived grants bound to the current renderer document and an internal asset ID. The Phase 0 registry proves:

- tokens reveal neither document nor asset ID;
- another document cannot resolve or revoke the token;
- the actual `processId:routingId:frameToken` owner contract is accepted and checked live;
- asset authorization is checked at mint and resolve;
- expiry, explicit revocation, and automatic invalidation revocation;
- bounded registry capacity with oldest-grant eviction.

Phase 2 must add protocol registration before readiness, exact requesting-frame validation, range/cache semantics if necessary, CSP scoping, MIME/size enforcement, and tests against navigation/reload/destruction. Bounded `Uint8Array` IPC remains acceptable only for picker ingestion or a selected small preview; it is not the gallery transport.

### Provider API and credential boundary

Google's current [image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) documents the Interactions endpoint, current model IDs, reference images, response format, and rights requirements. The [Interactions API reference](https://ai.google.dev/api/interactions-api) documents durable/terminal states and its request/response contract. The earlier GenerateContent image API is now explicitly labeled legacy.

The Phase 0 contract therefore:

- fixes the origin to `https://generativelanguage.googleapis.com/v1beta/interactions`;
- allows only `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, and `gemini-3-pro-image` for this release snapshot;
- sends text and bounded Aiden-owned reference bytes only;
- sends no key, auth header, remote URL, absolute path, safety override, search tool, or provider conversation ID in the renderer-owned intent;
- requests one output because the current normalized adapter has not yet proven multi-output behavior;
- sets `store: false` and `background: false` for the stateless first slice;
- preserves the provider's default safety behavior.

Phase 4 must resolve credentials with main-owned provider authority, verify API-key auth separately from OAuth, pin the directly used SDK or implement a fully bounded REST response parser, stage/validate the response before publishing success, and repeat the current-model contract check at implementation time.

## Dependency and audit disposition

`npm audit` reports three existing toolchain findings after install:

- `esbuild` low severity through Aiden's direct dev dependency;
- `js-yaml` high severity through ESLint/electron-builder/electron-updater;
- `nanoid` high severity through Vite/PostCSS.

`npm explain` shows none is introduced by the React Flow subtree. Do not apply `npm audit fix --force`; its suggested esbuild resolution is semver-major and unrelated to the canvas decision. Track these through the repository's ordinary dependency update work. `THIRD_PARTY_NOTICES.md` now includes the complete code-bearing React Flow runtime closure, and a focused contract test resolves the installed closure, pins every expected identity/license, and verifies notice/copyright coverage plus packaged-file configuration. Phase 5 still inspects the built artifact/SBOM rather than treating source configuration as final distribution proof.

Node Banana remains a behavioral reference only. No upstream source, assets, templates, branding, or AGPL background-removal dependency were copied.

## Phase 0 gates

| Gate                                                    | Result                                  |
| ------------------------------------------------------- | --------------------------------------- |
| Exact canvas dependency/license/peer review             | Pass                                    |
| 100/250-node sandboxed Electron feasibility measurement | Pass                                    |
| Strict graph schema and typed-port validation           | Pass                                    |
| Deterministic bounded scheduler                         | Pass                                    |
| Failure, cancellation, and late-result behavior         | Pass                                    |
| Atomic revision-checked metadata persistence            | Pass                                    |
| Corrupt/future-schema health and write refusal          | Pass                                    |
| Opaque live-owner/authorization-bound asset-grant core  | Pass                                    |
| Current Gemini request/model contract researched        | Pass                                    |
| Real paid provider generation                           | Assigned to explicit Phase 4 acceptance |
| Two fresh-context reviews and fixes                     | Pass                                    |

## Fresh-context review outcome

Two agents received no conversation history and independently reviewed the frozen Phase 0 target.

| Review                                        | Initial result | Validated findings fixed                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph, scheduler, and persistence correctness | NO-GO          | Non-cooperative cancel hang; rejection-without-reason success; missing run identity/reducer; mutable execution snapshot; implicit downstream fan-out; renderer-owner ID mismatch; corrupt/future-as-empty reads; sparse arrays; prototype-key IDs; node/manifest asset mismatch. |
| Security, provider, dependency, and benchmark | NO-GO          | Phase gate mismatch; CSP-invalid/under-asserted harness; immutable snapshot and rejection defects; grant authorization/liveness; missing runtime notices. No provider endpoint/model/request-shape defect was found.                                                             |

The plan now assigns live-provider, real-asset, journal-crash, packaged-performance, and final-distribution evidence to the phases that implement those boundaries. This is a sequencing correction, not a waiver: every deferred item remains a blocking exit in the plan. After repairs, the focused suite contains 30 passing tests (29 TypeScript contract cases plus the notice/package contract), and type-check, lint, production build, canvas harness, scoped React Doctor, and whitespace checks pass.

## Conditions on Phase 1

Phase 1 may implement only the default-off, fixture-backed canvas shell. The feature must not register storage, protocol, provider, or IPC side effects during that phase. Its exit requires the real Aiden node components and shell to pass the packaged canvas/accessibility gate before Phase 2 starts.
