# Usage data and crash reports

Aiden's desktop app sends anonymous usage data so we can see how many people use it and which big features they use. Crash reports, which show what breaks, arrive in a later release. This page is the reference for what is sent and how to turn it off. The design and rollout plan is [`plans/posthog-product-analytics-plan.md`](plans/posthog-product-analytics-plan.md).

## What is sent

Only the events and fields in `main/services/analytics/analytics-events.ts`. Settings → About → Usage data → **What's sent** renders that same list in the app, so it can't drift from what is actually sent.

Every event carries:

- a random install ID, created on this device and deleted when you turn usage data off;
- the app version, platform, CPU architecture, OS major version (on Linux, the kernel major version), surface (`desktop`) and build channel.

Lifecycle events:

| Event | When | Extra fields |
| --- | --- | --- |
| `app_opened` | Each launch | `launch_kind`: cold, after_update or after_crash |
| `app_active` | At most once per local day | none |
| `onboarding_finished` | Setup completed or deferred | `outcome`, and `provider_id` (a built-in Aiden id, otherwise `custom`) |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | When you turn usage data off (the last event sent) | none |

Feature events fire once, at the moment the action succeeded, from the service that owns it, so an action from a paired phone counts the same way as one on the Mac. A refused, cancelled or failed action sends nothing, and a subagent's own turns are not messages.

| Event | When | Extra fields |
| --- | --- | --- |
| `chat_message_sent` | A person's message started a turn, including a scheduled run and a message to a Bot. Telegram chats, Design runs and Aiden's own follow-up notices are not counted. | `provider_id`, `model_id`, `in_workspace`, `thinking`, `origin`: desktop, phone, bot or schedule |
| `chat_created` | A new chat from the sidebar, a phone, the first message of a draft, or the Assistant. Bots, schedules and forks are not counted. | `workspace_kind`: folder, scratch, worktree or none |
| `provider_connected` | A sign-in or key was saved, or a custom provider was added | `provider_id`, `auth`: key, oauth or local |
| `workspace_added` | A folder, named or scratch workspace was added. A hidden No workspace folder is not. | `kind`: folder, scratch or path (a typed path or a clone) |
| `bot_created` | A Bot was created | `preset_id`, `bot_count` bucket |
| `bot_routine_ran` | A Bot routine finished with a result | `trigger`, `result`: success or failed |
| `scheduled_task_ran` | A scheduled task finished with a result | `trigger`, `result`: success, silent or failed |
| `subagent_launched` | A foreground or background subagent started | `role` |
| `skill_used` | A skill was run by name and its message was saved | `source`: builtin or user, and `skill_id` for a bundled skill only |
| `connector_added` | A connector was added. Editing one is not counted. | `preset_id`, `transport`: stdio or http |
| `web_search_used` | A search returned results | `search_provider` |
| `voice_used` | A Live session opened, a dictation reached the text field (including from a phone), or read aloud started | `mode`: live, dictation or read_aloud; `engine`: local or cloud |
| `phone_paired` | An iPhone, iPad or Android phone finished pairing | `transport`: lan or tailscale; `device_count`: bucket of phones not revoked |
| `peer_mac_paired` | Another Mac or Linux host was paired from this one | `method`: discovery, code or link |
| `computer_use_enabled` | The global Computer Use switch went from off to on | none |
| `bot_computer_set_up` | Bot computers finished Set up, or element control was added later | `element_control` |
| `terminal_opened` | A terminal started | none |
| `git_commit` | A commit was made from Aiden | none |
| `worktree_created` | A worktree was created | none |

How the values are limited:

- `provider_id` and `model_id` are ids that ship in the app. A custom provider, a local model, or a model missing from the bundled catalog is sent as `custom`. Catalog ids are lowercased.
- `preset_id` is a bundled Bot preset or connector, otherwise `custom`. `search_provider` is one of Aiden's own search routes.
- `in_workspace` is true only for a real workspace. Messages to a Bot always report false.
- `trigger` is automatic, manual, catch_up, retry, file_change, webhook or watch. `thinking` is the level chosen for the turn, or other when Aiden doesn't know it, as for a message to a Bot.

Crash reports are listed in the registry and arrive in a later release; the in-app sheet always shows the current list.

## What is never sent

Chats, prompts, replies, file names or contents, paths, API keys or other credentials, and the names and URLs of custom providers. There are no person profiles, no session replay, no autocapture, no heatmaps, no surveys and no feature flags. The PostHog project discards client IP addresses.

## Where it goes

PostHog's US cloud, project "aiden", at the fixed host `https://us.i.posthog.com`. Requests reject redirects. Only the Electron main process sends; the renderer has no PostHog code. Data is kept for PostHog's default retention.

## Turning it off

- **Settings → About → Usage data**: turn off **Share anonymous usage and crash data**. Aiden drops the ordinary event queue immediately and deletes the install ID. It makes a separate, time-limited attempt to send one `analytics_disabled` event with the previous ID, even if you quit at the same time. Turning it back on starts a new ID.
- **Environment**: `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` turns it off regardless of the setting; the switch shows "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)".
- **First run**: the last onboarding step has the same switch, on by default, with a **What's sent** link. Finishing setup acknowledges the row only when it displayed sharing as on. A missing or failed settings read leaves the notice pending.
- **Existing installs**: the first launch after updating shows a one-time notice with **OK** and **Turn off**. Nothing is sent until the notice or the onboarding row has been shown; switching usage data on in Settings also answers the notice.

## Builds that never send

Only distribution builds carry the project key, injected from the `AIDEN_POSTHOG_PROJECT_KEY` release secret (the release workflow fails without it). `npm run dev`, unpacked builds, tests and E2E have no key and never create a client. Release smoke and acceptance launches set `AIDEN_ANALYTICS=0`. For local testing, `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build writes would-be events to the dev log instead of sending them.

## Phone apps and CLI

The iOS and Android apps contain no analytics. The CLI does not send usage data yet; when it does, it will follow the same list and switches.
