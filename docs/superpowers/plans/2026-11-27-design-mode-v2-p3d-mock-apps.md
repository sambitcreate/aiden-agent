# Design mode v2 — Phase 3d: mock apps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-11-27).** This revision applies review-p3d-plan (Gemini 4 Neon high: 8 blockers, 8 majors, 4 minors). All 20 were checked against the code after merging 3c at `1e27c2319`. Nineteen are fixed as suggested or by an equivalent mechanism, and one is taken in part (#4's inspector point). "Applied review decisions" at the end lists each.
>
> **Revision 3 (2026-11-27).** This revision applies review-p3d-plan-2 (1 blocker, 1 major, 3 minors), all fixed. Excludes now exempt only the mock folders. The written-page inspector gets its own call with the flag on. The owner decided open question 4: the tokens offer is deleted in 3d for everyone, as spec S6 says.

> **Revision 1 (2026-11-27).** First draft, written against 3c's head `b7a0ec93c` (PR #968). Nothing is built yet.

**Goal:** A workspace with no runnable web app can still design live. When the person wants to design something there, Aiden asks once, on a card main draws, whether to add a small Vite + React app (the *mock app*) in `design-app/`. On Allow, main writes the mock app from a template bundled with Aiden, installs it from the npm registry, starts it and places `/` on the chat's page. Each design is then a route in the mock app, shown live like any app frame. For a React project that isn't a web app (`react-nonweb`, such as an Electron app), the mock app reuses the project's own components through aliases and stubs, and its `DESIGN.md` is drafted from the project's own CSS variables and fonts. 3d also removes the v1 HTML-mockup path from every flag-on turn, and the v1 tokens offer everywhere. All of this is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`, except the tokens offer's removal (S114).

- **The ask (§6.8, S102).** `design_app {action: "scaffold"}`, or **Add design app…** in the status chip, shows one main-owned card. It names the folder, the files, the install command and what it downloads, and the run command. Its Allow is both the person's yes and the S2 launch consent. Nothing is written, installed or started before it.
- **Who gets it (S103).** `react-nonweb` workspaces get React mocks that reuse the project's UI. Workspaces with no React and no web app get a plain starter. Never `workspace-runner`, `unknown-framework`, `no-dev-script`, an unreadable `package.json`, a truncated detection, or a workspace that has a web app.
- **Where (S104).** `design-app/`, or `design-app-2/` (then `-3`…`-9`) when `design-app/` exists and isn't a mock app. Never `design/`.
- **The template (S105, S106).** `resources/design-app-template/`: React, React DOM, Vite and `@vitejs/plugin-react`, pinned exactly to the versions Aiden's own lockfile resolves, with a committed `package-lock.json`, so the install is `npm ci`. It ships a starter `DESIGN.md` and the `theme.css` exported from it (S110).
- **Stubs and aliases (S109).** For `react-nonweb`, main writes a first pass of `aiden.mock.json`: an `@app` alias to the project's UI folder, stubs for `electron` or `@tauri-apps/api`, and the preload globals the project exposes. Aiden refines it. The mock's Vite config reads that file as validated data.
- **Node-missing and install-failed (S112).** Node is resolved before the card. Without it there is no card and no files, and the chip says how to install Node. A failed install keeps the files, the chip says why (network, registry sign-in, or other), and Retry reinstalls.
- **Routes (S108, S113).** The mock app's pages are files in `src/routes/` (`settings.tsx` is `/settings`, a variant is `settings-v2.tsx`). 3b's discovery and placement, and 3c's ⌘D and Move page file to Trash, work on them unchanged.
- **`data-aiden-src` (S111).** A JSX dev-runtime shim in the template stamps host elements with `data-aiden-src="<workspace path>:<line>"`, so Phase 4 can map elements to source in mock apps, aliased project components included.
- **The v1 mockup path (S114).**
  - `design-system.ts`, `design-system-offers.ts`, their tests and their wiring are deleted, so the tokens offer is gone in both flag states.
  - With the flag on, no turn is taught to write `design/*.html` mockups, and written `design/` pages no longer land on the canvas by themselves. Existing HTML files still show as `file` frames.
  - With the flag off, the v1 HTML method stays until Phase 7 retires the flag.

**Architecture:**
- **Shared contract (`renderer/shared/design-app.ts`).** `DesignMockOffer`, `MockRefusal`, the `scaffold` consent request, two problems, `mock` on candidates and statuses, the snapshot's `mock` field, and the `designApp:scaffold` channel.
- **Template (`resources/design-app-template/`).** Static files, shipped as an `extraResources` folder. A dev-only script (`scripts/design-app-template-lock.mjs`) regenerates its lockfile.
- **Pure rules (`main/services/design-canvas/app-server/mock-app-core.ts`, new).** The offer and refusals, the folder choice, the UI-folder guess, the preload globals, the `aiden.mock.json` builder and the install-failure hint.
- **Disk (`main/services/design-canvas/app-server/mock-app.ts`, new).** Reads the template, writes the mock confined and create-only, verifies what it wrote, rolls back, saves `.aiden/canvas.json`, and drafts `DESIGN.md`.
- **Process (`app-server-main.ts`).** `DesignAppServers.scaffold()`: the toolchain, the card, the write, approving the written fingerprint, then 2b's own install and start, then placing `/`.
- **Detection and routes.** `app-detect.ts` sees `design-app*` folders and the mock marker. `app-routes-core.ts` maps a mock app to the TanStack flat-file convention.
- **Agent and UI.** `app-tool.ts` gets the `scaffold` action. The chip gets **Add design app…** and the mock problems. `design-app-consent.tsx` draws the scaffold card.
- **v1 removal.** `turn-wiring.ts`, `llm-client.ts`, `design-canvas/main.ts`, `skill.ts`, `canvas-tools.ts`, `written-pages.ts` and `entry.ts`.

**Tech Stack:** Electron 43.8.4, React 19.2.7, Vite 8.3.5, `@vitejs/plugin-react` 6.0.3, `@google/design.md` 0.4.0 (`css-vars` export), TypeScript, `tsx --test`, happy-dom, Playwright Electron in a Cua Space.

**Spec:** [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](../specs/2026-11-23-design-mode-live-app-design.md): §5.4, §6.8, §6.9 "Mock apps", §6.10, §8's 3d row, §11 items 2 and 5, and S1–S101 (S2, S6, S8, S21, S26, S27, S37, S47, S64, S80, S83, S95 and S101 above all).

**Stacking:** 3d stacks on 3c ([PR #968](https://github.com/sambitcreate/aiden-agent/pull/968)), which stacks on 3b, 3a, 2c, 2b, DM, 2a, 1b and 1a. It depends on 3b (routes, placement, the live skill) and DM (the linter worker, `draft`, `export`). The branch `t3/design-mode-v2-p3d` starts at `origin/t3/design-mode-v2-p3c` `b7a0ec93c`. Merge 3c again when it moves. Never rebase.

## Scope

**In:**
- The bundled template with its starter `DESIGN.md`, `theme.css`, exact pins, lockfile, `.npmrc`, self-contained Vite config, route mapper and JSX shim.
- `design_app scaffold`, the person's **Add design app…**, and the main-owned scaffold card.
- The offer rules, the folder rule and the mock marker.
- `react-nonweb` aliases, stubs and preload globals, and the drafted `DESIGN.md`.
- Node-missing and install-failed states, with Retry.
- Detection of mock apps, their route convention, and `/` placed after scaffolding.
- Removing the v1 tokens offer (both flag states), and the v1 HTML-mockup teaching and auto-placement (flag on).
- Analytics: `design_app_scaffolded`, `design_md_drafted {source: "mock"}`, and `design_app_frame_added` call site 7.
- Packaging checks for the template, docs, memory and spec amendments.

**Not in:**
- **Inspect, element chips and the source walk** (Phase 4). 3d only ships the stamps.
- **Porting a chosen direction into the real app.** That's an ordinary coding task (§6.8).
- **Tailwind or any other dependency in the template.** Aiden adds one with `run_command` and its normal approvals (S105).
- **Dynamic routes in mock apps.** Mocks use concrete routes only (S108).
- **A shared mock app for a monorepo's several non-web roots.** One mock app per workspace (S103).
- **Onboarding.** Nothing changes until Phase 7, because the flag stays experimental.
- **Native clients and Remote.** Phones don't draw the canvas. Task 11 checks nothing shared changed.

## Feature flag

Everything sits behind `designLiveEnabled()` (`main/services/studio/feature-flags.ts`) and, in the renderer, `useAppCapabilities().designLive`.

With the flag off:
- `design_app` doesn't exist, so there's no `scaffold`;
- `designApp:scaffold` throws the unavailable message, like every other `designApp:*` handler, and the snapshot has no `mock` field;
- the chip isn't drawn;
- no template is read and nothing is written;
- the prompt section and the `aiden-design` skill are today's flag-off text, except one sentence: the tokens-offer note no longer exists, so `HTML_METHOD` stops promising it (S114);
- written `design/` pages land on the canvas as today, and entry places them as today;
- no event is sent.

The tokens offer's deletion is the one change that reaches flag-off turns, because the spec deletes its modules in 3d (§11 item 2, S6, S37). S114 explains why the rest of the v1 HTML path stays for flag-off turns until Phase 7.

## What exists today (checked against 3c's head `55748a308`)

Line numbers drift as 3c takes review fixes. Task 0 rechecks them with `rg -n`, and named symbols win over numbers.

| Area | Fact | Evidence |
|---|---|---|
| Kinds | `AppKind = "web" \| "react-nonweb" \| "none"`; reasons `ok`, `desktop`, `workspace-runner`, `react-native`, `no-dev-script`, `unknown-framework`, `no-web-framework`, `invalid-package-json`, `no-package-json` | `main/services/design-canvas/app-server/app-server-core.ts:9-20` |
| R4 | `classifyPackage`: desktop shell with React → `react-nonweb desktop`, without → `none desktop`; framework + script → `web`; runner → `none workspace-runner`; React Native/Expo → `react-nonweb react-native`; framework with no usable script → `none no-dev-script`; script and no framework → `none unknown-framework`; React → `react-nonweb no-web-framework`; else `none no-web-framework` | `app-server-core.ts:349-378` |
| Target | `designTarget`: one web → `single`, several → `choose`, else any `react-nonweb` → `react-nonweb`, else `none` (all apps) | `app-server-core.ts:618-636` |
| Candidates | `findCandidates` looks at `.`, `apps/*`, `packages/*`, `web`, `frontend`, `site` (`FIXED_CONTAINERS`, `FIXED_FOLDERS`) and the workspace patterns; `design-app/` is never a candidate | `main/services/design-canvas/app-server/app-detect.ts:44-45`, `:280-317` |
| Install root | A candidate with its own lockfile is its own install root; `installed` is `node_modules` or `.pnp` | `app-detect.ts:325-380` (`detectWebApp`) |
| Toggle | `toggleRoots`: configured roots with a runnable script, else the `single` target's root | `app-server-main.ts:1584-1595` |
| Snapshot | `target: "single" \| "choose" \| "react-nonweb" \| "none" \| "unavailable"`; `candidates` are web apps only | `renderer/shared/design-app.ts:121-130`, `app-server-main.ts:1624-1640` (`snapshotNow`) |
| Consent | `DesignAppConsentRequest` has `launch` (reasons `first \| changed \| install \| choose`, `runCommand`, `installCommand?`, `scripts`, `launchFiles`, `savesChoice`) and `attach` | `renderer/shared/design-app.ts:132-167` |
| Declines | A decline answers `consent-declined`; Aiden's request for a declined key gets no second card, the person's always asks | `app-server-main.ts:907`, `:1118`; `.memory/design-mode.md` "v2 Phase 2b" |
| Approval record | `approveShown(workspaceId, appRoot, consent, shown, current)` stores the fingerprint the card showed, with `installShown` | `main/services/design-canvas/app-server/app-records.ts:57`, `:169` |
| Fingerprint | `readLaunchSurface(workspaceRoot, app)` hashes scripts, rc and workspace files, the lockfile and framework configs, and the checkout's realpath; a config's local imports aren't covered | `main/services/design-canvas/app-server/app-fingerprint.ts:152` |
| Install | Runs for a missing `node_modules` or an unfinished Aiden install, never over the person's own install; `npm ci` only with a `package-lock.json` | S27; `app-server-core.ts:516` (`installCommand`) |
| Problems | `node-missing`, `install-failed {exitCode, tail}`, `install-timeout`, `consent-declined`; `install-failed` reads "Installing the app's dependencies failed (exit code N)." | `renderer/shared/design-app.ts:40-80`, `:309-312` |
| Toolchain text | "Node.js 22 or newer wasn't found. Install it from nodejs.org or Homebrew, then try again." | `renderer/shared/design-app.ts:255` (`toolchainProblemMessage`) |
| Retry | Clears the toolchain cache; an install failure reinstalls | S47; `app-server-main.ts:474` (`retry`) |
| Tool | `design_app` actions `status \| start \| stop \| restart \| logs \| choose \| routes`; 4 starts per turn | `main/services/design-canvas/app-server/app-tool.ts:43-45` |
| Channels | `DESIGN_APP_CHANNELS`; `chatRunsDesignApps` guards every start | `renderer/shared/design-app.ts:211-238` |
| Chip | With no web app the chip is a Connect chip with only **Connect running server…** | `renderer/design/design-app-chip.tsx:374` |
| Card | `DesignAppConsentCard`, `DesignAppConsentCards` (mounted in `chat-pane.tsx`) | `renderer/design/design-app-consent.tsx:241`, `:366` |
| canvas.json writer | `saveCanvasConfigApp(root, {root, script})` through `writeConfinedWorkspaceText` with `expectedSha256` and no links; `unknown-version` leaves the file alone | `main/services/design-canvas/canvas-config.ts:250-289`; `main/services/coding-tools.ts:1042` |
| canvas.json roots | `configuredRoots` keeps entries whose `root` detection sees as `web` | `canvas-config.ts:160-167` |
| Route conventions | `conventionsFor(framework)`: Next, TanStack, React Router/Remix flat, Astro; every other id (Vite included) has none, so `/` plus canvas.json (S80) | `main/services/design-canvas/app-server/app-routes-core.ts:25-38`; callers `app-routes.ts:286`, `:326`, `app-page-files.ts:53` |
| Draft | `designMdDraftFor(workspaceRoot, appRoot)` drafts from the style files inside one app root through `style-scan.ts`; `draftDesignMd` caps at 32 KiB | `main/services/design-canvas/design-md/draft.ts:103`, `:118` |
| Export | `design_system export` formats `css-tailwind`, `json-tailwind`, `dtcg`, `css-vars` | `main/services/design-canvas/design-md/tool.ts:27` |
| Tokens offer | `designSystemOfferLine` and `DesignSystemOffers` (`userData/design-system-offers.json`), the singleton, and `createDesignNoteOffers`' v1 branch | `main/services/design-canvas/design-system.ts:23`, `design-system-offers.ts:31`, `design-canvas/main.ts:172-175`, `design-md/turn-wiring.ts:62-96`, `main/services/llm-client.ts:595`, `:3092-3099`, `:3414-3421` |
| Tokens-offer tests | `design-system.test.ts` and `design-system-offers.test.ts` in the registry; `offer-log.test.ts` names `DesignSystemOffers` in one test title | `scripts/ci-test-registry.json:393-394`, `main/services/design-canvas/offer-log.test.ts:38` |
| Skill | `HTML_METHOD` (v1, with the tokens-offer sentence at line 20); `AIDEN_DESIGN_SKILL_LIVE` ends with "No web app: … design with workspace HTML pages under design/" plus all of `HTML_METHOD` | `main/services/design-canvas/skill.ts:16-51`, `:65-91` |
| Prompt | `DESIGN_MODE_PROMPT_SECTION` (v1), `LIVE_DESIGN_MODE_PROMPT_SECTION` (keeps "With no web app, screens are workspace HTML files under design/"), `designModePromptSection(designMd, liveApps)` | `main/services/design-canvas/canvas-tools.ts:240`, `:270-289`, `:293` |
| Live switch | `liveAppsOn = canvasTools.some((tool) => tool.name === "design_app")`; `design_app` is built only with the flag and `followThroughAvailable` (macOS or Linux, writable workspace, attended chat) | `llm-client.ts:3176-3189`, `:2378-2388` |
| Auto-placement | `isAutoPlacedPagePath`, `placeWrittenPageFrames`, `createDesignPageScanner` place written `design/` pages; entry's `live` dep places the newest 12 pages and routes | `main/services/design-canvas/written-pages.ts:75`, `:254`, `:288`; `main/services/design-canvas/entry.ts:49` |
| Analytics | `design_md_drafted {source: enumProp("app")}`; `design_app_started`; `design_app_frame_added` with six call sites | `main/services/analytics/analytics-events.ts:92-106`; `docs/analytics.md:55-56` |
| Packaging | `build.extraResources` copies `resources/generative-ui` and others; resources resolve to `process.resourcesPath` when packaged and `app.getAppPath()/resources` otherwise | `package.json:457`, `:504`; `main/index.ts:1578-1582` (`applicationIconPath`) |
| Package checks | `verifyPackagedDesignMdLinter` in the macOS and Linux package checks | `scripts/verify-macos-package.mjs`, `scripts/verify-linux-package.mjs` |
| Versions | Root lockfile: `vite` 8.3.5 (deps `lightningcss`, `picomatch`, `postcss`, `rolldown`, `tinyglobby`; no install script), `@vitejs/plugin-react` 6.0.3, `react` and `react-dom` 19.2.7; `esbuild` is the only one with an install script and isn't a Vite 8 dependency | `package-lock.json` |
| Fixture practice | E2E fixtures symlink `node_modules` to the repo root's, so detection sees an install and nothing reaches the network | spec §7, `tests/fixtures/design-live-app/`, `tests/fixtures/design-live-routes/` |
| Product text | `PRODUCT.md:71` promises the tokens offer ("offers in chat to write a tokens file and a specimen page") | `PRODUCT.md:71` |
| Dependabot | No `.github/dependabot.yml`, so nothing bumps the template's lockfile behind Aiden's back | `.github/` |
| fsevents | `vite` 8.3.5 has `optionalDependencies: {fsevents: "~2.3.3"}`; `fsevents` 2.3.3 is `optional`, `os: ["darwin"]`, `hasInstallScript: true` in the lockfile, and its published package ships a prebuilt `fsevents.node` (its own scripts are only `clean`, `build`, `test` and `prepublishOnly`). `lightningcss` and `rolldown` take their native code from optional platform packages | `package-lock.json`; `node_modules/fsevents/` |
| Workspace excludes | `findCandidates` applies `patterns.exclude` to **every** found folder, the fixed ones included, so `"!design-app"` would hide a mock app; `parseWorkspacePattern` gives `null` for `**/x`, braces and more than three segments | `app-detect.ts:314-316`; `app-server-core.ts:581-589` |
| Framework-only route plumbing | `discoverRoutes` and `routeForWrittenFile` take `framework`; `routeWalks` caches by framework and `detectionShape` hashes `[root, framework]`; `writtenRouteData` keeps `{appRoot, framework}`; `pageFileContext` passes only `framework` to `routeFiles` | `app-routes.ts:278-286`, `:321-326`; `app-server-main.ts:338`, `:402-422`, `:1563`, `:1699`; `written-pages.ts:341-385`; `main/handlers/design-canvas.ts:1059-1060` |
| Written-route turn | `createWrittenRouteTurn` loads `{snapshot, config}` once per turn and keeps it | `written-pages.ts:410-425` |
| Route placement nesting | In both the tool loop and ACP's `onFileWrite`, `placeWrittenRoute` runs only inside `if (placeWrittenPage && …)` | `llm-client.ts:6426-6433`, `:6912-6919` |
| Fallback `/` | `placeWrittenPagesOnCanvas` returns early with no pages, rules or routes, and places `fallbackRoute` only on a page with no frames | `written-pages.ts:753`, `:800` |
| Tool wait | `waitForAttempt` arms `settleMs` (90 s) and extends to the card's time only when a status in `snapshot.apps` reaches `consent` | `app-tool.ts:180-200` |
| Person IPC | `person()` checks the flag, the chat and the folder, throws on refusal, and doesn't check `designMode` or any page | `main/handlers/design-app.ts:65-80` |
| Consent keys | `closeAll(prefix)` closes cards and clears declines whose key starts with `${workspaceId}\0` | `app-consent.ts:134-137` |
| DESIGN.md roots cache | `createDesignAppRoots` caches detection keyed on the root `package.json` and `pnpm-workspace.yaml` only | `design-md/locate.ts:154-192` |
| Reader | `lintContent(content)` exists; `export` reads only a located file | `design-md/reader.ts:360`, `:368` |
| Draft | `designMdDraftFor` returns the text only, with no counts or sources | `design-md/draft.ts:118-126` |
| Section patching | `withDesignModeSection` replaces a stored section on a non-live turn only when it holds `DESIGN_MD_PROMPT_BULLET` or `LIVE_APP_PROMPT_MARKER`; llm-client passes `live: designMdOn \|\| liveAppsOn`; `DESIGN_MD_PROMPT_BULLET` says "ahead of design/tokens.css" | `design-md/turn.ts:183-188`; `llm-client.ts:3450-3455`; `canvas-tools.ts:259` |
| Source walk | `fromStack` (app-root-relative, `/@fs/` refused) runs before `stamp`, which reads `data-aiden-src` as `path:line` with no base | `app-frames/react-source-walk.ts:105-112`, `:144-152`, `:212-219` |
| Credential rule | `isProtectedCredentialPath` | `main/services/model-file-policy.ts:243` |
| Create-only writer | `writeConfinedFile` writes a `Buffer` with `O_CREAT \| O_EXCL \| O_NOFOLLOW` into a confined folder | `app-page-files.ts:208-225`, `:340` |
| Scanner tests | `design-system.test.ts` mostly tests `style-scan.ts` (all but its `designSystemOfferLine` cases), and `design-system-offers.test.ts:21` is the only disk test of `findWorkspaceDesignSystem` | `main/services/design-canvas/design-system.test.ts`, `design-system-offers.test.ts:21-36` |
| Startup cleanup | `cleanUpRetiredModelScoring()` runs from `main/index.ts`; `design-canvas/main.ts` promises no I/O at construction | `main/index.ts:203`, `:2528`; `design-canvas/main.ts:1-3` |
| Tests that pin today | The no-web-app chip menu has only Connect running server… (E2E and renderer); `design_md_drafted {source: "mock"}` is dropped | `tests/e2e/design-app-status.spec.ts:320-327`, `renderer/design/design-app-chip.test.tsx:138-142`, `main/services/analytics/analytics-feature-reports.test.ts:270` |
| Approval module | `main/services/approval-gate/workspace-tool-approval.ts` | — |
| Packaging blocks | `build.extraResources` is shared by macOS and Linux; `build.mac.extraResources` is macOS-only; Linux unpacks to `resources/`, macOS to `Contents/Resources/` | `package.json:457`, `:504`; `scripts/verify-linux-package.mjs:266-271`, `:310`; `scripts/verify-macos-package.mjs:213` |
| Space sync | `cua-space-e2e.sh` skips untracked `.npmrc` files | `scripts/cua-space-e2e.sh:131` |

## Decisions

All are **proposed**. They become spec amendments S102–S116 in Task 12. Each follows the spec unless it says otherwise.

### S102 — The ask is one main-owned card, which is also the launch consent (proposed)

- **Why not `ask_user_question`.** The spec says Aiden asks "through the question card". But main can't check an `ask_user_question` answer, so a prompt injection, or Aiden misreading the reply, could scaffold and reach the npm registry with no real yes. The yes that permits files and network must be a card main draws and answers, as 2b's launch consent is (S2).
- **One card, not two.** The scaffold card is a new `DesignAppConsentRequest` kind, `scaffold`, drawn by `DesignAppConsentCard`. It carries everything 2b's launch card shows:
  - the question, from S103's offer: "This is an Electron app, so it can't run on the canvas. Make React mocks of its screens in design-app/ to iterate on?" (Tauri and React Native say so), or "This folder has no web app. Add a small React app in design-app/ to design in?";
  - the folder, the files it writes (`files`: the template's paths, at most 40 shown, then "and N more"), and that it adds a `.aiden/canvas.json` entry;
  - the install command (`npm ci`), the packages it downloads with their versions, and "Downloads these from the npm registry with your npm settings. The packages' install scripts don't run.";
  - the run command (`npm run dev`) and the script text (`vite`);
  - `DESIGN_APP_CONSENT_SCOPE`.

  Buttons: **Add design app** and **Not now**. On Allow, main approves the fingerprint of what it wrote (S107), so no 2b launch card follows.
- **Who can raise it.** Aiden, through `design_app {action: "scaffold"}`, and the person, through the chip's **Add design app…** (S112). The live skill tells Aiden not to ask first with `ask_user_question`: the card is the question.
- **Declines** follow 2b. Not now answers `consent-declined`. In this run, Aiden's later `scaffold` calls for that workspace get `consent-declined` with no card, and the person's chip item always asks again. The memory isn't persisted, so a restart may ask Aiden's request once more.
- **Unanswered.** A card nobody answers in 2 minutes closes (`consent-unanswered`, 2b's rule). Nothing was written.
- **The key.** One scaffold card per workspace, keyed `${workspaceId}\0\0scaffold`. An app root is never empty, so the key can't collide with a launch key (`${workspaceId}\0${appRoot}…`), and `closeAll(`${workspaceId}\0`)` on workspace removal closes it and clears its decline.
- **The tool's wait.** `waitForAttempt` only stretches its 90 s timer when an app status reaches `consent`, and before Allow there is no app. So `scaffold` gets its own wait. It waits for the card on `consentMs + graceMs` (as a launch card does). After Allow, it moves to 2b's `settleMs` from the moment the write finishes and the app's status appears. `DesignAppServers.scaffold` reports both moments through an `onPhase` callback (`card`, `writing`, `app`). An aborted turn (`signal`) ends the wait only, never the card's own answer or the install.
- **Surface.** It needs a live desktop window owner (S26). A Remote or windowless owner gets `consent-unavailable` and nothing is written.

### S103 — Who gets an offer, and who never does (proposed)

`mockOffer(detection, config, folders)` in `mock-app-core.ts` is pure. Its answer, in order:

| Detection | Answer |
|---|---|
| `truncated: true` | `refused: truncated` (a web app may be among the unread candidates) |
| any `web` candidate that isn't a mock app, or any configured or url root that isn't one | `refused: has-web-app` |
| a mock app already exists (S104's marker) | `existing {folder}`: no scaffold. The tool answers with that root, and `start` takes 2b's own path (its S2 card if it isn't approved yet) |
| any candidate with reason `workspace-runner` | `refused: workspace-runner` |
| any candidate with reason `unknown-framework` | `refused: unknown-framework` |
| any candidate with reason `no-dev-script` | `refused: no-dev-script` |
| any candidate with reason `invalid-package-json` | `refused: invalid-package-json` |
| `.aiden/canvas.json` with an unsupported `version` | `refused: unsupported-config` (the entry couldn't be written, S39) |
| any `react-nonweb` candidate | `react-nonweb {source, shell?, reactNative?, folder}`, with `source` the shallowest such root |
| otherwise (`none` with `desktop` or `no-web-framework`; a Deno-only root, which detection lists as `no-package-json`; or no candidates at all, as in a Python repository) | `starter {folder}` |

- **Real apps first.** Non-mock web roots are checked before the marker, so a leftover `design-app/` beside a real `apps/web` gives `has-web-app`, not `existing`.
- **Never for `workspace-runner` or `unknown-framework`** (S21). Both mean the workspace probably has a web app design mode can't identify, and a second app would hide it. `no-dev-script` and `invalid-package-json` are fixable in the person's own app, so they refuse too. Each refusal has a fixed message saying what to fix ("This workspace's dev script hands off to a workspace runner. Name the app in .aiden/canvas.json, or start it yourself and use Connect running server…").
- **A desktop app without React** (Electron with Vue, say) gets the starter, not React mocks of its screens, because there are no React components to reuse.
- **Monorepos with several non-web React roots** get one mock app at the workspace root. Its `source` is the shallowest `react-nonweb` root; Aiden can add aliases to the others (S109).
- **The permission.** A `none` or `read-only` workspace is refused (`read-only`) before any card, like 3c's S99.

### S104 — The folder and the mock marker (proposed)

- **The marker.** The template's `package.json` has `"aiden": {"designApp": 1}`. A folder is a mock app when its `package.json` is a regular file under 64 KiB whose `aiden.designApp` is exactly `1`. Detection reads it (S108).
- **The marker grants nothing.** It only decides reuse and the label. A mock app Aiden didn't write in this run still goes through 2b's S2 consent before it starts, so a repo that plants the marker gains nothing.
- **The choice.** The first of `design-app`, `design-app-2` … `design-app-9` that either doesn't exist (then scaffold there) or is a mock app (then `existing`). A path that exists and isn't a mock app (a folder, a file or a link) is skipped. All nine taken gives `refused: no-free-folder`. `design/` is never considered.
- **Workspace patterns.** If the root's `workspaces` or `pnpm-workspace.yaml` patterns would match the chosen folder, the answer is `refused: in-workspaces`. The mock would join the person's workspace install, and npm would run `npm ci` from their root. The message names the folder and suggests excluding it (`"!design-app"`).
  - **Conservative matching.** `parseWorkspacePattern` can't read `**` paths, braces or deep patterns. `mockFolderCovered(folder, patterns)` treats any include pattern it can't parse, or one starting with `**` or `*`, as covering the folder unless an exclude names that folder exactly. A false refusal costs the person one line in `workspaces`; a false pass would hand `npm ci` the person's whole workspace.
  - **The remedy must work.** `findCandidates` today applies `patterns.exclude` to every folder, so `"!design-app"` would also hide the mock from detection. 3d exempts **only the mock folders** (`MOCK_FOLDERS`: `design-app`, `design-app-2` … `design-app-9`) from `patterns.exclude`. Every other folder, fixed (`web`, `frontend`, `site`, `apps/*`, `packages/*`) or include-found, is still dropped by an exclude as today, so `app-detect.test.ts`'s `"!packages/legacy"` case keeps passing. When an exclude names a mock folder, the folder stays in `found` with `viaPattern` cleared (`found.set(rel, false)`), so it isn't treated as a workspace member (`member` in `detectWebApp`) and installs as its own root.
- **Checked twice.** S103 and S104 run when the card is offered and again inside the write, under the workspace admission (S107).

### S105 — The template (proposed)

`resources/design-app-template/`, copied as is (only `aiden.mock.json` and, for `react-nonweb`, `DESIGN.md` and `theme.css` are generated, S109 and S110):

| File | What it is |
|---|---|
| `package.json` | `"name": "design-app"`, `"private": true`, `"type": "module"`, the marker, `"scripts": {"dev": "vite"}`, and exact `dependencies` (`react`, `react-dom`) and `devDependencies` (`vite`, `@vitejs/plugin-react`), equal to the root lockfile's resolved versions |
| `package-lock.json` | lockfile v3, every entry with `resolved` on `https://registry.npmjs.org/` and a `sha512-` `integrity`, the platform packages of `rolldown` and `lightningcss` included |
| `.npmrc` | `ignore-scripts=true`, `audit=false`, `fund=false`, `update-notifier=false` (S106) |
| `.gitignore` | `node_modules/`, `dist/`, `.vite/` |
| `vite.config.js` | Self-contained: no local imports, so 2b's fingerprint covers all Node-side config. It reads `aiden.mock.json` as data and validates it (S109). It sets `plugins: [react()]`, `resolve.dedupe: ["react", "react-dom"]`, `css.postcss: {}` (an inline config, so no `postcss.config.*` above the folder is loaded and run), `envDir` and `cacheDir` inside the folder, `server.fs.allow` and `server.fs.deny` as S109 says (the mock's own folder, its `node_modules` realpath and the validated alias folders only, never the workspace root; before the install, or in a config-loading test, a missing `node_modules` is left off rather than `realpathSync` throwing), and the `react/jsx-dev-runtime` alias to the shim (S111). Host and port come from 2b's flags |
| `aiden.mock.json` | `{"version": 1, "kind": "starter", "source": null, "aliases": {}, "stubs": {}, "globals": []}`, rewritten for `react-nonweb` |
| `index.html` | One `#root`, `src/main.tsx` |
| `src/main.tsx` | Imports `./stubs/preload`, `./theme.css` and `./styles.css`, then mounts `App` |
| `src/App.tsx` | Maps `location.pathname` onto `import.meta.glob("./routes/**/*.tsx")` with `routePath` (S108), with `pushState` navigation and a "No page at /x" fallback |
| `src/aiden/route-path.ts` | `routePath(file)`: the mapper, no imports |
| `src/aiden/jsx-dev-runtime.ts` | The `data-aiden-src` shim (S111) |
| `src/routes/index.tsx` | A starter page: the tokens as swatches and a type scale, set from `theme.css`'s variables, with no network (no web fonts or remote images) |
| `src/stubs/preload.ts`, `src/stubs/electron.ts`, `src/stubs/tauri.ts` | Deep no-op proxies, each with a `mockData` map Aiden fills (S109) |
| `src/styles.css` | A small reset |
| `DESIGN.md`, `src/theme.css` | The starter design system and its `css-vars` export (S110) |
| `README.md` | Two paragraphs: what this folder is, that it's safe to delete, and how to run it by hand |

