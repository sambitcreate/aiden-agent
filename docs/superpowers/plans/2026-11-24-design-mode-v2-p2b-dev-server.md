# Design mode v2 — Phase 2b: the dev server process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Design mode can run the workspace's web app, safely and only when the person has agreed to it.
- `DesignAppServers` starts, installs, stops and restarts one dev server per workspace and app root, on top of `backgroundJobs`, with a `design` job owner that no chat owns (S7).
- Before the first start, and whenever the launch surface changes, the person sees one consent card naming the commands and the script text. Main keeps a hash of what they approved (S2).
- The server binds to loopback only (S14). Its origin is `http://127.0.0.1:<port>`, and it counts as ready only on a socket its own processes hold. An exposure check that fails closed watches it for as long as it runs.
- A server stops 60 s after no window shows that workspace's canvas, when the workspace changes or goes away, and when Aiden quits (S6).
- Aiden gets a `design_app` tool, recorded as a reviewed approval exception. 2c and 3a get a fixed status, consent and origin contract, so they don't change 2b's types.

**Architecture:**
- **Shared contract.** `renderer/shared/design-app.ts` holds the status, problem and consent types, the fixed problem messages, the display escaping and the IPC payload shapes. 2c's chip and 3a's frames read only these.
- **Pure core.** `main/services/design-canvas/app-server/app-launch-core.ts` takes a detected app, the scripts and a port, and returns the argv and environment. It also holds:
  - the readiness choice and the exposure check;
  - the install decision;
  - the fingerprint's canonical form.

  It does no I/O.
- **Disk and network edges.**
  - `app-fingerprint.ts` hashes the launch surface with bounded, no-follow reads.
  - `app-records.ts` keeps consents, install stamps and sticky ports in one userData file, and fails closed.
  - `app-ports.ts` picks a free loopback port.
  - DM's `canvas-config.ts` (extended here with `script` and `saveCanvasConfigApp`) reads and writes `.aiden/canvas.json`.
- **Process layer.** `backgroundJobs` gains:
  - a `design` owner;
  - argv spawning without a shell;
  - a rotating log;
  - its own running cap;
  - `designSockets(jobIds)`, which lists every listening socket of each job's process group and descendants, from one `ps` and one `lsof` call for all jobs, and fails closed.
- **Service.** `app-server-main.ts` holds `DesignAppServers`, one per process. It owns the per-app state machine and serialises actions per key. It holds a workspace admission per attempt, drives consent through `DesignAppConsent` (`app-consent.ts`), and watches visible-canvas presence from `DesignCanvasViews`.
- **Surfaces.**
  - the `design_app` tool (`app-tool.ts`);
  - the `designApp:*` IPC handlers;
  - a hook on the person's design-mode toggle;
  - one renderer card (`renderer/design/design-app-consent.tsx`).

  There's no status chip: that's 2c.

