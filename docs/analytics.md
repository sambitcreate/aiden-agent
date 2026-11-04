# Usage data and crash reports

Aiden's desktop app sends anonymous usage data so we can see how many people use it and what breaks. This release sends the app lifecycle events and crash reports below; feature-use events, which show which big features people use, arrive in a later release. This page is the reference for what is sent and how to turn it off. The design and rollout plan is [`plans/posthog-product-analytics-plan.md`](plans/posthog-product-analytics-plan.md).

## What is sent

Only the events and fields in `main/services/analytics/analytics-events.ts`. Settings → About → Usage data → **What's sent** renders that same list in the app, so it can't drift from what is actually sent.

Every event carries:

- a random install ID, created on this device and deleted when you turn usage data off;
- the app version, platform, CPU architecture, OS major version (on Linux, the kernel major version), surface (`desktop`) and build channel.

Lifecycle events in this release:

| Event | When | Extra fields |
| --- | --- | --- |
| `app_opened` | Each launch | `launch_kind`: cold, after_update or after_crash |
| `app_active` | At most once per local day | none |
| `onboarding_finished` | Setup completed or deferred | `outcome`, and `provider_id` (a built-in Aiden id, otherwise `custom`) |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | When you turn usage data off (the last event sent) | none |

Feature-use events are listed in the registry and arrive in a later release; the in-app sheet always shows the current list.

## Crash reports

Aiden reports crashes and uncaught errors only. A failure the app handles (a provider request that failed, a rejected key, a routine or tool error, an error an interface boundary caught) stays on your device.

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
- **Types.** An error name that does not look like an error class (`TypeError`, `SomethingError`, `SomethingException`), or that looks like a token, becomes `Error`.

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

PostHog's US cloud, project "aiden", at the fixed host `https://us.i.posthog.com`. Requests reject redirects. Only the Electron main process sends; the renderer has no PostHog code. Data is kept for PostHog's default retention.

## Turning it off

- **Settings → About → Usage data**: turn off **Share anonymous usage and crash data**. Aiden drops the ordinary event queue immediately and deletes the install ID and any pending crash report. It makes a separate, time-limited attempt to send one `analytics_disabled` event with the previous ID, even if you quit at the same time. Turning it back on starts a new ID.
- **Environment**: `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` turns it off regardless of the setting; the switch shows "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)".
- **First run**: the last onboarding step has the same switch, on by default, with a **What's sent** link. Finishing setup acknowledges the row only when it displayed sharing as on. A missing or failed settings read leaves the notice pending.
- **Existing installs**: the first launch after updating shows a one-time notice with **OK** and **Turn off**. Nothing is sent until the notice or the onboarding row has been shown; switching usage data on in Settings also answers the notice.

## Builds that never send

Only distribution builds carry the project key, injected from the `AIDEN_POSTHOG_PROJECT_KEY` release secret (the release workflow fails without it). `npm run dev`, unpacked builds, tests and E2E have no key and never create a client. Release smoke and acceptance launches set `AIDEN_ANALYTICS=0`. For local testing, `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build writes would-be events to the dev log instead of sending them.

## Phone apps and CLI

The iOS and Android apps contain no analytics. The CLI does not send usage data yet; when it does, it will follow the same list and switches.