- **No Tailwind** (open question 2). The template stays at four direct dependencies. When a `react-nonweb` project's CSS needs Tailwind to compile, Aiden adds `tailwindcss` and `@tailwindcss/vite` with `run_command` (its normal approval). The edited `vite.config.js` then asks again through S2's `changed` card.
- **Always npm.** The lockfile makes the mock its own install root with npm, whatever the workspace uses (open question 11). npm comes with Node, so there's no second tool to find.
- **Upgrades** come only with an Aiden release, like the other pinned runtimes in AGENTS.md. `scripts/design-app-template-lock.mjs` (dev-only, `npm run design-app-template:lock`) regenerates the lockfile in a temporary copy with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. That is a builder's dependency bump, the same network as any `npm install` on a developer machine. Nothing runs it at runtime, in tests or in CI.
- **Packaging.** Only the shared `build.extraResources` block (macOS and Linux, beside `generative-ui`) gains `{"from": "resources/design-app-template", "to": "design-app-template", "filter": ["**/*", ".npmrc", ".gitignore"]}`; `build.mac.extraResources` is macOS-only and isn't touched. The dotfiles are named in the filter, and Task 11's package checks require them, because a packed template without `.npmrc` would run install scripts. `assertLinuxBuildConfiguration` checks the entry. `designAppTemplateDir()` resolves it like `applicationIconPath`. `.npmrc` must be tracked in git before any Space run, since `cua-space-e2e.sh` skips untracked `.npmrc` files.

