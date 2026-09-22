# Form Fill Specialist (CUA-S1-FORMS + Core ML)

Status: Implemented — PR #195 remediation and automated macOS model verification complete; CI review, physical iOS parity, and signed live-window acceptance remain pending.

## Goal

A narrow, opt-in specialist layered on top of Aiden's existing Computer Use
architecture — **not** a replacement computer-use agent. When Computer Use is
enabled, the specialist model is downloaded and ready, and the user explicitly
asks to fill a form from a selected local document, Aiden:

1. Extracts explicit `Label: value` entities from that exact user-selected
   document.
2. Binds one exact target window and observes its form controls through the
   existing brokered `cua-driver` AX/SOM path.
3. Runs the CUA-S1-FORMS scorer on-device (Core ML) over only the supplied
   entities plus fixed action options (`check`, `click`, `skip`).
4. Produces a bounded, source-provenanced fill plan.
5. Shows one review card enumerating every proposed mutation.
6. One batch approval authorizes only that exact immutable plan.
7. Executes through `ComputerUseController` and the brokered driver.
8. Re-observes and verifies the window after every mutation.
9. Stops immediately on drift, ambiguity, cancellation, or an unconfirmed
   effect.
10. Never submits in the initial fill batch; submission requires a separate
    approval after the fill results are visible.

With the specialist disabled, missing, unsupported, or not explicitly invoked,
ordinary Computer Use behaves exactly as it does today.

## Pinned external references

All revisions are immutable content addresses — never mutable `main`:

| Artifact | Location | Pinned revision |
| --- | --- | --- |
| CUA-S1-FORMS model card / weights | `huggingface.co/cua-ai/cua-s1-forms` | `f54adbf447f4ca6ec259f529ee3f2e3e09f8cc71` |
| Core ML conversion (FP16 `.mlpackage`) | `huggingface.co/FluidInference/cua-s1-forms-coreml` | `ca2113d260559ee5d2d6463900e39916936aca65` |
| Upstream planner / schema (Python) | `github.com/trycua/cua` `libs/cua-s1` | `b7f7e2d8714609853a29c7d049140bc46aec0954` |
| FluidAudio Swift reference | `github.com/FluidInference/FluidAudio` `Sources/FluidAudio/Decision/CuaS1Forms` | `87a39dfe4068fef0f1c69bfe704b2b3ef4fbc5bc` |
| Golden demo set (196 rows) | `huggingface.co/datasets/cua-ai/cua-s1-forms` `demo.jsonl` | `8273f34778b99ac2e12d9f6e7d57dad99ae20845`, SHA-256 `4f43b442e79ba2e2ce731e27e9b8e340c2b5dfcaffc92d8ff564c34f115ff1ca` |

The conversion's `assets.lock.json` (SHA-256
`8e65ad70af6bb814b571cdcfe828ba4bc339147da2d2211cbeac416163ef18ba`) records the
upstream source revision `83f142c4290a0f7d9ed545ae8532858c6e4f8145`.

### Shipped artifact manifest (FP16 portable package only)

Repository `FluidInference/cua-s1-forms-coreml` @ `ca2113d2…`. The specialist
downloads exactly these files — nothing else:

| Path | SHA-256 |
| --- | --- |
| `cua_s1_forms_fp16_options32.mlpackage/Data/com.apple.CoreML/model.mlmodel` | `70485fc18cbb21785df833cbddddc0b5b59acb00d22394b76e55307e2c135dd0` |
| `cua_s1_forms_fp16_options32.mlpackage/Data/com.apple.CoreML/weights/weight.bin` | `4da9259f798e44f5a1b50769ee1916fd3747c4d723dd9997b516c7fe238c7895` |
| `cua_s1_forms_fp16_options32.mlpackage/Manifest.json` | `2bc0f5f62337b27fb6b0ecde248f1e3dc269e1ba4b65516aaeede2a60e293dcc` |
| `LICENSE` | `c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9` |
| `NOTICES.md` | `027c72741eaa695e60d7b6cebd3666372c81d443a96b673b72a897cf432ddfd0` |
| `UPSTREAM-THIRD-PARTY-NOTICES.md` | `4091e69b45c8cc97e30a066fbbd56148dbef66ab716432c048d2333c9c464213` |

INT4/INT8 variants and the `ane-gather/` variant are intentionally not
downloaded. Total package size is ~1.5 MB; the installer enforces a byte and
file-count bound anyway (defense in depth, not capacity planning).

## Architecture

