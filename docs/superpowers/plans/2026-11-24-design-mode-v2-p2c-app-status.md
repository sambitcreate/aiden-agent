# Design mode v2 — Phase 2c: app status, logs and attaching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person can see and control the workspace's live app from the canvas, and can use a dev server they already run.
- An **app status chip** in the canvas's top-right bar shows each app's state ("Vite · :5173", Starting…, Installing…, Crashed, Start, Connect, Choose apps…). Its menu has Start, Stop, Restart, Retry, Show logs, Disconnect, Connect, Connect again, Choose apps… and Connect running server….
- **Show logs** opens a read-only logs drawer in the canvas that follows the dev server's output. The text is plain: escape sequences are removed and hidden characters are shown as escapes.
- **Retry** after a failed install, a toolchain problem or a failed choice clears the remembered toolchain lookups. Main decides whether the retry reinstalls, and a failed choice is retried as that choice.
- **Connect running server…** lists loopback servers that the person's own processes run from this workspace's folder, read from the process and socket tables. Picking one **attaches** it. Aiden never starts, stops or signals an attached server.
- An `apps[].url` entry in `.aiden/canvas.json` attaches only after the person approves an **attach card** (S15). After that, it attaches without a card for as long as the URL, the server's address and the workspace's real folder stay the same.
- Attached servers are held to 2b's loopback rule. Their whole process subtree must belong to the person and listen on loopback only. The shared poller re-checks this every 2 s, and the server is detached when it fails.
- The **browser panel's Local servers list** shows every running design-mode app.

Everything above is behind `AIDEN_EXPERIMENTAL_DESIGN_LIVE` (default off), as 2b is.

**Architecture:**
- **Shared contract.** `renderer/shared/design-app.ts` gets these additive changes:
  - three channels;
  - the attach card's display fields;
  - two problems: `already-running` and `attach-url-invalid`;
  - the `DesignAppRunningServer` scan row and the scan's `incomplete` flag;
  - pure helpers: `logDisplayChunk` (with `logDisplayText` over it), `designAppChip`, `designAppRetryable`, `designAppAnnouncement` and `designBrowserServers`.

  No 2b field changes meaning.
- **Process readers.** `listening-ports.ts`:
  - `processTable` reads `uid` as well (one `ps -A -o pid=,ppid=,pgid=,uid=`), so `ProcessRow` gains `uid`;
  - new bounded readers: process folders (`processFolders`), process names (`processNames`) and the holder of one port (`portHolders`);
  - `processSubtree(rows, pid)`;
  - `readJobSockets` and `BackgroundJobs.designSockets` take optional attach roots. Each tick runs one `ps`, then one socket read for the jobs and a **separate** socket read for the attach roots, so a diagnostic from one side never fails the other (B-B3).
- **Aiden's own processes.** `BackgroundJobs.ownedPids(rows)` and `TerminalService.shellPids()` let the scan exclude every job tree and every descendant of Aiden that isn't under a terminal-drawer shell (A-M1).
- **Attach core.** The new `main/services/design-canvas/app-server/app-attach.ts` holds:
  - `parseAttachUrl` (pure);
  - `attachOrigin` (pure; it decides the origin from sockets, never from text);
  - `scanRunningServers(...)` and `checkAttach(...)`, which read through injected deps.

  It makes no HTTP request.
- **Service.** `DesignAppServers` gains attached entries (`source: "attached"`), a discriminated watch type, `running()`, `connect()`, `retry()`, `detach()` and a `clearToolchainCache` dependency. The rest stays as 2b built it:
  - its per-key queue, admission and presence rules;
  - `choose`'s own attempt and `choice-not-saved` (#916's `dce8fba39`);
  - its shared poller;
  - `appForOrigin` and `isAppOrigin`, which now also cover attached origins.
- **Consent.** `DesignAppConsent.request` accepts an attach card as well as a launch card, under a separate key, so the two never join or share a decline. `app-records.ts` keeps one attach approval per app root, bound to the workspace's real folder.
- **Surfaces.**
  - Three new IPC channels: `designApp:running`, `designApp:connect` and `designApp:retry`.
  - Four renderer pieces: the Connect and Choose sheets (`design-app-sheets.tsx`), the attach card (added to `design-app-consent.tsx`), the chip (`design-app-chip.tsx`) and the logs drawer (`design-app-logs.tsx`).
  - The browser listing is a main-side feed from `designAppServers.onStatus` into `browserService`, so it needs no new IPC.

**Tech Stack:** TypeScript (ESM), Electron 43 main, React renderer with Radix overlays from `renderer/components/ui.tsx`, `tsx --test` for unit and integration tests, and Playwright for one new E2E spec in the Cua Space.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`:
- §3 anti-goals 1, 2 and 4; §6.2.3 ("Attaching a server Aiden didn't start", the browser-panel line); §6.2.5;
- §8 row 2c; §9 ("Ports in use");
- §12 S2, S8 (Retry), S14, S15 (the 2c half), S25–S32 (2b) and S33–S44 (DM; `canvas-config.ts` is DM's file).

**Stacking.** 2c's branch is `t3/design-mode-v2-p2c`, cut from `t3/design-mode-v2-p2b` (PR #916, based on DM #915) at `dce8fba39` or later. This plan was checked against `459ad5258`, which adds one fix on top: a stop asked for after a choose drops the deferred choose. Task 0 checks that 2b's head has:
- `renderer/shared/design-app.ts` with the `attach` consent variant, the three `attach-*` problems and `choice-not-saved`;
- `DesignAppLogs.run` and `end`;
- `clearAppToolchainCache` in `app-toolchain.ts`;
- `BackgroundJobs.designSockets`;
- `readJobSockets`, `processTable` and `jobProcessTree` in `listening-ports.ts`, with `macSockets` failing closed on any `lsof` stderr (`62a4644c6`);
- `DesignAppServers.begin` giving `choose` its own attempt (`chooseOverRunning`) and ending an unsaved choice with `choice-not-saved` before any spawn (`dce8fba39`);
- `Entry.stops`, which lets a later stop drop a deferred choose (`459ad5258`);
- `DesignAppConsent.closeAll`.

If 2b changes after `459ad5258`, re-read its "As built" notes, update the contract-widening table (D13), and only then start.

2c's spec amendments are **S45–S56**.

## Scope

In scope:
- the status chip and its menu (§6.2.5), optimistic per the design guide's instant rule;
- Choose apps… (a sheet over 2b's `choose`);
- the read-only logs drawer, which replaces the terminal drawer of §6.2.5 (D4, S46);
- Retry (S8, 2b D6), with `clearAppToolchainCache()`;
- Connect running server…: the scan, the Connect sheet, `connect` and detaching (D6–D9);
- `apps[].url` in `.aiden/canvas.json`:
  - the parser (DM's file, extended additively);
  - the attach card;
  - the attach approval record (D10);
- attached origins in `appForOrigin`, `isAppOrigin` and `onOriginsChanged`, which are 3a's inputs;
- `design_app` on a url root (`start` attaches, `stop` detaches, `logs` refuses), with no new action (D11);
- the browser panel listing (D12);
- docs (`docs/design-mode.md`, `docs/plans/README.md`), spec amendments S45–S56, `.memory/design-mode.md`, this plan's as-built notes.

Out of scope:
- **3a:** app frames, the bridge, the network and permission dispatchers, CSP. 2c only feeds 3a its origins. S52 records that 3a's `frame-src` must also list `http://[::1]:*`, and S53 that 3a's `isAppOrigin` restriction must not block opening a design app in the browser panel.
- **3b:** `routes` and `params` in `.aiden/canvas.json`, Add ▸ Page from app, and the prompt and skill rewrite. The tool's description changes by one sentence only.
- **3d:** `mock` apps and the Node-missing and install-failed onboarding states beyond Retry.
- **4:** toasts for HMR, error frames and Fix with Aiden.
- **7:** onboarding (the tile and art) and README or PRODUCT lines. Live apps stay flagged.
- **Analytics.** §6.10 has no 2c event. Attaching sends nothing, and `design_app_started` keeps its 2b meaning (D14).
- **Choosing another script** in the Choose sheet. `DesignAppCandidate` carries one script; picking another stays with `design_app choose` or editing `.aiden/canvas.json`.
- **Remote, iOS, Android and the CLI.** Design mode is desktop-only, and nothing 2c changes reaches the Remote projection (Task 0 checks this).
- **Windows.** `hostPlatformCapabilities().backgroundJobs` is false there, so the snapshot's target is `unavailable`, the chip is hidden and the scan refuses with `unavailable`.

**Feature flag.** While `designLiveEnabled()` is false:
- the chip, the drawer, the sheets and the attach card never render. They read the renderer's `designLive` capability;
- every new `designApp:*` handler refuses with "Live apps are not available.", as 2b's do;
- `DesignAppServers` never scans, attaches or polls;
- the browser feed lists nothing, because nothing runs.