### S106 — The network, the install and pinning (proposed)

This is AGENTS.md's manual-only network posture, applied to mock apps:
- **Never without the Allow.** Startup, restoring chats, onboarding, detection, the snapshot, the chip, the offer, listing and refusals read files only. The template is read from the app bundle. Nothing contacts the network before the person chooses **Add design app** on the S102 card.
- **What reaches the network.** Only `npm ci`, run as 2b's install job in the mock's folder, under 2b's launch environment (S28's scrub, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`). Its `.npmrc` turns off the audit and fund calls and npm's update check, so npm fetches only the tarballs the lockfile names. The dev server itself is the app's own code (S5) and makes no registry call.
- **Which registry.** The person's own npm configuration (a mirror, proxy or token in `~/.npmrc` still applies; the project `.npmrc` only adds the four switches). A mirror missing a public package, or serving a re-packed tarball, fails `npm ci` with a 404 or an integrity error, which S112 shows. The template's `.npmrc` sets no `registry`. npm swaps the lockfile's `registry.npmjs.org` host for a configured registry by default, and every package's `sha512` integrity still has to match, so a mirror can't change the bytes.
- **No install scripts.** `ignore-scripts=true`, with one known package that declares one: `fsevents` 2.3.3, Vite's optional, macOS-only watcher. Its published package already holds a prebuilt `fsevents.node`, and its declared script only rebuilds that from source, so skipping it changes nothing. On Linux it isn't installed at all. The alternative, dropping optional dependencies, isn't possible: Rolldown's and LightningCSS's native code are optional platform packages. Task 2's test names the allowlist exactly (`{"node_modules/fsevents"}`, optional, `os: ["darwin"]`), so a Vite bump that brings another script-bearing package fails the test and needs a decision. Probe 4 checks on the Mac that `npm ci` with scripts off gives a dev server whose file watching sees an edit. `npm run dev` still runs, because npm runs a script that is named explicitly. The card says that install scripts don't run, in place of 2b's `DESIGN_APP_INSTALL_NOTE`.
- **Reinstalls.** The yes covers the first install and every reinstall of the same fingerprint, exactly as 2b's consent covers a web app (S8, S27, S47): Retry, or a start after a failed install. A changed `package.json`, lockfile, `.npmrc` or `vite.config.js` asks again with S2's `changed` card.
- **Pinning.** Exact versions with no ranges. Task 2's tests check:
  - the template's four direct dependencies equal the root lockfile's resolved versions, so the E2E (on Aiden's own `node_modules`) runs what people install;
  - every lockfile entry has an `https://registry.npmjs.org/` tarball and `sha512` integrity, with no git, file, link or http source;
  - the only entries with `hasInstallScript` are the allowlist (`fsevents`, optional and darwin-only).

### S107 — Writing the mock app (proposed)

