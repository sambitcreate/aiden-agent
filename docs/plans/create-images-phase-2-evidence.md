# Create Images Phase 2 Evidence

Status: **GO** — both fresh-context reviewers independently approve the source, frozen signed artifact, durable attestation, and exact evidence
Date: 2026-08-11
Feature gate: `AIDEN_CREATE_IMAGES_ENABLED=1`

## Implemented durability surface

- Main-owned workflow CRUD with strict opaque IDs, compare-and-swap revisions, bounded autosave, crash-survived journals, explicit conflict/recovery states, last-known-good manifests, deterministic recovery diagnostics, renderer-document liveness checks, and idempotent restart reconciliation after current-manifest publication.
- Opening a workflow restores its persisted viewport without publishing a write. Graph edits, viewport changes, rename, duplicate, delete, recovery, repair, and autosave use the same revision contract.
- Workflow inventory fails closed on unknown files, invalid IDs, symlinks, corrupt/future schemas, empty failed-publication ghosts, and bounded-scan overflow. Preflight quotas cap active workflows at 1,000 and aggregate manifest bytes at 512 MiB; deleted-workflow quarantine is isolated and capped at 32 entries and 128 MiB.
- Content-addressed PNG/JPEG storage with SHA-256 IDs, deduplication, descriptor-bounded reads, structural validation, mandatory deep decode, 16 MP decoded-pixel limit, 64 MiB compressed-image limit, 100,000-asset limit, 10 GiB total budget, and an 8 GiB warning threshold.
- Image decode and thumbnail generation run in a disposable hidden renderer with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `default-src 'none'`. No untrusted codec runs through `nativeImage` in the privileged main process.
- Opaque `aiden-asset://` grants are exact-document, main-frame, GET/image-only, expiring, one-use-authorized, path-free, and coupled to asset-store preview leases so GC cannot delete an open preview.
- Visible-node preview lifecycle uses per-asset single-flight loading, four-request concurrency, mount reference counts, pre-expiry renewal, delivery-error exponential backoff reset only by an exact-token image load, atomic token swap/revoke, virtualization remount recovery, same-digest adoption handoff, and immediate pruning on asset replacement/removal.
- Reference accounting covers workflow, run, export, and preview authorities under one snapshot lock. Asset GC supports race-checked dry runs/apply, grace periods, preview leases, and repair/index rebuild without exposing filesystem paths to the renderer.
- Renderer-owned mutations are limited to 120 operations per main document per 60 seconds. The production main renderer is deny-by-default for remote HTTP(S)/WS(S) egress; development permits only loopback transport. Other Aiden windows keep their own policy.
- Missing referenced assets remain editable and receive per-node, library, and storage diagnostics. Re-importing the exact original safely republishes only an absent content-addressed source; an existing corrupt source remains repair-only.
- Image Input controls have node-qualified accessible names, deterministic focus restoration, preview error recovery, and immediate grant cleanup.
- Native `.aiden-images` archive contracts independently preflight the sole bounded manifest before member reads, cap assets at the same 10 GiB aggregate as local storage plus workflow/manifest envelope, and reject traversal, links, duplicates, encryption, unsupported compression, credential/executable smuggling, size/CRC/digest mismatches, declared/actual byte differences, or disagreement between workflow references, manifest descriptors, and deeply validated assets.

The Phase 2 archive work is the versioned format and hostile-input contract. The product importer/exporter, download/reveal UI, and workflow deletion/GC experience remain in Phase 5 exactly as scheduled by the main plan. Phase 3 owns run journals; no provider execution is enabled in this phase.

## Device-local layout and limits

The main process owns `<userData>/create-images`:

```text
create-images/
  index.json
  asset-index.json
  workflows/<workflow-id>/
    workflow.json
    workflow.last-known-good.json
    autosave.journal              # present only while pending/recoverable
  assets/sha256/<prefix>/<sha256>.<png|jpg>
  thumbnails/<sha256>/<size>.png
  asset-quarantine/
  quarantine/                    # workflow recovery evidence
    deleted-workflows/           # separately bounded recoverable deletes
```

Workflow documents contain metadata and opaque asset IDs only—never base64 image data or absolute paths. Schema, renderer IPC, manifest persistence, and native archive workflow entries share an 8 MiB document ceiling. Preview grants default to 60 seconds, the registry is capped at 4,096 live grants, and visible preview acquisition is capped at four concurrent requests.

## Large-image decoder gate

`scripts/create-images-native-image.test.mjs` exercises the packaged decoder boundary with a deterministic static 4,000 × 4,000 PNG larger than 20 MiB. The final frozen-source run decoded and thumbnailed it in 2,103.30 ms while main-process private-memory growth was 81,312 KiB, below the 96 MiB gate. The test also verifies the sandboxed renderer boundary and fails on structured/legacy Electron console errors or CSP violations.

## Signed packaged-app acceptance

