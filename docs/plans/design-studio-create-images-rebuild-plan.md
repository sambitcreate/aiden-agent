# Design Studio + Create Images Rebuild Plan

> **For agentic workers:** This is the orchestration (umbrella) plan. Each phase below gets its own bite-sized TDD task plan (`docs/plans/<track>-phase-<n>-tasks.md`) written immediately before that phase executes, against the then-current `main`. REQUIRED SUB-SKILL for execution: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: Active — owner approved direction 2026-10-07
Date: 2026-10-07

**Owner decisions (2026-10-07):**
1. Create Images generates through **Pi image models** (`generateImages`), with optional direct Google registration.
2. **Designer Mode folds into Design Studio** as DS-4 "Connected app"; `designer-mode-plan.md` is superseded.
3. **Studio Foundation PR lands first**, then the DS and CI tracks run in parallel.
4. The orchestrator **keeps going** through phases and asks the owner questions along the way. The owner is still needed for the live image acceptance (CI-1.10) and for merges.
Baseline: `main` @ `bd232b85` (0.54.0 + #368)
Old work (read-only references):

| Mode | Old branch | Old tip | PR | Reference worktree |
|---|---|---|---|---|
| Design Studio | `feature/stitch-design-studio` | `577d17af` | #85 (closed, unmerged) | `.claude/worktrees/ref-design-studio` |
| Create Images | `feature/create-images-node-banana-parity` | `1e3b3909` | #37 (closed, unmerged) | `.claude/worktrees/ref-create-images` |

Both branches forked at `c8c09e0d` (2026-09-21) and are **722 commits behind** `main`. Since then main has changed 1,868 files (+450k/−198k).

**Goal:** Ship Design Studio and Create Images on current `main` as small, flag-gated, well-tested features. Keep the product ideas and the good pure logic from the old branches. Leave behind their architecture, tests, and over-engineering.

**Architecture:** Use fresh branches from `main` and port selectively, rather than merging. A shared **Studio Foundation** lands first and owns every shared core hotspot once: flags, routes, sidebar entries, canvas kit, asset store, privileged scheme, and test lanes. After that, the two feature tracks run in parallel in their own worktrees, each touching mostly its own files.

**Tech stack:** Electron, React 19, TanStack Router (lazy routes), `@xyflow/react`, Pi 1.0.3 (`@earendil-works/pi-ai` image models; the `pi-agent-core` `finishTurn` hook), `node:sqlite`, `main/services/durable-fs.ts`, Node `node:test` + Testing Library + Playwright.

---

## 1. Why we are rebuilding instead of merging

The full audits were run read-only against both branch tips and current `main`.

### 1.1 Design Studio (`feature/stitch-design-studio`)

**The idea is good.** It offers:
- Durable local Screen projects.
- Explore (2–4 directions) and Refine (one immutable revision).
- Element selection into the composer.
- Inspector tabs: Preview / Code / History.
- `DESIGN.md` design language.
- Prototype links.
- Deterministic export.
- A "Connected app" mode that already covers the planned [Designer Mode](designer-mode-plan.md) MVP.

**The implementation does not fit current main:**

| # | Problem | Evidence |
|---|---|---|
| 1 | The Studio is grafted onto ChatPane (`presentation="design"`). | `chat-pane.tsx` +1,542/−504 and ~229 Design references. Main has changed that file by +1,231/−542 since the fork, the worst merge surface in the app. |
| 2 | God component. | `design-workspace.tsx` is 4,761 lines. One component holds 75 `useState`, 27 effects and 48 direct IPC calls. |
| 3 | The run hook is broken on current Pi. | `generative-ui-extension.ts` and `pi-agent-runtime-harness.ts` use `shouldStopAfterTurn`, which Pi 1.x removed. Migrate to `finishTurn → { action: "end" }`. |
| 4 | Tests violate AGENTS.md. | ~660 `readFileSync` + `assert.match` source-grep assertions across 8 new files plus existing contract tests. (The rule landed in #241, after the branch tip.) |
| 5 | Pseudo-workspace leak. | Project chats hide behind the sentinel `"design-projects"` workspace, so exclusion filters spread into 8+ core and Remote modules. |
| 6 | Over-engineering for an unshipped feature. | V1+V2 schemas and a migration for data that never shipped. ~9k LOC of journals and recovery. 20+ distinct hash concepts. 23 private copies of validators. |
| 7 | IPC sprawl. | ~72 `designer:*` channels in one 2,123-line handler, which would add ~30% to the app's IPC surface. Code in Phases 4–6 is golfed into lines of up to 398 characters. |
| 8 | Product ceiling. | A project is one chat, so it inherits the per-chat generative-UI quota of 40 artifacts / 8 MiB. Explore exhausts a project in roughly 10–20 turns. |
| 9 | Performance. | Reference images are stored as base64 inside a JSON DataStore of up to 96 MB that is rewritten on every mutation. React Flow and every panel load eagerly in the chat route. |
| 10 | No kill switch, design-guide gaps. | No feature flag. Accent focus outlines, custom radii, raw `<button>`s, and prototype authoring by typed CSS selector. |

### 1.2 Create Images (`feature/create-images-node-banana-parity`)

**The idea is good.** It brings a Node Banana–style node canvas for image generation:
- Prompt, image input, generate, output, gallery, compare, annotation, and groups.
- Templates, prompt variables, and batching.
- Explicit paid consent, with no automatic paid retries.

**The implementation does not fit current main:**

| # | Problem | Evidence |
|---|---|---|
| 1 | It never produced a real image. | Both authorized live Gemini attempts failed (`request_rejected`, `output-invalid`). About 20k LOC of parity features were stacked on an unvalidated provider path. |
| 2 | Ungated, app-wide security changes. | `main-window.html` CSP removes `https:` from `connect-src` and `file:` from img/media for the whole app. A global `session.defaultSession.webRequest.onBeforeRequest` egress guard needed a favicon exception bolted on. The privileged-scheme call `registerSchemesAsPrivileged` runs twice. |
| 3 | Quadratic journal. | Each append copies the event array and re-parses the whole journal, SHA-256s the full JSON, writes to two event logs plus a pending file with ~20 fsyncs, and ~15–20 `lstat` checks. Appends take 21/57/114 s at 100/250/500 nodes, and the perf test thresholds (45/105/240 s) legitimize that. |
| 4 | God files. | 21 production files exceed 800 lines. `run-journal-store.ts` is 4,311 lines; `workflow-canvas.tsx` 4,152; `create-images-view.tsx` 3,632 (77 `useState` across the two views). |
| 5 | Tests violate AGENTS.md. | ~580 source-grep assertions (335 in `feature-surface.test.ts`). No Playwright e2e and no render test of either main view. |
| 6 | Redundant provider stack. | A hand-rolled `fetch` Gemini Interactions client with 24 hard-coded `"gemini"` branches in the coordinator. Main now has Pi `models.generateImages`, `registerImagesApiProvider`, 59 image models, reference-image resolution, usage accounting and artifact staging. |
| 7 | Test and debug machinery in production. | The packaged acceptance runner calls `executeJavaScript`. Stress fixture routes, a production mock provider, a source-fingerprint packaging step, rate limits on Aiden's own renderer, a forced external workspace folder with Finder sync, and a sandboxed decoder window plus a `sips` fallback. |
| 8 | Coupling and UX defects. | The quit dialog says "mock runs cost $0" even during live runs. Main calls a renderer global through `executeJavaScript`. `Command+D` is globally reserved. Selection cards have bordered and accent borders. The onboarding tile advertises a feature that is off by default. |

### 1.3 Main drift that blocks a merge

These parts of main were rewritten since the fork. Neither branch's integration code applies.

- **Router:** `lazyRouteComponent` with capability routes.
- **Sidebar:** unified workspace sidebar, paired hosts, needs-attention view.
- **Build:** `scripts/build-electron.mjs` is now `electronBuildOptions({ production })`.
- **Tests:** registered in `package.json` `test:serial` / `pretest:serial` and `scripts/ci-test-registry.json`; the old `pretest` chain is gone.
- **IPC:** `main/handlers/ipc-contract.test.ts` is now an AST-based exact inventory.
- **Startup:** startup IPC admission holds `ipcMain.handle` until reconciliation finishes.
- **Pi:** 0.84 → 1.0.3.
- **Remote:** protocol revision is now 24, with multi-host, peer and chat-fork projections.

Earlier merges of these branches already produced 24, 13 and 26 conflicts at a fraction of today's drift.

**Decision: (b) fresh branches from `main`, porting selectively file by file.** Anything ported must pass the current rules before it lands.

---

## 2. Global constraints

These apply to every task in every track.

- **No merge of the old branches.** Port by reading from `ref-*` worktrees. Never `git merge` or cherry-pick the old tips wholesale.
- **Feature flags:**
  - Both features ship behind app capabilities, **default off**: `designStudio` and `createImages`, exposed through `renderer/lib/app-capabilities.tsx`.
  - Use main's existing env and flag pattern (as with devices and geminiLive).
  - No onboarding tile until a flag defaults on.
- **Routes and code splitting:**
  - All feature routes use `lazyRouteComponent`; feature CSS is imported only by the lazy route.
  - `npm run check:bundle-budget` must stay green (entry + modulepreloads ≤ 3,520,000 B raw / 1,075,000 B gzip).
- **IPC:**
  - Each feature owns its own handler files under `main/handlers/<feature>/` and its own client module on `renderer/lib/ipc-bridge.ts` (not in the 1,705-line `renderer/lib/ipc.ts`).
  - Budget: **≤ 25 invoke channels per feature** at MVP; the orchestrator must approve going over.
  - Validators use `main/shared/guards.ts` (`isRecord`, `hasExactKeys`) and the `rendererDocumentOwner` checks.
  - Only `ipcMain.handle`: no `ipcMain.on`, `sendSync` or MessagePorts (they bypass startup admission).
- **Storage:**
  - New persistence uses `main/services/durable-fs.ts` (`writeFileAtomic` / `writeJsonAtomic`) or `node:sqlite` following `main/services/durable-jobs/store.ts`.
  - No base64 blobs inside JSON stores.
  - No dual-copy / hash-chain journals unless an ADR justifies them.
  - Stores initialize inside the `main/index.ts` reconcile chain, before `openProcessStartupIpcAdmission()`.
- **Network and security:**
  - No CSP edits to `main-window.html` without an explicit ADR line.
  - No global `webRequest` listeners.
  - One `registerSchemesAsPrivileged` call for all custom schemes.
  - Provider traffic only on explicit user action, with consent.
  - No models.dev, Artificial Analysis or OpenRouter-benchmark calls (AGENTS.md network posture).
- **Agent runtime:**
  - Design generation uses a capability/tool profile, not scattered `!design` checks in `llm-client.ts`.
  - Stop hooks use Pi 1.x `finishTurn` (`{ action: "end" }`, guarding error and aborted turns).
- **Chat visibility:** any hidden, feature-owned chat goes through one central visibility predicate. No new sentinel workspace IDs sprinkled across Remote and listing code.
- **Tests (AGENTS.md):**
  - Behavioral only: no source-grep, change-detector or tautological tests.
  - Register every new file in `package.json` `test:serial` and in `scripts/ci-test-registry.json`.
  - Playwright specs must pass on Linux xvfb (gate macOS-only behavior).
  - Never weaken `--fail-on-flaky-tests`.
- **Code shape:**
  - No production file over ~800 lines, and no React component over ~400 lines.
  - Normal formatting, with no golfed one-liners.
  - Logic lives in pure `*-core.ts` modules with Electron-free imports, because the CLI bundles `main/services` and `renderer/shared`.
- **UI:**
  - Follow `docs/design-guide.md` and review `docs/chatgpt-desktop-ui-inspiration.md` + `docs/chatgpt-ui-element-specimen.html` before UI work.
  - Use the shared squircle `Button` and semantic tokens from `renderer/styles.css` / `renderer/shared/appearance.ts`.
  - No borders on radio or selection cards and no colored status borders.
  - The neutral focus-ring token on non-text controls; no focus ring on text inputs.
  - Settings follow `docs/settings-design-system.md`. No brain icons.
- **Platform:**
  - macOS-only paths are gated with `hostPlatformCapabilities()`.
  - Accelerators come from `renderer/shared/keybindings.ts`'s platform-aware helpers.
  - No new globally reserved shortcuts.
- **Dependencies:**
  - Pin exactly, including `@xyflow/react` and `react-grab` (no caret on 0.x).
  - Renderer-only packages go in `devDependencies`. Main/preload packages go in `dependencies` and must pass `scripts/main-runtime-dependencies.test.mjs` and the packaged-slimness check.
  - Regenerate `THIRD_PARTY_NOTICES.md` when adding any.
- **PRs and CI:**
  - One PR per phase.
  - Update a branch with an open PR by merging `origin/main` into it; never rebase or force-push it.
  - Run the narrow suites locally before CI.
  - Merge only on green CI at the exact head. At most one rerun for a flake, and record it in the PR.
- **Docs:** update `docs/plans/README.md` and `.memory/` whenever a phase lands.

## 3. Review focus

These failure modes are not exercised by any single task's happy-path tests. Each one becomes a named test in the task that owns the code.

1. **Restart mid-run.**
   - *Expected:* quitting during an Explore or an image run leaves a consistent project or workflow on relaunch. In-flight work shows as *interrupted*, with no automatic resubmit and **no second paid request**.
   - *Owner:* DS-1 store and CI-1 run ledger tests, plus a Playwright relaunch spec per track.
2. **Hidden chats leaking.**
   - *Expected:* a Design project's backing chat never appears in the sidebar, search, Remote summaries, the multi-host feed, peer desktops, chat fork, Bots or native clients.
   - *Owner:* F-3 central visibility predicate, with tests through each projection. Run the iOS/Android contract suites.
3. **Flag off means no trace.**
   - *Expected:* with both flags off, the app behaves exactly like `main`: no routes, sidebar rows, commands, settings sections, IPC side effects, CSP changes or bundle growth in the entry chunk.
   - *Owner:* F-1 / F-2 rendered-sidebar and router tests, plus a bundle-budget check.
4. **Consent and cost.**
   - *Expected:* no provider request ever leaves without an explicit consent naming provider, model and request count. Batch and retry never silently multiply requests. A cancelled consent sends nothing.
   - *Owner:* CI-1 consent core tests with a fake image API that counts requests.
5. **Scale.**
   - *Expected:* a 500-node workflow and a 200-revision Design project open, save and run without multi-second stalls. Journal or ledger overhead for a 500-node run stays under 1 s, and memory stays bounded.
   - *Owner:* CI-1 ledger perf test with a tight threshold, and a DS-1 store perf test. Timing tests go in a separate perf lane and are not in the default pretest.

---

## 4. Worktree and branch layout

All work happens in worktrees under `/Users/sambitbiswas/projects/aiden-macos/.claude/worktrees/`.

| Worktree | Branch | Base | Purpose | Lifetime |
|---|---|---|---|---|
| `design-studio-image-gen-upgrade-74e137` (this one) | `feature/design-studio-image-gen-upgrade-74e137` | `main` | Orchestration: this plan, ADRs, per-phase task plans, index/memory updates | Until both tracks ship |
| `ref-design-studio` | detached @ `577d17af` | – | **Read-only** port source for Design Studio | Delete after DS-4 |
| `ref-create-images` | detached @ `1e3b3909` | – | **Read-only** port source for Create Images | Delete after CI-3 |
| `studio-foundation` | `feature/studio-foundation` | `main` | Track F: shared flags, routes, sidebar, canvas kit, asset store, scheme, test lanes | Until F merges |
| `design-studio-v2` | `feature/design-studio-v2` (then `-p2`, `-p3`…) | `main` after F merges | Track DS phases | Per phase PR |
| `create-images-v2` | `feature/create-images-v2` (then `-p2`…) | `main` after F merges | Track CI phases | Per phase PR |
| `designer-connected-app` | `feature/design-studio-connected` | `main` after DS-2 | Track DS-4 (Designer Mode) | Later |

Rules:
- Each phase is one PR from its own branch. The next phase branches from `main` after the previous phase merges. If a phase must stack before its predecessor merges, it uses that predecessor's branch as its PR base. Never delete a base branch while a stacked PR uses it.
- Feature branches are updated by **merging `origin/main` in**; they are never rebased.
- The old remote branches `feature/stitch-design-studio` and `feature/create-images-node-banana-parity` stay untouched as an archive.

## 5. Orchestration model

```
              ┌──────────── Phase 0: ADRs (this worktree) ───────────┐
              │  ADR-DS, ADR-CI, ADR-F; per-phase task plans          │
              └───────────────────────────┬──────────────────────────┘
                                          ▼
                     Track F  Studio Foundation  (1 PR, merges first)
                                          │
                ┌─────────────────────────┴─────────────────────────┐
                ▼                                                   ▼
   Track DS (worktree design-studio-v2)          Track CI (worktree create-images-v2)
   DS-1 generated-prototype core                 CI-1 MVP canvas + real images
   DS-2 export + Design Language                 CI-2 iteration loop
   DS-3 references & image nodes  ◄──── uses ──── CI image-gen service (after CI-1)
   DS-4 Connected app (Designer Mode)            CI-3 parity extras (gated each)
   DS-5+ gated extras                            CI-4 release readiness
```

- **Orchestrator** (me, in this worktree):
  - Writes the ADRs and per-phase task plans.
  - Creates the worktrees and dispatches implementer subagents with the worktree path and task text.
  - Serializes shared hotspots, merges `main` into the active branches after every landing, and keeps `docs/plans/README.md` and `.memory/` current.
- **Implementers:** one fresh subagent per task, working only inside its track worktree and following TDD (failing behavioral test → implementation → green → commit).
- **Reviewers:**
  - Per task: a fresh spec-compliance reviewer and a code-quality reviewer before the next task starts.
  - Per phase: a whole-branch review (`/code-review high`, `pr-review-toolkit` silent-failure and type-design passes) and an optional Codex second opinion, before the PR opens.
- **Parallelism:** DS and CI run concurrently after F merges. Within a track, tasks run one after another, because they share interfaces.
- **Hotspot serialization.** The files below are edited only in Track F, or by the orchestrator in a tiny "registration" commit:
  - `package.json` (test chain; resolve by union)
  - `scripts/ci-test-registry.json`
  - `renderer/preload-channels.ts`
  - `renderer/main/router.tsx`
  - `renderer/components/chat-sidebar.tsx`
  - `renderer/shared/settings-section.ts`
  - `renderer/main/settings-view.tsx`
  - `renderer/components/onboarding-flow.tsx`
  - `main/index.ts`
  - `main/handlers/index.ts`
  - `renderer/lib/app-capabilities.tsx`
  - `renderer/shared/keybindings.ts`
  - `docs/plans/README.md`

  Feature tracks never both edit one of these in the same window.
- **Local gates before any PR:** the phase's narrow suites, `npm run typecheck` (or the repo's tsc script), lint, `npm run build` + `check:bundle-budget`, the affected Playwright specs, and the Remote/native contract suites when chat listing or Remote is touched.

---

## 6. Phase 0: Decisions and ADRs (orchestrator, this worktree)

**Deliverables:** `docs/plans/design-studio-adr.md`, `docs/plans/create-images-adr.md`, `docs/plans/studio-foundation-adr.md`, each one page.

- [x] **ADR-F (foundation)**
  - **Flags:** `designStudio` and `createImages` capabilities, default off.
  - **Navigation:**
    - Design and Images rows in the sidebar primary nav (no group heading), alongside New Agent / Scheduled / Bots.
    - Lazy `/design…` and `/images…` routes **under** the chat layout so the sidebar stays visible; `chat-layout.tsx` gets one `isStudioPath` check that suppresses the Environment panel and terminal there (ADR-F supersedes the earlier root-route idea, which would have hidden the sidebar).
  - **Canvas kit:** shared `renderer/canvas/` on `@xyflow/react` (pinned): viewport, tool rail, node chrome, selection, keyboard map, minimap toggle.
  - **Asset store:**
    - Shared `main/services/studio-assets/`: content-addressed files under userData, magic-byte and pixel validation (ported `asset-image-validation-core.ts`), thumbnails via `nativeImage`, ref-counted GC.
    - The `aiden-asset:` protocol with document-bound grants (ported `asset-delivery-core.ts`), registered in the **same** `registerSchemesAsPrivileged` call as `aiden-genui:`.
  - **Chat visibility:** a `isUserVisibleChat()` / chat `owner` predicate that replaces the ten scattered `ASSISTANT_WORKSPACE_ID` exclusions.
  - **Tests:** npm suites (`test:chat-visibility`, `test:studio-foundation`, later `test:design-studio`, `test:create-images`) filed into the existing CI lanes; no new lanes (ADR-F).
- [ ] **ADR-DS (Design Studio)**
  - **Ownership:** a project is a first-class record that *owns* a hidden chat via the `owner` field, not a sentinel workspace.
  - **Storage:**
    - Project manifest JSON via `writeJsonAtomic`, one file per project.
    - Revision HTML as files, plus reference images in the shared asset store.
    - One schema version (v1) with no migration code.
  - **Quota:** a project-scoped artifact quota replaces the per-chat 40/8 MiB ceiling.
  - **Tool profile:** a `design` capability profile in the agent runtime with the tool allowlist (`render_artifact`), a `finishTurn`-based stop and a bounded context builder.
  - **IPC budget:** ≤ 25 channels, using an op-based `designProjects:mutate` with a discriminated union in place of many CRUD channels.
  - **Designer Mode:** folded in as DS-4. Mark `designer-mode-plan.md` *superseded by this plan*, and keep its Phase 0 GO gate, Vite-first scope and license-provenance ledger as DS-4 entry criteria.
  - **Dropped:**
    - V1→V2 and legacy-chat migrations
    - CDP prototype verification
    - export-history store
    - handoff V2 journal and effect store (handoff reuses main's managed-worktree service later)
    - multi-file transactions until re-justified
- [ ] **ADR-CI (Create Images)**
  - **Provider:**
    - Generate through **Pi image models** (`models.getAvailableOfType("image")`, `models.generateImages`), the same path as main's `generate_image` tool in `main/services/pi-model-tools.ts`. Any configured image-capable provider works (OpenRouter today).
    - All 59 bundled image models are OpenRouter's; bundled Google has none. `registerImagesApiProvider` only feeds Pi's standalone `generateImages()`, so direct Google needs a wrapped provider (as `concentrate-provider.ts` does), reusing the `main/services/tts/credentials.ts` saved-key / dedicated-key pattern (fails closed). **Deferred to CI-2** (owner has an OpenRouter key).
  - **Consent:** preview naming provider, model, request count and estimate (or "unknown"); expiry; a request counter enforced in main. **Owner caps for CI-1: 1 request per node, ≤ 4 per run.**
  - **Run ledger:** `node:sqlite` with one row per node attempt and O(1) append, modeled on `durable-jobs/store.ts`. Restart marks in-flight attempts `interrupted`.
  - **Workflow docs:** JSON via `writeJsonAtomic` with debounced autosave.
  - **Assets:** the shared studio asset store.
  - **Progress:** a throttled notification (`createThrottledTrigger`) with a full snapshot on subscribe. No projection cache or revision fences.
  - **Dropped:**
    - CSP edits, the egress guard and the favicon exception
    - acceptance runner, source fingerprint and lazy-boundary verifier
    - the production mock provider (a fake image API is registered **only in tests and e2e**)
    - renderer rate limits, the external workspace folder and Finder sync
    - decoder window and `sips`
    - stress routes and spike fixtures
- [ ] Owner review and approval of the three ADRs (gate).
- [x] Write `docs/plans/studio-foundation-tasks.md` (TDD task plan for Track F).

**Exit:** the ADRs are approved, the Track F task plan exists, and `docs/plans/README.md` lists this plan as Active with Designer Mode marked superseded.

---

## 7. Track F: Studio Foundation (worktree `studio-foundation`, one PR)

| Task | Deliverable | Key files | Behavioral tests |
|---|---|---|---|
| F-1 Capabilities and flags | `designStudio` / `createImages` capabilities, default off | `main/handlers/app.ts`, `renderer/lib/app-capabilities.tsx` | Capability read with env on/off; render tests show nothing when off |
| F-2 Routes, sidebar, commands | Lazy `/design`, `/images` routes under the chat layout with placeholder views; sidebar Design and Images rows; `design.open` / `images.open` commands (no default binding); capability-route redirect to `/` | `router.tsx`, `chat-sidebar.tsx`, `keybindings.ts`, `command-system-core.ts`, new `renderer/main/design-route.tsx`, `images-route.tsx` | Rendered sidebar with each flag combination; router redirect when off; palette visibility; bundle budget unchanged |
| F-3 Chat visibility predicate | `isUserVisibleChat(chat)` (or the `owner` field) replacing the scattered `ASSISTANT_WORKSPACE_ID` exclusions, applied in every listing/Remote/peer/fork projection | `chat-workspace-authority.ts`, `aiden-remote-chats.ts`, `aiden-remote-host-feed.ts`, `chat-fork-service`, `main/handlers/chats.ts`, … | Per-projection tests: a hidden chat is absent from the sidebar list, Remote summary, host feed, peer list, fork, search; existing Assistant behavior unchanged. iOS/Android contract suites run. |
| F-4 Shared asset store and protocol | `main/services/studio-assets/` (content-addressed put/get/thumb/GC) and the `aiden-asset:` protocol with document-bound grants, in one privileged-scheme registration | new `studio-assets/*-core.ts`, `generative-ui-protocol.ts` (shared registration), `main/index.ts` reconcile chain | Put/dedupe/GC/ref-count; invalid magic bytes and oversize pixels rejected; grant bound to document and revoked on navigation; both schemes privileged (register-and-invoke) |
| F-5 Canvas kit | `renderer/canvas/` on pinned `@xyflow/react`: `<StudioCanvas>`, tool rail, node chrome, keyboard map, fit/zoom | new files; CSS imported only by lazy routes | Testing Library render plus keyboard tool switching; Playwright smoke for pan/zoom/select on the placeholder route |
| F-6 Test suites and docs | npm suites filed into existing lanes in `ci-test-registry.json`, `package.json` scripts, `.memory/studio-foundation.md`, plan index | registry, `package.json` | `test:ci-policy` / `validateRegistry` green |

**Exit:** with both flags off, behavior matches `main` (sidebar, router and bundle-budget evidence). With them on, two empty canvases render. F-3 passes on desktop and native suites. CI is green at the exact head, and the PR merges.

**Status (2026-10-07): implemented; PRs open.** Track F shipped as two PRs: PR A (F-3 chat visibility predicate, [#375](https://github.com/sambitcreate/aiden-agent/pull/375)) and PR B (F-1, F-2, F-4, F-5, F-6; this PR). Exit criteria met locally: with both flags off the sidebar, router and bundle budget match `main` (entry chunk 21526 B raw / 8249 B gzip before the canvas kit, 21594 B / 8284 B on the branch), and with both flags on two empty canvases render under the chat sidebar. The remaining exit item is CI green on the exact head of each PR before merge; this section moves to "landed" when both merge.

---

## 8. Track DS: Design Studio (worktree `design-studio-v2`)

### DS-1 Generated-prototype core (MVP)

**Scope:**
- **Project library:** create, rename, duplicate, delete, with the delete cascade preview.
- **Project route:** canvas of Screens and reference images.
- **Composer:** reuses the existing composer through a chat-turn hook, not a `presentation` flag on ChatPane.
- **Generation:** Explore 2–4 directions (keep draft / discard on cancel), Choose / Archive, Refine one immutable revision.
- **Inspector:** Preview / Code / History with compare.
- **Visual edit:** element selection via React Grab (pinned and vendored), inserting chips as untrusted context.

| Task | Deliverable | Port from `ref-design-studio` |
|---|---|---|
| DS-1.1 Project store | One-schema manifest, revision files, project quota; initialized in the reconcile chain | Ideas from `design-project-store.ts` / `design-project-contract.ts` (rewrite, no V2) |
| DS-1.2 Design tool profile | `design` capability profile, `render_artifact` only, `finishTurn` stop, 128 KiB bounded context, earlier HTML marked untrusted | `generative-ui-extension.ts` changes, migrated to Pi 1.x |
| DS-1.3 Generative-UI design CSP and vendoring | Design guest CSP + React Grab primitives, pinned | `generative-ui-html/protocol/host-libraries` diffs, `scripts/vendor-generative-ui-libs.mjs` (main's copies are nearly unchanged; ports cleanly) |
| DS-1.4 IPC | `main/handlers/design/*.ts` (≤ 25 channels) and `renderer/lib/design-ipc.ts` | Rewrite of `designer.ts` |
| DS-1.5 Canvas and nodes | `renderer/design/` components (Screen node, reference node, tool rail) and hooks `useDesignProject`, `useDesignSelection`, `useDesignPreview` | Split of `design-workspace.tsx`; `renderer/shared/design-selection.ts` ported as-is |
| DS-1.6 Explore / Refine flows | Direction sets, choose/archive, refine lineage, cancelled-run prompt | `design-workspace.ts` logic (pure parts) |
| DS-1.7 Inspector | Preview / Code / History tabs with shared `Button` and tokens | `design-project-inspector.tsx` (restyle) |
| DS-1.8 E2E | Playwright: create → explore (fake model) → choose → refine → relaunch → state intact; flag off → no route | – |

**Exit:**
- All new tests are behavioral, and new files are ≤ 800 lines.
- No `design` checks scattered through `llm-client.ts`.
- `check:bundle-budget` is green with React Flow lazy.
- Remote/native suites show project chats are invisible.
- The relaunch Playwright spec passes on macOS and Linux xvfb.

### DS-2 Export and Design Language

- Port `design-project-export-core.ts` (deterministic ZIP, path normalization, portable-HTML assertion) and its tests, nearly as-is.
- Port `design-language-core.ts` (`DESIGN.md` subset) for import, export, derive-from-Screen and reviewed apply, all inside the inspector (no stacked accordions over the composer).
- Replace the single-regex secret scrubbing with an explicit allowlist of exported fields.

**Exit:** byte-identical export across runs; malicious `DESIGN.md` and ZIP-path fixtures fail closed; e2e covers export and apply.

### DS-3 Reference and image nodes (after CI-1 lands)

- Upload reference images into the shared asset store.
- An optional "Generate image" on a Screen or reference node calls Create Images' image-generation service, with the same consent sheet.

**Exit:** the consent e2e passes, and no provider call is made without consent.

### DS-4 Connected app (Designer Mode MVP; worktree `designer-connected-app`)

**Entry gate:** a written GO on the Designer Mode Phase 0 criteria (containment and DOM↔source identity on the `tests/fixtures/source-design-vite` fixture).

**Scope:**
- Vite + React only.
- The user explicitly starts the dev server, with a **scrubbed env** (no provider keys) and `shell:false`.
- Loopback proxy + websocket proxy (port `source-preview-transport-core.ts` and `source-preview-websocket-proxy.ts` with their tests).
- `frame-src` scoped by ADR.
- Exact JSX binding (port `design-source-graph-core.ts` and `renderer/shared/source-designer.ts`).
- Single-file Designer Action proposal → review → Apply → exact Undo (port `source-designer-actions.ts` with review).
- A provenance ledger for React Grab and Onlook ideas.

**Exit:** fixture-repo browser test proves exact binding, an untouched tree before approval, and exact undo. No whole-worktree staging.

### DS-5+ Gated extras (each re-justified, with its own exit tests)

- Comments
- Prototype links with click-to-pick (no typed selectors) and Play (no CDP)
- Workspace handoff through main's managed-worktree service
- Multi-file actions
- Next.js adapter
- Design-system snapshots

---

## 9. Track CI: Create Images (worktree `create-images-v2`)

### CI-1 MVP that actually generates images

**Scope:**
- **Nodes:** Prompt, Image Input, Generate Image, Output (with an inline mini-gallery).
- **Templates:** Blank and Starter.
- **Graph rules:** typed ports and cycle validation.
- **Persistence:** debounced autosave.
- **Run controls:** Run all / Run from here / Stop.
- **Consent:** sheet naming provider, model and request count.
- **Restart:** marks in-flight attempts as interrupted.

| Task | Deliverable | Port from `ref-create-images` |
|---|---|---|
| CI-1.1 Graph schema and ports | Trimmed `schema.ts`, `ports.ts` (typed ports, cycles), `editor-core.ts`, `node-dimensions-core.ts` with their behavioral tests | Port nearly as-is |
| CI-1.2 Workflow store | JSON per workflow via `writeJsonAtomic`, index, debounced autosave | Rewrite of `workflow-manifest-store.ts` (drop `autosave.journal`) |
| CI-1.3 Run ledger | `node:sqlite` attempts table, O(1) append, interrupt-on-restart, retention of 100 runs | Rewrite of `run-journal-store.ts` (4,311 lines → target < 400) |
| CI-1.4 Scheduler and coordinator | Topological scheduler with cancellation; coordinator < 600 lines, provider-agnostic | `scheduler-core.ts` (port), `run-service.ts` (rewrite) |
| CI-1.5 Image provider adapter | Wraps Pi `generateImages` and reference images (`pi-model-image-references.ts` bounds); usage via `modelOperationUsageRecord`; fake image API for tests only | Replaces `gemini-image-provider-core.ts` / `gemini-interactions-core.ts` / production mock |
| CI-1.6 Consent core | Consent plan (provider, model, count, estimate/unknown, expiry), enforced in main; no automatic paid retry or fallback | Ideas from `image-provider-execution-core.ts` (shrink) |
| CI-1.7 IPC | `main/handlers/create-images/*.ts` (≤ 15 channels), `renderer/lib/create-images-ipc.ts`, one throttled `imageWorkflows:run-changed` notification | Rewrite of the 2,195-line handler and 1,502-line `ipc.ts` |
| CI-1.8 Canvas UI | `renderer/images/` on the canvas kit: node registry, one file per node, `useWorkflowController` hook, run panel, consent sheet; no bordered selection cards | Split of `workflow-canvas.tsx` / `create-images-view.tsx` |
| CI-1.9 Perf and e2e | Ledger perf test (500-node run < 1 s overhead) in a perf lane; Playwright build → run (fake API) → output visible → relaunch → interrupted state → rerun after fresh consent | – |
| CI-1.10 Live acceptance (owner-attended) | One real image end to end on the owner's machine with their key, recorded in the evidence doc | – |

**Exit:**
- CI-1.10 has produced a real image.
- All tests are behavioral, and new files are ≤ 800 lines.
- Bundle budget is green.
- No CSP changes, global `webRequest` listeners or production mock.

**Scope-cut rule:** nothing from CI-2 starts until CI-1.10 passes.

### CI-2 Iteration loop

- Lightbox and A/B compare node (port `image-lightbox-core.ts`).
- Recent-outputs shelf (port `recent-output-core.ts`), and reusing an output as an input.
- Download / Reveal in Finder (platform-gated).
- History pruning and asset GC.
- Copy/paste (port `graph-fragment-core.ts`), and a node menu when a connection is dropped.
- Keyboard and accessibility pass.
- **Chat bridge:** "Open in Images" from a chat `generate_image` result, and "Send to chat" from an Output node.
- Settings → Images page following `settings-design-system.md`: navigation preset and autosave.

**Exit:** a Playwright spec per flow, and a VoiceOver/keyboard checklist recorded.

### CI-3 Parity extras (each behind its own sub-flag, each with an e2e)

- Prompt List batching (≤ 8 with explicit count in consent; port `prompt-list.ts`)
- `${var}` prompt variables (port `prompt-variables.ts`)
- Groups
- Templates explorer (port `templates.ts`)
- Annotation (Konva spike first, pinned)
- Native `.aiden-images` archive import/export (port the hostile-ZIP tests)
- Node Banana JSON importer
- Chat-model workflow proposals (diff that the user applies, never auto-run)
- Edge breakpoints / pause, only if users ask

### CI-4 Release readiness

- Default-on decision.
- Onboarding bento tile with an optimized 1024² PNG (`npm run assets:onboarding`) and the asset test.
- Quit-dialog copy driven by the real in-flight provider state.
- Notarized-build smoke and populated-storage relaunch.

---

## 10. Sequencing and rough sizing

| Step | Depends on | Runs in parallel with | Relative size |
|---|---|---|---|
| Phase 0 ADRs | – | – | S |
| Track F | Phase 0 | – | M |
| DS-1 | F | CI-1 | L |
| CI-1 | F | DS-1 | L |
| DS-2 | DS-1 | CI-2 | M |
| CI-2 | CI-1 (incl. live acceptance) | DS-2 | M |
| DS-3 | DS-1, CI-1 | CI-3 | S |
| DS-4 | DS-2 + Designer Mode GO gate | CI-3 / CI-4 | L |
| CI-3 / CI-4, DS-5+ | prior phase | each other | M each |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Hotspot conflicts between tracks | Track F registers both features' slots up front; the orchestrator owns any later hotspot edits; merge `main` after each landing |
| Pi image-model coverage or quality is not good enough | ADR-CI allows registering a direct Google images API via `registerImagesApiProvider`; the provider adapter interface keeps the coordinator provider-agnostic |
| Design generation quality depends on model and prompt | DS-1 keeps model choice with the existing picker; the fake-model e2e covers flow while live quality is assessed by the owner at each phase |
| F-3 visibility refactor regresses the Assistant or Remote | Per-projection behavioral tests; native contract suites; F-3 can split into its own PR if the diff is large |
| Scope creep back to the old size | IPC and file-size budgets, scope-cut rules, and one PR per phase with an explicit exit checklist |

## 12. Port index (quick reference)

**Port nearly as-is**, after reformatting and checking that the tests are behavioral:
- **Create Images:**
  - `renderer/shared/create-images/` `ports.ts`, `templates.ts`, `prompt-variables.ts`, `prompt-list.ts`, `editor-core.ts`, `graph-fragment-core.ts`, `node-dimensions-core.ts`, `image-lightbox-core.ts`, `recent-output-core.ts`
  - `main/services/create-images/asset-image-validation-core.ts` and `asset-delivery-core.ts`
- **Design Studio:**
  - `design-project-export-core.ts`, `renderer/shared/design-selection.ts`, `design-language-core.ts`
  - `design-source-graph-core.ts`, `renderer/shared/source-designer.ts`
  - `source-preview-transport-core.ts`, `source-preview-websocket-proxy.ts`, `design-direct-edit-core.ts`
  - `design-prototype-core.ts` (deduplicate it against its renderer copy)
  - `tests/fixtures/source-design-vite`

**Rewrite:**
- Both handler files and IPC clients
- Both god components
- The project store and run journal
- Both run coordinators
- Provider layer
- Settings page
- All CSS (to tokens and squircle)

**Drop:**
- Everything listed under "Dropped" in ADR-DS and ADR-CI
- All source-grep tests
- Reformat churn in unrelated files
- `.papercuts/` edits
