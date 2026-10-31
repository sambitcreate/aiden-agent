# Usage data and crash reports

Aiden's desktop app sends anonymous usage data so we can see how many people use it. This release sends only the app lifecycle events below; feature-use events and crash reports, which show which big features people use and what breaks, arrive in later releases. This page is the reference for what is sent and how to turn it off. The design and rollout plan is [`plans/posthog-product-analytics-plan.md`](plans/posthog-product-analytics-plan.md).

## What is sent

Only the events and fields in `main/services/analytics/analytics-events.ts`. Settings → About → Usage data → **What's sent** renders that same list in the app, so it can't drift from what is actually sent.

Every event carries:

- a random install ID, created on this device and deleted when you turn usage data off;
- the app version, platform, CPU architecture, OS major version, surface (`desktop`) and build channel.

Lifecycle events in this release:

| Event | When | Extra fields |
| --- | --- | --- |
| `app_opened` | Each launch | `launch_kind`: cold, after_update or after_crash |
| `app_active` | At most once per local day | none |
| `onboarding_finished` | Setup completed or deferred | `outcome`, and `provider_id` (a built-in Aiden id, otherwise `custom`) |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | When you turn usage data off (the last event sent) | none |

Feature-use events and crash reports are listed in the registry and arrive in later releases; the in-app sheet always shows the current list.

## What is never sent

Chats, prompts, replies, file names or contents, paths, API keys or other credentials, and the names and URLs of custom providers. There are no person profiles, no session replay, no autocapture, no heatmaps, no surveys and no feature flags. The PostHog project discards client IP addresses.

## Where it goes

PostHog's US cloud, project "aiden", at the fixed host `https://us.i.posthog.com`. Only the Electron main process sends; the renderer has no PostHog code. Data is kept for PostHog's default retention.

## Turning it off

- **Settings → About → Usage data**: turn off **Share anonymous usage and crash data**. Aiden sends one `analytics_disabled` event, drops anything queued, and deletes the install ID. Turning it back on starts a new ID.
- **Environment**: `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` turns it off regardless of the setting; the switch shows "Turned off by your environment (DO_NOT_TRACK)".
- **First run**: the last onboarding step has the same switch, on by default, with a **What's sent** link.
- **Existing installs**: the first launch after updating shows a one-time notice with **OK** and **Turn off**. Nothing is sent until the notice or the onboarding row has been shown; switching usage data on in Settings also answers the notice.

## Builds that never send

Only distribution builds carry the project key, injected from the `AIDEN_POSTHOG_PROJECT_KEY` release secret (the release workflow fails without it). `npm run dev`, unpacked builds, tests and E2E have no key and never create a client. Release smoke and acceptance launches set `AIDEN_ANALYTICS=0`. For local testing, `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build writes would-be events to the dev log instead of sending them.

## Phone apps and CLI

The iOS and Android apps contain no analytics. The CLI does not send usage data yet; when it does, it will follow the same list and switches.
