# Pi Compaction and Durable Memory Upgrade — Implementation Notes

These notes are implementation evidence for
[the upgrade plan](pi-compaction-memory-upgrade-plan.md). They intentionally contain no transcript,
credential, prompt, or device-identifying data.

## Phase 0 — Compatibility freeze

Status: Implemented and accepted after two review rounds on 2026-08-31.

### Pinned production boundary

- `@earendil-works/pi-agent-core@0.80.10`: npm SHA-1
  `c9e40261d935d0049f4e88ed5a6587ee1eec2c03`, integrity
  `sha512-nwnOR3SuLYGRFfyQm8ri4Nj5VGVAvAM9GuqQd3u7BUQj0d6hmD2F8w7OHAAjThE3CuySIdM+v8E22QJG6/RfCg==`.
- `@earendil-works/pi-ai@0.80.10`: npm SHA-1
  `97e8a4c1a005dbeef193a2074754b173d88c5a78`, integrity
  `sha512-Moe/H8c87yacDGK9dPbWphZNjVsrb3nTrIHycOQJAkFEnY9PYxOOd74+ny44kATfPU9Dm7aTHefar3pZF+UKUA==`.
- Upstream `v0.80.10` tag: `8dc78834cde4e329284cf505f9e3f99763df5529`.
- Re-resolved upgrade candidate: npm `0.84.4`, upstream tag
  `b79e4cc834970cca69daebffab7df1da7d1e52c4`. The candidate remains a Phase 3
  decision and is not used by Phase 0 runtime code.
- Audited installed exports/source maps:
  `dist/index.d.ts`, `dist/harness/session/session.{js,d.ts,map}`,
  `dist/harness/session/jsonl-{repo,storage}.{js,d.ts,map}`,
  `dist/harness/compaction/compaction.{js,d.ts,map}`, and
  `dist/harness/messages.js`.

Frozen SHA-256 source/declaration hashes:

| Installed artifact | SHA-256 |
| --- | --- |
| `dist/index.d.ts` | `72fbca27169b0f2e5f7a565a6d2e5e953ec962a9a7c5694f827f2c9a14b01842` |
| `dist/harness/session/session.d.ts` | `2a0d56977ac196eda75cff679f0634f8d4eb5a625cb19d492afa1a0f614d6a6c` |
| `dist/harness/session/jsonl-repo.d.ts` | `a61c6320f7117d393a1673ed5bc77fb8e466600754a2626cb051daabff25cce7` |
| `dist/harness/session/jsonl-storage.d.ts` | `a352527296e00aa28baead14a82e5f8893c4911743def47be3fd475e3e0d6f14` |
| `dist/harness/compaction/compaction.d.ts` | `8c3311d33df571503dc62c154a9e41f77a91aedb5682f4d70e82b25aaa6b8684` |
| `dist/harness/messages.js` | `ddd128106ed362d03011e25c083e411ee8f3d2de2118939c2289fccec3dbe9e6` |
| `dist/harness/session/session.js` | `ccfebee2a16fb2bc78a0ae647326e0f3f09952006f54a67916dc8ec4cefa94e0` |
| `dist/harness/session/jsonl-repo.js` | `21cf89c4dd4fb6ed8620d1ce43516003d457c042749696eecea74bbe0b59eb08` |
| `dist/harness/session/jsonl-storage.js` | `8806c1ed37d5e48c48a8c5819fa909626f0fa5a4cd909ed61d6628dd827430d1` |
| `dist/harness/compaction/compaction.js` | `29c6a3d4a70668c40515f63de49493730708457106dcf8ded766ac297cb2da4a` |

Frozen exported API/signature inventory used by Aiden:

- Session: `Session`, `buildSessionContext`, `buildContextEntries`,
  `defaultContextEntryTransform`, `sessionEntryToContextMessages`, and
  `CustomEntryContextMessageProjector`. The v3 checkpoint writer is
  `Session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)`.
- JSONL: `JsonlSessionRepo`, `JsonlSessionStorage`, and
  `loadJsonlSessionMetadata`. The header contract is `type: "session"`,
  `version: 3`; leaf records redirect the active branch through `targetId`.