```
renderer ── settings row + review card + progress/result card
    │ IPC (main-owned, owner-fenced)
main ── form-fill/
        ├─ artifacts.ts      download → verify(SHA-256 manifest) → stage → atomic publish
        ├─ helper.ts         versioned newline-JSON protocol client to native helper
        ├─ extract.ts        bounded Label: value extraction, provenance
        ├─ planner.ts        pure-TS port of upstream context/option format + decode
        ├─ batch.ts          immutable plan + one-use digest + execution loop
        └─ ipc handlers      status / download / cancel / remove / plan-progress
    │ executes via
main ── computer-use/ComputerUseController (unchanged public surface)
    │ authenticated broker/bridge, audit-token auth, per-generation sessions
native/cua-s1-forms ── thin Swift helper (Foundation + CoreML only)
        ├─ AidenCuaS1FormsCore    ported Apache-2.0 input/output/validation code
        └─ AidenCuaS1FormsHelper  bounded protocol executable
```

### Runtime choice

A thin `native/cua-s1-forms` Swift package rather than a FluidAudio dependency.
Rationale: FluidAudio's package compiles broad audio targets and vendored
dependencies we do not need; the useful surface is Apache-2.0-licensed
input preparation, tensor validation, and stable softmax. We port that code
(with attribution in `THIRD_PARTY_NOTICES.md`) into `AidenCuaS1FormsCore` and
wrap it in a versioned file-based protocol identical in shape to
`native/apple-foundation-models` (which we do **not** extend — it targets
macOS 26 and has a separate responsibility).

- macOS 14.4+ Apple Silicon only (same floor as Computer Use).
- The helper never downloads anything; it loads an already-installed
  `.mlpackage` or compiled `.mlmodelc` path supplied by Electron main.
- Inputs: `context_ids` int32 `[1,224]`, `option_ids` int32 `[1,32,96]`,
  `option_mask` int32 `[1,32]`; outputs `logits`/`probabilities` float32 `[1,32]`.
  The helper validates exact names, shapes, and dtypes before first inference
  and rejects malformed output (NaN/Inf, non-`[1,32]` shape, probability mass
  on padding) — fail closed.
- 2–32 non-empty options; overflow is rejected, never dropped or split.
- UTF-8 byte encoding with `+1` offset, zero padding, context truncated at 224
  bytes, each option at 96 bytes — identical to upstream `preprocessing.py` and
  FluidAudio `CuaS1FormsInput`. Truncation flags are returned to the planner.
- The model stays warm inside the helper process for the bounded operation;
  cancellation and clean shutdown are part of the protocol.
- Keep-warm + crash/restart policy: the main-process client supervises the
  child, restarts it once per generation, and fails closed on repeated crash.

### Model artifact lifecycle (Aiden-owned, default OFF)

Mirrors the Parakeet lifecycle (`main/services/local-models.ts`) but fixes its
weakness: the manifest is a complete SHA-256 map, not filename presence.

