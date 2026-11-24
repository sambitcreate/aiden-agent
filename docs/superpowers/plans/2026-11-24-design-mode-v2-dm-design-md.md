# Design mode v2 — Phase DM: DESIGN.md as the design-system source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Aiden one place to read an app's design system, the app's `DESIGN.md`, and a tested way to find it, check it and draft one:
- `@google/design.md` is added, pinned exactly at `0.4.0`. Only its `/linter` entry point is used. It runs in a worker thread with a 2 s deadline, never on the main thread, with no network and no subprocess.
- `.aiden/canvas.json` gets its first reader (`canvas-config.ts`), which DM owns and 2b extends.
- `locateDesignMd` finds the `DESIGN.md` for an app root: an `apps[].designMd` entry, else the nearest `DESIGN.md` from the app root up to the workspace root.
- `DesignMdReader` reads it with a 64 KiB cap, lints it in the worker, adds two checks the library lacks (duplicate sections, unresolved token references), and caches the result by content hash.
- A new `design_system` tool (`read`, `lint`, `export`, `draft`) gives Aiden the tokens, the findings, the library's CSS and token exports, and a starter draft. It never writes a file. Everything from the file reaches Aiden fenced as data (S11).
- The path and lint counts of the active `DESIGN.md` ride the existing `design-canvas-status` transcript note, so the system prompt and its cache stay the same from turn to turn.
- When an app has no `DESIGN.md`, the same note asks Aiden, once per workspace and app root, to offer a draft through the question card. Aiden writes the file only after the person says yes, with its ordinary file tools and their ordinary approvals.
- The `design_md_linted` and `design_md_drafted` analytics events.
- A read-only `designCanvas:designSystem` IPC. A new packaged acceptance script calls it to run the linter inside the packaged app, and Phase 5's Styles frame will read it.

Everything above is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` (default off). With the flag off, design mode behaves exactly as today and the linter is never loaded.

**Architecture:**
- **New folder** `main/services/design-canvas/design-md/` (§6.9, §11 item 2). Pure pieces take parsed inputs and do no I/O. Readers do bounded, no-follow reads and feed them.
- **Linter boundary.** `lint-worker.ts` is the only file that imports `@google/design.md/linter`. It is its own esbuild entry (`build/main/design-md-lint-worker.js`), like `pi-vcc-worker.js`. `lint-client.ts` starts one worker per request, with a deadline, a memory limit, a scrubbed environment and at most two at once. A worker that fails to load gives a typed `linter-unavailable` status, never a crash.
- **Turn wiring.** `llm-client.ts` builds the tool next to the canvas tools, under the same gates, and appends one DESIGN.md sentence to `canvasStatusLine`. The static prompt section gains one flag-only bullet.
- **App roots.** DM picks which app roots to describe from `.aiden/canvas.json` entries that name a `script`, else 2a's `detectWebApp` and `designTarget`, else the workspace root. It doesn't start anything or ask which app; that's 2b.

**Tech Stack:** TypeScript (ESM), Electron 43 main, `node:worker_threads`, `tsx --test` for unit tests, the packaged-build verification scripts. No renderer UI changes and no E2E spec changes.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`:
- §2 decision 10; §5.4 (the v1 tokens offer this replaces);
- §6.5 (`design_system`), §6.6.2 (DESIGN.md as the first token source, used by Phase 5), §6.6.3 (Styles frame, Phase 5), §6.8 (mock apps, 3d), **§6.9**, §6.10 (`design_md_*` events);
- §7 (the DESIGN.md test list), §8 (the DM row), §11 items 1 and 2;
- §12 S6 (sequencing and the flag), S11 (untrusted output), S21 and S23 (2a's detection, which DM calls).

**Order.** DM's branch stacks on PR #911 (Phase 2a, `t3/design-mode-v2-p2a`), which is stacked on #908 (1b) and #894 (1a). DM lands before 2b, and 2b's branch stacks on DM's. So DM creates the shared pieces 2b reuses: `designLiveEnabled` (with 2b's definition) and `canvas-config.ts`. DM must merge before 3b.

## Scope

In scope:
- the dependency: exact pin, lockfile, licence notice, the worker entry, asar trimming and packaged-build checks;
- the flag helper `designLiveEnabled`;
- `.aiden/canvas.json`: a bounded reader, a raw-object read for 2b's writer, the `version` rule (none or `1`), a parser for `apps[].root`, `apps[].script` and `apps[].designMd`, and the shared `describedRoots` rule;
- lookup, read, lint, cache and summary of an app's `DESIGN.md`;
- `draftDesignMd`: a starter `DESIGN.md` from a token snapshot, plus the snapshot from the app's own style files;
- moving v1's style scanner into `design-md/style-scan.ts`, and the offer log into `offer-log.ts`;
- the `design_system` tool and its gates;
- the DESIGN.md sentence in the canvas status note, and the once-per-app draft offer;
- one flag-only bullet in the design-mode prompt section, and the DESIGN.md line in `canvas_read`;
- the `design_md_linted` and `design_md_drafted` events;
- the read-only IPC and `scripts/design-md-packaged-acceptance.mjs`;
- docs (including a new `docs/design-mode.md`), memory, spec amendments S33–S44 and the plan index.

Out of scope:
- the Styles frame, its live updates and its **Draft DESIGN.md** button (Phase 5, §6.6.3). Phase 5 also adds the file watcher that keeps it live (S35);
- code drift between DESIGN.md tokens and the running app's CSS variables, and the bridge's token collection as a draft source (Phase 5, §6.6.2);
- the `aiden-design` skill rewrite (3b). DM adds no skill text;
- the mock app's starter `DESIGN.md` and `theme.css`, and `design_md_drafted {source: "mock"}` (3d, S6);
- deleting v1's tokens offer (`DesignSystemOffers`, `designSystemOfferLine`, its skill text): 3d. DM leaves it working when the flag is off and skips it when the flag is on;
- writing `.aiden/canvas.json`, and its other fields (`routes`, `params`, `url`, `mock`): 2b writes `root` and `script`; 3b, 3d and 2c read the rest;
- resolving `@file#fragment` references. 0.4.0 doesn't, and DM doesn't either (S38);
- `studioCapabilities().designLive` for the renderer: 2b adds it;
- Remote, phones, Telegram and the CLI. None of them gets the tool, the note, the IPC or the dependency (§3 non-goals). `packages/cli` doesn't bundle `design-canvas/` and stays unchanged.

**Feature flag.** DM ships behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE`, default off, as S6 does for 2b–5 (S33). DM creates the helper, using 2b's definition, in `main/services/studio/feature-flags.ts`:
- `designLiveEnabled(env = process.env) = designModeEnabled(env) && designFlagOn(env.AIDEN_EXPERIMENTAL_DESIGN_LIVE)`;
- `designFlagOn(value)` is true for `1`, `true`, `yes` or `on`, trimmed and case-insensitive. The file's existing `flagOn` (only `1` and `true`) stays as it is for Create Images, so Create Images doesn't change;
- the constant `DESIGN_LIVE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_LIVE"`. It's read on each check.

With the flag off:
- no `design_system` tool, no prompt bullet, no DESIGN.md sentence, no draft offer, and the IPC refuses;
- v1's tokens offer works as today;
- no lint worker is ever started.

Turning the flag on or off changes the design-mode prompt section once, at the next design turn of each chat (S34). That's one prompt-cache miss per chat per flip, which is accepted.

## What exists today (checked against the code at `19b464fb9`)

| Item | Today | DM action |
|---|---|---|
| `@google/design.md` | Not installed (`node_modules/@google` holds only `genai`). | Added at exactly `0.4.0` (Task 1). |
| Dependency pins (`package.json`) | Runtime dependencies are mostly exact (`"yaml": "2.9.0"`, `"unified": "11.0.5"`); four use `^`. `zod` at root is `4.6.7`. | `"@google/design.md": "0.4.0"`, exact. |
| Main build (`scripts/build-electron.mjs:23`) | `electronBuildOptions` lists esbuild entries with `packages: "external"`; `main/services/pi-vcc/worker.ts` → `build/main/pi-vcc-worker.js` is one (`:37-38`). | A `design-md-lint-worker.js` entry beside it (Task 1). |
| `scripts/main-runtime-dependencies.test.mjs` | Builds `electronBuildOptions` in memory and fails if a production dependency isn't reached by any entry (`:64-76`), or a reached one is dev-only. | The worker entry and a lazy export in `design-canvas/main.ts` make the package reached (Task 1). Run in Task 1 and Verification. |
| Worker pattern (`pi-vcc/worker-client.ts:70-93`) | One `Worker` per call from `build/main/pi-vcc-worker.js` (or the built file when running from `.ts`), `resourceLimits`, a timer that `terminate()`s, at most two at once with a bounded queue. | `lint-client.ts` follows it. Under `tsx` it loads the `.ts` worker with the parent's own `process.execArgv` (adding `--import tsx` only if it's missing), so tests need no build step and a test's other `--import` preloads reach the worker too. An explicit `execArgv: ["--import", "tsx"]` would drop them (checked 2026-11-24 on Node 22.23.4). |
| Packaging (`package.json` `build` at `:391`, `asar` at `:409`) | `asar: true`; `files` drops `*.d.ts`, `*.map`, and test, docs and README files in `node_modules`. | Exclusions (Task 9). |
| v1 design system (`design-system.ts`, `design-system-offers.ts`) | Used only by `design-canvas/main.ts:139` (the `designSystemOffers` singleton) and `llm-client.ts` (`canvasStatusLine` at `:3210` appends the tokens offer; `settleDesignSystemOffer` at `:3281` logs it when the turn ends normally). The offer log is an HMAC-keyed JSON file under userData. | The scanner moves to `design-md/style-scan.ts` and the log to `offer-log.ts` (Task 7). With the flag on, the tokens offer is skipped (Task 8). |
| `aiden-design` skill (`skill.ts`) | Tells Aiden to read `design/tokens.css` and "a DESIGN.md or style guide". | No change (3b rewrites it). |
| `DESIGN_MODE_PROMPT_SECTION` (`canvas-tools.ts:210`) | Static. Declared as the extension's `systemPrompt` (`llm-client.ts:3076`), or patched once into the transcript when entered mid-turn (`:3261`, only when no `design-mode` section is present). | `designModePromptSection(designLive)`; the patch is replaced when its text differs (Task 8). |
| `withCanvasStatusNote` (`renderer/shared/design-canvas/canvas-summary.ts:539`) | Adds a `design-canvas-status` section only when the line differs from the last one in the transcript; journaled by `status-note.ts`. | Reused as is. |
| Canvas tools (`llm-client.ts:2998`) | Built when the workspace has a folder; `stillAvailable` re-checks design mode, the folder and `permission !== "none"`; held until entry; windowless turns list them in `windowOnlyToolNames` (`:3070`). | `design_system` joins `canvasTools` (Task 8). |
| `ask_user_question` (`llm-client.ts:1518`) | Enabled through `shouldEnableAskUserQuestionExtension({…, excluded})`. | The draft offer requires the same answer (Task 8). |
| `fenceAsData(label, text)` (`renderer/shared/agent-notices.ts:88`) | Fences untrusted text with a fence longer than any backtick run inside. | Used for all file-derived text. |
| 2a detection (`app-detect.ts:53`, `:325`; `app-server-core.ts:173`, `:616`) | `readBounded(path, cap)`, `detectWebApp(root, {stopAt?, homeDir?})` (no signal), `isSafeScriptName`, `designTarget(detection)`. No caller yet. | DM is the first caller (Tasks 2–3). |
| `.aiden/canvas.json` | Not read anywhere. | `canvas-config.ts` (Task 2). |
| Analytics | `COUNT_BUCKETS`; `design_*` events tested in `analytics-feature-reports.test.ts`; rows at `docs/analytics.md:50-53`. | Two events (Tasks 4, 8). |
| Design IPC (`main/handlers/design-canvas.ts`, `design-canvas-main.ts`) | `designCanvas:*` handlers with register-and-invoke tests; the preload allows the `designCanvas:` prefix. | `designCanvas:designSystem` (Task 9). |
| Packaged checks | `verify-linux-package.mjs` (CI, `ci.yml:821`), `verify-macos-package.mjs` (release; `:467` checks `build/main/pi-vcc-worker.js`), `test:e2e:diagnostics:packaged` (`release.yml:183`). Packaged scripts drive the app through `globalThis.aidenAPI.ipc.invoke` (`pi-session-packaged-restart-acceptance.mjs:165-171`). | Linter checks and a new acceptance script (Task 9). |
| Comment at `pi-compaction-session-store.ts:647` | "…the one-time design-system offer". | "…the one-time design-system or DESIGN.md offer" (Task 8). |

