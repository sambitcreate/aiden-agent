# Design Studio DS-1a (headless core)

Status (2026-10-07): DS-1a is implemented on `feature/design-studio-v2` (DS-1a.1 through DS-1a.19). It stays behind `AIDEN_EXPERIMENTAL_DESIGN_STUDIO` (`designStudioEnabled()`). There is no UI yet; DS-1b (Studio UI) is next.

Context: umbrella plan `docs/plans/design-studio-create-images-rebuild-plan.md`, ADR `docs/plans/design-studio-adr.md`, history in `studio-rebuild.md`. Track F facts are in `studio-foundation.md`.

## 1. Module map

Pure cores (Electron-free, testable with `tsx --test`):
- `main/services/design/store-core.ts`: planning (`planDesignRun`), run begin and end (`beginDesignRun`, `endDesignRun`), restart reconciliation, and the owner-decision rules.
- `main/services/design/manifest-core.ts`: the one-schema (v1) manifest parser. The store re-parses every manifest before it writes one.
- `main/services/design/ops-core.ts` and `ops-parse.ts`: project mutations and their payload parsers. The parsers live in main because they use `main/shared/guards.ts`.
- `main/services/design/design-context-core.ts`: the bounded, untrusted `<design_context>` builder.
- `renderer/shared/design/{types,limits,own,resume}.ts`: shared types, quotas, owner helpers and `designResumeOffer`.

Stateful and Electron-bound:
- `store.ts` (`DesignProjectStore`, file I/O) with `project-gate.ts` (one serial queue per project).
- `chat-port.ts`: the hidden chat behind each project, owner `design-project`.
- `design-preview.ts`: the `aiden-genui:` resolver for revisions.
- `design-render-extension.ts`: the `render_artifact` tool, which ends a run through Pi 1.x `finishTurn`.
- `run-service.ts` (`DesignRunService`): starts runs through `llmClient.start`, tracks settlements, and exposes `drain()`.
- `main.ts`: app singletons. `startup-core.ts`: `startDesignStudio`.
- `main/handlers/design/{projects,run,params,results,register}.ts`: the ten IPC channels.

Renderer:
- `renderer/lib/design-ipc.ts`: `designProjectsApi`, a typed client that throws `DesignIpcError`.
- `renderer/lib/generation-stream.ts`: `subscribeGenerationStream`. `startGeneration` in `ipc.ts` delegates to it, so ChatPane is unchanged (`ipc-stream.test.ts` is the oracle).

Profile and harness:
- `main/services/generation-profile.ts`: `resolveGenerationProfile`, `selectRuntimeExtensions`, `assertGenerationProfileTools`.
- `main/services/generation-harness.ts`: `createGenerationHarness`.
- `llm-client.ts` threads the `designRun` binding through start, extension composition, the turn-input closure, the accepted count and `onSettled`.

## 2. Storage, commit order and recovery

