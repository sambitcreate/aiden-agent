# Usage data and crash reports

Aiden's desktop app, and distributed builds of its headless server, send anonymous usage data so we can see how many people use it, which big features they use and what breaks. This page is the reference for what is sent and how to turn it off. The design and rollout plan is [`plans/posthog-product-analytics-plan.md`](plans/posthog-product-analytics-plan.md).

## What is sent

Only the events and fields in `main/services/analytics/analytics-events.ts`. Settings → About → Usage data → **What's sent** renders that same list in the app, so it can't drift from what is actually sent.

Every event carries:

- a random install ID, created on this device and deleted when you turn usage data off;
- the app version, platform, CPU architecture, OS major version (on Linux and on the server, the kernel major version), surface (`desktop` or `server`) and build channel.

Lifecycle events:

| Event | When | Extra fields |
| --- | --- | --- |
| `app_opened` | Each launch | `launch_kind`: cold, after_update or after_crash |
| `app_active` | At most once per local day | none |
| `onboarding_finished` | Setup completed or deferred | `outcome`, and `provider_id` (a built-in Aiden id, otherwise `custom`) |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | When you turn usage data off (the last event sent) | none |
| `server_started` | Each time `aiden serve` is ready to serve | `launch`: foreground, daemon or service |

Feature events fire once, at the moment the action succeeded, from the service that owns it, so an action from a paired phone counts the same way as one on the Mac. A refused, cancelled or failed action sends nothing, and a subagent's own turns are not messages. Nothing is sent until the notice or the onboarding row has been shown, so actions during first-run setup aren't counted: the first provider appears only as `provider_id` on `onboarding_finished`. An action in the first moments of a launch waits in memory, up to 100 events, until usage data has started, and is dropped if sending isn't allowed. Delayed metadata lookups keep the action's original consent: a later disclosure or opt-in cannot authorize an earlier action, and a consent change or shutdown discards its unfinished report. New feature reports stop as soon as that change or shutdown is requested, including while an earlier settings write finishes.

