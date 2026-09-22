# Create Images Phase 5 Evidence

Status: **IMPLEMENTATION COMPLETE; POST-ACCEPTANCE SOURCE POLISH VERIFIED; FRESH PACKAGE AND DISTRIBUTION GATES PENDING** — the MVP completion surface passed source, product-canvas, signed development-package, and isolated packaged acceptance. The later image-import/preview polish below changes package inputs, so that signed development artifact is retained as historical evidence and is no longer an attestation of the current source. A fresh signed package, notarized distribution, update-from-prior-release, and migration acceptance have not been run.
Date: 2026-08-19
Feature gate: `AIDEN_CREATE_IMAGES_ENABLED=1`

## Shipped MVP completion surface

- Four device-local starter choices ship: blank, starter, reference-led edit, and variant set. Every template creates fresh workflow/node/edge IDs and passes the strict graph schema.
- Native `.aiden-images` export is main-owned and revision-bound. It stages verified referenced assets under a private directory, writes a versioned stored ZIP to a native-dialog destination, fsyncs before atomic publication, and never returns a path to the renderer.
- Native import treats the archive as hostile. It performs a manifest-independent central-directory bootstrap, rejects unsafe paths/kinds, duplicate names, encryption, unsupported compression, entry/count/size/compression bombs, CRC/SHA/declared-size mismatches, and validates the exact workflow/asset/media/dimension relationship before publishing. Import never connects a provider, executes a workflow, or fetches a URL.
- The Node Banana v1 JSON compatibility importer is a clean Aiden-native conversion, not vendored Node Banana code. It maps only the supported image subset, regenerates all identities, validates a bounded acyclic graph, externalizes safe inline static images through Aiden's sandboxed image pipeline, strips credentials/settings/paths/runtime output, and presents an explicit per-node rewrite/skip report before navigation.
- Retained run outputs can be saved through a native dialog only after both run-journal and reference-authority checks. Asset bytes remain path-free over IPC and are reverified immediately before export.
- Asset cleanup is a two-step, main-owned plan/apply flow with a seven-day grace period. The confirmation exposes only verified counts/bytes; apply rechecks workflow/run/export/preview references and rejects stale plans.
- Workflow deletion remains admission-fenced and refuses deletion while any active, retained, ambiguous, recovery, unsafe, or unassociated run authority exists.
- The workflow library includes accessible first-run template/import actions. Narrow canvas layouts retain the actionable validation-issues trigger; reduced-motion, forced-colors, keyboard, focus-restoration, and non-spatial controls remain covered.
- Create Images is advertised in the final onboarding bento gallery with its own optimized 1024 × 1024 transparent PNG.
- Aiden has no approved product telemetry pipeline for this surface, so Phase 5 ships without feature telemetry rather than introducing a new content or operational reporting path.

## Post-acceptance image import and canvas polish

