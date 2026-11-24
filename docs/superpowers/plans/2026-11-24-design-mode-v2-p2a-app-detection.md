# Design mode v2 — Phase 2a: app detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give design mode a tested way to find a workspace's web app and the tools to run it, before anything runs.
- The device helpers stop putting an empty entry on PATH. That is a small safety fix, with its own commit, made before the lift.
- The Node and package-manager lookup that devices use moves into a shared `main/services/node-toolchain.ts`. Devices behave as they do after that fix.
- `detectWebApp(root)` finds the workspace's app candidates and classifies each as `web`, `react-nonweb` or `none`. For each it gives the framework, dev script, package manager, install root and install state.
- Lockfile and package-manager rules are pure functions, and so are the fixed install and run commands built from them.
- `resolveAppToolchain` turns a missing Node or package manager into a typed reason that 2b and 2c can show.

**Architecture:**
- **Shared toolchain.** `node-toolchain.ts` holds:
  - the generic resolver (PATH, then the login shell, then Homebrew), with an optional cache of validated paths;
  - the standalone-Node check;
  - the PATH and environment helpers.

  `devices/device-toolchain.ts` keeps every export it has today, as thin wrappers that pass the device's own settings (Node 22, `npm` and `node` only, no cache). Device callers don't change.
- **Pure core.** `main/services/design-canvas/app-server/app-server-core.ts` takes parsed inputs (a package.json object, lockfile names, a few existence flags) and returns the classification. It does no I/O.
- **Reader.** `app-detect.ts` reads the disk with bounded, no-follow reads and feeds the core. It is the only 2a file that touches the filesystem for detection. The spec put `detectWebApp` in `app-server-core.ts`; S23 records the move.
- **Toolchain join.** `app-toolchain.ts` combines a detected app with `node-toolchain.ts` and returns either the resolved binaries or a typed problem.

Nothing in the running app calls the new design modules in 2a. 2b is their first caller.

**Tech Stack:** TypeScript (ESM), Electron 43 main, `tsx --test` for unit tests. No renderer or E2E changes.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`:
- §4 (constraints), §5.2;
- §6.2.1 (detection), §6.2.2 (Node toolchain), §6.2.3 (the install rule; 2a uses it only for the command table);
- §6.8 (non-web React projects, missing Node);
- §7 (pure-core tests), §8 (row 2a), §10 (builder's choices), §11 item 3 (E2E fixture);
- §12 S2, S6, S8 and S14, which 2b builds on top of this.

Stacked on PR #908 (Phase 1b), which is stacked on PR #894 (Phase 1a).

## Scope

In scope:
- the device PATH fix: `deviceNodeEnvironment`, `androidSdkEnv` and `createNpmRunner` stop adding empty PATH entries (Task 1);
- lifting `resolveExecutable`, the login-shell lookup, the standalone-Node check and the environment helpers out of `device-toolchain.ts` into `node-toolchain.ts`. They're generalised to a fixed set of commands (`node`, `npm`, `pnpm`, `yarn`, `bun`), and devices don't change;
- an optional cache of validated login-shell answers, which only design callers use (§6.2.2 "with a cache");
- `detectWebApp(root)`: candidates at the root, in the spec's fixed folders and in declared workspace patterns, each classified (§6.2.1);
- package-manager and lockfile detection, covering:
  - conflicting lockfiles and the `packageManager` field;
  - `pnpm-workspace.yaml` as a pnpm signal, and Deno markers;
  - workspace members;
  - a workspace folder that sits inside a larger repo;
- the fixed install and run-script argv for each manager (§6.2.3 "Install", S2 "the resolved command");
- `designTarget(detection)`: what design mode should do with a detection (start one app, ask which, offer mocks, or nothing);
- `resolveAppToolchain(app)`: Node and the package manager resolved, or a typed reason with a short message;
- the spec amendments recording 2a's decisions, the memory files and the plan index.

Out of scope:
- starting, stopping or installing anything: `DesignAppServers`, `backgroundJobs` changes, the `design` job owner, consent and the install stamp (2b: S2, S7, S8);
- the dev-server command environment: `agentShellCommandEnvironment()`, `BROWSER=none`, `FORCE_COLOR=0`, `PORT`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and the loopback host flags (S14). §8 lists §6.2.2 under 2a, but these are launch facts with no caller until 2b, so they land there with the process (S19). 2a settles the signatures 2b needs (`nodeCommandEnvironment(env, binDirs)`, `runScriptCommand(info, script, extraArgs)`) so 2b doesn't change them;
- `.aiden/canvas.json`: reading `apps`, `mock`, a project naming itself `react-nonweb`, and saving the monorepo choice (3b for the file, 2b for the saved choice);
- the monorepo question card, the status chip and any message shown to the person (2b, 2c);
- route discovery (3b), mock apps and the scaffold questions (3d);
- a corepack fallback for a missing `pnpm` or `yarn` (settled: none);
- running Deno projects (reported as `unsupported-manager`);
- Windows. Design live needs `backgroundJobs`, which `hostPlatformCapabilities()` gives only on darwin and linux. 2a makes no platform claim and changes nothing in `host-platform-capabilities.ts`;
- analytics. `design_app_started` belongs to 2b (§6.10).

**Feature flag.** 2a ships without `AIDEN_EXPERIMENTAL_DESIGN_LIVE`. It has no user-facing surface: no IPC channel, no tool, no UI and no new process. The flag starts in 2b (S6), the first phase that calls these modules. The device fix and lift aren't design work; they stay under the devices' own flag, as today.

## What exists today (checked against the code at `e88271d63`)

| Item | Today | 2a action |
|---|---|---|
| `resolveExecutable(command: "npm" \| "node", deps)` (`device-toolchain.ts:197`) | PATH entries (absolute only), then the `$SHELL -ilc` output (last absolute line, checked with `isExecutable`), then `/opt/homebrew/bin` and `/usr/local/bin`. Not exported. | Moves to `node-toolchain.ts`, exported, with a wider command union and an optional `cache` dependency (Task 2). |
| `NpmResolutionDeps` (`:185`) | `{ env, isExecutable(path), loginShellLookup(shell) }`. The lookup has its command baked in. | Becomes an alias of `ExecutableResolutionDeps`, whose lookup takes `(shell, command)`. A one-argument function still fits the type, so device code and tests compile unchanged. |
| `resolveNpm` (`:193`), `defaultNpmResolutionDeps` (`:219`) | npm: a plain `X_OK` check. The lookup runs `command -v npm` with `env: process.env`, a 5 s timeout and the default `maxBuffer`. Used by `main/handlers/devices.ts:53` and `scripts/devices-acceptance.mjs:56`. | Stay in `device-toolchain.ts` as wrappers, with the same argv, timeout, env and buffer. A guard test pins the argv before the lift. |
| `resolveDeviceNode` (`:284`), `defaultDeviceNodeResolutionDeps` (`:322`) | Node is checked with the `isDeviceNodeExecutable` probe. The lookup runs `command -v node` with the given env and `maxBuffer: 16384`. No cache. Used by `local-device-host.ts:850`. | Wrappers over `resolveExecutable` and `isStandaloneNodeExecutable(…, { minMajor: 22 })`. A guard test pins the argv and buffer. |
| `isDeviceNodeExecutable` (`:295`) | Rejects the app binary by realpath and inode, then runs `-p` and wants `electron === false` and major ≥ 22. It probes with `deviceNodeEnvironment`. Defaults: `process.execPath`, `!!process.versions.electron`. | Wrapper over `isStandaloneNodeExecutable` with `minMajor: 22`, keeping both defaults. |
| `deviceNodeEnvironment` (`:288`) | PATH = `[dirname(node), env.PATH ?? ""].join(path.delimiter)`, then deletes `ELECTRON_RUN_AS_NODE`. With PATH unset or `""` it leaves a trailing `:`, and it keeps any empty entry in the inherited PATH. An empty entry puts the working folder on PATH. Used by `local-device-host.ts` (`:315`, `:358`, `:363`) and `device-tool-maintenance.ts:168`. | **Task 1 fixes it:** no empty entries, by the rule `nodeCommandEnvironment` uses. Task 2 makes it a wrapper over `nodeCommandEnvironment(env, [dirname(node)])`. |
| `androidSdkEnv` (`local-device-host.ts:264`, PATH built at `:274`) | Joins the SDK folders with `env.PATH ?? ""`, which gives the same trailing `:`. No direct test; `local-device-host.test.ts:769` and `:800` test the SDK lookup around it. | Task 1 fixes it, with a new test next to `:800`. |
| `createNpmRunner` (`device-toolchain.ts:243`) | `[dirname(npm), env.PATH].filter(Boolean)` drops a missing PATH, but keeps empty entries inside the inherited PATH. | Task 1 uses the same helper here (see Review amendments, B-M1 note). |
| `NODE_REQUIRED_REASON`, `DeviceNodeUnavailableError`, tool specs and installs | Device-only. | No change. |
| Device tests | `device-toolchain.test.ts` covers npm and Node resolution order, app-binary rejection, old runtimes and the environment (`:294-301`). It is in `test:devices` and the `runtime-subagents` registry lane. | Task 1 extends `:294-301` with three PATH cases. After that, the lift's oracle is the existing device tests unedited, plus Task 1's cases and Task 2's two argv guards. |
| `packages/cli` | Bundles no `devices/` or `design-canvas/` module (`grep` over `packages/cli/src` finds neither). | `npm run cli:build` is a guard only. |
| Lockfile or framework detection | None in `main/` or `renderer/`. Only CI scripts mention lockfiles. | New. |
| `tests/fixtures/design-live-app/` (§7, §11 item 3) | Doesn't exist yet; 3a adds it. | 2a's tests build their own trees in temp folders. One case copies the fixture's shape (Vite + React, `node_modules` as a symlink). |
| `yaml` | Runtime dependency, `2.9.0`. | Used to read `pnpm-workspace.yaml`. |

## Review amendments (2026-11-24)

Two adversarial reviews (A: detection rules; B: lift safety and tests) were accepted in full. The decision file named minor findings without ids, so this table numbers them B-m1… and A-m1… in the order given.

| Id | Decision | Where the plan handles it |
|---|---|---|
| B-M1 | Device PATH fix first, own commit; fix `androidSdkEnv`; three cases in `device-toolchain.test.ts:294-301` and one in `local-device-host.test.ts`; drop `probeEnv`; new lift oracle | Task 1; "What exists today"; Interfaces (no `probeEnv`); Task 2 Step 4; Risk 1; S24. Also applied to `createNpmRunner`, which keeps empty entries from the inherited PATH (same file, same rule). |
| B-M2 | Explicit lookup limits: `timeoutMs` defaults to 5000, `maxBuffer` only when defined; > 1 MiB test; real `defaultNpmResolutionDeps` argv test | Interfaces (`loginShellCommandLookup`); Task 2 Step 1 (both tests, plus the same guard for the Node lookup) |
| B-M3 | Cache only validated paths, inside `resolveExecutable` through a `cache` dependency; drop stale entries | R9; Interfaces (`ExecutableCache`); Task 2 Step 1 tests; Risk 4 |
| B-M4 | `lockfileLevelsUp: number` | R8 type; R6; Task 5 enclosing test |
| B-M5 | `runScriptCommand(info, script, extraArgs?)` with per-manager `--`; `nodeCommandEnvironment(env, binDirs[])` | R10; Interfaces; Task 2 and Task 4 tests |
| B-m1 | Line references fixed against HEAD | "What exists today" (checked at `e88271d63`) |
| B-m2 | `isStandaloneNodeExecutable` keeps the defaults `process.execPath` and `!!process.versions.electron` | Interfaces |
| B-m3 | S-amendments for the `detectWebApp` move and the PATH fix | Task 7 (S23, S24) |
| B-m4 | Docs: `.memory/devices-ssh-hosts-toolchain.md:59`; wider docs search | Task 7 Steps 3–4 |
| B-m5 | Tests: a dangling `node_modules` symlink, and a symlinked `node_modules` at the enclosing root | Task 5 Step 1 |
| B-m6 | Drop the framework-table loop test | Task 3 (removed) |
| A-M1 | Dev-script choice prefers the framework's dev command and skips builds, production runs and workspace runners | R3; Task 3 tests; Risk 10 settled |
| A-M2 | Angular, Nuxt, `@tanstack/start`, `remix@3`; reason `unknown-framework` | R2; R4 rule 8; Task 3; S22 |
| A-M3 | Tauri is desktop, like Electron | R4 rules 2–3, reason `desktop` plus `desktopShell`; Task 3 |
| A-M4 | Node 22 for design, the same as devices | R9; message text; Q2 settled; the old S22 (Node 20) dropped |
| A-M5 | The field wins only with no lockfile or its own; `pnpm-workspace.yaml` means pnpm; Deno gives `unsupported-manager` | R5; R6; R9; Task 4 tests; S20 |
| A-M6 | `O_NOFOLLOW \| O_NONBLOCK`, `fstat().isFile()`, cap+1 reads; `lstat` containers and pattern parents; drop absolute and `..` patterns; FIFO and `packages → /` tests | Global Constraints ("Bounded reads"); R1; Task 5 |
| A-m1 | No upward walk when the workspace root holds `.git`; compare `stopAt` and home after `realpath` | R6; Task 5 tests |
| A-m2 | A conflict with exactly one manager's `node_modules` marker picks it (`source: "installed"`) and still lists the conflict | R5 step 5; Task 4 and Task 5 tests; Q3 settled |
| A-m3 | npm is resolved first from `dirname(resolvedNode)` | R9 step 3; Task 6 test |
| A-m4 | Yarn flavour: the field's major, else `.yarnrc.yml`, `.pnp.cjs` or a non-v1 `yarn.lock` | R5 "Yarn flavour"; Task 4 and Task 5 tests |
| A-m5 | No corepack fallback; S19 says 2b always sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` | Scope; Task 7 (S19); Q1 settled |
| A-m6 | Q5 agreed, with `binDirs` | Scope; Interfaces; Q5 settled |
| A-m7 | `@react-router/dev` before `@remix-run/dev` | R2 order; Task 3 test |
| A-m8 | Edge tests: no `scripts`, array `scripts`, `dev: 42` and `dev: null`, a Storybook-only repo, an Nx integrated repo with no member `package.json`; none may give a misleading "add a dev script" | R4 (`no-dev-script` narrowed, `workspace-runner`); Task 3 and Task 5 tests |

