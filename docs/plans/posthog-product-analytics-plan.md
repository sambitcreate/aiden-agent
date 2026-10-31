# Anonymous Usage Analytics and Crash Reporting (PostHog)

Status: Active (PR 1, core with nothing sending, in review; PR 2, consent and lifecycle, in review)
Date: 2026-10-28
Base: `origin/main` at `8504c773c` (0.62.0 + #625–#628)
Scope: Electron desktop app (macOS and Linux) first, then the `aiden` CLI. iOS and Android are out of scope.
Supersedes: the closed PostHog proposal in [PR #197](https://github.com/sambitcreate/aiden-agent/pull/197) (2026-09-30), which never merged.

## Why

Aiden is used by a small group today and the owner wants to grow it. Right now there is no way to answer three questions:

1. **How many people use Aiden?** Daily and weekly active installs, by version and platform.
2. **Which big features do they use?** Bots, routines, workspaces, voice, the phone app, Computer Use and so on, so effort goes where people are.
3. **Does it crash, and where?** Every crash and uncaught error, grouped, with a cleaned stack trace, so breakage is seen without waiting for a report.

The answer must stay true to Aiden's privacy posture: no content ever leaves the device, the data cannot identify a person, and anyone can turn it off.

## Decisions (owner)

| Decision | Choice |
| --- | --- |
| Service | PostHog (one project) |
| Consent | **On by default.** Onboarding states it plainly; Settings has a switch to turn it off. |
| Platforms | Desktop now. CLI as a second phase. Phones later, separately. |
| Usage events | The list in [Events](#events), including web search and peer Mac pairing. |
| Crashes | Every crash and every uncaught error, with a stack trace. |
| Region and retention | PostHog US cloud; PostHog's default retention. |
| Opt-out signal | Send one `analytics_disabled` event when someone turns it off. |
| Soft errors | **Not collected.** Handled failures (provider request failed, key rejected, routine failed, tool error) stay out to keep the signal quiet. |

## Goals

- Accurate daily/weekly/monthly active installs, split by app version, platform and CPU architecture.
- One adoption count per major feature, with only categorical properties.
- Every crash, renderer/helper process death and uncaught exception or unhandled rejection reaches PostHog Error Tracking, grouped and deduplicated, with a sanitized stack trace.
- A single switch turns everything off immediately and forgets the install identity.
- Development, unpacked builds and tests never send anything.

## Non-goals

- Identifying people. No accounts, emails, names, `identify()`, aliases or person profiles.
- Session replay, heatmaps, autocapture of clicks or page views, surveys, feature flags, experiments or remote config.
- Soft/handled errors, performance traces, logs or diagnostics journal upload.
- Native crash dumps (Crashpad minidumps). They stay local and opt-in exactly as today; uploading them would need Sentry and can contain memory contents.
- iOS and Android in this plan.
- Replacing the local diagnostics journal or the local usage dashboard (`main/services/usage-store.ts`). Those stay as they are.

## Anti-goals (would make this a failure even if it works)

- Any prompt, chat text, model output, file name, path, repository name, URL, API key, token, email, custom skill name, custom provider/model name or Bot name reaching PostHog.
- Events sent before the user has had a chance to see the notice.
- Turning the switch off and something still being sent.
- A crash loop or stuck error flooding the project.
- Analytics slowing launch or making a network call block the UI.
- A dev build polluting production data.

## Privacy model

**Identity.** One random UUID v4 per install (`analytics.installId`), created the first time analytics is allowed to send, stored in machine-local `<userData>/settings.json` (not the portable `config.json`, so it never syncs or travels with an exported config). It is never derived from hardware, the user, or the existing diagnostics salt. Turning analytics off deletes it; turning it back on creates a new one, so old and new data cannot be linked.

**No person data.** Every event is sent with `$process_person_profile: false`. No `identify`, `alias`, `$set` or groups.

**No location.** `posthog-node` already disables GeoIP by default (v3+); we pass `disableGeoip: true` explicitly. The PostHog project must also have **Discard client IP data** turned on (owner setup step), so the server does not store the IP.

**Closed event list.** Events and properties are declared in one typed registry (`main/services/analytics/analytics-events.ts`). Every property is an enum, a boolean, a bucketed number or a version string. A `beforeSend` guard re-validates every outgoing payload and drops anything not in the registry, so a mistake elsewhere cannot leak.

**Identifiers we normalise.** Provider IDs pass only when they are a built-in provider ID; anything else becomes `"custom"`. Model IDs pass only when present in the bundled model catalog; anything else becomes `"custom"`. A model ID is never reported for a provider whose model list comes from the person's own setup (Ollama, LM Studio, custom OpenAI-compatible endpoints), even when its name happens to match a catalog entry: a local model name can be anything the person typed. Preset IDs (Bots, connectors) pass only when they are a bundled preset; otherwise `"custom"`.

**Errors.** Every exception is rebuilt as a new sanitized error before it reaches the SDK (see [Crashes and errors](#crashes-and-errors)). We build PostHog's `$exception` payload ourselves and send it with a plain `capture()`; we never call the SDK's `captureException`, because its Node stack parser reads source files from disk to attach context lines, and exception autocapture stays off.

**Super properties** (attached to every event): `app_version`, `platform` (`darwin`/`linux`), `arch` (`arm64`/`x64`), `os_major` (e.g. `26`; the kernel major on Linux), `surface` (`desktop`/`cli`), `channel` (`release`/`beta` if applicable). No locale, timezone, hostname or username.

## Consent and lifecycle

**Default.** `analytics.enabled` defaults to `true`.

**Nothing is sent until the notice has been shown.** `analytics.noticeShownAt` gates sending:
- New installs: the notice is part of onboarding (below). Sending starts once `app:setOnboardingOutcome` records `completed` or `deferred` (`main/index.ts:987`).
- Existing installs upgrading into this release: a one-time, dismissible notice card appears on first launch. Sending starts when the card has been shown. Events and crashes before that are not sent and are not queued.

**Turning it off** (Settings switch, or `aiden telemetry off` for the CLI):
1. Stop capture immediately; drop the in-memory queue without flushing.
2. Delete `installId` and any pending crash record.
3. Persist `enabled: false`.

**Environment kill switches** (my call, standard practice): `DO_NOT_TRACK=1` or `AIDEN_ANALYTICS=0` force analytics off regardless of the setting. Settings shows the switch disabled with "Turned off by your environment".

**Builds that never send.** The PostHog project key is injected only by the release build. The release workflow **fails** if the secret is missing; a local `npm run dist` without it prints a warning and builds an app that sends nothing. Release-workflow smoke and acceptance runs of the keyed artifacts (macOS packaged acceptance, Linux `.deb`/AppImage installs) set `AIDEN_ANALYTICS=0` so they never reach production data. The key is injected (`npm run dist` / release workflow, from a CI secret, into a generated constant). Development (`npm run dev`), unpacked builds, tests and E2E have no key, so the client is never constructed and no network call can happen. The general rule: a launch no person started (CI, smoke, acceptance, E2E against a keyed build, any scripted headless launch) sets `AIDEN_ANALYTICS=0`. The build-time `channel` super property (`release`/`beta`/`dev`) stays as a second guard, so anything that slips through is labelled and filtered out of dashboards. `AIDEN_ANALYTICS_DEBUG=1` in development prints would-be events to the dev log instead, for testing.

## Network posture

- One fixed host: the PostHog ingestion host for the chosen region (US cloud: `https://us.i.posthog.com`). No other PostHog endpoints: no `/decide`, flags, remote config or surveys. No personal API key is configured, so the SDK never polls.
- All sending happens in the Electron **main** process via `posthog-node`. The renderer never talks to PostHog; it reports through existing IPC. This also satisfies `scripts/main-runtime-dependencies.test.mjs`.
- Batched: `flushAt: 20`, `flushInterval: 30_000`, `maxQueueSize: 500`. On quit, `shutdown(1500)` with a hard cap so quitting is never delayed noticeably. There is no on-disk event queue (except the single pending-crash record below); events still queued at quit are lost.
- Failure handling is the SDK's (`posthog-node` 5.56.1, verified in its source), so we do not write our own retry loop:
  - every event gets a UUIDv7 when captured, so the server de-duplicates a batch that is retried after a lost response;
  - a send retries 3 times, 3 s apart, only on 408, 429, 5xx or a network error;
  - any other 4xx drops that batch for good (no retry storm against a rejected key), and a 413 halves the batch size and tries again;
  - a batch that fails on the network stays in memory and is retried on the next flush; when the queue reaches `maxQueueSize` the oldest events are dropped.
- `posthog-node` pins `@posthog/core` with a caret range; the root `overrides` pin it (and its nested `@posthog/types`) exactly, so a new transitive release never arrives without a reviewed lockfile change.
- Apart from the update check (`main/services/app-updater.ts`), this is the only outbound call Aiden makes without a user action. `AGENTS.md` gets a new **Product analytics** section (in the style of the models.dev rules) that states these limits, so later work cannot widen them casually.

## Events

All counts are "the moment it happened", fired from the main process unless noted. Property values are enums unless stated. Event names are `snake_case` and stable; renaming one is a breaking change for dashboards.

### Who's using it

| Event | When | Properties |
| --- | --- | --- |
| `app_opened` | `app.whenReady()` (`main/index.ts:1856`), once per launch, after consent gate | `launch_kind`: `cold` / `after_update` / `after_crash` |
| `app_active` | Once per local calendar day while the app is running (timer checks hourly). Mac apps stay open for days, so this is what makes DAU accurate. | — |

Dashboards count active users from both `app_active` and real actions (`chat_message_sent`), so a Mac left open for a week is not mistaken for engagement. Phone and peer reconnects never fire events by themselves. Phone use counts against the host Mac's install, with `origin: "phone"` on `chat_message_sent` as the phone signal; the phone apps have no analytics of their own.
| `onboarding_finished` | `app:setOnboardingOutcome` (`main/index.ts:987`) | `outcome`: `completed` / `deferred`; `provider_id` |
| `app_updated` | First launch on a new version | `from_version`, `to_version` |
| `analytics_disabled` | Sent once, synchronously flushed, at the moment the user turns it off, *before* the ID is deleted. Lets us see opt-out rate. | — |

### Core use

| Event | When | Properties |
| --- | --- | --- |
| `chat_message_sent` | `chat:start` returns `started` (`main/handlers/chat.ts:29`, `main/services/chat-generation-start.ts:10`) | `provider_id`, `model_id`, `in_workspace` (bool), `thinking` (`off`/`low`/`medium`/`high`/…), `origin` (`desktop`/`phone`/`bot`/`schedule`) |
| `chat_created` | `chats:create*` (`main/handlers/chats.ts:154,280,289`) | `workspace_kind`: `folder` / `scratch` / `worktree` / `none` |
| `provider_connected` | `providers:save` and OAuth completion (`main/handlers/providers.ts:157,197`) | `provider_id`, `auth`: `key` / `oauth` / `local` |
| `workspace_added` | `workspaces:create*`, `openPath` (`main/handlers/workspaces.ts:164,168,199`, `workspace-intake.ts:66`) | `kind`: `folder` / `scratch` / `path` |

### Big features

| Event | When | Properties |
| --- | --- | --- |
| `bot_created` | `bots:create`, `bots:createFromPreset` (`main/handlers/bot-access.ts:97`, `bots.ts:161`) | `preset_id` (bundled or `custom`), `bot_count` bucket (`1`, `2-3`, `4-10`, `11+`) |
| `bot_routine_ran` | Routine executor (`main/services/scheduled-bot-routines.ts:242`) | `trigger`: `automatic` / `manual` / `catch_up` / `retry` / `file_change` / `webhook` (from `ScheduledRunTrigger`, `main/services/schedule-service-core.ts:16`; `event` is split by its source); `result`: `success` / `failed` |
| `scheduled_task_ran` | `run()` (`main/services/schedule-execution.ts:352`) | `trigger` (same enum), `result`: `success` / `silent` / `failed` |
| `subagent_launched` | `launch()` (`main/services/subagents/background-subagent-coordinator-v2.ts:111`) | `role`: `scout` / `planner` / `reviewer` / `implementer` / `other` |
| `skill_used` | Skill turn commit (`main/services/skill-invocation-turn.ts:74`) | `source`: `builtin` / `user`. Built-in skill name only when `builtin`. |
| `connector_added` | `mcp:save` (`main/handlers/phase2.ts:433`) | `preset_id` (bundled or `custom`), `transport`: `stdio` / `http` |
| `web_search_used` | `search()` (`main/services/web-search.ts:292`) | `search_provider` |
| `voice_used` | `assistant-live:start`, `dictation:result`, `tts:start` (`main/handlers/assistant-live.ts:39`, `dictation.ts:16`, `tts.ts:113`) | `mode`: `live` / `dictation` / `read_aloud`; `engine`: `local` / `cloud` |
| `phone_paired` | Pairing **completes** in the Aiden Remote service (the async point where a device is added to the paired list; `remote:setupPairing` / `remote:beginPairing` at `main/handlers/aiden-remote.ts:162,186` only start it) | `transport`: `lan` / `tailscale`; `device_count` bucket |
| `peer_mac_paired` | Peer pairing completes (`main/handlers/peer-pairing.ts:155`) | `method`: `discovery` / `code` / `link` |
| `computer_use_enabled` | Global switch turned on: `computerUse:setEnabled(true)` (`main/handlers/computer-use.ts:53`). Per-chat access-card grants are not counted. | — |
| `bot_computer_set_up` | Set up completes (`main/handlers/bot-computers.ts:97`) | `element_control` (bool) |
| `terminal_opened` | `terminal:create` (`main/handlers/terminal.ts:91`) | — |
| `git_commit` | `git:commit` succeeds (`main/handlers/workspaces.ts:299`) | `pushed` (bool, set by a following `git:push` within the same action if available; otherwise separate) |
| `worktree_created` | `git:createWorktree` (`main/handlers/workspaces.ts:357`) | — |

Only success moments are counted. Subagent turns are not `chat_message_sent` events; they are counted once by `subagent_launched`. Line numbers are as of the base commit; the implementer should hook the service function rather than the IPC wrapper where both exist, so CLI and phone-originated actions are counted once.

Deliberately left out (can be added later with one registry entry each): Telegram, in-app browser, simulators, command palette, compaction, follow-through, artifacts, btw side questions, export.

## Crashes and errors

### What is captured

| Source | Hook (existing) | Sent as |
| --- | --- | --- |
| Main-process uncaught exception | `uncaughtExceptionMonitor` in `main/services/process-diagnostics.ts:75` | `$exception` via `captureException`, `level: fatal`, `source: main` |
| Main-process unhandled rejection | Already reaches the same `uncaughtExceptionMonitor` with `origin: "unhandledRejection"`. **No new listener** is added: registering `process.on("unhandledRejection")` would stop Node rethrowing it and so change today's crash behaviour. | `$exception`, `level: fatal`, `source: main`, `origin: unhandled_rejection` |
| Renderer uncaught error / rejection | Listeners exist (`renderer/lib/dev-log.ts:95,98`) and are rate-limited by main, but `reportRendererDiagnostic` (`dev-log.ts:59-89`) sends only `{kind, errorType, context, referenceId}`, with no message or stack. See [Renderer stacks](#renderer-stacks). | `$exception`, `source: renderer` |
| Renderer process gone | `render-process-gone` (`main/index.ts:1249`, `main/services/browser/service.ts:850`) | `app_crashed` with `kind: renderer`, `reason`, `exit_code` (no stack exists) |
| Helper/GPU/utility process gone | `child-process-gone` (`main/index.ts:1720`) | `app_crashed` with `kind: <process type>`, `reason`, `exit_code` |
| Renderer crash loop | existing `renderer-crash-loop` diagnostic event | `app_crashed` with `kind: renderer_loop` |
| Native main-process crash (no JS runs) | **New** run marker: write `<userData>/analytics-run.marker` at launch, delete on clean quit; if present at next launch, the last run ended uncleanly | `app_crashed` with `kind: unclean_exit` on next launch, and `app_opened.launch_kind = after_crash` |

The best tap point is the diagnostics journal: these sources already flow through `writeDiagnosticEvent` (`main/services/diagnostic-journal.ts:549`) with typed names. The analytics sink subscribes to the fatal/crash subset there instead of adding parallel hooks everywhere. The raw `Error` (needed for the stack) is passed alongside where the journal only keeps the projected form.

### Renderer stacks

The owner wants to see every error with a stack, so the renderer-to-main diagnostics IPC is widened (a privacy-contract change, called out in PR 4):
- Only while analytics is enabled and the notice has been shown (main tells the renderer via the status IPC), the renderer adds the raw `name`, `message` and `stack` (capped at 8 KiB) to the existing report.
- **Main sanitizes**, using the same sanitizer as main-process errors. The renderer never sanitizes or decides what is safe.
- The diagnostics journal keeps its current content-free projection; the raw fields go only to the analytics sink and are never written to disk.
- When analytics is off, the IPC payload is exactly what it is today.

### Fatal crashes survive the exit

A fatal main-process exception may kill the process before an async flush finishes. So the sink:
1. Builds the sanitized exception.
2. Writes it synchronously to `<userData>/analytics-pending-crash.json` (one record, overwritten, small).
3. Attempts `captureException` + `flush()` with a 1 s cap.
4. On next launch, if the pending file exists and its ID was not acknowledged as sent, sends it, then deletes it.

If analytics is off at next launch, the pending file is deleted unsent.

### Sanitizing every exception

Before an error reaches `captureException`, the sink rebuilds it as a new `Error`:
- `name`: kept if it matches `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, else `Error`.
- `message`: email addresses are redacted first, then the text runs through the existing `sanitizeDiagnosticText` (`main/services/diagnostics-contract.ts:403`), which already redacts credentials, tokens, authorization values, URLs, POSIX/Windows paths, UUIDs and long IDs, then capped at 300 characters.
- `stack`: each frame's file path rewritten to an app-relative virtual path (e.g. `app:///main/services/foo.js`). Frames outside the app bundle become `<external>` (user workspace scripts, Pi extensions in the user's folders, node internals keep `node:` prefix). Function names are kept. Max 30 frames.
- `cause` chains: sanitized the same way, max depth 3.

Rewriting file paths to `app:///…` has a second purpose: `posthog-node` error tracking reads source context lines from disk for frames it can resolve. Virtual paths cannot resolve, so the SDK never reads files from the user's disk. The implementer must confirm this against the pinned SDK version and, if the SDK exposes an option to disable context lines, set it as well. SDK exception autocapture (`enableExceptionAutocapture`) stays **off**; all capture goes through our sanitizing sink.

Extra properties on exceptions: `source` (`main`/`renderer`/`cli`), `level`, `process_type`, `uptime_bucket` (`<1m`, `1-10m`, `10-60m`, `1h+`). No IPC channel arguments, no route, no window title.

The SDK's `before_send` guard is the last check on every message. It drops every `$`-prefixed property a caller supplies except, on `$exception` only, `$exception_list` (rebuilt from scratch and rejected unless it matches what the sanitizer produces), `$exception_level` and `$exception_fingerprint`; it then forces `$process_person_profile: false`. Turning analytics off revokes the transport's fetch, so a flush or retry already in progress dispatches nothing further; a request already on the wire cannot be recalled.

### Flood control

Per app session:
- At most **25** exception events.
- The same fingerprint (sanitized `name` + top 3 frames) at most **3** times; further repeats are counted and sent once as a property `repeat_count` on the session's last report, or dropped.
- `app_crashed` and fatal exceptions bypass the per-fingerprint cap but count toward the session cap.

### Source maps

Out of scope for v1. If the main/renderer bundles are minified, stacks will be harder to read; a follow-up can upload source maps to PostHog from the release workflow (build-time only, never from the app).

## User-facing surfaces

All UI follows `docs/settings-design-system.md`, `docs/design-guide.md`, `GUI.md` and the ChatGPT inspiration references required by `AGENTS.md`. Screenshots of every new surface go in the PR for the owner's approval.

**Onboarding (new installs).** On the final onboarding step, one grouped-card row: "Share anonymous usage and crash data", trailing switch (on), with a one-line subtitle "Helps improve Aiden. Never includes your chats, files or keys." and a "What's sent" link that opens the event list (below). The onboarding feature-tour gallery is not changed; this is not a feature.

**Existing installs (one-time).** A dismissible notice card on first launch after upgrading: same wording, buttons **OK** and **Turn off**. Dismissing it counts as shown.

**Settings.** In **Settings → Diagnostics** (`renderer/components/settings/diagnostics-settings.tsx`), a new top group "Usage data" (my call; it sits with the existing local diagnostics controls):
- Switch: "Share anonymous usage and crash data".
- Subtitle explains what it is and is not.
- Row: "What's sent" → a sheet listing every event and property, rendered from the same registry the code uses (so the list can never drift from reality).
- When disabled by environment: switch disabled, caption "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)".

**Docs.** A new `docs/analytics.md` describing the posture, the full event list and how to turn it off. The README "Privacy and trust" section and `PRODUCT.md` are updated in the same PR that first enables sending.

## Architecture

```
renderer ── existing diagnostics IPC ──┐
                                       ▼
main/services/analytics/
  analytics-events.ts     typed registry: events, property schemas, enums, buckets
  analytics-consent.ts    enabled / noticeShownAt / installId / env kill switch (settings.json)
  analytics-sanitize.ts   exception rebuild, path rewrite, normalisers (provider/model/preset)
  analytics-core.ts       pure: validate → enrich super props → rate limit → hand to transport
  analytics-client.ts     posthog-node wrapper (only file importing posthog-node); beforeSend guard
  analytics-crash.ts      diagnostics-journal sink, pending-crash file, run marker
  analytics-service.ts    lifecycle: start after consent, daily timer, shutdown on quit
main/handlers/analytics.ts  IPC: get status, set enabled, mark notice shown, list registry for "What's sent"
```

- `analytics-core.ts` takes an injected transport so tests run with a fake and no network.
- Feature call sites use one function: `trackEvent("bot_created", { preset_id, bot_count })`. Type-checked against the registry; unknown event or property is a compile error and also a runtime drop.
- `trackEvent` is fire-and-forget and must never throw into the caller.
- Settings keys live in machine-local `settings.json` under `analytics`: `{ enabled, installId, noticeShownAt, lastActiveDay, lastVersion }`.
- The CLI bundles `main/services` sources directly (see `AGENTS.md`), so it reuses `analytics-events.ts`, `analytics-sanitize.ts` and `analytics-core.ts` unchanged, with its own consent store and client.

## CLI (phase 2)

- Same PostHog project, `surface: "cli"`, separate install ID stored in its own file, `~/.aiden/agent/aiden-analytics.json` (respects `AIDEN_CODING_AGENT_DIR`). Not in `settings.json`, which is Pi's file and is rewritten by Pi and `app-controls.ts`.
- **Notice:** one line on stderr the first time an interactive command runs: "Aiden sends anonymous usage and crash data. Turn off: aiden telemetry off". Not shown and nothing sent for `--version`/`help`.
- **Off by default when not interactive** (my call): if `CI` is set, or stdout is not a TTY and the notice has never been shown, nothing is sent. Scripts and CI should never be counted or surprised.
- `aiden telemetry status | on | off`. `DO_NOT_TRACK=1` and `AIDEN_ANALYTICS=0` work the same as desktop.
- Events: `cli_started` (`command`: from the fixed `dispatchCommand` list in `packages/cli/src/commands.ts:9`, else `interactive`/`other`), plus the shared registry events the CLI can trigger (chat message, bot created, routine ran, scheduled task ran, subagent, skill, connector, web search).
- Crashes: `uncaughtException` / `unhandledRejection` in the CLI process through the same sanitizer; flush with a 1 s cap before exit.
- `packages/cli/src/cli.ts:29–33` forces `PI_TELEMETRY=0` (Pi's own telemetry). That stays: this plan adds Aiden's analytics, not Pi's.
- `posthog-node` added to `packages/cli/package.json` at the exact same version as the desktop pin.

## Docs and policy changes

Same PR as the first behaviour that sends data (PR 2):
- `AGENTS.md`: new **Product analytics** section (fixed host, main-process only, registry-only events, no content, consent gate, kill switches, dev builds never send, no flags/replay/autocapture).
- `docs/plans/logging-and-diagnostics-upgrade-plan.md`: add a dated note under Non-goals pointing here. Diagnostics itself still has no upload path; the journal is never sent. Existing text is history and is not rewritten.
- `scripts/diagnostic-policy.test.mjs`: unchanged expectations (Crashpad stays upload-disabled); extend if it asserts there is no upload path at all, scoping that claim to diagnostics.
- `README.md` Privacy and trust, `PRODUCT.md`, new `docs/analytics.md`.
- `ios/APP_STORE_METADATA.md:83` says Aiden runs no "analytics endpoint". The phone apps still don't, but the claim is about Aiden overall, so reword it to scope it to the phone app.
- `docs/plans/README.md` status row.
- External: the privacy policy (wherever it is published) must describe this before the first release that sends.

## Tests

Behavioural, per `AGENTS.md` house style; every new file registered in the root `package.json` test chain and `scripts/ci-test-registry.json` (run `npm run test:ci-policy`).

- `analytics-core.test.ts`: unknown events and properties are dropped; super properties attached; `$process_person_profile: false` on every payload; nothing reaches the transport when disabled, when the notice has not been shown, or when `DO_NOT_TRACK=1`; per-session and per-fingerprint caps; `trackEvent` never throws when the transport throws.
- `analytics-sanitize.test.ts`: fixture errors containing a home path, workspace path, `sk-…` key, bearer token, email, credentialed URL and a long prompt-like message come out with none of those substrings; frames outside the bundle become `<external>`; `cause` depth cap; provider/model/preset normalisers map unknown values to `custom`.
- `analytics-consent.test.ts`: turning off deletes the install ID and pending crash record; turning back on yields a new ID; upgrade path sets the existing-user notice requirement.
- `analytics-crash.test.ts`: a fatal error writes the pending record synchronously; next start sends it once and deletes it; run marker present at start produces exactly one `unclean_exit`.
- IPC register-and-invoke test for `main/handlers/analytics.ts`.
- Renderer: Settings group and onboarding row render, toggle calls IPC, environment-disabled state; "What's sent" lists registry entries (assert on a couple of known events, not a full snapshot).
- Playwright E2E: onboarding shows the row with the switch on; turning it off in Settings persists across relaunch. E2E runs without a key, so no network.
- A packaged-build check in the release workflow that the key constant is present only in `dist` output, never in the repo.
- CLI: `aiden telemetry off|on|status`, notice shown once, no send when `CI` is set or non-TTY, shared registry events validated.

## Delivery (one PR each, stacked)

1. **Core, no sending.** `main/services/analytics/*` (registry, consent, sanitizer, core with fake transport, client wrapper, crash sink), `posthog-node` pinned exactly, tests. No key, no UI, nothing wired. Safe to merge on its own. Because nothing in main imports the client yet, `posthog-node` sits in `devDependencies` (as `scripts/main-runtime-dependencies.test.mjs` requires); PR 2 moves it to `dependencies` when main starts importing it.
2. **Consent, lifecycle and "who's using it".** (In review, stacked on PR 1.) Settings group, onboarding row, existing-user notice, "What's sent" sheet, IPC, release-key injection, `app_opened` / `app_active` / `onboarding_finished` / `app_updated` / `analytics_disabled`. All docs and policy changes above. Screenshots in the PR.
3. **Feature events.** Wire the core-use and big-feature tables at service level.
4. **Crashes and errors.** Journal sink (including rejections via the existing monitor), widened renderer IPC with main-side sanitizing, process-gone events, run marker, pending-crash file, flood control.
5. **CLI.** Consent store, notice, `aiden telemetry`, `cli_started`, shared events, crash capture, `packages/cli/README.md`.

Each PR runs the narrow suites locally before CI; PR 2 onwards also checks a packaged build sends to a test PostHog project (owner key) and that turning it off stops traffic (verified with a local proxy or the PostHog live events view).

## Owner setup (outside the code)

1. Create one PostHog project in the US cloud.
2. Project settings: **Discard client IP data** on; session replay, autocapture, heatmaps, surveys and web analytics off; data retention left at PostHog's default.
3. Add the project API key as the `AIDEN_POSTHOG_PROJECT_KEY` release CI secret.
4. Dashboards: DAU/WAU/MAU from `app_opened` + `app_active` by unique `distinct_id`; feature adoption (% of weekly actives firing each feature event); version and platform split; opt-out rate; Error Tracking issues list.
5. Update the published privacy policy.

Done 2026-10-30: project "aiden" (id 619947) in the US cloud with client IP discarded; session replay, autocapture, heatmaps, surveys, console log capture and performance capture off; the `AIDEN_POSTHOG_PROJECT_KEY` repository secret added. Dashboards and the privacy policy remain.

## Cost

PostHog's free tier currently covers 1M product events and 100k exceptions per month, which is far beyond what a small group generates. `chat_message_sent` is the highest-volume event; if volume ever matters it can be sampled.

## Lessons from t3code (2026-10-30)

At the owner's request we read how [pingdotgg/t3code](https://github.com/pingdotgg/t3code) sends PostHog analytics.

What it does:
- No PostHog SDK. A hand-written client in its Node server posts to `/batch/` through its own ingest proxy. Each event gets a UUIDv7; batches of 20 flush every 10 s; failures back off with jitter from 2 s to 5 min and are dropped after 30 min, or at once on 400, 401 or 413; a 1,000-event buffer drops the oldest.
- Identity is a hash of the person's Codex `account_id` or Claude `userID`, read from `~/.codex/auth.json` and `~/.claude.json` with unsalted SHA-256. That is a pseudonymous identifier that links one person across installs and products.
- On by default with only an environment-variable opt-out: no Settings switch, no `DO_NOT_TRACK`, and events are sent before any notice. The project key is hard-coded and dev builds send, labelled by a build-time channel.
- Free-form event names with per-property allowlists; a model is reported only when it is a non-custom entry in a vendor catalog. No PostHog error tracking.

What we adopted:
- The retry and rejection rules above. `posthog-node` already implements them, so we document and test them (`analytics-client.test.ts` proves a rejected batch is dropped, not retried) instead of writing our own sender.
- Counting active users from real actions as well as `app_active`, and never from reconnects.
- Never reporting model names for providers whose model lists come from the person's own setup.
- The build-time `channel` property as a second guard against non-release traffic.
- An explicit rule that launches no person started never send, and an explicit queue-overflow policy (drop oldest).

What we deliberately do not copy: identity derived from other products' account files, a hard-coded key in source, sending before the notice, sending from dev builds, and an opt-out that only exists as an environment variable.

## Resolved questions (owner, 2026-10-29)

1. **Region:** PostHog US cloud (`https://us.i.posthog.com`).
2. **Retention:** PostHog's plan default.
3. **`analytics_disabled` event:** keep it, to measure the opt-out rate.

## Calls made by the planner (owner may override)

- Crash reports go to PostHog Error Tracking rather than Sentry; native minidumps stay local.
- No events or crashes are sent until the notice has been shown, including for upgrading users.
- `DO_NOT_TRACK` / `AIDEN_ANALYTICS=0` kill switches on desktop as well as CLI.
- Daily `app_active` heartbeat for accurate DAU on a long-running desktop app.
- CLI sends nothing in CI or non-interactive first runs.
- Settings control lives in Settings → Diagnostics.
- Unknown provider/model/preset IDs are reported as `custom`.
- No on-disk event queue apart from the single pending-crash record.
- Main-process unhandled rejections keep today's fatal behaviour; no new listener.
- Renderer errors gain message and stack only while analytics is on, sanitized in main.
- `computer_use_enabled` counts only the global switch.
- Release workflow fails without the key; its own smoke runs never send.
- CLI analytics state lives in its own file, not Pi's `settings.json`.