- Compaction: `DEFAULT_COMPACTION_SETTINGS`, `calculateContextTokens`,
  `estimateContextTokens`, `estimateTokens`, `shouldCompact`, `findTurnStartIndex`,
  `findCutPoint`, `generateSummary`, `prepareCompaction`, `compact`, and
  `serializeConversation`. `prepareCompaction` and `compact` return Pi `Result`
  values with `CompactionError` rather than throwing expected failures.

### Reference refresh

Default branches were shallow-fetched immediately before Phase 0 implementation.

| Reference | Resolved revision | Inspected paths | Decision |
| --- | --- | --- | --- |
| `mksglu/context-mode` | `6b8bf61f83abed6c3faf4e7c3ba02c162fadfedf` | `src/store.ts`, `src/truncate.ts`, `src/session/db.ts`, `src/session/snapshot.ts`, `src/session/purge.ts` | Keep bounded FTS5/BM25 retrieval, attribution, purge, and compact snapshots as Phase 6 design inputs. Reject a parallel MCP/session owner. |
| `nicobailon/pi-subagents` | `3f879722f96fdec19364ccd9a18f8176d797fedc` | `src/runs/shared/session-lease.ts`, `permissions.ts`, `single-output.ts`, `child-protocol.ts` | Reuse fail-closed session leasing and bounded child-output ideas. Preserve Aiden's main-owned immutable capability ceilings and journal. |
| `juicesharp/rpiv-mono` | `d13677c7b6f012335da6dc86217e18213e32faf6` | `packages/rpiv-todo/state/replay.ts`, `todo.session-isolation.test.ts`, `rpiv-ask-user-question/reconcile.ts` | Re-run installed rpiv replay/isolation contracts after the session port and Pi upgrade; do not merge rpiv state into memory. |
| `nicobailon/pi-web-access` | `5741f303a4f5b89fed18e02ec3fed038844e0e98` | `src/`, `README.md` | Retain bounded source references as a future recall input. Do not persist raw web output as a memory fact. |
| `nicobailon/pi-mcp-adapter` | `ff234b862359e722bf4dc1c99cde62278d4b8eb3` | `src/`, `skills/mcp-scripting/SKILL.md` | Adopt compact, explicit result envelopes where applicable. Reject a second MCP lifecycle or session owner. |
| `DietrichGebert/ponytail` | `2ed6c52c9d7e5e56942508591085fd45dea277d3` | `README.md`, `skills/ponytail/SKILL.md` | Workflow-only simplicity reference; no memory or compaction authority. |
| `@gotgenes/pi-permission-system` | npm `29.1.0`, integrity `sha512-b4mYae/YhWN9kAChOGVMc/xcxgbc5n5spW0VsHddg2CuNAlxSQl5APMUsbiIHVRVyGdytxcPOSFdB7mMceZWvA==` | package metadata and public policy contract | Carry deterministic allow/ask/deny and child-to-owner forwarding into Phase 6. Do not import its unresolved durable-approval semantics. |
| `MattDevy/pi-extensions` | `86cbbbb1d65eeca88ce2f820dd958301625e394c` | `packages/`, including continuous-learning and review packages | Confidence/feedback can inform suggestions, but model output never commits memory and code simplification is not context compaction. |
| `narumiruna/pi-extensions` | `36c2421544f0defaebd3d44b793d39b2a7f5fb47` | `packages/`, extension readmes | Re-audit native compaction only in Phase 7; local Pi checkpoints remain the cross-provider baseline. |
| `injaneity/pi-computer-use` | `4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62` | `src/output.ts`, `src/runtime.ts`, `README.md` | Keep text/image output bounding and re-fetchable references in the replay matrix. Do not weaken Aiden's screenshot retention and authority boundaries. |

### Frozen fixtures and verifier

- `main/services/fixtures/pi-legacy/` covers uncompacted history, images,
  provider/model changes, tool call/result pairs, Aiden transaction and visible-sync
  markers, repeated/split-turn checkpoints, abandoned attempts, a torn tail, and a
  structurally corrupt parent.
- `pi-legacy-session.ts` is an Aiden-owned, read-only v3 decoder and migration
  verifier. It materializes every legacy checkpoint's retained tail in memory,
  preserves abandoned/custom/model-change records, proves complete source/target
  context parity, and reports content-free deltas. It does not repair or write the source.
- `pi-legacy-session.test.ts` proves that the independent decoder reconstructs the
  same complete context state as pinned Pi `0.80.10` for the golden fixtures.
  It also freezes the five-surface binding matrix and model-specific image projection.