## Global Constraints

- **Device behaviour.** After Task 1, devices behave exactly as before, except that they never put an empty entry on PATH. Every export of `device-toolchain.ts` keeps its name and signature. The existing tests in `device-toolchain.test.ts`, `local-device-host.test.ts`, `android-device-features.test.ts` and `renderer/components/settings/simulator-settings.test.tsx` pass without edits. Only Task 1's new cases and Task 2's guards are added. If an existing test needs an edit, the change is wrong.
- **Fixed commands only.** `resolveExecutable` and the login-shell lookup accept only the `ToolCommand` union. The lookup also checks at runtime, so a string from a package.json can never reach `command -v`.
- **Pure core.** `app-server-core.ts` imports nothing from `node:fs`, `node:child_process` or Electron.
- **Bounded reads** (A-M6). Every file `detectWebApp` reads (`package.json`, `pnpm-workspace.yaml`, the head of `yarn.lock`) goes through one `readBounded(path, cap)`:
  - it opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`;
  - it checks `fstat().isFile()`;
  - it reads at most `cap + 1` bytes, and over the cap counts as unreadable;
  - a symlink, FIFO, socket, device or folder is unreadable, never followed or waited on.

  Caps:
  - 512 KiB per `package.json`, 64 KiB for `pnpm-workspace.yaml`, 512 bytes of `yarn.lock`;
  - 200 entries per scanned folder;
  - 100 candidates in total (then `truncated: true`).

  Containers (`apps/`, `packages/`) and every parent folder of a workspace pattern are checked with `lstat` and skipped when they're a symlink or not a folder. Candidate folders that are symlinks are skipped. `node_modules` and dot folders are never entered. Existence checks for lockfiles and markers use `lstat` and never read. Nothing throws for a bad file: a bad candidate gets a reason.
- **Relative output.** Every path in a detection is POSIX and relative to the workspace root (`.` for the root). Absolute paths stay inside main and never go into a result. Enclosing folders show up only as `lockfileLevelsUp`.
- **Script names.** A script name is used only when its value is a string, it is at most 100 characters, it has no control characters, and it doesn't start with `-`. So a script name can never be read as a manager option. Extra run arguments must have no control characters.
- **AGENTS.md:**
  - no source-grep tests;
  - each new test file goes in `scripts/ci-test-registry.json` and a `package.json` script, then `npm run test:ci-policy` runs;
  - docs change in this PR;
  - platform claims match `host-platform-capabilities.ts` (2a makes none).
- **Each task stands alone.** Every task ends with its own tests, `npx tsc --noEmit -p .` and `npm run test:ci-policy` passing, and one commit.
- **Tests.** Detection tests use real temp folders and call the real functions. Toolchain tests use injected `isExecutable` and lookup fakes, plus temp-folder executables and shells where the real behaviour matters. A test that can't fail before its task's change is marked **(guard)**.

## Detection rules

**R1. Candidates** (§6.2.1, §10). `detectWebApp(root)` looks at:
1. the root itself;
2. each folder directly inside `apps/` and `packages/`, and the folders `web/`, `frontend/` and `site/` (the spec's fixed list);
3. the root's declared workspace patterns: `workspaces` in `package.json` (an array, or `{ packages: [...] }`) and `packages:` in `pnpm-workspace.yaml`.

A folder is a candidate when it has a `package.json`. Supported pattern forms:
- `a`, `a/b`, `a/b/c` (exact);
- `a/*`, `a/b/*` (one level);
- `a/*-app` (a `*` inside the last segment);
- a leading `./` is stripped, and `**` counts as `*`, so `packages/**` searches one level, per §6.2.1 and §10;
- `!pattern` removes matches.

Patterns that are absolute or contain a `..` segment are dropped. Other forms (braces, deeper wildcards, more than three segments) are ignored. Every parent folder of a pattern is checked with `lstat`, so a symlinked `packages/` pointing at `/` is never listed. Candidates are deduplicated and sorted: root first, then by path.

**R2. Framework** (§6.2.1; widened by S22). Read from `dependencies` and `devDependencies`, never `peerDependencies`. The first match in this order wins. Later entries also appear inside earlier frameworks' apps: Remix, React Router, TanStack Start and SvelteKit apps all list `vite`, and migrated React Router apps may still list `@remix-run/dev`.

| Dependency | `framework` | Label | Default port | Dev commands (R3) |
|---|---|---|---|---|
| `next` | `next` | Next.js | 3000 | `next dev` |
| `@react-router/dev` | `react-router` | React Router | 5173 | `react-router dev` |
| `@remix-run/dev` | `remix` | Remix | 5173 | `remix vite:dev`, `remix dev` |
| `remix` at major 3 or later | `remix-3` | Remix | 44100 | `node --watch` |
| `@tanstack/react-start` | `tanstack-start` | TanStack Start | 3000 | `vite`, `vinxi dev` |
| `@tanstack/start` | `tanstack-start` | TanStack Start | 3000 | `vinxi dev`, `vite` |
| `nuxt` | `nuxt` | Nuxt | 3000 | `nuxt dev`, `nuxi dev` |
| `@angular/build`, `@angular-devkit/build-angular` | `angular` | Angular | 4200 | `ng serve` |
| `astro` | `astro` | Astro | 4321 | `astro dev` |
| `gatsby` | `gatsby` | Gatsby | 8000 | `gatsby develop` |
| `react-scripts` | `create-react-app` | Create React App | 3000 | `react-scripts start` |
| `@tanstack/router-plugin` | `tanstack-router` | Vite | 5173 | `vite` |
| `vite` | `vite` | Vite | 5173 | `vite` |

Notes:
- "React Router v7 framework mode" in the spec is read as `@react-router/dev`. A plain `react-router` dependency is library mode inside some other framework, usually Vite, and matches that framework instead.
- The `remix` package's major version comes from its range (`^3`, `3.x`, `~3.0.0`, `>=3`). Below 3 it is the old v1 meta package and is ignored. Task 3 checked `remix@3.3.0` (npm `latest`): the starter in `@remix-run/cli` runs `NODE_ENV=development node --watch --import remix/node-tsx server.ts`, and `server.ts` listens on `PORT` or 44100.
- `vite` as a dev command means the word `vite` (also `npx vite`, `vite dev`, `vite serve`) not followed by `build`, `preview` or `optimize`.
- The label and default port feed 2c's chip ("Vite · :5173") and its port suggestion. Task 3 checks each port against the framework's current docs and corrects the table if one is wrong.
- Non-React frameworks (Angular, Nuxt, Remix 3, and Vue or Svelte apps through `vite`) run as live frames. Source mapping and component cards stay React-only (§3 non-goals).

**R3. Dev script** (A-M1). Look only at `dev`, `start` and `serve`, in that order, and only at string values with safe names.
1. **Prefer** the first whose text contains one of the framework's dev commands (R2). So `"dev": "next dev || next start"` and `"dev": "tsc -w & vite"` are picked.
2. **Otherwise** take the first that isn't skipped. A script is skipped when its text contains:
   - a build: `vite build`, `next build` (without `next dev`), `tsc`, `tsup`, `rollup`;
   - a production run: `next start`, `vite preview`, `astro preview`, `gatsby serve`, `remix-serve`, `react-router-serve`, `NODE_ENV=production`, `serve -s`;
   - Storybook: `storybook`;
   - a workspace runner: `turbo`, `nx ` (word, then a space), `lerna`, `pnpm -r`, `pnpm --recursive`, `--filter`, `--workspaces`, `yarn workspaces`.
3. **Otherwise** there's no script.

The check is word-based, so the tokens match only as words: `tsc` doesn't match `tscx`. The scan also records whether a dev/start/serve script existed at all and whether one was skipped as a workspace runner, for R4. The list of safe script names (at most 50) is returned too, for 2b's `choose`.

**R4. Kind** (§6.2.1, §6.8, decision 9; widened by S21). For each candidate, in order:

| # | Condition | `kind` | `reason` |
|---|---|---|---|
| 1 | `package.json` unreadable, over the cap, not a regular file, or not a JSON object | `none` | `invalid-package-json` |
| 2 | a desktop shell in deps (`electron`, `@tauri-apps/api`, `@tauri-apps/cli`) and React (`react` or `react-dom`) | `react-nonweb` | `desktop` |
| 3 | a desktop shell, no React | `none` | `desktop` |
| 4 | a framework (R2) and a dev script (R3) | `web` | `ok` |
| 5 | a dev/start/serve script was skipped as a workspace runner, or the folder holds `nx.json`, `turbo.json` or `lerna.json` | `none` | `workspace-runner` |
| 6 | `react-native` or `expo` in deps | `react-nonweb` | `react-native` |
| 7 | a framework, no dev/start/serve string script at all, and no Storybook (`storybook` or any `@storybook/` dependency) | `none` | `no-dev-script` |
| 8 | a usable (not skipped) dev/start/serve script, and no framework matched | `none` | `unknown-framework` |
| 9 | React in deps | `react-nonweb` | `no-web-framework` |
| 10 | anything else | `none` | `no-web-framework` |

Notes:
- `desktop` apps also carry `desktopShell: "electron" | "tauri"`, so 3d's question can name the shell (§6.8). Rule 2 before rule 4 is the spec's "no `electron` dependency", extended to Tauri (A-M3). An Electron + Vite + React app, such as Aiden itself, is `react-nonweb`.
- `no-dev-script` means exactly "this is a framework app with nothing to run", so "add a dev script" is the right advice. A Storybook-only repo, or a library whose `dev` is `vite build --watch`, falls through to rule 9 (React mocks) or rule 10 instead.
- `workspace-runner` covers a turbo or Nx root and an Nx integrated repo whose apps have no `package.json`. Its members, when they have one, are found as their own candidates. 2c and 3d say "this repo runs its apps through a workspace tool", and never offer to scaffold.
- `unknown-framework` is an app with a runnable script that design mode doesn't recognise, such as a custom webpack server. 3d must not scaffold for it (A-M2). 2b can still offer it later through `choose`; that's 2b's call.
- Rule 6 is the spec's "uses React but can't run as a web page by itself". A React Native package that also lists `vite` and a dev command runs on the web and is caught by rule 4.
- A `scripts` value that is missing, an array, or not an object counts as no scripts. A script whose value isn't a string (`42`, `null`) counts as missing.
- `.aiden/canvas.json` can later mark a project `react-nonweb` (§6.2.1). That override is 3b's.

**R5. Package manager and lockfiles** (A-M5, A-m2, A-m4; S20). Signals, per folder:

| File | Manager |
|---|---|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lock`, `bun.lockb` | bun |
| `package-lock.json`, `npm-shrinkwrap.json` | npm |

Two files of the same manager (`bun.lock` with `bun.lockb`, `package-lock.json` with `npm-shrinkwrap.json`) are not a conflict. The manager is decided at the candidate's install root (R6). Let L be the set of managers with a lockfile there, and F the manager named by the `packageManager` field (`"pnpm@9.15.0+sha512…"`; only `npm`, `pnpm`, `yarn` or `bun` count).
1. **F set, and L empty or `{F}`:** F, `source: "packageManager"`.
2. **F set, and L holds another manager:** `name: null`, `conflict` = L ∪ {F}, sorted.
3. **No F, one manager in L:** that manager, `source: "lockfile"`.
4. **No F, several managers in L:** `name: null`, `conflict` = L, sorted.
5. **Conflict tie-break:** when `node_modules` at the install root holds markers of exactly one manager in the conflict, pick it with `source: "installed"`, and keep `conflict`. The markers are `.package-lock.json` (npm), `.modules.yaml` (pnpm), `.yarn-integrity` or `.yarn-state.yml` (yarn). A `null` name otherwise; 2b refuses to install or start that app, with a message saying how to fix it. Guessing could rewrite the wrong lockfile.
6. **No F, L empty, `pnpm-workspace.yaml` present:** pnpm, `source: "workspace-file"`.
7. **No F, L empty, `deno.lock`, `deno.json` or `deno.jsonc` present:** `name: null`, `unsupported: "deno"`.
8. **Nothing at the install root:** the enclosing walk (R6). If it finds nothing either, npm with `source: "none"`; install is `npm install`, not `npm ci` (§6.2.3).

**Yarn flavour.** The field's major version decides when the field names yarn (1 is `classic`, 2 or more `berry`). Otherwise it's `berry` when the folder holding the yarn signal has `.yarnrc.yml` or `.pnp.cjs`, or the first 512 bytes of its `yarn.lock` contain `__metadata:`. Anything else is `classic`, including an empty `yarn.lock`.

**R6. Install root, workspaces and enclosing repos.**
- **Own signals:** a candidate with its own lockfile (or `pnpm-workspace.yaml`) is its own install root, even inside a declared workspace. This covers a standalone `frontend/` in a Python repo, and pnpm's `shared-workspace-lockfile=false`.
- **Workspace member:** a candidate without its own lockfile that matches a root workspace pattern (R1, step 3) has `installRoot: "."`. Its manager comes from the root's signals and `packageManager` field; the candidate's own field wins when it has one.
- **Fixed-folder candidate:** a candidate found only through the fixed list, with no lockfile and no matching pattern, is its own install root.
- **Workspace inside a bigger repo:** a workspace opened at `apps/web` of a pnpm monorepo has no lockfile of its own. Installing with `npm install` there would write a `package-lock.json` and a second `node_modules` into the person's repo. So `detectWebApp` walks upward when all of these hold:
  - the root has no lockfile;
  - the root has no `packageManager` field, `pnpm-workspace.yaml` or Deno marker;
  - the root has no `.git` (A-m1).

  The walk:
  - checks each parent folder for the R5 lockfile names, `pnpm-workspace.yaml`, the yarn-flavour markers and `node_modules`;
  - stops at the first folder with a lockfile or `pnpm-workspace.yaml`, and after checking a folder that holds `.git` (file or folder);
  - never reads the home folder, `stopAt`, anything above them, or past 5 levels. Both `stopAt` and home are compared after `realpath`;
  - a signal found there decides the manager by R5, with `source: "enclosing"` (or `"installed"` after a tie-break) and `lockfileLevelsUp` set to how many folders up it was. `installRoot` stays the candidate's own path, because every manager finds its workspace root from a member folder.

  The walk reads only names and the 512-byte `yarn.lock` head, never returns the enclosing path, and never runs Deno checks. Tests pass `stopAt` to keep it inside the temp folder.

**R7. Install state.** `installed` is true when `node_modules` at the install root `stat`s as a folder, or `.pnp.cjs` exists there (Yarn PnP). For an enclosing signal, `node_modules` at that enclosing folder counts too, since npm and yarn hoist there. `stat` follows symlinks: 3a's E2E fixture symlinks its `node_modules` to the repo root's (§7). A dangling symlink is `installed: false`, not an error. This is a hint only: 2b's install stamp (S8) decides whether to reinstall.

**R8. What a detection returns.**

```ts
type AppKind = "web" | "react-nonweb" | "none";
type AppReason = "ok" | "desktop" | "workspace-runner" | "react-native" | "no-dev-script"
  | "unknown-framework" | "no-web-framework" | "invalid-package-json";
type FrameworkId = "next" | "react-router" | "remix" | "remix-3" | "tanstack-start" | "nuxt" | "angular"
  | "astro" | "gatsby" | "create-react-app" | "tanstack-router" | "vite";
type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

interface PackageManagerInfo {
  name: PackageManagerName | null;          // null on an unresolved conflict or an unsupported manager
  source: "packageManager" | "lockfile" | "installed" | "workspace-file" | "enclosing" | "none";
  lockfile?: string;                        // the file R5 chose, e.g. "pnpm-lock.yaml"
  lockfileLevelsUp: number;                 // 0 inside the workspace; ≥ 1 for an enclosing signal
  conflict?: PackageManagerName[];          // R5 steps 2, 4 (kept after a step-5 tie-break)
  field?: PackageManagerName;               // the packageManager field's manager, on a step-2 conflict (added in Task 6)
  unsupported?: "deno";                     // R5 step 7
  yarn?: "classic" | "berry";
}

interface DetectedApp {
  root: string;                              // "." or "apps/web"
  name?: string;                             // package name, ≤ 214 chars, control characters stripped
  kind: AppKind;
  reason: AppReason;
  desktopShell?: "electron" | "tauri";
  framework?: FrameworkId;
  script?: string;                           // R3
  scripts: string[];                         // safe script names, ≤ 50
  usesReact: boolean;
  packageManager: PackageManagerInfo;
  installRoot: string;                       // R6
  installed: boolean;                        // R7
}

interface WebAppDetection { apps: DetectedApp[]; truncated: boolean }
```

`designTarget(detection)` sums it up for 2b:

| Detection | `designTarget` | What 2b does (for reviewers; not built here) |
|---|---|---|
| exactly one `web` app | `{ kind: "single", app }` | Turning design mode on starts it (after S2 consent). |
| two or more `web` apps | `{ kind: "choose", apps }` (only the `web` ones) | Nothing starts. Aiden asks which apps, and the chip shows **Choose apps…** (§6.2.1). |
| no `web`, one or more `react-nonweb` | `{ kind: "react-nonweb", apps }` | Nothing starts. 3d's mock-app question. |
| no `web`, no `react-nonweb` | `{ kind: "none", apps }` (all candidates, so `no-dev-script`, `workspace-runner` and `unknown-framework` stay visible) | Nothing starts. 3d's scaffold question only when no candidate has `workspace-runner` or `unknown-framework`; otherwise a hint from the reason. |
| no `package.json` anywhere | `{ kind: "none", apps: [] }` | As above. |

A `react-nonweb` package next to a `web` app (for example `packages/ui` beside `apps/web`) doesn't change the target. A web app whose manager is `null` is still `web`. Refusing it is 2b's job, so the person sees why.

**R9. Missing Node or package manager** (§6.8, §4, A-M4, A-m3). `resolveAppToolchain(app, deps)`:
1. **Node first:** `resolveExecutable("node")` with `isStandaloneNodeExecutable(…, { minMajor: 22 })`, the same floor as devices. None found: `{ ok: false, problem: "node-missing" }`. Node is needed even with pnpm's standalone build or bun, because the frameworks' own CLIs run on Node.
2. **No manager name:**
   - `unsupported`: `{ ok: false, problem: "unsupported-manager", manager: "deno" }`;
   - a conflict: `{ ok: false, problem: "manager-conflict", conflict }`.
3. **The manager:**
   - npm is looked for first at `dirname(node)/npm`, then through `resolveExecutable("npm")`;
   - other managers go through `resolveExecutable(name)` with a plain executable check.

   None found: `{ ok: false, problem: "manager-missing", manager }`. There's no fallback to npm for a pnpm, yarn or bun project, because that would write a second lockfile, and no corepack fallback (S19).
4. Otherwise `{ ok: true, node, manager: { name, path } }`.

`toolchainProblemMessage(problem)` gives one fixed sentence per problem, for 2b's tool answers and 2c's chip:
- `node-missing`: "Node.js 22 or newer wasn't found. Install it from nodejs.org or Homebrew, then try again."
- `manager-missing`: "This app uses pnpm, which wasn't found. Install pnpm, then try again." (the manager's name filled in)
- `manager-conflict`: "This app has lockfiles for npm and yarn. Delete the one you don't use, or set packageManager in package.json." (the names filled in; a field-and-lockfile conflict says "packageManager says pnpm, but the lockfile is npm's.")
- `unsupported-manager`: "This app uses Deno, which design mode can't run yet."

The design callers pass a shared `ExecutableCache` to `resolveExecutable` (B-M3):
- it keeps only a login-shell answer that is absolute and passed `isExecutable`;
- before using a kept path, `resolveExecutable` checks it again and drops it when the check fails;
- junk output and misses are never kept, so installing Node and pressing Retry works without a restart (§6.8 "offers Retry").

**R10. Commands** (§6.2.3, S2, B-M5). Pure argv builders. The caller chooses the cwd.

| Manager | `installCommand` with a lockfile | without | `runScriptCommand(info, script, extraArgs)` |
|---|---|---|---|
| npm | `npm ci` | `npm install` | `npm run <script>`, plus `-- <extra…>` when there are extra args |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm install` | `pnpm run <script> <extra…>` |
| yarn classic | `yarn install --frozen-lockfile` | `yarn install` | `yarn run <script> <extra…>` |
| yarn berry | `yarn install --immutable` | `yarn install` | `yarn run <script> <extra…>` |
| bun | `bun install --frozen-lockfile` | `bun install` | `bun run <script> <extra…>` |

Rules:
- "With a lockfile" means the R5 lockfile, including an enclosing one, since the manager runs from the member folder and finds it. `workspace-file` without a lockfile is "without".
- Only npm needs `--` to pass arguments to the script. Task 4 ran each manager against a script printing its argv: npm 10.9.9 needs `--`; pnpm 12.15.0 and Yarn 4.19.0 pass a bare `--` through to the script; Yarn 1.22.22 and bun 1.3.11 forward arguments with or without it.
- Both builders throw for a `null` manager, an unsafe script name, or an extra argument with a control character.
- 2b runs the result through `backgroundJobs` with the resolved binary path in place of the bare name.

## Interfaces

`main/services/node-toolchain.ts`:
- `type ToolCommand = "node" | "npm" | "pnpm" | "yarn" | "bun"`; `isToolCommand(value): value is ToolCommand`.
- `interface ExecutableCache { get(key: string): string | undefined; set(key: string, path: string): void; delete(key: string): void }`; `createExecutableCache(): ExecutableCache & { clear(): void }`. The key is the shell and command.
- `interface ExecutableResolutionDeps { env: NodeJS.ProcessEnv; isExecutable(path: string): Promise<boolean>; loginShellLookup(shell: string, command: ToolCommand): Promise<string | null>; cache?: ExecutableCache }`.
- `resolveExecutable(command: ToolCommand, deps): Promise<string | null>`:
  1. PATH, unchanged.
  2. The cached login-shell path, if `cache` is set and the path still passes `isExecutable`; a path that fails is deleted.
  3. The lookup, called with the command. The last absolute line that passes `isExecutable` is returned, and stored in `cache` if set.
  4. Homebrew.

  Without `cache`, it behaves exactly as the old function.
- `loginShellCommandLookup(options: { env: NodeJS.ProcessEnv; timeoutMs?: number /* default 5000 */; maxBuffer?: number /* passed to execFile only when defined */ }): (shell, command) => Promise<string | null>`. It runs `execFile(shell, ["-ilc", `command -v ${command}`], { timeout, encoding: "utf8", env, ...(maxBuffer === undefined ? {} : { maxBuffer }) })`. It refuses any command outside `ToolCommand` before spawning.
- `isExecutableFile(path): Promise<boolean>` (`X_OK`).
- `isStandaloneNodeExecutable(candidate, env, options: { minMajor: number; appExecutable?: string /* default process.execPath */; isElectron?: boolean /* default !!process.versions.electron */ }): Promise<boolean>`. This is the body of `isDeviceNodeExecutable`, with the major version as a parameter. Its probe runs with `nodeCommandEnvironment(env, [dirname(candidate)])`.
- `prependPathEntries(dirs: string[], pathValue: string | undefined): string`: `dirs` then the inherited entries, every empty entry dropped, joined with `path.delimiter`. (Task 1 adds it to `device-toolchain.ts`; Task 2 moves it here.)
- `nodeCommandEnvironment(env, binDirs: string[]): NodeJS.ProcessEnv`: a copy with `PATH = prependPathEntries(binDirs, env.PATH)` and `ELECTRON_RUN_AS_NODE` deleted.

`main/services/devices/device-toolchain.ts` keeps:
- `NpmResolutionDeps`, now `= ExecutableResolutionDeps`;
- `resolveNpm`, `defaultNpmResolutionDeps`, `resolveDeviceNode`, `defaultDeviceNodeResolutionDeps`;
- `isDeviceNodeExecutable(candidate, env, appExecutable = process.execPath, isElectron = !!process.versions.electron)`;
- `deviceNodeEnvironment(env, nodePath)` = `nodeCommandEnvironment(env, [dirname(nodePath)])`;
- `createNpmRunner`.

It also re-exports `prependPathEntries` for `local-device-host.ts`.

`main/services/design-canvas/app-server/app-server-core.ts` (pure):
- the types in R8, and `FRAMEWORKS` (R2 table, with dev-command matchers);
- `parsePackageJson(text: string): PackageJson | null`, with a leading BOM stripped;
- `detectFramework(pkg)`, `pickDevScript(pkg, framework?)` → `{ script?, hadDevScript, skippedRunner }`, `safeScriptNames(pkg)`, `isSafeScriptName(name)`;
- `classifyPackage(pkg | null, markers: { workspaceRunnerFile: boolean })` → `{ kind, reason, desktopShell?, framework?, script?, usesReact }`;
- `parsePackageManagerField(value: unknown)` → `{ name, major? } | null`;
- `lockfileManagers(fileNames: string[])` → `Map<PackageManagerName, string>`;
- `installedMarkerManagers(fileNames: string[])` → `Set<PackageManagerName>`;
- `decidePackageManager({ field, lockfiles, installedMarkers, pnpmWorkspaceFile, denoMarker, yarnFlavourHints, levelsUp, enclosing })` → `PackageManagerInfo` (R5);
- `workspacePatterns(rootPkg, pnpmWorkspaceYaml: unknown)` → `{ include: string[]; exclude: string[] }` (absolute and `..` patterns dropped), and `matchesWorkspacePattern(relPath, pattern)` (R1);
- `designTarget(detection)` (R8);
- `installCommand(info)`, `runScriptCommand(info, script, extraArgs?: string[])` → `{ command: PackageManagerName; args: string[] }` (R10).

`main/services/design-canvas/app-server/app-detect.ts`:
- `readBounded(filePath, cap, options?: { head?: boolean }): Promise<string | null>` (Global Constraints; `head` returns the first `cap` bytes of a longer file, for the `yarn.lock` head);
- `detectWebApp(root: string, options?: { stopAt?: string; homeDir?: string }): Promise<WebAppDetection>`.

`main/services/design-canvas/app-server/app-toolchain.ts`:
- `type ToolchainProblem = { problem: "node-missing" } | { problem: "manager-missing"; manager: PackageManagerName } | { problem: "manager-conflict"; conflict: PackageManagerName[]; field?: PackageManagerName } | { problem: "unsupported-manager"; manager: "deno" }`;
- `resolveAppToolchain(app: Pick<DetectedApp, "packageManager">, deps: { node: ExecutableResolutionDeps; manager: ExecutableResolutionDeps }): Promise<{ ok: true; node: string; manager: { name: PackageManagerName; path: string } } | ({ ok: false } & ToolchainProblem)>`;
- `defaultAppToolchainDeps(env?)`: both resolvers share one module-level `createExecutableCache()`, and use `loginShellCommandLookup({ env, maxBuffer: 16_384 })`;
- `toolchainProblemMessage(problem: ToolchainProblem): string`.

## Tasks

### Task 0: Baseline

- [x] Run `npm run test:devices` and note the pass count. Run `npx tsx --test main/services/devices/device-toolchain.test.ts main/services/devices/local-device-host.test.ts main/services/devices/android-device-features.test.ts` on its own. All must pass before any change.

### Task 1: Device helpers stop putting an empty entry on PATH

**Files:**
- Modify: `main/services/devices/device-toolchain.ts` (`prependPathEntries`, `deviceNodeEnvironment`, `createNpmRunner`), `main/services/devices/local-device-host.ts` (`androidSdkEnv`)
- Test: extend `main/services/devices/device-toolchain.test.ts` (the environment test at `:294-301`) and `main/services/devices/local-device-host.test.ts` (a new test after the SDK tests at `:769` and `:800`)

- [x] **Step 1: Write failing tests:**
  - in `device-toolchain.test.ts`, next to the existing environment test, `the device environment never puts an empty entry on PATH`, with three cases:
    - PATH unset gives exactly `/opt/node/bin`;
    - PATH `""` gives exactly `/opt/node/bin`;
    - PATH `/usr/bin::/bin` gives `/opt/node/bin:/usr/bin:/bin`;
  - in `device-toolchain.test.ts`, `the npm runner's PATH has no empty entry`. Run `createNpmRunner` against a temp-folder `npm` script that prints `$PATH` to a file, with `PATH: "/usr/bin::/bin"`;
  - in `local-device-host.test.ts`, `the Android SDK environment puts the SDK tools first and never adds an empty PATH entry`. `androidSdkEnv` with PATH unset, `""` and `/usr/bin::/bin`, with and without `javaHome`, and `root: null` returning the env unchanged.