**Tech Stack:** TypeScript (ESM), Electron 43 main, React renderer, `tsx --test` for unit and integration tests, Playwright for one E2E (Cua Space and host).

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`:
- §3 anti-goals 2 and 4, §4, §5.2;
- §6.2.1 (the Choose apps rule), §6.2.2 (the launch environment), §6.2.3, §6.2.4, §6.8 (the Node-missing and install-failed states);
- §6.10 (`design_app_started`), §6.11, §7 (main services), §8 (row 2b), §10;
- §12 S2, S5, S6, S7, S8, S14, S15 (the consent half: 2c reuses S2's card for a repo URL) and S19–S22.

**Stacking.** DM lands first (cross-phase decision 1). 2b's branch stacks on DM's branch, which stacks on PR #911 (Phase 2a), which is stacked on PR #908 (Phase 1b) and PR #894 (Phase 1a). 2b builds on these DM modules, which must exist on its base:
- `main/services/design-canvas/canvas-config.ts`: `CANVAS_CONFIG_PATH`, `CANVAS_CONFIG_MAX_BYTES`, `CanvasConfigApp` (already carrying `script?: string`, checked with 2a's `isSafeScriptName`), `CanvasConfig`, `parseCanvasConfig`, `parseCanvasConfigObject`, `readCanvasConfigText`, `readCanvasConfig`, `inspectCanvasConfig`, `configuredRoots(config, detected)`, `describedRoots(config, detected)` and `isSafeWorkspaceRelativePath` (a root of exactly `"."` allowed, any other `.` segment refused). DM's `version` rule: a missing `version` or `1` is known; anything else is unknown, and `parseCanvasConfig` returns `null`, which callers can tell apart from an empty config;
- `designLiveEnabled(env)` and `DESIGN_LIVE_FEATURE_FLAG` in `main/services/studio/feature-flags.ts`;
- `const designLive = designLiveEnabled()` in `llm-client.ts`'s canvas-tools block;
- `docs/design-mode.md` with DM's "DESIGN.md (experimental)" section;
- the S33–S44 amendments block in the spec.

2b's amendments are S25–S32 (cross-phase decision 4).

## Scope

In scope:
- reusing DM's flag helper and DM's `studioCapabilities().designLive` for 2c's renderer;
- `backgroundJobs` changes (S7):
  - the `design` owner and argv spawning;
  - the rotating log with byte-offset reads;
  - the design cap;
  - `designSockets`;
  - the owner guards in `scanPorts` and `forgetOldFinished`;
- address-aware listening sockets with a reader that fails closed (S14);
- the launch plan: argv, environment, port and host per framework (S14, S19);
- port choice with a sticky port per app root, and readiness from sockets the job owns;
- the launch fingerprint, the consent records, the consent card, its IPC, the read-only refusal and the desktop-only refusal (S2);
- the install decision with a completion stamp (S8, refined by D6);
- `DesignAppServers`:
  - start, stop, restart, logs and choose;
  - crashes and the exposure watch;
  - the workspace gate;
  - the 60 s visible-presence rule (S6);
  - workspace removal and access loss;
  - quit and crash recovery;
- the `design_app` tool with its gates, its per-turn budget and its reviewed approval exception;
- the person's toggle (button, ⇧⌘L, `/design`, Enter on Aiden's `design_mode` card) starting the target app;
- `saveCanvasConfigApp`, which saves the monorepo choice (`script`, which DM's parser already reads) through the consent card;
- the `designApp:*` IPC that 2c builds on: status get and broadcast, person start, stop, restart and choose, logs, and consent. Every call goes through `rendererDocumentOwner`;
- the `design_app_started` event (§6.10);
- a "Live apps (experimental)" section appended to `docs/design-mode.md`, plus `docs/analytics.md`, the S25–S32 amendments, memory and the plan index.

Out of scope:
- **2c:** the status chip, its menu, the logs drawer, Connect running server, attaching a server by URL, and the browser-panel listing. 2b already defines `source: "attached"`, the `attach` consent request and the attach problems, so 2c adds no type;
- **3a:** app frames, the bridge, the network and permission dispatchers, and the iframe CSP. 2b gives 3a `appForOrigin`, `isAppOrigin` and `onOriginsChanged`;
- **other `.aiden/canvas.json` fields:** `routes`, `params`, `mock` and `url` (3b, 3d, 2c). DM owns the parser (including `script` and the `version` rule), `describedRoots` and `designMd`; 2b adds only the writer, which keeps every other field;
- **prompt and skill text.** 3b rewrites them. 2b's only model-facing text is the `design_app` tool's description and results;
- mock apps and scaffolding (3d);
- **Windows.** `hostPlatformCapabilities().backgroundJobs` is false there, so 2b reports `unavailable` and offers no tool;
- **Remote, iOS, Android and the CLI:**
  - Remote turns can't start a server (D5);
  - design jobs never reach Remote's `chat:jobs`;
  - the shared `BackgroundJobView` and `BackgroundJobEndReason` types don't change, so the mobile clients don't either;
- automatic restart after a crash (D10).

**Feature flag.** Everything that can start a process or show the card is behind DM's `designLiveEnabled()`, which is true when `designModeEnabled(env)` holds and `AIDEN_EXPERIMENTAL_DESIGN_LIVE` is `1`, `true`, `yes` or `on`, trimmed and case-insensitive. Off means:
- the `design_app` tool isn't offered;
- turning design mode on starts nothing;
- every `designApp:*` handler refuses with "Live apps are not available.";
- `DesignAppServers` is never asked to do anything, so no design job, record file, port probe or fingerprint read happens.

Unflagged and inert while the flag is off:
- `backgroundJobs`' design owner, argv mode, rotating log and `designSockets` (no caller without the flag);
- the address-aware socket reader;
- `DesignCanvasViews.onPresence` and the `visible` field in the view report (a listener with no subscriber);
- the reviewed-exception row in `workspace-tool-approval.ts` (it names a tool that isn't offered);
- `saveCanvasConfigApp` (no caller);
- the `design_app_started` registry row and its docs row.

## What exists today (checked against the code at `19b464fb9`)

| Item | Today | 2b action |
|---|---|---|
| `BackgroundJobs.start` (`main/services/follow-through/background-jobs.ts:323`) | `spawn(command, { shell: true, detached: true })` in its own process group, marker env `AIDEN_BACKGROUND_JOB=<id>`, stdin ignored. Per-chat cap 10, global cap 20. | Gains `startDesign` with owner `{ kind: "design", workspaceId, appRoot }` and `argv: { file, args }` (no shell). Design jobs have their own cap and don't count toward the chat caps (Task 2). |
| `list`, `get`, `read`, `settle`, `stop`, `stopChat`, `hasSettleStoppable`, `stopSettled`, `runningCount` | Keyed by `view.chatId`. | Answer only for chat-owned jobs. Design jobs get `getDesign`, `readDesignLog`, `stopDesign`, `listDesign`. |
| `scanPorts` (`:838`, `onChange(view.chatId)` at `:871`) and `forgetOldFinished` (`:931`, `onChange` at `:967-969`) | Call `onChange` with the job's chat id. | Never call `onChange` for a design job; `onDesignChange` instead (Task 2). |
| `listAll()` | Every job; only keep-awake reads it. `backgroundJobKeepAwakeInput` (`keep-awake/keep-awake-inputs.ts:106`) already skips jobs with ports. | Unchanged. A design install keeps the Mac awake while it runs; a listening server doesn't (Q6). |
| `stopWorkspace(workspaceId)`, `shutdown()`, `reapPreviousLaunch()` | Filter by `view.workspaceId`, stop everything, and reap from `running.json`. | Unchanged. They already cover design jobs, because design views keep `workspaceId` and `writeRecord` lists every running job. |
| `capture` (`:880`) | Past 50 MB of output the job is stopped with `output-limit`. | A design job's log rotates instead (D13). A dev server that logs every HMR update must not die after hours. |
| `onEnded`, `onChange(chatId)` (`follow-through-main.ts:191`, the `backgroundJobs` constructor) | `onEnded` posts a notice that wakes the chat; `onChange` broadcasts `chats:follow-through-changed` and feeds `chatSettlement`. | Never called for design jobs. A new `onDesignChange(view)` goes to `DesignAppServers` through a listener set. |
| `listening-ports.ts` | `parseLsofListening` and `parseProcNetTcp` keep ports only. Failures return nothing. | Address-aware siblings, plus `designSockets`, whose reader reports failure instead of nothing (Task 3). |
| `browserLocalServers(output)` (`main/services/browser/core.ts:299`) | Finds loopback URLs in terminal text; maps `0.0.0.0` to `localhost`. | Reused to read the printed port only. Loopback is decided by socket addresses, never by text. |
| `agentShellCommandEnvironment()` (`main/services/agent-command-environment.ts`) | Drops only secret-named `AIDEN_*` variables; keeps tooling tokens and provider keys. | The base of the launch environment, then scrubbed further (D7). |
| pi-ai `findEnvKeys(provider, env)` (`node_modules/@earendil-works/pi-ai/dist/env-api-keys.js:121`, pi-ai 1.5.2) | Exported from `@earendil-works/pi-ai/compat` (which re-exports `env-api-keys`), not from the main entry; returns the provider key variables present in `env`. The name table itself isn't exported. `compat` also exports `getProviders`. | `providerKeyNames(env)` imports both from `@earendil-works/pi-ai/compat`, calls `findEnvKeys` for every provider, and deletes what it finds. |
| `nodeCommandEnvironment`, `resolveAppToolchain`, `toolchainProblemMessage`, `clearAppToolchainCache`, `detectWebApp`, `designTarget`, `installCommand`, `runScriptCommand`, `FRAMEWORKS` (2a) | No caller yet. | First caller. `FRAMEWORKS[].devCommands` tells whether a script runs the framework's own CLI. |
| `DesignCanvasViews.mounted(workspaceId)` (`views.ts:177`) | A count, with no events. `report`, `unmount` and `unmountAll` set `mounted`. The renderer (`renderer/design/use-design-view.ts:102`) reports views; the stacked layout's visible pane is in `renderer/design/design-layout.tsx:48-67`. | The report gains `visible`, and the views gain `visible(workspaceId)` and `onPresence` (Task 7). |
| `chats:setDesignMode` (`main/handlers/chat-renderer-mutations.ts:140`) | Knows `wasOn` and the source; reports `design_mode_entered`. Its event parameter is unused. | On a false → true change with the flag on, it calls `designModeEntered` with `rendererDocumentOwner(event, …)` as the card's owner. |
| `designCanvas:consentAnswer` (`main/handlers/design-canvas-main.ts:35`) | Enter on Aiden's card turns design mode on. | Same hook, with that window as owner. |
| `rendererDocumentOwner(event, invalid)` (`main/services/renderer-document-owner.ts:85`) | Throws unless the sender is the current main frame; the owner can `send` and `onInvalidated`. | Every `designApp:*` handler and the toggle hook use it. |
| `DesignModeConsent` (`design-mode-tool.ts:35`), `renderer/design/design-mode-consent.tsx` | One pending card per chat, owner checks, 2-minute timeout, answers only from the card's window. | The pattern `DesignAppConsent` and its card follow. |
| `createMcpStdioApprovalStore` (`mcp-stdio-approvals.ts`) | Serialised writes, fail closed on an unreadable file, `approveShown`. | The pattern for the records file. |
| `workspaceMutationGate` (`main/services/workspace-mutation-gate.ts`) | `admit(id)` gives a signal that `begin(id)` aborts. Workspace `update` and `remove` call `begin` (`workspace-application-service.ts:381`, `:515`), then `closeForWorkspace` stops the workspace's jobs. Managed worktrees go through `beginWorkspaceMutation` (`workspace-worktree-application-service-main.ts:148`). | Each attempt holds an admission (D11). Because `begin` already aborts admissions, and every workspace change already stops the jobs, 2b adds no separate `pauseWorkspace`. |
| `processRecoveryReady` (`main/index.ts:2588`) | The result of reaping the last launch's jobs; `:2739` refuses work until it's true. | `start` waits for it (D3). |
| `designCanvasWorkspaceCleanup` (`design-canvas/main.ts:97`), `removeDesignCanvasWorkspace` (`:107`) | Called on workspace remove (`main/index.ts:2759`) and on managed-worktree delete (`workspace-worktree-application-service-main.ts:145`). | Also calls `designAppServers.forgetWorkspace`. |
| Remote turns (`main/services/aiden-remote-chats.ts:1420`) | Run with `usageSource: "chat"`, so they pass `followThroughAvailable`. Their owner has `kind: "remote"`. | `start`, `restart` and `choose` refuse them (D5). |
| `write_file`'s confined write (`coding-tools.ts`: `pinWorkspaceRoot` `:369`, `verifyWorkspaceRoot` `:394`, `resolveWritableInRoot` `:563`, `commitPinnedWrite` `:866`, `readReplacedFile` `:909`) | Module-private. Creates parent folders without following links and commits through the pinned writer. `assertAgentMayWriteConfigPath` protects only `.aiden/hooks.json` and `.aiden/hooks/` under `.aiden`. | A new exported `writeConfinedWorkspaceText(root, relPath, text, { expectedSha256?, signal })` reuses that path for `saveCanvasConfigApp` (Task 5). `writeWorkspaceFile` (the Files panel) can't create, and `writeWorkspaceBinaryFile` refuses hidden folders, so neither fits. |
| `AIDEN_ANALYTICS_DEBUG` (`analytics-main.ts:51`) | Read only when `!app.isPackaged`. | The pattern for the E2E grace knob (Q8). |
| `scripts/ci-test-registry.json` lanes | `core-git`, `runtime-subagents`, `renderer-other`, `macos`. | Main tests in `core-git`, renderer tests in `renderer-other`, `app-server-process.test.ts` in `macos`. |
| `scripts/ci-e2e-spec-map.json` | `design-canvas.spec.ts` maps to `main/services/design-canvas/` and `main/handlers/design-canvas`. | A row for `design-app-server.spec.ts`. |

## Decisions

These settle the rules the spec leaves open. Task 14 records the ones that change the spec as S25–S32.

**D1. Owner.** A design job's owner is `{ kind: "design", workspaceId, appRoot }`. It has no chat.
- It never wakes a chat.
- It never appears in `background_job`, Remote's `chat:jobs`, the goal check's `jobsRunning` or chat settlement.
- It isn't stopped by a chat delete.
- It never triggers `chats:follow-through-changed`, including from `scanPorts` and `forgetOldFinished`.

Its lifetime is visible presence, the workspace and quit (S7).

**D2. One server per app root.** The key is `workspaceId + "\0" + appRoot`, where `appRoot` is 2a's POSIX relative root. Every action on a key runs through one per-key queue.
- A start while running answers `running`.
- A start while consent, install or start is pending joins that attempt, so the consent broker never shows a second card for a key.
- Two chats in one workspace share the server.
- Two workspace records on the same folder are two keys. Next.js refuses a second dev server in one folder, which then shows as a crash (Risk 12).

**D3. What starts a server.** Only these:
- the person turning design mode on in a chat of the workspace (false → true), from a desktop window's main frame, with the flag on;
- `design_app start`, `restart` or `choose`;
- `designApp:start`, `restart` or `choose` from a window (2c's chip and 3a's "Start app" overlay).

Every start first waits for `processRecoveryReady`. If recovery failed, the start ends with `recovery-failed`. Launching Aiden, restoring design-mode chats, opening a canvas, switching chats, moving a chat to another workspace (it isn't a false → true change), Remote, the CLI and background work never start a server, install, probe a port or read a fingerprint.

**D4. What the toggle starts.** From `designTarget(detectWebApp(root))` and `readCanvasConfig(root)`:
- **configured roots:** DM's `configuredRoots(config, detected)` (cross-phase decision 2): the scripted entries detection sees as web candidates, `[]` for a `null` or unsupported config. 2b doesn't restate or re-implement its rule. When it returns any, they decide, whatever the target. (DM's `describedRoots` adds a detection fallback for DESIGN.md lookup; 2b never uses it to decide what starts);
- otherwise `single`: that app;
- otherwise `choose`: nothing starts, and the snapshot target is `choose`;
- `react-nonweb` and `none`: nothing.

Each app gets its own card when consent is needed, shown one after another. A config with an unknown `version` (`parseCanvasConfig` returns `null`) describes no roots.

**D5. Consent (S2).**
- **Fingerprint.** SHA-256 of a canonical JSON object (`launchFingerprintInput`), built from detection and toolchain resolution run now. It holds:
  - `v: 2`, `appRoot`, `installRoot`, `lockfileLevelsUp`, the manager name and Yarn flavour, and the script name;
  - script texts (absent recorded as `null`):
    - the app root's `<script>`, `pre<script>` and `post<script>`;
    - the install lifecycle scripts of both the install root and the app root: `preinstall`, `install`, `postinstall`, `preprepare`, `prepare` and `postprepare`;
  - the raw `packageManager` and `devEngines` values of the app root and the install root, as JSON;
  - the install argv, and the run argv without the port and host arguments (so a port change never asks again);
  - for each file below, `[relativeName, sha256]` or `[relativeName, "missing"]`:
    - the R5 lockfile, including an enclosing one;
    - in every folder from the app root up to the lockfile's folder (or the install root when there's no lockfile): `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs` and `bunfig.toml`;
    - the file a `.yarnrc.yml` `yarnPath` names, resolved from that folder;
    - every framework config file present in the app root: `vite.config.*`, `next.config.*`, `astro.config.*`, `react-router.config.*`, `remix.config.*`, `nuxt.config.*`, `angular.json`, `gatsby-config.*` and `gatsby-node.*`. Config extensions are `js`, `mjs`, `cjs`, `ts`, `mts` and `cts`.

  Names are sorted. A name above the workspace is written as `../…` relative to the workspace root, for the hash only; it never appears in a status or tool result.
- **Unreadable is a refusal.** A listed file that is a symlink, FIFO, device or folder refuses the start with `launch-file-unreadable` and its name. So does an rc or config file over 1 MiB, and a lockfile or `yarnPath` target over 64 MiB. Nothing is hashed through a link, so a link can't point the hash away from what runs.
- **The record** holds `{ fingerprint, script, installShown: boolean, at }`. `installShown` is true when the approved card showed the install command.
- **When it asks again:**
  - the fingerprint differs (`reason: "changed"`);
  - an install is needed and the record's `installShown` is false (`reason: "install"`);
  - `choose` names another root or script (`reason: "choose"`);
  - the workspace was removed, which forgets its records (`reason: "first"`).

  A change of port, Node path or manager path never asks: those are the environment, not the repo.
- **Checked again before every spawn.** Allow approves only the fingerprint the card showed (`approveShown`). Before each spawn (install and server), main runs detection, toolchain resolution and the fingerprint again, and builds the argv from that result, so the argv is what's on disk now. A mismatch asks again.
- **What the card shows:**
  - the app root and the framework label, plus the package name when there is one;
  - the run command as display text (`pnpm run dev`);
  - the install command when an install will run, with "Installing runs your dependencies' install scripts.";
  - each script that will or may run, with its full text;
  - the names of the hashed rc, workspace and config files present, never their contents (an `.npmrc` can hold a registry token);
  - for `choose`, the line "Allow also saves this choice in .aiden/canvas.json.";
  - the S2 line: "This approves the commands above. The dev server then runs this app's own code, and approving doesn't cover what that code does."
- **Text safety.** `consentDisplayText` shows script text, the app root and the package name verbatim in monospace, with these characters shown as visible `\u{…}` escapes:
  - `\p{Cc}` (including `\r`) except `\n`;
  - `\p{Cf}`, which covers bidi overrides and zero-width characters;
  - `\p{Zl}` and `\p{Zp}`;
  - the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0;
  - variation selectors U+FE00–U+FE0F and U+E0100–U+E01EF.

  A script longer than 4 000 characters (`MAX_JOB_COMMAND_CHARS`) is refused with `script-too-long`, so nothing is ever cut from what the person approves.
- **Answers.**
  - Allow stores the record, then the attempt continues.
  - Not now ends it with `consent-declined`. Aiden's later `design_app start` for that key then answers `declined` without a card, until the person starts or toggles themselves.
  - No answer in 2 minutes gives `consent-unanswered`.
- **Who sees the card.** For the person's actions, the main frame that sent them. For `design_app`, the window that owns the turn.
- **Desktop-only.** `start`, `restart` and `choose` refuse with `desktop-only`, whatever consent exists, unless the caller's owner is a live desktop window (not `kind: "remote"`, not destroyed, `id !== 0`). That covers Remote turns, which pass `followThroughAvailable` (`aiden-remote-chats.ts:1420`). `status`, `stop` and `logs` still work for them.
- **Read-only refusal.** Every start, the person's included, is refused with `no-access` when the workspace permission is `none` or it has no folder. A turn whose run permission is `read-only` never gets the tool, through `followThroughAvailable`. `DesignAppServers.start` also takes the caller's permission and refuses `read-only` itself.

**D6. Install (S8).** The record per `workspaceId + installRoot` is `{ state: "started" | "done", manager, lockHash, at }`. `lockHash` is the R5 lockfile's hash, or the install root's `package.json` hash when there's no lockfile.
- **Never outside the workspace.** When `lockfileLevelsUp ≥ 1`, Aiden never installs: the install would write in a parent repo. If `installed` is true, it starts without installing; otherwise the attempt ends with `install-outside-workspace`. The message says to install in the parent repo, then start again.
- **Otherwise an install runs** before the server when any of these holds:
  - `installed` (2a's R7) is false;
  - the record is `started` (Aiden's own install was stopped, killed or crashed);
  - the record is `done` with a different `lockHash` or manager;
  - the caller asked (`restart { install: true }`, or 2c's Retry after `install-failed`).
- **A person's own install is kept.** With `node_modules` present and no record, the person installed it, so Aiden doesn't reinstall: `npm ci` would wipe their tree and run every install script again. This narrows S8's "a missing stamp means reinstall" to Aiden's own installs. A crash whose tail shows a missing module (`Cannot find module`, `ERR_MODULE_NOT_FOUND`, `Module not found`, `Failed to resolve import`) gets a `next` hint: "Try design_app restart with install: true."
- **How it runs.**
  - The record is written `started` before the install spawns, and `done` after it exits 0.
  - A non-zero exit gives `install-failed { exitCode, tail }`.
  - An install still running after 15 minutes is stopped with `install-timeout`.
  - The command is 2a's `installCommand(info)`, run with the resolved manager path in the install root.
  - Installing uses the package registry. That's the tooling's network (§6.8), never an app frame's, and it happens only after consent.

**D7. Launch plan (S14, S19).** `launchPlan(app, scripts, port, env)` is pure.

**Environment:**
- Start from `agentShellCommandEnvironment()`, then `nodeCommandEnvironment(env, [dirname(node), dirname(manager)])`, which drops empty PATH entries and `ELECTRON_RUN_AS_NODE`.
- Delete:
  - `NODE_ENV` (a packaged Aiden's `production` would build React without the debug info 3a needs);
  - every `ELECTRON_*` variable;
  - every `AIDEN_*` variable (the job marker is added after, by `backgroundJobs`);
  - every lowercase `npm_*` variable, and `npm_config_*` in any case;
  - `INIT_CWD`;
  - every provider key name pi-ai knows, found with `findEnvKeys(provider, env)` over `getProviders()` (`providerKeyNames`). Both are imported from `@earendil-works/pi-ai/compat`, which re-exports `env-api-keys`; pi-ai's main entry doesn't export `findEnvKeys`.

  Tooling tokens such as `NPM_TOKEN` and `GH_TOKEN` stay, since installs need them. `docs/design-mode.md` says apps should read their own keys from their own `.env`.
- Set `BROWSER=none`, `FORCE_COLOR=0` and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
- Set these unless the person already set them: `NEXT_TELEMETRY_DISABLED=1`, `ASTRO_TELEMETRY_DISABLED=1`, `NUXT_TELEMETRY_DISABLED=1`, `GATSBY_TELEMETRY_DISABLED=1`, `NG_CLI_ANALYTICS=false` and `DO_NOT_TRACK=1`.
- Set `HOST` and `PORT` per the table below.

**Arguments.** The script "runs the framework CLI" when its words contain one of `FRAMEWORKS[framework].devCommands`, the same matcher 2a uses. Only then are flags appended, through `runScriptCommand(info, script, extraArgs)` (npm gets `--` first).

| Framework (matched dev command) | Flags when the script runs the framework CLI | Env |
|---|---|---|
| `vite`, `tanstack-router` and `tanstack-start` through `vite`; `react-router dev`; `remix vite:dev` | `--host 127.0.0.1 --port <p> --strictPort` | — |
| `astro`, `nuxt`, `angular`, `tanstack-start` through `vinxi dev` | `--host 127.0.0.1 --port <p>` | — |
| `next` | `--hostname 127.0.0.1 --port <p>` | `PORT=<p>` |
| `gatsby` | `-H 127.0.0.1 -p <p>` | — |
| classic `remix dev`, `create-react-app`, `remix-3` | none | `HOST=127.0.0.1`, `PORT=<p>` |
| any framework, script not running its CLI (`node server.mjs`) | none | `HOST=127.0.0.1`, `PORT=<p>` |

A script that already has a host flag (`--host`, `--hostname`, `-H`) or a port flag (`--port`, `-p`, `--strictPort` counts with the port) doesn't get that flag again: Vite's parser turns a repeated option into an array. A script's own `--host` with no value is then caught by the exposure check (D9). A script's own port wins, and readiness reads the real port (D8).

Remix 3's default starter calls `listen(44100)` and ignores `HOST` and `PORT`, so it binds every interface and is refused as `exposed`. The one-line fix in `docs/design-mode.md` is to make `server.ts` listen on `process.env.PORT` at `process.env.HOST`.

**D8. Port, origin and readiness.**
- **Port choice** (`app-ports.ts`). The first of these that is free:
  1. the sticky port recorded for this app root;
  2. the framework's default port;
  3. a port the OS hands out for `127.0.0.1:0`.

  "Free" means a test listen on `127.0.0.1:<p>` succeeds, and a connect to `127.0.0.1:<p>` and to `[::1]:<p>` is refused within 250 ms. The connect catches a server elsewhere on the wildcard address, which macOS lets a more specific listen sit beside. Keeping the port keeps the app's storage and cookies across restarts. The port is recorded once the server is ready.
- **Origin.** The origin is `http://127.0.0.1:<port>`, never `localhost`. Another process can hold `[::1]:<port>` while the app holds `127.0.0.1:<port>`, and `localhost` could resolve to it. This amends spec §6.2.3 (line 186) through S29.
- **Readiness.** While the job is starting, `DesignAppServers` reads the job's sockets from the shared poller (D9) every 500 ms. The owned ports are the job's loopback sockets, minus 9229 and 24678. `readyPort(owned, printed, planned)` picks:
  - a printed loopback URL's port that is also owned;
  - else the planned port when it's owned;
  - else the only owned port;
  - else not ready yet.

  A port no process of the job holds never counts, whatever the output says. There's no `scanPorts` call: the shared poller's `designSockets` already gives the job's ports.
