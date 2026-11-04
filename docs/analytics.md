# Usage data and crash reports

Aiden's desktop app, and distributed builds of its headless server, send anonymous usage data so we can see how many people use it. The desktop app's current release sends only the app lifecycle events below; feature-use events and its crash reports, which show which big features people use and what breaks, arrive in later releases. This page is the reference for what is sent and how to turn it off. The design and rollout plan is [`plans/posthog-product-analytics-plan.md`](plans/posthog-product-analytics-plan.md).

## What is sent

Only the events and fields in `main/services/analytics/analytics-events.ts`. Settings → About → Usage data → **What's sent** renders that same list in the app, so it can't drift from what is actually sent.

Every event carries:

- a random install ID, created on this device and deleted when you turn usage data off;
- the app version, platform, CPU architecture, OS major version (on Linux and on the server, the kernel major version), surface (`desktop` or `server`) and build channel.

Lifecycle events in this release:

| Event | When | Extra fields |
| --- | --- | --- |
| `app_opened` | Each launch | `launch_kind`: cold, after_update or after_crash |
| `app_active` | At most once per local day | none |
| `onboarding_finished` | Setup completed or deferred | `outcome`, and `provider_id` (a built-in Aiden id, otherwise `custom`) |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | When you turn usage data off (the last event sent) | none |
| `server_started` | Each time `aiden serve` is ready to serve | `launch`: foreground, daemon or service |

Feature-use events and desktop crash reports are listed in the registry and arrive in later releases; the in-app sheet always shows the current list.

## What is never sent

Chats, prompts, replies, file names or contents, paths, API keys or other credentials, and the names and URLs of custom providers. There are no person profiles, no session replay, no autocapture, no heatmaps, no surveys and no feature flags. The PostHog project discards client IP addresses.

## Where it goes

PostHog's US cloud, project "aiden", at the fixed host `https://us.i.posthog.com`. Requests reject redirects. Only the Electron main process and the server process send; the renderer has no PostHog code. Data is kept for PostHog's default retention.

## Turning it off

- **Settings → About → Usage data**: turn off **Share anonymous usage and crash data**. Aiden drops the ordinary event queue immediately and deletes the install ID. It makes a separate, time-limited attempt to send one `analytics_disabled` event with the previous ID, even if you quit at the same time. Turning it back on starts a new ID.
- **Environment**: `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` turns it off regardless of the setting; the switch shows "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)".
- **First run**: the last onboarding step has the same switch, on by default, with a **What's sent** link. Finishing setup acknowledges the row only when it displayed sharing as on. A missing or failed settings read leaves the notice pending.
- **Existing installs**: the first launch after updating shows a one-time notice with **OK** and **Turn off**. Nothing is sent until the notice or the onboarding row has been shown; switching usage data on in Settings also answers the notice.

## Builds that never send

Only distribution builds carry the project key, injected from the `AIDEN_POSTHOG_PROJECT_KEY` release secret (the release workflow fails without it). `npm run dev`, unpacked builds, tests and E2E have no key and never create a client. Release smoke and acceptance launches set `AIDEN_ANALYTICS=0`. For local testing, `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build writes would-be events to the dev log instead of sending them; a keyless server build writes them to stderr.

## Headless server (`aiden serve`)

The server follows the same event list and sends with `surface: "server"`. Only the `aiden serve` process sends: admin commands such as `aiden workspace list` send nothing and never load the analytics client. The one exception is `aiden telemetry off`, which sends the single `analytics_disabled` described below. Only a build made with `npm run cli:dist` can send, and the `Build keyed server bundle` workflow, which builds for Linux x64, is the one place that happens. A server built from a clone (`npm run cli:build`) and the Docker image have no key, send nothing and show no notice.

A keyed server adds `server_started`, crash reports and, as feature-use events arrive, the shared events its own work triggers. A crash report covers an uncaught exception or rejection and carries only the error's type, its sanitized stack frames and a Node error code such as `ENOENT`, never its message: a server's messages can quote file names, hosts and prompt text that redaction cannot recognize. A crash waits at most one second for its report, then exits exactly as it would have. A rejection the server logs and survives is reported as an error. At most 25 crashes are reported per day, so a service restarting in a loop cannot flood the project; after that the server sends nothing until the next day. The server has no `app_active` event; `server_started` covers it. `server_started` is sent once the server is ready, so a server that fails to start is not counted.

Consent and a separate random install ID live in `aiden-analytics.json` in the agent directory (`~/.aiden/agent`, or `AIDEN_CODING_AGENT_DIR`):

- **Notice:** one line on stderr at `aiden service install`, and at the first `aiden serve` on a terminal: "This Aiden server sends anonymous usage and crash data. Turn off: aiden telemetry off". `aiden serve --daemon` shows it in the terminal that starts it. A server that never showed the notice sends nothing, so a container or a script that runs `aiden serve` without a terminal stays silent.
- **`aiden telemetry status|on|off`:** `off` saves the choice, sends one `analytics_disabled` with the old ID, and forgets the ID. A running server re-reads the file before every event and request, so it stops too and drops its queue. `on` also answers the notice; a running server starts sending again at its next start, with a new ID. A consent file that cannot be read counts as off, since it may have held your opt-out; `on` replaces it.
- **Environment:** `DO_NOT_TRACK=1` and `AIDEN_ANALYTICS=0` work as on the desktop, and with `CI` set nothing is ever sent. These are read per process: a service started by systemd or launchd does not see your shell's environment, so use `aiden telemetry off` for a service.
- `--version`, help and every other admin command never show the notice or send.

## Phone apps

The iOS and Android apps contain no analytics.
