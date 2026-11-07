# Design mode P0: retire Design Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the flagged Design Studio (hidden project chats, run service, generation profile, route, nav row, IPC) so design mode can be built on ordinary chats, without changing anything for normal chats or Create Images.

**Architecture:** This is a deletion PR. Renderer surfaces go first, then main services and IPC, then scripts and docs. Each task leaves the app building and the test chain green. Shared pieces that Studio introduced but others now use stay.

**Tech Stack:** Electron, TypeScript, React 19, TanStack Router, `tsx --test`, Playwright.

**Spec:** [`docs/superpowers/specs/2026-10-31-design-mode-design.md`](../specs/2026-10-31-design-mode-design.md) §7.

## Global Constraints

- Merge `origin/main` into the branch before starting. The worktree was cut before #656 to #683.
- Ordinary chat generation must behave exactly as before. `generation-harness.test.ts`, `pi-agent-runtime-harness-finish-turn.test.ts`, `ipc-stream.test.ts` and `generation-stream.test.ts` keep passing, minus their design-only cases.
- Keep: `renderer/canvas/*`, `main/services/studio-assets/*`, `createImagesEnabled`, the `/images` routes, Pi `finishTurn` support in `pi-agent-runtime-harness.ts`, `renderer/lib/generation-stream.ts`, and `parseChatOwnerV1` / `chatSurface` in `renderer/shared/chat-visibility.ts`.
- Do not migrate or delete Studio data on disk.
- `studioAssetsEnabled()` becomes `createImagesEnabled()`.
- Every removed test file is also removed from `package.json` and `scripts/ci-test-registry.json`. Run `npm run test:ci-policy`.
- Tests stay behavioral (AGENTS.md "Tests"). Do not add source-grep assertions.

## Review Focus

1. **Developer machines** with `AIDEN_EXPERIMENTAL_DESIGN_STUDIO=1` and existing hidden `design-project` chats. Those chats must stay out of the sidebar, Remote and copy surfaces. This is covered by the existing `chat-visibility.test.ts` owner cases, which must still pass unchanged.
2. **Old deep links:** opening a stale `/design` or `/design/<id>` URL (window restore, a deep link) must land on the chat home, not a blank route. The test is in Task 1.
3. **Create Images with Studio gone:** with `AIDEN_EXPERIMENTAL_CREATE_IMAGES=1`, the Images row, the `/images` canvas and the `aiden-asset:` protocol still work. This is covered by `test:studio-foundation` and `tests/e2e/studio-foundation.spec.ts`, updated in Task 1.
4. **Shutdown:** quitting must not wait on a removed "Design work" step or log a missing-service error. The shutdown test is in Task 2.
5. **⌘⇧D:** it must not be bound to anything after P0. P1 rebinds it, and the shortcut sheet test is updated in Task 1.

---

### Task 1: Remove the renderer Studio surfaces

**Files:**
- Delete: `renderer/design/design-route.tsx`, `renderer/lib/design-ipc.ts`, `renderer/lib/design-ipc.test.ts`, `renderer/shared/design/*`
- Modify: `renderer/main/router.tsx` (the `/design` routes, around lines 198–223), `renderer/shared/studio-routes.ts`, `renderer/main/root-view.tsx` (`openStudio`, `design.open`, around lines 204–215), `renderer/components/sidebar-primary-nav.tsx` (the Design row, around lines 79–86), `renderer/shared/keybindings.ts` (`design.open`, lines 30 and 287–295), `renderer/lib/app-capabilities.tsx` (drop `designStudio`), `renderer/preload-channels.ts` (the `designProjects:` prefix and its two events)
- Test: `renderer/shared/studio-routes.test.ts`, `renderer/main/studio-capability-route.test.tsx`, `renderer/components/sidebar-primary-nav.test.tsx`, `renderer/lib/app-capabilities.test.ts`, `renderer/lib/shortcut-sheet.test.ts`, `renderer/lib/command-system-core.test.ts`, `tests/e2e/studio-foundation.spec.ts`

