# LLM and pi-vcc compaction

Status: complete (2026-09-04). LLM remains the default; pi-vcc remains experimental.

## Shipped behavior

LLM remains the default. Settings → Memory has an independent Automatic
compaction radio choice. pi-vcc is explicitly experimental. `/compact` uses the
setting; `/compact-LLM` and `/compact-VCC` override one operation. Names are
case-insensitive, require idle chat, preserve the draft, and do not send a new
message after completion. Manual and automatic completion show the engine,
elapsed time, and estimated before/after context size. Automatic feedback uses
existing bounded activity detail fields, retaining mobile wire compatibility.

The shared harness snapshots the preference for each generation, including Bots,
scheduled work, Telegram and mobile-originated requests. Descendants inherit
that snapshot. Telegram's existing compaction action uses the saved default;
the two new commands are desktop-only. There is no benchmark or preview UI.

## Architecture and compatibility

- Pure compiler closure pinned to pi-vcc 0.7.1 at
  `1f1575b6e0a07df51e0a9ea8413394ccac3714ae`, with packaged MIT attribution.
  See `main/services/pi-vcc/UPSTREAM.md` for all local adaptations.
- Pi owns preparation, model-aware safe cuts, retained tails and v4 checkpoint
  reconstruction. Aiden retains admission, cancellation, journal recovery and
  one overflow retry. VCC never falls back to an LLM automatically.
- Node worker threads run both compilation and recall: two active workers,
  bounded waiting queue, 128 MiB V8 old-generation limit per worker and 15-second
  deadline. Cancellation terminates work before freeing its slot. The package
  verifier requires the packed worker and attribution. No synchronous fallback.
- Full summary plus retained context must fit the model budget and reduce the
  estimated prior input. Ranked brief budgets decrease deterministically. Empty,
  unsafe-boundary, stale-leaf, failed-worker and insufficient-reduction outputs
  cannot replace the checkpoint.
- Manual VCC resolves bundled/stored model metadata offline; it does not resolve
  inference auth, call a provider or record summarization usage. No runtime model
  catalog requests were added.
- Source comes exclusively from the current session's active branch. Retained
  copies are deduplicated, private reasoning/binary payloads removed, images
  replaced with continuity markers, and credential-shaped content redacted.
  Aiden tool names/arguments and file/commit evidence are adapted explicitly.
- Optional v4 checkpoint details carry versioned engine/compiler provenance.
  Unmarked checkpoints are LLM. LLM/unknown summaries are conservatively carried
  opaquely even when some raw history exists: v4 cannot certify complete imported
  coverage. They never enter pi-vcc's format-specific merge parser. An oversized
  opaque block fails safely. This conservative choice favors continuity over
  maximum compression when switching engines.
- `vcc_recall` is registered for both engines and searches only the current
  active lineage, with ranked literal keywords or stable journal entry refs.
  Exact-ref plus keyword lookup can locate facts late in long results. At most
  five 1,200-character excerpts are returned as untrusted historical data.
  Worker budgets bound scanning; no other chats, raw-file readers or parent-private
  journals are exposed. Fork/clone retains Aiden's existing visible-history-only
  boundary. Chat deletion deletes the recall journal.

## User education

Settings → Memory and the desktop command descriptions explain the choice.
Existing semantic tokens, borderless radio choices and visible keyboard focus
are retained. Onboarding and feature-tour changes are excluded at the user's
request; no compaction illustration is included.

## Evaluation and rollout

`npm run vcc:evaluate` runs synthetic coding and multilingual planning histories
with annotated goals, constraints, decisions, unresolved work and completed
actions. `docs/testing/pi-vcc-evaluation.json` records the local report. It reports
summary retention separately from retrieval, size, wall time, no summarization
calls and whole-process peak RSS (not incremental per-worker memory). This tiny
corpus is a regression signal, not a quality/latency comparison against paid LLM
compaction or an upstream performance guarantee. Keep LLM as the default pending
representative Aiden evaluations and a separate rollout decision.

## Verification

Coverage includes deterministic output, Aiden tool/commit evidence, multilingual
history, attachments/redaction, large tool outputs, small windows, engine
switching, opaque imported gaps, stable refs, sibling exclusion, queue/worker
cancellation, stale-leaf rollback, zero-provider VCC, one overflow retry, v4
restart/deletion, default migration/persistence and one-operation controls.

Passed checks (2026-09-04):

- 20 focused compiler/control tests; 260 compaction/lifecycle/harness tests.
- 354 slash-command tests; 246 portable-config tests; 50 onboarding tests;
  eight memory-settings/policy tests; 54 activity/presentation tests.
- Full subagent suite and 361 remote tests; five fork/clone copy tests.
- Android AidenChatTest and physical iPhone 13 Pro AidenChatTests, including
  decoding and presentation of existing activity detail fields.
- TypeScript, ESLint, build and 23 package-verifier tests. The signed development
  package passes its hardened-package verification. No release catalog refresh
  or production-state changes were made.
- Packaged offline VCC checkpoint creation and preference persistence, v3
  migration, interrupted-migration receipt recovery, idempotent v4 restart and
  exact-zero rollback have passed. Final packaged Settings click/keyboard
  acceptance passed with visible focus, persisted choice and borderless radio
  cards. The resulting screen was visually inspected.

React Doctor was run as prescribed. Its deprecated diff flag performed a full
repository scan (59/100, 14 existing ref/cleanup errors and 523 warnings); these
are separate from the passing TypeScript/ESLint/feature gates. The integration
makes no claim that the repository is free of that pre-existing diagnostic debt.

## PR review follow-up

The composer tracks compaction activity independently of status copy, so all
three commands retain Cancel while clone/export/worktree do not gain it. An
Electron regression exercises default, LLM and VCC cancellation and subsequent
export. Known worker failures cross the boundary as fixed codes, preserving
boundary, history-limit and reduction errors without forwarding private
exception text. Recall has its own failure, timeout, cancellation and queue
messages and never recommends a compaction command.

Merged current main and retained its Quick View command alongside the three
compaction commands (31 catalog entries).

Review-fix verification: 22 compiler/control tests, 260 lifecycle tests, 354
slash-command tests, the focused Electron cancellation regression, both
TypeScript projects, ESLint and build passed. React Doctor's changed-file scan
reported 82/100 with 19 warnings (existing complexity and iteration patterns);
no additional diagnostic-driven changes were required for these fixes.