- [x] **Step 2:** Run `npx tsx --test main/services/devices/device-toolchain.test.ts main/services/devices/local-device-host.test.ts`. Expected: the new cases FAIL, and every existing case passes.
- [x] **Step 3: Implement** `prependPathEntries(dirs, pathValue)` in `device-toolchain.ts` and use it in all three places. Use `path.delimiter`, which is `:` on darwin and linux, as today. `androidSdkEnv` imports it from `./device-toolchain.js` (already an import of that file).
- [x] **Step 4:** Rerun both files and `npm run test:devices`. Expected: PASS, Task 0's count plus the new cases. Run `npx tsc --noEmit -p .` and `npm run test:ci-policy`.
- [x] **Step 5:** Commit `fix(devices): never put an empty entry on a helper's PATH`.

### Task 2: Lift the Node toolchain out of the device toolchain

**Files:**
- Create: `main/services/node-toolchain.ts`, `main/services/node-toolchain.test.ts`
- Modify: `main/services/devices/device-toolchain.ts` (wrappers and re-exports only)
- Test: add two guards to `device-toolchain.test.ts`, written and run before any source change
- Register: `node-toolchain.test.ts` in `test:devices` (next to `device-toolchain.test.ts`) and in the `runtime-subagents` lane of `scripts/ci-test-registry.json`
- Not modified: `local-device-host.ts`, `main/handlers/devices.ts`, `device-tool-maintenance.ts`, `scripts/devices-acceptance.mjs`