### Expected surface bindings

| Surface | Authoritative context/binding |
| --- | --- |
| Workspace | Persistent chat journal plus chat-saved provider/model and workspace prompt/tools. |
| Canonical Bot | Canonical Bot backing chat plus Bot-saved provider/model, persona, and authority. |
| Ordinary Telegram | Telegram profile/workspace backing chat and that chat's exact saved selection. |
| Bot-bound Telegram | The canonical Bot backing chat and Bot-saved selection; never the Telegram profile default. |
| Child | In-memory bounded fork with inherited immutable provider/model/authority ceiling and child-local compaction session. |

## Phase 1 — Current-version correctness

Status: Implemented and accepted after two review rounds on 2026-08-31.

- `projectNextContextUsage()` is the single conservative pressure projection for
  restored zero-usage history, newly appended prompts, tool continuations, static
  prompt/tool schema cost, images, and child initial forks. The coordinator refuses
  no-op semantic checkpoints when no compressible history exists.
- Provider-bound emergency projection now reports a typed outcome. History removal
  schedules one Pi-owned durable checkpoint at the next terminal safe boundary;
  active-payload reduction remains request-local, and irreducible payload replacement
  returns the stable `active_context_too_large` category without rewriting history.
- `ContextLifecycleService.compactChat()` is the only persistent-chat manual
  compaction boundary. It acquires normal turn admission, enforces canonical Bot and
  archive state, resolves the exact chat-saved provider/model, returns closed
  content-free reasons, and always releases its lease.
- Telegram `/compact` and desktop `/compact` both use that service. The desktop
  command reuses the existing accessible slash palette and transient toast/status
  feedback, with no new visual primitive.
- Review round one closed active-tool-tail projection, stable emergency errors,
  checkpoint no-op handling, exact manual model authority, and stale usage anchors.
  Review round two closed current static-context anchoring, queued-turn projection,
  summary usage accounting, successful between-tool checkpoint reconciliation, and
  owner-bound manual cancellation. The full compaction, Telegram, slash-command,
  and TypeScript gates pass.

## Phase 2 — Pi session migration seam

Status: Implemented and accepted after two review rounds on 2026-08-31.

- `PiSessionPort` is the narrow Aiden-owned journal surface used by the
  compaction coordinator, visible-chat synchronization and transactions,
  persistent session store, runtime harness, todo replay, manual lifecycle,
  and in-memory child sessions. Only its legacy adapter can access Pi 0.80
  storage to create an entry-projector view.
- The store continues to own chat identity, `0600`/`0700` permissions,
  corrupt/torn journal recovery, transaction rollback, path indexing,
  quarantine, and deletion. None of those policies moved into Pi.
- `PiSessionMigrationReceipt` freezes a strict, content-free receipt schema
  with formats, source SHA-256, promoted/backup paths, closed counts, validation
  state, and timestamp. Unknown/transcript-shaped fields fail closed.
- Reference re-check (default branches, 2026-08-31):
  - `nicobailon/pi-subagents` at
    `3f879722f96fdec19364ccd9a18f8176d797fedc`: inspected session-file trust,
    fork CWD alignment, workflow settlement, and runtime session-manager
    scoping. Retained its useful per-child identity/trusted-path separation;
    rejected direct JSONL rewriting because Aiden owns atomic migration and
    private journal policy behind the port.
  - `juicesharp/rpiv-mono` at
    `d13677c7b6f012335da6dc86217e18213e32faf6`: inspected `session-hooks.ts`
    and `session-capture.ts`. Retained per-session compaction lifecycle scoping
    and exact stale-session handling as compatibility expectations; rejected
    global captured session authority and post-compaction message injection.
- `test:compaction` now includes port/receipt conformance and passes 211 tests;
  TypeScript compilation passes.
- Review round one moved persistent repository discovery/open/create/delete
  behind a second Aiden-owned port, froze session entries/context/metadata as
  Aiden contracts, hid native objects with ECMAScript private fields, and made
  the independent v3 decoder reject malformed or unknown entry kinds.
- Review round two moved child in-memory session creation into the repository
  adapter, added closed role-specific nested message validation, and enforced
  receipt count/format/absolute-distinct-path invariants. The final phase gate
  passes 212 compaction/session tests, TypeScript compilation, and diff checks.

## Phase 3 — Pi 0.84.4 and v4 journal migration