- First entry now stops at an accessible, path-free setup surface until the user chooses an image workspace through Electron's main-owned native directory picker. Aiden keeps workflow/run manifests and canonical content-addressed assets protected internally, then publishes non-overwriting Finder-visible mirrors under `Imports/` and `Generated/`. The root is marker- and filesystem-identity-bound, symlinks and replacement roots fail closed, ordinary status IPC never exposes an absolute path, and imports/provider runs are disabled until the configured root is writable.
- The workflow library exposes explicit **Open in Finder**, **Sync images**, and **Change folder** actions with retry/unavailable states. Asset publication notifies the mirror only after the canonical CAS commit and outside its mutation lock; a mirror failure never weakens canonical durability, but subsequent preflight blocks new runs until the folder is reconnected.
- Clipboard image paste now matches Node Banana's useful canvas interaction without copying its renderer/base64 storage model. Pasting outside editable controls replaces a selected Image Input or creates a centered, collision-aware Image Input node. Electron main reads and bounds the clipboard image, emits a canonical PNG into the same hostile-image ingest path, and returns only opaque asset metadata.
- The populated Image Input is now an image-first compact canvas node: the imported image is full-bleed but `object-fit: contain`, its natural aspect is bounded, and Replace/Remove controls appear on hover or keyboard focus. It keeps Aiden's typed React Flow port and opaque main-owned asset identity without retaining Node Banana's surrounding generic card or renderer/base64 storage model.
- Create Images canvas surfaces, nodes, edges, selection rings, overlays, empty states, and control panels use Aiden semantic appearance tokens. Live isolated Electron QA covered both Aiden Light and Aiden Dark with a 1800 × 1800 WebP and a 2548 × 3300 TIFF; both rendered as compact image-only references and remained completely visible in either theme.
- Native canvas drop and chooser import accept bounded static raster inputs even when macOS supplies an empty or generic MIME type. Canonical PNG/JPEG remain byte-exact. Static WebP, AVIF, BMP, ICO, TIFF/HEIF-family inputs, and single-frame GIF normalize to a canonical PNG when they are supported by either Electron's disposable sandboxed decoder or the bounded macOS ImageIO fallback. The fallback copies bounded bytes into a private temporary directory, invokes fixed `/usr/bin/sips` arguments without a shell, enforces a 20-second timeout and output limit, then fully revalidates PNG dimensions and pixels before ingest. Animated GIF/WebP/HEIF, SVG/vector, malformed, oversized, over-dimension, and magic/extension-mismatched inputs still fail closed.
- Preview delivery remains opaque and main-authorized. A missing/unsupported thumbnail may fall back to a freshly validated canonical source under a short internal lease; grant requests have a bounded timeout/retry path, late tokens are revoked, and image delivery only resets backoff after the exact `<img>` reports success.
- Preview-manager disposal is deferred by one task and cancelled when React development Strict Mode replays effect cleanup/setup. This fixes the live-only state where import succeeded durably but the reused manager stayed permanently disposed and the node remained on “Loading preview…”. Actual unmount still disposes and revokes.
- Generated images, retained Output images, and imported references now open in one full-screen inspector modeled on Node Banana's direct click-to-expand behavior but completed to Aiden's interaction and security standards. The Radix surface starts at a useful fitted size and adds bounded 5%–800% zoom, pointer-anchored wheel zoom, drag/arrow-key pan, Fit/1:1 controls, Escape dismissal, reduced motion, forced colors, and exact trigger-focus restoration. Canvas cards continue loading bounded 512px thumbnails; the inspector asks for the fully validated source through an exact `/original` rendition of the same opaque, expiring, document-bound asset grant. Live isolated Electron QA confirmed the retained Gemini result had a 1024 × 1024 natural source, not the 512px thumbnail.

## Dependency and provenance evidence