## What the package does (checked 2026-11-24 from the tarball)

`npm pack @google/design.md@0.4.0` into the scratchpad; the source was read and run, not the README. Review A re-verified the tarball.

- **Release facts.** Versions 0.1.0 to 0.4.0; `latest` is 0.4.0, published 2026-07-27. ESM only (`import` condition only), Node ≥ 18. Integrity `sha512-7aNIv6hslxIZ9igXq1abbVu+ue/ft/oFMUrAuhzpVFijGr9v+l0CkkCBQsHozucNiZHIBS43XC6l8gYDZRys9Q==`, 58 files. No install scripts in the package or its tree.
- **Licence.** `LICENSE` is Apache License 2.0. **`package.json` has no `license` field.** No `NOTICE` file.
- **Exports.** `"."` is the CLI (`dist/index.js`). `"./linter"` is `dist/linter/index.js` (683 KB): `lint`, the rules, `fixSectionOrder`, and the emitters.
- **Self-contained bundle.** The linter inlines its dependencies (unified, remark, micromark, yaml, zod 3, debug). Its only imports are Node built-ins. The installed `citty`, `remark-mdx`, `remark-frontmatter` and nested `zod@3` are never loaded by it.
- **No network, no subprocess.** None in the linter bundle. It reads `DEBUG`, `LOG_STREAM` and `LOG_TOKENS`, which can make `debug` print content; the worker strips them.
- **File reads.** The linter reads `dist/linter/spec-config.yaml` beside itself at import. `dist/spec-config.yaml` and `dist/spec.md` at the top level are read only by the CLI (`dist/index.js:20996`, `:24707`), so they can be dropped from the asar with it.
- **Speed (review A).** Linear for tokens, but **quadratic on emphasis runs**: `*a_` repeated to 16 KB takes 0.69 s, 32 KB 3.9 s, 64 KB 13.8 s; 260 KB of ordinary text takes 2.1 s. `lint` is synchronous. Hence the worker, the 2 s deadline and the 64 KiB cap.
- **Emitter shapes** (checked by running them): each `execute(state)` returns `{success: true, data}` or `{success: false, …}`:
  - `serializeTailwindV4(new TailwindV4EmitterHandler().execute(state).data.theme)` gives an `@theme { --color-primary: …; --font-body: …; --text-body: …; --radius-md: … }` block;
  - `serializeCssVars(new CssVarsEmitterHandler().execute(state).data.declarations)` gives `:root { --color-primary: …; --rounded-md: … }`;
  - `new DtcgEmitterHandler().execute(state).data` is the DTCG object (`$schema` 2025.10);
  - `report.tailwindConfig` is the Tailwind v3 `theme.extend` result.
- **Behaviour that differs from §6.9:**
  - The model has `colors`, `typography`, `rounded`, `spacing` and `components`. **`motion` isn't a group**: a `token-like-ignored` warning, and it's dropped from exports.
  - Known sections: Overview (alias Brand & Style), Colors, Typography, Layout (alias Layout & Spacing), Elevation & Depth (alias Elevation), Shapes, Components, Do's and Don'ts. **Motion and Voice & Content Strategy aren't known.** Unknown headings are ignored.
  - **A duplicate heading isn't reported.**
  - **`@file#fragment` isn't resolved or checked.**
  - **A broken `{path}` reference is an error only inside `components`.** In a token group it stays in `symbolTable` as the raw string (`colors.ghost` → `"{colors.nope}"`), is left out of `colors` and the exports, and isn't reported. A cycle behaves the same.
  - Invalid YAML is a `warning` with no `rule`. An empty file gives one warning. YAML alias bombs are refused. Nesting deeper than 20 is an error.
  - `omitted: [{section, reason}]` gives an info `declared-omission`.

## Spec amendments S33–S44

Task 10 adds these to spec §12 as "### Phase DM amendments (2026-11-24)". 2b uses S25–S32.