- **Limits.**
  - The 120 s readiness timer restarts on every chunk of output, so a slow compile that keeps logging isn't killed.
  - A hard cap of 10 minutes from spawn applies either way.
  - When either expires, the job is stopped with `not-ready` and the tail.
  - An exit during `starting` whose tail matches `isAddressInUse` is retried once on a port from step 3. That covers `EADDRINUSE`, Vite's "Port … is already in use" and CRA's "Something is already running on port". Any other exit is a crash.

**D9. Exposure check (S14).** `designSockets(jobIds)` returns, per job, every listening TCP socket of that job's processes, unfiltered: `Map<jobId, { ok: true, sockets: { pid, address, port }[] } | { ok: false, reason }>`. "The job's processes" are its process group plus every descendant by parent pid. That catches a child that called `setsid`.
- **One shared poller.** One `ps` plus one `lsof` costs about 100 ms of CPU, so per-job polling at short intervals would cost 30–40% of a core. Instead, `DesignAppServers` runs one poller for all design jobs. Each tick makes one `ps -A -o pid=,ppid=,pgid=` call, builds every job's process tree from it, then makes one `lsof -nP -a -iTCP -sTCP:LISTEN -p a,b,c` call for the union of their pids (on Linux, one pass over `/proc/net/tcp`, `tcp6` and the pids' fd folders). It then hands each job its slice.
  - The tick runs every 500 ms while any job is `starting`, and every 2 s when every job is `running`. It stops when no design job is starting or running.
  - Ticks never overlap: a slow tick delays the next one rather than piling up.