**Interfaces:**
- Produces: `AppCapabilities` without `designStudio`. P1 adds `designMode`.
- Produces: the `design.open` keybinding id no longer exists. P1 adds `design.toggle`.

- [ ] **Step 1: Update the tests to the post-Studio contract.**
  - `studio-capability-route.test.tsx`: rendering `/design` and `/design/project-1` with every capability on redirects to the chat home. `/images` still renders the Images canvas when `createImages` is on.
  - `sidebar-primary-nav.test.tsx`: with `createImages: true`, the trailing rows are `["Images"]`, and no row is named "Design".
  - `shortcut-sheet.test.ts`: no entry uses ⌘⇧D.
  - `command-system-core.test.ts`: no "Open Design Studio" command exists for any capability set.
  - `tests/e2e/studio-foundation.spec.ts`: `STUDIO_CHUNK` drops `design-route`. "Design and Images open empty canvases" becomes "Images opens an empty canvas", expecting `["Images"]`.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npm run test:studio-foundation && npx tsx --test renderer/lib/shortcut-sheet.test.ts renderer/lib/command-system-core.test.ts`
  - Expected: FAIL. The Design row, the `/design` route and ⌘⇧D still exist.
- [ ] **Step 3: Delete the files and remove the references listed above.**
  - The `/design` paths become a redirect to `/`, the same way the router already handles an unknown studio path with the capability off.
- [ ] **Step 4: Run the tests and the type-check.**
  - Run: `npm run type-check && npm run test:studio-foundation && npx tsx --test renderer/lib/shortcut-sheet.test.ts renderer/lib/command-system-core.test.ts renderer/lib/app-capabilities.test.ts`
  - Expected: PASS. Type-check fails only on main-side `designStudio` references, which Task 2 removes. If it does, run Task 2 before committing.
- [ ] **Step 5: Commit** with the message `Remove Design Studio route, nav row and IPC client`.

### Task 2: Remove the main-process Studio services and IPC

**Files:**
- Delete: `main/services/design/*` (including `store.perf.test.ts`), `main/handlers/design/*`, `main/services/generation-profile.ts`, `main/services/generation-profile.test.ts`
- Modify:
  - `main/index.ts`: the imports at lines 118–120, `SHUTDOWN_BUDGET_MS.designWork` at lines 397 and 444, the shutdown step at lines 626–628, and the startup at line 2357.
  - `main/handlers/index.ts`: `registerDesignHandlers`, around line 62.
  - `main/services/llm-client.ts`: `designRun`, `designGenerationWiring`, `designRunOutcome`, and every `generationProfile.kind === "design"` branch.
  - `main/services/generation-harness.ts`: the `GenerationProfile` parameter.
  - `main/services/studio/feature-flags.ts`: drop `DESIGN_STUDIO_FEATURE_FLAG` and `designStudioEnabled`. `studioAssetsEnabled` returns `createImagesEnabled`, and `studioCapabilities` returns `{ createImages }`.
- Test: `main/services/studio/feature-flags.test.ts`, `main/services/generation-harness.test.ts`, `main/handlers/chat-renderer-mutations.test.ts`, `main/handlers/ipc-contract.test.ts`, the shutdown test that covers `SHUTDOWN_BUDGET_MS` (find it with `grep -rl SHUTDOWN_BUDGET_MS main --include=*.test.ts`)

**Interfaces:**
- Consumes: `AppCapabilities` without `designStudio` (Task 1).
- Produces: `studioCapabilities(env): { createImages: boolean }`. P1 extends it with `designMode`.
- Produces: `createGenerationHarness(...)` without a profile argument. Chat generations take the former `kind: "chat"` path unchanged.

- [ ] **Step 1: Update the tests.**
  - `feature-flags.test.ts`: `studioAssetsEnabled({ AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "1" })` is `false`; `studioAssetsEnabled({ AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1" })` is `true`; `studioCapabilities({})` deep-equals `{ createImages: false }`.
  - `generation-harness.test.ts`: delete the design-profile cases and keep every chat case unchanged.
  - The IPC inventory in `ipc-contract.test.ts` has no `designProjects:` channel.
  - The shutdown test's step labels do not include "Design work".
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/studio/feature-flags.test.ts main/handlers/ipc-contract.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Delete the files and remove the references.**
  - If `GenerationProfile` is left with only the chat variant, delete the type and the parameter rather than keeping a one-variant union.
  - Grep `llm-client.ts` for `design` afterwards and expect no matches outside unrelated words.
- [ ] **Step 4: Run the narrow suites and the type-check.**
  - Run: `npm run type-check && npm run lint && npx tsx --test main/services/studio/feature-flags.test.ts main/services/generation-harness.test.ts main/services/pi-agent-runtime-harness-finish-turn.test.ts main/handlers/chat-renderer-mutations.test.ts main/handlers/ipc-contract.test.ts renderer/lib/generation-stream.test.ts renderer/lib/ipc-stream.test.ts && npm run test:chat-visibility && npm run test:create-images`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `Remove Design Studio services, run hooks and IPC`.

### Task 3: Scripts, registry, docs and memory

**Files:**
- Modify: `package.json`, `scripts/ci-test-registry.json`, `scripts/ci-test-registry.test.mjs` (lines 211–212 use `design/store.perf.test.ts` as the "never run" fixture; point them at another manual entry), `docs/plans/README.md`, `docs/plans/design-studio-create-images-rebuild-plan.md`, `docs/plans/design-studio-adr.md`, `.memory/design-studio.md`, `.memory/studio-rebuild.md`, `.memory/studio-foundation.md`

**Interfaces:** none.

- [ ] **Step 1: Update `package.json`.**
  - Remove the `test:design-studio` and `test:design-studio:perf` scripts and `&& npm run test:design-studio` from `test:serial`.
  - Move `main/services/pi-agent-runtime-harness-finish-turn.test.ts`, `main/services/generation-harness.test.ts`, `renderer/lib/generation-stream.test.ts` and `main/handlers/chat-renderer-mutations.test.ts` into the long `tsx --test` list in `test:serial`. Today they run only through `test:design-studio`.
- [ ] **Step 2: Update the registry.**
  - Remove every `main/services/design/*`, `main/handlers/design/*`, `generation-profile` and `design-ipc` entry from `scripts/ci-test-registry.json`.
  - Re-point the moved files' entries to `test:serial`.
  - Fix the fixture in `ci-test-registry.test.mjs`.
- [ ] **Step 3: Run the CI policy check.**
  - Run: `npm run test:ci-policy`
  - Expected: PASS. No file is unregistered and no entry points at a missing file.
- [ ] **Step 4: Update the docs.**
  - `docs/plans/README.md`: the Design Studio row becomes "Superseded 2026-10-31 by [Design mode](../superpowers/specs/2026-10-31-design-mode-design.md); Studio code removed in P0. Create Images continues under this plan." Add a Design mode row under Active.
  - `docs/plans/design-studio-adr.md` and `docs/plans/design-studio-create-images-rebuild-plan.md`: add a dated "Superseded" note at the top and leave the history intact.
  - `.memory/design-studio.md`: set the status to removed, with a one-paragraph pointer to the design-mode memory.
  - Search the docs for `AIDEN_EXPERIMENTAL_DESIGN_STUDIO`, "Design Studio" and `/design` and fix stale claims: `README.md`, `PRODUCT.md`, `docs/*.md`.
- [ ] **Step 5: Run the full suite.**
  - Run: `npm run test`
  - Expected: PASS.
- [ ] **Step 6: Run the Studio E2E.**
  - Run: `npm run test:e2e:space -- tests/e2e/studio-foundation.spec.ts` (on main after the merge; it falls back to `npm run test:e2e` filtered to that spec if the script is missing).
  - Expected: PASS.
- [ ] **Step 7: Commit** with the message `Drop Design Studio tests and mark the plan superseded`.