`npm run test:create-images:packaged` launches the signed development `.app` from ASAR with the real preload, CSP, installed production request policy, feature gate, workflow store, asset store, decoder utility, and custom protocol. The harness observes the installed request policy; it never replaces or clears the production `webRequest` listener.

Final receipt:

- 100-node route; graph history `100 → 101 → 102 → 101 → 102`, native edge/node Delete/Undo/Redo, keyboard connection, pointer reconnection, invalid-drop explanations, keyboard move/undo, modal focus, and responsive 1280/1000/700/390 px checks all passed;
- 39 native keyboard actions and 38 live-region mutations;
- 0 renderer errors, 0 unrelated remote requests, and 0 unrelated Aiden product-file mutations;
- hostile main-renderer egress probe: 1 request observed, 1 blocked by the installed production policy;
- asset protocol: 1 live grant, 2 image requests, 2 real authorizations, exact live main-frame evidence;
- durable prompt edit published as workflow revision 2, survived renderer reload, and kept graph JSON path-free and base64-free;
- exact 9-file Phase 2 mutation set: current workflow, identical last-known-good workflow, workflow index, asset index, three content-addressed protected asset-index predecessors, one content-addressed source image, and one 512 px thumbnail;
- source asset: 21,033,819 bytes, 4,000 × 4,000, SHA-256/asset ID `6ebf7cf212ab0f1c7a6c48f8599796527a3d3c09d45e39c18c17f51b62db39d3`;
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
- 14,006.821291 ms duration and clean bounded exit.

The durable attestation is `build/create-images-packaged-acceptance/attestation.json` and binds the receipt to:

- source HEAD `c3d644485e543579bbf478bb1e7355ba6667ce65`;
- embedded/current package-input fingerprint `808461b34da3f44839d8151b4578c61b23469f6d5c23fe8285f5713e50aabe25`;
- ASAR SHA-256 `6381631c33556e6f82e7283105bfd8c0235bd0f08e6acbacc54edf43c5c9a798`;
- code-signature CDHash `6dda105ac132c810a3da1e526c4815e3e64bc675`;
- bundle identifier/version `com.sambitcreate.aiden-agent` / `0.28.0`.

The package fingerprint is captured before compilation, verified after compilation, embedded in ASAR, and compared before and after acceptance. It truthfully binds repository package inputs to this development artifact. A clean isolated install, installed dependency/toolchain closure, SBOM, notarized `npm run dist`, and update-from-prior-release evidence remain Phase 5 release gates; this Phase 2 document does not claim them.

## Canvas and storage verification

- `npm run test:create-images`: **150/150** (7 pretests, 131 TypeScript cases, 12 Node/script cases).
- `npm run type-check`: pass.
- `npm run lint`: pass.
- `git diff --check`: pass.
- `npm run build`: pass with schema/fixtures/feature CSS behind the lazy route and acceptance automation behind a separate main-process dynamic chunk.
- `npm run package`, `npm run package:verify`, and post-package fingerprint verification: pass.
- `npm run test:create-images:packaged`: pass against the exact signed artifact above.
- `npm run test:create-images:canvas-product`: pass. The 100-node fixture rendered in 99.20 ms with 1.245 ms average viewport operations, 2/100 DOM nodes, 0 long tasks, and 10,496,724 B JS heap. The 250-node fixture rendered in 116.20 ms with 1.2475 ms average viewport operations, 2/250 DOM nodes, one 55 ms long task, and 36,482,499 B JS heap. Heap growth was 25,985,775 B; both measured eight visible nodes with zero overlaps and a bounded scrollable 32K prompt editor.
- `npm run test:create-images:canvas-spike`: pass for 100/250 nodes; heap growth was 14,432,364 B and selection cadence stayed frame-bounded.
- Scoped React Doctor found no new Create Images-specific correctness diagnostic; its changed-scope detection fell back to the repository scan because the feature files are untracked in the current worktree.

## Review repairs already incorporated

The first two Phase 2 fresh-context reviews found and the implementation repaired: hidden crash journals, an impossible Delete parser, expiring previews without renewal, protocol grants disconnected from GC leases, unsafe inventory completeness, misleading recovery actions, unqualified Image Input labels/focus loss, unbounded workflow/quarantine growth, unbounded descriptor reads, privileged codec execution, permissive renderer egress, and weak packaged file/protocol evidence.

The two final fresh-context reviews additionally repaired aggregate storage bypasses, durable reference races, archive bootstrap/cross-contract gaps, workflow/IPC/archive ceiling drift, read-only-open canonicalization, refetch-driven CAS overwrite, close-guard ownership, directory fsync and quarantine isolation, missing-source diagnostics/re-import, preview adoption and delivery retry leaks, empty failed-create ghosts, and idempotent exact-journal restart cleanup. Both reviewers independently give unconditional Phase 2 GO after no-launch verification of the exact signed artifact, attestation, and this evidence.