- [x] **Step 1a: Guards first** (in `device-toolchain.test.ts`; they must pass on the old code):
  - `the npm login-shell lookup runs the shell with -ilc and command -v npm` **(guard)**. Call the real `defaultNpmResolutionDeps.loginShellLookup(shell)` against a temp-folder shell script that writes `"$@"` to a file and prints `/x/npm`. Assert the argv is exactly `["-ilc", "command -v npm"]` and the output comes back;
  - `the Node login-shell lookup runs command -v node and gives up on more than 16 KiB of output` **(guard)**. Call the real `defaultDeviceNodeResolutionDeps(env).loginShellLookup(shell)`: the argv is `["-ilc", "command -v node"]`, and a shell printing 20 KiB gives `null`.

  Run the file. Expected: PASS before any change.
- [x] **Step 1b: Write failing tests** in `node-toolchain.test.ts`:
  - `resolveExecutable finds pnpm on PATH, then through the login shell, then in Homebrew, and passes the command to the lookup`. The fake lookup records `(shell, command)` and returns a banner line before the path. Assert the order, that the lookup sees `"pnpm"`, and that relative PATH entries are skipped;
  - `the login-shell lookup runs the shell with -ilc and command -v for the asked command`. A temp-folder shell script records its argv: exactly `["-ilc", "command -v bun"]`;
  - `the login-shell lookup refuses a command outside the fixed set without starting the shell`. Call it with `"npm; touch x"` cast to `ToolCommand`, against a temp shell script that would create a marker. It resolves `null`, and the marker doesn't exist;
  - `the login-shell lookup gives null when the shell fails, times out, or prints more than 1 MiB with no maxBuffer`. A script that exits 1, one that sleeps past a 200 ms `timeoutMs`, and one that prints 1.5 MiB;
  - `the lookup's timeout defaults to five seconds` **(guard)**. A script that sleeps 1 s still answers when no `timeoutMs` is passed;
  - `with a cache, a validated login-shell path is kept and the shell isn't asked again`. Count lookup calls: the second `pnpm` resolve doesn't call the lookup; a `bun` resolve does;
  - `junk login-shell output is never cached`. The lookup prints `pnpm: aliased to pnpx` and then a path that fails `isExecutable`. Nothing is stored, and the next resolve asks again;
  - `a cached path that stops passing the check is dropped and looked up again`. Resolve, then make `isExecutable` refuse the cached path; the next resolve calls the lookup and stores the new path;
  - `without a cache, resolveExecutable asks the login shell every time` **(guard)**;
  - `isStandaloneNodeExecutable takes the minimum major version`. A temp script printing `{"node":"20.19.0","electron":false}` passes at `minMajor: 20` and fails at 22;
  - `isStandaloneNodeExecutable rejects the app binary and its links without running it` (the device test's setup, through the new function; **(guard)** for the move);
  - `nodeCommandEnvironment puts every bin folder first, in order, with no empty PATH entry, and clears Electron mode`. Two bin folders; PATH unset, `""` and `/usr/bin::/bin`; the input object is unchanged.
- [x] **Step 2:** Run `npx tsx --test main/services/node-toolchain.test.ts`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.**
  - Create `node-toolchain.ts` with everything under Interfaces. Move `resolveExecutable` and `prependPathEntries` there; `resolveExecutable` gains the `cache` path.
  - In `device-toolchain.ts`, keep each export:
    - `resolveNpm(deps)` = `resolveExecutable("npm", deps)`;
    - `resolveDeviceNode(deps)` = `resolveExecutable("node", deps)`;
    - `defaultNpmResolutionDeps` = `{ env: process.env, isExecutable: isExecutableFile, loginShellLookup: (shell) => npmLookup(shell, "npm") }`, with `npmLookup = loginShellCommandLookup({ env: process.env })`. No `maxBuffer`, as today;
    - `defaultDeviceNodeResolutionDeps(env)`: a node lookup with `maxBuffer: 16_384`, and `isDeviceNodeExecutable`;
    - `isDeviceNodeExecutable(candidate, env, app = process.execPath, isElectron = !!process.versions.electron)` = `isStandaloneNodeExecutable(candidate, env, { minMajor: 22, appExecutable: app, isElectron })`;
    - `deviceNodeEnvironment(env, nodePath)` = `nodeCommandEnvironment(env, [path.dirname(nodePath)])`;
    - `export { prependPathEntries } from "../node-toolchain.js"`.
  - Update the file's header comment to say where resolution now lives.
  - Register the test file.
- [x] **Step 4:** Rerun the new file. Then run, with no edits to existing cases:
  - `npx tsx --test main/services/devices/device-toolchain.test.ts main/services/devices/local-device-host.test.ts main/services/devices/android-device-features.test.ts main/services/devices/device-tool-maintenance.test.ts renderer/components/settings/simulator-settings.test.tsx`;
  - `npm run test:devices`, with Task 1's count plus the new tests.

  Run `npx tsc --noEmit -p .` and `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `refactor(devices): shared node-toolchain for Node and package-manager lookup`.

### Task 3: Framework, dev script and kind (pure)

**Files:**
- Create: `main/services/design-canvas/app-server/app-server-core.ts`, `main/services/design-canvas/app-server/app-server-core.test.ts`
- Register: `app-server-core.test.ts` in `test:design-mode` and in the `core-git` lane (where the other `design-canvas` tests are)

- [x] **Step 1: Write failing tests** (package objects in, results out):
  - **frameworks:**
    - `each framework is found from dependencies or devDependencies, and peerDependencies are ignored`, one row per R2 entry, including Angular's two packages, Nuxt and `@tanstack/start`;
    - `a framework app that also lists vite is that framework, not vite` (React Router, Remix, TanStack Start and TanStack Router, each with `vite`);
    - `@react-router/dev wins over @remix-run/dev`;
    - `react-router without @react-router/dev counts as the app's bundler` (`react-router` + `vite` is `vite`);
    - `remix 3 is its own framework and older remix is ignored` (`remix: "^3.0.0"` against `remix: "^1.19.3"`). Drop this case with the row if Remix 3 has no stable dev command;
  - **dev script:**
    - `the dev script is dev, then start, then serve, when none runs the framework's dev command`;
    - `a script running the framework's dev command wins over an earlier one`, for each of:
      - `dev: "vite build --watch"` with `start: "vite"`;
      - `dev: "next dev || next start"`;
      - `dev: "tsc -w & vite"`;
      - `start: "react-scripts start"`;
      - `develop`-style `start: "gatsby develop"`;
      - `dev: "ng serve"`;
      - `dev: "nuxt dev"`;
      - `dev: "vinxi dev"` with `@tanstack/start`;
    - `builds, production runs, Storybook and workspace runners are passed over`, one case each:
      - `start: "next start"` and `start: "next build && next start"` with no `dev`;
      - `serve: "serve -s build"`;
      - `start: "NODE_ENV=production node server.js"`;
      - `dev: "tsup --watch"`;
      - `dev: "rollup -c -w"`;
      - `dev: "storybook dev -p 6006"`;
      - `dev: "turbo dev"`;
      - `dev: "nx serve web"`;
      - `dev: "pnpm -r dev"`;
      - `dev: "pnpm --filter web dev"`;
      - `dev: "npm run dev --workspaces"`;
      - `dev: "yarn workspaces foreach run dev"`;
      - `dev: "lerna run dev"`;
    - `unsafe script names and non-string scripts are never picked or listed`: `-c`, a name with a newline, a 101-character name, `dev: 42` and `dev: null`;
    - `scripts that are missing or an array count as no scripts`;
  - **kinds**, one test per R4 row, named for its rule:
    - `an Electron app with React is react-nonweb desktop, even with vite and a dev script` (Aiden's own shape: `electron`, `vite`, `react`, `dev`), with `desktopShell: "electron"`;
    - `a Tauri app with React is react-nonweb desktop` (`@tauri-apps/cli` + `vite` + `react` + `dev: "vite"`), and `@tauri-apps/api` alone also counts;
    - `a desktop app without React is none`;
    - `a turbo root is workspace-runner, not no-dev-script` (`dev: "turbo dev"`, `turbo` in devDeps, no framework);
    - `an Nx root with vite and react but no runnable script is workspace-runner` (`nx.json` marker, `scripts: {}`);
    - `an Expo app is react-nonweb react-native`;
    - `a vite app with no scripts at all is none no-dev-script`;
    - `a Storybook-only React repo is react-nonweb, not no-dev-script` (`vite`, `react`, `@storybook/react-vite`, scripts `storybook` and `build-storybook`);
    - `a React library whose dev only builds is react-nonweb, not no-dev-script` (`packages/ui` shape: `vite`, `react` in peer and dev deps, `dev: "vite build --watch"`);
    - `a custom webpack app is none unknown-framework` (`react`, `webpack`, `dev: "webpack serve"`);
    - `a React package with no framework and no scripts is react-nonweb no-web-framework`;
    - `a vite Vue app is web and does not use React`;
    - `an Angular app is web`, and `a Nuxt app is web`;
  - `parsePackageJson strips a BOM and returns null for arrays, strings and broken JSON`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/app-server/app-server-core.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement R2–R4. Check each default port and dev command in R2 against the framework's current docs, Remix 3 included, and fix the table here and in this plan if one is wrong. Register the test file.
- [x] **Step 4:** Rerun. Run `npx tsc --noEmit -p .` and `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): pure web-app classification for design mode`.

### Task 4: Package managers, lockfiles and commands (pure)

**Files:**
- Modify: `app-server-core.ts`, `app-server-core.test.ts`

- [x] **Step 1: Write failing tests** (`decidePackageManager` and helpers with plain inputs):
  - `each lockfile name maps to its manager, and two files of one manager are not a conflict`;
  - `the packageManager field decides when there's no lockfile or only its own`. Field `pnpm@9.15.0+sha512.abc` with no lockfile; then with `pnpm-lock.yaml`;
  - `a packageManager field that disagrees with the lockfile is a conflict naming both`. Field pnpm with `package-lock.json`: `name: null`, `conflict: ["npm", "pnpm"]`;
  - `an unknown or malformed packageManager field is ignored`. `"deno@2"`, `"pnpm"` (no version, still pnpm), `42`;
  - `one manager's lockfile decides the manager`;
  - `lockfiles of two managers give no manager and list the conflict`. `package-lock.json` + `yarn.lock`: `conflict: ["npm", "yarn"]`;
  - `a conflict with exactly one manager's install marker picks it and keeps the conflict`. The same lockfiles with `node_modules/.yarn-integrity`: yarn, `source: "installed"`, `conflict` kept. With both `.package-lock.json` and `.yarn-integrity`: still `null`;
  - `pnpm-workspace.yaml without a lockfile means pnpm`;
  - `a Deno project without an npm-family lockfile has no manager and is marked unsupported`. `deno.json`, then `deno.lock`; with `package-lock.json` it's npm;
  - `no signal means npm with source none and lockfileLevelsUp 0`;
  - `an enclosing signal sets source enclosing and lockfileLevelsUp`;
  - `the yarn flavour follows the field's major version, then .yarnrc.yml, .pnp.cjs or a non-v1 yarn.lock head`. Field `yarn@1.22.22` with `.yarnrc.yml` is classic. A head with `__metadata:` is berry. A `# yarn lockfile v1` head is classic. An empty head is classic;
  - `installCommand gives the frozen install with a lockfile and a plain install without one`. One row per R10 line, plus `npm-shrinkwrap.json` giving `npm ci`, an enclosing lockfile giving the frozen form, and `workspace-file` alone giving `pnpm install`;
  - `runScriptCommand passes extra arguments the way each manager expects`. One row per manager with `["--port", "5173"]`: npm puts `--` before them, the others don't (or as Step 3's docs check finds). No extra args gives no `--`;
  - `runScriptCommand refuses an unsafe name, a null manager, or an extra argument with a control character`;
  - `workspacePatterns reads package.json workspaces in both shapes and pnpm-workspace.yaml packages, splits out ! patterns, and drops absolute and .. patterns`;
  - `matchesWorkspacePattern handles exact paths, one-level stars, a star inside a segment and ** as one level, and ignores braces`.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3:** Implement R5 (without disk access), R10 and the pattern helpers from R1. Check how pnpm, yarn classic, yarn berry and bun pass arguments after `run <script>`, using each manager's docs, and set the table to match.
- [x] **Step 4:** Rerun. Run `npx tsc --noEmit -p .`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): package-manager and lockfile rules for design mode`.

### Task 5: `detectWebApp` on the disk, and `designTarget`

**Files:**
- Create: `main/services/design-canvas/app-server/app-detect.ts`, `main/services/design-canvas/app-server/app-detect.test.ts`
- Modify: `app-server-core.ts` (`designTarget`), `app-server-core.test.ts`
- Register: `app-detect.test.ts` in `test:design-mode` and the `core-git` lane

The test file has a small `writeTree(base, { "package.json": {...}, "apps/web/package.json": {...}, "pnpm-lock.yaml": "" })` helper:
- it writes objects as JSON and strings as is;
- it makes `node_modules` folders, and makes symlinks from a `{ symlink: target }` value;
- it lives in the test file. 3b can move it into a shared helper when `discoverRoutes` needs it.

- [x] **Step 1: Write failing tests.** Each test runs in its own `mkdtemp` folder, removed afterwards, with `stopAt` and `homeDir` set to the temp base.
  - **Basic shapes:**
    - `a single Vite React app at the root is the one web app and counts as installed`. `designTarget` is `single`;
    - `the design-live-app fixture shape counts as installed through a symlinked node_modules`. Vite + React, no lockfile, `node_modules` a symlink to another temp folder: `web`, npm with source `none`, `installed: true`;
    - `a dangling node_modules symlink is not installed and does not throw`;
    - `an Electron app shaped like Aiden is react-nonweb, and packages without React are none`. `designTarget` is `react-nonweb`;
    - `a folder with no package.json anywhere gives no apps and target none`;
    - `a missing root folder gives no apps instead of throwing`.
  - **Workspaces and install roots:**
    - `a pnpm monorepo lists apps/web, apps/docs and packages/ui, with the root's manager and install root`. `pnpm-workspace.yaml` lists `apps/*` and `packages/*`; `web` is Next, `docs` is Astro, `ui` is a React library. Two `web`, one `react-nonweb`, every `installRoot` is `.`, and `designTarget` is `choose` with only the two web apps;
    - `npm workspaces hoist: a member without node_modules is installed when the root has it`;
    - `an excluded workspace pattern drops that folder`;
    - `a turbo monorepo root is workspace-runner and its apps are found`;
    - `an Nx integrated repo with no member package.json gives one workspace-runner root and target none`;
    - `a standalone frontend folder with its own lockfile is its own install root`. A root with no `package.json` (a Python repo) and `frontend/` with `yarn.lock`.
  - **Lockfiles and conflicts:**
    - `conflicting lockfiles leave the app web with no manager`. `designTarget` is still `single`;
    - `a conflict is settled by the one manager that installed node_modules`. `package-lock.json`, `yarn.lock`, `node_modules/.package-lock.json`;
    - `a yarn.lock without the v1 header is berry`;
    - `a Yarn PnP install counts as installed`. `.yarnrc.yml`, `yarn.lock`, `.pnp.cjs`: berry, `installed: true`.
  - **The enclosing walk:**
    - `a workspace opened inside a pnpm monorepo takes the enclosing lockfile`. Tree `base/repo/pnpm-lock.yaml`, `base/repo/.git/`, workspace `base/repo/apps/web`: pnpm, `source: "enclosing"`, `lockfileLevelsUp: 2`, `installRoot: "."`;
    - `an enclosing pnpm-workspace.yaml alone means pnpm`;
    - `a symlinked node_modules at the enclosing root counts as installed`;
    - `the walk stops at a .git folder and never reads above it`. The lockfile sits above `base/repo/.git`, giving npm with source `none`;
    - `the walk never runs when the workspace root holds .git`. A lockfile one level up is ignored;
    - `the walk never reads stopAt or home, compared after realpath`. `stopAt` passed through a symlinked path, and a lockfile in `stopAt` itself is ignored.
  - **Bounded and hostile reads:**
    - `a broken package.json is reported, not thrown`. Invalid JSON and a 600 KiB file each give `invalid-package-json`;
    - `a FIFO named package.json is unreadable and the read returns at once`. Created with `mkfifo`; the test fails on a 2 s timeout;
    - `a symlinked package.json is unreadable, not followed`;
    - `symlinked candidate folders, node_modules and dot folders are never scanned`. `apps/linked` symlinked to a folder with a Next app, `apps/.cache/package.json`, `packages/node_modules/x/package.json`: none is listed;
    - `a packages folder that is a symlink to / is never listed`, both as a fixed folder and through a `packages/*` workspace pattern;
    - `the scan stops at 100 candidates and says so`. 120 folders under `packages/`;
    - `results hold only relative paths`. No `root`, `installRoot` or `lockfile` value is absolute or contains `..`.
  - **Edge shapes** (A-m8), none of which may give `no-dev-script`:
    - a Storybook-only repo;
    - a `package.json` with `scripts` as an array;
    - one with `dev: null`.
  - In `app-server-core.test.ts`, `designTarget gives single, choose, react-nonweb or none` from hand-built detections. Include `react-nonweb` next to one `web` (which gives `single`), and a `none` target that keeps `workspace-runner` and `unknown-framework` candidates.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/app-server/app-detect.test.ts main/services/design-canvas/app-server/app-server-core.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** `readBounded` and `detectWebApp`:
  - read the root `package.json` and `pnpm-workspace.yaml` through `readBounded`;
  - `lstat` `apps/`, `packages/` and each pattern's parent folders; list real folders with `readdir({ withFileTypes: true })`, skipping symlinks, dot names and `node_modules`, at most 200 entries per folder, sorted by name before the cap;
  - for each candidate:
    - read `package.json`;
    - `lstat` the lockfile names, `pnpm-workspace.yaml`, the Deno markers, `.yarnrc.yml`, `.pnp.cjs` and the runner markers (`nx.json`, `turbo.json`, `lerna.json`);
    - read the `yarn.lock` head;
    - list `node_modules` markers, and `stat` `node_modules`;
  - run the enclosing walk (R6) once, only when its conditions hold;
  - feed the core.

  Catch every per-file error and turn it into a reason. Register the test file.