`writeMockApp(workspaceRoot, folder, files, options)` in `mock-app.ts`:
- **The template is read bounded:** at most 64 files, 1 MiB in total and 256 KiB each, regular files only, no links (a refused read is `scaffold-failed {step: "template"}`).
- **The folder is created** with a non-recursive `mkdir` after `lstat`ing every segment from the workspace's realpath (3c's `confinedTarget` rule). Subfolders are created one level at a time.
- **Each file is written create-only** as bytes with 3c's `writeConfinedFile(…, {create: true})` (`O_CREAT | O_EXCL | O_NOFOLLOW`, in a folder `confinedTarget` checked), after its parent folders were created one level at a time. `writeConfinedWorkspaceText` isn't used: it takes text and spawns the native mutator once per file.
- **Verified before approval.** Each file is re-read with 3c's `readRegularFileBytes` (`O_NOFOLLOW`, regular files only), and its SHA-256 must equal what was written. Only then does main run `readLaunchSurface`, and call `approveShown` with what the card showed (`installShown: true`). A file changed in between fails the verification (`scaffold-failed {step: "verify"}`), and the next start asks with 2b's card.
- **Rollback.** On any failure before approval, main re-reads each file it created with `readRegularFileBytes`, so a link swapped in is never followed, and removes those whose bytes are still what it wrote (for S110's replaced `DESIGN.md` and `theme.css`, the bytes it wrote last), then the folders it created if they're empty. A file that changed is left, and the answer says so. Nothing outside the folder is touched.
- **`.aiden/canvas.json`.** After the files, `saveCanvasConfigApp(root, {root: folder, script: "dev"})`. `unknown-version` can't happen (S103 refused it), and any other failure leaves the scaffold in place and says the entry wasn't saved, because detection alone makes the mock the `single` target (S108). The spec's `mock: true` field isn't written: the marker in `package.json` is the one source, and a field nothing reads would mislead.
- **Under one admission.** The whole write holds a `workspaceMutationGate` admission (2b). A folder-path change or `none` permission mid-write aborts and rolls back.

### S108 — Detection, the mock flag and routes (proposed)

- **Detection.** `FIXED_FOLDERS` gains `design-app` and `design-app-2` … `design-app-9`. A mock app is an ordinary Vite + React app, so R4 classifies it `web` with framework `vite` and script `dev`. Its own lockfile makes it its own npm install root. With it present, `designTarget` is `single` for a `react-nonweb` or empty workspace, so the design-mode toggle starts it like any web app.
- **The flag.** `DetectedApp.mock?: true` comes from the marker (S104). It's carried on `DesignAppCandidate.mock` and `DesignAppStatus.mock`. The chip labels it "Design app · :5173". Nothing trusts it for safety.
- **Routes.** `routeConventionsOf(app)` returns `["tanstack"]` for a mock app and `conventionsFor(framework)` otherwise. Every route path takes a `RouteApp = {framework?, mock?: true}` in place of a bare `framework`, so the mock flag reaches each of them:
  - `discoverRoutes` and `routeForWrittenFile` (`app-routes.ts`);
  - `routeFiles` (`app-page-files.ts`);
  - `DesignAppServers`' `routeWalks` cache, whose entry and key gain `mock`, and `detectionShape`, which hashes `[root, framework, mock]` so a marker appearing or going clears the walks;
  - `writtenRouteData`'s `owners` (`written-pages.ts`), which keep `mock` from the snapshot's candidates and apps;
  - `pageFileContext` (`main/handlers/design-canvas.ts`), which reads `mock` with `framework`.

  Task 4 tests the written-route and page-file paths with a `{framework: "vite", mock: true}` app, since a missed site there would turn off placement or make ⌘D refuse with `config-router`. With no `routeTree.gen.ts`, 3b walks `src/routes/**` with TanStack's flat-file rules. So:
  - discovery lists every page;
  - a route file Aiden writes lands by itself (S83);
  - 3c's ⌘D copies `settings.tsx` to `settings-v2.tsx`. The files have no `createFileRoute` call, so there's no literal to rewrite (S101);
  - Move page file to Trash works.
- **The template's mapper agrees.** `src/aiden/route-path.ts` implements the subset that gives concrete routes: `index` is `/`, `a.b` and `a/b` are `/a/b`, a trailing `.index` or `/index` is the parent. Files main's rule maps to a pattern, layout or nothing (`$x`, `_x`, `__root`, `(group)`, `-x`) are ignored. Task 4's test runs both over one table of paths, plus every file in `tests/fixtures/design-live-routes/src/routes/`, and they must agree on each concrete route.
- **Dynamic routes** aren't supported in mocks. A `$slug.tsx` shows nothing in the mock and is skipped by discovery's concrete-route rule. The skill says to make concrete example routes instead.

### S109 — Aliases, stubs and globals for `react-nonweb` (proposed)

- **`aiden.mock.json`**, version 1: `{kind, source, aliases: {name: workspaceRelativePath}, stubs: {specifier: "src/stubs/<file>"}, globals: string[]}`. It's data, read by `vite.config.js`. It isn't in 2b's fingerprint, so Aiden can refine it without a new card. The config validates it before use, and refuses to start on a bad file (Vite prints why):
  - alias names match `^@?[a-z0-9][a-z0-9._/-]{0,63}$`, at most 20;
  - alias targets are folders that resolve (realpath) inside the workspace root, outside the mock's own folder, and outside `.git`, `.aiden`, `node_modules` and hidden folders;
  - no alias target, and no folder between it and the workspace root, is a protected credential path by the same rule as `isProtectedCredentialPath` (`main/services/model-file-policy.ts`). The template can't import Aiden's module, so `vite.config.js` carries a copy of its patterns, and Task 2 checks the copy against the real function over a table of paths;
  - stub specifiers match the npm name rule plus subpaths, at most 40;
  - stub targets resolve inside the mock's `src/stubs/`;
  - globals are JavaScript identifiers, at most 20.
- **What the dev server may serve.** `server.fs.allow` is the mock's own folder, the realpath of its `node_modules`, and each validated alias target folder, and nothing else. A starter mock serves nothing outside `design-app/`. The workspace root is never on the list. `server.fs.deny` adds, to Vite's defaults (`.env`, `.env.*`, `*.{crt,pem}`, `**/.git/**`), the same credential patterns: `**/.npmrc`, `**/.netrc`, `**/.git-credentials`, `**/.aiden/**`, `**/.ssh/**`, `**/.aws/**`, `**/.gnupg/**`, `**/*.{key,p8,p12,pfx,jks,keystore,ppk,mobileprovision}`, `**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`, `**/credentials.json`, `**/.env*`, `**/.envrc*`, `**/.yarnrc*`, `**/.pnpmrc` and `**/.bunfig.toml`. So an alias to a UI folder still can't hand out a key file inside it. The deny list covers `/@fs/` requests and aliased paths alike, and the mock's own `.npmrc` is denied too.
- **Main's first pass**, all pure in `mock-app-core.ts`, from bounded no-follow reads:
  - **`guessUiRoot(folders)`**: the first of `src/renderer`, `renderer`, `app/renderer`, `src/web`, `src/ui`, `src` (relative to `source`) that holds a `.tsx` or `.jsx` file within 2 levels and passes the alias rules above. It becomes `@app`. With none, there's no alias, and the answer says so.
  - **Stubs**: `electron` and `@electron/remote` go to `src/stubs/electron.ts` for an Electron shell, and `@tauri-apps/api` and its subpaths to `src/stubs/tauri.ts` for Tauri. React Native gets none: its components don't render in React DOM, so the skill says to hand-build mocks in React (§6.8: "hand-built in React when a component can't render outside the app").
  - **`exposedGlobals(tokens)`**: the first string argument of each `contextBridge.exposeInMainWorld(` call. It's found with 3b's `scanTsTokens` in at most 8 files named `preload*.{ts,js,mjs,cjs}` within 4 levels of `source`, each 256 KiB at most, skipping `node_modules` and hidden folders.
- **What the stubs do.** `src/stubs/preload.ts` installs a deep no-op proxy on `window[name]` for each global. Any property is a function returning `Promise.resolve(mockData[path])`. `electron.ts` and `tauri.ts` export the same proxy as the default and the common named exports. Aiden fills `mockData` so real components render with data.
- **Why the config holds.**
  - `resolve.dedupe` keeps one React, so a project component imported through `@app` doesn't load the project's React.
  - The project's other dependencies resolve from its own `node_modules`, when they're installed. When they aren't, Aiden hand-builds that part.
  - The inline PostCSS config means no repository config runs in the mock's Vite.
- **Reporting.** The scaffold's answer lists the alias, stubs and globals main wrote, and the project's style files the draft came from, so Aiden can say which parts are real components and which are mocked.

### S110 — The mock's DESIGN.md and theme.css (proposed)

- **The starter** `DESIGN.md` has neutral colours (with `light` and `dark` groups), a system font stack, a type scale, a radius and a spacing scale, and the prose sections the 0.4.0 linter knows. It lints with zero errors and zero warnings through DM's worker (Task 2).
- **`theme.css` is the `css-vars` export, not `css-tailwind`.** It's plain `:root` custom properties, because the template has no Tailwind (S105), and `@theme` would do nothing without it. The spec's §6.9 "css-tailwind" is amended. Task 2 checks that the committed `src/theme.css` equals the real exporter's `css-vars` output for the committed `DESIGN.md`.
- **For `react-nonweb`**, main builds the pair **in memory before writing anything**, so a failure can never leave a drafted `DESIGN.md` beside the starter `theme.css`:
  1. `designMdDraftResultFor(workspaceRoot, source)` (new in `draft.ts`, beside `designMdDraftFor`) returns `{content, colors, fonts, sources}`. It confines `source` with 3b's `confinedRoot` (no links, inside the workspace realpath) before DM's scanner reads it;
  2. with any colour or font, `designMdReader.lintContent(content)` must give no errors, and a new `designMdReader.exportContent(content, "css-vars")` (the worker's export over text, with the same limits as `export`) must give non-empty CSS;
  3. only then are the drafted `DESIGN.md` and `src/theme.css` put in the file map, in place of the template's, before S107 writes anything. They're written create-only like every other file, and verified and rolled back with them;
  4. otherwise the starter pair is written, and the answer says why: no tokens, lint errors, or the worker was unavailable or timed out (S44).
- **DESIGN.md's roots see the mock.** `createDesignAppRoots` caches detection on the root `package.json` and `pnpm-workspace.yaml` only, and scaffolding touches neither. It gains `invalidate(workspaceRoot)`, which `scaffold` calls on success, so `design_system`, the canvas note and DM's offer see `design-app/DESIGN.md` at once and stop offering a draft for `.`.
- **Analytics.** `design_md_drafted {source: "mock"}` once, when a drafted (not starter) `DESIGN.md` was written.
- **No draft offer.** A mock app always has a `DESIGN.md`, so DM's offer never fires for it.

### S111 — `data-aiden-src` stamps (proposed)

- **How.** `vite.config.js` aliases `react/jsx-dev-runtime` to `src/aiden/jsx-dev-runtime.ts`, except for the shim's own import of the real runtime. The shim re-exports React's runtime. For a string `type`, it adds `data-aiden-src` from `jsxDEV`'s `source` argument (`fileName`, made workspace-relative, `:lineNumber`) unless the props already have one. That covers aliased project components too, because Vite compiles them with the same runtime.
- **Value.** `ws:` plus a POSIX path relative to the workspace and a line (`ws:src/renderer/components/Button.tsx:14`, or `ws:design-app/src/routes/index.tsx:9`), at most 256 characters, with no absolute or `..` paths (dropped otherwise). `vite.config.js` passes the workspace root to the shim through `define`, after `fs.realpathSync`, and compares it with `fileName`'s realpath form, so a workspace under a linked folder (`/var` → `/private/var` on macOS) still matches.
- **Two bases, told apart.** 3a's `react-source-walk.ts` tries `fromStack` first, which gives app-root-relative paths for files inside the mock and refuses `/@fs/` files (the aliased project files). `stamp` then reads `data-aiden-src`. The `ws:` prefix marks a stamp as workspace-relative, so Phase 4 never reads `src/routes/index.tsx` (app-relative) and `design-app/src/routes/index.tsx` (workspace-relative) as different files. An unprefixed stamp keeps v1's meaning (the page's own path). 3d changes `stamp` to return `{path, line, base: "workspace"}` for a `ws:` value, `walk()` to copy `base` onto its result, and `ReactSourceResult` to declare `base?: "workspace"`; Phase 4 resolves it.
- **Probe first** (Task 0, probe 2). It checks that `@vitejs/plugin-react` 6.0.3 in development passes a `source` object to `jsxDEV`. If it doesn't, the plugin's `transform` hook adds the attribute using Vite's `transformWithOxc` JSX output, and if that's also unavailable, S111 is deferred to Phase 4, which already has `_debugStack` (S64). The probe result goes in As built.
- **Consumers.** Phase 4's Inspect reads the stamps. Phase 4 must accept stamped paths that resolve inside the **workspace** for mock apps (aliased project files sit outside the mock's root), which amends S11's "inside the app root" for mock apps only. 3d ships stamps and has no reader.

### S112 — Node-missing, install-failed and the chip (proposed)

- **Node first.** `scaffold` resolves the toolchain (`resolveAppToolchain` for npm) before the card. `node-missing` or `manager-missing` answers at once, with no card and no files, using `toolchainProblemMessage`. The snapshot's `mock` field carries the problem, so the chip shows it.
- **Install failures** keep the written app. The app's status is 2b's `install-failed` or `install-timeout`. For a mock app, `designAppProblemMessage` adds one hint from `installFailureHint(tail)` (pure):
  - **network** (`ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ENETUNREACH`, `network request … failed`): "The design app's install needs the npm registry. Check your network or proxy, then Retry.";
  - **auth** (`E401`, `E403`, `ENEEDAUTH`): "The npm registry refused the download. Check your npm sign-in or registry settings, then Retry.";
  - otherwise: "Show logs has npm's output.".

  The hint is chosen from the untrusted tail, but only fixed text is shown. Retry is S47's: it reinstalls.
- **The chip** for a workspace with no web app (2c's Connect chip) gains, with the flag on:
  - **Add design app…**, when the offer is `react-nonweb` or `starter`. It calls `designApp:scaffold` with the page on screen (as 3b's Add ▸ Page from app does, S87), which raises the same card;
  - the refusal's message, in its menu as a disabled row, when the offer is refused;
  - the toolchain problem, with Retry. Before the mock exists there's no app root for 2c's `retry` (which would answer `not-web`), so this Retry calls `designApp:scaffold` again. A scaffold the person starts clears the toolchain cache first (`clearToolchainCache`), as `retry` does, so a just-installed Node is found.

  Once the mock exists, the chip is the ordinary app chip.
- **What Aiden sees.** `design_app status` adds the snapshot's `mock` (the offer, its folder, a refusal's `why` and message, and a toolchain problem), so the live skill's "when status refuses…" has something to read. `scaffold` takes no `root`, like `status`, `start` and `routes`, and the tool's argument check exempts it.

### S113 — Iterations are routes, and `/` is placed (proposed)

- **After the start succeeds**, main places the mock's `/` as an app frame, once, on the page S84 resolves. For Aiden's call, that's the turn's page. For the person's item, it's the page on screen, checked by main. 3b's `fallbackRoute` can't do this: `placeWrittenPagesOnCanvas` returns early with no pages or routes, and places the fallback only on a page with no frames at all. So `placeMockHome` (new, in `app-page-actions`' main-side neighbour `main/services/design-canvas/mock-home.ts`) follows `designCanvas:placeAppRoute`'s steps (`main/handlers/design-canvas.ts`, S87): `store.update` with `beforeWrite` re-checking the chat, place `/` beside the page's frames, a broadcast `step`, `sendFocus`. It answers `placed` or `already`, and `already` focuses the existing `/` frame. `design_app_frame_added` is reported only for `placed`.
- **A pending placement survives one retry.** When the install fails, the placement is kept for that workspace and root in memory, with its page and chat. The next attempt that reaches `running` in this run (Retry, Aiden's `start`, or the toggle) places it, if that chat is still in design mode. A restart forgets it, and entry's single-app `/` fallback (S83) covers an empty page then.
- **The tool's answer** waits like `start` (S31: the card, then up to 90 s). It returns `{status: "scaffolded", root, kind, phase, placed, aliases, stubs, globals, designMd: "drafted" | "starter", styleSources}`. If the start is still going after 90 s, it answers with the phase, and the `/` placement happens when the app reaches `running`, if design mode is still on for that chat.
- **Iterations.** Each design is a route file in `src/routes/` (S108). A variant is `<name>-v2.tsx`, by Aiden or by ⌘D. Nothing new is needed: 3b places written route files, and 3c handles ⌘D and Trash.

### S114 — Removing the v1 mockup path (proposed)

- **The tokens offer goes, in both flag states.**
  - Delete `design-system.ts`, `design-system-offers.ts`, both tests and their two registry entries, the `designSystemOffers` singleton, and the `v1` input and branch of `createDesignNoteOffers`. The status line becomes the DESIGN.md sentence with the flag on, and the plain line with it off.
  - `offer-log.ts` stays for DM. Its test that reads a `design-system-offers.json`-shaped log keeps its oracle, with the title no longer naming the deleted class.
  - `style-scan.ts` stays (S37).
  - The scanner's own tests stay. `design-system.test.ts` mostly tests `style-scan.ts` (`detectDesignSystem`, `parseDesignColor`, the name rules, `designSystemFileRank`, the injection filters and the size bounds), and `design-system-offers.test.ts`'s first case is the only disk test of `findWorkspaceDesignSystem` (vendored code, `design/` and `.env.css` excluded). Those move into a new `main/services/design-canvas/design-md/style-scan.test.ts`, registered in `test:design-mode` and the `core-git` lane. Only the `designSystemOfferLine` and `DesignSystemOffers` cases are deleted.
  - `cleanUpRetiredDesignSystemOffers()` (new, `main/services/design-canvas/retired-design-system-offers.ts`, delete-only, modelled on `cleanUpRetiredModelScoring`) removes `userData/design-system-offers.json` and its `.key`. `main/index.ts` calls it beside `cleanUpRetiredModelScoring()`, so `design-canvas/main.ts` keeps its no-I/O construction.
  - The flag-off skill's `HTML_METHOD` loses the sentence that promises the note ("When it is missing and their files set up colours or fonts, a design-mode note lists them once: …"). The rest of that bullet stays.
- **With the flag on, no turn teaches HTML mockups.**
  - The live skill drops `HTML_METHOD`. Its craft guidance (the checklist, flows and diagrams, comments) becomes a shared `CRAFT` block. Its "No web app" section becomes "No web app: a design app" (Task 8 has the text).
  - `AIDEN_DESIGN_SKILL_LIVE.description` drops "or as workspace HTML files".
  - `LIVE_DESIGN_MODE_PROMPT_SECTION` loses **every** `design/` HTML bullet it inherits from the v1 section, not only "With no web app…": the HTML-pages bullet, "For a design/ page, pick the design width", and "Each page you write is checked the same way". In their place: "With no web app, ask for a design app with design_app scaffold; its pages are routes like any app's." and "canvas_inspect checks an HTML file frame the person placed; it doesn't draw app frames (canvas_read with snapshot: true shows those)."
  - A flag-on turn without `design_app` (a read-only workspace, or a platform without background jobs) gets a new `LIMITED_DESIGN_MODE_PROMPT_SECTION`. It's the v1 section without those `design/` HTML bullets, plus: "Live apps can't run in this chat, so design with notes, shapes, flows and images. Existing design/ pages still show as frames." It starts with its own `LIMITED_APP_PROMPT_MARKER`.
  - `DESIGN_MD_PROMPT_BULLET` says "ahead of design/tokens.css". A flag-on `LIVE_DESIGN_MD_PROMPT_BULLET` drops that clause. The flag-off section never had the bullet, so the old one is deleted.
  - `designModePromptSection(designMd, mode)` takes `"v1" | "live" | "limited"`, and its callers change with it: `llm-client.ts`, `skill.test.ts`, `design-md/turn.test.ts` and `prompt-prefix-stability.test.ts`.
  - **Replacing a stored section.** `withDesignModeSection` (`design-md/turn.ts`) also treats a stored section holding `LIMITED_APP_PROMPT_MARKER` as one to replace, and recognises both DESIGN.md bullets by their shared opening (`DESIGN_MD_BULLET_PREFIX`, "- The app's DESIGN.md is its design system's source of truth"), so a 3b/3c transcript holding the old bullet still swaps when the flag turns off, and `llm-client.ts` passes `live: designLive` (the flag), not `designMdOn || liveAppsOn`. So a flag-on turn whose tools exclude both `design_system` and `design_app` still swaps a stored v1 section for the limited one, and a flag-off turn swaps either flag-on section back to v1.
- **With the flag on, written `design/` pages don't land by themselves.** The wiring is in `llm-client.ts`, not only `written-pages.ts`:
  - in both the tool loop and ACP's `onFileWrite`, `placeWrittenRoute` is nested inside `if (placeWrittenPage && …)`. 3d splits the two checks, so route placement runs whether or not page placement exists;
  - with the flag on, `placeWrittenPage` and the command scanner (`createDesignPageScanner`) aren't built, and `recentWrittenPages.note` isn't called for `design/` pages;
  - today the only caller of `writtenPageInspector.written` is `placeWrittenPage`. So with the flag on, both the tool loop and ACP's `onFileWrite` call `writtenPageInspector?.written(page)` directly when `writtenPagePath` gives a `design/` page and the write wasn't denied or an error. The inspector reports only when a `file` frame shows that page on screen (`frameShowingDesignPage`), so it still places nothing;
  - entry's `pagesWrittenInChat` gains `includeHtmlPages` (default `true`), which `entry.ts` passes as `!live`, so entry places only routes (and `/`).

  Existing `file` frames, the watcher's reloads, Add ▸ File, `canvas_place_frame {kind: "file"}` and `canvas_inspect` all keep working. The automatic check report for a `design/` page Aiden edits (`writtenPageInspector`) stays too: it places nothing, and it helps when the person asks Aiden to fix an HTML page they placed.
- **With the flag off, the v1 HTML method stays until Phase 7.** Flag-off is the shipped product (v1 is on by default). Deleting its only way to design before Phase 7 turns the replacement on would regress main between 3d and 7. Phase 7, which retires the flag, deletes `HTML_METHOD`, `DESIGN_MODE_PROMPT_SECTION`'s HTML bullets and the `design/` auto-placement, and §8's Phase 7 row is amended to say so.

### S115 — Analytics (proposed)

- **New event** `design_app_scaffolded {kind: "react-nonweb" | "starter", outcome: "added" | "declined" | "failed"}`. It's sent once per card that was answered, from main: `added` after S107 approved the files, `declined` on Not now, and `failed` when an answered Allow ended in `scaffold-failed`. A refusal before any card, a toolchain problem, an unanswered card and `existing` send nothing. It carries no folder, name, alias, path or count.
- **Widened:** `design_md_drafted.source` gains `mock` (S110).
- **New call site:** `design_app_frame_added` call site 7, the scaffold's `/` placement (S113), with `source: aiden` or `person` and `device_bucket: "laptop"`, after commit, only when `placeMockHome` answers `placed`.
- `design_app_started` is unchanged. The mock's start reports `framework: vite`, `manager: npm`.
- Each change goes in `analytics-events.ts`, `docs/analytics.md` and a registry test (Task 6). `analytics-feature-reports.test.ts` today asserts `design_md_drafted {source: "mock"}` is dropped; Task 6 turns that case into "accepted", and adds `design_app_scaffolded` accept and drop cases there. The Settings "What's sent" sheet renders from the registry.

### S116 — Gates and surfaces (proposed)

- **Gates.** `scaffold` (tool and IPC) needs:
  - the flag;
  - `chatRunsDesignApps` (an attended desktop chat, no Bot or owner);
  - design mode on in that chat, and folder access;
  - a writable workspace (not `none` or `read-only`);
  - a live desktop window owner (S26).

  The tool counts toward S31's 4 starts per turn, checks `stillAvailable` before acting and after every await, and is cancelled mid-wait only through the turn's `signal`, as `start` is.
- **The person's IPC.** `designApp:scaffold` throws on a refusal, like every other `designApp:*` handler (`person()`), and resolves with `DesignAppScaffoldResult` otherwise; the chip shows the thrown message. `DesignAppChat` gains `designMode?: boolean`, and the handler refuses a chat that isn't in design mode. A new `pageOnScreen(chatId, pageId)` dependency, wired in `design-canvas-main.ts` from `designCanvasViews` and the store (as `placeAppRoute` checks its page), refuses a page that isn't the chat's page on screen. The chip gets `pageId` and the canvas's `flush` from `design-canvas.tsx`, and flushes the pending save before it calls.
- **Same-turn routes.** `createWrittenRouteTurn` loads the snapshot once per turn, so routes written after a mid-turn scaffold would be missed. It gains `reset()`, which the `design_app` tool calls through a new `onScaffolded` dependency when `scaffold` answers `scaffolded` or `existing`.
- **Approval.** `design_app` stays in `REVIEWED_CARDLESS_TOOLS`. Its per-call approval card is skipped because S102's card is the consent, and hooks and Settings → Approvals rules still apply (S31). `main/services/approval-gate/workspace-tool-approval.ts`'s reviewed reason gains "scaffold asks on its own card".
- **Desktop only.** Remote, phones, Telegram and `aiden serve` don't get `design_app` today (S7, S26), so none can scaffold. The mock's files are ordinary workspace files, which Remote file views show like any others. No Remote contract changes (Task 11).
- **The CLI** bundles `main/services` and `renderer/shared`. The new pure modules must build there (Task 11), and the template isn't bundled.

## Interfaces

```ts
// renderer/shared/design-app.ts (additions)
export type DesignMockKind = "react-nonweb" | "starter";
export type MockRefusal =
  | "has-web-app" | "workspace-runner" | "unknown-framework" | "no-dev-script"
  | "invalid-package-json" | "truncated" | "unsupported-config" | "no-free-folder"
  | "in-workspaces" | "read-only";
export type DesignMockOffer =
  | { offer: "react-nonweb"; folder: string; source: string; shell?: "electron" | "tauri"; reactNative?: true }
  | { offer: "starter"; folder: string }
  | { offer: "existing"; folder: string }
  | { offer: "refused"; why: MockRefusal; folder?: string };

export interface DesignAppsSnapshot {
  // …2b/2c fields unchanged…
  /** 3d: with the flag on and no web app. Absent otherwise. */
  mock?: DesignMockOffer & { problem?: ToolchainProblem };
}
export interface DesignAppCandidate { /* … */ mock?: true }
export interface DesignAppStatus { /* … */ mock?: true }

export type DesignAppConsentRequest =
  | /* launch, attach (unchanged) */
  | {
      kind: "scaffold";
      requestId: string;
      chatId: string;
      workspaceId: string;
      /** "design-app" or "design-app-2" … */
      folder: string;
      mockKind: DesignMockKind;
      /** "Electron", "Tauri" or "React Native" for react-nonweb. */
      shellLabel?: string;
      installCommand: "npm ci";
      runCommand: "npm run dev";
      scripts: Array<{ name: "dev"; text: string }>;
      /** Direct dependencies with exact versions, from the template. */
      packages: Array<{ name: string; version: string }>;
      /** Paths relative to the folder, sorted; at most 40 shown, then "and N more". */
      files: readonly string[];
    };
// The scaffold card's DesignAppConsent key is `${workspaceId}\0\0scaffold`, so
// closeAll(`${workspaceId}\0`) on forgetWorkspace closes it and no app root collides.

export type DesignAppProblem =
  | /* …unchanged… */
  | { problem: "scaffold-refused"; why: MockRefusal }
  | { problem: "scaffold-failed"; step: "template" | "write" | "verify" | "design-md" };

export const DESIGN_APP_CHANNELS = {
  // …
  /** (chatId, {pageId}) → DesignAppScaffoldResult; throws on a refusal, like every designApp:* handler. */
  scaffold: "designApp:scaffold",
} as const;
export function mockRefusalMessage(why: MockRefusal, folder?: string): string;
export function installFailureHint(tail: string): "network" | "auth" | "other";
```

```ts
// main/services/design-canvas/app-server/mock-app-core.ts (new, pure)
export const MOCK_FOLDERS: readonly string[]; // "design-app", "design-app-2" … "design-app-9"
export function isMockPackage(pkg: PackageJson | null): boolean;
export function mockOffer(
  detection: WebAppDetection,
  config: CanvasConfigInspection | null,
  folders: ReadonlyMap<string, "missing" | "mock" | "taken">,
  patterns: { include: string[]; exclude: string[] },
  permission: string,
): DesignMockOffer;
export function guessUiRoot(sourceRel: string, folderHasJsx: ReadonlyMap<string, boolean>): string | null;
export function exposedGlobals(tokens: readonly TsToken[]): string[];
export function mockConfig(input: {
  kind: DesignMockKind;
  folder: string;
  source: string | null;
  uiRoot: string | null;
  shell?: "electron" | "tauri";
  globals: string[];
}): { version: 1; kind: DesignMockKind; source: string | null; aliases: Record<string, string>; stubs: Record<string, string>; globals: string[] };
```

```ts
// main/services/design-canvas/app-server/mock-app.ts (new, disk)
export function designAppTemplateDir(): string;
export async function readTemplate(dir: string): Promise<{ files: Map<string, Buffer> } | { problem: "template" }>;
export async function mockFolderStates(workspaceRoot: string): Promise<Map<string, "missing" | "mock" | "taken">>;
export async function writeMockApp(
  workspaceRoot: string,
  folder: string,
  files: ReadonlyMap<string, Buffer>,
  options: { admission: WorkspaceAdmission; signal?: AbortSignal },
): Promise<{ ok: true; written: string[] } | { ok: false; step: "write" | "verify"; kept: string[] }>;
/** In memory only: the scaffold puts the pair in the file map before writeMockApp runs (S110). */
export async function draftMockDesignMd(
  workspaceRoot: string,
  source: string,
  deps: { reader: DesignMdReader; signal?: AbortSignal },
): Promise<
  | { designMd: "drafted"; files: { "DESIGN.md": Buffer; "src/theme.css": Buffer }; styleSources: string[] }
  | { designMd: "starter"; styleSources: string[]; reason: "no-tokens" | "lint" | "export" | "unavailable" | "timeout" }
>;
```

```ts
// main/services/design-canvas/design-md/draft.ts (addition)
export async function designMdDraftResultFor(
  workspaceRoot: string,
  source: string,
): Promise<{ content: string; colors: number; fonts: number; sources: string[] }>;

// main/services/design-canvas/design-md/reader.ts (addition; the worker already takes {op: "export", content, format}, so only reader.ts changes)
interface DesignMdReader {
  exportContent(content: string, format: "css-vars", signal?: AbortSignal): Promise<string>;
}

// main/services/design-canvas/design-md/locate.ts: DesignAppRoots is a function type today; it becomes a callable interface
export interface DesignAppRoots {
  (workspaceRoot: string, options: { signal?: AbortSignal; config: CanvasConfig | null }): Promise<{ roots: string[]; more: number }>;
  invalidate(workspaceRoot: string): void;
}

// main/services/design-canvas/written-pages.ts (additions)
interface WrittenRouteTurn { reset(): void }
export function pagesWrittenInChat(messages: ChatMessage[], options: { isRouteFile?: …; includeHtmlPages?: boolean }): …;

// main/services/design-canvas/mock-home.ts (new)
export async function placeMockHome(input: {
  chatId: string; pageId: string; appRoot: string; by: "person" | "aiden";
}, deps: MockHomeDeps): Promise<"placed" | "already" | "refused">;

// main/services/design-canvas/retired-design-system-offers.ts (new, delete-only)
export async function cleanUpRetiredDesignSystemOffers(userDataDir?: string): Promise<void>;
```

```ts
// main/services/design-canvas/app-server/app-server-main.ts
export interface DesignAppScaffoldInput {
  chatId: string;
  workspaceId: string;
  by: "person" | "aiden";
  owner: DesignAppOwner;
  /** The person's: the page on screen, checked by main. Aiden's: the turn's page resolver (S84). */
  page: { pageId: string } | { resolve: () => Promise<string | undefined> };
  /** The tool's wait follows these: "card" waits consentMs + graceMs, "writing" and "app" wait settleMs (S102). */
  onPhase?: (phase: "card" | "writing" | "app") => void;
  /** Ends only the caller's wait; an answered card's write and install go on. */
  signal?: AbortSignal;
}
class DesignAppServers {
  scaffold(input: DesignAppScaffoldInput): Promise<DesignAppScaffoldResult>;
}
export type DesignAppScaffoldResult =
  | { status: "scaffolded"; root: string; kind: DesignMockKind; app: DesignAppStatus; placed: "placed" | "already" | "pending" | "none"; // pending: kept for one retry (S113)
      aliases: Record<string, string>; stubs: Record<string, string>; globals: string[]; designMd: "drafted" | "starter"; styleSources: string[] }
  | { status: "existing"; root: string; app: DesignAppStatus }
  | { status: "problem"; problem: DesignAppProblem };
```

```ts
// main/services/design-canvas/app-server/app-routes-core.ts
export type RouteApp = { framework?: FrameworkId; mock?: true };
export function routeConventionsOf(app: RouteApp): readonly RouteConvention[];
// discoverRoutes, routeForWrittenFile and routeFiles take a RouteApp in place of the framework (S108).

// main/services/design-canvas/canvas-tools.ts
export type DesignPromptMode = "v1" | "live" | "limited";
export const LIMITED_DESIGN_MODE_PROMPT_SECTION: string;
export const LIMITED_APP_PROMPT_MARKER: string;
export function designModePromptSection(designMd: boolean, mode?: DesignPromptMode): string;

// main/services/design-canvas/design-md/turn-wiring.ts
export function createDesignNoteOffers(input: {
  live: boolean;
  mdTurn: Pick<DesignMdTurn, "statusSentence" | "settle"> | undefined;
  signal: AbortSignal;
  log: (message: string, error?: unknown) => void;
}): { statusLine(line: string): Promise<string>; settle(delivered: boolean): void };
```

```jsonc
// resources/design-app-template/aiden.mock.json (react-nonweb, as main writes it for an Electron app)
{ "version": 1, "kind": "react-nonweb", "source": ".",
  "aliases": { "@app": "src/renderer" },
  "stubs": { "electron": "src/stubs/electron.ts", "@electron/remote": "src/stubs/electron.ts" },
  "globals": ["api"] }
```

## Global Constraints

- **Flag off is today**, except S114's tokens offer. Tasks 6, 7 and 8 each include a flag-off case:
  - no `scaffold` action;
  - `designApp:scaffold` throws the unavailable message;
  - the snapshot has no `mock`;
  - flag-off prompt and skill text are today's except the one sentence;
  - written `design/` pages still land.
- **Manual-only network (S106).** No code path reaches the network before the S102 Allow. Task 6 has a spy test: the fake `backgroundJobs` sees no install job before the card's Allow, and none after Not now, a refusal, a toolchain problem or `existing`. Nothing is added to startup, onboarding or background work except S114's delete-only file removal.
- **No overwrite, no links, no escape.** Every write is create-only, inside the chosen folder (plus `.aiden/canvas.json` through its own writer), after `lstat` checks from the workspace realpath. Rollback removes only unchanged files main created.
- **Main decides paths.** The renderer and the tool send no folder, file or alias. Aiden's later edits to `aiden.mock.json` are validated by the template's config, not trusted.
- **Never run the person's code** to scaffold. The preload scan and the UI-root guess are bounded file reads.
- **The fingerprint covers what runs in Node.** `vite.config.js` is self-contained, and the PostCSS config is inline (S105).
- **Analytics.** Only S115's changes, from main, each with its registry entry, its `docs/analytics.md` row and a test.
- **IPC contract.** `designApp:scaffold` uses the `designApp:` invoke prefix. No new notification channel: the card reuses `designApp:consent`. `main/handlers/ipc-contract.test.ts` must pass.
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`). Read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before Task 7. Then:
  - the scaffold card reuses `DesignAppConsentCard`'s layout, squircle buttons (`Button` from `renderer/components/ui`) and semantic tokens;
  - status colours as soft fills, labels and icons, with no decorative borders;
  - visible `focus-visible` on every control;
  - focus starts on **Not now**, as 2b's card does;
  - Reduce Motion through the motion tokens;
  - no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only, with no source greps, no tautologies and no `className` or markup snapshots.
  - The template's tests read its JSON and run the real exporter and linter, which is data, not production source.
  - The route-mapper test compares two implementations over one table.
  - Each new test file is appended to `test:design-mode` in `package.json` (a union) and to its lane in `scripts/ci-test-registry.json` (`core-git` for main and shared, `renderer-other` for happy-dom, `macos` for real processes) in the task that adds it, which runs `npm run test:ci-policy`.
- **Window-opening runs happen in the Cua Space** (`npm run test:e2e:space`), with 3a–3c's notes:
  - frames at `scale: 0.25`, then fitted;
  - focus and Enter;
  - `--disable-seccomp-filter-sandbox` through `appArgs` on Linux;
  - `--run` with `bash -c "npm run build && …"`.
- **Docs change in this PR** (Task 12).

## Review Focus

1. **Nothing reaches the registry without the Allow.** Detection, the snapshot, the chip, a refusal, a toolchain problem, Not now, an unanswered card, a Remote owner and `existing` start no install job. *Pinned by* Task 6's spy cases.
2. **The approved fingerprint is exactly what main wrote.** A file changed between the write and approval fails verification and asks again on the next start. A later edit to `vite.config.js` or `package.json` asks with S2's `changed` card. An edit to `aiden.mock.json` that points outside the workspace fails in the config. *Pinned by* Task 5's verify case, Task 6's changed-file case and Task 2's config-validation cases.
3. **Never scaffold where a web app may exist.** `workspace-runner`, `unknown-framework`, `no-dev-script`, `invalid-package-json`, truncated, any web or configured root, and workspace patterns covering the folder all refuse before any card. *Pinned by* Task 3's table.
4. **No write outside, no overwrite, a clean rollback.** A link at `design-app`, a file named `design-app-2`, a link inside the folder after `mkdir`, and a failure halfway leave nothing of Aiden's behind and touch no other file. *Pinned by* Task 5.
5. **The v1 removal is exact.** Flag-off text differs from today only by the tokens-offer sentence. No flag-on prompt variant or skill mentions writing `design/*.html`. Existing `file` frames still reload. *Pinned by* Task 8's prompt and skill cases and the existing design-mode E2E.

---

## Tasks

### Task 0: Baseline and probes

- [ ] Confirm the branch is `t3/design-mode-v2-p3d` on `origin/t3/design-mode-v2-p3c` (`55748a308` or later). Merge newer 3c commits (no rebase), and grep for conflict markers.
- [ ] Run `npm ci`, `npm run build:native:c`, `npm run build:vcc`, and `npm ci` in `packages/cli`.
- [ ] Recheck each "What exists today" row with `rg -n`, and update the table if anything moved.
- [ ] **Probe 1 (create-only writes).** Settled by review: S107 uses 3c's `writeConfinedFile(…, {create: true})`, which opens with `O_CREAT | O_EXCL | O_NOFOLLOW`. Confirm that's still its behaviour at the merged head (it has its own suite), and record it.
- [ ] **Probe 2 (JSX source).** In a scratch Vite 8.3.5 app on the repo's `node_modules`, alias `react/jsx-dev-runtime` to a shim that records its fifth argument. Load a page in the Space (`npm run test:e2e:space -- --run bash -c "…"`) and record whether `source.fileName` and `lineNumber` arrive. Record the outcome and S111's branch in As built.
- [ ] **Probe 3 (PostCSS isolation).** Put a `postcss.config.js` that writes a marker file in the scratch app's parent, set `css.postcss: {}` in its config, load a CSS file, and confirm no marker appears.
- [ ] **Probe 4 (the lockfile across platforms).** Run `npm run design-app-template:lock` on the Mac, then `npm ci` from that lockfile in the Space (linux-arm64). Confirm `rolldown`'s and `lightningcss`'s Linux bindings install and `npm run dev` serves `/`. This is a builder's probe with network access, never a test. Record the result. If the Linux bindings are missing, the lock script adds `--os`/`--cpu` passes and S105 notes it. On the Mac, with the template's `.npmrc` (`ignore-scripts=true`), confirm `node_modules/fsevents/fsevents.node` is present after `npm ci`, and that an edit to `src/routes/index.tsx` reaches the open page through HMR (S106's allowlist).
- [ ] Run `npm run test:design-mode` and `npx tsc --noEmit -p .`. Expected: PASS. Record any failures as pre-existing.

### Task 1: The shared contract

**Files:**
- Modify: `renderer/shared/design-app.ts`:
  - the types in Interfaces and the `scaffold` channel;
  - `mockRefusalMessage`, `installFailureHint`;
  - `designAppProblemMessage` cases for the two new problems;
  - the mock hint on `install-failed` and `install-timeout` when the status is `mock`;
  - the scaffold card's fixed sentences (`DESIGN_APP_SCAFFOLD_NETWORK`, `DESIGN_APP_SCAFFOLD_NO_SCRIPTS`).
- Test: `renderer/shared/design-app.test.ts` (extend if it exists, else create it in `core-git`)

- [ ] **Step 1: Write the failing tests:**
  - `"every refusal has a message that says what to fix"`: each `MockRefusal` gives a non-empty sentence, and `in-workspaces` names the folder it's given.
  - `"installFailureHint reads npm's network and auth codes"`: rows written by hand from npm's documented error codes (`ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `E401`, `E403`, `ENEEDAUTH`, an `ERESOLVE` tail, an empty tail).
  - `"a mock app's failed install adds the hint; a web app's doesn't"`.
  - `"the hint never repeats the tail's text"`: a tail holding `ENOTFOUND` plus a fake URL gives only the fixed sentence.
- [ ] **Step 2: Run** `npx tsx --test renderer/shared/design-app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Register the file if new, and run `npm run test:ci-policy`. Commit `feat(design): mock app contract (3d)`.

### Task 2: The template

**Files:**
- Create: `resources/design-app-template/` (S105's table)
- Create: `scripts/design-app-template-lock.mjs` and the `design-app-template:lock` script in `package.json` (not in any test chain)
- Modify: the shared `build.extraResources` block in `package.json` only (S105), and `assertLinuxBuildConfiguration` in `scripts/verify-linux-package.mjs`
- Create: `main/services/design-canvas/app-server/design-app-template.test.ts` (`core-git`)
- `git add` the template's `.npmrc` and `.gitignore` before any Space run: `cua-space-e2e.sh` skips untracked `.npmrc` files.
- Create: `tests/fixtures/design-app-template-config/` (small workspaces for the config's validation)

- [ ] **Step 1: Write the failing tests** in `design-app-template.test.ts`:
  - `"the template's direct dependencies are the versions Aiden's lockfile resolves"`: read `resources/design-app-template/package.json` and the root `package-lock.json`, and compare `react`, `react-dom`, `vite` and `@vitejs/plugin-react`, each an exact version with no range.
  - `"every package in the template lockfile comes from the registry with sha512 integrity"`.
  - `"only the allowlisted optional darwin package has an install script"`: the set of lockfile entries with `hasInstallScript` equals `{"node_modules/fsevents"}`, and that entry is `optional: true` with `os: ["darwin"]`. A Vite bump that adds another fails here.
  - `"the template's .npmrc turns off install scripts, audit, fund and the update check, and sets no registry"`: parse it as `key=value` lines.
  - `"the starter DESIGN.md lints clean"`: run it through DM's worker (`runDesignMdWorker`): zero errors and zero warnings.
  - `"theme.css is the css-vars export of the starter DESIGN.md"`: the worker's export equals the committed file byte for byte.
  - `"the package carries the mock marker and a dev script that runs vite"`: `isMockPackage` (from Task 3; write this case in Task 3 if the order requires).
  - **Config validation**, through Vite's `loadConfigFromFile` on each fixture workspace, so the real config runs:
    - `"an alias inside the workspace resolves"`;
    - `"an alias to /etc, to .git or through a link out of the workspace refuses"`;
    - `"an alias to .aiden, node_modules, a hidden folder or the mock itself refuses"`;
    - `"an alias to a protected credential path refuses"`: `.ssh`, `.aws`, a folder holding only `.env` files named as the alias, and so on;
    - `"the config's credential rule agrees with isProtectedCredentialPath"`: a hand-written table of paths (credential and ordinary), each run through the config's exported check and `model-file-policy.ts`'s function. Every path the real function protects, the config refuses;
    - `"server.fs.allow is the mock, its node_modules and the alias folders only"`, read from the loaded config, for a starter (no aliases) and an Electron fixture;
    - `"server.fs.deny names the credential globs"`: a request through a dev server the test starts (on Aiden's `node_modules`, loopback, no network) for `/@fs/<alias folder>/.npmrc` and `/@fs/<alias folder>/.env` answers 403, and a normal source file in the alias folder answers 200;
    - `"a stub outside src/stubs refuses"`;
    - `"a bad alias name or a non-identifier global refuses"`;
    - `"a missing aiden.mock.json is the starter"`.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Write the template,** run `npm run design-app-template:lock` once (builder's network), and commit the lockfile it writes.
- [ ] **Step 4: Run.** Expected: PASS. Register the suite (`test:design-mode`, `core-git`) and run `npm run test:ci-policy`. Commit `feat(design): the mock app template (3d)`.

### Task 3: The pure mock rules

**Files:**
- Create: `main/services/design-canvas/app-server/mock-app-core.ts`
- Test: `main/services/design-canvas/app-server/mock-app-core.test.ts` (new, `core-git`)

- [ ] **Step 1: Write the failing tests:**
  - `"mockOffer follows S103's table"`: one row per line, each built from a `DetectedApp` fixture.
    - Electron + React gives `react-nonweb` with `shell: "electron"`, and Tauri + React gives `shell: "tauri"`.
    - Expo gives `react-nonweb` with `reactNative`.
    - Electron + Vue gives `starter`.
    - An empty folder and a Python repo with no `package.json` both give `starter`.
    - A `workspace-runner` root, an `unknown-framework` root, a `no-dev-script` app and an invalid `package.json` each refuse with their reason, even beside a `react-nonweb` package.
    - A web candidate, a configured root and a url root each give `has-web-app`.
    - Truncated gives `truncated`, an unsupported canvas.json `version` gives `unsupported-config`, and `read-only` and `none` give `read-only`.
  - `"the folder is design-app, else the next free one; a mock app is reused; design/ never"`: states `{design-app: taken}` give `design-app-2`, `{design-app: mock}` gives `existing design-app`, all nine taken gives `no-free-folder`, and no input yields `design`.
  - `"a workspace pattern covering the folder refuses"`: `["*"]`, `["design-*"]`, `["design-app"]`, `["**"]`, `["**/*"]` and `["{apps,design-app}"]` refuse (the last three through `mockFolderCovered`'s conservative rule), `["packages/*"]` doesn't, and `["*", "!design-app"]` doesn't.
  - `"real web apps come before an existing mock"`: `apps/web` plus a marked `design-app` gives `has-web-app`; a marked `design-app` alone gives `existing`.
  - `"guessUiRoot skips folders an alias couldn't name"`: a `.ssh`, `node_modules` or hidden folder with JSX is passed over.
  - `"isMockPackage needs aiden.designApp exactly 1"`: `1` is true; `"1"`, `2`, `true`, a missing field and an array are false.
  - `"guessUiRoot takes the first folder with JSX"`.
  - `"exposedGlobals reads exposeInMainWorld's first string argument"`: `contextBridge.exposeInMainWorld("api", {...})` and `exposeInMainWorld('electron', …)` count. A non-string first argument, a template literal, a call in a comment and `foo.exposeInMainWorldX(` don't. The list is deduplicated and capped at 20.
  - `"mockConfig writes the alias, the shell's stubs and the globals"`: Electron gives `electron` and `@electron/remote`, Tauri gives `@tauri-apps/api`, React Native and the starter give none.
- [ ] **Step 2: Run** `npx tsx --test main/services/design-canvas/app-server/mock-app-core.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Register and run `npm run test:ci-policy`. Commit `feat(design): mock app offer, folder and alias rules (3d)`.

### Task 4: Detection and routes see mock apps

**Files:**
- Modify: `main/services/design-canvas/app-server/app-detect.ts` (the `design-app*` folders, `mock` from the marker, `MOCK_FOLDERS` exempt from excludes with `viaPattern` cleared)
- Modify: `main/services/design-canvas/app-server/app-server-core.ts` (`DetectedApp.mock`)
- Modify: `main/services/design-canvas/app-server/app-routes-core.ts` (`routeConventionsOf`), `app-routes.ts`, `app-page-files.ts` (use it)
- Modify: `main/services/design-canvas/app-server/app-server-main.ts` (`mock` on candidates and statuses; the snapshot's `mock` offer with the flag on; `routeWalks` keyed on `RouteApp`; `detectionShape` with `mock`)
- Modify: `main/services/design-canvas/written-pages.ts` (`WrittenRouteData.owners` carry `mock`; `writtenRouteData` passes the `RouteApp`)
- Modify: `main/handlers/design-canvas.ts` (`pageFileContext` passes the `RouteApp` to `routeFiles`)
- Create: `tests/fixtures/design-mock-routes/` (a mock app built from the template with `src/routes/{index,settings,settings-v2,billing.index,$slug,_layout}.tsx` and a `node_modules` symlink made by the test)
- Test: `app-detect.test.ts`, `app-routes.test.ts`, `app-page-files.test.ts`, `app-server-main.test.ts`, and `main/services/design-canvas/app-server/mock-route-path.test.ts` (new, `core-git`)

- [ ] **Step 1: Write the failing tests:**
  - `app-detect.test.ts`:
    - `"a design-app folder is a candidate, and the marker makes it a mock"`;
    - `"design-app-3 is found too, design is not"`;
    - `"an Electron root with a mock app gives the mock as the single web target"` (`designTarget` is `single` on `design-app`);
    - `"a linked design-app is skipped"`;
    - `"workspaces [\"*\", \"!design-app\"] still finds the mock, as its own install root"`: `kind: "web"`, `mock: true`, and its install root is `design-app`, not `.`;
    - the existing `"an excluded workspace pattern drops that folder"` (`"!packages/legacy"`) passes unchanged, and a new row adds `"!apps/old"` dropping a fixed-container folder.
  - `app-routes.test.ts`: `"a mock app's routes come from src/routes with the flat rule"`, on the fixture: `/`, `/settings`, `/settings-v2` and `/billing`, with `$slug` and `_layout` not listed.
  - `app-page-files.test.ts`: `"⌘D on a mock route copies settings.tsx to settings-v3.tsx"`, with `-v2` taken. `"Trash finds the single owner of /settings"`.
  - `written-pages.test.ts`: `"a route written into a mock app is placed"`, through `writtenRouteData` and `routeForWrittenFile` with a `{framework: "vite", mock: true}` candidate (today's code finds no conventions for `vite`).
  - `main/handlers/design-canvas.test.ts`: `"⌘D's page-file context knows a mock app's routes"`, through `pageFileContext` and `routeFiles`.
  - `app-server-main.test.ts`: `"adding the marker changes the detection shape and re-walks routes"`.
  - `mock-route-path.test.ts`: `"the template's routePath agrees with main's rule on every concrete route"`. It imports `resources/design-app-template/src/aiden/route-path.ts` and `routeFromFile("tanstack", …)`, over a hand-written table and every file in `tests/fixtures/design-live-routes/src/routes/`. Where main's rule gives a concrete route, both must give the same one. Where it doesn't, `routePath` must give `null`.
  - `app-server-main.test.ts`:
    - `"with the flag on, a react-nonweb workspace's snapshot offers react-nonweb mocks"`;
    - `"an empty workspace's snapshot offers the starter"`;
    - `"a runner workspace's snapshot refuses with workspace-runner"`;
    - `"with the flag off there is no mock field"`.
- [ ] **Step 2: Run** the suites. Expected: FAIL.
- [ ] **Step 3: Implement.** `mockFolderStates` reads each `MOCK_FOLDERS` entry with `lstat` and a bounded no-follow read of its `package.json`.
- [ ] **Step 4: Run.** Expected: PASS. Register the new suite and run `npm run test:ci-policy`. Commit `feat(design): detection and routes know mock apps (3d)`.

### Task 5: Writing the mock app

**Files:**
- Create: `main/services/design-canvas/app-server/mock-app.ts`
- Modify: `main/services/design-canvas/design-md/draft.ts` (`designMdDraftResultFor`), `reader.ts` (`exportContent`, over the worker's existing `export` op), `locate.ts` (`invalidate`)
- Test: `main/services/design-canvas/app-server/mock-app.test.ts` (new, `core-git`), and the existing `draft`, `reader` and `locate` suites

- [ ] **Step 1: Write the failing tests** (temp workspaces, the real template folder):
  - `"a starter scaffold writes the template's files exactly and adds the canvas.json entry"`. Every written file's bytes equal the template's, `aiden.mock.json` is the starter, and canvas.json gains `{root: "design-app", script: "dev"}` with existing entries and unknown fields kept.
  - `"a react-nonweb scaffold writes the alias, stubs and globals"`, on an Electron fixture with `src/renderer/App.tsx` and `src/preload.ts` exposing `api`.
  - `"nothing is overwritten"`: a `design-app/README.md` created between the folder choice and the write makes the write fail, and the person's file is unchanged.
  - `"a link anywhere on the path refuses"`: `design-app` as a link, and `design-app/src` replaced by a link after `mkdir` (a hook in the test), both leave the link target untouched.
  - `"a failure halfway removes only what was written and unchanged"`: inject a write failure on the fifth file. The first four are removed, and a file the test changed meanwhile is kept and reported.
  - `"verification fails when a written file changed before approval"`.
  - `"the template is read bounded"`: a template folder with a link, a 2 MiB file or 65 files gives `template`.
  - `"the drafted DESIGN.md replaces the starter when the project has tokens, and theme.css is its css-vars export"`, through the real worker.
  - `"a project with no tokens keeps the starter pair"`.
  - `"a worker that times out keeps the starter pair and says why"`, with a fake reader.
  - `"a draft whose export fails writes neither drafted file"`: a fake reader whose `exportContent` rejects. Both written files equal the template's.
  - `"a draft source that is a link out of the workspace is refused"` (`designMdDraftResultFor`'s confinement).
  - `"rollback reads with O_NOFOLLOW"`: a written file swapped for a link to an outside file before rollback is left alone, and the outside file is untouched.
  - `reader` suite: `"exportContent gives the same CSS as export on the same text"`, through the real worker.
  - `locate` suite: `"invalidate makes the next roots call see a new design-app/DESIGN.md"`.
  - `"a folder path change mid-write aborts and rolls back"`, with a fake admission.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** per S107, S109 and S110, writing with `writeConfinedFile(…, {create: true})` and verifying with `readRegularFileBytes`.
- [ ] **Step 4: Run.** Expected: PASS. Register and run `npm run test:ci-policy`. Commit `feat(design): write a mock app confined, create-only and verified (3d)`.

### Task 6: Scaffolding in DesignAppServers, and analytics

**Files:**
- Modify: `main/services/design-canvas/app-server/app-server-main.ts` (`scaffold`; the declined-key memory; the `/` placement once `running`, through `placeMockHome`)
- Modify: `main/services/design-canvas/app-server/app-consent.ts` (the `scaffold` request kind, one card per workspace)
- Modify: `main/services/design-canvas/app-server/app-records.ts` (only if `approveShown` needs the `scaffold` reason)
- Modify: `main/services/design-canvas/main.ts` (the template dir and placement deps)
- Create: `main/services/design-canvas/mock-home.ts` (`placeMockHome`, S113) and `mock-home.test.ts` (`core-git`)
- Modify: `main/services/analytics/analytics-events.ts`, `docs/analytics.md`
- Test: `app-server-main.test.ts`, `app-consent.test.ts`, `mock-home.test.ts`, `main/services/analytics/analytics-feature-reports.test.ts`, and the registry's existing test

- [ ] **Step 1: Write the failing tests** (fake `backgroundJobs`, fake toolchain, temp workspaces):
  - `"no install job starts before Allow"`: a scaffold waits on the card. Before the answer, the fake jobs list is empty, and no file exists.
  - `"Not now writes nothing, starts nothing and sends declined; Aiden's next scaffold gets no card; the person's does"`.
  - `"an unanswered card, a Remote owner, a refusal and a toolchain problem start nothing and send nothing"`.
  - `"Allow writes, approves the written fingerprint, installs with npm ci and starts without a second card"`. The fake jobs see `npm ci` then `npm run dev` in `design-app`, and the consent spy saw one card.
  - `"a file Aiden changes after the scaffold asks again on the next start"`: edit `vite.config.js` and restart, and the `changed` card appears.
  - `"an existing mock app isn't scaffolded again"`: `existing`, and `start` takes 2b's path.
  - `"node-missing answers before any card"`, and the snapshot's `mock.problem` carries it. `"the person's scaffold clears the toolchain cache, so a Node installed since is found"`.
  - `"a failed install keeps the files, and Retry reinstalls"` (S47).
  - `"the running mock's / is placed once on the resolved page and reported as call site 7"`: the `onAppFrameAdded` spy is called once. A second scaffold call answers `existing`, and nothing is reported.
  - `mock-home.test.ts`: `"/ lands on a page that already has notes and frames"`; `"an existing / frame is focused, not duplicated, and not reported"`; `"a chat that left design mode before the write places nothing"`.
  - `"a pending / survives a failed install and lands on the Retry that reaches running"`; `"a restart forgets it"`.
  - `"the scaffold card's key closes on forgetWorkspace"`: `closeAll` with the workspace prefix answers the open card as unanswered.
  - `"a scaffold invalidates the DESIGN.md roots"`: the roots spy sees `invalidate(workspaceRoot)` after `scaffolded`, and the next roots call lists `design-app`.
  - `"a packaged build ignores AIDEN_E2E_DESIGN_APP_NODE_MODULES"`: with `isPackaged: true`, the knob makes no link and the install job runs.
  - `"onPhase reports card, then writing, then app"` and `"an abort during the card ends the wait, and an Allow after it still writes and installs"`.
  - `"flag off: scaffold is unavailable"`.
  - Analytics: `"design_app_scaffolded accepts only kind and outcome"` and `"design_md_drafted accepts source mock"`, using the registry's own validation. In `analytics-feature-reports.test.ts`, the existing case that expects `source: "mock"` to be dropped now expects it kept, and `design_app_scaffolded` gets an accept case and a drop case (an extra `folder` property).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** per S102, S106, S112, S113 and S115.
- [ ] **Step 4: Run.** Expected: PASS. Commit `feat(design): scaffold a mock app after the person's Allow (3d)`.

### Task 7: The tool, the IPC, the chip and the card

**Files:**
- Modify: `main/services/design-canvas/app-server/app-tool.ts` (the `scaffold` action and its answer, fenced like `routes`)
- Modify: `main/services/approval-gate/workspace-tool-approval.ts` (the reviewed reason's text)
- Modify: `main/handlers/design-app.ts` (`designApp:scaffold`, through `rendererDocumentOwner` and `chatRunsDesignApps`; `DesignAppChat.designMode`; the `pageOnScreen` dependency)
- Modify: `main/handlers/design-canvas-main.ts` (wires `pageOnScreen` from `designCanvasViews` and the store)
- Modify: `main/services/llm-client.ts` (the tool's `onScaffolded` resets the turn's `createWrittenRouteTurn`)
- Modify: `renderer/lib/ipc.ts` (`designAppApi.scaffold`)
- Modify: `renderer/design/design-canvas.tsx` (passes `pageId` and `flush` to the chip)
- Modify: `renderer/design/design-app-chip.tsx` (**Add design app…**, the refusal row, the toolchain problem with Retry)
- Modify: `renderer/design/design-app-consent.tsx` (the `scaffold` card)
- Test: `app-tool.test.ts`, `main/handlers/design-app.test.ts`, `renderer/design/design-app-chip.test.tsx`, `renderer/design/design-app-consent.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - `app-tool.test.ts`:
    - `"status carries the mock offer, a refusal's message and a toolchain problem"`;
    - `"scaffold needs no root"`;
    - `"scaffold answers the root, kind, placement, aliases and draft"`;
    - `"scaffold counts toward four starts a turn"`;
    - `"scaffold refuses with the refusal's message"`;
    - `"scaffold after the turn's signal aborts stops waiting, not the install"`, and `"scaffold with stillAvailable false before acting does nothing"`;
    - `"scaffold's wait outlives 90 s while the card is open"`: a fake clock, the scaffold reporting `card` and answering at 110 s; the tool answers `scaffolded`, not the timeout;
    - `"a route written after scaffold in the same turn is placed"`: a file write before the scaffold loads an empty owner list; `onScaffolded` resets it, and the later `design-app/src/routes/settings.tsx` write is placed.
  - `design-app.test.ts`:
    - `"designApp:scaffold needs an attended design-mode chat with a writable folder"`;
    - `"a page id that isn't on screen is refused"`;
    - `"a chat not in design mode is refused"`;
    - `"refusals throw, and success resolves with the scaffold result"`;
    - `"flag off answers unavailable"`.
  - `design-app-chip.test.tsx`:
    - `"no web app: Add design app… raises the card"`: the existing `target: "none"` case gains `mock: {offer: "starter"}`, and the menu is Add design app… then Connect running server…;
    - `"the chip flushes the canvas before it asks"`: the `flush` spy runs before `scaffold`, which gets the page id;
    - `"a refused offer shows its message as a disabled row"`;
    - `"node-missing shows the install text with Retry, and Retry calls scaffold"`;
    - `"once the mock runs, the chip reads Design app · :5173"`.
  - `design-app-consent.test.tsx`:
    - `"the scaffold card names the folder, the packages with versions, npm ci, npm run dev and the network sentence"`;
    - `"Electron, Tauri and React Native questions differ; the starter asks the no-web-app question"`;
    - `"focus starts on Not now, and Escape is Not now"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read the two UI reference docs first.
- [ ] **Step 4: Run.** Expected: PASS. Commit `feat(design): design_app scaffold, Add design app… and the scaffold card (3d)`.

### Task 8: Remove the v1 mockup path

**Files:**
- Delete: `main/services/design-canvas/design-system.ts`, `design-system-offers.ts`, and the `designSystemOfferLine` and `DesignSystemOffers` cases
- Move: the rest of `design-system.test.ts` and `design-system-offers.test.ts`'s `findWorkspaceDesignSystem` case into `main/services/design-canvas/design-md/style-scan.test.ts` (new). The two old files are deleted after the move, their entries in `scripts/ci-test-registry.json` and `test:design-mode` are replaced by the new file's (`core-git`), and the moved cases keep their titles and assertions
- Create: `main/services/design-canvas/retired-design-system-offers.ts` and its test (`core-git`); call it from `main/index.ts` beside `cleanUpRetiredModelScoring()`
- Modify: `main/services/design-canvas/design-md/turn-wiring.ts` (`createDesignNoteOffers` without `v1` and `folderPath`), `turn-wiring.test.ts`
- Modify: `main/services/llm-client.ts`:
  - drop `designSystemOffers`; `designPromptMode` from the flag and `liveAppsOn`;
  - split `placeWrittenRoute` out of `if (placeWrittenPage && …)` in the tool loop and in ACP's `onFileWrite`;
  - with the flag on, build no `placeWrittenPage` and no `createDesignPageScanner`, and note no `design/` page in `recentWrittenPages`;
  - with the flag on, call `writtenPageInspector?.written(page)` directly for a written `design/` page in the tool loop and in ACP's `onFileWrite` (S114);
  - `withDesignModeSection(…, {live: designLive})`
- Modify: `main/services/design-canvas/design-md/turn.ts` (`LIMITED_APP_PROMPT_MARKER` counts as a section to replace)
- Modify: `main/services/design-canvas/main.ts` (drop the singleton; no I/O added)
- Modify: `main/services/design-canvas/offer-log.test.ts` (the one test title)
- Modify: `main/services/design-canvas/skill.ts` (`CRAFT`, flag-off `HTML_METHOD` minus one sentence, the live "No web app: a design app" section, `AIDEN_DESIGN_SKILL_LIVE.description`)
- Modify: `main/services/design-canvas/canvas-tools.ts` (every `design/` HTML bullet out of the live and limited sections, `LIMITED_DESIGN_MODE_PROMPT_SECTION` and its marker, `LIVE_DESIGN_MD_PROMPT_BULLET`, `designModePromptSection(designMd, mode)`), and every `withDesignModeSection` caller
- Modify: `main/services/design-canvas/written-pages.ts` (`pagesWrittenInChat`'s `includeHtmlPages`), `entry.ts` (passes `!live`)
- Test: `skill.test.ts` (its `designModePromptSection` callers at the boolean argument), `canvas-tools.test.ts`, `design-md/turn.test.ts`, `prompt-prefix-stability.test.ts`, `turn-wiring.test.ts`, `written-pages.test.ts` (which also covers `entry.ts`), `style-scan.test.ts`, and the llm-client design-mode suites that build the section

The live skill's new section reads:

> No web app: a design app.
> - When design_app is among your tools and design_app status says the workspace has no web app (target react-nonweb or none), and the person wants to design something, call design_app scaffold. It asks the person on its own card, so don't ask first with ask_user_question. If they choose Not now, design with notes, shapes, flows and images, and don't ask again unless they do.
> - When status refuses (a workspace runner, an app design mode can't identify, a missing dev script), say what the refusal says. Don't make a design app.
> - A design app's pages are route files in its src/routes/ (settings.tsx is /settings; a variant is settings-v2.tsx). For a project that isn't a web app, build each screen from the project's own components through the aliases in its aiden.mock.json (@app points at the project's UI). Stub desktop-only APIs in src/stubs/ and fill their mockData so the components render. When a component can't render outside the app, build that part by hand in React. Always say which parts are real components and which are mocked.
> - The design app's DESIGN.md is its design system. When you change it, export it with design_system export, format css-vars, into src/theme.css.
> - Moving a chosen direction into the real app is an ordinary coding change in the project's own source, outside the canvas.
> - When design_app is not among your tools, live apps can't run in this chat. Design with notes, shapes, flows and images; existing design/ pages still show as frames.

- [ ] **Step 1: Write the failing tests:**
  - `skill.test.ts`:
    - `"flag off: the skill is today's but for the tokens-offer sentence"`: compare against a copy of today's text with that one sentence removed, written into the test by hand once (the oracle is the spec's removal, not the new constant);
    - `"flag on: the skill never teaches design/ HTML pages and explains scaffold"`: no `design/tokens.css`, no "workspace HTML", and it mentions `design_app scaffold` and `src/routes/`.
  - `canvas-tools.test.ts`:
    - `"each prompt mode is static"`: two calls give the same text;
    - `"live and limited never say to write design/ HTML"`;
    - `"v1 is today's section"`;
    - `"a stored limited section is replaced on a live turn and the other way round"`;
    - `"a flag-off turn replaces a stored limited section with v1"` and `"a flag-on turn with neither design_system nor design_app replaces a stored v1 section with limited"` (`design-md/turn.test.ts`, through `withDesignModeSection`);
    - `"the live DESIGN.md bullet doesn't name design/tokens.css"`.
  - `turn-wiring.test.ts`: `"flag off the status line is the plain line"`, `"flag on it carries the DESIGN.md sentence"`.
  - `written-pages.test.ts` (it covers `entry.ts` too): `"flag on: a written design/ page isn't placed or noted; an existing file frame still reloads"`, and `"flag off: today's placement"`. Entry: `"flag on, pagesWrittenInChat leaves out design/ pages and keeps routes"`.
  - The llm-client tool-loop suite: `"a route write is placed when no page placer exists"`, for the tool loop and ACP's `onFileWrite`.
  - The same suite: `"flag on: editing a design/ page a file frame shows attaches a check report and places nothing"`, and `"flag on: a design/ page no frame shows gets no report"`, for both paths.
  - `retired-design-system-offers.test.ts`: `"the old offers log and key are removed, a missing file is fine, and nothing else in userData is touched"`.
  - `style-scan.test.ts`: the moved cases pass unchanged against `design-md/style-scan.ts`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suites above, then `npm run test:design-mode`. Expected: PASS. Run `npm run test:ci-policy`. Commit `refactor(design): remove the v1 tokens offer and, with live apps, the HTML mockup path (3d)`.

### Task 9: `data-aiden-src` in the template

**Files:**
- Modify: `resources/design-app-template/src/aiden/jsx-dev-runtime.ts`, `vite.config.js` (per Probe 2's branch)
- Modify: `main/services/design-canvas/app-frames/react-source-walk.ts` (`stamp` parses `ws:`, `walk()` carries `base`, `ReactSourceResult.base`)
- Test: `main/services/design-canvas/app-server/design-app-template.test.ts`, `main/services/design-canvas/app-frames/react-source-walk.test.ts`

- [ ] **Step 1: Write the failing tests** (the shim as a module, with a fake `jsxDEV`):
  - `"a host element gets data-aiden-src with ws:, the workspace path and line"`;
  - `"a workspace under a linked folder still matches"`: the config's realpath'd root against a `/private/var`-style `fileName`;
  - `react-source-walk.test.ts`: `"a ws: stamp is read as workspace-relative, and the walk's result carries base; an unprefixed one is as before"`;
  - `"a component element, an element that has one already, and a source outside the workspace are left alone"`;
  - `"the value is capped at 256 characters and never absolute or with .."`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** If Probe 2 deferred S111, remove the shim from the template, skip this task, and record that in As built.
- [ ] **Step 4: Run.** Expected: PASS. Commit `feat(design): data-aiden-src stamps in mock apps (3d)`.

### Task 10: E2E, lanes and screenshots

**Files:**
- Create: `tests/fixtures/design-mock-electron/`: `package.json` (`electron` and `react` dependencies, no scripts Vite could run), `src/renderer/components/Button.tsx` (no external imports), `src/renderer/styles.css` (`--brand` and a font stack), `src/preload.ts` (`contextBridge.exposeInMainWorld("api", …)`)
- Create: `tests/fixtures/design-mock-empty/` (a `README.md` only)
- Modify: `main/services/design-canvas/app-server/mock-app.ts`: the unpackaged-only knob `AIDEN_E2E_DESIGN_APP_NODE_MODULES=<absolute path>`. After the write, before the start, it symlinks the mock's `node_modules` to that path, so 2b sees an install and nothing reaches the network (spec §7's rule). A packaged build ignores it, and Task 6 has a case for that.
- Create: `tests/e2e/design-mock-app.spec.ts` (with `tests/e2e/design-live-helpers.ts`)
- Modify: `scripts/ci-e2e-spec-map.json`: `"design-mock-app.spec.ts"` with these prefixes:
  - `resources/design-app-template/`, `tests/fixtures/design-mock-`;
  - `main/services/design-canvas/app-server/mock-app`, `main/services/design-canvas/app-server/app-detect`, `main/services/design-canvas/app-server/app-tool`, `main/services/design-canvas/app-server/app-server-main`;
  - `main/services/design-canvas/skill`, `main/services/design-canvas/canvas-tools`, `main/services/design-canvas/written-pages`;
  - `renderer/design/design-app-chip`, `renderer/design/design-app-consent`, `renderer/shared/design-app`, `tests/e2e/design-live-helpers.ts`;
  - `main/services/design-canvas/app-server/app-routes`, `main/services/design-canvas/app-server/app-page-files`, `main/services/design-canvas/entry`, `main/services/design-canvas/mock-home`, `main/services/design-canvas/design-md/draft`, `main/handlers/design-app`, `main/handlers/design-canvas`.
- Modify: `tests/e2e/design-app-status.spec.ts:320-327`: the no-web-app chip's menu is now `["Add design app…", "Connect running server…"]` with the flag on.

- [ ] **Step 1: Write the spec.** Each test seeds its own workspace copy. The fake model drives Aiden. Cases:
  - **A. Electron project, Allow.** The fake model calls `design_app scaffold`. The card asks the Electron question and lists `react`, `react-dom`, `vite` and `@vitejs/plugin-react` with versions. Press Add design app (focus, Enter). `design-app/` exists with `aiden.mock.json` holding `@app` → `src/renderer` and `api`. The chip reads "Design app". A live `/` frame shows the starter heading, and its `<h1>` has `data-aiden-src` starting `ws:design-app/src/routes/index.tsx:` (read through the frame, unless Task 9 was deferred).
  - **B. A route from the project's own component.** The fake model writes `design-app/src/routes/settings.tsx`, which imports `@app/components/Button`. The `/settings` frame lands by itself and shows the real button's text, styled with `--brand`.
  - **C. ⌘D on a mock route.** `/settings` selected, ⌘D creates `settings-v2.tsx` and its frame. ⌘Z removes both.
  - **D. Not now.** On the empty fixture, the starter question shows. Not now leaves no `design-app/`. A second scaffold from the fake model shows no card and answers `consent-declined`. The chip's Add design app… shows the card again.
  - **E. Refusal.** A fixture whose root script is `turbo run dev` gives no card. The tool answers `workspace-runner`, and the chip shows its message.
  - **F. Flag off.** No chip and no `scaffold`. Aiden's design/ HTML page still lands (today's v1 behaviour).
  - **G. Flag on, an existing design/ page.** It shows as a `file` frame added by the person, and reloads on save. A new `design/` file written by the fake model doesn't land by itself.
- [ ] **Step 2: Run** in the Space, with the template's `.npmrc` tracked: `npm run test:e2e:space -- tests/e2e/design-mock-app.spec.ts`, then `design-app-status.spec.ts`, the 3a–3c live specs and the flag-on and flag-off v1 design suites.
- [ ] **Step 3: Screenshots** in light and dark (`shoot`), for the PR body:
  - the Electron scaffold card;
  - the starter card;
  - the chip with Add design app…;
  - the chip with node-missing;
  - the chip with a network install failure;
  - the starter `/` frame;
  - B's `/settings` frame.
- [ ] **Step 4: Run** `npm run test:ci-policy`. Commit `test(design): mock app E2E (3d)`.

### Task 11: Packaging, the CLI and the native-clients guard

- [ ] Extend `scripts/verify-macos-package.mjs` and `scripts/verify-linux-package.mjs` (beside `verifyPackagedDesignMdLinter`). macOS checks `Contents/Resources/design-app-template/…` and Linux `resources/design-app-template/…` (its lowercase unpacked layout): `package.json`, `package-lock.json`, `.npmrc`, `.gitignore`, `vite.config.js` and `src/aiden/route-path.ts` packed as regular files, with the packed `.npmrc` holding `ignore-scripts=true`, and that the packed `package.json` carries the marker. Extend `scripts/verify-macos-package.test.mjs` with the missing-template case.
- [ ] Run a local unsigned `--dir` build and the macOS check. Record it in As built.
- [ ] Run `npm run cli:build` and `cd packages/cli && npm test`. Expected: PASS. The CLI bundle doesn't import `design-canvas` today; if that's still so, record that 3d's modules aren't in it.
- [ ] Check that no Aiden Remote contract changed: `git diff origin/t3/design-mode-v2-p3c -- main/services/remote* main/services/aiden-remote* ios android` is empty, and the canvas JSON gains no stored field. Record this in As built.

### Task 12: Docs, memory and spec amendments

**Files:**
- Modify: `docs/design-mode.md`:
  - a new "Design apps" section (`#design-apps`): when Aiden asks, the two questions, what the card lists, the folder rule and the marker, what's written, `npm ci` from the npm registry with install scripts off and the person's own registry settings, the routes, `aiden.mock.json`'s aliases, stubs and globals, the drafted `DESIGN.md`, the refusals, Node missing and install failures with Retry, and that deleting the folder removes it;
  - "Live apps": no more `design/` HTML mockups with the flag on;
  - "Privacy": what stays on the device (everything but the package downloads).
- Modify: `PRODUCT.md:71`. Remove the tokens-offer sentence (unconditional), and add one sentence for design apps behind the flag.
- Modify: `README.md`, only if its design-mode line mentions the tokens offer or HTML mockups for live apps.
- Modify: `docs/analytics.md` (S115's rows).
- Modify: `docs/plans/README.md` (3d built, with the PR link once opened).
- Modify: the spec:
  - the status line;
  - §5.4 and §6.8 (S102–S104, S107, S112–S114);
  - §6.9 "Mock apps" (S110: `css-vars`);
  - §6.10 (S115);
  - §8's 3d row and Phase 7 row (S114);
  - §11 item 5 (S111);
  - append S102–S116 as amendments.
- Modify: `.memory/design-mode.md`. Add a "v2 Phase 3d" section: the template and its pins, the lock script, the card as the consent, the folder rule, the marker, the route convention, the config's validation, Probe 2's outcome, the v1 removal's split between the flag states, and E2E gotchas.
- Modify: this plan's As built.

- [ ] Fix the known stale lines: `docs/design-mode.md:49` (the chip menu "has only Connect running server…"), `:109` (routes and `design/` pages together), `:112` (a workspace without a web app keeps `design/` HTML pages), `:116` (Privacy), `docs/analytics.md:55` (`design_md_drafted` gains `mock`) and `:57` (`design_app_frame_added` call site 7).
- [ ] Confirm `renderer/components/onboarding-feature-gallery.tsx:127-134` needs no change: design apps stay behind the experimental flag, and the gallery shows only shipped features.
- [ ] Search for stale claims: `rg -n "tokens.css|specimen.html|tokens offer|design/\*\.html|mockup|design-app" docs README.md PRODUCT.md main/services/design-canvas/skill.ts`. Fix any that 3d makes stale.
- [ ] Commit `docs(design): design apps and the v1 mockup removal (3d)`.

## Spec amendments S102–S116 (Task 12 writes these)

| # | Amendment | Section |
|---|---|---|
| S102 | The ask is one main-owned `scaffold` card, also the launch consent; raised by `design_app scaffold` or the chip's Add design app…; declines as 2b's; desktop window owner only | §6.8 |
| S103 | The offer table: `react-nonweb` mocks, the starter for no React or web app (and non-React desktop apps); refusals for runner, unknown framework, no dev script, invalid package.json, truncated, any web or configured root, unsupported config, read-only | §6.8 |
| S104 | `design-app`, then `design-app-2`…`-9`; the `"aiden": {"designApp": 1}` marker decides reuse only; never `design/`; refused when the root's workspace patterns cover the folder | §6.8 |
| S105 | The template: four exact pins equal to Aiden's lockfile, a committed registry lockfile, `.npmrc`, a self-contained `vite.config.js` with inline PostCSS, no Tailwind, always npm, upgraded only with a release, `extraResources` | §6.8 |
| S106 | Network only through `npm ci` after the Allow; the person's npm registry settings; sha512 integrity; no install scripts, audit, fund or update check; reinstalls under 2b's consent | §6.8, §6.2.3 |
| S107 | Confined, create-only, bounded writes, verified before the fingerprint is approved; rollback of unchanged files only; the canvas.json entry is `{root, script}` with no `mock` field | §6.8 |
| S108 | Detection sees `design-app*` folders; `mock` from the marker; mock routes use TanStack's flat-file rules, so 3b's placement and 3c's ⌘D and Trash work; concrete routes only | §6.3.6, §6.8 |
| S109 | `aiden.mock.json` (aliases, stubs, globals) as validated data; alias targets refuse `.git`, `.aiden`, hidden folders and protected credential paths; `server.fs.allow` is the mock, its `node_modules` and the alias folders, with an explicit credential `fs.deny`; main's first pass: UI root, shell stubs, `exposeInMainWorld` globals; one React | §6.8 |
| S110 | `theme.css` is the `css-vars` export (amends `css-tailwind`); a clean-linting starter; react-nonweb drafts from the project's style files at scaffold, lint and export in memory before anything is written, else the starter; DESIGN.md's roots are invalidated after a scaffold | §6.9 |
| S111 | `data-aiden-src` from a JSX dev-runtime shim (probe first); `ws:`-prefixed workspace-relative `path:line` from a realpath'd root; `_debugStack` paths stay app-relative; Phase 4 resolves each by its base | §11 item 5, S11 |
| S112 | Toolchain before the card; install failures keep the files, with fixed network or auth hints from npm's codes; the chip's Add design app…, refusal row and problem | §6.8, §6.2.5 |
| S113 | `/` placed once on the resolved page after the start, whatever else is on it, an existing `/` focused; a pending placement survives one Retry in the run; iterations are `src/routes/` files; the tool waits for the card, then like `start` | §6.8 |
| S114 | The tokens offer is deleted in both flag states; flag on, no prompt or skill teaches `design/` HTML and written pages don't auto-place; flag off keeps v1's HTML method until Phase 7 deletes it | §5.4, §8 |
| S115 | `design_app_scaffolded {kind, outcome}`; `design_md_drafted` source `mock`; `design_app_frame_added` call site 7 | §6.10 |
| S116 | The gates; `design_app` stays cardless because scaffold has its own card; desktop only; no Remote contract change | §6.2.4, §6.8 |

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-app.test.ts main/services/design-canvas/app-server/mock-app-core.test.ts main/services/design-canvas/app-server/mock-route-path.test.ts main/services/design-canvas/app-server/design-app-template.test.ts`
2. `npx tsx --test main/services/design-canvas/app-server/mock-app.test.ts main/services/design-canvas/app-server/app-detect.test.ts main/services/design-canvas/app-server/app-routes.test.ts main/services/design-canvas/app-server/app-page-files.test.ts`
3. `npx tsx --test main/services/design-canvas/app-server/app-server-main.test.ts main/services/design-canvas/app-server/app-consent.test.ts main/services/design-canvas/app-server/app-tool.test.ts main/handlers/design-app.test.ts main/handlers/ipc-contract.test.ts`
4. `npx tsx --test main/services/design-canvas/skill.test.ts main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/design-md/turn-wiring.test.ts main/services/design-canvas/written-pages.test.ts main/services/design-canvas/offer-log.test.ts`
5. `npx tsx --test renderer/design/design-app-chip.test.tsx renderer/design/design-app-consent.test.tsx`
6. `npm run test:design-mode`
7. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
8. `npm run lint` and `npm run check:aiden-rules`
9. `npm run test:ci-policy`
10. `npm run build` and `npm run cli:build`
11. In the Cua Space: Task 10's spec, `design-app-status.spec.ts`, `design-live-frames.spec.ts`, `design-live-routes.spec.ts`, `design-live-viewports.spec.ts`, and the flag-on and flag-off v1 design suites.
12. On the host: the macOS package check from Task 11.

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries Task 10's screenshots in light and dark.

## Risks and edge cases

| # | Risk | Mitigation |
|---|---|---|
| 1 | **A lockfile made on a Mac misses Linux bindings.** | Probe 4 runs `npm ci` from it in the Space. The lock script adds platform passes if needed. |
| 2 | **A registry mirror or proxy rewrites URLs.** | No `registry` in `.npmrc`, so the person's settings apply. Integrity still has to match. A refusal shows the auth hint. |
| 3 | **The project's components need its providers, router or i18n.** | Aiden wraps routes in those providers or mocks them, and says what's mocked. Hand-built parts are the fallback (§6.8). |
| 4 | **The project's CSS needs Tailwind or another compiler.** | Aiden adds it with `run_command` (approved), and the edited config asks again (S2). The draft's `theme.css` still gives the tokens. |
| 5 | **Two Reacts** from aliased files. | `resolve.dedupe` (S105). B's E2E case renders a real project component. |
| 6 | **The person deletes `design-app/`.** | Detection drops it. The stale canvas.json entry is ignored, because `configuredRoots` needs a web candidate. The next offer can scaffold again. |
| 7 | **The person commits `design-app/`.** | It's their choice. `.gitignore` keeps `node_modules` and caches out, and the README says what the folder is. |
| 8 | **The marker is planted in a hostile repo.** | It grants nothing: S2's card still guards the start (S104). |
| 9 | **Aiden edits `aiden.mock.json` to read outside the workspace, or a credential inside it.** | The config refuses targets outside the workspace and protected credential paths (Task 2). `server.fs.allow` is only the mock, its `node_modules` and the validated alias folders, never the workspace root, and an explicit `fs.deny` adds `.npmrc`, `.netrc`, keys, `.ssh`, `.aws`, `.aiden` and `.env*` to Vite's defaults. The dev server only listens on loopback. |
| 10 | **An HTML page the person asks Aiden to tweak, with the flag on.** | Its frame still works. The live skill no longer teaches the tweaks block, so Aiden reads the page's own block if it has one. This is accepted until Phase 7, and noted in docs. |
| 11 | **The flag-off skill changes by one sentence.** | It's intentional (S114), and the change is called out in the PR. Flag-off prompt caching pays one miss per chat once. |
| 12 | **`npm ci` is slow on a cold cache.** | The chip shows Installing… with logs. The tool's 90 s wait answers with the phase, and `/` is placed once it's running (S113). |
| 13 | **The source arg isn't passed to `jsxDEV`.** | Probe 2, with S111's fallback or deferral to Phase 4's `_debugStack` path (S64). |
| 14 | **A workspace with a `design-app` that the person later turns into a real app.** | Without the marker it's just a web candidate, so S103 finds `has-web-app` and offers nothing. |
| 15 | **A Vite bump brings another package with an install script.** | Task 2's allowlist test fails, and the bump needs a decision: allowlist it with a reason, or pin around it. `ignore-scripts=true` means it wouldn't run either way. |
| 16 | **A corporate mirror serves a re-packed tarball.** | Its `sha512` doesn't match the lockfile, and `npm ci` fails with an integrity error. S112 shows it with the network hint; Aiden can't fix a mirror, and the docs say so. |

## Open questions

Each has the answer this plan uses. The owner may override.
1. **Ask with `ask_user_question`, as the spec words it, or a main card?** *A main-owned card that is also the launch consent* (S102). Main can't verify a chat answer, and the yes gates network access.
2. **Tailwind in the template?** *No.* Four dependencies. Aiden adds Tailwind with an approved `run_command` when a project needs it (S105).
3. **`theme.css` as `css-tailwind` (the spec) or `css-vars`?** *`css-vars`*, because the template has no Tailwind (S110).
4. **Delete the tokens offer for flag-off users now, or at Phase 7?** *Now*, as the spec's §11 item 2 and S6 say. The flag-off skill drops the one sentence that promised it (S114). **Decided by the owner (2026-11-27): delete it in 3d for everyone**, following spec S6. Review-p3d-plan-2 checked every reference and found nothing that breaks once Task 8 and Task 12 (`PRODUCT.md:71`) are done.
5. **Keep v1's HTML mockups for flag-off turns until Phase 7?** *Yes.* Flag-off is the shipped product, and its only way to design must last until the flag turns on (S114).
6. **Can the person start the flow without Aiden?** *Yes*, with the chip's Add design app… (S112).
7. **Count declines in analytics?** *Yes*, as `outcome: declined`. Unanswered cards are not counted (S115).
8. **Route convention for mock apps?** *TanStack's flat-file rules*, so 3b's and 3c's route features work unchanged (S108).
9. **Always npm, even in a pnpm or Yarn repository?** *Yes.* The mock is its own npm install root with a committed lockfile (S105).
10. **Remember a decline across restarts?** *No.* Memory only, like 2b's declines. The person's chip item always asks (S102).
11. **One mock app per workspace in a monorepo with several non-web React roots?** *Yes.* The source is the shallowest, and Aiden adds aliases for the others (S103).
12. **If the JSX source probe fails?** *A transform-based stamp if Vite exposes one, else defer the stamps to Phase 4* (S111).

## Applied review decisions (review-p3d-plan, 2026-11-27)

| # | Finding | Decision |
|---|---|---|
| 1 | `fsevents` 2.3.3 has `hasInstallScript` | Fixed: S106 keeps `ignore-scripts=true` with an exact allowlist (`node_modules/fsevents`, optional, darwin); Task 2's test names it; Probe 4 checks the prebuilt binary and HMR on the Mac. |
| 2 | `mock` isn't carried through route plumbing | Fixed: `RouteApp` through `discoverRoutes`, `routeForWrittenFile`, `routeFiles`, `routeWalks`, `detectionShape`, `writtenRouteData` and `pageFileContext` (S108, Task 4 tests). |
| 3 | Excludes drop fixed folders | Fixed in round 2: only `MOCK_FOLDERS` are exempt from excludes, with `viaPattern` cleared; other fixed folders keep today's rule (S104, Task 4 tests). |
| 4 | `placeWrittenRoute` nested in the page check; v1 wiring is in llm-client | Fixed, except the inspector: routes are split out, page placement, the command scanner and the timeline note are off with the flag on, `pagesWrittenInChat` gains `includeHtmlPages`. **Pushed back in part:** `writtenPageInspector` stays, since it places nothing and checks HTML pages the person still places by hand (S114). Round 2: it gets its own `written(page)` call in both paths with the flag on, because `placeWrittenPage` was its only caller. |
| 5 | Deleting the scanner's only tests | Fixed: moved to `design-md/style-scan.test.ts`, registered (Task 8). |
| 6 | `fs.allow` is the whole workspace; credentials | Fixed: allow is the mock, its `node_modules` and alias folders; explicit credential `fs.deny`; alias targets checked against a copy of `isProtectedCredentialPath`'s rules, tested against the real function (S109, Task 2). |
| 7 | The tool's 90 s wait vs the card | Fixed: `onPhase` gives the card `consentMs + graceMs`, then `settleMs`; a fake-clock test (S102, Task 7). |
| 8 | Packaging block, dotfiles, Linux path | Fixed: shared block only, dotfile filter, `assertLinuxBuildConfiguration`, per-platform paths (S105, Task 11). |
| 9 | `fallbackRoute` can't place `/` | Fixed: `placeMockHome` modelled on `placeAppRoute`, `placed \| already`, one retry (S113, Task 6). |
| 10 | IPC and chip plumbing | Fixed: throws like the other handlers, `designMode`, `pageOnScreen`, chip `pageId` and `flush` (S116, Task 7). |
| 11 | Draft result, stale roots, two-file write | Fixed: `designMdDraftResultFor`, `exportContent`, in-memory pair, `invalidate` (S110, Task 5). |
| 12 | Written-route turn cache | Fixed: `reset()` through `onScaffolded` (S116, Task 7). |
| 13 | Prompt wiring gaps | Fixed: `LIMITED_APP_PROMPT_MARKER`, `live: designLive`, live DESIGN.md bullet, every `design/` bullet, skill description, test callers (S114, Task 8). |
| 14 | Tests that pin today | Fixed: `design-app-status.spec.ts`, `analytics-feature-reports.test.ts`, `design-app-chip.test.tsx` in Tasks 10, 6 and 7. |
| 15 | Card files, consent key, row order | Fixed: `files`, `${workspaceId}\0\0scaffold`, real apps before `existing` (S102, S103). |
| 16 | Stamp path bases | Fixed: realpath'd root, `ws:` prefix, Phase 4 resolves by base (S111, Task 9). |
| 17 | Cleanup in `design-canvas/main.ts` | Fixed: `cleanUpRetiredDesignSystemOffers()` from `main/index.ts` (S114). Not added to onboarding reset: the file is gone after the first launch. |
| 18 | Paths, write helper, wording, packaged knob | Fixed: approval path, `writeConfinedFile` and `readRegularFileBytes`, `signal` wording, the packaged-knob test (S107, S116, Tasks 6 and 7). |
| 19 | Globs, Deno wording, user npmrc, Space sync | Fixed: `mockFolderCovered`, S103's starter row, S106's registry note, `.npmrc` tracked (S103, S104, S106, Task 2). |
| 20 | Spec-map prefixes, stale doc lines | Fixed: Task 10's prefixes, Task 12's lines and the gallery check. |

Open question 4 was decided by the owner on 2026-11-27: the tokens offer is deleted in 3d for everyone (S114, spec S6).

### Round 2 (review-p3d-plan-2, 2026-11-27)

| # | Finding | Decision |
|---|---|---|
| 1 | Exempting every fixed folder from excludes breaks `"!packages/legacy"` | Fixed: only `MOCK_FOLDERS` are exempt, with `viaPattern` cleared (S104, Task 4). |
| 2 | The kept inspector has no caller with the flag on | Fixed: a direct `writtenPageInspector?.written(page)` in both paths, with tests (S114, Task 8). |
| 3 | `ws:` in Case A; `walk()` and `ReactSourceResult` drop `base` | Fixed (S111, Tasks 9 and 10). |
| 4 | `status` lacks `mock`; Retry before the mock exists | Fixed: `status` carries `mock`, `scaffold` needs no root, the chip's Retry re-runs scaffold, which clears the toolchain cache (S112, Tasks 6 and 7). |
| 5 | Leftovers and nits | Fixed: the IPC throws everywhere, `placeMockHome` in Task 6, `DesignAppRoots` as a callable interface, `exportContent` in `reader.ts` only, a missing `node_modules` guard, more deny globs, the shared bullet prefix, `design-app-status.spec.ts` in Verification. |

## As built

Not built yet.