- Setting `formFillSpecialistEnabled`, default `false`. Enabling alone does not
  download — the user presses **Download** in Settings → Computer Use (or the
  row's Download action on the setting itself).
- Download only on explicit user action; never at startup, never in background
  polling, never from `computerUse:status` reads.
- Files stream to `userData/form-fill-models/.staging-<ts>/`; each file is
  hashed as it lands; unexpected paths, symlinks, extra files, missing files,
  or hash mismatches reject the whole staging dir.
- Verified staging is renamed atomically to
  `userData/form-fill-models/<packageId>/`. A working model is never replaced
  by a partial/invalid download.
- First use compiles the `.mlpackage` once (via the helper's `prepare`
  request); the compiled artifact is cached under
  a separate revision-scoped sibling cache, rebuilt from verified source once
  per runtime and shared through one cancellable preparation promise.
- Status states surfaced to the renderer: `not_downloaded`, `downloading`
  (bounded progress), `preparing`, `ready`, `update_required`, `error`
  (with retry), `unsupported`. Cancel and Remove are user actions through
  main-owned IPC; all are owner-fenced to the calling renderer document.
- No network contact on startup or on ordinary Computer Use reads.

### Document provenance contract

The only source is the exact attachment the user selected in the active
renderer document.

- The model-facing tool accepts only `attachmentId` + the bound window target —
  it never accepts entity lists, values, or document text from the LLM.
  Electron main resolves `attachmentId` against the exact chat, message, and
  generation, and re-hashes the attachment bytes at plan time.
- Each extracted entity records: `attachmentId`, content `sha256`, original
  `label`, original `value`, `line` (1-based), and `derived` (`false` in v1 —
  no derivation policy exists yet).
- v1 sources: bounded UTF-8 `.txt`/`.md` containing explicit `Label: value`
  lines. Binary content, truncated attachment text (`Attachment.text` carries
  a truncation flag at 100k chars), empty labels/values, values over the byte
  limit, and conflicting duplicate labels are rejected before planning.
- Empty extraction fails closed — the tool reports a clear error and no plan
  is created.
- **Option-overflow policy:** the scorer admits 32 options; 3 are reserved for
  `check`/`click`/`skip`, so at most **29** source entities per fill plan.
  Exceeding 29 fails closed with an explanatory error — entities are never
  silently truncated, split across softmaxes, or re-scored in partitions.

### Planner contract (pure TypeScript)

`main/services/form-fill/planner.ts` has no Core ML, AX, or I/O dependency —
unit tests drive it with a stub scorer.

- Context format (byte-exact port of upstream `render_context`):
  `TASK fill the form from the document, then submit\nFORM {title}\nELEMENT
  {role} "{label}" {state}[ hint="{placeholder}"]` with title ≤64 bytes,
  label ≤72 bytes, value state `value="{≤48 bytes}"` or
  `checked/unchecked` for checkbox roles, placeholder hint ≤72 bytes.
- Options: `fill {label}: {value}` per entity, then `check`, `click`, `skip`.
- One fill option per supplied entity; decode accepts only indices in
  `[0, entities + 3)`; entity pointer preserved for provenance.
- Actionable AX roles normalized to upstream's set:
  `button, checkbox, combobox, edit, textfield` (+ `ax` prefixes).
- Per-element outcome: `fill` (with entity), `needs_review`, or `skip`
  (left untouched). Deterministic order: fills first, then checks, then
  clicks — matching upstream `ACTION_ORDER`, ties broken by element index.
- `needs_review` triggers (any one): `skip` wins; top probability below the
  evaluated threshold; top-two margin below the evaluated margin; context or
  chosen option materially truncated; unsupported role/action; ambiguous or
  duplicate entity; element already populated with a different value;
  unsupported check/click attempt.
- Thresholds are constants in the planner, evaluated against fixtures before
  enabling; the model's probabilities are **not** presented to the user as
  confidence percentages.
- No invented/transformed/concatenated values; no executable mutation for
  anything outside the validated source set; no submit ever.
- No automatic LLM fallback: unresolved fields are left untouched and the
  result card offers a separate "Continue with standard Computer Use" path
  (ordinary per-action approvals).

### Checkbox policy (v1)

`check` is planned only when the observed element has a known checkbox role,
a known boolean checked state, and the plan execution re-verifies the
postcondition. Unknown state, already-checked, and consent/terms/legal/opt-in
labels route to `needs_review` — never toggled.

### Batch authorization contract

One approval authorizes one immutable plan. The contract is owned by Electron
main; the renderer only displays and approves/rejects it.

A `FormFillBatchPlan` binds: `version` (1), `chatId`, `generationId`,
`ownerDocumentId`, `attachmentId`, `attachmentSha256`, `window` (`pid` +
`windowId` + `title`), `targetRevision` (controller snapshot revision at plan
time), ordered `actions[]` each carrying `{elementIdentity, role, label,
action, entity?{label, value, line, sha256-ref}}`, `maxActions`,
`submit: false`, `expiresAt`, and `digest` = SHA-256 over the canonical JSON
of all of the above.

On approval (`Fill N fields`):

1. Revalidate: owner document still current, both CU gates still open, model
   still `ready`, attachment bytes still hash to `attachmentSha256`, bound
   window identity unchanged, plan digest recomputes to `digest`, not expired.
2. The batch grant is consumed once (replay → reject).
3. Execution runs only through `ComputerUseController`; before **every**
   mutation the controller takes a fresh exact-window observation, reacquires
   the intended element by token + conservative semantic check (role + label),
   executes, then verifies effect + postcondition from the post-observation.
4. First error, drift, unknown outcome, target change, transport loss, or
   cancellation stops the batch. Later actions report `not_attempted`.
5. Per-row results: `filled`, `already_satisfied`, `untouched` (deselected),
   `needs_review`, `failed`, `not_attempted`.
6. Stop, quit, chat switch, gate close, or controller close revokes pending
   plans and any active batch.

If this contract cannot be built without weakening `ComputerUseGrantLedger`
invariants (one-use fingerprint bound to generation + target revision + args),
the fallback ships the review card but keeps per-field approval — never fake
batch security in the renderer.

### Privacy wording

UI copy may say "Matching runs on this Mac." It must **not** claim the
document stays on the Mac — the same attachment is part of the hosted chat
model's context. A stronger claim requires a dedicated local-only source path
excluded from prompt construction (out of scope for v1).

### No-submit decision

Submit candidates (button role + exact normalized label `Submit`/`Submit
Form`) are recognized only to be **excluded** from the batch (`submit: false`
is part of the digest). After fill results are visible, a separate standard
Computer Use approval can submit — same UX as today's per-action approval.

### Logging

No document values, field values, screenshots, or scorer inputs/outputs are
logged. Logs carry counts, states, error codes, and digests only.

## Delivery slices

- **A0 (this document):** contracts, threat model, fixture schema.
- **A — native scorer + artifact lifecycle:** `native/cua-s1-forms` Swift
  package, `scripts/build-cua-s1-forms-helper.mjs`,
  `main/services/form-fill/{artifacts,helper}.ts`, tests. Helper presence +
  signing verified by packaged checks on macOS.
- **B — extraction + planner:** `extract.ts`, `planner.ts`, fixtures
  (`tests/fixtures/form-fill/`), pure-TS tests including golden demo rows.
- **C — batch execution:** `batch.ts` + `ComputerUseController` integration +
  approval details kind `form-fill-batch`; tests prove one-use digest, fresh
  observation per mutation, stop-on-first-error, revocation paths.
- **D — wiring/UX:** Settings row, tool entry point, review card, progress +
  result cards, IPC contracts, reduced-motion/a11y.
- **E — evaluation + packaged acceptance:** 3–5 local form fixtures, metrics
  report, extended packaged acceptance.

## Fixture schema (`tests/fixtures/form-fill/*.json`)

```jsonc
{
  "name": "patient-registration",
  "document": "…UTF-8 text with Label: value lines…",
  "formTitle": "Northwind Clinic - New Patient Registration",
  "elements": [
    {
      "role": "AXTextField", "label": "First name", "value": "",
      "index": 0, "actions": ["AXPress"], "checked": null,
      "frame": {"x":0,"y":0,"w":0,"h":0}, "token": "…"
    }
  ],
  "expected": [
    {"index": 0, "outcome": "fill", "entityLabel": "First name"},
    {"index": 1, "outcome": "needs_review", "reason": "skip_wins"}
  ],
  "notes": "…"
}
```

Upstream golden data: `demo.jsonl` (196 rows, pinned SHA-256 above) drives
context/option formatting and argmax decode tests without running Core ML —
rows assert exact context strings and selected indices, so any porting drift
in encoding/formatting is caught on Linux.

## Acceptance evidence

Recorded per slice; the final report lists files, revisions, hashes, tests,
and remaining manual acceptance on macOS.


## 2026-09-22 remediation evidence

- Read the Notion CUA-S1-FORMS research and verified the pinned publisher model card, checksums, license, Swift source and driver revision. MIT applies to model artifacts; FluidAudio's ported Swift reference is Apache-2.0 (not the earlier claimed MIT). Publisher benchmark numbers are not Aiden acceptance results.
- Fixed product-version gating, `.mlpackage` source URLs, fully awaited bounded downloads, cancellation/removal publication ordering, renderer-owner invalidation and a separate compiled cache. Concurrent preparation shares one lifecycle-bound promise; one cancelled caller cannot cancel another generation's initialization.
- Exact latest-user-turn source references are exposed in the tool description; stale prior attachments cannot seed a plan. Rehash before execution; reject unsupported source types, zero-action plans and forms above 64 actionable controls before scoring.
- Approval digest includes full capture structure. Pinned driver snapshot-token rollover requires unchanged structural hash, exact unique role/label, index, frame, depth and parent; arbitrary lost tokens, window/app/title changes and user edits stop input. Mutations use fresh driver tokens, never submit, and report interrupted batches as incomplete. Layout changes after a fill intentionally stop the remaining batch.
- Bot admission uses the existing Computer Use grant, unchanged tool exclusions and live revocation wrapper. Mobile approvals remain host-only; both native clients decode count-only results through existing generic tool activity.
- Automated evidence: 375 scoped JavaScript checks and 41 native broker checks; 17 Swift/Core ML tests with the downloaded SHA-verified FP16 model (zero skips); focused Android count-only activity test passed. Type-check/lint and integration suites are tracked in the PR closeout. Physical iOS is queued behind the coordinator's device lock/ownership gate; signed live-window and packaged TCC acceptance remain unverified.