- `yauzl@3.4.0` and `yazl@3.3.1` are exact runtime pins; `@types/yauzl@3.4.0` and `@types/yazl@3.3.1` are exact development pins.
- `THIRD_PARTY_NOTICES.md` contains the complete direct ZIP runtime closure (`yauzl`, `yazl`, `pend`, and `buffer-crc32`), and the registered notice test verifies exact versions, licenses, and notice text.
- The selected yauzl release is newer than the `3.2.1` fix for [CVE-2026-31988](https://github.com/advisories/GHSA-2c72-c9vx-76g4). Both libraries use streaming ZIP APIs and ZIP64 support documented by their upstream projects: [yauzl](https://github.com/thejoshwolfe/yauzl) and [yazl](https://github.com/thejoshwolfe/yazl).
- The Node Banana implementation remains a clean compatibility layer based on the plan's pinned MIT research reference. No upstream branding, assets, prompts, application source, or renderer/base64 storage architecture is included.

## Source and product verification

- `npm run test:create-images`: pass after the workspace/clipboard/import/lightbox polish — 9 pretests, 443 functional assertions, 2 durability/performance tests, and 15 Node/script checks.
- Phase 5 coverage includes native round-trip, duplicate-manifest and invalid-ZIP refusal before publication, exact private asset export, four template graphs, supported/unsupported Node Banana conversion and real inline-image externalization, path/credential/base64 stripping, two-step cleanup IPC, retained-output authorization, and exact notice closure.
- 500-node successful journal: 1,502 durable events, 635,757-byte current log, 111.87 s append, 196 ms cold replay.
- 1,000 output-rich terminal journals × 250 asset IDs: 4.83 s restart, 4.68 s authoritative admission audit, 21.63 s modeled product path, 78 ms retention lookup, 355,073-byte derived index, bounded caches.
- `npm run test:onboarding`: pass — 14/14, including the 23-tile gallery and one-megapixel alpha-PNG contract. The Create Images tile was regenerated against the existing `aiden-assistant.png` and `attachments-vision.png` illustrations, then verified as a 1024 × 1024 RGBA PNG with genuine transparency.
- `npm run test:create-images:canvas-product`: pass after updating the stress-row spacing for the full capability-driven Generate Image card. Both 100- and 250-node cases reported zero visible overlaps, exact 1000 × 650 hosts, visible-node culling, bounded prompt editors, edit/announcement correctness, and 8,674,258-byte heap growth. Average viewport operations were 1.245 ms and 1.248 ms.
- `npm run type-check`: pass.
- `npm run lint`: pass.
- `git diff --check`: pass.
- `npm run build`: pass after the workspace/clipboard/import/lightbox polish. The lazy Create Images route is 399.38 kB JS / 116.48 kB gzip and 62.77 kB CSS / 9.29 kB gzip; the lazy-boundary verifier passed. Electron's main build keeps the macOS converter in a separate on-demand chunk, so ordinary PNG/JPEG and browser-decodable imports do not load it.
- React Doctor was run after the React work. Its current changed-branch scan covered 154 files (63/100, 127 broad existing diagnostics); it reported no lightbox-specific component, accessibility, or security diagnostic.

## Development-signed packaged acceptance

The acceptance was refreshed on 2026-08-21 after the Node Banana follow-on implementation and is bound to the exact current package inputs. Project evidence files are excluded from the source fingerprint, so recording these results does not stale the artifact.

- `npm run package`, `npm run package:verify`, and `npm run package:fingerprint:verify`: pass.
- Exact source fingerprint: `eee98a151e1836eb7ca6158bccdf54aff5e9ed36c89ddc410d5c44cbb6252d44`.
- App identity: bundle `com.sambitcreate.aiden-agent`, version `0.28.0`, Developer ID signature CDHash `a9fc3b6a6259137ee2200ce274769b5b26d9dbf5`.
- ASAR SHA-256: `76ef235d071c6a63e848d7da16ede469ddc616d4e0c6896d2f1e300b0594479f`.
- `npm run test:create-images:packaged`: pass in an isolated private profile in 14,440.26425 ms.
- The packaged receipt records 39 keyboard actions, 38 live-region mutations, narrow validation/add placement, reduced motion, focus restoration, spatial/keyboard connection editing, durable reload, one blocked egress probe, 0 remote requests, 0 renderer errors, sandboxing, context isolation, and `nodeIntegration: false`.
- Asset delivery recorded one opaque grant, two image requests, and two exact authorizations from a live main frame.
- Acceptance configures a private disposable external image workspace through the real main-owned picker result path before service initialization. Durable evidence is an exact 12-file set: workspace record and validated predecessor, current/LKG workflow, workflow index, unchanged empty run index, asset index, three protected asset-index predecessors, one 21,033,819-byte 4000 × 4000 content-addressed PNG, and its 512px thumbnail. No autosave journal, run journal, quarantine file, unrelated asset, or arbitrary product mutation was present.
- Durable attestation: `build/create-images-packaged-acceptance/attestation.json` (mode and identity are revalidated by the acceptance script).

## Deliberately open release gates

This evidence is sufficient to continue implementation work, but it is not a Phase 5 distribution GO. The following plan gates remain explicit:

1. run `npm run dist` for the final release candidate and verify its notarized distribution identity/artifacts;
2. install over the prior supported Aiden release and verify the updater path, preserved device-local workflows/runs/assets, and no automatic provider execution;
3. run clean-install plus populated-storage migration/recovery acceptance on the final distribution;
4. complete the separately tracked Phase 4 opt-in real-key Gemini text-to-image and reference-image acceptance only after the user explicitly authorizes potentially billable provider requests.

No live Gemini request, provider charge, notarization, updater publication, or production installation was triggered by this evidence run.