Status: Implemented and accepted after two review rounds on 2026-08-31.

- Both Pi packages are exact-pinned to `0.84.4`. Audited npm integrity:
  - `@earendil-works/pi-agent-core`:
    `sha512-HyUnjaOXj6oN/6SNcr8A1J/ElRQA50FtIE0XUTSKAQVqmdlb9qdojOyUQwF/jULE5+yOEtGuVgi/N1RnBiNG+g==`
  - `@earendil-works/pi-ai`:
    `sha512-AClAZxf5+c4RRu44NJPS6wyQy+Nmq+Mzyyrdvm4ZVMNuixelO02RZX4G4Aq1F145Yzp43wnM5S+hLlSI7ypfVw==`
  - upstream `v0.84.4` tag: `b79e4cc834970cca69daebffab7df1da7d1e52c4`.
- The compile spike explicitly adapted the v4 lane/session repository, numeric
  timestamps, `uuidv7` entry ownership, strict JSON durability, provider
  refresh contexts, signal-bearing auth callbacks, terminal stop reasons,
  and next-turn preparation. Aiden still owns its runtime harness because the
  public Pi harness remains an incomplete scaffold at this release.
- `migratePiSessionJournal()` independently decodes v3, materializes every
  checkpoint retained tail, preserves messages, custom/Aiden transaction
  markers, facts, model/tool state, and abandoned branches, then emits a v4
  main lane plus a closed migration operation. It validates provider-context,
  entry-count, and leaf parity by reopening the staged file with the installed
  v4 repository before atomic promotion.
- Promotion retains the exact source bytes in a `0600` backup, writes a strict
  content-free `0600` receipt, repairs receipt-write interruption
  idempotently, and fails closed without changing the authoritative v3 file.
  Rollback preserves a private v4 artifact, verifies the source hash, restores
  exact v3 bytes atomically, and removes the promotion receipt.
- Persistent chat opening scans exact v3 ownership headers and promotes them
  before v4 repository discovery. Backups and receipts enter Aiden's deletion
  index. Pi v4's delayed steering queue is also included in between-tool
  pressure before the next provider request.
- The current gate passes 218 compaction/session tests (including fixtures,
  24 randomized repeated-checkpoint chains, torn writes, interrupted receipt
  publication, rollback, restart discovery, and corrupt duplicate fallback),
  TypeScript compilation, and diff checks.
- Review round one closed stale/failed receipt trust, backup-object validation,
  and crash-ordering durability by reopening promoted journals, verifying exact
  backup hashes and private regular-file modes, and fsyncing every directory
  publication boundary. It also refreshed the guarded OAuth branding test and
  added `test:compaction:packaged`, which creates a chat in the signed app,
  seeds v3 data, launches the upgraded app, and proves promotion plus an
  idempotent second process restart without duplicate journals.
- Review round two made post-promotion recovery discoverable before ordinary v4
  repository opening, restored corrupt-legacy-duplicate fallback without ever
  selecting the failed candidate, compared every immutable v4 header field,
  and made rollback retry idempotent without overwriting its preserved v4
  evidence. The packaged acceptance now deletes the receipt after promotion
  and proves the next app process reconstructs it without rewriting v4 bytes.
- Final Phase 3 gates: 220 compaction/session tests, 51 branding/runtime tests,
  TypeScript compilation, diff checks, signed development packaging, hardened
  package verification, and the three-process packaged migration/restart
  acceptance all pass.

## Phase 4 — Retained-tail semantic compaction

Status: Implemented and accepted after two review rounds on 2026-08-31.