| Event | When | Extra fields |
| --- | --- | --- |
| `chat_message_sent` | A person's message started a turn or was queued for one, including a scheduled run and a message to a Bot. A message that joins a running Bot turn, a message from another Bot, Telegram chats, Design runs and Aiden's own follow-up notices are not counted. | `provider_id`, `model_id`, `in_workspace`, `thinking`, `origin`: desktop, phone, peer (another paired Mac or Linux host), bot or schedule |
| `chat_created` | A new chat from the sidebar, a phone, the first message of a draft, or the Assistant. Bots, schedules and forks are not counted. | `workspace_kind`: folder, scratch, worktree or none |
| `provider_connected` | A sign-in or key was saved for a built-in provider, or a custom provider was added | `provider_id`, `auth`: key, oauth or local (a custom provider on this machine or one with no key) |
| `workspace_added` | A folder, named or scratch workspace was added. A hidden No workspace folder is not. | `kind`: folder, scratch or path (a typed path or a clone) |
| `bot_created` | A Bot was created | `preset_id`, `bot_count` bucket |
| `bot_routine_ran` | A Bot routine finished with a result | `trigger`, `result`: success or failed |
| `scheduled_task_ran` | A scheduled task finished with a result. A cancelled or skipped run is not counted; one blocked by a permission is `failed`. | `trigger`, `result`: success, silent or failed |
| `subagent_launched` | A subagent started | `role` |
| `skill_used` | A skill was run by name and its message was saved | `source`: builtin or user, and `skill_id` for a bundled skill only |
| `connector_added` | A connector was added. Editing one is not counted. | `preset_id`, `transport`: stdio or http |
| `web_search_used` | A search finished without an error, even with no results | `search_provider` |
| `voice_used` | A Live session opened, a hotkey dictation delivered its text (pasted or copied), a phone transcribed speech, or read aloud started. The microphone in the Mac composer is not counted. | `mode`: live, dictation or read_aloud; `engine`: local or cloud |
| `phone_paired` | An iPhone, iPad or Android phone finished pairing | `transport`: lan or tailscale; `device_count`: bucket of phones not revoked |
| `peer_mac_paired` | Another Mac or Linux host was paired from this one | `method`: discovery, code or link |
| `computer_use_enabled` | The global Computer Use switch went from off to on | none |
| `bot_computer_set_up` | Bot computers finished Set up, or element control was added later | `element_control` |
| `terminal_opened` | A terminal started | none |
| `git_commit` | A commit was made from Aiden | none |
| `worktree_created` | A managed worktree was created and saved as a workspace | none |
| `design_mode_entered` | A chat went into design mode | `source`: toggle (the Design button), shortcut (⇧⌘L), slash (`/design`) or aiden (Enter on Aiden's card) |
| `design_mode_exited` | A chat left design mode from the Design button, ⇧⌘L or `/design off` | none |
| `design_mode_declined` | Not now on Aiden's "Open design mode?" card. A card that times out or stops with the reply is not counted. | none |
| `design_comments_sent` | A desktop message carried design-canvas comments for Aiden | `count_bucket`: how many comments. Their notes, pages, files and elements stay on your device. |

How the values are limited:

- `provider_id` and `model_id` are ids that ship in the app. A custom provider, a local model, or a model missing from the bundled catalog is sent as `custom`. Catalog ids are lowercased.
- `preset_id` is a bundled Bot preset or connector, otherwise `custom`. `search_provider` is one of Aiden's own search routes.
- `in_workspace` is true only for a real workspace. Messages to a Bot always report false, and report `origin: bot` whichever surface sent them.
- `trigger` is automatic, manual, catch_up, retry, file_change, webhook or watch. `thinking` is the level chosen for the turn, or other when Aiden doesn't know it, as for a message to a Bot.

Chats and turns an outside MCP app starts through the local MCP server are never counted: no `chat_created` and no `chat_message_sent`.

Bot continuity integration: host-issued watch/routine and approved-peer task/result inputs do not count as a person’s `chat_message_sent`, including routines without display labels. A person’s accepted durable input reports only allowlisted IDs from its admitted execution model; analytics never resolves the Bot’s unrelated current default or changes its saved model/fallback choice. Duplicates and Resume do not add message events.

## Crash reports

The desktop app reports crashes and uncaught errors only. A failure the app handles (a provider request that failed, a rejected key, a routine or tool error, an error an interface boundary caught) stays on your device. The headless server's crash reports are narrower and are described under [Headless server](#headless-server-aiden-serve).

| What happened | Sent as | Fields |
| --- | --- | --- |
| Uncaught exception in the main process, or startup failing once crash capture has begun | `$exception`, `level: fatal` | `source: main`, `origin`, `process_type`, `uptime_bucket` |
| Unhandled rejection in the main process (Aiden keeps running) | `$exception`, `level: error` | `source: main`, `origin`, `process_type`, `uptime_bucket` |
| Uncaught error or rejection in the app window | `$exception`, `level: error` | `source: renderer`, `origin`, `process_type`, `uptime_bucket` |
| The app window's process died | `app_crashed` | `kind: renderer`, `reason`, `exit_code` |
| The app window kept crashing | `app_crashed` | `kind: renderer_loop` |
| A web page's process in the in-app browser died | `app_crashed` | `kind: browser_tab`, `reason`, `exit_code` (never the page or its address) |
| A GPU, utility or other helper process died | `app_crashed` | `kind: gpu`, `utility` or `other`, `reason`, `exit_code` |
| The last run ended without JavaScript getting to run, for example a native crash | `app_crashed`, on the next launch | `kind: unclean_exit` |

A process that exited with code zero, a helper Aiden stopped itself and a process that ended while Aiden was quitting are not crashes and are not sent. A crash that arrives on the next launch has `origin: pending_crash` and carries the version and time it happened.

An `$exception` holds the error's type, a message and up to 30 stack frames, for the error and up to three causes. Every exception is rebuilt from scratch in the main process:

- **Messages.** Only messages the JavaScript runtime, Node, Chromium or Electron write themselves are kept, and what is kept is fixed text. A name the runtime quotes becomes `[name]`, as in `Cannot read properties of undefined (reading '[name]')`, because it can be a value from data. Paths are redacted. Every other message becomes `[message withheld]`. An app-thrown message can quote a prompt or a reply, and no redactor can tell a sentence of chat from anything else, so the type and stack identify those errors instead.
- **Stacks.** A frame inside the app bundle keeps its app-relative file (`app:///…`), function name and position. A frame in Node's own code keeps only the module (`node:fs`). Anything else becomes `<external>`, and a function name that is not a single code identifier becomes `?`. A function in the bundle that takes its name from a computed key shows that key.
- **Types.** An error name is kept only if it is on the fixed list in `analytics-sanitize.ts` (the language's, Node's and the web platform's own names, plus `ZodError` and `PostHogFetchError`). Any other name becomes `Error`, because a name can be set from anything, so a custom class name is not reported.

### Errors from the app window

While usage data can be sent, the app window adds an uncaught error's raw name, message and stack (capped at 8 KiB) to the report it already gives the main process. The main process treats those fields as untrusted, runs them through the sanitizer above, and neither stores nor logs them; the local diagnostics journal keeps its content-free record. When sending is off, the report is exactly the content-free form. The window has no PostHog code and decides nothing about what is safe.

### Crashes that end the process

A fatal main-process exception may kill Aiden before anything reaches the network, so the sanitized exception is first written to `analytics-pending-crash.json` in the app's data folder, then sent at once. The file is deleted when the server confirms it. If it is still there on the next launch, it is sent then, under the same event ID so the server keeps one copy. A crash that could not be sent waits for a launch that can. Only the most recent unsent crash is kept, so a second fatal error replaces the first. Turning usage data off deletes the file; a record left by an earlier install ID, or found while sending is off, is deleted unsent.

`analytics-run.marker` is a small file present while Aiden runs, holding a random ID for that run. If a launch finds it, and no pending crash from that same run explains why, the last run ended without JavaScript running and one `unclean_exit` is sent. Sending must have been allowed at that launch: a crash from before the notice or from before you opted in is never reported.

### Limits

At most 25 crash reports per app session, and at most three of the same non-fatal error (same type and top three frames). Fatal errors and `app_crashed` skip the per-error limit but count toward the 25. Quitting never waits longer than the existing usage-data shutdown deadline for a report to finish sending.

A failure before crash capture starts, such as a module that cannot load, is not reported. Native crash dumps are not sent. They stay on your device and stay opt-in. Aiden does not upload source maps, so stacks from minified code show minified names.

## What is never sent

Chats, prompts, replies, file names or contents, paths, API keys or other credentials, and the names and URLs of custom providers. There are no person profiles, no session replay, no autocapture, no heatmaps, no surveys and no feature flags. The PostHog project discards client IP addresses.

## Where it goes

PostHog's US cloud, project "aiden", at the fixed host `https://us.i.posthog.com`. Requests reject redirects. Only the Electron main process and the server process send; the renderer has no PostHog code. Data is kept for PostHog's default retention.

## Turning it off

- **Settings → About → Usage data**: turn off **Share anonymous usage and crash data**. Aiden drops the ordinary event queue immediately and deletes the install ID and any pending crash report. It makes a separate, time-limited attempt to send one `analytics_disabled` event with the previous ID, even if you quit at the same time. Turning it back on starts a new ID.
- **Environment**: `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` turns it off regardless of the setting; the switch shows "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)".
- **First run**: the last onboarding step has the same switch, on by default, with a **What's sent** link. Finishing setup acknowledges the row only when it displayed sharing as on. A missing or failed settings read leaves the notice pending.
- **Existing installs**: the first launch after updating shows a one-time notice with **OK** and **Turn off**. Nothing is sent until the notice or the onboarding row has been shown; switching usage data on in Settings also answers the notice.

## Builds that never send

Only distribution builds carry the project key, injected from the `AIDEN_POSTHOG_PROJECT_KEY` release secret (the release workflow fails without it). `npm run dev`, unpacked builds, tests and E2E have no key and never create a client. Release smoke and acceptance launches set `AIDEN_ANALYTICS=0`. For local testing, `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build writes would-be events to the dev log instead of sending them; a keyless server build writes them to stderr.

## Headless server (`aiden serve`)

The server follows the same event list and sends with `surface: "server"`. Only the `aiden serve` process sends: admin commands such as `aiden workspace list` send nothing and never load the analytics client. The one exception is `aiden telemetry off`, which sends the single `analytics_disabled` described below. Only a build made with `npm run cli:dist` can send, and the `Build keyed server bundle` workflow, which builds for Linux x64, is the one place that happens. A server built from a clone (`npm run cli:build`) and the Docker image have no key, send nothing and show no notice.

A keyed server adds `server_started`, crash reports and the shared events its own work triggers, apart from its own chat paths, which do not report `chat_message_sent` yet. A crash report covers an uncaught exception or rejection and carries only the error's type, its sanitized stack frames and a system error code from a fixed list, such as `ENOENT`, never its message: a server's messages can quote file names, hosts and prompt text that redaction cannot recognize. Any other code is dropped, and the final check before sending admits a bare code only on a server's report. Frames are read only from a stack whose first line is the error's name and current message, so a stack that outlived a changed message sends no frames. As on the desktop, an error type outside the fixed list is sent as `Error`. A crash waits at most one second for its report, then exits exactly as it would have. A rejection the server logs and survives is reported as an error. At most 25 crashes are reported per day, so a service restarting in a loop cannot flood the project; after that the server sends nothing until the next day. The server has no `app_active` event; `server_started` covers it. `server_started` is sent once the server is ready, so a server that fails to start is not counted.

Consent and a separate random install ID live in `aiden-analytics.json` in the agent directory (`~/.aiden/agent`, or `AIDEN_CODING_AGENT_DIR`):

- **Notice:** one line on stderr at `aiden service install`, and at the first `aiden serve` on a terminal: "This Aiden server sends anonymous usage and crash data. Turn off: aiden telemetry off". `aiden serve --daemon` shows it in the terminal that starts it. A server that never showed the notice sends nothing, so a container or a script that runs `aiden serve` without a terminal stays silent.
- **`aiden telemetry status|on|off`:** `off` saves the choice, sends one `analytics_disabled` with the old ID, and forgets the ID. A running server re-reads the file before every event and request, so it stops too and drops its queue. The switch and each request share a lock, so once `off` returns no new request starts; one already on the wire finishes. A server that can't get the lock quickly sends nothing, and if a stuck process holds it, `off` says so and changes nothing, so run it again. `on` also answers the notice; a running server starts sending again at its next start, with a new ID. A consent file that cannot be read counts as off, since it may have held your opt-out; `on` replaces it.
- **Environment:** `DO_NOT_TRACK=1` and `AIDEN_ANALYTICS=0` work as on the desktop, and with `CI` set nothing is ever sent. These are read per process: a service started by systemd or launchd does not see your shell's environment, so use `aiden telemetry off` for a service.
- `--version`, help and every other admin command never show the notice or send.

## Phone apps

The iOS and Android apps contain no analytics.
