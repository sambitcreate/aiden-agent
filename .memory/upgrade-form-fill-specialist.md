# Form Fill Specialist (CUA-S1-FORMS + Core ML)

Narrow opt-in specialist layered on existing Computer Use. NOT a replacement agent. Design contracts: `docs/plans/form-fill-specialist-plan.md`.

## Architecture (as built)

- **Native scorer**: `native/cua-s1-forms/` — thin Swift/Core ML helper (Foundation+CoreML only, macOS 14.4+ arm64), lines-based JSON protocol over stdio, warm model, bounded I/O + timeouts, fail-closed. Built by `scripts/build-cua-s1-forms-helper.mjs` into `build/native/Aiden CUA-S1 Forms Helper.app`; packaged via `extraFiles`/`binaries` (inherit entitlements only — no AX needed). Model artifacts are NOT bundled — downloaded to userData at runtime.
- **Artifact lifecycle**: `main/services/form-fill/manifest.ts` pins HF repo `FluidInference/cua-s1-forms-coreml` @ ca2113d2 with per-file sha256+bytes; `artifacts-core.ts` = staging→verify→atomic publish, caps (16MiB total / 8MiB file / 64 files), `FormFillRuntime` wraps helper-client.
- **Provenance**: `extract-core.ts` — bounded UTF-8 `.txt`/`.md` `Label: value` extraction, ≤29 entities (32 options − 3 fixed actions), fails closed on empty/binary/truncated/too-large/conflicting-duplicates. sha256 contentHash per plan.
- **Planner**: `planner-core.ts` — pure TS port of upstream cua-s1 render_context/render_options/decode (UTF-8 224B ctx / 96B opt), thresholds 0.5 top / 0.15 margin / any-truncation → needs_review; checkbox `check` always needs_review in v1 (never auto-executes); submit-role+label controls always skip.
- **Batch authority**: `batch-core.ts` FormFillBatchPlan (version, chat/generation/document, attachment id+hash, window, epoch, ordered actions, maxActions, submit:false, TTL, sha256 digest via ledger). `service.ts`: `approvalFor` (build+mint at card time), `authorize` (post-approval subset via formFillExcludedOrders → derived plan+new digest), `execute` (consume once → controller), `revoke` on all generation teardown paths.
- **Controller**: `executeFormFillBatch` — fresh exact-window observation per row, reacquire by token+index+role+label, set_value via brokered driver, re-read verified, stop-on-first-error, per-row results (filled/already_satisfied/needs_review/failed/not_attempted).
- **Approval UX**: `form-fill-batch` details kind → `FormFillApproval` card (target app/window, doc name+hash prefix, per-row label→value+source line, deselect checkboxes, "This will not submit the form."). Renderer guard `isFormFillBatchApprovalDetails` fails closed. Deselections flow back via `chat:approve` options → `approvals.decide` payload → `takeDecisionPayload` → `authorize`. Confirm label "Fill N fields"; deny "Cancel". iOS remote approval contract carries no details — no mobile change needed.
- **Settings**: Settings → Computer Use → "Form fill specialist" switch (default off) + model state row (Not downloaded/Downloading/Preparing/Ready/Update required/Error/Unsupported) with Download/Cancel/Retry/Remove. `formFillSpecialistEnabled` in AppSettings.
- **Onboarding**: `formFill` bento tile in "control" group + `features/form-fill.png` (1024² RGBA).

## Invariants

- No execution without: CU generation gate + accessibility + helper ready + artifact ready + attachment hash match + window identity + digest match + TTL + one-use token.
- Scorer output never authorizes anything; values only ever come verbatim from the extracted entities.
- Tool args carry no values; tool textResult is counts-only; timeline detail is counts-only ("N of M fields", "N filled …").
- `form_fill` tool exists only when `computerUse` is live for the generation AND `formFillSpecialistEnabled===true` AND artifact state `ready`.

## Status

- All TS suites green (test:form-fill = 76+eval tests; test:computer-use incl. ipc-contract; type-check; eslint).
- **Verified on macOS**: Swift helper compilation and 17 native tests with real SHA-verified FP16 model (zero skips). Still unverified: helper signing/notarization in a real package and end-to-end acceptance against a live form window.
- Notion research reviewed in remediation; pinned source code, model card and licenses independently verified.


## 2026-09-22 review remediation

PR #195 updated against main c8c09e0d2 in isolated worktree 6510. All 12 original inline findings addressed with regression coverage. Further Sol reviews found/fixed value drift, malformed scorer output, Unicode identity, 64-control approval bounds, concurrent compilation/cancellation and native fixture loading. Pinned driver tokens roll per snapshot: structural digest plus exact unique semantics/geometry/hierarchy fences their refresh; full layout changes stop the batch. Source Swift is Apache-2.0; model files are MIT. Both license texts are in packaged THIRD_PARTY_NOTICES.md.

Native local model verification: 17/17 tests, no skips, six downloaded files verified against pinned hashes. Computer Use: 375 JS + 41 Rust passing before final closeout; focused Android parity passed. iOS physical test is queued with the coordinator (last known device locked); signed app/TCC/live form acceptance still not performed. Do not call this released or merged. Existing Improve compute RUSE task owns general capture improvements; its uncommitted work was not copied.