- **S33. Flag.** DM ships behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` with 2b–5 (S6), and creates `designLiveEnabled` with 2b's definition. With the flag on, the DESIGN.md offer replaces v1's tokens offer; with it off, nothing changes and no lint worker starts.
- **S34. No volatile prompt line.** §6.9's "volatile line" became the `design-canvas-status` note on 2026-11-18. The DESIGN.md path and counts are one sentence of that note, so a turn with the same counts adds nothing. The prompt section gains one static bullet when the flag is on; flipping the flag changes it once per chat.
- **S35. No watcher in DM.** Reads are on demand (turn start, tool calls, the IPC) and cached by content hash, so an edit is seen on the next read. Phase 5 adds a watcher for the live Styles frame.
- **S36. `design_system` actions.** `read | lint | export | draft`. `lint` takes optional `content` to check a draft before it's written. `draft` returns text and never writes. The tool never writes files.
- **S37. Draft sources and the scanner.** In DM a draft comes from the app's own style files, through v1's scanner, which DM moves into `design-md/style-scan.ts`. 3d deletes only the tokens offer and its skill text, not the scanner (this replaces §11 item 2's "delete both" and S6's scanner part). Phase 5 adds the bridge's token collection as a second source. Placing a Styles frame after a draft moves to Phase 5.
- **S38. What 0.4.0 checks.** No `motion` group; Motion and Voice & Content Strategy aren't known sections; `@file#fragment` isn't resolved; duplicate sections and unresolved token-group references aren't reported. DM adds `aiden/duplicate-section` and `aiden/unresolved-ref` warnings. 3b's skill text and Phase 5's Styles frame must not promise more than this.
- **S39. `.aiden/canvas.json` in DM.** DM owns `canvas-config.ts`.
  - **Version.** A file with no `version`, or `version: 1`, is understood. Any other `version` is `unsupported-version`: DM reads nothing from it, and a writer must refuse to change it. New files are written with `version: 1` (2b's writer does the writing).
  - **Paths** are workspace-relative; a root of exactly `.` is allowed and any other `.` segment is refused. `apps[].designMd` must end in `.md`.
  - **Described roots** come from one shared helper, `describedRoots(config, detected)`, used by DM's R2 and 2b's D4: the entries with a `script` whose `root` is also a `web` candidate in detection, in file order; if there are none, detection decides.
  - `designMd` applies to any entry whose `root` matches. Unknown fields stay in the file for 2b's writer.
- **S40. "Asks once"** means once per workspace and app root, logged only when the turn that carried the offer ended normally, as v1's tokens offer does. The log is an HMAC of the folder path and app root with the per-install key; the mechanics move to `offer-log.ts`. The offer is made only when `ask_user_question` is offered in that turn and the chat can write.
- **S41. The IPC.** A read-only `designCanvas:designSystem` lands in DM. `scripts/design-md-packaged-acceptance.mjs` calls it in the release workflow, and Phase 5 reads it. It sends no analytics.
- **S42. Packaging.** The package's CLI (`dist/index.js`), its top-level `dist/spec.md` and `dist/spec-config.yaml`, `dist/linter/spec.md` and its nested `node_modules/` are left out of the asar. The lint worker is a separate built file, and both package checks look for it.
- **S43. Events.** `design_md_linted` fires once per new content of a file per run, never for a `content` lint or an IPC read. `design_md_drafted {source: "app"}` fires when a turn ran `draft` and the target file exists at the turn's normal end where it didn't when the draft ran.
- **S44. The linter runs in a worker.** The worker posts `ready` once the linter is imported; loading has a 10 s limit (then `linter-unavailable`), and the lint itself a 2 s deadline from `ready` (then `timed-out`, cached by content hash). A 64 KiB file cap. The worker's environment drops `DEBUG`, `LOG_STREAM` and `LOG_TOKENS`.

## Global Constraints

- **Offline, always.** Nothing in DM opens a socket or starts a process other than the lint worker thread. Task 1's test proves the worker lints with every network and subprocess entry point trapped.
- **Off the main thread.** `lint` and the emitters run only in the worker. The main process never imports `@google/design.md`.
- **Reads stay inside the workspace.** Every path is resolved against the workspace folder's `realpath` and checked with `isPathInside` (`main/shared/path-containment.ts`). Reads go through 2a's `readBounded` on the real path. A symlinked `DESIGN.md` is followed only when its target is inside the workspace.
- **Every path is checked before it's used or shown.** App roots (from `canvas.json` or detection), walked folders, `designMd` values and draft targets all pass `isSafeWorkspaceRelativePath`. A root that fails is counted in "more" and never named. Paths in the note, answers and fence labels are written with `JSON.stringify`.
- **Size bounds.**
  - `DESIGN.md`: 64 KiB (`DESIGN_MD_MAX_BYTES = 65_536`). Over it, the status is `too-large` and nothing is linted.
  - Worker load: 10 000 ms from `new Worker` to the worker's `ready` message (the linter import, and under tests the `tsx` compile: about 230–300 ms locally, more on CI), then `terminate()` and `linter-unavailable`.
  - Lint deadline: 2 000 ms from `ready`, then `terminate()` and `timed-out`. Worker heap: 128 MB (`resourceLimits.maxOldGenerationSizeMb`).
  - At most two workers at once and 16 waiting, so the 19th request in flight is `busy`.
  - `.aiden/canvas.json`: 64 KiB; at most 32 `apps` entries kept.
  - `lint {content}`: 64 KiB.
  - Tool answers: at most 300 tokens in `read` (then `truncated: true`), each value at most 200 characters; at most 40 sections; at most 50 findings listed, with the full counts; `export` output at most 64 KiB, else refused with its size; a draft at most 32 KiB.
  - Cache: 16 files, least recently used out.
  - The note names at most three app roots.
- **Untrusted file text (S11).** Token names, values, section headings, finding messages, exports and drafts reach Aiden only inside `fenceAsData`. The note holds only checked paths, counts and fixed words.
- **No writes.** DM code never writes into the workspace. Aiden writes `DESIGN.md` with `write_file` and `edit_file`, under the workspace's approval mode. There's no new approval exception.
- **No startup work.** Nothing runs at launch. The first worker starts with the first lint in a run.
- **AGENTS.md:**
  - no source-grep tests; tests call the real functions with fixtures, or register and invoke IPC;
  - each new test file goes in `scripts/ci-test-registry.json` (the `core-git` lane, beside the other `design-canvas` tests) and in `test:design-mode`, then `npm run test:ci-policy` runs. `test:design-mode` is a union with whatever 2b adds;
  - docs change in this PR; the analytics registry, its docs rows and tests change together;
  - the manual-only network rules are untouched: the library is bundled, never fetched.
- **Each task stands alone.** Every task ends with its tests, `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs` and `npm run test:ci-policy` passing, and one commit.

## Rules

**R1. Where `DESIGN.md` lives** (§6.9 "Where it lives", S39). `locateDesignMd(workspaceRoot, appRoot, config)` returns `{ path, source: "config" | "app" | "ancestor" | "workspace" } | { missing: true, searched: string[] } | { invalid: reason }`:
1. **Override.** If an `apps` entry in `.aiden/canvas.json` has `root` equal to `appRoot` and a `designMd`, use it. A missing file there is `missing`, not a fallback: the person named it.
2. **Walk.** Otherwise look for an entry named exactly `DESIGN.md` (case-sensitive, by `readdir`, so macOS's case-insensitive disk doesn't match `design.md`) in the app root, then each parent folder, up to and including the workspace root. Never above it. The first match wins. Each walked folder is a prefix of a checked root, and is checked again anyway.
3. **Entry checks.** The entry must be a regular file, or a symlink whose `realpath` is a regular file inside the workspace's `realpath`. A folder named `DESIGN.md` is skipped. A symlink out of the workspace is `invalid: "outside-workspace"`; a dangling one is skipped.

`isSafeWorkspaceRelativePath(value, {extension?})`: a string of at most 200 characters, either exactly `.` or POSIX segments with no leading `/`, no `.` or `..` segment and no empty segment, each segment `[A-Za-z0-9._@+-]+` (no spaces, quotes or control characters); with `extension: ".md"`, it must end in `.md` and can't be `.`. Results are workspace-relative POSIX; for root `.` the file is `DESIGN.md`, never `./DESIGN.md`.

**R2. Which app roots a turn describes** (S39). `designAppRoots(workspaceRoot, { signal, config, detect })` runs detection (cached, below) and returns `describedRoots(config, detected)`, then bounds it.

`describedRoots(config: CanvasConfig | null, detected: WebAppDetection): string[]` is pure and lives in `canvas-config.ts`, so DM and 2b's D4 share one rule:
1. the `canvas.json` entries that have a `script` and whose `root` equals the `root` of a detected app with `kind: "web"`, in file order, without repeats;
2. if there are none, `designTarget(detected)`: `single` gives its root, `choose` gives every `web` root in detection order, anything else gives `["."]`.

A scripted entry that detection doesn't see as a web app (deleted, renamed, not a web app any more) is ignored rather than trusted. Then:
3. roots that fail `isSafeWorkspaceRelativePath` are dropped and counted in `more`;
4. at most 8 roots are resolved; the note names at most 3, and `more` counts the rest.

**Detection cache.** One entry per workspace, keyed on the sha256 of the root `package.json` and `pnpm-workspace.yaml` contents (read with `readBounded`, 512 KiB and 64 KiB). A change to either file runs detection again. The turn's `signal` is checked before detection and before each lookup; `detectWebApp` takes no signal, so an aborted turn waits for at most one bounded detection.

**R3. Reading and linting** (§6.9 "Reading and checking", S44). `DesignMdReader.read(workspaceRoot, located, { report = true })` returns a `DesignMdState`:

| Status | When | What follows |
|---|---|---|
| `ok` | read and linted | `summary {errors, warnings, infos}`, `findings`, `sections`, `omitted`, `tokens`, the content hash |
| `missing` | R1 found nothing | `searched` (relative folders); the draft offer may follow (R6) |
| `invalid` | R1 refused the path | the reason, in fixed words |
| `too-large` | `lstat` of the real path says over 64 KiB | the size; nothing read or linted |
| `unreadable` | gone, a FIFO, a device, a read error, or `readBounded` refused it | fixed words |
| `timed-out` | the lint passed its 2 s deadline, counted from `ready` | fixed words ("Checking this DESIGN.md took too long."); cached by content hash |
| `lint-failed` | `lint` threw inside the worker | fixed words; logged without the message |
| `linter-unavailable` | the worker couldn't load the linter, didn't post `ready` within 10 s, or exited without answering | fixed words; logged once per run |
| `busy` | two workers running and 16 waiting | fixed words; not cached |

Rules:
- **Size first.** `lstat` the real path (after R1's `realpath`); a regular file over 64 KiB is `too-large`. Then `readBounded(realPath, 64 KiB)` reads it; `null` there (a swap, a FIFO, growth past the cap) is `unreadable`. So `too-large` is reachable, and the bounded read is still the last check.
- A UTF-8 BOM is stripped. The content goes to the worker as a string; the worker returns plain JSON (no `Map`s).
- **Cache.** The key is the real path plus the sha256 of the content. `ok`, `timed-out` and `lint-failed` are cached. A hit returns the stored state without a worker.
- **Aiden's findings**, added in main after the worker answers, and counted in the summary:
  - `aiden/duplicate-section` (warning, path `sections`): a section listed more than once in `report.sections`, after folding aliases through `DESIGN_MD_SECTION_ALIASES` (a local table: Brand & Style → Overview, Layout & Spacing → Layout, Elevation → Elevation & Depth). Message: "Section \"<name>\" appears <n> times."
  - `aiden/unresolved-ref` (warning, path the token's path): a `symbolTable` value that is still a string matching `^\{[^}]+\}$`. Message: "<path> refers to <ref>, which doesn't resolve, so the token is left out."
- **Tokens.** `tokens` is the flat `symbolTable`, each resolved value shown as a string (`#1a1c1e`, `8px`, a typography level's `fontFamily`/`fontSize`/`fontWeight`/`lineHeight`), unresolved ones left out, sorted by path, capped per Global Constraints.
- **Analytics.** A cache miss on a file with `report: true` sends `design_md_linted {errors_bucket, warnings_bucket}` with `COUNT_BUCKETS`, after Aiden's findings are added (S43). `lintContent` and `read({report: false})` send nothing.

**R4. The `design_system` tool** (§6.9 "Agent surface", S36). Parameters: `{ action: "read" | "lint" | "export" | "draft", appRoot?: string, format?: "css-tailwind" | "json-tailwind" | "dtcg" | "css-vars", content?: string }`.
- `appRoot` defaults to the first root of R2. It must pass the R1 check and exist as a folder inside the workspace.
- **`read`**: `{ status, path, source, summary, sections, omitted, tokens, truncated? }`. Sections and tokens go in one `fenceAsData(\`DESIGN.md tokens and sections from ${JSON.stringify(path)}\`, json)` block; status, path and counts stay outside it.
- **`lint`**: `{ status, path, summary }` plus the findings (`severity`, `rule`, `path`, `message`), fenced. With `content`, the text is linted as given, under the same cap and deadline; nothing is cached, no event is sent, and the answer says `source: "content"`.
- **`export`**: one worker call that lints and emits, fenced:
  - `css-tailwind`: `serializeTailwindV4(execute(state).data.theme)` (Tailwind v4 `@theme` CSS, the format 3d's `theme.css` uses);
  - `json-tailwind`: `report.tailwindConfig` as JSON;
  - `dtcg`: `execute(state).data` as JSON;
  - `css-vars`: `serializeCssVars(execute(state).data.declarations)`.

  `success: false` is returned, fenced, with `status: "error"`. Output over 64 KiB is refused with its size. Exports are cached by content hash and format.
- **`draft`**: only when the status is `missing` for that app root. Returns `{ target, draft, summary }`: `target` is the `designMd` override, else `DESIGN.md` for root `.`, else `<appRoot>/DESIGN.md`; `draft` is `draftDesignMd(snapshot)` fenced; `summary` is the draft's own lint counts. It records the target for R7. With a `DESIGN.md` present it refuses and says to `read` it.
- **Never writes.** `draft` answers end with: "Nothing was written. Show the person what you'll write, then write it with write_file once they've said yes."
- **Gates.** Built only when `designLive` is on and the canvas tools are built, with the same `stillAvailable` (design mode on, same folder, permission not `none`). Declared with the canvas tools, not on demand, so the tool list stays the same across turns. Its own budget is 20 calls per turn, with the canvas tools' `limit_reached` answer shape. Replay class `"safe"`. Windowless turns list it in `windowOnlyToolNames`, like the canvas tools.

**R5. The status note sentence** (S34). `designMdStatusSentence(entries, { more, offer? })`, pure. It's appended to the canvas line in every flag-on design turn, whether or not the chat can write. For each described root:
- `ok`: `DESIGN.md: "web/DESIGN.md" (1 error, 2 warnings).` Infos are left out. Several roots are joined with "; ".
- `missing`: `No DESIGN.md for "web".`
- other statuses: `DESIGN.md for "web" can't be checked (too large).`, `(took too long)`, and so on, with fixed reasons.
- `more > 0`: `…and 2 more apps.`
- `offer` (R6), when given, is appended last.

Paths are checked and `JSON.stringify`d. The sentence never holds file content.

**R6. The draft offer** (§6.9 "When there isn't one", S40). `DesignMdOffers.offerFor(workspaceRoot, appRoot)` returns the fixed offer sentence, or `""`. The turn asks for it only when all hold:
- the root's status is `missing`, and it's the first such root this turn;
- the chat can write (`designSystemOfferable` in llm-client: not Bot, assistant, windowless, `none`, `read-only`, or without `write_file`);
- `ask_user_question` is offered in this turn: the same `shouldEnableAskUserQuestionExtension({…, excluded})` result llm-client already computes at `:1518`;
- the log doesn't have the workspace and app root, and this run hasn't offered it.

The turn's end settles it like v1: `delivered` logs it; a failed or stopped turn leaves it for a later turn.

The sentence: `There's no DESIGN.md for "<appRoot>" yet. Before you design in it, ask the person once with ask_user_question: "No DESIGN.md yet. Draft one from the app's current styles?" On yes, call design_system with action draft, fill only the sections you have evidence for, list the rest under omitted, check it with design_system lint and content, then write it with write_file. On no, carry on without it and don't ask again.`

**R7. `design_md_drafted`** (S43). `draft` records `{ target }` for the turn (it can only run when the target is missing). When the turn ends normally, each recorded target that now `lstat`s as a regular file sends `design_md_drafted {source: "app"}` once. A stopped or failed turn sends nothing. `"mock"` is added in 3d.

**R8. The draft** (§6.9, §7, S37). `draftDesignMd(snapshot: DesignTokenSnapshot): string`, pure:
- `DesignTokenSnapshot = { name?: string; colors: {name: string | null; value: string; dark?: string}[]; fonts: {name: string | null; family: string}[]; rounded?: {name: string; value: string}[]; spacing?: {name: string; value: string}[] }`. v1's `DetectedDesignSystem` fits it; Phase 5's bridge snapshot will too.
- YAML front matter with `name`, `colors` (names lowercased to `[a-z0-9-]`, deduplicated with `-2`, `-3`; nameless values become `color-1`…; dark values under a `dark` group), `typography` (one level per font role, `fontFamily` only), and `rounded` and `spacing` when given.
- Prose sections in the library's order, with a one-line placeholder where there's evidence. Sections without evidence go under `omitted` with the reason "No evidence in the app's styles yet."
- The front matter is written with the `yaml` package's `stringify`, never concatenation.
- Over 32 KiB, colours are dropped from the end until it fits.
- `designMdDraftFor(workspaceRoot, appRoot, signal)` runs the scanner (`findWorkspaceDesignSystem`) on the app root's folder and feeds `draftDesignMd`.

**R9. The IPC** (S41). `designCanvas:designSystem {chatId, appRoot?}` → `{ status, path?, summary?, sections?, findings? (≤ 50) }` or `{ error: "unavailable" }`. It refuses with the flag off, for unknown, Bot or `owner` chats, for chats without a workspace folder, and for an `appRoot` that fails R1's check. It doesn't need design mode on, as `designCanvas:get` doesn't. It reads with `{report: false}`, never writes, and sends no event.

## Interfaces

`main/services/studio/feature-flags.ts`: `DESIGN_LIVE_FEATURE_FLAG`, `designFlagOn(value)`, `designLiveEnabled(env)`.

`main/services/design-canvas/design-md/lint-worker.ts` (worker entry): imports `@google/design.md/linter` statically and posts `{ ready: true }` once that import has finished; handles `{ op: "lint", content }` and `{ op: "export", content, format }`; posts `{ ok: true, result }` or `{ ok: false, code: "lint-failed" | "emit-failed" }`. `result` for `lint`: `{ summary, findings, sections, omitted, symbols: [path, {kind, text} | {unresolved: string}][], tailwindConfig }`; for `export`: `{ success, text?, errors? }`.

`main/services/design-canvas/design-md/lint-client.ts`:
- `DESIGN_MD_LINT_DEADLINE_MS = 2_000` (from `ready`); `DESIGN_MD_WORKER_LOAD_TIMEOUT_MS = 10_000` (from `new Worker` to `ready`);
- `type LintOutcome = { ok: true; result } | { ok: false; status: "timed-out" | "lint-failed" | "linter-unavailable" | "busy" }`;
- `runDesignMdWorker(request, options?: { deadlineMs?; loadTimeoutMs?; signal?; workerUrl?; env?; execArgv? }): Promise<LintOutcome>`. The request is posted only after `ready`. Production: `new URL("./design-md-lint-worker.js", import.meta.url)`, with no `execArgv` (Node's default, the parent's). From `.ts`: `new URL("./lint-worker.ts", import.meta.url)` with `execArgv: options.execArgv ?? withTsx(process.execArgv)`, where `withTsx` appends `--import tsx` only when no `--import tsx` (or `--import=tsx`) is present. Never a fixed `["--import", "tsx"]`, which would drop the parent's other preloads. `env` is a copy of `process.env` without `DEBUG`, `LOG_STREAM`, `LOG_TOKENS`. `resourceLimits: { maxOldGenerationSizeMb: 128 }`.

`main/services/design-canvas/canvas-config.ts`:
- `CANVAS_CONFIG_PATH = ".aiden/canvas.json"`, `CANVAS_CONFIG_MAX_BYTES = 65_536`;
- `CANVAS_CONFIG_VERSION = 1`;
- `type CanvasConfigApp = { root: string; script?: string; designMd?: string }`; `type CanvasConfig = { version: 1; apps: CanvasConfigApp[] }`;
- `type CanvasConfigInspection = { status: "ok"; config: CanvasConfig; raw: Record<string, unknown> } | { status: "invalid" } | { status: "unsupported-version"; raw: Record<string, unknown> }`;
- `isSafeWorkspaceRelativePath(value: unknown, options?: { extension?: ".md" }): value is string`;
- `parseCanvasConfigObject(text: string): Record<string, unknown> | null` (the raw object, BOM stripped; `null` for bad JSON or a non-object), for 2b's writer to merge into;
- `inspectCanvasConfig(text: string): CanvasConfigInspection`: `invalid` for bad JSON or a non-object; `unsupported-version` when `version` is present and isn't exactly the number `1`; otherwise `ok`. 2b's writer uses it and refuses to write over `invalid` or `unsupported-version`;
- `parseCanvasConfig(text: string): CanvasConfig | null`: the `ok` config, else `null` (so an unknown version gives `null`). Known fields only; a bad `root` drops the entry; a bad `script` (not `isSafeScriptName`) or `designMd` drops that field;
- `describedRoots(config: CanvasConfig | null, detected: WebAppDetection): string[]` (R2);
- `readCanvasConfigText(workspaceRoot): Promise<string | null>` and `readCanvasConfig(workspaceRoot): Promise<CanvasConfig | null>` (through `readBounded`).

`main/services/design-canvas/design-md/locate.ts`: `locateDesignMd(workspaceRoot, appRoot, config)` (R1); `createDesignAppRoots(deps?)` → `(workspaceRoot, { signal, config }) => Promise<{ roots: string[]; more: number }>`: the per-workspace detection cache, then `describedRoots`, then the R2 bounds.

`main/services/design-canvas/design-md/sections.ts`: `DESIGN_MD_SECTION_ALIASES`, `canonicalSection(name)`.

`main/services/design-canvas/design-md/reader.ts`: `DESIGN_MD_MAX_BYTES = 65_536`; `type DesignMdState`; `class DesignMdReader { constructor(deps: { run?: typeof runDesignMdWorker; report?: (event, props) => void; maxEntries?: number }); read(workspaceRoot, located, options?: { report?: boolean; signal? }); lintContent(content, signal?); export(workspaceRoot, located, format, signal?) }`; `withAidenFindings(result)` (pure).

`main/services/design-canvas/design-md/style-scan.ts` (moved, Task 7): `findWorkspaceDesignSystem`, `detectDesignSystem`, `designSystemFileRank` and their types, unchanged.

`main/services/design-canvas/design-md/draft.ts`: `type DesignTokenSnapshot`; `draftDesignMd(snapshot)`; `designMdDraftFor(workspaceRoot, appRoot, signal?)`.

`main/services/design-canvas/design-md/status.ts`: `designMdStatusSentence(entries, options)` (R5); `designMdOfferSentence(appRoot)` (R6).

`main/services/design-canvas/offer-log.ts`: `class OfferLog { constructor({ file, now?, onSaveError? }); keyFor(...parts: string[]): Promise<string>; claim(key): Promise<boolean>; settle(key, delivered): Promise<void> }`. Same key file and version-2 JSON as today.

`main/services/design-canvas/design-md/offers.ts`: `class DesignMdOffers { offerFor(workspaceRoot, appRoot): Promise<string>; settle(workspaceRoot, delivered): Promise<void> }` on `design-md-offers.json`.

`main/services/design-canvas/design-md/tool.ts`: `DESIGN_SYSTEM_CALLS_PER_TURN = 20`; `createDesignSystemTool(deps)` (R4).

`main/services/design-canvas/design-md/turn.ts`: `createDesignMdTurn(deps)` → `{ tool, statusSentence(signal), canvasReadLine(signal), settle(delivered) }`; `withDesignModeSection(messages, text, now)` (pure: no `design-mode` section → append it; the latest one equals `text` → the same array; otherwise append a patch with `text`, which replaces it).

`main/services/design-canvas/main.ts`: `designMdLinter` (lazy: the shared `runDesignMdWorker`, no worker until called), `designMdReader`, `designMdOffers`.

## Tasks

### Task 0: Baseline

- [x] Run `npm run test:design-mode` and note the pass count. Run `npx tsx --test main/services/design-canvas/design-system.test.ts main/services/design-canvas/design-system-offers.test.ts main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/skill.test.ts main/handlers/design-canvas.test.ts main/services/analytics/analytics-feature-reports.test.ts main/services/studio/feature-flags.test.ts renderer/shared/design-canvas/canvas-summary.test.ts main/services/prompt-prefix-stability.test.ts` and `node --test scripts/main-runtime-dependencies.test.mjs scripts/verify-linux-package.test.mjs scripts/verify-macos-package.test.mjs`. All must pass before any change.
- [x] Confirm the branch is based on `t3/design-mode-v2-p2a` and that 2b hasn't merged (DM lands first). If 2b has merged anyway, use its `designLiveEnabled` and skip Task 1 Step 1's flag part.

### Task 1: The flag, the pinned linter and its worker

**Files:**
- Modify: `main/services/studio/feature-flags.ts`, `main/services/studio/feature-flags.test.ts`, `package.json` (`dependencies`), `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `scripts/build-electron.mjs` (the worker entry), `main/services/design-canvas/main.ts` (`designMdLinter`)
- Create: `main/services/design-canvas/design-md/lint-worker.ts`, `lint-client.ts`, `lint-client.test.ts`, `test-support/trap-network.mjs` (the preload for the offline and resolve-hook tests; it writes to the file named by `AIDEN_TEST_TRAP_LOG`), fixtures under `design-md/fixtures/` (`valid.md`, `broken-ref.md` with a broken reference both in `components` and in `colors`, `low-contrast.md`, `duplicate-section.md` with Overview and Brand & Style, `bad-yaml.md`, `motion.md`, `emphasis.md` generated in the test, not committed)
- Register: the new test file

- [x] **Step 1: The flag, test first.** In `feature-flags.test.ts`: `live apps are on only for 1, true, yes or on`: unset, `""`, `0`, `false`, `off` are off; `1`, `TRUE`, ` true `, `yes`, `On` are on; and `live apps are off whenever design mode is off`: the flag on with `AIDEN_DESIGN_MODE=0`. Run it (FAIL), add `DESIGN_LIVE_FEATURE_FLAG`, `designFlagOn` and `designLiveEnabled`, rerun (PASS). Create Images' cases stay as they are.
- [x] **Step 2: Install.** `npm install --save-exact --ignore-scripts @google/design.md@0.4.0`. Check that `package.json` reads `"@google/design.md": "0.4.0"`, that the lockfile entry has the integrity above, and that no new lockfile entry has `hasInstallScript`. Record the added packages and the `node_modules` size change in the PR description (a clean probe measured about 9.6 MB on disk).
- [x] **Step 3: Write failing tests** in `lint-client.test.ts`, against the real library through the real worker:
  - `the worker reports what the fixtures hold`: `valid.md` has 0 errors; `broken-ref.md` has one `broken-ref` error at `components.<name>`, and its `colors` symbol comes back `{unresolved: "{colors.nope}"}`; `low-contrast.md` has a `contrast-ratio` warning; `bad-yaml.md` has a warning and no failure; `motion.md` has `token-like-ignored` at `motion`. These pin S38's facts, so a pin upgrade that changes them fails here first;
  - `a pathological file comes back timed-out within the deadline`: 64 KiB of `*a_` (about 14 s of linting); the outcome is `timed-out`, and the time from the worker's `ready` to the outcome is under 2.5 s (measured with an `onReady` test hook in the options, so the `tsx` compile and import don't count);
  - `a worker that never posts ready gives linter-unavailable after the load timeout` (a `workerUrl` to a test worker that never posts, `loadTimeoutMs: 300`; the outcome arrives in under 1 s and the worker is terminated);
  - `the worker's environment has no debug switches`: with `DEBUG=*`, `LOG_STREAM=1` and `LOG_TOKENS=1` set in the test process, linting `valid.md` writes nothing to the worker's stderr (`stderr: true` on the worker, collected);
  - `the export shapes are right`: `css-tailwind` holds `@theme {` and `--color-primary:`; `css-vars` holds `:root {` and `--color-primary:`; `dtcg` parses with a `$schema`; `json-tailwind` holds `colors.primary`;
  - `the worker lints with no network and no subprocess`: a child `node --import tsx --import ./test-support/trap-network.mjs` script, with `AIDEN_TEST_TRAP_LOG` set to a temp file, runs `runDesignMdWorker` on each fixture with no `execArgv` option, so the worker inherits both preloads through `process.execArgv`. The preload replaces `globalThis.fetch`, `http.request`, `https.request`, `net.connect`, `net.createConnection`, `tls.connect`, `dgram.createSocket` and every `child_process` entry point with functions that log a call line and throw. **Positive control:** on load it logs `installed <threadId>`. The test requires an `installed` line with a non-zero `threadId` (so the trap ran inside the worker), the expected lint counts, and no call lines;
  - `only the linter entry point loads`: the same preload registers a resolve hook (`module.register`) in each thread, which logs every resolved URL. **Positive control:** a URL ending in `@google/design.md/dist/linter/index.js` is logged from the worker's thread. Then none ends in `@google/design.md/dist/index.js`, and none is under `node_modules/citty`, `remark-mdx`, `remark-frontmatter` or `@google/design.md/node_modules/`. This is the oracle for Task 9's trimming;
  - `an explicit execArgv option replaces the inherited one`: with `execArgv: ["--import", "tsx"]` the log has no `installed` line from the worker. This shows the control can fail;
  - `a worker that can't load gives linter-unavailable` (a `workerUrl` to a file that throws on import) and `with two running and sixteen waiting, the nineteenth request is busy` (a fake worker URL that sleeps; 19 requests give 18 that finish and one `busy`);
  - `an aborted signal terminates the worker` (the `*a_` input, abort after 100 ms, the call settles within 500 ms).
- [x] **Step 4:** Run `npx tsx --test main/services/design-canvas/design-md/lint-client.test.ts`. Expected: FAIL (modules missing).
- [x] **Step 5: Implement** `lint-worker.ts` and `lint-client.ts` per Interfaces, following `pi-vcc/worker-client.ts` (acquire, timer, `terminate()` before release). Add the esbuild entry `main/services/design-canvas/design-md/lint-worker.ts` → `build/main/design-md-lint-worker.js` (`format: "esm"`, `packages: "external"`) to `electronBuildOptions` after the vcc worker. Add `designMdLinter` to `design-canvas/main.ts`: a lazy holder that starts no worker until called.
- [x] **Step 6: Notice.** Add `## DESIGN.md linter (@google/design.md 0.4.0)` to `THIRD_PARTY_NOTICES.md`: Copyright Google LLC, Apache License 2.0, the licence URL; that the package's `package.json` has no `license` field and the licence comes from its `LICENSE` file; that only `dist/linter/` is loaded; and the licences of the modules it inlines (unified, remark, micromark, yaml, zod, debug), each checked in the bundle's header comments or their npm entries.
- [x] **Step 7:** Rerun the test file, `npx tsx --test main/services/studio/feature-flags.test.ts`, `node --test scripts/main-runtime-dependencies.test.mjs` (it now sees `@google/design.md` through the worker entry), `npm run build:electron` (the worker file is written), `npx tsc --noEmit -p .`, `npm run lint`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 8:** Commit `feat(design): add the live flag and the pinned DESIGN.md linter in a worker`.

### Task 2: Read `.aiden/canvas.json`

**Files:**
- Create: `main/services/design-canvas/canvas-config.ts`, `main/services/design-canvas/canvas-config.test.ts`
- Register the test file

- [x] **Step 1: Write failing tests:**
  - `a config lists its apps with root, script and designMd`: `{"apps":[{"root":"web","script":"dev","designMd":"web/design/DESIGN.md"},{"root":"."}]}`;
  - `a missing version or version 1 is understood, and any other version isn't`: no `version` and `1` give `ok`; `2`, `0`, `"1"`, `1.5`, `null` and `true` give `unsupported-version` from `inspectCanvasConfig` (with the raw object) and `null` from `parseCanvasConfig`; bad JSON gives `invalid`;
  - `described roots are scripted entries that detection also sees as web apps, else detection`, on hand-built `WebAppDetection` values:
    - entries `web` (with `script`) and `docs` (with `script`), detection with `web` as `web` and `docs` as `react-nonweb`: `["web"]`;
    - a scripted entry `old` that detection doesn't list, and detection with one web app `site`: `["site"]`;
    - no scripted entries, two web apps: both, in detection order; no web apps: `["."]`;
    - scripted entries in file order `b`, `a`, both web: `["b", "a"]`; a repeated root appears once;
    - a `null` config behaves like no entries;
  - `fields DM doesn't know are ignored by the parser but kept in the raw object`: `routes`, `params`, `url`, `mock` and a top-level `"future": 1` come back from `parseCanvasConfigObject` unchanged;
  - `a root of exactly "." is allowed, and other "." segments aren't`: `.` passes; `./web`, `web/.`, `a/./b` fail;
  - `unsafe paths are dropped`: absolute, `..`, `a//b`, a space, a quote, a control character, 201 characters, `designMd` not ending in `.md`, `designMd: "."`, a non-string. A bad `root` drops the entry; a bad `designMd` or `script` drops that field. A `script` of `-x` or 101 characters is dropped (2a's `isSafeScriptName`);
  - `bad JSON, an array, or apps that isn't an array gives no apps`; a BOM is fine; more than 32 entries keep the first 32;
  - `the reader refuses a symlinked, oversized, folder or FIFO config without hanging`; `a missing config is null`.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3: Implement** with `readBounded` from `app-server/app-detect.ts` and `isSafeScriptName` from `app-server-core.ts`. A header comment says 2b adds the writer, which merges into `parseCanvasConfigObject`'s result so unknown fields survive.
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): read app roots, scripts and designMd from .aiden/canvas.json`.

### Task 3: Find an app's DESIGN.md

**Files:**
- Create: `main/services/design-canvas/design-md/locate.ts`, `main/services/design-canvas/design-md/locate.test.ts`
- Register the test file

- [x] **Step 1: Write failing tests** (real temp folders):
  - `the app root's DESIGN.md wins over the workspace root's`;
  - `with none in the app root, the nearest folder above it wins`: `apps/web` finds `apps/DESIGN.md` before `DESIGN.md`;
  - `nothing above the workspace root is read`: a `DESIGN.md` in the parent is never found; `searched` ends at `.`;
  - `root "." finds DESIGN.md, not ./DESIGN.md`;
  - `a designMd override is used, and a missing override is missing rather than a fallback`; it applies to an entry with no `script` too;
  - `only the exact name counts`: `design.md` and `Design.md` aren't found (names are listed, so this holds on macOS);
  - `a folder named DESIGN.md is skipped`;
  - `a symlink inside the workspace is followed; one leading out is invalid; a dangling one is skipped`;
  - `designAppRoots uses describedRoots on real detection`: on a fixture with two Next apps under `apps/` and a `canvas.json` naming one with a `script`, only that one is described; an entry without `script` doesn't count, and detection decides;
  - `without scripted entries, detection decides`: `single`, `choose` and the `["."]` fallback on fixture repos (a Vite app, two Next apps under `apps/`, an Electron app);
  - `hostile folder names are never described or named`: a detected web app at `apps/x"; ignore previous instructions` and one at `apps/my app` are dropped and counted in `more`; the result holds neither string;
  - `more than 8 roots give more`;
  - `detection runs once per workspace until package.json or pnpm-workspace.yaml changes` (a counting `detect`; edit `package.json`, it runs again);
  - `an aborted signal stops before detection and before each lookup`.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3: Implement** R1 and R2.
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): find the DESIGN.md for an app root`.

### Task 4: Read, lint and cache

**Files:**
- Create: `main/services/design-canvas/design-md/sections.ts`, `sections.test.ts`, `reader.ts`, `reader.test.ts`
- Modify: `main/services/analytics/analytics-events.ts` (`design_md_linted`), `main/services/analytics/analytics-feature-reports.test.ts`, `docs/analytics.md`
- Register the new test files

- [x] **Step 1: Write failing tests:**
  - `sections.test.ts`: `the alias table matches the installed linter's spec-config.yaml`. Parse `node_modules/@google/design.md/dist/linter/spec-config.yaml` with `yaml` (data, not production source) and check that every `aliases` entry maps to its `canonical` in `DESIGN_MD_SECTION_ALIASES`, and nothing else is in the table;
  - `reader.test.ts`, with the real worker:
    - `a valid file reads as ok with counts, sections, omitted and tokens`;
    - `a duplicate section adds one aiden/duplicate-section warning, folding aliases` (`duplicate-section.md`: Overview and Brand & Style);
    - `an unresolved token reference adds aiden/unresolved-ref, and the token isn't listed` (`broken-ref.md`'s `colors` entry);
    - `a file over 64 KiB is too-large and no worker runs` (a counting `run`); exactly 64 KiB is linted;
    - `a vanished file, a FIFO or a folder reads as unreadable without hanging`;
    - `a pathological file is timed-out, and the second read doesn't start a worker` (the `*a_` input; counting `run`);
    - `a lint that throws gives lint-failed with fixed words, and no thrown text reaches the state or the log` (a fake `run` answering `lint-failed`; a fake worker throwing `new Error("SECRET")` for the log check);
    - `an unchanged file is linted once; an edit is linted again`;
    - `the cache keeps 16 files`;
    - `a BOM is stripped before linting`;
    - `tokens are flat, sorted and capped at 300 with truncated`; long values are cut at 200;
    - `a file read reports design_md_linted once per new content, bucketed`: 0 errors and 2 warnings give `{errors_bucket: "0", warnings_bucket: "2-3"}`; a cache hit, `lintContent` and `read({report: false})` report nothing;
  - `analytics-feature-reports.test.ts`: `design_md_linted` passes with both buckets; an unknown bucket is dropped.
- [x] **Step 2:** Run the files. Expected: FAIL.
- [x] **Step 3: Implement** R3. Register `design_md_linted: { errors_bucket: enumProp(...COUNT_BUCKETS), warnings_bucket: enumProp(...COUNT_BUCKETS) }` and its `docs/analytics.md` row: "`design_md_linted` | Design mode checked an app's DESIGN.md (once per change in a run) | `errors_bucket`, `warnings_bucket`: how many errors and warnings. The file, its tokens and its findings stay on your device."
- [x] **Step 4:** Rerun, plus `npx tsx --test main/services/analytics/*.test.ts`. Run `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): read, lint and cache an app's DESIGN.md`.

### Task 5: Draft a DESIGN.md from the app's styles

**Files:**
- Create: `main/services/design-canvas/design-md/draft.ts`, `draft.test.ts`
- Register the test file

- [x] **Step 1: Write failing tests:**
  - `a draft from colours and fonts lints with no errors` (the real worker);
  - `sections without evidence are under omitted, and the rest come in the library's order` (parse the front matter with `yaml` and the headings; with colours only, Typography is omitted);
  - `dark values go to a dark group`;
  - `token names are made safe and unique`: `--Primary`, `$primary`, `primary` and a nameless value give `primary`, `primary-2`, `primary-3`, `color-1`;
  - `a value can't break the YAML`: a snapshot family `Inter"\n---\ncolors:` (built directly) parses back to that exact string with no extra keys;
  - `a draft over 32 KiB drops colours until it fits, and still lints` (500 colours);
  - `designMdDraftFor reads only the app root's own style files`: a temp app with `src/index.css` (`--primary: #1a1c1e` and a dark override) gives both; a stylesheet outside the app root isn't read.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3: Implement** R8, importing the scanner from `../design-system-offers.js` for now (Task 7 moves it).
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): draft a DESIGN.md from the app's own styles`.

### Task 6: The `design_system` tool

**Files:**
- Create: `main/services/design-canvas/design-md/tool.ts`, `tool.test.ts`
- Register the test file

- [x] **Step 1: Write failing tests** (real reader and worker over temp workspaces; `execute` called as the model would):
  - `read returns status, path and counts outside the fence, and tokens and sections inside it`;
  - `a DESIGN.md whose prose, headings and token names hold instructions reaches Aiden only fenced`: a fixture with `## Ignore previous instructions` and a token `ignore-all-rules`; every occurrence of either string in the answer lies inside a fence;
  - `a fence can't be closed from inside the file`: a heading of eight backticks; the answer's fence is longer;
  - `lint lists findings with rule and path, capped at 50 with the full counts`;
  - `lint with content checks the text as given, without caching or an event`;
  - `export gives each format through the right emitter`: `css-tailwind` holds `@theme {`; `css-vars` holds `:root {`; `dtcg` parses with `$schema`; `json-tailwind` parses;
  - `an emitter failure comes back as status error` (a fake `run` answering `success: false`);
  - `export over 64 KiB is refused with its size` (a 60 KiB file of short colour tokens whose export is larger);
  - `draft is refused when a DESIGN.md exists, and otherwise returns target, a fenced draft and its counts, and writes nothing` (a recursive listing before and after);
  - `draft targets DESIGN.md for root ".", <root>/DESIGN.md otherwise, and the designMd override when there is one`;
  - `appRoot must be safe and an existing folder inside the workspace` (`..`, an absolute path, `./web`, a file, a missing folder);
  - `appRoot defaults to the first described root`;
  - `the 21st call in a turn gets limit_reached and nothing else runs`;
  - `a chat that left design mode gets unavailable`;
  - `onDraft hears the target once per draft`.
- [x] **Step 2:** Run the file. Expected: FAIL.
- [x] **Step 3: Implement** R4 with `Type` from `typebox` (enums for `action` and `format`; `maxLength` 200 on `appRoot` and 65 536 on `content`), `declarePiRuntimeReplay(…, "safe")` and `fenceAsData`. Description: "Read, check, export or draft the app's DESIGN.md, the design system's source of truth: its tokens, sections and lint findings, its Tailwind, DTCG or CSS-variable export, or a starter draft from the app's own styles. It never writes files; write DESIGN.md yourself with write_file after the person agrees."
- [x] **Step 4:** Rerun, `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): add the design_system tool`.

### Task 7: Move the scanner and the offer log; the draft offer and the status sentence

**Files:**
- Create: `main/services/design-canvas/design-md/style-scan.ts`, `main/services/design-canvas/offer-log.ts`, `offer-log.test.ts`, `design-md/offers.ts`, `offers.test.ts`, `design-md/status.ts`, `status.test.ts`
- Modify: `main/services/design-canvas/design-system.ts` (keeps only `designSystemOfferLine` and what it needs), `design-system-offers.ts` (uses `OfferLog` and imports the scanner), `design-md/draft.ts` (imports from `style-scan.ts`), `design-system.test.ts` and `design-system-offers.test.ts` (import paths only)
- Register the new test files

- [x] **Step 1: Guards first.** Run `design-system.test.ts` and `design-system-offers.test.ts` **(guard)**. After the move, the only edits allowed in them are import paths; any other edit means the move changed behaviour.
- [x] **Step 2: Write failing tests:**
  - `offer-log.test.ts`: a key is claimed once per run; `settle(true)` persists it for a new instance; `settle(false)` releases it; a log written by today's `DesignSystemOffers` (version 2, HMAC keys) reads unchanged; an unreadable key file gives a run-only key; 1 000 entries are kept, oldest out;
  - `offers.test.ts`: one offer per workspace and app root; another app root gets its own; no repeat after a delivered turn, even from a new instance; a repeat after an undelivered one; the log file holds no path (search its text for the temp folder name and the app root);
  - `status.test.ts`:
    - `one ok root gives its quoted path and error and warning counts, without infos`;
    - `missing, too-large, timed-out and lint-failed roots give fixed words`;
    - `three roots are named and the rest counted`;
    - `the offer sentence is appended when given`;
    - `the sentence holds no file content`: states from a hostile fixture produce a sentence with none of its strings;
    - `the note stays the same when the counts do, and changes once when they change`: `withCanvasStatusNote` with the canvas line plus the sentence for two turns with equal states adds no second message; one more warning adds one.
- [x] **Step 3:** Run the files. Expected: FAIL.
- [x] **Step 4: Implement.** Move `findWorkspaceDesignSystem`, `detectDesignSystem`, `designSystemFileRank` and their types into `design-md/style-scan.ts`, unchanged. Move the HMAC key, load, save and settle code into `OfferLog` without changing the file format or the key file; `DesignSystemOffers` keeps its public methods. `DesignMdOffers` keys by `keyFor(path.resolve(workspaceRoot), appRoot)`.
- [x] **Step 5:** Rerun the new files and the guards. Run `npx tsc --noEmit -p .`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 6:** Commit `refactor(design): move the style scanner and offer log; offer a DESIGN.md draft once per app`.

### Task 8: Wire it into design-mode turns, behind the flag

**Files:**
- Modify: `main/services/design-canvas/main.ts` (`designMdReader`, `designMdOffers`), `main/services/design-canvas/canvas-tools.ts` (`DESIGN_MD_PROMPT_BULLET`, `designModePromptSection(designLive)`, the `canvas_read` line), `canvas-tools.test.ts`, `skill.test.ts`, `main/services/llm-client.ts`, `main/services/pi-compaction-session-store.ts` (the comment at `:647`), `main/services/prompt-prefix-stability.test.ts`, `main/services/analytics/analytics-events.ts` (`design_md_drafted`), `analytics-feature-reports.test.ts`, `docs/analytics.md`
- Create: `main/services/design-canvas/design-md/turn.ts`, `turn.test.ts`
- Register the test file

`turn.ts` holds the per-turn glue, so llm-client stays thin and the glue is tested.

- [x] **Step 1: Write failing tests.**
  - `turn.test.ts`:
    - `the status sentence describes each root, and offers a draft for the first missing one`;
    - `the sentence is there but the offer isn't when the chat can't write` (`offerable: false`);
    - `the offer isn't made when ask_user_question isn't offered` (`askOffered: false`, which llm-client sets from `shouldEnableAskUserQuestionExtension` with `excluded`);
    - `settle(true) logs the offer; settle(false) leaves it for a later turn`;
    - `a draft whose target exists at a delivered turn's end sends design_md_drafted {source: "app"} once`; a missing target, or an undelivered turn, sends nothing;
    - `the canvas_read line is one sentence with the quoted path and counts`;
    - `a reader failure leaves the sentence empty and is logged`, so a broken DESIGN.md never breaks the canvas note;
    - `withDesignModeSection appends the section when absent, leaves the same messages when the latest one matches, and appends a patch when it differs` (the flag flipped since the chat's last turn);
  - `canvas-tools.test.ts`: `canvas_read includes the DESIGN.md line when the turn gives one, and not otherwise`;
  - `skill.test.ts`: `every tool the flag-on prompt section names is one a flag-on turn offers`, built from `createDesignCanvasTools` plus `createDesignSystemTool` and the names matched in `designModePromptSection(true)` (`canvas_*` and `design_system`). The existing case stays unedited;
  - `prompt-prefix-stability.test.ts`: a flag-on case (`AIDEN_EXPERIMENTAL_DESIGN_LIVE=1` set for the case and restored after). Two design-mode turns whose DESIGN.md counts differ send a byte-identical system prompt and tool list; only the `design-canvas-status` note differs. Run on the default wire and on one that keeps system messages in place, as the existing canvas cases do;
  - `analytics-feature-reports.test.ts`: `design_md_drafted` with `source: "app"` passes; `"mock"` is refused until 3d.
- [x] **Step 2:** Run the files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - `DESIGN_MD_PROMPT_BULLET`: "- The app's DESIGN.md is its design system's source of truth, ahead of design/tokens.css. Use its tokens, never one-off values, and its prose as guidance. The canvas note names it and its lint counts; design_system reads, lints and exports it. When a change adds or alters a token, update DESIGN.md in the same turn, keeping its sections in order and its YAML valid, then run design_system lint." `designModePromptSection(false)` returns today's `DESIGN_MODE_PROMPT_SECTION`.
  - `main.ts`: `designMdReader` (on `designMdLinter`, with `reportAnalyticsEvent`) and `designMdOffers` (`design-md-offers.json` under userData).
  - `llm-client.ts`:
    - add `const designLive = designLiveEnabled();` at the top of the canvas-tools block (2b reuses it);
    - hold the `shouldEnableAskUserQuestionExtension` result from `:1518` in a const, so the turn glue can read it;
    - when `designLive` and the canvas tools are built: build `createDesignMdTurn` with the canvas tools' `workspaceRoot` and `stillAvailable`, `offerable: designSystemOfferable`, `askOffered`, and the turn's `signal`; add its tool to `canvasTools` before they're declared or held, so it follows the entry, hold and windowless rules;
    - use `designModePromptSection(designLive)` for the extension's `systemPrompt`, and `withDesignModeSection` in `prepareCanvasTools` instead of the presence check at `:3249-3261`;
    - in `canvasStatusLine`, when `designLive`, append `statusSentence(signal)` to the canvas line for every turn, and skip `designSystemOffers.offerFor` (v1's tokens offer);
    - give `canvas_read` the `canvasReadLine` dep;
    - in `settleDesignSystemOffer(delivered)`, also call the turn's `settle(delivered)`.

    With the flag off none of these paths run, and the prompt text is today's.
  - `pi-compaction-session-store.ts:647`: "…and the one-time design-system or DESIGN.md offer…".
  - Register `design_md_drafted: { source: enumProp("app") }` and its row: "`design_md_drafted` | Aiden drafted an app's DESIGN.md and it was written in the same turn | `source`: app (from the app's own styles). The file and its contents stay on your device."
- [x] **Step 4:** Rerun the files, `npm run test:design-mode`, and `npx tsx --test main/services/pi-agent-runtime-harness.test.ts` (its canvas status note cases). Run `npx tsc --noEmit -p .`, `npm run lint`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): give design-mode turns the app's DESIGN.md, behind the live flag`.

### Task 9: The read-only IPC and the packaged-build checks

**Files:**
- Modify: `main/handlers/design-canvas.ts`, `main/handlers/design-canvas-main.ts`, `main/handlers/design-canvas.test.ts`, `renderer/lib/ipc.ts` (`designCanvasApi.designSystem`), `package.json` (`build.files`, the `test:design-md:packaged` script), `scripts/verify-macos-package.mjs` (+ `.test.mjs`), `scripts/verify-linux-package.mjs` (+ `.test.mjs`), `.github/workflows/release.yml`
- Create: `scripts/design-md-packaged-acceptance.mjs`

- [x] **Step 1: Write failing tests:**
  - `design-canvas.test.ts` (register and invoke):
    - `designSystem answers for an attended workspace chat with the flag on` (a temp workspace with `valid.md` as `DESIGN.md`: status `ok`, counts, sections, findings ≤ 50);
    - `it refuses with the flag off, for an unknown chat, a Bot chat, an owner chat, a chat without a folder, and an unsafe appRoot`;
    - `it works with design mode off, writes nothing, and sends no analytics event` (a recording `report`; a listing before and after);
  - `verify-macos-package.test.mjs` and `verify-linux-package.test.mjs`, on fake asars built with `@electron/asar`'s `createPackage`:
    - `the packaged lint worker and linter must be packed`: missing `build/main/design-md-lint-worker.js`, `node_modules/@google/design.md/dist/linter/index.js` or `…/dist/linter/spec-config.yaml` fails, naming the entry; an unpacked or empty entry fails;
    - `the packaged linter must lint a fixture`: the check extracts `dist/linter/` into a temp folder, imports it under Node and lints a fixed DESIGN.md; a fake linter whose `lint` throws fails;
    - `the trimmed files must be absent`: an asar with `@google/design.md/dist/index.js`, `dist/spec-config.yaml` (top level) or `node_modules/@google/design.md/node_modules/` fails.
- [x] **Step 2:** Run them. Expected: FAIL.
- [x] **Step 3: Implement.**
  - The handler per R9, behind `designLiveEnabled()`, with `designMdReader.read(…, {report: false})`.
  - `build.files` additions: `"!**/node_modules/@google/design.md/dist/index.js"`, `"!**/node_modules/@google/design.md/dist/spec.md"`, `"!**/node_modules/@google/design.md/dist/spec-config.yaml"`, `"!**/node_modules/@google/design.md/dist/linter/spec.md"`, `"!**/node_modules/@google/design.md/node_modules/**"`. Only the CLI reads the top-level `spec-config.yaml` and `spec.md` (`dist/index.js:20996`, `:24707`); the linter reads only `dist/linter/spec-config.yaml`, which stays. `dist/commands/` holds only declarations, which are already dropped, so it needs no rule.
  - `verifyPackagedDesignMdLinter(appAsar)` in `verify-macos-package.mjs`, exported, called from its own run and from `verifyLinuxPackage` (PR coverage, through `ci.yml:821`). Add `build/main/design-md-lint-worker.js` beside `pi-vcc-worker.js` in the macOS required-entries list (`:467`).
  - `scripts/design-md-packaged-acceptance.mjs`, run by `npm run test:design-md:packaged`: launch the packaged app from `release/distribution` (as `run-packaged-diagnostics-acceptance.mjs` finds it) with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`, `AIDEN_ANALYTICS=0`, a temp `--user-data-dir` and a DevTools port; through `globalThis.aidenAPI.ipc.invoke`, create a scratch workspace (`workspaces:createScratch`) and a chat in it (`chats:create`); write the `valid.md` fixture as `DESIGN.md` into the returned folder; invoke `designCanvas:designSystem`; assert `status: "ok"` and the fixture's counts. This runs the worker and the linter from inside the asar (§6.9, §11 item 1). Register the script in `scripts/ci-test-registry.json` the way the diagnostics acceptance is registered.
  - `release.yml`: a step running `npm run test:design-md:packaged` right after the `test:e2e:diagnostics:packaged` step (`:183`), on the same runner and conditions.
- [x] **Step 4:** Rerun. Then check a real package: `npm run build`, the repo's unpacked macOS build (`npx electron-builder --dir`, unsigned), `verifyPackagedDesignMdLinter` on its `app.asar` with `node --input-type=module -e`, and `npm run test:design-md:packaged` against that build if the script can point at it (it takes an app path argument). Record the asar size before and after in the PR description. The Linux check runs in CI; the macOS check and the acceptance run in the release workflow. Run `npx tsc --noEmit -p .`, `npm run lint`, `node --test scripts/main-runtime-dependencies.test.mjs`, `npm run test:ci-policy`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): read DESIGN.md over IPC and check the packaged linter`.

### Task 10: Docs, memory and the spec amendments

**Files:**
- `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`
- `docs/plans/README.md`
- `docs/design-mode.md` (create; 2b appends to it)
- `.memory/design-mode.md`
- this plan

- [x] **Step 1: Spec.** Add "### Phase DM amendments (2026-11-24)" with S33–S44 as written above, after the Phase 2a block (2b's S25–S32 block goes between them when 2b lands). In §6.9, add one line under "Reading and checking" pointing at S34–S38 and S44 (don't rewrite §6.9). In §11 item 2 (`:559`), add: "Changed by S6 (removal moves to 3d) and S37 (the scanner stays, in `design-md/style-scan.ts`)." Update the status line at the top to name this plan.
- [x] **Step 2: User guide.** Create `docs/design-mode.md` with a short intro and a "DESIGN.md (experimental)" section: it needs `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`; where the file is looked for (R1) and `apps[].designMd`; that Aiden checks it offline with the bundled linter and writes it only after asking; what 0.4.0 does and doesn't check (S38); that nothing leaves the Mac.
- [x] **Step 3: Plan index.** In `docs/plans/README.md`, extend the design mode v2 row: "Phase DM (DESIGN.md) planned 2026-11-24, plan [dm](../superpowers/plans/2026-11-24-design-mode-v2-dm-design-md.md)". When the PR opens, add its number and "in review".
- [x] **Step 4: Memory.** Add a "v2 Phase DM: DESIGN.md" section to `.memory/design-mode.md`: the module layout, the flag, the worker and its deadline, the linter facts (self-contained bundle, `spec-config.yaml` read at import, no `license` field, the S38 gaps, quadratic emphasis), the note sentence instead of a prompt line, the scanner and offer-log moves, the packaging exclusions and checks, and that DM lands before 2b. In the v2 summary at `:3`, replace "v1 `design-system*.ts` used only by `main.ts`, deleted in 3b" with "removed in 3d (S6), except the scanner, which moved to `design-md/style-scan.ts` (S37)".
- [x] **Step 5: Stale claims.** Run `rg -n "DESIGN\.md|design_system|design/tokens\.css|tokens\.css|design-system-offers|design-system\.ts|AIDEN_EXPERIMENTAL_DESIGN_LIVE" README.md PRODUCT.md docs .memory AGENTS.md packages/cli/README.md` and fix what DM made wrong. Expected:
  - README and `PRODUCT.md`: no change, since DM is behind a flag;
  - `docs/analytics.md`: the two rows;
  - `THIRD_PARTY_NOTICES.md`: Task 1's section;
  - dated plans that mention `design/tokens.css` or deleting `design-system.ts` in 3b: history, no edit.
- [x] **Step 6:** Tick this plan's boxes and commit `docs(design): Phase DM spec amendments, guide and memory`.

## Verification

Run, in order, each expected to pass:
- `npx tsx --test main/services/design-canvas/design-md/*.test.ts main/services/design-canvas/canvas-config.test.ts main/services/design-canvas/offer-log.test.ts main/services/design-canvas/design-system-offers.test.ts main/services/design-canvas/design-system.test.ts main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/skill.test.ts main/handlers/design-canvas.test.ts main/services/studio/feature-flags.test.ts`
- `npx tsx --test main/services/analytics/*.test.ts renderer/shared/design-canvas/canvas-summary.test.ts main/services/pi-agent-runtime-harness.test.ts main/services/prompt-prefix-stability.test.ts`
- `npm run test:design-mode` (Task 0's count plus the new files)
- `node --test scripts/main-runtime-dependencies.test.mjs scripts/verify-linux-package.test.mjs scripts/verify-macos-package.test.mjs`
- `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
- `npm run lint`
- `npm run test:ci-policy`
- `npm run cli:build`, then `rg -n "@google/design" packages/cli/dist` finds nothing
- `npm run build`; `build/main/design-md-lint-worker.js` exists; then Task 9 Step 4's unpacked-build checks
- E2E, flag off (nothing should change): `npm run test:e2e:space -- tests/e2e/design-mode.spec.ts tests/e2e/design-canvas.spec.ts`
- E2E, flag on (the canvas still opens and a design turn runs): `npm run test:e2e:space -- --run env AIDEN_EXPERIMENTAL_DESIGN_LIVE=1 npm run test:e2e -- tests/e2e/design-mode.spec.ts`. Normal mode doesn't pass environment variables into the Space, so the flag-on run uses `--run`.

Then `npm run test` once before the PR. CI must be green on the exact head. The release workflow runs the macOS package check and `test:design-md:packaged` before the next release.

## Risks and edge cases

For reviewers to attack:

1. **The deadline is the only guard against slow files.** Emphasis runs are quadratic in 0.4.0, so a 64 KiB file can take far longer than 2 s; the worker is terminated and the file reads as `timed-out` until it changes. The deadline runs from the worker's `ready`, so a slow load (the linter import; under tests also the `tsx` compile, about 230–300 ms locally and more on CI) doesn't eat into it; loading has its own 10 s limit, which gives `linter-unavailable`. Attack: is 2 s of lint time fair on a slow machine? Ordinary 64 KiB files lint in well under a second here. The deadline is one constant, and a `timed-out` file is re-tried only when its content changes.
2. **A worker per lint.** Each lint starts a worker (about 30 ms plus the import). The content-hash cache keeps it to once per change. Two at once and a queue of 16 bound the cost; the 19th request in flight is `busy`, not queued forever.
3. **`spec-config.yaml` at import.** The worker imports the linter, which reads it beside itself. A packaging rule that drops `dist/linter/spec-config.yaml` makes every lint `linter-unavailable`; both package checks and the acceptance catch it. Attack each `build.files` `!` pattern against `dist/linter/`.
4. **Trimming the asar.** Leaving out the CLI and the nested `node_modules` relies on the `/linter` bundle being self-contained, which Task 1's resolve-hook test and the packaged lint run prove for 0.4.0. The hoisted, unused dependencies (`remark-mdx`, `remark-frontmatter`, `citty` and their trees) still ship, about 3 MB; excluding them by name is fragile, since another dependency could start using them.
5. **Licence metadata.** The package declares no `license`, so a scanner or a future SBOM step will flag it as unknown. The notice records it by hand.
6. **Cache stability of the note.** The sentence is part of the `design-canvas-status` line, so a DESIGN.md edit adds one note on the next turn and nothing after. Attack: does anything in it change without the file changing? It holds quoted paths, counts and fixed words. `more` depends on detection, which reruns only when the root `package.json` or `pnpm-workspace.yaml` changes. A file that's `timed-out` stays so until it changes, so it doesn't flicker.
7. **The flag flip.** Turning the flag on or off changes the prompt section once per chat, through `withDesignModeSection`'s patch. That's a single cache miss, and it's how the flag works in development; people don't see the flag until Phase 7.
8. **Prompt injection through DESIGN.md.** The tool never sends prose; Aiden reads it with `read_file` like any repo file. Tokens, sections, findings, exports and drafts are fenced. The note carries only checked, quoted paths. Attack the path check: can a folder or `designMd` name carry words into the note? Only `[A-Za-z0-9._@+-]` segments pass.
9. **Symlinks and races.** A `DESIGN.md` symlink inside the workspace is followed; one leading out is refused. Between `lstat` and the read, a swap to a symlink or a bigger file makes `readBounded` refuse (`O_NOFOLLOW`, cap+1), so it fails closed as `unreadable`.
10. **Exact-name lookup.** Only `DESIGN.md` counts. A repo with `design.md` gets "missing" and a draft offer; `apps[].designMd` can point at any `.md` file.
11. **0.4.0's gaps** (S38). An unresolved token-group reference is now an `aiden/unresolved-ref` warning, and the token is left out of `read`'s tokens and the exports, so Aiden can see it's missing. A cycle shows the same way. Motion and Voice & Content Strategy sections pass silently; 3b's skill text should say so.
12. **The offer asks once.** A person who said no isn't asked again in that workspace and app root. They can still ask Aiden, or use Draft DESIGN.md on the Styles frame in Phase 5. Two chats in one workspace starting turns together could both get the offer, as v1 accepts.
13. **v1 and v2 side by side.** With the flag on, the tokens offer is off, but the v1 skill still talks about `design/tokens.css`; the bullet says DESIGN.md comes first. 3b rewrites the skill and 3d removes the offer.
14. **Detection cost.** At most one detection per workspace until its root manifests change, and only on flag-on design turns. Its reads are bounded by 2a; a monorepo with 100 candidates resolves only 8 roots.
15. **Shared pieces with 2b.** DM creates `designLiveEnabled` and `canvas-config.ts` (including `inspectCanvasConfig`'s version rule and `describedRoots`), and 2b reuses them; 2b's D4 should call `describedRoots` rather than restate it, and its writer should write `version: 1` and refuse `invalid` or `unsupported-version` files. Both plans use the same definition: `1`, `true`, `yes` and `on`.

## Open questions

All seven from the first draft were agreed by both reviews:
1. DM behind the live flag: yes (S33).
2. A fourth `draft` action: yes (S36).
3. The scanner: kept and moved into `design-md/style-scan.ts` in DM (S37).
4. An IPC with no UI yet: yes (S41).
5. Trimming the asar: yes (S42), with the corrected file list.
6. `designMd` relative to the workspace root: yes (S39).
7. Infos in the note: no.

## As built (2026-11-24): deviations

- Drafts list only token groups under `omitted`: 0.4.0 accepts only `colors`, `typography`, `rounded`, `spacing` and `components` there (anything else is `unknown-omission`), so prose sections without evidence are left out instead.
- `locateDesignMd` takes an optional fourth `{ signal }`; `LocatedDesignMd.invalid` adds `"unsafe-path"`.
- The lint client's options add `onReady`, `onOutput` and `log`; the worker's stdout is drained as well as stderr, since `LOG_STREAM` and `LOG_TOKENS` print there. `designMdLinter` in `main.ts` wraps `runDesignMdWorker` to pass the main-process logger.
- The `canvas_read` dep is `designMdLine` (the plan's `canvasReadLine` is the turn method that feeds it).
- Prompt-prefix case: the `design-canvas-status` note is a section patch, which both wires tested fold into the system head, so a changed count changes the system segment once (as v1's canvas counts do). The case checks that the tools and the assembled system prompt are byte-identical, that the telemetry names `system:design-canvas-status` as the only change, and that a third turn with unchanged counts extends the prefix exactly.
- The design-md lint worker isn't added to `verifyPackagedVccWorker`'s list: `verifyPackagedDesignMdLinter` requires it, and both package checks call that.
- `verify-linux-package.test.mjs` checks the `build.files` trim rules through `assertLinuxBuildConfiguration`; the asar-level behaviour is tested once, on the shared `verifyPackagedDesignMdLinter`, in `verify-macos-package.test.mjs`.
- `test:design-md:packaged` has no `ci-test-registry.json` entry: the registry lists test files only, and the diagnostics acceptance it mirrors isn't listed either.
- The package's own runtime dependencies (`remark-mdx`, `citty`, micromark extensions and others) became production dependencies and are packed (about 0.6 MB, 173 files), although the linter bundle doesn't load them. S42 doesn't trim them; a follow-up could.