- **Fails closed.** A failure makes the tick fail for every job it covers (or, for a per-pid failure, for that pid's job), never an empty list. Failures are:
  - a call that times out (2 s);
  - output that overruns `maxBuffer` (4 MiB);
  - a live process's fd folder that can't be read;
  - a process with more than 4 096 open fds (`MAX_DESIGN_JOB_FDS`), on Linux, where each fd is read;
  - `/proc/net/tcp` that can't be read, or a `tcp6` that exists but can't be read (a kernel without IPv6 has no `tcp6`, which counts as no IPv6 sockets).

  lsof exiting 1 with output is fine: it does that when one of several pids has no sockets.
- **The rule.** Every socket must be on `127.0.0.0/8`, `::1` or `::ffff:127.x.x.x`. Any wildcard (`*`, `0.0.0.0`, `::`) or other address stops the job with `exposed`. The check runs on every tick: every 500 ms while starting, and every 2 s while running.
- **Failures.**
  - While starting, a failed read never marks the server ready.
  - While running, three failed reads in a row stop the job with `exposure-unknown`.

**D10. States.** `DesignAppPhase` is `stopped | consent | installing | starting | running | crashed`.
- **Crashed:** a server that exits on its own while starting or running, including with code 0 (a dev server isn't meant to end). It carries `exitCode`, `signal` and the last 20 lines (at most 2 000 characters) of output. Nothing restarts it by itself, so a broken config can't loop.
- **Stopped, no problem:** a stop someone asked for, the presence stop and quit.
- **Stopped, with a problem:**
  - access loss and workspace changes set one (D11);
  - an attempt that ends without running keeps its `problem`.

**D11. Stop, restart and workspace changes.**
- **Stop** asks the job's processes to end (SIGTERM), then forces them after 4 s (SIGKILL), through `stopDesign`. It is idempotent. It cancels a pending card and stops an install. An attached server (2c) is never stopped: stop answers `attached`.
- **Restart** is a stop, then a start with the same port. It runs the checks of D5 again.
- **Workspace gate.** Each attempt, from the first read until `running` or its end, holds `workspaceMutationGate.admit(workspaceId)`. When its signal aborts (a workspace update, remove or managed-worktree change has begun), the attempt stops its job and ends. Right before every spawn (after consent, after install) main re-reads the workspace: it must exist, have the same folder path and not be `none`.
- **Problems on a workspace change.**
  - `no-access` only when the workspace is gone, its folder is gone, or its permission is now `none`;
  - otherwise `interrupted` ("The workspace changed while the app was starting. Start it again.").
- **Running servers.** The 2 s poll also re-reads the workspace record. A changed folder path, or `none`, stops the server. `closeForWorkspace` → `stopWorkspace` already stops it too, which `onDesignChange` reports.

**D12. Presence is a visible canvas (S6).**
- **Visible.** The renderer's `designCanvas:view` report gains `visible: boolean`: the canvas pane is shown (in the stacked layout, the Canvas pane is the one shown) and `document.visibilityState` is `visible`. The renderer reports again when either changes. `DesignCanvasViews.visible(workspaceId)` counts mounted chats that are also visible, and `onPresence(workspaceId, visibleCount)` fires when that count changes.
- **The timer.** When a workspace's count reaches 0, a 60 s timer starts for each of its servers that isn't stopped. A count above 0 cancels it. When it fires, the servers stop.
- **Unseen starts.** A server that reaches `starting` while nothing is visible (a tool call from a chat whose canvas is hidden) starts the timer at once.
- **What counts as leaving.** Leaving design mode, switching workspace, showing the Chat pane in the stacked layout, hiding or minimising the window, closing or reloading it, and deleting or moving a chat all lead here.
- **Installs** stop with the rest; the `started` record makes the next start reinstall.

**D13. Logs and output bounds.**
- **Memory.** The tail is `JOB_TAIL_CHARS` (20 000 characters).
- **Rotation.** A design job's log rotates: past 25 MB the current file becomes `<id>.1.log` (replacing an older one), and a new `<id>.log` starts. At most 50 MB is kept, and the server keeps running.
- **Byte offsets.** Each job tracks two byte offsets over its whole output: `outputBytes` (the total) and `oldestKeptByte`.
- **`readDesignLog(jobId, { after, maxBytes })`** reads from the files:
  - a cursor before `oldestKeptByte` starts there, with `truncated: true`;
  - a cursor past the end returns nothing.

  It returns `{ text, from, next, truncated }`, with the text decoded leniently at the edges.
- **Surfaces.**
  - `designApp:logs` reads at most 64 KiB per call.
  - `design_app logs` returns at most 200 lines and 8 000 characters, fenced with `fenceAsData`.
  - Status payloads carry log text only in the crash and failure `tail` (2 000 characters).
  - URLs are parsed only from the in-memory tail.

**D14. Errors: who hears what.**

| Event | The person | Aiden |
|---|---|---|
| Consent needed | The card | The tool waits for the answer |
| Declined, unanswered, no window, `desktop-only` | Nothing more | `declined` / `unanswered` / `unavailable` / `desktop-only` with a `next` line |
| `no-access`, `interrupted`, `recovery-failed`, `unavailable` | A toast on the person's path | The message; or the tool isn't offered |
| Toolchain problems (2a) | A toast with `toolchainProblemMessage` | The same message |
| `launch-file-unreadable`, `script-too-long`, `job-limit`, `install-outside-workspace` | A toast with the fixed message | The same message |
| `install-failed`, `install-timeout`, `not-ready`, `exposed`, `exposure-unknown` | A toast with the fixed message; the tail only in 2c's chip menu | The message, with the tail fenced as data |
| `crashed` | A toast: "The app's dev server stopped." | `status` shows it, with the tail fenced as data, plus the missing-module hint when it applies. No notice and no wake (D1) |
| Presence stop, quit | Nothing (2c's chip shows Stopped) | `status` shows `stopped` |

Toasts come from the card's host component (Task 10), with fixed text from `designAppProblemMessage`, never log text, and only for attempts with `startedBy: "person"`. Absolute paths and environment values never appear in a status, a tool result, an analytics event or a log line Aiden writes.

**D15. The monorepo choice.**
- **Who calls it.** `design_app choose { root, script? }` and 2c's Choose apps call the same service method.
- **What it accepts.** `root` must be a `web` candidate from detection, and `script` a safe script name in its `package.json` (default: 2a's pick). `react-nonweb`, `none`, `workspace-runner` and `unknown-framework` candidates are refused with `not-web`. This settles 2a's Q9.
- **The card** has `reason: "choose"` and the save line.
- **On Allow**, `saveCanvasConfigApp(workspaceRoot, { root, script })` (cross-phase decision 2):
  - creates `.aiden/` and `canvas.json` through `writeConfinedWorkspaceText` with `followLinks: false`, so an existing link anywhere on the path refuses the write;
  - a new file is written as `{ "version": 1, "apps": [{ root, script }] }`;
  - reads it with DM's `readCanvasConfigText`, whose result names its reason (missing, link, too-large, unreadable or the text). Only `missing` creates a new file; `link`, `too-large` and `unreadable` refuse without writing. It checks `version` with DM's `inspectCanvasConfig`, never a re-implementation: an unsupported version refuses with `unknown-version`, and the file is left alone;
  - merges `script` into the raw JSON entry whose `root` matches, or appends `{ root, script }`;
  - keeps every other field, entry and unknown key byte-for-byte in value (DM's `designMd`, 3b's `routes` and `params`);
  - writes only if the file still has the hash it was read with.

  Then it starts the app.
- **Reading.** DM's parser already reads `script`; 2b adds no parsing. A saved entry never skips consent.

**D16. Caps and budgets.**
- At most 8 running design jobs across all workspaces (`MAX_RUNNING_DESIGN_JOBS`). They don't count toward the per-chat 10 or the global 20, and chat jobs don't count toward them. Over the cap, a start answers `job-limit`.
- A key runs one job at a time: its install, then its server.
- At most 4 `start`, `restart` and `choose` calls per turn (`DESIGN_APP_STARTS_PER_TURN`). The fifth answers an error result without acting.

**D17. Analytics.** `design_app_started { framework, manager?, outcome }`:
- `framework`: one of the 12 `FrameworkId` values;
- `manager`: `npm | pnpm | yarn | bun`, left out when no manager was resolved (a conflict or Deno);
- `outcome`: `running | crashed | failed`.

It is sent once per start attempt that got past consent, when the attempt settles:
- `running`: it became ready;
- `crashed`: it exited before it was ready;
- `failed`:
  - a toolchain problem;
  - an install that failed or timed out, or one outside the workspace;
  - `not-ready`, `exposed`, `exposure-unknown`;
  - `job-limit`.

It isn't sent for:
- a decline, no answer or no window;
- `desktop-only`, `no-access`, `interrupted` or `recovery-failed`;
- a `choose` target;
- a stop before ready.

It carries no route, path, URL, name or script.

## Interfaces

`renderer/shared/design-app.ts` (the contract 2c and 3a build on; no Electron imports):

```ts
export const FRAMEWORK_IDS: readonly FrameworkId[];          // the 12 ids, for the analytics enum
export type DesignAppPhase = "stopped" | "consent" | "installing" | "starting" | "running" | "crashed";

export type DesignAppProblem =
  | { problem: "unavailable" }                                   // platform or flag
  | { problem: "no-access" } | { problem: "interrupted" } | { problem: "desktop-only" } | { problem: "recovery-failed" }
  | { problem: "node-missing" }
  | { problem: "manager-missing"; manager: PackageManagerName }
  | { problem: "manager-conflict"; conflict: PackageManagerName[]; field?: PackageManagerName }
  | { problem: "unsupported-manager"; manager: "deno" }
  | { problem: "launch-file-unreadable"; file: string }           // relative, ≤ 200 chars
  | { problem: "script-too-long" }
  | { problem: "consent-declined" } | { problem: "consent-unanswered" } | { problem: "consent-unavailable" }
  | { problem: "job-limit" }
  | { problem: "install-outside-workspace" }
  | { problem: "install-failed"; exitCode: number | null; tail: string }
  | { problem: "install-timeout" }
  | { problem: "not-ready"; tail: string }
  | { problem: "exposed" } | { problem: "exposure-unknown" }
  | { problem: "not-web" }
  // 2c's Connect running server (defined now so 2c adds no type):
  | { problem: "attach-not-loopback" } | { problem: "attach-unreachable" } | { problem: "attach-not-in-app" };

export interface DesignAppStatus {
  workspaceId: string;
  appRoot: string;                       // POSIX, relative, "." for the root
  source: "started" | "attached";        // 2b only makes "started"
  framework?: FrameworkId;
  frameworkLabel: string;                // "Vite", or "App" with no framework
  manager?: PackageManagerName;
  script?: string;
  phase: DesignAppPhase;
  since: number;
  origin?: string;                       // "http://127.0.0.1:5173", only while running
  port?: number;                         // only while running
  startedBy?: "person" | "aiden";
  exitCode?: number | null;              // crashed
  signal?: string;                       // crashed
  tail?: string;                         // crashed; ≤ 2 000 chars; untrusted text
  problem?: DesignAppProblem;
  revision: number;
}

export interface DesignAppCandidate { appRoot: string; framework?: FrameworkId; frameworkLabel: string; script?: string; name?: string }

export interface DesignAppsSnapshot {
  workspaceId: string;
  target: "single" | "choose" | "react-nonweb" | "none" | "unavailable";
  apps: DesignAppStatus[];               // every known server, plus target apps at "stopped"
  candidates: DesignAppCandidate[];      // web candidates, for Choose apps…
  chosen: string[];                      // described roots from .aiden/canvas.json (entries with a script)
}

export type DesignAppConsentRequest =
  | {
      kind: "launch";
      requestId: string; chatId: string; workspaceId: string; appRoot: string;
      packageName?: string; frameworkLabel: string;
      reason: "first" | "changed" | "install" | "choose";
      runCommand: string;                // display text: "pnpm run dev"
      installCommand?: string;           // only when an install will run
      scripts: Array<{ name: string; text: string }>;
      launchFiles: string[];             // hashed rc, workspace and config file names present
      savesChoice: boolean;              // reason "choose": Allow writes .aiden/canvas.json
    }
  | { kind: "attach"; requestId: string; chatId: string; workspaceId: string; appRoot: string; url: string };  // 2c
export interface DesignAppConsentClosed { requestId: string }

export interface DesignAppLogs { text: string; from: number; next: number; truncated: boolean }

export function designAppProblemMessage(problem: DesignAppProblem): string;  // fixed sentences
export function consentDisplayText(text: string): string;                    // D5 escapes
```

`FrameworkId` and `PackageManagerName` move from `app-server-core.ts` into this file and are re-exported there, so the renderer never imports a main module and 2a's tests pass unedited.

IPC. Every handler builds its owner with `rendererDocumentOwner(event, …)`, so a subframe or stale document is refused. Each refuses while `designLiveEnabled()` is false. `chatId` is the authority check, as for `designCanvas:*`: an attended, non-Bot chat in a workspace with a folder.
- `designApp:status:get (chatId) → DesignAppsSnapshot`;
- `designApp:start (chatId, appRoot?)`, `designApp:stop (chatId, appRoot)`, `designApp:restart (chatId, appRoot, { install?: boolean })` and `designApp:choose (chatId, appRoot, script?)`, each `→ DesignAppStatus`. These are person actions; the card goes to the sender;
- `designApp:logs (chatId, appRoot, { after?: number }) → DesignAppLogs`;
- `designApp:consentAnswer (requestId, "allow" | "decline") → boolean`;
- main → windows:
  - `designApp:status` (a `DesignAppsSnapshot`, broadcast);
  - `designApp:consent` and `designApp:consentClosed`, to the card's window only.

`main/services/design-canvas/app-server/app-server-main.ts`:

```ts
export class DesignAppServers {
  constructor(deps: DesignAppServersDeps);   // jobs, detect, readConfig, saveConfigApp, toolchain, fingerprint, records,
                                              // ports, consent, views, workspaces (get by id), gate, recoveryReady,
                                              // report, now, timers, graceMs, log
  snapshot(workspaceId: string): Promise<DesignAppsSnapshot>;
  start(input: { workspaceId: string; appRoot?: string; by: "person" | "aiden"; chatId: string;
                 owner?: ChatGenerationOwner | RendererDocumentOwner; permission: WorkspaceGatePermission;
                 install?: boolean; signal?: AbortSignal }): Promise<DesignAppStatus>;
  stop(workspaceId: string, appRoot: string): Promise<DesignAppStatus>;
  restart(input: Parameters<DesignAppServers["start"]>[0] & { appRoot: string }): Promise<DesignAppStatus>;
  choose(input: { workspaceId: string; appRoot: string; script?: string; chatId: string; by: "person" | "aiden";
                  owner?: ChatGenerationOwner | RendererDocumentOwner; permission: WorkspaceGatePermission }): Promise<DesignAppStatus>;
  logs(workspaceId: string, appRoot: string, options: { after?: number; maxBytes: number }): Promise<DesignAppLogs>;
  designModeEntered(input: { chatId: string; workspaceId: string; owner: RendererDocumentOwner }): void;  // D4, fire and forget
  forgetWorkspace(workspaceId: string): Promise<void>;
  /** 3a: the running server whose job holds this exact address and port. */
  appForOrigin(origin: string): { workspaceId: string; appRoot: string } | undefined;
  /** 3a: every origin served this session (127.0.0.1, any held [::1], and the localhost alias), until forgetWorkspace. */
  isAppOrigin(origin: string): boolean;
  onOriginsChanged(listener: () => void): () => void;
  onStatus(listener: (snapshot: DesignAppsSnapshot) => void): () => void;
}
```

`backgroundJobs` additions (`background-jobs.ts`):
- `type JobOwner = { kind: "chat"; chatId: string } | { kind: "design"; workspaceId: string; appRoot: string }`, kept on the record. Chat-keyed methods check `owner.kind === "chat"` before they compare `chatId`.
- `startDesign(input: { workspaceId; appRoot; cwd; argv: { file: string; args: string[] }; display: string; description: string; env }) → DesignJobView`. It spawns `file` with `args`, `shell: false`, `detached: true`, with the marker env.
- `DesignJobView = Omit<BackgroundJobView, "chatId" | "stopWhenChatSettles" | "origin"> & { owner: "design"; appRoot: string; oldestKeptByte: number }`.
- `getDesign(jobId)`, `readDesignLog(jobId, { after, maxBytes })`, `stopDesign(jobId) → Promise<DesignJobView>`, `listDesign(workspaceId)`.
- `designSockets(jobIds: string[]) → Promise<Map<string, { ok: true; sockets: Array<{ pid: number; address: string; port: number }> } | { ok: false; reason: string }>>`: one `ps` and one `lsof` (or one `/proc` pass) for every job asked about (D9). `DesignAppServers`' single poller is the only caller.
- Option `onDesignChange?: (view: DesignJobView) => void`. `onEnded` and `onChange` are never called for design jobs.
- `MAX_RUNNING_DESIGN_JOBS = 8`. `assertRoomFor` counts chat and design jobs apart.

`listening-ports.ts` additions:
- `parseLsofListeningSockets(output) → Map<pid, Array<{ address: string; port: number }>>`;
- `parseProcNetTcpSockets(table, family) → Map<inode, { address: string; port: number }>`;
- `listeningSocketsByProcess(pids) → Promise<{ ok: true; byPid } | { ok: false; reason; pids? }>` (fails closed, D9): one `lsof -nP -a -iTCP -sTCP:LISTEN -p <comma list>` on macOS; on Linux one read of `/proc/net/tcp` and `tcp6` plus each pid's fd folder, capped at `MAX_DESIGN_JOB_FDS = 4096` fds per pid. A per-pid failure names its pids, so only that job fails;
- `processTable() → Promise<{ ok: true; rows: Array<{ pid; ppid; pgid }> } | { ok: false; reason }>` (one `ps -A -o pid=,ppid=,pgid=`), and the pure `jobProcessTree(rows, pgid) → number[]`: the group plus descendants by parent pid;
- `isLoopbackAddress(address)`.

`main/services/design-canvas/app-server/app-launch-core.ts` (pure):
- `launchPlan(app, scripts, port, env) → { extraArgs: string[]; env: NodeJS.ProcessEnv }` (D7), and `providerKeyNames(env, providers, findEnvKeys)`;
- `runsFrameworkCli(scriptText, framework) → devCommand | undefined`, `scriptSetsHost`, `scriptSetsPort`;
- `readyPort({ owned, printed, planned })` (D8);
- `exposedSockets(sockets)` (D9);
- `needsInstall({ installed, lockfileLevelsUp, record, lockHash, manager, forced }) → "install" | "skip" | "outside-workspace"` (D6);
- `launchFingerprintInput(…)` and `launchFingerprint(…)` (D5);
- `isAddressInUse(tail)`, `missingModuleHint(tail)`;
- `lastLines(text, lines, maxChars)`.

`app-fingerprint.ts`:
- `hashBounded(path, cap) → Promise<{ hash } | { unreadable: true }>`. It opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, checks `fstat().isFile()`, and stream-hashes up to `cap + 1` bytes.
- `readLaunchSurface(workspaceRoot, app, toolchain) → Promise<{ fingerprint; scripts; launchFiles; packageName? } | { problem: "launch-file-unreadable"; file } | { problem: "script-too-long" }>`.

`app-records.ts`:
- `createDesignAppRecords(file: () => string)`, with `consentOf`, `approveShown(workspaceId, appRoot, { script, installShown }, shown, current)`, `installOf`, `markInstall`, `portOf`, `setPort` and `forgetWorkspace`.
- One JSON file, `userData/design-apps.json`, `version: 1`, written atomically with mode 0600 through `writeJsonAtomic`, with every call serialised.
- An unreadable or invalid file reads as empty: no consent, no stamp, no port.
- Caps: 256 workspaces, 16 app roots each, oldest out.

`app-ports.ts`: `chooseAppPort({ sticky?, fallback, probe }) → Promise<number>`, and `defaultPortProbe`.

`app-consent.ts`: `DesignAppConsent` with:
- `request({ key, chatId, request, owner, signal }) → Promise<"allow" | "decline" | "unanswered" | "unavailable">`. A second request for a pending key joins the first;
- `answer(requestId, answer, owner)`;
- `forgetDecline(key)` and `isDeclined(key)`.

It keeps `DesignModeConsent`'s rules: a 2-minute timeout, at most 16 pending, answers only from the card's window.

`canvas-config.ts` (DM's file, extended):
- (DM already gives `CanvasConfigApp.script`, `readCanvasConfigText` (a reason-carrying result), `parseCanvasConfigObject`, `inspectCanvasConfig`, `configuredRoots` and `describedRoots`; 2b adds only the writer.)
- `saveCanvasConfigApp(workspaceRoot, { root, script }, signal?) → Promise<"saved" | "unknown-version">`. A new file is `{ "version": 1, "apps": [...] }`.

`coding-tools.ts`: `writeConfinedWorkspaceText(root, relativePath, text, { expectedSha256?: string | null; followLinks?: boolean; signal? })`. `saveCanvasConfigApp` passes `followLinks: false`. It's `write_file`'s pinned, confined create-or-replace path. `expectedSha256: null` means the file must not exist.

`app-tool.ts`: `createDesignAppTool(deps) → AgentTool`, name `design_app`.

## Global Constraints

- **Manual-only processes.** No design process, install, port probe or fingerprint read happens at startup, on restore, in the background, during onboarding or while the flag is off (D3). Tests prove it with a `DesignAppServers` whose deps throw on any use.
- **No shell.** Design jobs spawn the resolved manager binary with an argv, never a command string. The script text reaches a shell only through the manager running that script, which is what the person approved.
- **Fixed inputs.** Nothing from the model, `.aiden/canvas.json` or `package.json` becomes an argv element except these:
  - script names, only from 2a's `isSafeScriptName`;
  - app roots, only from detection results;
  - extra arguments, only from `launchPlan`.
- **Disk now.** Every spawn's argv is rebuilt from detection, toolchain and fingerprint run right before it (D5).
- **Relative output.** Statuses, tool results, IPC payloads and analytics carry relative roots and file names only.
- **Untrusted text.** Script text, package names, app roots, log tails and `.aiden/canvas.json` contents are data. Log text reaches Aiden only fenced with `fenceAsData`, and the card shows text escaped (D5).
- **Loopback only** (D9). No design server is ever marked running, or kept running, without a successful address read that is all loopback.
- **Fail closed:**
  - unreadable records mean no consent;
  - unreadable launch files refuse the start;
  - a failed socket read never marks a server ready, and three in a row stop a running one;
  - an unreadable `.aiden/canvas.json` describes no roots;
  - an unknown config version is never written.
- **Shared types.** `BackgroundJobView`, `BackgroundJobEndReason` and the Remote protocol don't change.
- **AGENTS.md:**
  - no source-grep tests;
  - each new test file goes in `scripts/ci-test-registry.json` (main tests in `core-git`, renderer tests in `renderer-other`, `app-server-process.test.ts` in `macos`) and in `test:design-mode` (a union with DM's additions), then `npm run test:ci-policy`;
  - the new E2E spec goes in `scripts/ci-e2e-spec-map.json`;
  - the analytics event gets its registry row, docs row and test;
  - docs change in this PR;
  - window-opening tests run in the Cua Space, and specs with darwin branches also on the host;
  - the new card follows `GUI.md`, `docs/design-guide.md` and the two ChatGPT UI references, with semantic tokens and the shared squircle buttons, and keeps `focus-visible` rings;
  - UI changes need light and dark screenshots in the PR body.

## Tasks

### Task 0: Baseline

- [x] Check the base: `git log --oneline -5` must show DM's commits on top of PR #911. Confirm that these exist before any change:
  - `main/services/design-canvas/canvas-config.ts` with `parseCanvasConfig` (returning `null` for an unknown `version`), `parseCanvasConfigObject`, `readCanvasConfigText`, `readCanvasConfig`, `inspectCanvasConfig`, `configuredRoots`, `describedRoots`, `isSafeWorkspaceRelativePath`, and `script?` on `CanvasConfigApp`;
  - `designLiveEnabled` in `main/services/studio/feature-flags.ts`;
  - `designLive` in `llm-client.ts`;
  - `docs/design-mode.md`.

  If one is missing, stop and report: 2b builds on DM.
- [x] Run `npm run build:native:c`. `write_file`'s pinned writer, which Task 5 reuses, needs the native file-mutator helper, and a fresh worktree doesn't have it.
- [x] Run `npm run test:design-mode`, `npm run test:follow-through` and `npx tsx --test main/services/follow-through/background-jobs.test.ts main/services/follow-through/listening-ports.test.ts main/services/approval-gate/workspace-tool-approval.test.ts main/services/studio/feature-flags.test.ts main/services/design-canvas/canvas-config.test.ts main/services/analytics/analytics-feature-reports.test.ts`. Note the pass counts. All must pass.

### Task 1: The flag, from DM

**Files:**
- Modify (only if needed): `main/services/studio/feature-flags.ts`, `main/services/studio/feature-flags.test.ts`

- [x] **Step 1:** Read DM's `designLiveEnabled` tests. Add any that are missing for the binding definition:
  - `yes`, `on`, ` TRUE ` and `On` are on;
  - `0`, `no` and `""` are off;
  - it's off whenever `AIDEN_DESIGN_MODE=0`;
  - `studioCapabilities` reports `designLive`.

  If DM's tests cover all of them, add nothing and go to Step 4.
- [x] **Step 2:** Run `npx tsx --test main/services/studio/feature-flags.test.ts`. Expected: FAIL only for what's missing.
- [x] **Step 3:** Fix the helper to the binding definition if it differs; never add a second helper. Add `designLive` to `studioCapabilities` and its renderer type if DM didn't.
- [x] **Step 4:** Rerun, then `npx tsc --noEmit -p .`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): live-app flag capabilities` (skip if nothing changed).

### Task 2: Background jobs get a design owner

**Files:**
- Modify: `main/services/follow-through/background-jobs.ts`, `background-jobs.test.ts`, `follow-through-main.ts`

- [x] **Step 1: Write failing tests** in `background-jobs.test.ts`, with real spawns of `process.execPath` scripts as the file already does:
  - `a design job runs its argv without a shell`. Args `["-e", "console.log(process.argv.slice(1).join('|'))", "a b", "$(echo x)", ";"]` print `a b|$(echo x)|;`;
  - `a design job is invisible to every chat-keyed method`. After `startDesign`, these find nothing for any chat id, including `""` and the job's `workspaceId`: `list(c)`, `get(c, id)`, `read(c, id)`, `settle(c, id, 0)`, `stop(c, id, …)`, `runningCount(c)` and `hasSettleStoppable(c)`. `stopChat(c, …)` leaves it running;
  - `a design job never calls onEnded or onChange, from its end, a port scan or finished-job eviction, and calls onDesignChange`. Drive `scanPorts()` with a fake `listeningPorts`, and overflow the finished cap;
  - `design jobs don't count toward a chat's 10 or Aiden's 20, and chat jobs don't count toward the design 8`. Use `maxRunning*` options of 2 to keep it fast;
  - `a ninth running design job is refused with BackgroundJobLimitError`;
  - `stopWorkspace and shutdown stop design jobs, and running.json lists them for the next launch`. Also check that `reapPreviousLaunch` on a new instance stops a design job left from a simulated crash, in the existing crash-recovery test's shape;
  - `a design log rotates past its size and keeps running`. With a rotate size of 4 KiB and 32 KiB printed: the state is `running`, at most two files exist, `oldestKeptByte > 0`, and `readDesignLog` with `after: 0` starts at `oldestKeptByte` with `truncated: true`;
  - `readDesignLog returns the bytes after a cursor and the next cursor`. Two reads in a row join to the output with nothing lost;
  - `a chat job past the log cap still stops with output-limit`, unchanged;
  - `stopDesign ends the group, children included`. The script spawns a child that ignores SIGTERM. After `stopDesign` resolves, the child's pid is gone.
- [x] **Step 2:** Run `npx tsx --test main/services/follow-through/background-jobs.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
  - Keep `JobRecord.owner`. Chat jobs get `{ kind: "chat", chatId }` from `start` and `adopt`. Guard every chat-keyed method on `owner.kind === "chat"`.
  - Add `startDesign` (sharing `start`'s body, with `shell: false`), `getDesign`, `readDesignLog`, `stopDesign`, `listDesign`, `onDesignChange` and `MAX_RUNNING_DESIGN_JOBS`.
  - `finish`, `finishAdopted`, `scanPorts` (`:871`) and `forgetOldFinished` (`:967-969`) call `onDesignChange` instead of `onEnded` or `onChange` for design jobs. `forgetOldFinished` keeps at most 8 finished design jobs, apart from chats.
  - `capture` rotates design logs, and tracks `oldestKeptByte`.
  - In `follow-through-main.ts`, pass `onDesignChange` through a listener set (`designJobListeners`), so `design-canvas` can subscribe without an import cycle.
- [x] **Step 4:** Rerun, plus `npm run test:follow-through`. Expected: PASS, with the existing tests unedited.
- [x] **Step 5:** Commit `feat(jobs): a design job owner, argv spawning and a rotating log`.

### Task 3: Socket addresses, the job's process tree, and a reader that fails closed

**Files:**
- Modify: `main/services/follow-through/listening-ports.ts`, `listening-ports.test.ts`, `background-jobs.ts` (`designSockets`), `background-jobs.test.ts`

- [x] **Step 1: Write failing tests.**
  - **Parsers** (captured text):
    - `lsof sockets keep their address`. `n127.0.0.1:5173`, `n*:3000`, `n[::1]:4321`, `n[::]:8000`. The reader passes `-n -P`;
    - `/proc tcp and tcp6 rows give addresses`. `0100007F:1435` gives 127.0.0.1:5173 and `00000000:0BB8` gives 0.0.0.0:3000; also the tcp6 loopback, `::` and IPv4-mapped `::ffff:127.0.0.1` rows;
    - `isLoopbackAddress accepts 127.0.0.0/8, ::1 and ::ffff:127.x, and refuses *, 0.0.0.0, ::, 192.168.1.10 and localhost`;
    - `the ps tree gives the group and every descendant by parent pid`. A `pid ppid pgid` table where a grandchild has its own pgid.
  - **Failing closed** (injected exec and fs):
    - a timeout, a `maxBuffer` overrun, an unreadable `/proc/<pid>/fd` of a live pid, more than 4 096 fds, and an unreadable (not missing) `/proc/net/tcp6` each give `{ ok: false }`, never an empty list;
    - `an unreadable fd folder fails only the job that owns that pid`;
    - `lsof exiting 1 with output is a success`;
    - `the existing ports-only functions behave as before`.
  - **`designSockets`**:
    - `three jobs cost one ps and one lsof call`. Injected exec counts the calls; the lsof argv has one `-p` with every pid of the three trees;
    - (real spawn, in `background-jobs.test.ts`) `a design job's sockets include a listener started by a setsid grandchild, with its address`. A `node:net` server on `127.0.0.1:0` inside a `setsid` child; skipped where `setsid` is missing.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - The socket parsers.
  - `processTable()`: one `ps -A -o pid=,ppid=,pgid=` call, 2 s timeout, 4 MiB buffer; and the pure `jobProcessTree(rows, pgid)`.
  - `listeningSocketsByProcess(pids)`, one lsof call for all pids (or one `/proc` pass), reporting failures.
  - `designSockets(jobIds)`, which runs one `processTable()`, builds each job's tree, makes one `listeningSocketsByProcess` call for the union, and splits the result per job.
  - Aiden's own sockets are left out, as `portsOfProcesses` does. The ports-only functions become wrappers that keep today's "nothing on failure" behaviour for chat jobs.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(jobs): a design job's sockets with addresses, read fail-closed`.

### Task 4: The shared contract and the pure launch core

**Files:**
- Create: `renderer/shared/design-app.ts`, `renderer/shared/design-app.test.ts`, `main/services/design-canvas/app-server/app-launch-core.ts`, `app-launch-core.test.ts`
- Modify: `app-server-core.ts` (re-export the moved `FrameworkId` and `PackageManagerName`)
- Register:
  - `app-launch-core.test.ts` in `test:design-mode` and `core-git`;
  - `design-app.test.ts` in `test:design-mode` and `renderer-other`.

- [x] **Step 1: Write failing tests.**
  - **Launch plan** (D7), from hand-built `DetectedApp`s:
    - `a Vite script gets --host 127.0.0.1 --port --strictPort, after -- for npm and bare for pnpm`;
    - `react-router dev and remix vite:dev get --strictPort; astro, nuxt, angular and vinxi do not`;
    - `Next gets --hostname and PORT; Gatsby gets -H and -p`;
    - `classic remix dev, CRA and Remix 3 get HOST and PORT only`;
    - `a custom server script gets HOST and PORT and no flags`. A Vite app with `dev: "node server.mjs"`;
    - `a script that sets its own port keeps it and gets only the host`. `vite --port 3000`;
    - `a script with its own --host gets no host flag`. `vite --host`;
    - **the environment scrub.** With `NODE_ENV=production`, `ELECTRON_RUN_AS_NODE=1`, `AIDEN_ANALYTICS=0`, `AIDEN_FOO=1`, `npm_lifecycle_event=x`, `NPM_CONFIG_REGISTRY=…`, `npm_config_cache=…`, `INIT_CWD=/x`, `OPENAI_API_KEY=k`, `ANTHROPIC_API_KEY=k`, `NPM_TOKEN=t` and `PATH=":/usr/bin::"`:
      - every scrubbed name is gone, including both provider keys (found through a fake `findEnvKeys`);
      - `NPM_TOKEN` stays;
      - PATH has no empty entries;
      - `BROWSER`, `FORCE_COLOR` and `COREPACK_ENABLE_DOWNLOAD_PROMPT` are set;
    - `telemetry variables are set unless the person set them`. `NEXT_TELEMETRY_DISABLED=0` in the input stays `0`;
    - `the bin folders of Node and the manager come first on PATH`.
  - **Readiness** (D8):
    - `a printed port that the job owns wins`;
    - `a printed port the job doesn't own is ignored`;
    - `with no printed URL, the planned port or the only owned port is ready`;
    - `two owned ports and no match is not ready yet`;
    - `9229 and 24678 never count`;
    - `nothing owned is never ready`.
  - **Exposure** (D9): `exposedSockets` returns the wildcard and LAN sockets, and nothing for `127.0.0.1`, `127.0.0.2`, `::1` and `::ffff:127.0.0.1`.
  - **Install decision** (D6):
    - one test per D6 row;
    - `node_modules present and no record is skip`;
    - `lockfileLevelsUp 1 with node_modules is skip, and without it is outside-workspace, even when forced`.
  - **Fingerprint** (D5):
    - `the fingerprint changes when any listed script text, packageManager, devEngines, rc, workspace or config file, the yarnPath target or the lockfile changes`;
    - `it does not change with the port, the Node path or the manager path`;
    - `file order doesn't matter, and a missing file differs from an empty one`.
  - **Text helpers:**
    - `isAddressInUse matches Node's EADDRINUSE, Vite's "is already in use" and CRA's "Something is already running on port"`;
    - `missingModuleHint finds Node, Vite and webpack missing-module lines`;
    - `lastLines keeps the last N lines within the character cap`.
  - **Contract** (`design-app.test.ts`):
    - `every problem has a fixed message that never contains its tail`. Fixtures put a marker string in `tail`;
    - `manager-missing names the manager; exposed and install-outside-workspace say how to fix it`;
    - `consentDisplayText escapes every class in D5`. Cases: `"dev‮rm"`, `"a​b"`, `"x\u0007"`, `"a\rb"`, `"a b"`, `"a b"`, `"ㅤ"`, `"ﾠ"`, `"ᅟᅠ"`, `"a️"` and `"a\u{E0100}"`. Plain text and `\n` stay as they are.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3:** Implement. Move the two type aliases into the shared file; `app-server-core.ts` re-exports them.
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): launch plan, readiness and the live-app contract`.

### Task 5: Launch fingerprint, the records file and the canvas.json writer

**Files:**
- Create: `main/services/design-canvas/app-server/app-fingerprint.ts`, `app-fingerprint.test.ts`, `app-records.ts`, `app-records.test.ts`
- Modify: `main/services/design-canvas/canvas-config.ts`, `canvas-config.test.ts` (DM's), `main/services/coding-tools.ts` (export `writeConfinedWorkspaceText`), `coding-tools.test.ts`
- Register: the new tests in `test:design-mode` and `core-git`

- [x] **Step 1: Write failing tests** (temp folders, real disk).
  - **Fingerprint reads:**
    - `the surface lists the script, pre and post texts, both roots' install lifecycle scripts, and the files present`;
    - `rc and workspace files in every folder from the app root to the lockfile folder are hashed`. A pnpm monorepo where the member has an `.npmrc` and the root has `pnpm-workspace.yaml` and `.pnpmfile.cjs`;
    - `an enclosing lockfile two levels up is hashed`;
    - `a .yarnrc.yml yarnPath target is hashed, and a yarnPath that is a symlink refuses`;
    - `a symlinked vite.config.ts refuses with launch-file-unreadable naming it`;
    - `a FIFO named .npmrc refuses at once`. The test fails on a 2 s timeout;
    - `a 2 MiB config file refuses, and a 10 MiB lockfile is hashed`;
    - `a script over 4 000 characters gives script-too-long`;
    - `an .npmrc's contents never appear in the result`.
  - **Records:**
    - `approveShown stores the consent with installShown only when the shown fingerprint still matches`;
    - `an unreadable or invalid records file means no consent, no stamp and no port`. Bad JSON, `version: 2`, and a folder in its place;
    - `install records go started, then done with the lock hash`;
    - `forgetWorkspace removes consents, stamps and ports for that workspace only`;
    - `concurrent writes all land`. 50 interleaved `setPort` and `markInstall` calls, then a reread;
    - `the file is written with mode 0600`;
    - `caps evict the oldest workspace and app root`.
  - **`saveCanvasConfigApp`** (extend DM's `canvas-config.test.ts`; DM's tests already cover parsing `script`, so 2b adds none):
    - `it creates .aiden/ and canvas.json in an empty workspace, with version 1`;
    - `it merges script into the matching entry, keeping designMd, routes, params, unknown keys and other entries`. Compare parsed JSON before and after;
    - `it appends a new entry for a new root`;
    - `a file without version is known and keeps having no version field`;
    - `it refuses version 2 and version "1" and leaves the file unchanged`;
    - `it never writes through a symlinked .aiden or canvas.json`. Both refused, the link target unchanged;
    - `a file changed between read and write is not overwritten`. `expectedSha256` mismatch;
    - `root "." round-trips`.
  - **`writeConfinedWorkspaceText`** (in `coding-tools.test.ts`):
    - `creates parents, refuses a path outside the root, and honours expectedSha256 null as create-only`;
    - `with followLinks false, a symlinked parent folder or target is refused, even one pointing inside the root, and the target is unchanged`;
    - `with followLinks false, a link swapped in between the check and the commit is still refused`, through `testObserver.beforeWriteCommit`;
    - `write_file's behaviour (following in-root links) is unchanged`.
- [x] **Step 2:** Run the files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - `hashBounded` and `readLaunchSurface`, reusing 2a's `readBounded` for package.json, and `yaml` for `yarnPath`.
  - `createDesignAppRecords` on `writeJsonAtomic` with a serial queue.
  - `writeConfinedWorkspaceText`, from `write_file`'s internals (`pinWorkspaceRoot`, `resolveWritableInRoot`, `assertAgentMayWriteConfigPath`, `readReplacedFile`, `verifyWorkspaceRoot`, `commitPinnedWrite`), with the file's current SHA-256 checked against `expectedSha256`.
  - **`followLinks: false`.** `resolveWritableInRoot` (`coding-tools.ts:563-598`) resolves the parents and the target to their real paths, so on its own it writes through a link. Add an option: with `followLinks: false`, it `lstat`s every existing component from the root to the target and refuses on any symbolic link. It then returns the unresolved relative path, which goes to `commitPinnedWrite` so the native mutator creates folders and commits without following links. `write_file` keeps the default (`true`).
  - `saveCanvasConfigApp` on top of it: DM's `readCanvasConfigText` for the read, `inspectCanvasConfig` for the version check and `parseCanvasConfigObject` for the raw object, then a raw-JSON merge.
- [x] **Step 4:** Rerun, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): launch fingerprint, records and the canvas.json writer`.

### Task 6: Port choice

**Files:**
- Create: `main/services/design-canvas/app-server/app-ports.ts`, `app-ports.test.ts`
- Register: in `test:design-mode` and `core-git`

- [x] **Step 1: Write failing tests** (real sockets on loopback):
  - `the sticky port is used when free`;
  - `a sticky port in use falls back to the framework default, then to an OS port`;
  - `a port held on the wildcard address counts as in use`;
  - `a port held on ::1 only counts as in use`. Skipped when the host has no IPv6 loopback;
  - `the probe finishes within a second when nothing answers`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3:** Implement `chooseAppPort` and `defaultPortProbe`.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): pick a free loopback port for the app`.

### Task 7: Visible-canvas presence

**Files:**
- Modify:
  - main: `main/services/design-canvas/views.ts`, `views.test.ts`, `main/handlers/design-canvas.ts` (parse `visible`), `main/handlers/design-canvas.test.ts`;
  - renderer: `renderer/design/use-design-view.ts`, `renderer/design/use-design-view.test.tsx`.

- [x] **Step 1: Write failing tests.**
  - **Views:**
    - `onPresence fires with the workspace's visible count on mount, visibility change, unmount and unmountAll`. Two chats on one workspace;
    - `a hidden mounted canvas doesn't count`;
    - `a report that doesn't change visibility doesn't fire`;
    - `the listener can unsubscribe`.
  - **Handler:** `designCanvas:view accepts visible true and false, treats a missing visible as false, and refuses a non-boolean`.
  - **Renderer** (`use-design-view.test.tsx`):
    - `the stacked layout reports visible false when the Chat pane is shown and true when the Canvas pane is`;
    - `a hidden document reports visible false, and becoming visible reports true`. Stub `document.visibilityState` and dispatch `visibilitychange`.
- [x] **Step 2:** Run the files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - The report field. A missing field means not visible, so an older renderer never keeps a server alive.
  - `visible(workspaceId)` and `onPresence`.
  - The renderer reads the stacked pane from the layout context and `document.visibilityState`, and reports on change. A throwing listener is logged and never breaks a report.
- [x] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): report whether the canvas is visible`.

### Task 8: `DesignAppServers` and the consent broker

**Files:**
- Create: `main/services/design-canvas/app-server/app-server-main.ts`, `app-server-main.test.ts`, `app-consent.ts`, `app-consent.test.ts`
- Register: both in `test:design-mode` and `core-git`

The tests use fakes for every dep:
- a fake jobs object that records `startDesign` and `stopDesign`, and lets the test drive output, sockets (and read failures) and exits;
- a fake clock and timers;
- fake detection, config, toolchain, fingerprint, records, ports, views and workspaces;
- a real `WorkspaceMutationGate`;
- a resolved `recoveryReady`;
- an analytics recorder.

- [x] **Step 1: Write failing tests.**
  - **Consent broker** (`app-consent.test.ts`):
    - `a card goes to the owner's window and an answer from another window is refused`;
    - `a second request for a pending key joins it: one card, both callers get the answer`;
    - `no answer in 2 minutes gives unanswered and closes the card`;
    - `a Remote or destroyed owner gives unavailable without sending`;
    - `after Not now, Aiden's requests give declined without a card until forgetDecline`;
    - `the abort signal closes the card`.
  - **Starting** (`app-server-main.test.ts`):
    - `the first start asks, and Allow installs when node_modules is missing, then starts, then runs at http://127.0.0.1:<port>`. Phases broadcast in order; the install argv is 2a's frozen install with the resolved manager path; the run argv and env come from `launchPlan`;
    - `a second start with the same fingerprint asks nothing`;
    - `a changed script asks again with reason changed, and Not now leaves the app stopped with consent-declined`;
    - `a consent given without the install line asks again with reason install when an install becomes needed`;
    - `before each spawn, detection, toolchain and fingerprint run again`. The fake fingerprint changes between Allow and the server spawn (after install): a second card. A changed manager path after consent gives the new path in the argv without a card;
    - `with permission none, a read-only caller, or a Remote owner, start, restart and choose are refused with no-access or desktop-only, and nothing is read`. Zero calls on the fingerprint, detection and toolchain fakes, even with a stored consent;
    - `start waits for recoveryReady, and a failed recovery ends with recovery-failed`;
    - `a toolchain problem ends the attempt with that problem and sends design_app_started failed without manager`;
    - `node_modules present and no install record skips the install; a started record reinstalls; restart with install reinstalls`;
    - `an enclosing lockfile never installs: with node_modules it starts, without it ends with install-outside-workspace`;
    - `an install exit 1 gives install-failed with the last lines, and the record stays started`;
    - `an install past 15 minutes is stopped with install-timeout`;
    - `two chats starting the same app share one attempt, one card and one job`;
    - `a ninth design server gives job-limit`.
  - **Workspace changes:**
    - `a workspace mutation that begins during consent or install aborts the attempt and stops its job`;
    - `a rename-only update ends the attempt with interrupted; a permission change to none or a removed folder gives no-access`;
    - `a running server whose workspace folder path changes is stopped`.
  - **Readiness and exposure:**
    - `a printed URL on a port the job doesn't own never makes it ready, and 120 s without output stops it with not-ready`;
    - `output resets the readiness timer, and the 10-minute cap stops it anyway`;
    - `a wildcard socket stops the job with exposed, even after it printed a loopback URL`;
    - `a socket that turns wildcard while running is caught on the next 2 s poll`;
    - `failed socket reads never mark it running; three in a row while running stop it with exposure-unknown, and one success resets the count`;
    - `an address-in-use exit during starting retries once on a new port; a second one is a crash`;
    - `the ready port is recorded as the sticky port`;
    - `two servers share one designSockets call per tick: every 500 ms while either is starting, every 2 s once both run, and no ticks once both stop`.
  - **Crash, stop and restart:**
    - `an exit while running is crashed with the exit code and at most 20 lines, and nothing restarts it`;
    - `an exit with code 0 while running is crashed`;
    - `a crash tail with "Cannot find module" carries the install hint`;
    - `stop ends the job and leaves stopped with no problem; a second stop is a no-op`;
    - `stop during consent closes the card; stop during install stops the install`;
    - `restart keeps the port and runs the D5 checks again`.
  - **Presence and lifecycle:**
    - `60 s after the last visible canvas of a workspace goes, its servers stop; becoming visible within 60 s keeps them`;
    - `a server started while nothing is visible stops 60 s later`;
    - `presence in another workspace changes nothing here`;
    - `the job stopped from stopWorkspace marks the app stopped`;
    - `forgetWorkspace stops timers, clears statuses and isAppOrigin entries, and forgets records`;
    - `constructing the service and restoring views never starts, probes or reads anything`. Every dep throws on use, and `views` fires presence for restored chats.
  - **Toggle and choose:**
    - `designModeEntered starts the single web app`;
    - `designModeEntered with two web apps and no described roots starts nothing, and the snapshot target is choose`;
    - `described roots in .aiden/canvas.json start in turn, each with its own card; a designMd-only entry describes nothing`;
    - `a described entry naming a non-web root, a missing script or an unsafe name is ignored`;
    - `choose shows a card with reason choose and savesChoice, and Allow calls saveCanvasConfigApp before starting`;
    - `choose on a react-nonweb or unknown-framework root is refused with not-web`;
    - `a chat moved to another workspace with design mode on starts nothing there`.
  - **3a and 2c contract:**
    - `appForOrigin matches only the exact address and port the running job holds`. `http://127.0.0.1:<p>` matches. `http://localhost:<p>` and `http://[::1]:<p>` don't, unless the job holds `::1`. Another port, `http://localhost.evil.com:<p>` and `https://127.0.0.1:<p>` don't;
    - `isAppOrigin stays true for every origin served this session after the server stops, until forgetWorkspace`, including the localhost alias;
    - `onOriginsChanged fires when a server starts and stops running`;
    - `logs pass the byte cursor through and cap at maxBytes`;
    - `snapshot lists candidates, described roots and every app's status with relative roots only`. No absolute path anywhere in the JSON.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3: Implement** the state machine of D2–D17:
  - a per-key promise queue;
  - one workspace admission per attempt, released at `running` or the end;
  - phase changes through one `setPhase`, which bumps `revision`, notifies `onStatus` and, for running changes, `onOriginsChanged`;
  - one shared readiness and exposure poller for all keys (500 ms while any key is starting, else 2 s), started with the first job and stopped with the last, with no overlapping ticks;
  - presence timers keyed by workspace;
  - a session set of served origins per workspace.

  Every external effect goes through `deps`.
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): DesignAppServers runs one dev server per app root`.

### Task 9: Real processes: a fake dev server and the real Vite

**Files:**
- Create: `tests/fixtures/design-app-server/server.mjs`, `tests/fixtures/design-app-server/fake-pm.mjs`, `tests/fixtures/design-app-server/README.md`, `main/services/design-canvas/app-server/app-server-process.test.ts`
- Register: the test in `test:design-mode` and the `macos` lane (it reads real lsof addresses; skipped on win32)

The fixture is plain Node with no dependencies.

**`server.mjs`** listens with `node:http` on `--host`/`--port` or `HOST`/`PORT`, prints `  ➜  Local:   http://127.0.0.1:<port>/`, and answers 200. Its test modes:
- `--fake-wildcard`: listen on `0.0.0.0`;
- `--fake-late-wildcard=<ms>`: also listen on the wildcard address later;
- `--fake-crash-after=<ms>`;
- `--fake-never-listen`, and `--fake-chatty-never-listen` (prints every second);
- `--fake-other-port`: listen on a port other than the one asked for, and print the asked one;
- `--fake-flood=<bytes>`;
- `--fake-child`: spawn a child that ignores SIGTERM;
- `--fake-setsid-child`: spawn a `setsid` child that listens on the wildcard address;
- `--fake-in-use`: exit with CRA's "Something is already running on port" message.

**`fake-pm.mjs`** stands in for a package manager. The test writes a `#!/bin/sh` shim to a temp folder, mode 0755, and hands its path to the service as the manager:
- `install` and `ci` write `node_modules/.fake-installed` and exit with `FAKE_INSTALL_EXIT` (default 0);
- `run <script> [--] args…` runs the script text from `package.json` with `sh -c`, with the args appended, as npm does.

Each test copies the fixture into a temp app root with a `package.json` (`"devDependencies": { "vite": "*" }`), so detection classifies it as `web`. Install tests add a `package-lock.json`, so the install command is `ci`.

- [x] **Step 1: Write failing tests.** They use the real `BackgroundJobs`, the real socket reader, the real port chooser, a temp userData records file and real timers. The readiness timer is a constructor option set to 5 s, and the grace period to 1 s.
  - `a custom dev script starts on loopback and runs at http://127.0.0.1:<port>`. An HTTP GET to the origin answers 200;
  - `the real Vite starts through a node_modules symlink with --host, --port and --strictPort, and binds loopback only`. The temp app's `node_modules` is a symlink to the repo root's (which carries `vite`, as §7 plans for 3a), with `dev: "vite"`, an `index.html`, and npm as the real manager. The socket read shows only `127.0.0.1:<p>`;
  - `a wildcard listener is stopped as exposed`;
  - `a late wildcard listener is stopped as exposed while running`;
  - `a setsid child's wildcard listener is caught`;
  - `a server that never listens is stopped as not-ready, and its process is gone`;
  - `a chatty server that never listens survives past the inactivity timer, until the hard cap`. The hard cap is set to 8 s for the test;
  - `a crash after start is reported as crashed with its tail`;
  - `a server listening on another port than it prints is ready on the port it really holds`;
  - `a flood of 8 MB keeps the server running, with the log rotated`. Rotate size 1 MB;
  - `stop ends the server and its SIGTERM-ignoring child`;
  - `a first install runs fake-pm ci, writes the stamp, and the next start skips it`;
  - `CRA's address-in-use message is retried once on another port`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/app-server/app-server-process.test.ts`. Expected: FAIL.
- [x] **Step 3:** Fix what the real processes show (timing, group kill, address reads on this host). The fake-dep tests in Task 8 stay the oracle for rules; this file proves the wiring.
- [x] **Step 4:** Rerun three times in a row on the host, then once in the Cua Space (`npm run test:e2e:space -- --run npx tsx --test main/services/design-canvas/app-server/app-server-process.test.ts`) for Linux `/proc` sockets. Expected: PASS each time. A failure that passes on rerun is a bug (AGENTS.md).
- [x] **Step 5:** Commit `test(design): dev-server lifecycle against a fake server and real Vite`.

### Task 10: The consent card

**Files:**
- Create: `renderer/design/design-app-consent.tsx`, `renderer/design/design-app-consent.test.tsx`
- Modify:
  - `renderer/preload-channels.ts` and `renderer/lib/ipc.ts` (`designAppApi`);
  - the component that mounts `design-mode-consent.tsx`, to mount the new card beside it.
- Register: the test in `test:design-mode` and `renderer-other`

Before styling, review `GUI.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. The card follows `design-mode-consent.tsx`:
- **Layout.**
  - A `Callout` above the composer, with the shared squircle `Button`s Allow (primary) and Not now.
  - Title: "Run <frameworkLabel> app?", or "Run <frameworkLabel> app again?" for `changed` and `install`.
  - Under it, in order:
    - the escaped app root and package name;
    - the run command;
    - the install line when present;
    - each script as a labelled monospace block;
    - the launch file names;
    - the save line for `choose`;
    - the S2 sentence.
- **Style.** Semantic tokens only. Blocks scroll inside a max height and have no decorative border. Status colour stays in soft fills, with no coloured outline.
- **Keyboard.** Focus lands on Not now, and Escape is Not now.
- **Attach requests.** The card ignores `kind: "attach"` requests: 2c renders those.

- [x] **Step 1: Write failing tests** (Testing Library, a stub `designAppApi`):
  - `the card shows the command, the install line, every script's text and the launch file names`;
  - `a script, app root or package name with a bidi override or a Hangul filler shows the escape, not the character`;
  - `a choose request says Allow saves the choice to .aiden/canvas.json`;
  - `Allow and Not now answer with the request id, and the card closes on consentClosed`;
  - `a request for another chat waits until that chat is shown`, as `design-mode-consent.test.tsx` does;
  - `Escape answers Not now and focus starts on Not now`;
  - `a problem status from a person-started attempt shows one toast with the fixed message and never the tail`.
- [x] **Step 2:** Run `npx tsx --test renderer/design/design-app-consent.test.tsx`. Expected: FAIL.
- [x] **Step 3: Implement.**
  - The card.
  - The preload channels: `designApp:consent`, `designApp:consentClosed`, `designApp:status` and the invoke channels.
  - The `designAppApi` wrappers.
  - The toast: it listens to `designApp:status`, and shows only for an app whose `startedBy` is `person`, once per `revision` with a new `problem` or `crashed`.
- [x] **Step 4:** Rerun, plus `npm run test:design-mode`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): the run-app consent card`.

### Task 11: The `design_app` tool and its approval exception

**Files:**
- Create: `main/services/design-canvas/app-server/app-tool.ts`, `app-tool.test.ts`
- Modify: `main/services/approval-gate/workspace-tool-approval.ts`, `workspace-tool-approval.test.ts`, `main/services/llm-client.ts`
- Register: `app-tool.test.ts` in `test:design-mode` and `core-git`

The tool:
- **Description.** "Run this workspace's web app for design mode: status, start, stop, restart, logs, or choose which app in a monorepo. The first start asks the person on a card. It runs only the app's own dev script, never other commands; use run_command for those."
- **Parameters.**
  - `action`: `status | start | stop | restart | logs | choose`;
  - optional `root`: an app root from `status`;
  - `script`: for `choose`;
  - `install`: boolean, for `restart`;
  - `lines`: 1–200, for `logs`, default 50.
- **Results** are JSON, as `design_mode`'s are.
  - **`status`:** the target and each app's phase. Running apps have `url`; apps with a problem have its message, a fenced tail and the missing-module hint.
  - **`start`, `restart` and `choose`:**
    - they wait while the card is open (up to its 120 s), then up to 90 s more for the attempt to settle;
    - they answer the phase, with a `next` line for `consent`: "The person hasn't answered the card yet; check status in a moment and don't start again";
    - a `next` line for `installing` and `starting`: "It is still starting; check with status in a moment";
    - a `next` line for `declined`, `unanswered`, `unavailable` and `desktop-only`, as `design_mode`'s are.
  - **Abort** stops the waiting, not the server.
  - **Budget.** A fifth `start`/`restart`/`choose` in one turn answers an error result without acting (D16).

- [x] **Step 1: Write failing tests.**
  - **Tool** (fake service):
    - `status lists apps with relative roots, 127.0.0.1 urls and fenced tails`;
    - `start passes by aiden, the turn's owner and permission, and returns running with the url`;
    - `start answers declined with a next line telling Aiden not to ask again`;
    - `a start still in consent after the wait returns phase consent with its next line`;
    - `the fifth start, restart or choose in a turn is refused without calling the service`;
    - `logs are fenced as data and capped at 200 lines and 8 000 characters`;
    - `choose with a root that isn't a candidate is refused before any card`;
    - `an unknown action or root is an error result, not a throw`;
    - `after design mode is turned off mid-turn, every action answers unavailable`. Through `stillAvailable`.
  - **Gate** (`workspace-tool-approval.test.ts`, calling `workspaceToolApproval`):
    - `design_app is allowed with via reviewed-exception in ask, auto and full modes, and with legacy permissions`;
    - `design_app is never judged and offers no Mac grant`;
    - `a PreToolUse hook block and a rules-page Block still block design_app`;
    - `a rules-page Ask on design_app still asks`.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - **The exception.** In `workspace-tool-approval.ts`, add `REVIEWED_CARDLESS_TOOLS: ReadonlyMap<string, string>` with `design_app` and the reason "design-mode dev-server control: per-call approval skipped after workspace consent".
  - **Its decision.** For a tool in that map, `workspaceToolApproval` runs the hook and rules steps first. If neither blocks or asks, it returns `{ outcome: "allow", via: "reviewed-exception" }`. Widen `WorkspaceToolApproval`'s `via`, and update the callers that switch on `via` (log or ignore it like `hook-allow`).
  - **The offer.** In `llm-client.ts`, reuse DM's `designLive`. Offer `design_app` beside the canvas tools only when all of these hold:
    - `designLive`;
    - `followThroughAvailable`;
    - the canvas tools are offered.

    List it in `windowOnlyToolNames` as the canvas tools are.
  - **`stillAvailable`** reuses the canvas tools' check (design mode on, same folder, permission not `none`), plus the flag.
  - **The card's owner** is `getOwner()`.
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, plus `npx tsx --test main/services/approval-gate/workspace-tool-approval.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): design_app tool, a reviewed approval exception`.

### Task 12: Production wiring and IPC

**Files:**
- Create: `main/handlers/design-app.ts`, `main/handlers/design-app.test.ts`
- Modify:
  - `main/services/design-canvas/main.ts` (the `designAppServers` singleton; `designCanvasWorkspaceCleanup` and `removeDesignCanvasWorkspace` call `forgetWorkspace`);
  - `main/handlers/chat-renderer-mutations.ts` (toggle hook) and `main/handlers/design-canvas-main.ts` (Aiden's card hook);
  - `main/services/follow-through/follow-through-main.ts` (`onDesignChange` listener);
  - `main/index.ts` (pass `processRecoveryReady` and register the handlers);
  - `main/services/analytics/analytics-events.ts` and `main/services/analytics/analytics-feature-reports.test.ts`.
- Register: `design-app.test.ts` in `test:design-mode` and `core-git`

- [x] **Step 1: Write failing tests.**
  - **IPC** (register and invoke, in the style of `main/handlers/design-canvas.test.ts`):
    - `every designApp handler refuses while the flag is off`;
    - `every designApp handler refuses a subframe sender`. A fake event whose `senderFrame` isn't the main frame;
    - `status:get, start, stop, restart, choose and logs refuse a Bot chat, a missing chat and a chat whose workspace has no folder`;
    - `start passes by person, the sender's document owner and the workspace permission`;
    - `consentAnswer from another window is refused`;
    - `malformed arguments are refused`. A non-string app root, `../x`, an absolute root, and `logs` with a negative cursor.
  - **Hooks** (extend the existing suites):
    - in `chat-renderer-mutations.test.ts`:
      - `turning design mode on calls designModeEntered once with the sender's document owner; turning it on again or off does not`;
      - `with the flag off, or from a subframe, it is never called, and the toggle still succeeds`;
    - the Aiden's-card Enter path, the same way;
    - in the cleanup test: `removing a workspace forgets its design apps`.
  - **Analytics** (in `analytics-feature-reports.test.ts`, through `captureAnalyticsEvents`):
    - `design_app_started is sent with framework, manager and outcome`;
    - `it is sent without manager`;
    - `an unknown framework, manager or outcome, or any other property, is dropped`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement.**
  - Build `designAppServers` in `design-canvas/main.ts` from the real deps:
    - `backgroundJobs`;
    - `detectWebApp` with `stopAt` set to home;
    - `readCanvasConfig` and `saveCanvasConfigApp`;
    - `defaultAppToolchainDeps()`;
    - the fingerprint reader;
    - the records file at `userData/design-apps.json`;
    - the port chooser;
    - `designCanvasViews`;
    - `configStore.getWorkspace`;
    - `workspaceMutationGate`;
    - a `recoveryReady` promise that `main/index.ts` resolves with `processRecoveryReady`;
    - `reportAnalyticsEvent`;
    - the logger;
    - the grace period (60 s, or the clamped dev knob from Q8).
  - Construction does no I/O.
  - Broadcast `designApp:status` from `onStatus`.
  - Subscribe to `onDesignChange` through Task 2's listener set.
  - Add the registry row:

    ```ts
    design_app_started: {
      framework: enumProp(...FRAMEWORK_IDS),
      manager: optional(enumProp("npm", "pnpm", "yarn", "bun")),
      outcome: enumProp("running", "crashed", "failed"),
    }
    ```

    Append it after DM's rows.
- [x] **Step 4:** Rerun, `npm run test:design-mode`, `npm run test:follow-through`, `npx tsc --noEmit -p .`, `npm run lint`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): wire live apps into design mode behind the flag`.

### Task 13: E2E and screenshots

**Files:**
- Create: `tests/e2e/design-app-server.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json` (map the spec to `main/services/design-canvas/app-server/`, `main/handlers/design-app`, `renderer/design/design-app-consent`, `renderer/shared/design-app.ts`, `main/services/follow-through/background-jobs.ts`, `main/services/follow-through/listening-ports.ts` and `tests/fixtures/design-app-server/`)

- [x] **Step 1: Write the spec.**
  - **Launch.** `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1` and `AIDEN_E2E_DESIGN_APP_GRACE_MS=2000`.
  - **Workspace.** A temp copy of `tests/fixtures/design-app-server/` with an empty `node_modules/` (so no install) and `dev: "node server.mjs"`. The real `npm` from the environment runs it.
  - **Cases:**
    - `turning design mode on shows the run-app card with the script text; Not now starts nothing`. `designApp:status:get` shows `stopped` with `consent-declined`;
    - `Allow starts the app and it reaches running at http://127.0.0.1:<port>`. Poll `designApp:status:get` through the page bridge; the origin answers an HTTP GET from the test;
    - `showing the Chat pane in the stacked layout, or leaving design mode, stops the server after the grace period`;
    - `a second chat in the same workspace turning design mode on doesn't start a second server or ask again`.
  - **Screenshots:** `1440-design-app-consent-{light,dark}.png` in the test's output folder.
- [x] **Step 2:** Run `npm run test:e2e:space -- tests/e2e/design-app-server.spec.ts`. Then run it on the host with `npx playwright test tests/e2e/design-app-server.spec.ts`: the socket reader has a darwin branch (lsof), which the Linux Space doesn't exercise. Expected: PASS both.
- [x] **Step 3:** Commit `test(design): live app start and stop E2E`.

### Task 14: Docs, memory and spec amendments

**Files:**
- `docs/design-mode.md` (DM's file), `docs/analytics.md`, `docs/plans/README.md`
- `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`
- `.memory/design-mode.md`
- this plan

- [x] **Step 1: `docs/design-mode.md`.** Append a "Live apps (experimental)" section after DM's. It covers:
  - the flag;
  - that turning design mode on starts the workspace's web app after an approval card, and when the card comes back;
  - that installs use the package registry, and never run in a parent repo;
  - loopback only, at `127.0.0.1`, and the `exposed` fixes: remove `--host` from the script, or for Remix 3's starter make `server.ts` listen on `process.env.PORT` at `process.env.HOST`;
  - that apps read their keys from their own `.env`, because Aiden removes provider keys and its own variables from the environment;
  - the framework telemetry variables Aiden sets;
  - the 60 s stop when the canvas isn't visible, and the other stops;
  - that monorepos pick apps once, saved as `script` in `.aiden/canvas.json` `apps`;
  - macOS and Linux only.
- [x] **Step 2: `docs/analytics.md`.** After DM's rows, add `design_app_started`: "A design-mode app start that got past the approval card settled". List `framework`, `manager` (left out when none was resolved) and `outcome`, with their values.
- [x] **Step 3: Spec amendments.** Add "### Phase 2b amendments (2026-11-24)" with exactly these numbers (DM uses S33–S44):
  - **S25. Design jobs (2b).** A design owner with its own cap of 8 and its own read, stop and socket methods. The log rotates at 25 MB and keeps 50 MB; reads take byte offsets. `scanPorts` and finished-job eviction never notify a chat. The shared job types and Remote are unchanged.
  - **S26. Consent detail (2b).** The fingerprint covers:
    - both roots' install lifecycle scripts;
    - the raw `packageManager` and `devEngines` values;
    - rc and workspace files from the app root to the lockfile folder, and the `yarnPath` target;
    - the lockfile and framework configs (the spec's five, plus Nuxt, Angular and Gatsby).

    The other rules:
    - unreadable or linked files, and scripts over 4 000 characters, refuse;
    - the record keeps `installShown`;
    - detection, toolchain and fingerprint run again before every spawn;
    - display escapes cover control, format, line and paragraph separators, Hangul fillers and variation selectors;
    - `start`, `restart` and `choose` need a live desktop window owner.
  - **S27. Install rule (2b; narrows S8).** An install runs for a missing `node_modules`, an unfinished or stale Aiden install, or on request. It doesn't run for an install the person made, and never when the lockfile is outside the workspace (`install-outside-workspace`).
  - **S28. Launch environment (2b; extends S19 and S22).**
    - Flags are added only when the script runs the framework CLI, never as a second host or port flag; Vite-based CLIs get `--strictPort`, and classic `remix dev` gets env only.
    - The scrub removes `NODE_ENV`, `ELECTRON_*`, `AIDEN_*`, `npm_*`, `npm_config_*`, `INIT_CWD` and provider keys.
    - Framework telemetry is off unless the person set it.
    - Remix 3's default starter ignores `HOST` and `PORT` and is refused as `exposed` (S22 note).
  - **S29. Origin and exposure (2b; amends §6.2.3 line 186).**
    - The origin is `http://127.0.0.1:<port>`.
    - Readiness needs a port the job's process tree holds; the timer resets on output, with a 10-minute cap.
    - Every socket of the tree must be loopback, checked by one shared poller (one `ps` and one `lsof` per tick for all jobs) every 500 ms while starting and every 2 s while running, with a reader that fails closed and a 4 096-fd cap per process; three failed reads stop the server.
    - `appForOrigin` matches held addresses only, and `isAppOrigin` keeps every served origin restricted for the session.
  - **S30. Presence and workspace changes (2b; refines S6).**
    - Presence is a visible canvas (pane shown and document visible).
    - Each attempt holds a workspace admission. A folder-path change or `none` stops a running server.
    - `no-access` only when access is really gone, otherwise `interrupted`.
    - The existing gate covers workspace changes, so there's no separate pause.
  - **S31. Tool and choice (2b).**
    - No automatic restart.
    - At most 4 starts per turn; the tool waits for the card.
    - `choose` accepts only `web` candidates, and saves `script` into `.aiden/canvas.json` through the confined writer, which refuses any link on the path and an unknown `version`, and writes new files with `version: 1`.
    - Configured roots come from DM's `configuredRoots`.
    - A moved chat starts nothing.
  - **S32. Phase split (2b, 2c).** 2b owns the `design_app` tool and the `designApp:*` IPC (all through `rendererDocumentOwner`), the `launch | attach` consent union and the attach problems. 2c adds only UI and attaching.

  Update the status line at the top to name the 2b plan.
- [x] **Step 4: Plan index.** Extend the design mode v2 row in `docs/plans/README.md`: "Phase 2b (the dev server process) planned 2026-11-24, stacked on DM, plan [p2b](../superpowers/plans/2026-11-24-design-mode-v2-p2b-dev-server.md)". Add the PR number and "in review" when the PR opens.
- [x] **Step 5: Memory.** Add a "v2 Phase 2b: dev server" section to `.memory/design-mode.md`, covering:
  - the module layout;
  - the design owner;
  - the consent fingerprint and where records live;
  - the install rule;
  - the launch plan and env scrub;
  - the 127.0.0.1 origin;
  - readiness and the exposure watch;
  - visible presence and the workspace gate;
  - the IPC and status contract for 2c and 3a;
  - the flag;
  - the test files and lanes.

  Update the v2 summary line at the top.
- [x] **Step 6: Stale claims.** Run `rg -n "design_app|DesignAppServers|AIDEN_EXPERIMENTAL_DESIGN_LIVE|localhost:<port>|background job" README.md PRODUCT.md docs .memory AGENTS.md packages/cli/README.md` and fix what 2b made wrong. Expected:
  - `README.md` and `PRODUCT.md` describe shipped defaults, and live apps are off by default, so no edit (Phase 7 updates them);
  - `docs/keyboard.md` has nothing new;
  - onboarding doesn't change while the feature is flagged: S6 moves the tile and art to Phase 7, so onboarding changes once, at launch;
  - `host-platform-capabilities.ts` needs no change (2b relies on `backgroundJobs`, true on darwin and linux).
- [x] **Step 7:** Tick this plan's boxes, and commit `docs(design): Phase 2b docs, spec amendments and memory`.

## Verification

Run, in order, each expected to pass:
- `npx tsx --test main/services/follow-through/background-jobs.test.ts main/services/follow-through/listening-ports.test.ts main/services/studio/feature-flags.test.ts main/services/approval-gate/workspace-tool-approval.test.ts main/services/analytics/analytics-feature-reports.test.ts main/services/coding-tools.test.ts`
- `npx tsx --test main/services/design-canvas/app-server/*.test.ts main/services/design-canvas/canvas-config.test.ts main/services/design-canvas/views.test.ts main/handlers/design-app.test.ts main/handlers/design-canvas.test.ts main/handlers/chat-renderer-mutations.test.ts renderer/shared/design-app.test.ts renderer/design/design-app-consent.test.tsx renderer/design/use-design-view.test.tsx`
- `npm run test:design-mode` and `npm run test:follow-through`
- `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
- `npm run lint`
- `npm run test:ci-policy` (registry lanes: `core-git` for main tests, `renderer-other` for `design-app.test.ts` and `design-app-consent.test.tsx`, `macos` for `app-server-process.test.ts`; `ci-e2e-spec-map.json` has the new spec)
- `npm run cli:build` (a guard: the CLI doesn't bundle `design-canvas/`, but it must still build after the `background-jobs.ts`, `listening-ports.ts` and `coding-tools.ts` changes)
- `npm run test:e2e:space -- tests/e2e/design-app-server.spec.ts`, then the same spec on the host (darwin lsof branch)
- `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts` (design mode on and off must be unchanged with the flag off)
- iOS and Android: nothing to run. No shared server contract, Remote route or transcript UI changes. Check with `rg -n "BackgroundJobEndReason|chat:jobs" ios android` that no client reads a field 2b changed.

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries the light and dark card screenshots.

## Risks and edge cases

For reviewers to attack:

1. **Orphaned processes.** The server runs in its own process group and stops with SIGTERM, then SIGKILL after 4 s.
   - A grandchild that calls `setsid` leaves the group. The exposure check still sees its sockets (the tree goes by parent pid), but a runtime stop signals the group only. It still carries the `AIDEN_BACKGROUND_JOB` marker, so `reapPreviousLaunch` kills it at the next launch.
   - A child re-parented to init loses its parent link and drops out of the tree.
   - **After an Aiden crash, servers keep running until the next launch reaps them** from `running.json`, which lists design jobs. Until then they hold their ports and keep serving on loopback.
   - A server whose stop can't be confirmed stays `running` in `backgroundJobs`, and its status says so.
2. **Port races.** The free check and the server's own listen are separate.
   - Vite with `--strictPort` exits on a taken port and is retried once on an OS port; Next and CRA exit and are retried too.
   - Readiness reads the port the job really owns.
   - Two workspaces starting at once may pick the same default port; the second retries.
   - A sticky port taken by something else since then gives a new origin, and the app signs out.
3. **A hostile `package.json` or repo.**
   - The consent hashes everything D5 lists, and a change asks again.
   - Imports from configs, PostCSS and Tailwind configs, and `node_modules/.bin` are app code, which the card says consent doesn't cover.
   - Re-running detection right before spawn leaves a window of milliseconds; a process that can write the repo can already change the app's code.
   - `.aiden/canvas.json` can only name roots and scripts that detection accepts, and still needs consent.
   - Unicode tricks are escaped on the card.
   - `--host` in a script is caught at the socket, not trusted in text.
4. **Secrets in the environment.** The scrub removes provider keys pi-ai knows, every `AIDEN_*`, and npm's own variables.
   - Tooling tokens (`NPM_TOKEN`, `GH_TOKEN`, cloud keys from a shell profile) stay for installs, and the app's code can read them.
   - A provider key under a name pi-ai doesn't know survives.
   - The env is never written to a status, a tool result, analytics or Aiden's logs. The app's own output can print it, and that reaches Aiden fenced as data.
5. **Loopback in practice.**
   - Remix 3's default starter and custom `listen(PORT)` servers are refused as `exposed` until they bind 127.0.0.1. That's deliberate, and the docs give the fix.
   - Attack: IPv4-mapped forms, a server that binds loopback first and the wildcard later (caught within 2 s), and the 2 s window itself.
6. **Windows and Linux.**
   - Windows gets `unavailable` and no tool.
   - On Linux, addresses come from `/proc/net/tcp` and `tcp6`, and fds from `/proc/<pid>/fd`. A child that made itself non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`, or a setuid helper) has an fd folder Aiden can't read. The reader then fails closed: the server never becomes ready, or a running one stops with `exposure-unknown`. Attack whether a common dev tool does this.
   - lsof on macOS can take up to 2 s on a busy machine; ticks never overlap, so a slow read stretches the interval rather than piling up.
   - **Polling cost.** One `ps` plus one `lsof` is about 100 ms of CPU. With one shared tick for all jobs, that is about 20% of a core while something is starting (500 ms) and about 5% while everything is running (2 s), whatever the number of servers. Attack whether 2 s is too slow for the exposure window, or too costly on battery.
7. **A server that never becomes ready.** It's stopped after 120 s without output, or 10 minutes from spawn.
   - A big Next app is "ready" (listening) long before its first page compiles.
   - A server on a Unix socket is never ready.
   - `predev` codegen counts against the 10 minutes.
8. **Huge output.**
   - The tail is capped at 20 000 characters, so memory is bounded.
   - The log rotates at 25 MB and keeps 50 MB without stopping the server.
   - URL parsing scans the tail only.
   - Readers past the rotation get `truncated: true` from the oldest kept byte.
9. **The install.**
   - `npm ci` deletes `node_modules` first, which is why a person's own tree is kept (D6).
   - Installs run lifecycle scripts, which the card states and the fingerprint covers.
   - `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` lets a corepack shim download a pinned pnpm or Yarn without asking (S19).
   - Parent-repo installs are refused.
10. **Presence edge cases.**
    - A window that is visible but frozen keeps its count.
    - Sleep delays timers.
    - Attack the reload path (`whenSenderResets` → `unmountAll` → remount): the server must survive a reload within 60 s.
    - Attack the stacked layout and minimise: `visibilityState` is `hidden` for a minimised window on macOS, but not for one fully covered by another app.
11. **Consent card placement.** The person's toggle sends the card to the toggling document. A card for a chat the person isn't viewing waits for that chat, and can time out after 2 minutes. Aiden hears `unanswered`.
12. **Two workspaces, one folder.** Two keys and two servers. Next.js refuses the second (`.next` lock), which shows as a crash. Accepted as rare.
13. **The flag off.** The tests prove nothing runs, but the `designApp:*` handlers and preload channels still exist. Attack whether a renderer can reach `DesignAppServers` through any path while the flag is off.
14. **The DM dependency.** If DM changes `canvas-config.ts`'s parser or the flag helper after this plan, Task 0 catches it. 2b never adds a second parser or helper.

## Open questions

Each has the answer this plan uses. Q1, Q2, Q5 and Q8 were settled by the reviews.

1. **Install for a person's own `node_modules` with no stamp.** *Settled:* no reinstall (D6, S27). A crash with a missing module gets a `restart { install: true }` hint.
2. **A server bound beyond loopback.** *Settled:* stop, as `exposed` (D9).
3. **Automatic restart after a crash.** *Assumed:* none (D10, S31).
4. **Where the person sees errors before 2c's chip.** *Assumed:* a toast with fixed text from the card's host component, for person-started attempts only (D14). 2c may replace it without a type change.
5. **Framework telemetry.** *Settled:* the telemetry variables are set unless the person set them (D7).
6. **Keep-awake.** *Assumed:* unchanged. Keep-awake already ignores jobs with listening ports, so a running server never keeps the Mac awake; an install does until it ends.
7. **`.aiden/canvas.json` before 3b.** *Settled* (cross-phase decision 2): DM owns the reader; 2b adds `script` and `saveCanvasConfigApp`, which keeps every other field.
8. **The E2E grace knob.** *Settled:* `AIDEN_E2E_DESIGN_APP_GRACE_MS`, read only when `!app.isPackaged`, as `AIDEN_ANALYTICS_DEBUG` is (`analytics-main.ts:51`), and clamped to 1–60 s.
9. **Spec amendment numbers.** *Settled:* 2b uses S25–S32 and DM uses S33–S44.

## As built (2026-11-24)

Built on `t3/design-mode-v2-p2b` in plan order. Where the code differs from the text above, the code and this list win.

**Interfaces adapted (Tasks 1–8).**
- `launchPlan` takes an options object (`binDirs`, `providerKeys`, `platform`) and returns `run` as well as `extraArgs` and `env`. `readLaunchSurface` takes no toolchain. `hashBounded` also reports `{missing}`.
- `saveCanvasConfigApp` takes write hooks, for its tests. `toolchainProblemMessage` moved to `renderer/shared/design-app.ts`, so 2c needs no main import. `scriptDevCommand` and `scriptTextWords` were added for the flag rules.
- `listeningSocketsByProcess`' failure carries `byPid`. The ports-only functions are unchanged.
- A missing `/proc/net/tcp6` (ENOENT, a kernel without IPv6) reads as no IPv6 sockets when `/proc/net/tcp` read fine. Any other `tcp6` error still fails closed.
- The renderer capability is `designLive`.
- `BackgroundJobs` gained `designTail(jobId)` for crash tails.
- The consent broker's `request` takes `by` (only Aiden's request is silenced by a decline), and it gained `closeAll(prefix)`.
- `DesignAppServersDeps` has `choosePort`, `osPort`, `launchEnv`, `platform`, `enabled`, `limits` and a `workspace` getter, instead of the plan's `ports` and `timers` names.
- Readiness counts only IPv4 loopback (127.x) ports a process of the job holds.
- Output resets the quiet timer at the next poll tick (at most 500 ms later), because output is deliberately not a job change event.
- A choose always asks once per attempt.
- Toolchain problems answer before any card, and analytics records `failed` (D17).
- A card shown again after a repo change between the card and Allow says `changed`.

**Task 9.**
- `stopDesign` also finds the job tree's members that left its process group (`setsid`) by parent pid, before any signal, and signals them with the group. The setsid process test failed without this fix.
- The fixture's address-in-use flag is `--fake-in-use-once=<file>`, so the retry succeeds.
- The process tests use the real records file; the fake-dependency tests keep records in memory.
- The Vite test links the repo's `node_modules` and asserts nothing installs.

**Task 10.**
- `designApp:status` and the `designApp:` invoke prefix were added in Task 12 with their send site and handlers. The IPC contract test requires every allowlisted notification to have a main send site and every prefix to have a handler.
- The card's script wells use the `bg-control` token, because the `Callout` already uses `bg-well`.
- Problem toasts are one `DesignAppProblemToasts` mounted beside the `Toaster` in `app.tsx`.
- No toast is shown for `consent-declined`, `consent-unanswered`, `consent-unavailable` or `desktop-only`.

**Task 11.**
- Offering `design_app` in `llm-client.ts` moved to Task 12, because it needs the `designAppServers` singleton.
- The gate exception runs `planActionGate` with only the hook verdict and the rules-page rule. Block and Ask keep the gate's own order, and a rules-page Allow also answers `reviewed-exception`. In Never ask mode, a rules-page Ask is pre-approved as it is for every tool.
- The tool's statuses are `running`, `consent`, `installing`, `starting`, `declined`, `unanswered`, `unavailable`, `desktop-only`, `failed`, `crashed` and `stopped`. An aborted wait answers an error result.
- Roots are checked against the snapshot. `choose` accepts candidates only; the other actions accept candidates, apps and chosen roots.
- `logs` finds the log's end, then reads its last 64 KiB.
- The wait lasts as long as the card's own time while a card for that workspace and root is open, and 90 s since the last change otherwise.

**Task 12.**
- `llm-client.ts` imports `design-canvas/main.ts` and loads `follow-through-main` lazily, so `main/index.ts` connects the jobs (`connectDesignAppJobs`) and recovery (`designAppRecoveryDone`) instead of `design-canvas/main.ts` importing them.
- The toggle hook is a `designApp` dependency of `createRendererChatMutationHandlers`. The card's Enter path is `createDesignModeCardEnter` in `main/handlers/design-app.ts`, so both are tested by register and invoke.
- Workspace removal forgets the workspace's apps through `createDesignWorkspaceCleanup({ apps })`, which covers both `designCanvasWorkspaceCleanup` and `removeDesignCanvasWorkspace`. A failed stop still deletes the canvas.
- The `designApp:*` handlers are always registered and refuse each call while the flag is off; `consentAnswer` answers false.
- `findEnvKeys` receives only the variables that are set (pi-ai's `ProviderEnv`).
- The analytics core drops an unknown optional `manager` by itself and keeps the event, as it does for every optional property.

**Task 13.**
- The spec ran in the Cua Space. It was not run with Playwright on the host: the orchestrator allows window-opening tests only in the Space. The darwin `lsof` branch runs on the host headlessly in `app-server-process.test.ts` (13/13).
- The second-chat case runs with a 15 s grace, so switching chats can't outlast it.
- The stop cases assert both phase `stopped` and that the origin no longer answers.

**Review fixes (2026-11-24).** These change behaviour described above.
- **Provider keys.** `AWS_BEARER_TOKEN_BEDROCK` is scrubbed as a fixed extra, because pi-ai's env lookup doesn't name it.
- **Hidden characters.** The D5 escapes also cover every `\p{Default_Ignorable_Code_Point}` (U+034F, U+17B4 and the rest).
- **Forced install above the workspace.** A forced install (Aiden's own unfinished or stale install) with the lockfile in a parent folder answers `install-outside-workspace` instead of installing there.
- **No lockfile.** After a successful install, Aiden re-reads the surface. When the only change from the consented surface is one new lockfile in the install root (same manager, same everything else), the consent moves to the new fingerprint and keeps `installShown`, and the install record stores the post-install `lockHash`. So an app with no lockfile asks once and installs once.
- **Read-only access.** A workspace whose permission is `read-only` (or none) is treated as no access at start, at entering design mode, at the attempt's first read, at the pre-spawn re-read and while running. The tool refuses `start`, `restart` and `choose` on such a turn with `no-access`, before counting a start. The pre-spawn re-read has tests for a folder or access change while the card waits and during the install.
- **Logs run identity.** `DesignAppLogs` gains `run` (the job id) and `end`. `logs` takes `run`; when it doesn't match the current job, or `after` is past the end, the read starts at the oldest kept byte with `truncated: true`. `designApp:logs` accepts `run`. The tool probes the end, then reads the last 64 KiB of that run.
- **Consent wait.** The tool's wait while a card is open is the card's time plus 5 s (`DESIGN_APP_CONSENT_GRACE_MS`), so an ignored card answers `unanswered`, not `consent`.
- **Origins.** `onOriginsChanged` fires whenever the served-origin set changes: a socket added while running (such as `[::1]` after `127.0.0.1`), and `forgetWorkspace` dropping served origins.
- **Concurrent roots.** `designModeEntered` starts every chosen root at once.
- **Presence (replaces D12's `document.visibilityState`).** The renderer reports `visible` from the canvas pane alone (stacked layout: Canvas pane shown). Main decides the window part: `designCanvas:view` takes a `senderWindowShown` dependency that is true while the sender's `BrowserWindow` is visible and not minimized, and `DesignCanvasViews.windowChanged()` re-announces presence on `minimize`, `restore`, `hide` and `show`. An occluded window, which macOS may report as a hidden document, still counts as shown.
- **Escaped processes.** When a design job's root exits, `BackgroundJobs` sweeps processes whose environment carries its `AIDEN_BACKGROUND_JOB=<id>` marker (SIGTERM, the stop grace, then SIGKILL). After `reapPreviousLaunch`, the same sweep runs for record entries marked `design: true`. The marker is read from `/proc/*/environ` on Linux and `ps -E -A -ww` on macOS. macOS doesn't show the environment of Apple platform binaries (such as `sleep` or `sh`), so a leftover of that kind isn't found; the user's own `node` processes are.
- **Card.** Script wells show every line break as a muted ↵ and collapse 3 or more blank lines or 8 or more spaces into `[N blank lines]` or `[N spaces]` (`consentScriptParts`); a multi-line script's label gives its line count. No well scrolls on its own. The details sit in one keyboard-focusable region (`What Allow runs`) capped at 50vh (25vh when several cards show), with a **Scroll for more** cue, and the buttons stay outside it. Waiting cards are keyed by `requestId`, so every pending card shows, oldest first (`useDesignAppConsents`, `DesignAppConsentCards`). A new card leaves focus in a card the person is already in.
- **Fixtures.** The fake package manager writes `package-lock.json` on install when there is none. `server.mjs --fake-setsid-loopback-child` leaves a setsid loopback child for the crash sweep test.

**Left for the PR.**
- One full `npm run test`.
- The PR number in `docs/plans/README.md`.
- The light and dark card screenshots in the PR body. They are saved in the E2E test's output folder.