- Layout: `userData/design-projects/<id>/manifest.json` and `revisions/<revId>.html`. Directories are 0700 and files are 0600.
- Commit order: the revision file first (`writeFileAtomic`, fsync), then the manifest (`writeJsonAtomic`). The manifest is the commit point.
- Mutations use compare-and-set on `expectedRevision`. A stale write returns the latest snapshot and writes nothing.
- A per-project serial gate orders everything. A project with a running run refuses delete and duplicate with `busy`. Screen removal is refused as `busy` only for a Screen the run renders into (its draft, a Refine target) or one in the direction set the run is filling (PR #385 review: deleting a direction mid-Resume used to settle the set complete but incomplete, losing the Resume offer). Screens in other sets stay deletable.
- Duplicate: a failed library-directory fsync after the final rename rejects with `unavailable`. The renamed copy is not rolled back; it stays listed (it is on disk), its chat is created or deferred, and the next start reconciles it.
- Restart (`initialize`, called from `startDesignStudio` before IPC admission):
  - A `running` run becomes `partial` with `endReason: "interrupted"` if it accepted at least one draft. With none, it becomes `interrupted` and its empty direction set is dropped.
  - Unreferenced revision files and staging leftovers are collected.
  - A referenced file that is missing, resized, or fails its sha256 check is marked `missing` before interrupted runs are ended, so a damaged draft is never published. Startup hashes only files referenced by a non-missing revision at their recorded size (200-revision perf lane ~30-40 ms, was ~20 ms). Checksums are checked on read too.
  - `deleting` cascades resume (`resumeDeletions`).
  - An unreadable manifest is listed as unreadable and is never deleted automatically.
  - Restart sends zero provider requests.
- The store is unusable until `initialize` has classified every project.
- Shutdown (`shutdownAndQuit`, `main/index.ts`): `designRunService.drain()`, then `designProjectStore.drain()`, bounded at 2 s. A timeout logs "Design work did not settle within the shutdown budget." With the flag off, both resolve immediately.

## 3. Quotas (`renderer/shared/design/limits.ts`, owner-approved 2026-10-07)

- 256 KiB per revision; 100 revisions per Screen; 400 revisions and 64 Screens per project; 64 MiB per project.
- 250 projects; 2 GiB across the library; manifest at most 1 MiB; 100 run records. The newest run of each set is protected from trimming.
- Prompt at most 16,000 characters.
- Enforcement: the parser checks the per-Screen revision limit and manifest shape. The store checks project bytes, set size, partial and complete counts, project count and library bytes. Bytes for an accepted design are reserved under the gate until its manifest owns them.
- The project byte cap counts declared bytes, so a missing file still uses quota until the project is deleted.

## 4. The design profile and runtime

- `resolveGenerationProfile` is the only authority. A design chat must be owned by the same project the run binding names. Anything else is refused. Non-design chats get the default profile.
- A design run composes only the design render extension. It has no built-in tools, no subagents, no computer use and no MCP. `assertGenerationProfileTools` refuses any other tool name.
- `render_artifact` takes HTML only and ends the run through Pi 1.x `finishTurn`. Calls past N are rejected with `terminate: true`. A same-title replacement is allowed at most N times.
- Stop rules:
  - N accepted artifacts ends the run as `complete`, before any summary request.
  - At least 2N render calls, counting rejected and invalid ones, ends it as `partial`.
  - At least N+2 provider turns ends it as `partial`.
  - A text-only stop with fewer than N accepted ends it as `partial`, offering Resume.
  - Refine renders exactly one.
- Bounded context: at most 128 KiB in total, of which 96 KiB is the base revision. Up to five selection targets at 2 KiB each. Up to four existing direction titles at 200 characters each. Earlier `render_artifact` HTML is replaced with `[design revision <revId> omitted]`.
- Stored messages keep a revision sentinel instead of HTML. Measured at DS-1a.10: 6.2 MB reduced to 83 KB.
- Store time: opening and saving a 200-revision project took 36.0 ms in the perf lane on 2026-10-07 (budget 200 ms).

## 5. Interruption, Resume and Discard (owner decision, 2026-10-07)

- Pi 1.0.3 cannot resume mid-turn. `continue()` works only from a user or toolResult tail, and error or aborted responses are hard exits. Aiden's journal rolls back an uncommitted turn on crash, and the durable-jobs ledger is unwired and excludes Design.
- So every interruption publishes partial, then the user can Resume. End reasons are `stopped`, `provider_failed`, `interrupted` and `short`.
- Resume is `designProjects:run` with `resumeRunId`. It creates a new run record and a new turn on the same hidden chat.
  - Cap: `requestedCount − set.screenIds.length`, recomputed from the manifest at click time.
  - Only the newest run of an unarchived set that is not full can be resumed.
  - It repeats the brief verbatim, defaults to the set's model, and drops the orphaned user message of the interrupted turn.
  - A render whose title duplicates an existing direction (ignoring case and whitespace) is refused as invalid.
  - Settled `render_artifact` effects are recovery-recorded before the turn (`acknowledgeRenderEffects`), so Pi's "do not repeat" boundary cannot contradict the manifest.
- `settleRun` is discard-only. It archives the incomplete set, deletes nothing and frees no quota.
- DS-1b banner: "Incomplete k/N · Resume · Discard". There is no Keep sheet. The cost line reads "Resume — asks <model> for K more directions (one new request turn)". The cap and default model come from `designResumeOffer`.
- Known limitation: a duplicated project does not carry resumable runs.

## 6. IPC, notifications and gating

- Ten channels, all `ipcMain.handle`: `designProjects:list`, `get`, `create`, `duplicate`, `mutate`, `previewDelete`, `delete`, `run`, `previewSrc`, `readSource`.
  - Owner checks: `rendererDocumentOwner` for projects and previews, `chatGenerationOwner` for runs.
  - Store refusals come back as `{ ok: false, reason, message }`. The reasons are `invalid`, `quota`, `busy`, `not_found`, `stale` and `unavailable`. The client turns them into `DesignIpcError`.
- Notifications:
  - `designProjects:changed` `{ projectId, revision }`, throttled at 150 ms per project.
  - `designProjects:run-changed` `{ projectId, runId, status, acceptedRevisionIds }`, sent on each acceptance and on settle.
  - A deleted project's change broadcast carries `revision: 0`, because `get` returns nothing for it. DS-1b must treat a missing project as removed (re-read `get`, which returns `not_found`), not as revision 0.
- Gating: `designStudioEnabled()`, which reads `AIDEN_EXPERIMENTAL_DESIGN_STUDIO` set to `1` or `true`.
  - Off: no store directory, no manifest read, no chat write, and no handler registration (`main/handlers/index.ts`).
  - The preload allowlist lists both notification channels unconditionally, because they are static.
- DS-1b consumes `designProjectsApi` and `subscribeGenerationStream`. It must subscribe first and invoke `designProjects:run` second, so no opening tokens are dropped.

## 7. ADR deviations (accepted by the plan author, 2026-10-07)

The plan header lists eight deviations: parsers in main; authority in `resolveGenerationProfile`; `DesignRunBinding` carries the extension and settle; nine `llm-client` sites with an allowlist backstop; a main-side hidden chat with a fixed id; `outputCap`; checksum on read; and one test line renamed. The list is in `.superpowers/sdd/design-studio-ds1a-tasks/plan-header.md` in the orchestration worktree.

## 8. Open items

- The owner-attended live smoke (real provider requests, interrupt, relaunch and Resume) has not been run. It needs an explicit go-ahead because it spends money.
- The dev-profile launch check has not been run: with the flag off there should be no `design-projects` directory, and with it on there should be one. The macOS dev launcher uses the real dev profile, so it is the owner's to run.
- Quotas are to be revisited after the owner tests real projects. Mobile Design is a separate decision. Project chats stay hidden everywhere through DS-3.
- Low priority, no action yet: the design-id and run-status helpers are duplicated across modules; `llm-client` and the harness keep growing; the store gives the renderer no availability signal.
- The chat-removal handler wiring (`rejectFeatureOwned` in `main/handlers/chats.ts`) is covered only by a source grep in `subagent-phase3-contract.test.ts`. Add a behavioral handler test when feasible. The service behavior is covered in `chat-application-service.test.ts`.
- Next: DS-1b (Studio UI, React Grab vendoring and design CSP as DS-1.3, Playwright).