These are unflagged and inert while the flag is off:
- the `listening-ports.ts` readers (no caller; `processTable`'s extra `uid` column is read by 2b's poller but only 2c uses it);
- `BackgroundJobs.ownedPids` and `TerminalService.shellPids` (no caller);
- the canvas-config `url` parser (read only by 2c's code);
- the records' `attaches` map.

## What exists today (checked against 2b's head `459ad5258`, which is `dce8fba39` plus one choose fix)

| Item | Today | 2c action |
|---|---|---|
| `DesignAppConsentRequest` (`renderer/shared/design-app.ts:123`) | `launch` variant; `attach` variant `{ kind, requestId, chatId, workspaceId, appRoot, url }` (`:144`), which nothing builds | Attach variant gains `configUrl`, `processName`, `folder` (D10). Launch unchanged |
| `DesignAppProblem` (`design-app.ts:47-74`) | Includes `choice-not-saved` (`dce8fba39`) and the three `attach-*` problems | Adds `already-running` (B-B1) and `attach-url-invalid` (B-m4), each with its own fixed sentence |
| `DesignAppConsent.request` (`app-consent.ts:46`) | `request: LaunchConsentCard` (`:22`); key joins any pending request with the same key; `by: "aiden"` and a remembered decline answer `decline` | Accepts `LaunchConsentCard \| AttachConsentCard`. Callers pass an attach key `${ws}\0${root}\0attach` (D10). The join and decline rules are unchanged |
| `DesignAppStatus.source` (`design-app.ts:81`) | Typed `"started" \| "attached"`; `setPhase` (`app-server-main.ts:1130`) and `blankStatus` (`:476`) always write `"started"` | Both take the entry's source (B-M4) |
| `designAppProblemMessage` attach rows (`design-app.ts:257-262`) | `attach-not-loopback`: "Only a server on this computer, at 127.0.0.1, can be connected."; `attach-unreachable`: "Nothing answered at that address."; `attach-not-in-app` | New text for `attach-not-loopback` (D8), for a real non-loopback listener only. New text for `attach-unreachable` that doesn't claim a probe. No type change |
| `DESIGN_APP_CHANNELS` (`design-app.ts:164`) | 10 channels; the preload allows the `designApp:` invoke prefix | `running`, `connect`, `retry` added. The prefix already covers them; the IPC contract test needs a handler for each |
| `DesignAppHandlerDeps.servers` (`main/handlers/design-app.ts:33`) | `Pick<DesignAppServers, "snapshot" \| "start" \| "stop" \| "restart" \| "choose" \| "logs">` | Widened with `running`, `connect` and `retry` |
| `main/handlers/design-app.test.ts:97-110` | `PERSON_CHANNELS` lists six channels, and the first test asserts the registered set equals them plus `consentAnswer` | Edited on purpose: the three new channels join `PERSON_CHANNELS`, so the set and the flag-off refusal cover them (D13) |
| `DesignAppServers.stop` (`app-server-main.ts:322`) | Counts the stop in `entry.stops` (`459ad5258`), then halts the attempt and the job | For an attached entry: counts the stop the same way, then `detach()`. No job, no signal (D9) |
| `DesignAppServers.choose` (`:341`), `begin` (`:512`), `afterQueued` (`:541`), `chooseOverRunning` (`:545`) | A choose never folds into other work: it waits for a pending attempt; on a running app it stops and restarts through its own choose card (`dce8fba39`). A stop asked for after a choose drops the deferred choose (`459ad5258`). A save that isn't `"saved"` ends with `choice-not-saved` before any spawn (`:681-694`) | On a root with a live attachment, `choose` refuses with `already-running` before `begin` (B-B1). Retry after a failed choose replays the choose (B-m2) |
| `DesignAppServers.logs` (`:353`) | Reads `lastJobId`'s log with `run`/`after`; empty with no `run` when there is no job | While an attachment is live, answers empty with no `run`, even when `lastJobId` remains from an earlier started run (B-M4) |
| `DesignAppServers.designModeEntered` (`:366`) → `toggleRoots` (`:1118`) | Starts every configured root that has a `script`, or the single web app | `toggleRoots` drops url roots, `urlRefused` ones included (A-m3). Url roots attach through `attachRoots`, and a root with a live attachment starts nothing (B-B1) |
| `tick` (`:977`), `checkSockets` (`:1009`), `halt` (`:924`) | One `designSockets(ids)` per tick for every started watch; three failed reads halt with `exposure-unknown` | The watch becomes a discriminated type (A-m4). Attached watches go in the same tick as `roots`, with their own failure count (B-B3). `halt`, presence and `forgetWorkspace` route attached watches to `detach()` |
| `serve()` (`:1041`) | Adds `127.0.0.1:<port>` and the `localhost` alias always, and `[::1]:<port>` when held | For an attached entry, adds exactly the loopback origins the subtree holds on the port (B-m6), plus the `localhost` alias so 3a keeps it restricted |
| `appForOrigin` (`:399`), `isAppOrigin` (`:416`), `served` | Started servers only | Attached entries count too (D9) |
| `deps.report` (`:108`, called from `:564`) | `design_app_started` for a started run's outcome | Never called for an attach (D14) |
| `DesignAppJobs.designSockets` (`app-server-main.ts:85`) | `(jobIds) → Map<jobId, JobSockets>` | `(jobIds, roots?) → Map<string, JobSockets>`; the map is keyed by job id and by `attach:<key>` |
| `clearAppToolchainCache()` (`app-toolchain.ts:58`) | No caller. Misses are never cached; hits are | `DesignAppServers` dep `clearToolchainCache`, called by `retry` (D5) |
| `BackgroundJobs.designSockets(jobIds)` (`background-jobs.ts:829`) → `readJobSockets(groups)` (`listening-ports.ts:442`) | One `ps` and one socket read for every job's group | Optional `roots: ReadonlyMap<key, pid>`, answered from the same `ps` but a **separate** socket read (D9, B-B3) |
| `BackgroundJobs.listDesign(workspaceId)` (`:816`) | Not on `DesignAppJobs`; no IPC | Not needed: `DesignAppServers`' snapshot already carries every running origin. The browser listing is fed from `onStatus` in main (D12) |
| `BackgroundJobs` owned processes | No accessor; jobs keep `child.pid` and `adoptedGroup` | `ownedPids(rows)`: every pid in any running job's tree, from rows the caller already read (A-M1) |
| `TerminalService` (`main/services/terminal.ts:324`, singleton `:892`) | Sessions keep `pty.pid`; no accessor | `shellPids()`: the live PTY shells' pids, so servers the person starts in the terminal drawer stay listable (A-M1) |
| `processTable()` (`listening-ports.ts:297`), `ProcessRow` (`:142`) | `ps -A -o pid=,ppid=,pgid=` | `ps -A -o pid=,ppid=,pgid=,uid=`; `ProcessRow.uid`. 2b's callers ignore it (A-M3) |
| `macSockets` (`listening-ports.ts:334`) | Any `lsof` stderr fails the look closed, on exit 0 or 1; exit 1 with empty stderr is a quiet miss (`62a4644c6`) | Unchanged for jobs and checks. Discovery alone uses a `partial` option that keeps what was read and reports `incomplete` (B-B3) |
| Browser panel (`browser/service.ts:631` `observeTerminalOutput`, `renderer/components/browser-panel.tsx:373`) | `state.servers` from terminal output only, max 12, rendered as "Local servers" | `setDesignServers(workspaceId, servers)` merges design apps first (D12) |
| `canvas-config.ts` `CanvasConfigApp` | `{ root, script?, designMd? }`; unknown fields (`url`) kept for the writer | `url?: string` (canonical text) and `urlRefused?: true` (D7). `configuredRoots`/`describedRoots` unchanged |
| `app-records.ts` | `consents`, `installs`, `ports` per workspace; `parse` (`:88`) drops invalid entries; `capByAge` (`:111`) caps each map at 16 roots on write | `attaches: Record<appRoot, { origin, configUrl, workspaceReal, at }>`, parsed and capped like the others, `{}` when absent (D10) |
| Canvas top-right slot (`design-canvas.tsx:1307`, `actions` prop of `StudioCanvas`) | A "Canvas view" glass toolbar (`:1310`): Present, Expand, Panel | The chip is a sibling glass group before it (D2) |
| `QUIET_PROBLEMS` (`design-app-consent.tsx:35`), `DesignAppProblemToasts` (`:322`) | Toasts person-started problems, except four quiet ones | Attach problems and `already-running` join the quiet set; the chip and sheets show them in place (D3) |
| Canvas presence (`renderer/design/use-design-view.ts:96`) | `visible = !stacked \|\| pane === "canvas"`; main adds whether the window is shown, because macOS can report an occluded window's document hidden | The logs drawer polls on this signal, never on `document.visibilityState` (B-m1) |
| Terminal drawer (`renderer/components/terminal-drawer.tsx`) | Ghostty PTY sessions with input | Not used for logs (D4) |
| `AIDEN_RENDERER_URL` (`main/windows/window-paths.ts:20`) | The dev renderer's origin in `npm run dev` | Its port is never listed or attached (D6) |

## Decisions

**D1. What 2c adds, and what it leaves alone.**
- It keeps every 2b rule for started servers: consent, install, launch plan, readiness, exposure, presence, the workspace gate, and `choose`'s own attempt.
- It adds the attached source, three person actions (`running`, `connect`, `retry`) and the UI.
- It adds no phase. An attach uses:
  - `consent` while the card waits;
  - `starting` while it checks;
  - `running` once attached;
  - `stopped` with an `attach-*` problem when it fails or ends.
- **An attached root never launches (B-B1).** While an attachment is live on a root:
  - `start` and `retry` answer the attached status and change nothing;
  - `restart` and `choose` refuse with `already-running`: "Design mode is already connected to a server for this app, and Aiden never restarts or replaces a server it didn't start. Disconnect it first.";
  - `designModeEntered` starts nothing on it.

  The person disconnects first; after that, `start` follows D7 (a url root attaches, any other root launches as in 2b).

**D2. The chip.**
- **Where.** A glass group (`role="group"`, `aria-label="Live app"`) before the "Canvas view" toolbar in `StudioCanvas`'s `actions` slot. It is rendered while `designLive` holds and the snapshot's `target` isn't `unavailable` (B-M2).
- **One chip per workspace.** The pure `designAppChip(snapshot)` returns `{ label, tone, apps, choose, connectOnly }` or `null`:
  - `unavailable`: `null` (hidden);
  - `none` or `react-nonweb` with no apps: "Connect", `connectOnly: true`. Its menu has only Connect running server… (B-M2);
  - `choose` with nothing chosen and no apps: "Choose apps…";
  - one app: its own label;
  - several apps: "<N> apps" with the worst tone.
- **Labels.**

  | State | Label |
  |---|---|
  | Running | "<frameworkLabel> · :<port>" (attached and started alike) |
  | `installing` | "Installing…" |
  | `starting` | "Starting…" |
  | `consent` | "Waiting for approval" |
  | Crashed | "Crashed" |
  | Stopped with a problem, `choice-not-saved` included | "Not running" |
  | Stopped | "Start" (started source), "Connect" (url root), or "Connect again" (a Connect pick that detached) |
- **Tones** are a 6 px status dot: `running` uses the success token, `busy` and `neutral` the tertiary text token, and `problem` the danger token. There's no pulse, spinner or colored outline: the label carries the state.
- **Trigger.** `Button variant="bar" size="small"` with `aria-haspopup="menu"` and a full `aria-label` ("Live app: Vite, running at port 5173"). Its focus-visible ring is the shared one.
- **Announcements (B-m5).** A visually hidden `role="status"` (`aria-live="polite"`) region beside the trigger speaks two transitions only, from the pure `designAppAnnouncement(previous, next)`: running → crashed ("Vite crashed.") and attached running → stopped ("Disconnected from your server at 127.0.0.1:5173."). Nothing else is announced.
- **Menu.** `DropdownMenu` from `ui.tsx`, so it joins the layer stack and gets Escape and focus return. It has one section per app:
  - **Header:** frameworkLabel, the escaped app root (`consentDisplayText`), and one status line. The line is "Running at 127.0.0.1:5173", "Connected to your server at [::1]:5173", or the fixed `designAppProblemMessage`. It never shows log text.
  - **Items for a started app:** Start (stopped), Stop (running, starting, installing or consent), Restart (running or crashed), Retry (D5), Show logs (once a run exists).
  - **Items for an attached app:** Disconnect (running); Connect (stopped url root: runs `start`, which attaches through D10); Connect again (a stopped Connect pick: opens the Connect sheet filtered to that root, B-m3).
  - **Then:** Choose apps… (when there's more than one candidate), and Connect running server… (always, while the target isn't `unavailable`).
- **Instant rule (B-M1).** Start, Stop, Restart, Retry, Connect and Disconnect set an optimistic phase on that app at once (Starting…, Start, Starting…, Starting…, Starting… and Connect), held per `appRoot` together with the `revision` the app had when the action began.
  - **The invoke's own result settles it.** When the invoke resolves, its `DesignAppStatus` replaces the optimistic state.
  - **A refusal rolls back.** A resolved status that carries a `problem` but whose `phase` equals the phase before the action is a refusal: the chip rolls back to that phase and shows the problem inline in the menu's status line. It doesn't toast.
  - **A rejected invoke** rolls back and shows one toast with the error's message.
  - **Broadcasts** clear an app's optimistic state only when they carry a higher `revision` for that `appRoot` than the one recorded; an older or equal broadcast, or another app's, leaves it.
- **Motion.** Label changes cross-fade over `--motion-duration`. Under Reduce Motion the tokens are 0 ms, so they swap at once.

**D3. Who hears what.**
- 2b's problem toasts stay for person-started **launch** failures: they're transient feedback for an action the person took, and the chip may be off screen in the stacked layout.
- `attach-not-loopback`, `attach-unreachable`, `attach-not-in-app`, `attach-url-invalid` and `already-running` join `QUIET_PROBLEMS`. The Connect sheet shows them inline under the row; the chip menu shows them in the app's status line.
- A toggle that finds a url root's server not running shows "Not running" on the chip and never toasts, so entering design mode doesn't nag.

**D4. Logs drawer, not the terminal drawer (S46).** §6.2.5 says the terminal drawer streams the log read-only. That drawer is a Ghostty PTY surface built for input. Feeding it a dev server's raw output would hand untrusted escape sequences to a terminal emulator: OSC 52 clipboard writes, OSC 8 links, title changes. So the log opens in a canvas-local drawer:
- **Where.** Inside the canvas region, docked to the bottom, 40% of the canvas height (min 160 px, max 60%). It's a `useLayer(open, "panel", { onEscape })` surface, so Escape closes it and focus returns to the chip through `returnFocus`. One drawer shows one app at a time.
- **Reading (B-B2).**
  - **Probe.** The first read is `designApp:logs(chatId, appRoot, { after: 0 })`. It gives the run and its `end`.
  - **Tail start.** When `end` is at most 256 KiB, the probe's text is the first chunk and reading continues from its `next`. Otherwise the probe's text is dropped, one "Earlier output was dropped" line is shown, and reading restarts at `{ run, after: end − 256 KiB }`.
  - **Catching up.** While a read's `next` is below its `end` and the read advanced, the next read is sent at once (each read is at most 64 KiB). A read that didn't advance waits for the next poll.
  - **Polling.** Otherwise one read every 1 s, while the drawer is open and the canvas presence signal (`useDesignPane`'s `!stacked || pane === "canvas"`, the same one `useDesignView` reports) says the canvas is visible (B-m1). It never reads `document.visibilityState`, which macOS reports hidden for an occluded window.
  - **Run changes.** The cursor is `{ run, next }`. A response whose `run` differs, or that comes back `truncated`, adds a muted separator line ("New run" or "Earlier output was dropped") before its text, and resets the cleaner's carry (below).
  - Polling stops when the drawer closes or the app is gone from the snapshot.
- **Character boundaries.** Main decodes each read with `Buffer.toString("utf8")`, so a read that ends inside a multi-byte character would turn both halves into U+FFFD. `readDesignLog` therefore ends `next` before an incomplete trailing UTF-8 sequence (at most 3 bytes) while the job runs, and a read that starts on continuation bytes skips them (at most 3). That is how the decision's "carry partial UTF-8 bytes" is applied: the bytes stay in the log and arrive whole in the next read. A job that has ended returns its last bytes as they are, so `next` always reaches `end`.
- **Cleaning across chunks (B-M5, A-m2).** The pure `logDisplayChunk(text, carry) → { text, carry }` cleans one chunk with state from the last:
  - it removes CSI, OSC (BEL- or ST-terminated), DCS, SOS, PM, APC and two-byte ESC sequences;
  - an unterminated sequence at the chunk's end (a lone ESC, an ESC `[` with no final byte, an OSC or DCS with no terminator) goes into `carry.pending` and is cleaned with the next chunk; a pending sequence over 4 KiB is dropped whole;
  - it turns `\r\n` and a lone `\r` into `\n`. A trailing `\r` waits in `carry.pending`, so a `\r\n` split across chunks gives one newline;
  - it keeps `\t`;
  - it caps each line at 4 KiB. The rest of a long line is counted in `carry.dropped` (across chunks) and replaced, when its newline arrives, by " [N more characters]";
  - it passes the rest through `consentDisplayText`, so any control or hidden character left shows as `\u{…}`.

  `logDisplayText(text)` is `logDisplayChunk(text, emptyCarry)` with any pending text shown escaped, for one-off strings.
- **Bounds.** Each cleaned chunk is appended as its own text node; the drawer never rebuilds one big string. Past 256 KiB in total, the oldest chunks go, the new first chunk loses its text up to its first `\n`, and one "Earlier output was dropped" line stays on top.
- **Text.** React text nodes in a `<pre>`. It's never `dangerouslySetInnerHTML` and never turned into links.
- **Accessibility.** The `<pre>` is `role="log"` with `aria-live="off"` (the output is too chatty to announce) and `tabIndex=0` with the focus-visible ring, so the keyboard can scroll it.
  - The drawer follows the tail while scrolled to the bottom. When the person scrolls up, a "Jump to latest" bar button appears.
  - The header has the app's label, its status line, and a Close bar button with `aria-label="Close logs"`.
- **Motion.** It enters with `--motion-large-duration` and `--motion-large-easing` (a 4 px rise plus a fade), and `usePresence` waits for the exit. Under Reduce Motion it appears and goes at once.
- **Attached apps have no logs.** Aiden doesn't own their output, so the menu doesn't offer Show logs for them, and main answers an empty read with no `run` while an attachment is live (D9).

**D5. Retry (S8, S47).**
- **Who sees it.** `designAppRetryable(status)` is true when a started app is stopped with one of these problems:
  - `install-failed` or `install-timeout`;
  - a toolchain problem (`node-missing`, `manager-missing`, `manager-conflict`, `unsupported-manager`);
  - `not-ready`, `exposure-unknown`, `recovery-failed` or `choice-not-saved`;
  - or the app is `crashed`.

  For `exposed` it isn't offered, because the script has to change first; the status line says how. Restart remains. It is never offered for an attached app.
- **The channel.** `designApp:retry(chatId, appRoot)` → `DesignAppServers.retry(input)`. The renderer never decides whether to reinstall or which script to run. Main:
  1. answers the attached status unchanged when an attachment is live on the root (B-B1);
  2. calls `deps.clearToolchainCache()` (wired to `clearAppToolchainCache()`), so a Node or manager the person just installed or moved is found again;
  3. when the entry's last attempt was a `choose` that ended with a problem (`entry.lastChoose = { script? }`, set when a choose attempt ends stopped and cleared when one succeeds), replays `choose({ ...input, script })`, so the choose card shows again and the choice is saved (B-m2);
  4. otherwise runs `restart({ ...input, install: true })` when the entry's last problem is `install-failed` or `install-timeout`, or when the entry is `crashed` and `missingModuleHint(tail)` matches;
  5. runs `restart(input)` otherwise.

  Every 2b rule still applies: refusals, consent (a forced install with `installShown: false` asks again), the workspace gate and the per-key queue.
- **Url roots** have no Retry. Their menu item is Connect, which runs `start` (D7, D10). A detached Connect pick has Connect again (D2).
- **Aiden.** `design_app` doesn't gain `retry`. It already has `restart { install }`, and 2b's missing-module hint tells it when to use it.

**D6. Which servers Connect lists (S48).** A scan runs only when the person opens Connect running server… or presses Refresh in it, and never in the background. One scan:
1. `processTable()`: every pid, ppid, pgid and uid.
2. **The person's processes, not Aiden's (A-M1, A-M3).** It keeps rows with `uid === process.getuid()` first, then removes:
   - every pid in any background job's tree, from `BackgroundJobs.ownedPids(rows)` (design jobs, follow-through jobs and adopted groups alike);
   - every descendant of `process.pid` (Aiden's own helpers, its renderer and GPU processes, MCP servers it spawned), except processes inside the subtree of a terminal-drawer shell from `TerminalService.shellPids()`, which are the person's.
3. `processFolders(kept, deps)`: each kept process's working folder.
   - macOS: one `lsof -nP -a -d cwd -Fpn -u <uid>` call (2 s timeout, 4 MiB buffer). Folders come back canonical; there is no per-process `realpath`.
   - Linux: `readlink /proc/<pid>/cwd` for each kept pid only (the uid filter runs before any `readlink`); EACCES and ENOENT skip that pid. At most 4 096 pids; past that, the scan fails closed with `ok: false`.
   - **Partial reads (B-B3).** `lsof` stderr, or a skipped pid on Linux, doesn't fail discovery: the scan keeps what it read and sets `incomplete: true`. A timeout, a buffer overrun or an exit other than 0 or 1 fails it.
4. It keeps the pids whose folder is the workspace's `realpath` or inside it. Containment is `relative()` with no leading `..` and not absolute. It is never a string-prefix test, so `apps/web2` isn't inside `apps/web`. The workspace `realpath` is read once per scan.
5. `listeningSocketsByProcess(kept, deps, { partial: true })`: 2b's reader, which here keeps what it read and sets `incomplete` on `lsof` stderr instead of failing. Aiden's own pid is already excluded.
6. `processNames(pidsWithSockets)`: `ps -o pid=,comm= -p <list>`. It trims `comm` to its last path segment, at most 64 characters.
7. It groups by port. A port is listed once, under the pid that holds it with no listening parent of its own in the kept set (the outermost holder).

**Excluded ports.** They're dropped before listing:
- ports below 1024;
- 9222 (the remote debugging port), 9229 (the inspector) and 24678 (Vite's legacy HMR port);
- the port of `AIDEN_RENDERER_URL` when it's set;
- any port held by a pid that step 2 removed.

**Each row** is a `DesignAppRunningServer`:
- `port`, `pid`;
- `origin`, from `attachOrigin` (D8); absent when the row isn't connectable;
- `appRoot`: the deepest of the snapshot's candidates, chosen roots and url roots whose folder holds the process's folder. A process outside every app root gets its own folder (workspace-relative, POSIX; `.` only for the workspace folder itself), so connecting it attaches that folder (B-M3);
- `folder`: the process folder relative to the workspace, POSIX, at most 200 characters;
- `processName`;
- `connectable`, with `why` when false:
  - `"beyond-loopback"`: the holder's subtree listens on a wildcard or a non-loopback address;
  - `"other-address"`: every socket on the port is loopback, but none is on `127.0.0.1`, `::ffff:127.0.0.1` or `::1` (for example `127.0.0.2`), so there is no origin to load it at (A-M2);
  - `"other-user"`: a process in the holder's subtree belongs to another user, so its sockets can't be confirmed (A-M3);
  - `"already-running"`: that app root has a started server or a pending attempt.

The scan answers `{ workspaceId, ok, incomplete, servers }`: at most 20 rows, by port. A failed step returns `{ ok: false }` with no rows, and the sheet says Aiden couldn't read the running servers. `incomplete: true` makes the sheet add "Some servers may be missing." A pick is always re-checked fail-closed by `checkAttach` (D8).

**D7. `apps[].url` (S51).** `canvas-config.ts`'s parser gains a `url` reader, `parseAttachUrl(text)` from `app-attach.ts`. It is pure and exported so DM's parser can call it.
- **Accepted:**
  - an `http:` URL whose hostname is exactly `localhost`, `127.0.0.1` or `[::1]`;
  - with an explicit port from 1024 to 65535;
  - with no username, password, query or fragment;
  - with a path that is empty or `/`;
  - in at most 256 characters.

  The entry gets `url` set to `http://<host>:<port>` as written. It's display text only, and the real origin comes from sockets (D8).
- **Refused:** anything else (`https:`, `ws:`, `192.168.x.x`, `localhost.evil.com`, `0.0.0.0`, `[::]`, a missing port, credentials, a path). The entry gets `urlRefused: true` and no `url`. The snapshot lists that root as stopped and attached-source, with `attach-url-invalid` (B-m4): "The url for this app in .aiden/canvas.json can't be connected. Use http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>, with no path." Nothing is scanned for it.
- **A url root attaches; it never launches.** When an entry has `url` or `urlRefused`, the person's toggle, Start and `design_app start` never spawn for that root, even if the entry also names a `script` (A-m3). A `url` root attaches; a `urlRefused` root answers `attach-url-invalid`. `choose` on a url root without a live attachment still saves `script` (2b behavior), but the root keeps attaching while `url` is there.
- **The root** must pass `isSafeWorkspaceRelativePath` and name an existing folder that isn't a link (an `lstat`), and its `realpath` must be inside the workspace's `realpath` (A-M6). It doesn't need to be a detected `web` candidate: a docs site with an unknown framework can be attached. Its label is the candidate's framework label when there is one, else "App".
- `configuredRoots` and `describedRoots` don't change. A new `attachRoots(config)` lists the url and `urlRefused` roots, and `toggleRoots` removes them from the launch set.

**D8. Attach checks: ownership, loopback and ports (S49).** `checkAttach({ workspacePath, appRoot, port, pid? }, deps)` looks up the port first, then the folder (A-M6). It answers one of these, in this order:
1. **The port is excluded (D6) or outside 1024–65535** → `attach-not-in-app`. That covers Aiden's renderer, its debugging ports and every job's ports.
2. **The holder.** `portHolders(port, uid, deps)`:
   - macOS: `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -u <uid> -Fpn` (2 s, 4 MiB; any stderr fails closed, as `macSockets` does since `62a4644c6`);
   - Linux: the LISTEN entries for the port in `/proc/net/tcp` and `tcp6`, then the socket inodes in `/proc/<pid>/fd` of this uid's processes only, capped at 4 096 pids and 4 096 fds each.

   No process of this user holds a listening socket on the port (on any address), or the lookup fails → `attach-unreachable`. Its text becomes "Design mode couldn't find a server of yours listening on that port." It never claims a probe.
3. **The holder is Aiden's** (D6 step 2), or **its folder isn't inside `realpath(appRoot)`**, which must itself be inside `realpath(workspace)` → `attach-not-in-app`. The folder comes from `processFolders` for that one pid, which fails closed here. For a Connect pick, a `pid` other than the port's outermost holder also lands here: the renderer's pid only selects (Q1).
4. **Any process in the holder's subtree** (`processSubtree(rows, holderPid)`, the holder plus its descendants by parent pid) **belongs to another user** → `attach-not-loopback`: Aiden can't read that process's sockets, so it can't confirm the rule (A-M3).
5. **Any listening socket in that subtree is a wildcard (`*`, `0.0.0.0`, `::`) or a non-loopback address** → `attach-not-loopback`. That's 2b's `exposedSockets`. The socket read fails closed on any `lsof` stderr. The new fixed message, for a real non-loopback listener only (B-m4): "Design mode connects only to a server that listens on this computer alone. Restart it bound to 127.0.0.1 (for example with --host 127.0.0.1 or --hostname 127.0.0.1), then connect again."
6. **`attachOrigin(subtreeSockets, port)` (A-M2)** gives:
   - `http://127.0.0.1:<port>` when the subtree holds exactly `127.0.0.1:<port>` or `::ffff:127.0.0.1:<port>`;
   - else `http://[::1]:<port>` when it holds `::1:<port>` (S52);
   - else nothing: another loopback address such as `127.0.0.2` → `attach-unreachable`.

   Never `localhost`, which another process can answer (2b D8).
7. **Otherwise it passes**, with `{ pid, ppid, origin, held, processName, folder }`, where `held` is the subtree's loopback addresses on the port.

**What is never done:**
- No HTTP request, no TCP connect and no DNS lookup. Ownership and reachability come from the socket and process tables only.
- A config url's host text never picks the origin: `localhost:4321` attaches as `127.0.0.1:4321` or `[::1]:4321`, whichever the holder actually listens on.

**D9. An attachment's lifetime (S49).**
- **The watch is its own type (A-m4).** `type Watch = StartedWatch | AttachWatch`, discriminated by `kind`:
  - `StartedWatch { kind: "started"; jobId; … }` is 2b's `ServerWatch` unchanged apart from the tag;
  - `AttachWatch { kind: "attached"; pid; ppid; port; origin; held; failedLooks; lostAt? }` has no `jobId`, so no job path can take it.
- **Registered.** `entry.watch = AttachWatch`. Status: `source: "attached"`, `phase: "running"`, `origin`, `port`, and `startedBy` for the person or Aiden. `setPhase` and `blankStatus` take the entry's source, so every later status keeps `"attached"`.
- **Served origins (B-m6).** `serve()` for an attached entry registers exactly the loopback origins its subtree holds on the port: `http://127.0.0.1:<port>` when it holds `127.0.0.1` or `::ffff:127.0.0.1`, `http://[::1]:<port>` when it holds `::1`, plus the `localhost:<port>` alias so 3a keeps that name restricted too. It never registers `127.0.0.1` for a `[::1]`-only server. A held address that appears later is added at the next tick, and `onOriginsChanged` fires. `appForOrigin` matches an attached entry when its held sockets include the exact address and port (2b's rule); `isAppOrigin` keeps the origin restricted for the session (S29).
- **Watched** by the shared poller every 2 s. Each tick calls `designSockets(jobIds, roots)` once, with `roots` mapping `attach:<key>` to the holder pid. That is one `ps`, one socket read for the started jobs and a separate socket read for the attached subtrees (B-B3), so a diagnostic line from an attached server's processes never fails the started jobs' look, and the other way round.
  - **A failed look** counts toward that attachment's own three strikes only. Three in a row detach it with `attach-unreachable` (Aiden can no longer confirm the server; the person can connect again). It never touches a started job's count, and never signals anything.
  - **The holder is gone (A-M5).** When the holder pid has left the process table, the watch looks, in the same tick, for a re-bind: the holder's old parent is still alive, and a process of the same uid in that parent's subtree holds the same address and port and passes the loopback and uid checks. Then the watch moves to that process (`pid`, `ppid`), and nothing changes on the chip. Without one, the watch waits up to 6 s (three ticks, from `lostAt`) and detaches with `attach-unreachable` if none appears. A new holder under a different parent never re-binds.
  - **The holder no longer holds the port** on the origin's address, while still alive → detach with `attach-unreachable`.
  - **Another user's process** appears in the subtree → detach with `attach-not-loopback` (A-M3).
  - **A non-loopback socket** anywhere in the subtree → detach with `attach-not-loopback`.
  - **The workspace record** losing its folder, or becoming `none`, `read-only` or a different path → detach with `no-access` or `interrupted` (2b D11).
- **`detach(entry, problem?)`** clears the watch, sets `stopped` (with the problem, or none for a person's Disconnect), and fires `onOriginsChanged`. It never calls `stopDesign`, `process.kill`, `halt`'s job path or any signal. `halt()`, presence and `forgetWorkspace` call `detach()` for an `AttachWatch` (A-m4).
- **Stop means detach.** `stop()` on an attached entry counts the stop in `entry.stops`, as 2b does since `459ad5258`, so a deferred choose is dropped, then detaches. The poll's own detaches count no stop. The tool says "Disconnected. The server keeps running." (D11.)
- **Logs.** While an attachment is live, `logs()` answers `{ text: "", from: 0, next: 0, end: 0, truncated: false }` with no `run`, whatever `lastJobId` holds from an earlier started run (B-M4).
- **Presence.** Attachments follow the same 60 s rule as started servers. Detaching then frees the poller, and the origin stays restricted. A Connect pick is not re-attached on its own; a url root re-attaches on the next toggle, Start or `design_app start`, without a card while D10's record matches.
- **`forgetWorkspace`** detaches with the rest. Quit has nothing to stop.
- **Replacing.** A Connect pick for a root that already has an attachment replaces it: the old one detaches first, in the same queued action. A Connect pick for a root with a started server or a pending attempt is refused with `already-running` (the row says `why: "already-running"`): the person stops Aiden's server first.
- **Reporting.** `deps.report` is never called for an attach, a re-bind or a detach (D14).
- **Refusals.** As 2b's `refusal()`:
  - `unavailable` (flag or platform);
  - `desktop-only` (no live desktop window owner);
  - `no-access` (permission `none` or `read-only`, or no folder).

  Attaching runs no code, but a read-only workspace gets no live apps in v2, for one rule everywhere (Q2).

**D10. Consent for attaching (S50).**
- **A Connect pick is the consent.** It's an explicit person action from a window's main frame (`rendererDocumentOwner`). The row the person picked names the address, the process and its folder, and main re-checks it (D8): the pid must still be the port's outermost holder. No card and no record: a pick lasts until it detaches.
- **A repo-supplied `apps[].url` needs the attach card (S15)** before its origin is registered. That holds whether the person's toggle, the chip's Connect, or `design_app start` asked.
  - **The card.** `{ kind: "attach", requestId, chatId, workspaceId, appRoot, url: <canonical origin>, configUrl, processName, folder }`, sent through `DesignAppConsent.request` under the key `${workspaceId}\0${appRoot}\0attach`, so it never joins or is silenced by a launch card for the same root.
  - **Binding the process (A-M4).** After Allow, main runs `checkAttach` again. It registers only when the re-check finds the same holder pid, the same `processName` and the same `folder` the card showed, and the same origin. Otherwise the card shows again with what is there now (at most twice in one attempt; then the attempt ends with `attach-unreachable`).
  - **The record.** `attaches[appRoot] = { origin, configUrl, workspaceReal, at }` in `design-apps.json`, where `workspaceReal` is the workspace's `realpath` at approval. It's written only on Allow and only after the bound re-check passes.
  - **When the card shows again:** `configUrl` changes, the canonical origin changes (for example, `::1` instead of `127.0.0.1`), the workspace's `realpath` differs from `workspaceReal`, or the workspace was forgotten.
  - **Decline.** As 2b: Not now ends with `consent-declined`, and Aiden's later `start` for that root answers `declined` without a card until the person acts.
- **Aiden can't attach anything else.** `design_app` has no connect or port argument. It can write `url` into `.aiden/canvas.json` with its ordinary file tools and their ordinary approvals; the attach card then still asks.

**D11. `design_app` (contract widening).** It has no new action or parameter. Its description gains one sentence: "A root with a url in .aiden/canvas.json is a server the person runs: start connects to it after the person approves, stop disconnects, and Aiden never starts, stops or reads the output of that server."
- **`status`** lists attached apps with `source: "attached"` and `url`.
- **`start`** on a url root attaches (D7, D10). On a live attachment it answers the attached status (D1).
- **`restart`** on a url root without a live attachment attaches, as `start` does. On a live attachment, Connect pick or url root, it refuses with `already-running` (D1).
- **`stop`** on an attached app detaches and answers `stopped` with `next`: "Disconnected. The server keeps running."
- **`logs`** on an attached app is an error result: "Aiden doesn't read the output of a server it didn't start."
- **`choose`** on a live attachment refuses with `already-running`; otherwise it is unchanged (#916's own attempt and `choice-not-saved`).
- **Unchanged:** the per-turn budget of 4 counts attach starts too, and the card wait and `stillAvailable` work as 2b built them.

**D12. The browser panel listing (S53).** The review asked for "an IPC for the browser-panel listing, because `listDesign` isn't exposed". A main-side feed does the job without one, and needs neither `listDesign` nor a new channel:
- **The feed.** `design-canvas/main.ts` subscribes `designAppServers.onStatus` and calls `browserService.setDesignServers(workspaceId, designBrowserServers(snapshot))`.
- **What it lists.** `designBrowserServers` (pure, shared) lists running apps, started and attached, as `{ url: origin + "/", label: "<frameworkLabel> · <escaped appRoot> · design mode" }`.
- **How it merges.** `BrowserService` keeps design servers apart from terminal ones. `getState().servers` is the design servers first, then the terminal list, deduplicated by URL and capped at 12. A stopped app leaves the list at the next status. The panel already renders `state.servers` and sends it over the existing `browser:event`. `BrowserServer`'s type doesn't change, so Remote and the CLI see nothing new.
- **Opening one** uses the browser panel's normal profile partition and navigation rules. 2c changes nothing there, and `isAppOrigin` isn't consulted by the browser panel. 3a's restriction of app origins applies to canvas frames on the default session only, and must not block opening the same URL in the browser panel (S53).

**D13. Contract widenings and what guards the old behaviour.**

| Contract | Widening | Guard (existing tests that must pass unedited, plus new ones) |
|---|---|---|
| `DesignAppConsentRequest` attach variant | Adds `configUrl`, `processName`, `folder` | `design-app-consent.test.tsx` launch cases; new attach-card cases |
| `DesignAppProblem` | Adds `already-running` and `attach-url-invalid` | `renderer/shared/design-app.test.ts`: every problem has a message with no log text |
| `designAppProblemMessage` | New fixed text for `attach-not-loopback` and `attach-unreachable` | As above, plus the D8 wording cases |
| `DesignAppConsent.request({ request })` | `LaunchConsentCard \| AttachConsentCard` | `app-consent.test.ts` unedited; new: an attach and a launch for one root don't join, and an attach decline doesn't silence a launch |
| `DESIGN_APP_CHANNELS` | `running`, `connect`, `retry` | `renderer/shared/design-app.test.ts` 2b cases; the IPC channel inventory test (handler per channel) |
| `DesignAppHandlerDeps.servers` | The `Pick` adds `running`, `connect`, `retry` | Type check; `main/handlers/design-app.test.ts` |
| `main/handlers/design-app.test.ts:97-110` | **Edited on purpose:** `PERSON_CHANNELS` gains the three channels, so the registered-set assertion and the flag-off loop cover them | Every 2b channel and argument list in that table is kept as is |
| `DesignAppStatus` from `setPhase`/`blankStatus` | Carry the entry's `source` | 2b status cases unedited (they only make started entries) |
| `DesignAppServers.stop` | Detaches an attached entry | `app-server-main.test.ts` 2b stop cases unedited; new: `stopDesign` and the kill dep are never called for an attached entry |
| `DesignAppServers.start`/`restart`/`choose` | A url root attaches; a live attachment answers or refuses with `already-running` (D1) | 2b start, restart and choose cases unedited (no url or attachment in their fixtures), #916's choose and stop-after-choose cases included |
| `DesignAppServers.logs` | Empty with no `run` while attached | 2b logs cases unedited |
| `DesignAppServers.retry` (new) and `entry.lastChoose` | Replays a failed choose; `choice-not-saved` is retryable | 2b's `choice-not-saved` case unedited; new retry cases |
| `appForOrigin`/`isAppOrigin`/`onOriginsChanged` | Include attached, with exact origins | 2b origin cases unedited; new attached cases |
| `designModeEntered`, `toggleRoots` | Url and `urlRefused` roots never launch; url roots attach; a live attachment starts nothing | 2b toggle cases unedited |
| `DesignAppJobs.designSockets` type | `(jobIds, roots?)`; the result map is also keyed by `attach:<key>` | 2b fakes still type-check (the parameter is optional) |
| `BackgroundJobs.designSockets(jobIds, roots?)` | Optional `roots`, a separate socket read | `background-jobs.test.ts` and `listening-ports.test.ts` 2b cases unedited; new: one `ps`, two socket reads, and a failure on one side leaves the other `ok` |
| `readJobSockets(groups, deps, roots?)` | As above | As above |
| `ProcessRow`, `processTable` | `uid` column | `listening-ports.test.ts` 2b `processTable` cases: their fake `ps` output gains a fourth column, an edit made on purpose because the command's columns changed; the assertions stay |
| `listeningSocketsByProcess(pids, deps, options?)` | `{ partial: true }` keeps what was read and reports `incomplete` | `62a4644c6`'s stderr cases unedited: without the option, any stderr still fails closed |
| `BackgroundJobs.readDesignLog` | `next` ends on a UTF-8 boundary while the job runs; a start on continuation bytes skips them | 2b `readDesignLog` cases unedited (ASCII fixtures); new split-character case |
| `BackgroundJobs.ownedPids`, `TerminalService.shellPids` | New, read-only | New cases |
| `CanvasConfigApp` | `url?`, `urlRefused?` | DM's `canvas-config.test.ts` unedited; `saveCanvasConfigApp` still keeps an unknown or `url` field byte-for-byte |
| `app-records.ts` file | `attaches` map, default `{}`; `parse` validates it and `capByAge` caps it at 16 roots | `app-records.test.ts` unedited; new: a 2b-shaped file without `attaches` keeps its consents, and a 17th attach drops the oldest |
| `design_app` tool | Url-root behaviour, `already-running`, one description sentence | `app-tool.test.ts` 2b cases unedited |
| `BrowserService.getState().servers` | Design servers first | Existing browser core tests; new merge test |

No 2b field is renamed, removed or changes type.

**D14. Analytics.** None. `design_app_started` isn't sent for attaches, and no attach property is added. §6.10 lists no 2c event, and an attach starts nothing. A Task 6 test proves `deps.report` is never called for an attach (B-m5).

**D15. Network posture.** 2c adds no network access of any kind:
- no HTTP probe, TCP connect or DNS lookup in the scan, checks or poll;
- no models.dev, catalog or registry call.

The scan, the subprocesses `lsof` and `ps`, and `/proc` reads run only on these:
- the person opening Connect, pressing Refresh or picking a row;
- an attach the toggle, Start or `design_app start` asked for;
- the attached-server poll, which lasts only while something is attached.

Nothing runs at startup, on restore, during onboarding, or while the flag is off.

## Interfaces

`renderer/shared/design-app.ts` (additive):

```ts
export const DESIGN_APP_CHANNELS = {
  /* 2b's ten */,
  running: "designApp:running",   // (chatId) → DesignAppRunningScan
  connect: "designApp:connect",   // (chatId, { port, pid }) → DesignAppStatus
  retry: "designApp:retry",       // (chatId, appRoot) → DesignAppStatus
} as const;

export type DesignAppProblem =
  | /* 2b's, choice-not-saved included */
  | { problem: "already-running" }      // D1
  | { problem: "attach-url-invalid" };  // D7

export type DesignAppConsentRequest =
  | { kind: "launch"; /* unchanged */ }
  | {
      kind: "attach"; requestId: string; chatId: string; workspaceId: string; appRoot: string;
      /** The canonical origin Aiden will register: "http://127.0.0.1:4321" or "http://[::1]:4321". */
      url: string;
      /** What .aiden/canvas.json says, as written; untrusted text. */
      configUrl: string;
      /** The holder's process name (ps comm, ≤ 64 chars); untrusted text. */
      processName: string;
      /** The holder's folder relative to the workspace, POSIX, ≤ 200 chars. */
      folder: string;
    };

export interface DesignAppRunningServer {
  port: number; pid: number;
  origin?: string;                 // only when connectable
  appRoot: string; folder: string; processName: string;
  connectable: boolean;
  why?: "beyond-loopback" | "other-address" | "other-user" | "already-running";
}
export interface DesignAppRunningScan { workspaceId: string; ok: boolean; incomplete: boolean; servers: DesignAppRunningServer[] }

export const DESIGN_APP_ATTACH_SCOPE =
  "Aiden will show this server's pages in design mode. It never starts, stops or restarts it, and approving doesn't cover what the server does.";

export interface LogCarry { pending: string; column: number; dropped: number }
export const EMPTY_LOG_CARRY: LogCarry;
export function logDisplayChunk(text: string, carry: LogCarry): { text: string; carry: LogCarry };  // D4
export function logDisplayText(text: string): string;                                              // D4, one-off
export interface DesignAppChip { label: string; tone: "neutral" | "busy" | "running" | "problem"; apps: DesignAppStatus[]; choose: boolean; connectOnly: boolean }
export function designAppChip(snapshot: DesignAppsSnapshot): DesignAppChip | null;  // D2; null = hidden
export function designAppRetryable(status: DesignAppStatus): boolean;      // D5's menu rule
export function designAppAnnouncement(previous: DesignAppStatus | undefined, next: DesignAppStatus): string | null;  // D2
export function designBrowserServers(snapshot: DesignAppsSnapshot): Array<{ url: string; label: string }>;  // D12
```

`main/services/follow-through/listening-ports.ts` (additive):
- `ProcessRow.uid`; `processTable` reads `pid=,ppid=,pgid=,uid=`;
- `processSubtree(rows, pid) → number[]`: the pid plus its descendants by parent pid;
- `readJobSockets(groups, deps?, roots?: ReadonlyMap<string, number>)`. Each `roots` key is answered from `processSubtree` over the same `ps`, with its own socket read; the answer also carries each subtree's rows (`pid`, `ppid`, `uid`) so the watch can check uids and re-bind;
- `listeningSocketsByProcess(pids, deps?, options?: { partial?: boolean })`; with `partial`, stderr gives `{ ok: true, byPid, incomplete: true }`;
- `parseLsofCwd(output) → Map<pid, string>` (the `-Fpn` format);
- `processFolders(pids, deps, { uid, maxPids, partial }) → Promise<{ ok: true; byPid; incomplete: boolean } | { ok: false; reason }>`. Without `partial` it fails closed on any stderr or skipped pid;
- `processNames(pids, deps) → Promise<{ ok: true; byPid: Map<pid, string> } | { ok: false; reason }>`;
- `portHolders(port, uid, deps) → Promise<{ ok: true; pids: number[] } | { ok: false; reason }>`. Fails closed.

`background-jobs.ts`: `designSockets(jobIds, roots?)`, `ownedPids(rows: readonly ProcessRow[]): Set<number>`, and `readDesignLog`'s UTF-8 boundary rule (D4).

`main/services/terminal.ts`: `TerminalService.shellPids(): number[]`.

`main/services/design-canvas/app-server/app-attach.ts` (new):

```ts
export function parseAttachUrl(text: unknown): { ok: true; url: string; port: number } | { ok: false };
export function attachOrigin(sockets: ReadonlyArray<{ address: string; port: number }>, port: number): string | undefined;
export function attachOrigins(sockets: ReadonlyArray<{ address: string; port: number }>, port: number): string[];  // D9 serve(): every exact origin held
export interface AttachScanDeps {
  reader: SocketReaderDeps; uid: number; self: number;
  realpath(p: string): Promise<string>; lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  excludedPorts(): ReadonlySet<number>;                      // D6 fixed list + AIDEN_RENDERER_URL's port
  ownedPids(rows: readonly ProcessRow[]): ReadonlySet<number>;  // BackgroundJobs.ownedPids
  terminalShellPids(): readonly number[];                    // TerminalService.shellPids
}
export function scanRunningServers(input: { workspacePath: string; roots: readonly string[]; busyRoots: ReadonlySet<string> }, deps: AttachScanDeps)
  : Promise<{ ok: true; incomplete: boolean; servers: DesignAppRunningServer[] } | { ok: false }>;
export function checkAttach(input: { workspacePath: string; appRoot: string; port: number; pid?: number }, deps: AttachScanDeps)
  : Promise<{ ok: true; pid: number; ppid: number; origin: string; held: string[]; processName: string; folder: string }
    | { ok: false; problem: "attach-not-loopback" | "attach-unreachable" | "attach-not-in-app" }>;
```

`DesignAppServers` (additive):

```ts
running(input: { workspaceId: string; owner?: DesignAppConsentOwner; permission: WorkspaceGatePermission }): Promise<DesignAppRunningScan>;
connect(input: { workspaceId: string; chatId: string; by: "person"; owner?: DesignAppConsentOwner; permission: WorkspaceGatePermission; port: number; pid: number }): Promise<DesignAppStatus>;
retry(input: DesignAppStartInput & { appRoot: string }): Promise<DesignAppStatus>;
// deps gain: attach: AttachScanDeps; clearToolchainCache(): void; jobs.designSockets(jobIds, roots?)
```

`DesignAppConsent.request({ key, by, request: LaunchConsentCard | AttachConsentCard, owner, signal })`.

`app-records.ts`: `attachOf(workspaceId, appRoot)` and `approveAttach(workspaceId, appRoot, { origin, configUrl, workspaceReal })`. `forgetWorkspace` drops them too.

`canvas-config.ts`: `CanvasConfigApp = { root; script?; designMd?; url?; urlRefused?: true }`, plus `attachRoots(config): Array<{ root: string; url?: string; refused: boolean }>`.

`BrowserService.setDesignServers(workspaceId, servers: Array<{ url; label }>)`, with the pure `mergeBrowserServers(design, terminal)` in `browser/core.ts`.

`renderer/lib/ipc.ts`: `designAppApi.running(chatId)`, `.connect(chatId, { port, pid })` and `.retry(chatId, appRoot)`.

Renderer components:
- `renderer/design/design-app-sheets.tsx`: `DesignAppChooseSheet` and `DesignAppConnectSheet({ chatId, filterRoot?, returnFocus })`;
- `renderer/design/design-app-consent.tsx`: the waiting store holds both kinds; `DesignAppAttachCard`;
- `renderer/design/design-app-chip.tsx`: `DesignAppChip({ chatId })`, plus `useDesignApps(chatId)`, a cache-first snapshot per workspace kept in module memory, with the per-`appRoot` optimistic layer (D2);
- `renderer/design/design-app-logs.tsx`: `DesignAppLogsDrawer({ chatId, appRoot, onClose })`.

## Global Constraints

- **Person-only scans.** Only `designApp:running` and `designApp:connect` (person, main frame) and an attach of a url root may scan. Tests prove that construction, `snapshot`, presence changes, restore and the flag-off path never call the scan deps: they throw on use.
- **Sockets decide; text never does.** An origin is registered only from a successful socket read that shows the holder's whole subtree, all of it the person's, on loopback. Every tick re-checks it, and reads fail closed. Only discovery may be partial, and every pick is re-checked.
- **Never signal what Aiden didn't start.** Tests assert that `stopDesign` and any kill dependency are never called for an attached entry, across stop, presence, forget, failure, re-bind and replace.
- **Never list Aiden's own processes.** Job trees, Aiden's descendants outside terminal shells, and Aiden's debugging ports are excluded before any row is built.
- **Relative and bounded output.** Rows, cards and statuses carry relative folders (≤ 200 characters), process names (≤ 64) and canonical origins; never absolute paths, args or environment. Process names and config URLs are untrusted text, shown through `consentDisplayText`.
- **No new network** (D15). `npm run check:aiden-rules`' `network-allowlist` stays clean.
- **UI rules** (AGENTS.md, `GUI.md`, `docs/design-guide.md`; both ChatGPT references read before styling):
  - shared squircle `Button`s (`variant="bar"` in the top bar);
  - Radix overlays from `ui.tsx` (layer stack, `keepOpenWhileComposing` where a field sits in a menu);
  - semantic tokens only;
  - no decorative borders or outlines; status in soft fills, dots and labels;
  - visible `focus-visible` rings on every non-text control;
  - the drawer's log text isn't a text input and gets the ring; any filter field in a sheet gets no ring;
  - Reduce Motion through `:root[data-reduce-motion]` and the motion tokens;
  - focus return through `returnFocus`;
  - no brain icons.
- **AGENTS.md test rules.**
  - Behavioural tests only: no source greps, no tautologies, no exact `className` strings, no snapshots of markup.
  - Each new test file is registered **in the task that adds it**: appended to `test:design-mode` in `package.json` (union, keeping every entry) and added to its lane in `scripts/ci-test-registry.json` (main in `core-git`, renderer in `renderer-other`, the real-process test in `macos`). That task then runs `npm run test:ci-policy`.
  - The new E2E spec goes in `scripts/ci-e2e-spec-map.json` in Task 14.
- **Docs** change in this PR.

## Tasks

### Task 0: Baseline

- [x] Branch `t3/design-mode-v2-p2c` from `t3/design-mode-v2-p2b` at `dce8fba39` or its later head (`459ad5258` when this plan was revised). Build the native helpers a fresh worktree needs (`npm run build:native:c`, `npm run build:vcc`).
- [x] Confirm every 2b item listed under "Stacking". In particular:
  - `rg -n "run\?: string" renderer/shared/design-app.ts` shows `DesignAppLogs.run`, and `main/handlers/design-app.ts` validates `run`;
  - `rg -n "choice-not-saved" renderer/shared/design-app.ts main/services/design-canvas/app-server/app-server-main.ts` finds the problem, its message and the throw;
  - `rg -n "chooseOverRunning|stops: number" main/services/design-canvas/app-server/app-server-main.ts` finds both;
  - `rg -n "stderr.trim" main/services/follow-through/listening-ports.ts` shows the fail-closed rule in `macSockets`.

  These are baseline checks, not tests. If anything differs, update the "What exists today" table and D13 first.
- [x] Confirm the browser state isn't in the Remote projection or the native clients: `rg -n "BrowserState|browser:event" main/services/aiden-remote* ios android packages/cli/src` finds nothing that serializes `servers`. If it does, D12 needs a Remote check before Task 9.
- [x] Run `npm run test:design-mode`, `npm run test:follow-through`, `npx tsx --test main/services/browser/core.test.ts main/services/terminal.test.ts` and `npx tsc --noEmit -p .`. Expected: PASS. Record failures as pre-existing.

### Task 1: The shared contract

**Files:**
- Modify: `renderer/shared/design-app.ts`, `renderer/shared/design-app.test.ts`

- [x] **Step 1: Write failing tests** in `design-app.test.ts`:
  - **`logDisplayChunk` and `logDisplayText`, as a table:**
    - a coloured Vite line loses its CSI codes;
    - an OSC 8 hyperlink keeps only its visible text;
    - OSC 52 (clipboard) and OSC 0 (title) vanish whole, BEL- and ST-terminated;
    - DCS vanishes whole;
    - `\r\n` and a lone `\r` become `\n`;
    - a tab survives;
    - a lone ESC (in `logDisplayText`), a bidi override and a zero-width space show as `\u{…}`;
    - `<img src=x onerror=alert(1)>` comes back unchanged as text.
  - **Across chunks (B-M5):** each case feeds the chunks through `logDisplayChunk` in turn and compares the joined output with cleaning the whole string at once:
    - an OSC 52 split after `ESC ]52;c;` leaves nothing, and none of its base64 payload shows;
    - a CSI split after `ESC [3` leaves the coloured text only;
    - `\r` at the end of one chunk and `\n` at the start of the next give one newline;
    - a 300 KiB line fed in 64 KiB chunks gives its first 4 KiB, then " [N more characters]" with N = 300 × 1024 − 4096, once its newline arrives;
    - an unterminated OSC longer than 4 KiB is dropped and the text after its eventual BEL shows.

    (The split UTF-8 character is handled in main; Task 12 tests it.)
  - **`designAppChip`:**
    - `null` for `unavailable`;
    - "Connect" with `connectOnly: true` for `none` and `react-nonweb` with no apps;
    - "Choose apps…" for `choose` with nothing chosen;
    - one running app gives "Vite · :5173" with tone `running`;
    - an attached one gives the same label;
    - each phase gives its D2 label, and a stopped app with `choice-not-saved` gives "Not running";
    - two apps give "2 apps" with the worst tone (problem over busy over running);
    - a stopped url root gives "Connect", and a stopped attached root with no url gives "Connect again".
  - **`designAppRetryable`:** true for each D5 problem, `choice-not-saved` included, and for crashed; false for `exposed`, `consent-declined`, `already-running` and any attached app.
  - **`designAppAnnouncement`:** running → crashed and attached running → stopped give their sentences; starting → running, stopped → starting and a revision bump with no phase change give `null`.
  - **`designBrowserServers`:** only running apps, origin plus `/`, the escaped root in the label, attached included.
  - **Messages:** every `DesignAppProblem` still has a message with no log text. `attach-not-loopback` mentions `127.0.0.1` and `--host`; `attach-unreachable` doesn't say anything "answered"; `already-running` and `attach-url-invalid` have their D1 and D7 sentences.
- [x] **Step 2:** `npx tsx --test renderer/shared/design-app.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** the Interfaces block. Keep the launch variant byte-for-byte. Add the two problems to every exhaustive switch over `DesignAppProblem` (`npx tsc --noEmit -p .` finds them).
- [x] **Step 4:** Rerun, plus `npx tsc --noEmit -p .`. Expected: PASS. 2b's cases in the file are unedited.
- [x] **Step 5:** Commit `feat(design): 2c's shared status, attach and log display contract`.

### Task 2: `apps[].url` and the attach record

**Files:**
- Create: `main/services/design-canvas/app-server/app-attach.ts` (only `parseAttachUrl`, `attachOrigin` and `attachOrigins` for now), `app-attach.test.ts`
- Modify: `main/services/design-canvas/canvas-config.ts`, `canvas-config.test.ts`, `app-server/app-records.ts`, `app-records.test.ts`, `package.json` (`test:design-mode`), `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests.**
  - **`parseAttachUrl`, as a table:**
    - accepted: `http://localhost:4321`, `http://127.0.0.1:5173/`, `http://[::1]:3000`;
    - refused: `https://localhost:4321`, `ws://localhost:1`, `http://192.168.1.10:3000`, `http://localhost.evil.com:3000`, `http://0.0.0.0:3000`, `http://[::]:3000`, `http://localhost`, `http://u:p@localhost:3000`, `http://localhost:3000/app`, `http://localhost:3000?x=1`, `http://localhost:80`, `http://localhost:70000`, 300 characters, a number, `null`.
  - **`attachOrigin` (A-M2):**
    - `127.0.0.1:5173` gives `http://127.0.0.1:5173`;
    - `::ffff:127.0.0.1` gives the same;
    - `::1` alone gives `http://[::1]:5173`;
    - both give `127.0.0.1`;
    - `127.0.0.2:5173` alone gives `undefined`;
    - a socket on another port gives `undefined`.
  - **`attachOrigins` (B-m6):** `127.0.0.1` and `::1` on the port give both origins; `::1` alone gives only `[::1]`; `127.0.0.2` gives none.
  - **`canvas-config`:**
    - an entry with a valid `url` parses `url`;
    - an invalid one gives `urlRefused: true` and no `url`;
    - `attachRoots` lists both, with `refused`;
    - `configuredRoots` and `describedRoots` ignore `url`;
    - `saveCanvasConfigApp` keeps a `url` field and a refused one byte-for-byte.
  - **Records:**
    - `approveAttach` then `attachOf` round-trips `origin`, `configUrl` and `workspaceReal`;
    - a 2b-shaped file with no `attaches` still returns its consent, install and port;
    - `forgetWorkspace` drops attaches;
    - an invalid `attaches` value, or an entry missing `workspaceReal`, reads as none and keeps the rest;
    - a 17th approved root drops the oldest attach and no consent.
- [x] **Step 2:** Run the three files. Expected: FAIL.
- [x] **Step 3: Implement.** `canvas-config.ts` imports `parseAttachUrl` from `app-attach.ts` (pure). That keeps DM's file free of a second parser. `app-records.ts` validates `attaches` in `parse` and caps it with `capByAge` on write, like the other maps.
- [x] **Step 4: Register** `main/services/design-canvas/app-server/app-attach.test.ts`: append it to `test:design-mode` (union) and add it to the `core-git` lane. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npx tsx --test main/services/design-canvas/design-md/*.test.ts`, since DM reads the same config. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): read apps[].url and keep attach approvals`.

### Task 3: Process readers and the per-tick socket pass

**Files:**
- Modify: `main/services/follow-through/listening-ports.ts`, `listening-ports.test.ts`, `background-jobs.ts`, `background-jobs.test.ts`

- [x] **Step 1: Write failing tests** with fake `SocketReaderDeps` that count calls.
  - **`processTable`:** parses four columns into `uid`; a line with three columns is skipped. (2b's `processTable` fixtures gain a uid column: D13.)
  - **`processSubtree`:** a pid plus its children and grandchildren; a sibling in the same process group isn't included.
  - **`parseLsofCwd`:**
    - `p123\nfcwd\nn/Users/x/app` style output;
    - a path with spaces and a newline-free unicode name;
    - malformed lines are skipped.
  - **`processFolders`:**
    - macOS runs one `lsof` with `-u <uid>`;
    - Linux reads `/proc/<pid>/cwd` only for the pids it was given, and skips EACCES and ENOENT;
    - with `partial`, `lsof` stderr or a skipped pid gives `ok: true, incomplete: true` with the folders it read; without it, both give `ok: false`;
    - more than `maxPids` processes gives `ok: false`;
    - an `lsof` timeout gives `ok: false` either way.
  - **`processNames`:**
    - parses `pid comm` where `comm` is a path with spaces, and keeps its last segment;
    - names are cut to 64 characters;
    - a `ps` failure gives `ok: false`.
  - **`portHolders`:**
    - macOS: runs `lsof -iTCP:<port> -sTCP:LISTEN -u <uid>` and returns its pids; stderr next to output gives `ok: false`;
    - Linux: maps the port's LISTEN inode in `tcp` or `tcp6` to the uid's process that holds it; another uid's process is never read;
    - nobody on the port gives `ok: true, pids: []`.
  - **`listeningSocketsByProcess(…, { partial: true })`:** stderr next to output gives `ok: true, incomplete: true` with the sockets read. Without the option, `62a4644c6`'s cases still fail closed.
  - **`readJobSockets(groups, deps, roots)` (B-B3):**
    - one `ps` and two socket reads (one for the job trees, one for the root subtrees) answer both a job group and an attach root;
    - `lsof` stderr on the roots' read fails every root and leaves the job answers `ok`; stderr on the jobs' read leaves the roots `ok`;
    - a root whose pid is gone answers `ok: true` with no sockets and no rows (D9 handles it);
    - a root's answer carries its subtree's rows with `uid`.
  - **`designSockets(jobIds, roots)`:** passes `roots` through. Called with no `roots`, it makes one socket read, exactly as before (2b's cases stay unedited).
  - **`ownedPids(rows)`:** every pid in a running design job's tree, a follow-through job's tree and an adopted group's tree; not a stopped job's; not a stranger's.
- [x] **Step 2:** Run `npx tsx --test main/services/follow-through/listening-ports.test.ts main/services/follow-through/background-jobs.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement.** Reuse `execBounded` limits: a 2 s timeout and a 4 MiB buffer. `processFolders` on macOS: `lsof -nP -a -d cwd -Fpn -u <uid>`. The jobs' socket look keeps `62a4644c6`'s rule unchanged: any stderr fails it, on exit 0 or 1, and exit 1 with empty stderr is a quiet miss. `portHolders` and the roots' read follow the same rule.
- [x] **Step 4:** Rerun, plus `npm run test:follow-through`. Expected: PASS.
- [x] **Step 5:** Commit `feat(follow-through): process folders, names and owners; a separate socket read for attached servers`.

### Task 4: The scan and the attach check

**Files:**
- Modify: `app-server/app-attach.ts`, `app-attach.test.ts`

- [x] **Step 1: Write failing tests** (fake `AttachScanDeps`; real `path` logic with a fake `realpath` map; a fake process table).
  - **Scan:**
    - lists a loopback server whose folder is `apps/web`, under root `apps/web`, with `origin`, `processName`, `folder` and `connectable: true`;
    - a folder of `apps/web2` isn't put under `apps/web`; it's listed with `appRoot: "apps/web2"` (B-M3);
    - a process in the workspace folder itself is listed with `appRoot: "."`;
    - a folder outside the workspace isn't listed;
    - a workspace path that is a symlink still matches through `realpath`, read once;
    - another user's process isn't listed, and its folder is never read (the fake `readlink` throws for it) (A-m1);
    - **Aiden's own processes (A-M1):** a pid in `ownedPids`, a child of `self`, and a grandchild of `self` aren't listed; a server under a terminal shell pid (itself a child of `self`) is listed;
    - ports 80, 9222, 9229, 24678 and the renderer's port aren't listed;
    - a holder whose child also binds `0.0.0.0` is listed with `connectable: false`, `why: "beyond-loopback"` and no `origin`;
    - a holder on `127.0.0.2` only is listed with `why: "other-address"` (A-M2);
    - a holder whose child belongs to another uid is listed with `why: "other-user"` (A-M3);
    - a root in `busyRoots` gives `why: "already-running"`;
    - a parent and a child both holding the port give one row, for the parent;
    - more than 20 servers give 20, by port;
    - `lsof` stderr in discovery gives `ok: true, incomplete: true` with the rows it could read (B-B3);
    - a failed `ps` or a timed-out read gives `{ ok: false }` with no rows;
    - **no HTTP:** a test stub on `http.request`, `https.request`, `net.connect` and `dns.lookup` counts calls; a full scan and check leave all at zero.
  - **`checkAttach`**, in D8's order (A-M6):
    - an excluded port gives `attach-not-in-app`;
    - nobody holding the port gives `attach-unreachable`, and the folder reader is never called;
    - a `portHolders` failure gives `attach-unreachable`;
    - a holder outside the app root gives `attach-not-in-app`;
    - an app root that is a link to outside the workspace gives `attach-not-in-app`;
    - a holder in `ownedPids` gives `attach-not-in-app`;
    - a stale `pid` gives `attach-not-in-app`;
    - another uid in the subtree gives `attach-not-loopback`;
    - a wildcard in the subtree gives `attach-not-loopback`;
    - `127.0.0.2` only gives `attach-unreachable`;
    - `[::1]`-only gives `http://[::1]:<port>` with `held: ["::1"]`;
    - a pass gives the pid, ppid, origin, held addresses, name and folder.
- [x] **Step 2:** `npx tsx --test main/services/design-canvas/app-server/app-attach.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** D6 and D8.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): find the person's running servers and check an attach`.

### Task 5: The consent broker takes attach cards

**Files:**
- Modify: `app-server/app-consent.ts`, `app-consent.test.ts`

- [x] **Step 1: Write failing tests** (new cases; 2b's stay unedited):
  - `an attach card is sent with kind attach and its display fields`;
  - `a launch and an attach for one root are two cards`. Different keys; neither joins the other;
  - `Not now on an attach card silences Aiden's next attach for that root, not a launch`;
  - `closeAll for the workspace closes attach cards too`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement.** Add `AttachConsentCard = Omit<Extract<DesignAppConsentRequest, { kind: "attach" }>, "requestId">` beside `LaunchConsentCard` (`app-consent.ts:22`) and widen `request` (`:46`). Export `attachConsentKey(workspaceId, appRoot)`, which `DesignAppServers` uses.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): the run-app consent broker also asks before attaching`.

### Task 6: `DesignAppServers`: attaching, detaching and Retry

**Files:**
- Modify: `app-server/app-server-main.ts`, `app-server-main.test.ts`

- [x] **Step 1: Write failing tests** with 2b's fake deps, plus a fake `attach` deps whose scan and check answers are scripted, a fake `designSockets` that takes `roots`, a `clearToolchainCache` spy, a `report` spy, and a kill spy.
  - **Connect:**
    - `connect from the person registers 127.0.0.1:<port> as running and attached; appForOrigin, isAppOrigin and onOriginsChanged include it`;
    - `a [::1]-only attachment registers [::1] and localhost, never 127.0.0.1; when it also binds 127.0.0.1 later, the next tick adds it` (B-m6);
    - `connect re-checks in main: a pid that is no longer the port's holder gives attach-not-in-app and registers nothing`;
    - `connect refuses desktop-only, no-access (none and read-only) and unavailable before any scan`;
    - `connect for a root with a started server or a pending attempt is refused with already-running and spawns nothing`;
    - `a second connect for the same root replaces the first and fires onOriginsChanged once per change`;
    - `an attach never calls deps.report` (B-m5, D14).
  - **An attached root never launches (B-B1):**
    - `start and retry on a live attachment answer the attached status and spawn nothing`;
    - `restart and choose on a live attachment refuse with already-running, spawn nothing and leave it attached`;
    - `turning design mode on with a live attachment starts nothing on that root`;
    - `after Disconnect, start on a Connect-pick root launches as in 2b`.
  - **Lifetime:**
    - `stop on an attached app detaches: phase stopped, no problem, origins changed, and stopDesign and kill are never called`;
    - `the poll detaches when the holder is alive but no longer holds the port (attach-unreachable), when a wildcard appears (attach-not-loopback), and when another uid's process joins the subtree (attach-not-loopback)`;
    - `three failed looks of the attached subtree detach it with attach-unreachable, and a started job in the same ticks keeps running and counts no failure` (B-B3);
    - `three failed looks of the started jobs halt them with exposure-unknown and leave the attachment running`;
    - `one tick makes one designSockets call carrying both the started jobs and the attached roots`;
    - **Re-bind (A-M5):** `when the holder exits and a new same-uid process under the same parent holds the same address and port within 6 s, the watch moves to it and the chip doesn't change`; `a new holder under a different parent doesn't re-bind, and the attachment detaches with attach-unreachable after three ticks`;
    - `60 s with no visible canvas detaches attached apps and stops started ones`;
    - `forgetWorkspace detaches, and a workspace path change detaches with interrupted`;
    - **No job path (A-m4):** across stop, presence, forget, failure, re-bind and replace, `stopDesign`, `halt`'s job branch and the kill spy are never called for an attached entry.
  - **Logs (B-M4):** `a root that ran as a started app and is now attached answers logs with empty text and no run`.
  - **Url roots:**
    - `turning design mode on with a url root shows the attach card with the canonical url, the config url, the process name and folder; Allow attaches and records it with the workspace realpath`;
    - **Binding (A-M4):** `when the holder pid, process name or folder differ after Allow, the card shows again with the new values and nothing registers; a second change ends with attach-unreachable`;
    - `the next toggle attaches without a card while the record matches; a changed url, ::1 instead of 127.0.0.1, or a different workspace realpath asks again`;
    - `Not now ends with consent-declined, and design_app's start for that root answers declined without a card`;
    - `a url root whose server isn't running ends stopped with attach-unreachable and shows no card`;
    - `a urlRefused root is listed stopped with attach-url-invalid, nothing is scanned, and start answers the same`;
    - `a root with both url and script attaches and never spawns` and `a urlRefused root with a script never spawns, on the toggle or on start` (A-m3).
  - **Retry:**
    - `retry after install-failed clears the toolchain cache once and restarts with install`;
    - `retry after node-missing clears the cache and starts without forcing an install`;
    - `retry after a crash whose tail shows a missing module reinstalls`;
    - `retry after choice-not-saved shows the choose card again with the same script and saves on Allow` (B-m2);
    - `retry after a choose that ended install-failed replays the choose, script included` (B-m2).
  - **Scan entry point:**
    - `running() answers the scan with busy roots marked and incomplete passed through, and refuses like connect`;
    - `construction, snapshot, presence and the flag off never call any attach or scan dep` (the deps throw).
- [x] **Step 2:** `npx tsx --test main/services/design-canvas/app-server/app-server-main.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** D1, D5 and D7–D10 inside the existing per-key queue:
  - the `Watch` union replaces `ServerWatch` on the entry; `watches()`, `tick` and `checkSockets` branch on `kind`;
  - an attach is an attempt with its own controller and admission, and goes through `begin` like any other; `start`, `restart`, `choose` and `retry` check for a live attachment before `begin` (D1);
  - `tick` builds `roots` from the attached watches and passes them to `designSockets`; `checkAttached(entry, watch, result)` holds D9's rules;
  - `serve()` takes the held origins for attached entries (B-m6);
  - `setPhase` and `blankStatus` take the entry's source;
  - `entry.lastChoose` is set when a choose attempt ends stopped and cleared when one succeeds;
  - the snapshot adds url roots (`source: "attached"`, `stopped`) and keeps 2b's `candidates` and `chosen`;
  - `toggleRoots` drops `attachRoots`; `designModeEntered` attaches the url roots that aren't attached and skips live attachments.
- [x] **Step 4:** Rerun, plus every `app-server/*.test.ts`. Expected: PASS. 2b's cases are unedited, #916's choose and stop-after-choose cases included.
- [x] **Step 5:** Commit `feat(design): attach to a person's running server, detach, and retry`.

### Task 7: `design_app` on url roots

**Files:**
- Modify: `app-server/app-tool.ts`, `app-tool.test.ts`

- [x] **Step 1: Write failing tests:**
  - `status lists an attached app with source attached and its url`;
  - `start on a url root returns running attached after the card`;
  - `restart and choose on a live attachment answer already-running with its message`;
  - `stop on an attached app answers stopped with "Disconnected. The server keeps running."`;
  - `logs on an attached app is an error result naming why`;
  - `an attach start counts toward the 4-per-turn budget`;
  - `the description names url roots once`. This asserts the tool's returned `description` contains "url", which is the tool's API output, not source text.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D11.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): design_app connects and disconnects url roots`.

### Task 8: IPC and production wiring

**Files:**
- Modify: `main/handlers/design-app.ts`, `main/handlers/design-app.test.ts`, `main/services/design-canvas/main.ts`, `main/services/terminal.ts`, `main/services/terminal.test.ts`, `renderer/lib/ipc.ts`

- [x] **Step 1: Write failing tests** (register and invoke, as 2b's):
  - In `main/handlers/design-app.test.ts`, add the three channels to `PERSON_CHANNELS` (`:97-110`). This edit is deliberate (D13): the existing first test then asserts the registered set includes them and that each refuses while the flag is off.
  - `running, connect and retry refuse from a subframe, for a Bot chat, a missing chat and a chat whose workspace has no folder`;
  - `connect validates port (an integer 1–65535) and pid (a positive integer) and refuses anything else`, including strings, floats, `0` and `70000`;
  - `retry validates the app root like restart`;
  - `connect and retry pass by person, the sender's document owner and the workspace permission`;
  - `running passes the sender's owner and the workspace permission and returns the scan`.
  - In `terminal.test.ts`: `shellPids lists each open session's shell pid and drops it when the session closes`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement.**
  - Widen `DesignAppHandlerDeps.servers`' `Pick` and register the three handlers.
  - Add `TerminalService.shellPids()`.
  - In `design-canvas/main.ts`, build the real `AttachScanDeps`:
    - `defaultSocketReaderDeps()`;
    - `process.getuid()` and `process.pid`;
    - `fs.promises.realpath` and `lstat`;
    - `excludedPorts()`: 9222, 9229, 24678 and `AIDEN_RENDERER_URL`'s port;
    - `ownedPids: (rows) => backgroundJobs.ownedPids(rows)`;
    - `terminalShellPids: () => terminalService.shellPids()`.

    Then pass `clearToolchainCache: clearAppToolchainCache` and add `designAppApi.running`, `.connect` and `.retry`. Construction still does no I/O.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/handlers/design-app.test.ts main/handlers/design-canvas.test.ts main/services/terminal.test.ts`, the IPC channel inventory test, `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): running, connect and retry over designApp IPC`.

### Task 9: The browser panel lists design apps

**Files:**
- Modify: `main/services/browser/core.ts`, `core.test.ts`, `main/services/browser/service.ts`, `main/services/design-canvas/main.ts`

- [x] **Step 1: Write failing tests** in `core.test.ts`:
  - `mergeBrowserServers puts design servers first`;
  - `dedupes a URL the terminal also printed, keeping the design label`;
  - `caps at 12`;
  - `a design server that stopped is gone at the next merge while terminal entries stay`.

  Also add a service-level case through `BrowserService` with a fake owner, if the existing service test harness allows it; otherwise the core test is the oracle, and Task 14's E2E checks the panel and opens the listed app in it.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3: Implement** D12. `observeTerminalOutput` (`service.ts:631`) merges through the same function. `setDesignServers` emits only when the list changes.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/services/browser/*.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `feat(browser): list design-mode apps under Local servers`.

### Task 10: The Choose and Connect sheets, and the attach card

Before styling, read `GUI.md`, `docs/design-guide.md` (action shapes, Motion, Color and state, Loading and optimistic updates, Layers and Escape, Focus return), `docs/chatgpt-desktop-ui-inspiration.md` (attachment and status chip, compact popover, toasts) and `docs/chatgpt-ui-element-specimen.html` (popover elevation, button vocabulary).

**Files:**
- Create: `renderer/design/design-app-sheets.tsx`, `design-app-sheets.test.tsx`
- Modify: `renderer/design/design-app-consent.tsx`, `design-app-consent.test.tsx`, `package.json` (`test:design-mode`), `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests** (Testing Library, a stub `designAppApi`, `designLive` on unless stated).
  - **Choose sheet:**
    - `lists candidates with label, escaped root, package and script`;
    - `Run calls choose for that root`;
    - `a running root's Run is disabled`;
    - `the sheet has no radio cards`. Its rows are buttons.
  - **Connect sheet:**
    - `opening scans once and shows two skeleton rows until it answers`;
    - `rows show address, process, folder and app root; Connect calls connect with that port and pid`;
    - `a beyond-loopback row is disabled and says it listens beyond this computer, with the fix`;
    - `an other-address row and an other-user row are disabled and say why`;
    - `an already-running row is disabled and says Aiden already runs this app`;
    - `a failed connect shows its fixed message under the row and keeps the sheet open`;
    - `success closes the sheet and calls returnFocus`;
    - `an incomplete scan says Some servers may be missing`;
    - `empty and failed scans say so and offer Refresh, which scans again`;
    - `with filterRoot, only that root's rows show, with a way to show all` (B-m3);
    - `process names and folders with a bidi override show escapes`.
  - **Attach card** (in `design-app-consent.test.tsx`):
    - `an attach card shows the canonical address, the config url, the process name and folder escaped, and the attach scope sentence`;
    - `Allow and Not now answer with its request id`;
    - `focus starts on Not now and Escape answers Not now`;
    - `launch and attach cards for one chat both show, oldest first`;
    - `attach problems and already-running never toast`, extending 2b's toast-host case;
    - 2b's launch cases are unedited.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3: Implement.**
  - **The Choose sheet** is a `Dialog` with a short description ("Pick the apps design mode runs. The first run of each asks you on a card.") and a row list with one `Button` each.
  - **The Connect sheet** is a `Dialog`: title "Connect running server", description "Servers you started from this workspace's folder that listen only on this computer."
  - **Each row:** the address in monospace, "<processName> · <folder>" in secondary text, and the app root. A trailing `Button` Connect (secondary). A disabled row keeps its label and gives its reason in text.
  - **No decorative borders.** Rows are separated by the inset separators the design system already uses.
  - **The attach card** follows the launch card's `Callout`:
    - title "Connect to <processName> at <address>?";
    - lines in order: ".aiden/canvas.json asks for <configUrl>", "Folder: <folder>", the app root, and `DESIGN_APP_ATTACH_SCOPE`;
    - Allow (primary) and Not now.

    The waiting store keeps both kinds by `requestId`.
  - `QUIET_PROBLEMS` (`design-app-consent.tsx:35`) gains the four attach problems and `already-running` (D3).
- [x] **Step 4: Register** `renderer/design/design-app-sheets.test.tsx`: append it to `test:design-mode` and add it to the `renderer-other` lane. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:design-mode` and `npm run check:aiden-rules`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): Choose and Connect sheets, and the attach card`.

### Task 11: The status chip and its menu

**Files:**
- Create: `renderer/design/design-app-chip.tsx`, `design-app-chip.test.tsx`
- Modify: `renderer/design/design-canvas.tsx` (mount in `actions`, `:1307`), `package.json` (`test:design-mode`), `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests** (Testing Library, a stub `designAppApi` whose invokes the test resolves by hand, `designLive` on unless stated).
  - **Visibility (B-M2):**
    - `no chip while designLive is off, or for target unavailable`;
    - `for target none, a Connect chip whose menu has only Connect running server…`;
    - `a skeleton chip on the first read only, then the label; a later broadcast updates it in place`.
  - **Labels:** `labels follow the snapshot: Vite · :5173, Starting…, Installing…, Waiting for approval, Crashed, Start, Connect, Connect again, Not running, 2 apps`.
  - **Menu:**
    - `the trigger names the app and state for screen readers and opens a menu with Enter`;
    - `a running started app offers Stop, Restart and Show logs; a stopped one offers Start; an install-failed one offers Retry, which calls retry with its root`;
    - `a choice-not-saved app shows its fixed message and offers Retry`;
    - `an attached app offers Disconnect and no Show logs, Restart or Retry`;
    - `a stopped url root offers Connect, which calls start; a detached Connect pick offers Connect again, which opens the Connect sheet filtered to its root` (B-m3);
    - `a problem shows its fixed message in the menu and never the tail`.
  - **Instant rule (B-M1):**
    - `Start shows Starting… before the invoke settles, and the invoke's own result replaces it`;
    - `a resolved status with a problem and the phase from before the action rolls back and shows the problem in the menu, with no toast`;
    - `a rejected invoke rolls back and shows one toast`;
    - `a broadcast with an older or equal revision for that app keeps the optimistic label; a higher revision replaces it; a broadcast for another app leaves it`.
  - **Announcements (B-m5):** `the status region says Vite crashed. when a running app crashes, and Disconnected from your server at … when an attached app stops; starting and running say nothing`.
  - **Escape and focus:**
    - `Escape closes the menu and focus returns to the chip`;
    - `closing the Connect sheet returns focus to the chip`;
    - `the chip keeps a visible focus-visible ring after keyboard focus`. Assert the computed `outline` under `data-input-modality="keyboard"`, not class strings.
- [x] **Step 2:** `npx tsx --test renderer/design/design-app-chip.test.tsx`. Expected: FAIL.
- [x] **Step 3: Implement** D2 and D3.
  - `useDesignApps(chatId)` reads `designAppApi.status` once per mount and subscribes to `onStatus`, filtered by the snapshot's `workspaceId`. It keeps the last snapshot per workspace in module memory, so a chat switch renders at once (cache-first). The optimistic layer sits on top, per `appRoot`, as D2 says.
  - The chip mounts the Choose and Connect sheets from Task 10 and passes itself as `returnFocus`.
- [x] **Step 4: Register** `renderer/design/design-app-chip.test.tsx`: append it to `test:design-mode` and add it to the `renderer-other` lane. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:design-mode` and `npm run check:aiden-rules`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): the live app status chip`.

### Task 12: The logs drawer

**Files:**
- Create: `renderer/design/design-app-logs.tsx`, `design-app-logs.test.tsx`
- Modify: `renderer/design/design-canvas.tsx` (drawer host), `renderer/design/design-app-chip.tsx` (Show logs opens it), `main/services/follow-through/background-jobs.ts`, `background-jobs.test.ts` (UTF-8 boundaries), `package.json` (`test:design-mode`), `scripts/ci-test-registry.json`

- [x] **Step 1: Write failing tests.**
  - **Main, in `background-jobs.test.ts`:** a running design job whose log ends with the first two bytes of a three-byte character: `readDesignLog` ends `next` before them and the text has no U+FFFD; after the third byte is written, the next read returns the whole character. A read whose `after` lands on a continuation byte starts at the next character. A stopped job whose log ends mid-character returns every byte, so `next` equals `end`.
  - **Drawer**, with fake timers, a stub `logs` that scripts responses, and a stub pane signal:
    - **Reading (B-B2):**
      - `opening probes with after 0; a run of 100 KiB keeps the probe's text and continues from its next`;
      - `a run of 1 MiB drops the probe's text, shows Earlier output was dropped, and reads from end − 256 KiB`;
      - `while next is below end the next read is sent at once; a read that doesn't advance waits a second`;
      - `then polls with run and next every second`;
      - `a response for another run adds a New run line and continues from it`;
      - `truncated adds an Earlier output was dropped line`;
      - `past 256 KiB the oldest chunks go, the first kept chunk starts at a line, and one dropped line stays on top`;
      - `polling stops when closed, when the pane signal says the canvas isn't shown, and when the app leaves the snapshot`;
      - `a hidden document with the canvas pane shown keeps polling` (B-m1).
    - **Text:**
      - `ANSI colour codes are gone and an OSC 52 sequence split across two reads leaves nothing`;
      - `an HTML string renders as text, not markup, and no link is made`.
    - **Scrolling:** `scrolled up, new output doesn't move the view and Jump to latest appears; pressing it scrolls to the end`.
    - **Keyboard:**
      - `Escape closes it through the layer stack and focus returns to the chip`;
      - `the log region is focusable by keyboard`.
    - **Motion:** `under Reduce Motion it is shown and removed without waiting`. Use `data-reduce-motion="true"` on `:root`.
- [x] **Step 2:** Run both files. Expected: FAIL.
- [x] **Step 3: Implement** D4: the drawer, and `readDesignLog`'s boundary rule.
- [x] **Step 4: Register** `renderer/design/design-app-logs.test.tsx`: append it to `test:design-mode` and add it to the `renderer-other` lane. Run `npm run test:ci-policy`.
- [x] **Step 5:** Rerun, plus `npm run test:design-mode` and `npm run test:follow-through`. Expected: PASS.
- [x] **Step 6:** Commit `feat(design): a read-only logs drawer for the app's dev server`.

### Task 13: Real processes on the host

**Files:**
- Create: `main/services/design-canvas/app-server/app-attach-process.test.ts` (lane `macos`; it also runs on Linux CI where `/proc` exists, so registered like 2b's `app-server-process.test.ts`)
- Modify: `tests/fixtures/design-app-server/server.mjs` only to add `--fake-child-wildcard` (a child that binds `0.0.0.0`) and `--respawn-child` (a parent that runs the server as a child and starts a new child when it exits). It already has `--host`, `--port`, `--fake-wildcard`, `--fake-late-wildcard` and `--fake-crash-after`.
- Modify: `package.json` (`test:design-mode`), `scripts/ci-test-registry.json`

- [x] **Step 1: Write the tests** against real processes in a temp workspace:
  - `a server started from apps/web on 127.0.0.1 is listed under apps/web with its real process name`;
  - `the same server started from outside the workspace isn't listed`;
  - `a server on 0.0.0.0 is listed as not connectable`;
  - `a server whose child binds 0.0.0.0 is listed as not connectable`;
  - `checkAttach passes for the loopback server and gives the 127.0.0.1 origin`;
  - `the test runner's own process tree is never listed` (it is the scan's `self`);
  - `after the server exits, readJobSockets with its root pid shows no sockets`;
  - `with --respawn-child, killing the child leaves a new child under the same parent holding the port, which the re-bind rule accepts` (A-M5, through `readJobSockets` and the pure re-bind helper).

  Every spawned process is killed in `after`.
- [x] **Step 2: Register** the file: append it to `test:design-mode` and add it to the `macos` lane. Run `npm run test:ci-policy`.
- [x] **Step 3:** Run on the host: `npx tsx --test main/services/design-canvas/app-server/app-attach-process.test.ts`. This exercises the darwin `lsof -d cwd` and `-iTCP` branches headlessly; it opens no window. Expected: PASS.
- [x] **Step 4:** Commit `test(design): attach scan against real servers`.

### Task 14: E2E and screenshots

**Files:**
- Create: `tests/e2e/design-app-status.spec.ts`
- Modify: `scripts/ci-e2e-spec-map.json`. Map the spec to:
  - `renderer/design/design-app-chip`, `design-app-logs` and `design-app-sheets`;
  - `renderer/design/design-app-consent`;
  - `renderer/shared/design-app.ts`;
  - `main/services/design-canvas/app-server/`;
  - `main/handlers/design-app`;
  - `main/services/browser/core.ts`;
  - `main/services/follow-through/listening-ports.ts`;
  - `main/services/terminal.ts`;
  - `tests/fixtures/design-app-server/`.

- [x] **Step 1: Write the spec.** Launch with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1` and `AIDEN_E2E_DESIGN_APP_GRACE_MS=15000`, using a temp copy of `tests/fixtures/design-app-server/` as in 2b.
  - **Chip and logs:** `the chip shows Start; Start shows the card; Allow brings "App · :<port>"; Show logs shows the fixture's printed URL line; Stop returns to Start`.
  - **Crash and Retry:** `a crashing fixture (`--fake-crash-after=<ms>`) shows Crashed with Retry; the menu status shows the fixed message`.
  - **Connect:**
    - `Connect running server lists a server the test started with node server.mjs --host 127.0.0.1 from the workspace folder; Connect shows it as running`;
    - `Aiden's own processes and the started design app aren't in the list`;
    - `Disconnect leaves the test's server answering HTTP`. The test itself makes the HTTP GET; Aiden never does.
  - **Not connectable:** `a server on 0.0.0.0 (--fake-wildcard) is listed but can't be connected`.
  - **Config url:**
    - `a .aiden/canvas.json url root asks with the attach card when design mode turns on`;
    - `Allow connects; turning design mode off and on again connects without a card`.
  - **No target:** `a workspace with no web app shows a Connect chip whose menu offers only Connect running server…`.
  - **Browser panel:** `the browser panel's Local servers lists the running design app, and opening it loads the page`.
  - **Screenshots** in the test's output folder, light and dark at 1440:
    - `design-app-chip-running`;
    - `design-app-menu`;
    - `design-app-logs`;
    - `design-app-connect`;
    - `design-app-attach-card`.
- [x] **Step 2:** Run `npm run test:e2e:space -- tests/e2e/design-app-status.spec.ts`. Then run `npm run test:e2e:space -- tests/e2e/design-app-server.spec.ts` and `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts`: 2b's spec and design mode with the flag off must be unchanged. Expected: PASS. The darwin `lsof` branches are covered by Task 13 on the host; window-opening tests run only in the Space.
- [x] **Step 3:** Commit `test(design): app status chip, logs and attach E2E`.

### Task 15: Docs, memory and spec amendments

**Files:**
- `docs/design-mode.md`, `docs/plans/README.md`, `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`, `.memory/design-mode.md`
- this plan

- [x] **Step 1: Check registration.** Every new test file was registered in its task (Tasks 2, 10, 11, 12 and 13). Run `npm run test:ci-policy` once more. Expected: PASS.
- [x] **Step 2: `docs/design-mode.md`, Live apps (experimental).** Add:
  - the chip and its states, the Connect chip in workspaces without a web app;
  - Show logs (plain text, the last 256 KiB);
  - Retry, and that a failed choice is retried as that choice;
  - Choose apps…;
  - Connect running server…: which servers are listed and why some can't be connected, with the fix (`--host 127.0.0.1`, `--hostname 127.0.0.1`); that the list may say some servers are missing; that servers started in Aiden's terminal are listed, and Aiden's own processes never are;
  - that Aiden never stops, restarts or replaces a connected server (Disconnect first), and that connections end after 60 s with no visible canvas;
  - that a server that restarts itself under the same parent (watch mode) stays connected, and any other restart needs Connect again;
  - `apps[].url` (format, loopback only, approval card, url wins over script, an invalid url never runs the script);
  - `[::1]` servers;
  - Docker and VM servers can't be connected, because their process isn't in the workspace folder;
  - the browser panel listing.
- [x] **Step 3: Spec.** Add "### Phase 2c amendments (2026-11-24)" with S45–S56 (below), and update the status line at the top to name the 2c plan.
- [x] **Step 4: Plan index.** Extend the design mode v2 row with "Phase 2c (app status, logs, attaching) planned 2026-11-24, stacked on 2b, plan [p2c](../superpowers/plans/2026-11-24-design-mode-v2-p2c-app-status.md)". Add the PR number when it opens.
- [x] **Step 5: Memory.** Add a "v2 Phase 2c: status chip and attaching" section to `.memory/design-mode.md`, covering:
  - the files;
  - the attach rules (D6–D10), the separate socket read and the re-bind grace;
  - an attached root never launches; stop means detach;
  - the logs drawer instead of the terminal, and the UTF-8 boundary rule in main;
  - Retry, including the choose replay;
  - the browser feed;
  - the contract widenings (D13);
  - the test files and lanes.

  Update the v2 summary line.
- [x] **Step 6: Stale claims.** Run `rg -n "Connect running server|terminal drawer streams|attach|apps\[\]\.url|Local servers|when its port answers" README.md PRODUCT.md docs .memory packages/cli/README.md` and fix what 2c made wrong. Expected:
  - README and PRODUCT unchanged (flagged);
  - `docs/keyboard.md` has nothing new (no shortcut added);
  - onboarding unchanged (S6: Phase 7);
  - `host-platform-capabilities.ts` unchanged.
- [x] **Step 7:** Tick this plan's boxes, add "As built" notes, and commit `docs(design): Phase 2c docs, spec amendments and memory`.

## Spec amendments S45–S56 (Task 15 writes these)

- **S45. Status chip (2c; details §6.2.5).** One chip per workspace in the canvas's top-right `actions` slot, before the Canvas view tools. It is hidden without the flag or when live apps are `unavailable`; with no web app it is a Connect chip offering only Connect running server…. It summarises several apps as "<N> apps", has no spinner or pulse, and announces only a crash and a disconnect. Its menu has Start, Stop, Restart, Retry, Show logs, Disconnect, Connect, Connect again, Choose apps… and Connect running server…. The actions are optimistic: the invoke's own result settles them, a refusal rolls back with the problem shown inline, and only a newer revision for that app replaces them.
- **S46. Logs drawer (2c; replaces §6.2.5's terminal drawer).** Logs open in a read-only drawer inside the canvas, never the PTY terminal:
  - the text is plain, with escape sequences removed (also across reads), lines capped at 4 KiB, and hidden characters shown as escapes;
  - it starts at the last 256 KiB of the run, polls by run and byte cursor while the canvas is shown, and keeps 256 KiB;
  - main ends each read on a UTF-8 character boundary while the job runs;
  - attached servers have no logs.
- **S47. Retry (2c; S8).** `designApp:retry` clears the toolchain cache, and main decides what runs: a failed choice is replayed as that choice; an install failure or a missing-module crash reinstalls; anything else restarts. Not offered for `exposed` or attached apps.
- **S48. Connect lists from the process table (2c; amends §6.2.3 and §9).**
  - §9's "Ports in use" sentence ("a dev server already running outside Aiden is attached when its port answers on the detected origin") is replaced by: "A dev server already running outside Aiden is never attached by itself. The person connects it from Connect running server…, or approves an `apps[].url` entry. Aiden reads ownership from the process and socket tables, never by contacting the port, and never stops it." (A-m5)
  - The scan runs only on the person's action.
  - It lists listening sockets of the person's own processes (by uid, read first) whose canonical folder is inside the workspace's `realpath`, each under the deepest app root holding it, or under its own folder when no root holds it.
  - It excludes every Aiden job tree, every Aiden descendant outside a terminal-drawer shell, ports below 1024, 9222, 9229, 24678 and Aiden's renderer port.
  - A partial read lists what was read and says some servers may be missing; every pick is re-checked fail-closed.
  - It makes no HTTP probe and offers no default-port suggestion.
- **S49. Attached servers (2c; amends S29's "one `lsof` per tick").**
  - **The check** finds the port's holder first, then its folder, inside `realpath(appRoot)` inside `realpath(workspace)`.
  - **The origin** comes from sockets: exactly `127.0.0.1` (or `::ffff:127.0.0.1`), else `::1`; never `localhost` and never another loopback address. Aiden serves exactly the origins the subtree holds.
  - **Ownership and loopback.** Every process in the holder's subtree must be the person's, and every socket loopback. The shared poller re-checks every 2 s, in the same `ps` as jobs but with its own socket read, so one side's failed look never fails the other.
  - **Re-binding.** A holder that exits may be replaced within 6 s by a same-uid process under the same parent holding the same address and port; anything else detaches.
  - **Detaching.** An attachment detaches when the holder is gone or stops holding the port (`attach-unreachable`), after three failed looks of its own (`attach-unreachable`), when it binds beyond loopback or another user's process joins (`attach-not-loopback`), on workspace changes, and 60 s after no canvas is visible. Stop means disconnect. Aiden never signals an attached process.
  - **No launch.** While attached, start and retry answer the attachment, and restart and choose refuse with `already-running`.
  - **Access.** Read-only and `none` workspaces can't attach.
- **S50. Attach consent (2c; S15).**
  - A Connect pick is itself the consent; main re-checks that the picked pid still holds the port.
  - An `apps[].url` needs the attach card, under its own key. Allow registers only if the re-check finds the same pid, process name and folder the card showed. The record is keyed by the canonical origin, the config text and the workspace's real folder, and the card asks again when any changes.
  - `design_app` can attach only url roots and has no connect action.
- **S51. `apps[].url` (2c; §6.3.6's example).**
  - Accepted: `http:`, a host of `localhost`, `127.0.0.1` or `[::1]`, an explicit port from 1024 to 65535, no credentials, query or fragment, and a path that is empty or `/`.
  - Anything else is `urlRefused` and shown as `attach-url-invalid`.
  - A url or refused-url root never launches, even with a `script`.
- **S52. IPv6 loopback apps (2c → 3a; amends §6.3.2).** An attached app may have the origin `http://[::1]:<port>`, since Vite on macOS often binds `localhost` to `::1` only. 3a adds `http://[::1]:*` to the main window's `frame-src` and treats `[::1]` like `127.0.0.1` in its filter. §6.3.4 already allows it.
- **S53. Browser listing (2c; §6.2.3).** A main-side feed from `onStatus` into `BrowserService`: running design apps, started and attached, are listed first in Local servers with a "design mode" label. There's no new IPC and no `BrowserServer` type change. 3a's `isAppOrigin` restriction applies to canvas frames only and must not block opening that URL in the browser panel.
- **S54. 2b contract widenings (2c).** D13's table:
  - the attach card fields and the two new problems;
  - `DesignAppConsent.request` for attach;
  - three channels and the handler `Pick`;
  - stop on attached, and start, restart, choose and retry on a live attachment;
  - logs while attached;
  - attached origins;
  - `designSockets` roots and their separate socket read;
  - `ProcessRow.uid` and the partial discovery option;
  - `readDesignLog`'s UTF-8 boundary;
  - `CanvasConfigApp.url`;
  - the records' `attaches`;
  - the new `attach-not-loopback` and `attach-unreachable` text.

  No 2b field is renamed or retyped.
- **S55. Aiden's own processes (2c).** Connect never lists, and an attach never accepts, a process in any background job's tree, a descendant of Aiden outside a terminal-drawer shell, or a port Aiden uses for debugging. Servers the person runs in Aiden's terminal drawer are theirs and are listed.
- **S56. An attached root never launches (2c).** While a root is attached, nothing spawns for it: the toggle starts nothing, start and retry answer the attachment, and restart and choose refuse with `already-running`. The person disconnects first.

## Verification

Run, in order, each expected to pass:
1. `npx tsx --test renderer/shared/design-app.test.ts main/services/design-canvas/canvas-config.test.ts main/services/design-canvas/app-server/*.test.ts main/handlers/design-app.test.ts`
2. `npx tsx --test main/services/follow-through/listening-ports.test.ts main/services/follow-through/background-jobs.test.ts main/services/browser/core.test.ts main/services/terminal.test.ts`
3. `npx tsx --test renderer/design/design-app-chip.test.tsx renderer/design/design-app-logs.test.tsx renderer/design/design-app-sheets.test.tsx renderer/design/design-app-consent.test.tsx`
4. `npm run test:design-mode` and `npm run test:follow-through`
5. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p main/tsconfig.json`
6. `npm run lint` and `npm run check:aiden-rules`
7. `npm run test:ci-policy`
8. `npm run cli:build`. This is a guard: the CLI doesn't bundle `design-canvas/`, but `listening-ports.ts`, `background-jobs.ts` and `terminal.ts` changed.
9. Host, headless: `npx tsx --test main/services/design-canvas/app-server/app-attach-process.test.ts main/services/design-canvas/app-server/app-server-process.test.ts`
10. Cua Space: `npm run test:e2e:space -- tests/e2e/design-app-status.spec.ts`, then `tests/e2e/design-app-server.spec.ts` and `tests/e2e/design-canvas.spec.ts`
11. iOS and Android: nothing to run. Check with `rg -n "designApp|BrowserServer|servers" ios/AidenOnTheGo/Networking android/app/src/main | rg -i browser` that no client reads browser `servers`, and that Task 0's Remote check holds.

Then run `npm run test` once before the PR. CI must be green on the exact head. The PR body carries the Task 14 screenshots, light and dark.

## Risks and edge cases

For reviewers to attack:
1. **Pid reuse and races.** A holder could exit and an unrelated process of the same user take the port between the check and registration, or between ticks.
   - Registration after a card requires the same pid, process name and folder the card showed (A-M4).
   - The poll requires the same pid, or a re-bind under the same live parent, to hold the same address and port every 2 s.
   - A different pid on the port under another parent detaches with `attach-unreachable`.
   - Attack: pid reuse within one 2 s window on the same port under the same parent (needs the same uid; negligible).
2. **Folder spoofing.** A process can `chdir` into the workspace and listen. That process is the person's own (same uid). Attaching it only loads its pages in frames under 3a's filter, and Aiden never runs or signals it.
   - Attack: a process of another user. It's filtered out by uid before its folder is read, and a subtree that contains one is refused.
   - Attack: a symlink inside the workspace pointing out. Containment compares canonical paths, so a folder reached through a link resolves outside and isn't listed; an app root that resolves outside is refused.
3. **Wildcard binds.** Next.js `next dev` binds `::` by default, so a person's ordinary Next server can't be connected until they pass `--hostname 127.0.0.1`. That's deliberate: it keeps 2b's rule. The sheet says why and how to fix it.
   - Attack: a server binding loopback first and a wildcard later. It's caught within 2 s, as in 2b.
4. **Grouped runners and watch mode.** Turborepo and `concurrently` run several servers under one parent. A subtree is the holder and its descendants, not the process group, so a sibling app's wildcard doesn't block a loopback app. A wildcard socket held by the runner itself (the holder's parent) isn't checked: it's not this server. The same parent is what lets a watch-mode restart re-bind (A-M5).
   - Attack: a sibling app under the same runner binding the same address and port after the holder dies. Only one process can hold an address and port, and it is the person's own server under the same runner; the re-bind is accepted and the loopback check still applies.
5. **Docker, VMs and SSH tunnels.** The holder is `com.docker.backend`, a VM process or `ssh`, whose folder isn't the workspace, so it's not listed. This is documented, and a url root says `attach-not-in-app`.
6. **`lsof` diagnostics.** Since `62a4644c6`, any stderr fails a socket look. Attached subtrees get their own read, so a noisy attached server can only detach itself. Discovery alone tolerates stderr and says the list may be incomplete; the pick is re-checked strictly.
7. **Aiden's own and terminal processes.** Excluding every descendant of Aiden hides servers Aiden spawned (MCP servers, helpers), and the terminal-shell exception keeps the person's own terminal servers. Attack: a person's server started from a background job (a follow-through job). It's Aiden's job tree, so it isn't listed; the job's own Local servers line still shows it in the browser panel.
8. **Scan cost.** On macOS, `lsof -d cwd -u <uid>` over hundreds of processes takes about 100–300 ms. It runs only on the person's action and is capped at 2 s and 4 MiB. On Linux, `readlink` runs only for the person's pids, capped at 4 096. The per-tick cost while attached is one more `lsof` over a small subtree.
9. **Log polling cost.** 1 s polls of at most 64 KiB, only while the drawer is open and the canvas shown. Catching up from `end − 256 KiB` takes at most four reads at once.
10. **Escape sequences.** The stripping is deliberately broad and carries unfinished sequences across reads, and anything it misses shows as `\u{1B}…` text, which is ugly but harmless. The terminal emulator is never fed app output.
11. **The renderer's own dev server.** Excluded by `AIDEN_RENDERER_URL`'s port, and the renderer process is Aiden's descendant. Attack: a workspace that is Aiden's own repo running a second renderer dev server on another port from the terminal drawer. That would be listed. It's a separate process serving Aiden's renderer code under 3a's frame rules, and acceptable.
12. **The flag off.** The handlers exist and refuse. Attack whether any path reaches `scanRunningServers` with the flag off: the deps throw in tests.
13. **[::1]-only origins before 3a.** 2c registers them, and 3a must add them to `frame-src` (S52). Until 3a there are no frames, so nothing breaks.
14. **A url root that's also a started root.** Url wins (D7). A saved `script` is kept for when `url` is removed. `toggleRoots` drops url and refused-url roots from the launch set, and `start` never spawns for them.
15. **Optimistic state and broadcasts.** A broadcast from before the action carries the old revision, so it can't undo the optimistic label; the invoke's own result settles it. Attack: an invoke that never settles. 2b's invokes always resolve (the consent wait ends with a problem), so the label settles.

## Review decisions applied

| Decision | Where |
|---|---|
| B-B1 Attached root can launch | D1, D5 step 1, D9 Replacing, D11, D13 (`start`/`restart`/`choose`), S56, Task 1 (`already-running`), Task 6 "An attached root never launches", Task 7 |
| B-B2 Logs drawer probe and catch-up | D4 Reading, Task 12 Reading tests |
| B-B3 Separate `lsof` for attach roots; partial discovery | Architecture, D6 steps 3 and 5, D9 Watched, D13 (`readJobSockets`, `listeningSocketsByProcess`), S48, S49, Risk 6, Task 3, Task 4, Task 6 Lifetime, Task 10 (incomplete) |
| A-M1 Aiden's own processes | Architecture, D6 step 2 and Excluded ports, Global Constraints, S55, Risk 7, Task 3 (`ownedPids`), Task 4, Task 8 (`shellPids`, 9222), Task 13 |
| A-M2 Exact origin; 127.0.0.2 | D6 `why: "other-address"`, D8 step 6, Task 2 `attachOrigin`, Task 4 |
| A-M3 Other-uid processes | D6 step 2 and `why: "other-user"`, D8 step 4, D9 Watched, Task 3 (`processTable` uid), Task 4, Task 6 |
| A-M4 Card re-check binds the process; realpath-bound approvals | D10 Binding and record, S50, Risk 1, Task 2 records, Task 6 Url roots |
| A-M5 Watch-mode re-bind grace | D9 Watched, S49, Risk 4, Q3, Task 6 Re-bind, Task 13 |
| A-M6 Holder by port first; app root inside workspace | D7 root rule, D8 steps 2–3, S49, Task 3 `portHolders`, Task 4 `checkAttach` |
| B-M1 Optimistic UI | D2 Instant rule, S45, Risk 15, Task 11 Instant rule |
| B-M2 Connect reachable without a web app | D2 Where and `connectOnly`, S45, Task 1, Task 11 Visibility, Task 14 No target |
| B-M3 Rows outside an app root | D6 `appRoot`, S48, Task 4 |
| B-M4 D13 completeness | D13 rows (`setPhase`/`blankStatus`, handler `Pick`, `designSockets` type, `capByAge`/`parse`, `choice-not-saved`, `design-app.test.ts:97-110`, logs while attached), D9 Logs, Task 2, Task 6 Logs, Task 8 |
| B-M5 / A-m2 Log cleaning across chunks | D4 Character boundaries and Cleaning, Interfaces (`logDisplayChunk`), S46, Task 1 Across chunks, Task 12 |
| B-m1 Drawer polls on the presence signal | D4 Polling, "What exists today" (canvas presence), Task 12 |
| B-m2 Retry replays a failed choose | D5 step 3, S47, Task 6 Retry |
| B-m3 Connect again opens the filtered sheet | D2 Menu, D5 Url roots, Task 10 `filterRoot`, Task 11 Menu |
| B-m4 `attach-url-invalid`; `attach-not-loopback` scope | D7 Refused, D8 step 5, S51, Task 1, Task 6 |
| B-m5 `report` never called; polite announcements | D2 Announcements, D9 Reporting, D14, Task 1, Task 6 Connect, Task 11 |
| B-m6 Exact served origins | D9 Served origins, S49, Task 2 `attachOrigins`, Task 6 Connect |
| A-m1 Uid before `readlink`; no per-process realpath | D6 steps 2–4, Task 4 |
| A-m3 `toggleRoots` drops url roots | D7, Risk 14, Task 6 Url roots |
| A-m4 Discriminated watch; detach routing | D9 The watch is its own type and Detach, Task 6 No job path |
| A-m5 §9 "when its port answers" | S48 first bullet, Task 15 Step 6 |
| B S53 note | Out of scope (3a), D12 Opening one, S53, Task 14 Browser panel |
| Q1–Q9 | Open questions below, each matching the decision |

## Open questions

Each has the answer this plan uses. Both reviewers agreed with every one.
1. **Should a Connect pick also show the attach card?** *No* (D10). The pick is an explicit person action naming the address, process and folder, and main re-checks that the pid still holds the port (A-M4). A second card would ask twice for one intent. Repo-supplied URLs still ask (S15).
2. **Attaching in a read-only workspace?** *Refuse*, as 2b refuses starts (D9), so there's one rule. Revisit in 3a if people want to view apps in read-only workspaces.
3. **Re-attach after the person's server restarts?** *Not after a manual restart*: the new process could be anything, and the chip says "Connect again", which opens the Connect sheet for that root. *Yes for a supervised restart under the same parent* within 6 s (A-M5). Url roots re-attach on the next toggle or Connect without a card while the record matches.
4. **`[::1]`-only servers?** *Support*, with the exact-origin rule (S52, B-m6). Vite's default on macOS often binds `::1` only, and refusing it would make attach useless for the most common case. 3a takes the CSP line.
5. **Keep 2b's problem toasts now that the chip exists?** *Keep them for person-started launch failures, and never for attach problems* (D3). The chip can be off screen in the stacked layout.
6. **A `design_app connect` action?** *No* (D10, D11). Aiden attaching to arbitrary ports would bypass the person's choice. It can propose a `url` entry, which still asks.
7. **Logs in the terminal drawer instead?** *No* (D4, S46). Untrusted escape sequences must not reach a terminal emulator, and the drawer is built for input.
8. **The chip with several apps?** *One chip showing "<N> apps"*, with a section per app in the menu, rather than a chip per app crowding the top bar.
9. **Should the browser listing get its own IPC, as the 2b review suggested?** *No* (D12). The browser state already reaches the panel over `browser:event`. A main-side feed from `onStatus` needs no new channel and no `listDesign` export.

## As built (2026-11-24)

Built on `t3/design-mode-v2-p2c`, stacked on 2b (PR #916), Tasks 0–15 in order. Every security rule in Global Constraints holds as written. Deviations from the plan, each the smallest change that kept the rule:

1. **`already-running` gained `started?: true`.** `connect` on a root Aiden runs answers "Aiden already runs this app. Stop it first, then connect." instead of the attached-root text.
2. **DM's canvas-config test** now expects `url` on entries (DM owns `canvas-config.ts`, 2c added the field).
3. **`deps.attach` is a `DesignAppAttachDeps` facade** (`designAppAttachDeps`: scan, check, rebind, realpath) rather than the individual readers, so `DesignAppServers` tests fake one object.
4. **`entry.attached` is a separate field**, not a `Watch` union on `entry.server`: the job path is untouched and the attach path can't reach a signal.
5. **`jobProcessTree`'s parameter type was widened** to accept the roots' rows.
6. **Re-binding** is `rebindHolder` (pure, over rows and sockets) plus `findRebind` (a fresh table and a strict read of the old parent's subtree), retried for 3 ticks (`DESIGN_APP_REBIND_TICKS`, about 6 s).
7. **Folders over 200 characters** show cut with "…" in the Connect list, and a pick whose folder was cut is refused (`attach-not-in-app`), since a cut folder can't name a root.
8. **`toggleRoots` doesn't fall back** to the single detected app when the config has url roots, so a url root is never launched by the toggle.
9. **`connect` is an enqueued action, not an attempt** (`begin` is for launches); url-root attaches do run as attempts inside `runAttempt`.
10. **2b's consent test** "attach requests are left to 2c" now checks only the other-chat wait, since 2c renders attach cards.
11. **The chip's focus-ring check moved to E2E** (happy-dom has no computed outline): the spec asserts a 2 px solid outline under `data-input-modality="keyboard"`.
12. **`connectDesignAppJobs` gained `ownedPids` and `terminalShellPids`**, wired from `main/index.ts`, because `backgroundJobs` and `terminalService` are created there.
13. **Renderer tests compare booleans, never DOM nodes.** A failing `assert.equal(node, …)` makes Node inspect the happy-dom node's whole object graph, which spins instead of failing; it first looked like `waitFor` hanging. The chip and drawer tests poll with an `act`-wrapped `until` helper; the sheets tests wait on an `onClose` counter.
14. **The Connect sheet shows a rejected invoke's message inline** on the row, like a refusal, instead of a toast.
15. **The sheets, chip and drawer were written before their tests** in Tasks 10–12; each test was then checked against the behaviour, and two drawer mutations (no carry across reads, no 256 KiB bound) were confirmed to fail it.
16. **The drawer takes a `pollMs` prop** (default 1 000 ms), and its tests use real timers with short polls instead of fake timers, which don't reach happy-dom's timers reliably.
17. **Show logs opens the drawer from the menu's `onCloseAutoFocus`**, after Radix's focus trap is gone, so the drawer's output can take focus; opening it from `onSelect` lost focus to the closing menu (found in E2E).
18. **`readDesignLog` also ends on a character boundary when a read stops short of `end`** (`maxBytes`), not only while the job runs, and returns the shifted `from` when it skips leading continuation bytes.
19. **Linux `portHolders` skips an unreadable process of the person only when the readable ones hold every listening socket on the port**; otherwise it still fails closed. Electron's sandboxed helpers run as the person but aren't dumpable, so their `/proc/<pid>/fd` can't be read, and the strict version failed every check while Aiden ran (found in the Space E2E). The macOS `lsof` path is unchanged.
20. **After Not now, the chip says "Not running"**, not "Start" as Task 14's first line says: a declined card leaves the `consent-declined` problem, and D2 labels a stopped app with a problem "Not running". The E2E asserts that, then Start from the menu.
21. **The url-root E2E runs with a 2 s grace**, so turning design mode off really ends the attachment and the second turn-on exercises the remembered approval.
22. **`packages/cli` needed `npm ci`** in this fresh worktree before `npm run cli:build`; nothing in the CLI changed.
23. **Two E2E tests beyond Task 14's list**: a script that never listens shows "Starting…" and Stop ends it, and a two-app monorepo picked through Choose apps… shows "2 apps". They exercise those chip states and give their screenshots.

### Code-review fixes (2026-11-24)

Two code reviews of `dde664a2f` found one blocker, four majors and eleven minors. Each fix was written test first; the security rules in Global Constraints still hold as written.

24. **B1. The chip's Show logs test waits** for the drawer to open: it opens from the menu's `onCloseAutoFocus` (#17), after the click returns. The file passed 10 runs in a row.
25. **A-M1. A re-bind re-checks the folder.** `findRebind` takes `workspacePath` and `appRoot`, reads the new holder's folder strictly (`processFolders` without `partial`), and requires it inside `realpath(appRoot)` inside `realpath(workspace)`. It now answers `{ ok: true, pid, ppid }`, `{ ok: false, problem }` or `undefined` (nothing holds the port yet). A refusal detaches at once with its problem (`attach-not-in-app` for a folder outside or unreadable); only `undefined` waits out the 6 s.
26. **A-M2. A background job's processes never attach.** The scan, `checkAttach` and `findRebind` refuse a holder when any process in its subtree carries `AIDEN_BACKGROUND_JOB=` in its starting environment, so a job's `setsid` escapee that left the job's tree is refused too, and the design marker sweep (`sweepMarked`, which signals exactly the marked processes) never meets an attached watch. It reads environments with a new `processEnvironmentMarks(pids, prefix, reader)` in `listening-ports.ts`, not `processHasEnvironment`: that one matches one exact entry, and on macOS it reads an environment `ps -E` doesn't print as "no marker", which isn't fail-closed. The new reader reads `/proc/<pid>/environ` on Linux; on macOS it runs `ps -E` and plain `ps` over the same pids and calls a process unreadable when the two lines match, which is what Apple's platform binaries (and an empty environment) give.
    - **macOS decision: fail closed.** A process whose environment can't be read is never attached: the scan hides its row and marks the list `incomplete` ("Some servers may be missing"), and the check and a re-bind refuse with `attach-unreachable`. A marked process is refused with `attach-not-in-app`, like Aiden's own. So a dev server run by an Apple platform binary (such as `/usr/bin/ruby`) can't be connected on macOS; node, Python from Xcode or Homebrew, and other non-platform runtimes print their environment and are unaffected. Another user's process in a subtree is left to the uid rule (`other-user`) and its environment is never read.
27. **A-m1. Another user's process detaches on the first tick on Linux.** `readJobSockets` answers an attach root's `rows` even when its socket read failed (an unreadable process of another user fails the read on Linux), and `checkAttached` runs the uid check before `result.ok`.
28. **A-m2 (amends #19). An unreadable process right above the outermost holder fails closed.** Linux `portHolders` also fails when a process it skipped is the parent of the outermost holder of a chain it found, since a forked descriptor may make that parent the outermost holder. The first version failed for any unreadable ancestor; that refused every server under a non-dumpable same-uid session daemon (`cua-spacesd` in the E2E Space, an sshd session on a real host), so it was narrowed. A process further up could have handed the descriptor down only through the readable process below it, which doesn't hold it. The residual case is a readable middle process that forked the holder and then closed its copy while an unreadable grandparent kept one; Aiden then attaches the inner holder, which it never signals in any case.
29. **A-m3. A lost holder maps to no app.** While the holder is gone and no re-bind is found (the 6 s grace), the watch is `lost` and `appForOrigin` doesn't map its origin; a re-bind or the holder's return clears it. `isAppOrigin` still restricts the origin.
30. **A-m4. The log cleaner's newline policy.** CAN and SUB cancel an OSC, DCS, SOS, PM or APC (nothing shows). A line break inside one ends it unfinished: the ESC shows escaped and the rest shows as text, so `\e]0;title` followed by log lines shows those lines at once. Any sequence still unfinished 4 KiB after its ESC shows the same way, whether or not the read ended there, so chunked and whole reads agree; the carry therefore never holds more than 4 KiB. This replaces "a pending sequence over 4 KiB is dropped whole".
31. **A-m5. Choose on a url root is refused with `not-web`** before any card or save ("That folder isn't a web app design mode can run."). `already-running` was the other option, but its text says the app is connected, which is wrong for a url root nothing is attached to. A live attachment still answers `already-running`, as before.
32. **B2. The drawer bounds catching up.** A read that leaves `end − next > DESIGN_APP_LOGS_KEEP` (after a pause, or a new run longer than 256 KiB) drops the held text and the cleaner's carry, shows one line "Output was skipped to show the latest", and continues from `end − 256 KiB`.
33. **B3, B4. Tests for the gaps the mutation run found:** back-to-back 64 KiB catch-up reads after the first read (with a 400 ms poll, each read follows the last within 200 ms), B2's jump after a pause and after a new run, the cleaner's carry reset on a new run and on a truncated read (an OSC split across them), a Stop during `connect`'s checks, and a pick whose folder was cut for display. The Stop test showed a real race: `connect` read `entry.stops` only after its checks, so a Stop during them (or for a root with no entry yet) didn't win. `stop()` now records a per-key stop tick even without an entry, and `connect` refuses when one landed after it began.
34. **B5. The logs drawer sits above the zoom controls** (`bottom-14` instead of `bottom-3`), so they stay visible and clickable; the E2E checks the zoom bar takes a click and lies below the drawer.
35. **B6. Only a disconnect with a problem is announced.** The person's own Disconnect leaves no problem and says nothing.
36. **B7. A status read that races a broadcast keeps each app's higher revision**: the read's answer is merged with the latest broadcast for its workspace before it's shown. Broadcasts still replace as they arrive, since they come in order.
37. **B8. `.` shows as "workspace folder"** in the chip's menu, the logs drawer's header, the attach card and the Connect sheet (`designAppRootText`; the name is set in the body font, paths in monospace). Main's values, and the browser panel's label, keep `.`.

E2E runs only in the Linux Cua Space, so the darwin branches of the attach readers are covered by `app-attach-process.test.ts` on the host, not by the E2E.