- [x] **Step 4:** Rerun. Run `npx tsc --noEmit -p .` and `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): detectWebApp finds a workspace's web apps`.

### Task 6: Missing Node or package manager

**Files:**
- Create: `main/services/design-canvas/app-server/app-toolchain.ts`, `main/services/design-canvas/app-server/app-toolchain.test.ts`
- Register: `app-toolchain.test.ts` in `test:design-mode` and the `core-git` lane

- [x] **Step 1: Write failing tests** (fake resolution deps, plus temp-folder cases):
  - `with Node and pnpm found, the toolchain gives both paths`;
  - `npm next to the resolved Node wins over another npm on PATH`. Node at `/a/bin/node` with `/a/bin/npm` executable, and `/usr/bin/npm` on PATH: `/a/bin/npm`;
  - `without a usable Node the problem is node-missing, even when the manager exists`;
  - `Node older than 22 is not usable`. A temp-folder `node` script printing `{"node":"20.19.0","electron":false}` on PATH;
  - `a project whose manager isn't installed gets manager-missing with that manager, and never falls back to npm`. A pnpm app where only `npm` resolves;
  - `a conflict gives manager-conflict and a Deno project gives unsupported-manager, without looking a manager up`. The manager fakes count zero calls;
  - `after Node is installed, the next resolve finds it without a restart`. First call: the lookup returns null. Then the fake starts returning a path, and the second call finds it, because misses aren't cached;
  - `each problem has a message that names what to install or fix`. `manager-missing` names the manager, `manager-conflict` names both managers, `node-missing` says 22, `unsupported-manager` says Deno.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3:** Implement R9. `defaultAppToolchainDeps` shares one `createExecutableCache()`, uses `loginShellCommandLookup({ env, maxBuffer: 16_384 })`, `isStandaloneNodeExecutable(…, { minMajor: 22 })` for Node and `isExecutableFile` for managers. Register the test file.