- The implementation refresh on 2026-08-31 re-resolved npm latest as
  `@earendil-works/pi-agent-core@0.84.4` and confirmed the audited upstream tag
  commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`. The overlapping reference
  defaults remain `nicobailon/pi-subagents` at
  `3f879722f96fdec19364ccd9a18f8176d797fedc` and `juicesharp/rpiv-mono` at
  `d13677c7b6f012335da6dc86217e18213e32faf6`. Their child isolation and
  session-scoped replay contracts remain compatibility tests; neither becomes
  a runtime or journal owner.
- `PiCompactionCoordinator` now calls Pi's `compact()` with native
  `RetryPolicy` and `RetryCallbacks`. Pi owns bounded transient classification,
  exponential backoff, abort precedence, per-summary request identities, and
  `cacheRetention: "none"`; Aiden's duplicate `completeSimple` proxy and delay
  loop are removed.
- Native retained-tail checkpoints persist Pi's returned combined summary
  usage and expose the same usage on the local compaction completion event.
  Tests freeze successful callback order, retry exhaustion, cancelled backoff,
  cache isolation, stable retry request identity, and separate split-summary
  identities.
- The retained `PiAgentRuntimeHarness` follows Pi 0.84.4's loop contract:
  `prepareNextTurnWithContext` checks pressure only when the loop will really
  continue, while the post-`Agent.continue()` terminal path performs the idle
  assistant check and emergency checkpoint. A focused lifecycle test proves a
  terminal response receives one initial preflight, no between-turn check, and
  exactly one terminal check.
- Runtime source contains no legacy `firstKeptEntryId` writes. Remaining
  occurrences are confined to the independent v3 decoder/migrator and legacy
  fixtures. No remote telemetry or transcript-bearing diagnostics were added.
- Review round one reported no actionable findings and independently passed
  221 compaction/session tests, TypeScript compilation, diff checks, hardened
  package verification, and packaged migration/restart acceptance.
- Review round two found that the coordinator recomputed projected pressure
  with a smaller reserve and that queued-message pressure could request a
  checkpoint with no effective input to summarize. The coordinator now honors
  `projectNextContextUsage().shouldCompact` as the single threshold decision
  and projected checks refuse empty history/prefix preparations. Boundary tests
  cover both the reserve gap and a large queued steer that must proceed through
  bounded request projection without writing a useless checkpoint.
- Final Phase 4 gates: 222 compaction/session tests, TypeScript compilation,
  diff checks, a freshly rebuilt signed development package, hardened package
  verification, and packaged v3 promotion/idempotent v4 restart acceptance all
  pass.

## Phase 5 — Conversation surface parity

Status: Implemented and review-accepted after two rounds; credentialed operator
acceptance remains Pending in the retained runbook.

- The reference refresh on 2026-08-31 confirmed that the overlapping defaults
  remain `nicobailon/pi-subagents` at
  `3f879722f96fdec19364ccd9a18f8176d797fedc` and `juicesharp/rpiv-mono` at
  `d13677c7b6f012335da6dc86217e18213e32faf6`. Aiden retains their useful
  session-isolation/replay expectations while keeping all persistent-chat
  authority in the existing generation owner and `ContextLifecycleService`.
- `context-lifecycle-surface-matrix.test.ts` is a registered shared contract.
  Its production-wiring guard proves that desktop/workspace and canonical Bot
  turns construct the managed Pi harness, Telegram/remote/scheduled adapters
  use the same admitted generation entry rather than a second compactor, and
  children use `runManaged()` for their initial fork and continuations. Its
  behavioral table drives ordinary workspace, canonical Mac Bot,
  Telegram-bound Bot, ordinary Telegram, and remote/mobile Bot compaction
  through the real `ContextLifecycleService`; every row proves the exact
  backing chat/owner lease, saved provider/model resolution, shared session,
  and one native checkpoint.
- The same matrix proves ordinary Telegram chat IDs remain profile/workspace
  scoped and cannot collide with a canonical Bot backing chat. Existing dynamic
  Telegram coverage proves bound Bots resolve the backing chat's exact saved
  provider/model, preflight Bot authority before append, omit unattended mode,
  and refuse a mismatched binding.
- `telegram-session.test.ts` is now registered in both compaction and Telegram
  suites. It freezes all content-free lifecycle result mappings and proves
  manual `/compact` and cancellation enter `ContextLifecycleService` with the
  Telegram profile owner instead of opening a journal or resolving a model in
  the transport adapter. Telegram core tests now drive the actual
  `compact:yes` callback, proving an immutable bound-Bot backing chat is used,
  an ordinary profile/workspace remains isolated, and the shared busy result
  starts no generation.
- The cross-platform contract asserts the remote schema and every iOS/Android
  contract, model, and client source contain no checkpoint-authoring fields
  (`retainedTail`, legacy boundaries, or append APIs), while both native models
  continue to render the redacted `compact_context` activity state. Desktop
  remains persistence authority.
- Review round one rejected source-only parity assertions and an undocumented
  manual gate. The behavioral matrix and Telegram callback coverage above
  close the automated findings. The credentialed Telegram and packaged
  concurrency procedures now live in
  `docs/testing/pi-compaction-phase5-operator-gates.md` with prerequisites,
  content-free evidence, expected checkpoint deltas, and explicit Pending
  status; missing credentials or native toolchains cannot be reported as a
  pass.
- Review round two found that the behavioral matrix still bypassed production
  surface adapters, omitted the Swift networking client, and left its operator
  steps dependent on stale package output and unspecified journal tooling.
  Desktop and Telegram now use exported production lifecycle adapters; their
  shared-journal test drives Mac and bound Telegram through one canonical Bot
  session and two native checkpoints. Scheduled and remote turns now build and
  enter an executable shared generation-surface contract used by production,
  with exact chat/turn/owner/provider/model/tool-ceiling assertions. The native
  guard includes `AidenRemoteClient.swift`, and the runbook now starts with
  `npm ci` plus a fresh package, identifies the exact app/journal paths, creates
  a timestamped backup, and provides a content-safe checkpoint counter.
- Final automated verification: 230 compaction/surface tests, 181 Telegram tests,
  431 Bot tests, 343 remote tests plus seven LAN/restart tests (one expected
  remote skip), TypeScript compilation, lint, diff checks, and the
  signing-disabled generic-iOS test build pass. Android
  `testDebugUnitTest` could not start because this host has no Java runtime;
  no Android source or wire contract changed, and the shared TypeScript/native
  source contract passed.

## Phase 6 — Durable memory, separate from compaction

Status: Implemented and review-accepted after two rounds on 2026-08-31.

- `MemoryStore` owns a device-local SQLite/FTS5 store with exact Bot or
  workspace scope, stable fact IDs, normalized text, truthful edit/message/model-turn
  provenance, confidence, expiry, approval state, supersession, and bounded
  always-on projection. Its directory, database, live WAL, and SHM are repaired
  to `0700`/`0600`, and all reads remain offline.
- Always-on facts are appended as the final volatile prompt block after stable
  identity, extension, and skill contributions and before final context
  capacity checks. On-demand `recall_memory` uses scope-filtered BM25 with an
  eight-result cap and distinguishes owner-approved facts from unapproved
  historical transcript excerpts and artifact metadata in every citation.
- `remember_fact` exists only for an attended renderer-owned turn, is declared
  sequential and never replayable, validates excluded secrets/credentials,
  reasoning, tool payloads, compaction summaries, and authority text both
  before approval and at commit, and uses Aiden's fail-closed approval request.
  Telegram, scheduled, remote, and other headless turns remain recall-only.
- The desktop memory manager uses canonical chat authority and the shared turn
  gate for add/replace/delete/export. It displays exact workspace/Bot scope,
  provenance, expiry, replacement state, and always-on state; destructive
  deletion uses the existing accessible confirmation primitive. Export is an
  atomic private versioned JSON file.
- Visible user/assistant transcript excerpts and attachment/HTML-artifact labels
  are indexed as bounded metadata; attachment contents, raw reasoning, and tool
  payloads are not indexed. Chat deletion removes its metadata and source facts,
  while cross-source successors remain active with a cleared link. Expired facts
  no longer consume active or always-on quota.
- The registered production memory surface matrix proves Mac and Bot-bound
  Telegram share exact Bot scope, ordinary Telegram stays workspace-isolated,
  headless construction omits the write tool, denial/cancellation commit
  nothing, only an attended approved harness hook reaches commit, writes never
  replay, and volatile prompt/tool cost enters final context budgeting.
- Durable memory remains available from its attended chat management surface,
  but is deliberately not advertised as a separate onboarding feature tile.
- Review round one closed cross-source deletion, same-text replacement,
  provenance truthfulness, forbidden-content coverage, expired quotas, empty
  scope labeling, metadata recall, and the cross-surface gate. Review round two
  closed live SQLite sidecar permissions, wrong-scope chain mutation, recall
  approval labeling, and production approval-hook coverage.
- Final focused verification: 249 compaction tests before final-review
  hardening plus the post-review 18-test memory set, 52 onboarding tests, 181
  Telegram tests, the shared application-service boundary suite, TypeScript
  compilation, lint, and diff checks pass.

## Phase 7 — Evaluation, rollout, and optional native providers

Status: Implemented and review-accepted after two rounds on 2026-08-31. The
release-owner installed/signed and credentialed operator matrix remains
explicitly Pending, so the parent plan stays Active and `v4_only` cannot be
claimed or selected without its device-local receipts.

- The evaluation command runs seven executable fixtures. Semantic cases drive
  the real Pi coordinator, including split-turn and repeated checkpoints; the
  faux summary provider derives every identifier it emits from its actual
  received summary request instead of an expected-answer fixture. The
  attachment case drives the production emergency projector. Follow-up turns
  run until the next observed checkpoint, a real v3 fixture is migrated during
  every evaluation, and the scorecard records observed duration, provider
  usage/cost/cache fields, checkpoint results, reference retention, emergency
  projections, no-op attempts, and migration failures. Exact runtime schemas,
  all required cases, non-zero executable measurements, and both aggregate and
  per-case thresholds are enforced before a private receipt is written.
- One device-local policy advances exactly one cohort at a time: fixtures,
  developer installs, new chats, migrated low-risk chats, existing long chats,
  then `v4_only`. The same authoritative chat eligibility controls new v4
  journal creation, legacy migration, automatic and manual Pi checkpoints, and
  memory. In particular, a pre-existing chat without a journal is not silently
  classified as new. `AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0` is read once at
  startup and disables journal creation/migration, automatic/manual checkpoint
  generation, and memory while retaining byte-stable read access to existing
  v4 journals.
- Rollout advancement reloads current state under a private token/PID lock,
  rejects stale cached writers and stage skips/regressions, and safely reclaims
  an old lock only after its owner is dead and its exact contents remain
  unchanged. `npm run pi-upgrade:advance -- <next-stage>` is the explicit local
  operator path; no renderer, remote, Telegram, or model-facing API can advance
  it.
- Evaluation and installed receipts use exact schemas, recompute the scorecard,
  and bind to an SHA-256 traversal of the complete signed `.app` (including
  `app.asar` and resources), a consistently propagated explicit build ID, and
  the exact evaluation bytes. The packaged harness rehearses v3 promotion,
  receipt-loss recovery, idempotent restart, exact-zero rollback, and strict
  code-signature validation before it can atomically produce the installed
  receipt required for `v4_only`.
- The required provider-native re-audit resolved Pi Core `0.84.4`,
  `narumiruna/pi-extensions` at
  `36c2421544f0defaebd3d44b793d39b2a7f5fb47`, and
  `YeungKC/pi-codex-compact` at
  `53630cd9b937a8a4873271e20188c3f18819ca6a`. Inspected files were Pi's
  `packages/coding-agent/src/core/compaction/compaction.ts` and
  `packages/coding-agent/src/core/extensions/types.ts`, plus
  `pi-codex-compact/native-compaction.ts` and `index.ts`. Applicable ideas are
  bounded pre-provider remote compaction, model-transition recovery, and opaque
  checkpoint persistence. Rejected for this phase are provider-exclusive
  checkpoint authority and extension-owned reconciliation: the public seams do
  not expose exact capability metadata, token accounting, mid-turn state,
  retry policy, or all transport response metadata, and cannot prove Aiden's
  cross-surface deletion/offline reconstruction contract. Local Pi v4
  checkpoints therefore remain the cross-provider baseline; the pinned audit
  and reconsideration criteria are retained in the Phase 7 rollout runbook.
- Review round one replaced source-title assertions and permissive caller
  receipts with executable measurements, exact validation, per-chat production
  gates, build/evaluation binding, concurrency-safe advancement, and the native
  provider decision. Review round two removed the self-fulfilling replay
  oracle, measured re-compaction/migration/no-op outcomes, added per-case
  thresholds, unified automatic/manual/format eligibility, expanded identity
  from the launcher to the complete app, propagated build IDs, added the local
  advancement command, made crash locks recoverable, and completed this pinned
  audit record.
- Automated verification after review includes 259 compaction tests, 181
  Telegram tests, 431 Bot tests, focused rollout/lifecycle tests, TypeScript,
  lint, Electron build, a fresh signed development package, hardened package
  verification, packaged v3 promotion/idempotent v4 restart/exact-zero rollback
  acceptance, the complete repository `npm run test` command, and diff checks.
  The generated evaluation scorecard passed all seven cases with exact
  continuation/reference retention, zero no-op and migration failures, and at
  least two observed turns before re-compaction. Installed production and
  credentialed surface results must be appended to the operator runbooks when
  a release owner performs them; Pending is not a pass.