- [x] **Step 4:** Rerun. Run `npx tsc --noEmit -p .` and `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): resolve Node and the package manager for a detected app`.

### Task 7: Docs, memory and the spec amendments

**Files:**
- `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`
- `docs/plans/README.md`
- `.memory/design-mode.md`, `.memory/devices-ssh-hosts-toolchain.md`
- this plan

- [x] **Step 1: Spec.** Add "### Phase 2a amendments (2026-11-24)" after the Phase 1b amendments, numbered on from S18:
  - **S19. Launch environment in 2b.** The dev-server command environment (`agentShellCommandEnvironment()`, `BROWSER`, `FORCE_COLOR`, `PORT`, S14's host flags) lands in 2b with the process, through `nodeCommandEnvironment(env, binDirs)` and `runScriptCommand(info, script, extraArgs)`. 2b always sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. There's no corepack fallback for a missing manager.
  - **S20. Package manager rules** (R5, R6):
    - the `packageManager` field decides only with no lockfile or its own; otherwise it's a conflict;
    - a conflict is settled only by a single manager's install marker, else 2b refuses with a fix message;
    - `pnpm-workspace.yaml` means pnpm;
    - Deno is unsupported;
    - an enclosing repo's signal counts when the workspace has none and no `.git`.
  - **S21. Kinds and scripts** (R3, R4):
    - desktop shells (Electron, Tauri) are never `web`;
    - the dev script prefers the framework's dev command and skips builds, production runs, Storybook and workspace runners;
    - new reasons `workspace-runner` and `unknown-framework`;
    - `no-dev-script` only for a framework app with no dev/start/serve script and no Storybook;
    - React Native or Expo is `react-nonweb`;
    - "React Router v7 framework mode" means `@react-router/dev`.
  - **S22. Frameworks.** The allowlist gains Angular, Nuxt, `@tanstack/start` and Remix 3 (or records why Remix 3 was left out). They run as live frames; source mapping and component cards stay React-only.
  - **S23. `detectWebApp` lives in `app-detect.ts`.** It reads the disk with bounded, no-follow reads; `app-server-core.ts` stays pure.
  - **S24. Device PATH fix.** The device helpers (`deviceNodeEnvironment`, `androidSdkEnv`, `createNpmRunner`) no longer put an empty entry on PATH.

  Also update the header's status line to name the 2a plan.
- [x] **Step 2: Plan index.** In `docs/plans/README.md`, extend the design mode v2 row: "Phase 2a (app detection) planned 2026-11-24, plan [p2a](../superpowers/plans/2026-11-24-design-mode-v2-p2a-app-detection.md)". When the PR opens, add its number and "in review".
- [x] **Step 3: Memory.**
  - Add a "v2 Phase 2a: app detection" section to `.memory/design-mode.md`. Cover:
    - the module layout;
    - Task 1's PATH fix;
    - that devices keep their wrappers, and the unedited device tests plus Task 1's cases are the oracle;
    - R3's dev-command preference, R4's order and reasons, R5's conflict and tie-break rules, and R6's enclosing walk;
    - Node 22 for design;
    - that nothing calls the design modules until 2b.

    Update the v2 summary line at the top.
  - In `.memory/devices-ssh-hosts-toolchain.md`, add a dated entry after "Packaged local runtime fix (2026-10-12)" (its line 59 describes resolution). Say that resolution now lives in `main/services/node-toolchain.ts` behind the same device exports, and that the device helpers drop empty PATH entries. Don't rewrite the dated entry.
- [x] **Step 4: Check for stale claims.** Run `rg -n "device-toolchain|resolveExecutable|node-toolchain|deviceNodeEnvironment|androidSdkEnv|createNpmRunner" docs .memory AGENTS.md packages/cli/README.md` and fix anything the fix or the lift made wrong. Known results:
  - `docs/devices.md` says Node 22 and npm for local devices. That's still true, so no edit.
  - `docs/devices.md:164` names `device-toolchain.ts` for installs, which stay there, so no edit.
  - `docs/plans/simulator-devices-plan.md` is a dated plan: history, no edit.
  - README, `PRODUCT.md` and `docs/keyboard.md` describe nothing 2a changes. `docs/design-mode.md` doesn't exist yet; it starts with the first phase that has a person-facing surface.
- [x] **Step 5:** Tick this plan's boxes, and commit `docs(design): Phase 2a plan, spec amendments and memory`.

## Verification

Run, in order, each expected to pass:
- `npx tsx --test main/services/node-toolchain.test.ts main/services/devices/device-toolchain.test.ts main/services/devices/local-device-host.test.ts main/services/devices/android-device-features.test.ts main/services/devices/device-tool-maintenance.test.ts renderer/components/settings/simulator-settings.test.tsx`
- `npm run test:devices` (Task 0's count plus Task 1's, Task 2's guards and `node-toolchain.test.ts`)
- `npm run test:design-mode`
- `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
- `npm run lint`
- `npm run test:ci-policy`
- `npm run cli:build` (a guard: the CLI bundles neither `devices/` nor `design-canvas/`, but it must still build)
- `scripts/devices-acceptance.mjs` needs a simulator, so don't run it. It imports `createNpmRunner`, `defaultNpmResolutionDeps` and `resolveNpm` from `device-toolchain.ts`. Check that they still exist with `npx tsx --eval 'const m = await import("./main/services/devices/device-toolchain.ts"); for (const n of ["createNpmRunner", "defaultNpmResolutionDeps", "resolveNpm"]) if (m[n] === undefined) throw new Error(n);'`.

No E2E is needed: 2a changes no window, renderer or IPC. Task 1 changes the PATH that device helpers start with, so also run `tests/e2e/environment-devices-tab.spec.ts` on the host. Its macOS case is darwin-only, so the Cua Space would skip it.

Then `npm run test` once before the PR. CI must be green on the exact head.

## Risks and edge cases

For reviewers to attack:

1. **Task 1 changes devices on purpose.** A device helper used to inherit an empty PATH entry (the working folder) when PATH was unset, empty or held `::`. Now it never does. A setup that relied on finding a tool in the working folder through that empty entry would break. That's unlikely: these helpers run from Aiden's own folders, and a packaged app's cwd is `/`. After Task 1, the lift must change nothing more; diff each wrapper against the old body line by line. The likely slips:
   - the npm lookup gaining a `maxBuffer`, or the Node lookup losing its 16 KiB;
   - an `isExecutable` that now rejects Electron for npm;
   - a wrapper that drops `appExecutable` or `isElectron`, or their defaults.

   The code review extended the fix to the agent-device launcher (Q7) and to `run`'s branch for commands that start before Node is resolved (`xcrun simctl help`), which drops inherited empty entries and leaves an unset PATH unset. Follow-up, not changed in 2a: `ssh-device-script.ts:26` builds the remote PATH as `…:$PATH`, which gives a trailing empty entry when the remote PATH is empty.
2. **Design never inherits an empty PATH entry.** A dev server's cwd is the person's repo, so an empty PATH entry would let a file named `node` in the repo run. `nodeCommandEnvironment` drops empty entries, inherited ones included. 2b must build the launch environment only through it.
3. **Login-shell lookup.**
   - It runs the person's shell rc files, with a 5 s default timeout (as devices do today).
   - The command is from the fixed union and checked at runtime, so nothing from a package.json reaches the shell.
   - A zsh alias prints a non-absolute line and is ignored. fish supports `command -v`; nushell doesn't, so the lookup fails and Homebrew is tried.
   - Without `maxBuffer`, Node's 1 MiB default applies, and output past it gives `null`.
4. **The cache.** Only a path that passed `isExecutable` is kept, and it's checked again before every use, so a removed Node or pnpm is noticed. A changed nvm default isn't noticed while the old version still exists. `clear()` is there for 2c's Retry.
5. **Conflicts block the app.** A repo with a stale `yarn.lock` beside a working `package-lock.json`, and no single install marker, can't start until the person removes one or fixes the `packageManager` field. A wrong frozen install fails, and a wrong plain install writes a new lockfile into their repo. Attack whether the install-marker tie-break can pick wrong: `node_modules` left over from another manager, or an npm `node_modules` made before a switch to yarn.
6. **The enclosing walk.** It reads names of a few files and the 512-byte `yarn.lock` head in up to 5 parent folders. It never runs from a git root, and it stops at `.git`, home and `stopAt` (compared after `realpath`). A workspace under a folder with a stray lockfile and no `.git` in between picks that lockfile up. A git submodule has a `.git` file, so the walk stops there. Attack an unusual `HOME` on Linux, and macOS privacy prompts for parent folders (Desktop or Documents ancestors are already in the workspace's own scope).
7. **Install state is a hint.** A killed install leaves `node_modules`, so `installed: true` can be wrong; 2b's stamp (S8) decides. In pnpm workspaces a member's own `node_modules` can be missing while the root's exists, and 2a counts the root's. That's right for hoisting managers and close enough for pnpm, whose frozen install is quick when nothing changed.
8. **One-level search.** `apps/group/web` is found only when a workspace pattern names it exactly, and `packages/**` searches one level. This follows §6.2.1 and §10; a deeper search can come later.
9. **Dev-command matching.** It's word matching on script text, not a shell parser.
   - A `dev` like `concurrently "vite" "tsc -w"` matches `vite`, which is right.
   - `vite --mode production` is read as a dev run.
   - `NODE_ENV=production next dev` is preferred by step 1 before the skip list applies. That runs a dev server in production mode, which is legal, if odd.

   Attack the skip list against real monorepos: `--filter` also appears in non-runner commands.
10. **Framework precedence.**
    - A Next app that also lists `vite` (for Vitest) is Next.
    - An Astro site with `@astrojs/react` is Astro and uses React.
    - A migrated app with both `@react-router/dev` and `@remix-run/dev` is React Router.
    - An Angular app on the older `@angular-devkit/build-angular` and a newer one on `@angular/build` both match.
    - Remix 3's dev command and port are unverified until Task 3.
11. **Tauri and Electron.** A Tauri frontend often runs fine in a browser until it calls a Tauri API. Treating it as desktop (A-M3) sends it to React mocks. `.aiden/canvas.json` (3b) is the escape hatch.
12. **React Native.** Rule 6 sends Expo apps to the mock-app flow (§6.8). Expo can also run on the web (`expo start --web`), but design mode can't start that without an `expo` framework entry. That's out of scope; 3d's question copy should fit "an Expo app".
13. **Sizes and counts.** 512 KiB per package.json, 200 entries per folder, 100 candidates. A monorepo with more than 200 packages under `packages/` sees only the first 200 by name.
14. **Dead code until 2b.** The new design modules ship unused in 2a. Nothing imports them from production code, so the main bundle doesn't grow. Attack whether lint or the bundler flags unused modules.

## Open questions

Settled by the reviews:
1. **Corepack fallback:** none. 2b sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (S19).
2. **Node version for design:** 22, the same as devices.
3. **Conflicting lockfiles:** a single install marker settles it; otherwise 2b refuses with a message.
4. **The device PATH quirk:** fixed in Task 1, before the lift.
5. **The command environment:** 2b, with the signatures settled here (S19).

Still open, with the answer this plan assumes:
6. **The 3a fixture.** Should 2a create `tests/fixtures/design-live-app/` now? *Assumed:* no. 3a owns it with its E2E setup; Task 5 covers its shape, and 3a adds a `detectWebApp` check on the real fixture.
7. **The agent-device shim.** *Settled by the code review:* fixed in 2a. The generated launcher (`agent-device-shim.ts`) used to build `dirname(node) + ":" + (process.env.PATH ?? "")`, and it runs from the person's repo. It now drops every empty entry, and `device-tools.test.ts` runs the launcher with PATH unset, `""` and holding `::`.
8. **Remix 3.** *Assumed:* the row ships only if Task 3 finds a stable dev command and default port in Remix 3's docs; otherwise it's dropped and S22 says why.
9. **`unknown-framework` in 2b.** Can the person still start such an app through `choose`, with S2's consent showing the script text? *Assumed:* that's 2b's decision. 2a only promises that 3d never scaffolds for it.
