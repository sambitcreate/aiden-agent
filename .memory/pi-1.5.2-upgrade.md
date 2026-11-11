# Pi 1.5.2 upgrade (2026-11-11)

The live desktop and CLI Pi packages are pinned exactly at 1.5.2, in lockstep. The packages are the same as for 1.4.0: on the root, pi-agent-core, pi-ai, chord, pi-durable, pi-mcp and pi-codemode; on the CLI, pi-coding-agent, pi-ai, pi-agent-core, pi-codemode, pi-mcp, pi-durable and chord. This is W1a of `docs/plans/upstream-week-2026-11-11-plan.md`. The frozen 0.87.1 legacy harness is unchanged. Install with `npx npm@11.11.0 install`.

These were bumped with the pin:
- `PI_AI_VERSION` in `scripts/patch-pi-oauth-branding.mjs`
- `AIDEN_PI_CATALOG_VERSION` / `AIDEN_PI_CATALOG_GENERATED_AT` in `main/services/pi-remote-catalog.ts`, from pi-ai's `dist/providers/data/.manifest.json` (2026-11-10T12:05:37.628Z)

## Dependency changes

- **TypeBox.** pi-ai 1.5 no longer re-exports TypeBox (`Type`, `Static`, `TSchema`).
  - Every tool schema now imports from `typebox`, which is a direct root dependency at exactly `1.3.27`. The CLI bundles it.
  - Tool arguments are validated as JSON Schema by `@earendil-works/pi-schema`, and TypeBox's own validator no longer runs.
  - Aiden uses no TypeBox-only features (`Type.Refine`, `BigInt`, `Undefined`, `Void`, codecs, `Format.Set`).
  - Some tests asserted the old validation wording and were updated.
- **chord 1.5.2 peers.** chord declares exact optional peers `react 19.3.0` and `ws 8.21.0`. Without help, npm moved React to 19.3.0 while react-dom stayed at 19.2.7, which breaks every renderer test with "Incompatible React versions". It also moved ws backwards.
  - The root `overrides` entry `"@earendil-works/chord@1.5.2": { react: "19.2.7", ws: "8.21.1" }` keeps main's versions.
  - The CLI's entry keeps `ws 8.22.0`.
  - When React or ws is bumped, or chord is bumped, update or drop these overrides.

## Behavior Aiden keeps from 1.4.0

- **Anthropic message threads are off.**
  - pi-ai 1.5.1 continues a server-side thread for an Anthropic request with a sessionId, and sends only the new messages. This is on by default for the `anthropic` provider at api.anthropic.com.
  - `main/services/pi-message-threads.ts` `withoutMessageThreads()` sets `compat.supportsMessageThreads: false` on every Anthropic model Aiden resolves. That covers:
    - desktop `model-runtime.ts` and `model-runtime-core.ts`, which Bots use too
    - CLI `daemon-chats.ts`, `scheduled-inference.ts` and `pi-bridge/model-runtime.ts`
  - Cache-warming replays set `disableContinuation: true`.
  - Turning threads on needs a replay-gate evaluation first.
  - Test: `packages/cli/tests/daemon-turns.test.mjs`, "an Anthropic chat sends its whole conversation on every turn, never a message thread".
- **Server cache warming stays "streaming".**
  - coding-agent 1.5.1 changed the default to "idle": paid one-token refreshes for up to 30 minutes after a turn.
  - `packages/cli/src/daemon-session-settings.ts` `daemonSettingsManager()` keeps "streaming" for daemon chat turns and scheduled tasks. An explicit valid `cacheWarming` in the profile's `settings.json` still wins.
  - The CLI has no `cacheWarmingEnabled` setting; the desktop's idle warming is its own opt-in setting.
- **Whole active transcript in Bot watches.**
  - Pi Durable 1.5 `Conversation.watch()` frames are a window: the newest 50 entries, spliced back to 50 past 100, with head markers kept in place.
  - `main/services/bot-runtime/active-transcript-watch.ts` `watchActiveConversation()` rebuilds 1.4.0's frame from `conversation.context()`. It re-reads on a head marker, or when the window skipped entries.
  - `live-projection.ts` and `aiden-remote-bot-session.ts` use it.
  - Test: `active-transcript-watch.test.ts`.

## Pi Durable 1.5 behavior changes Aiden absorbs

- **Crash recovery charges a retry.**
  - A generation whose request was in flight when the host died is no longer resent on open. The attempt counts against `settings.retry`, and its partial becomes an aborted entry.
  - With no retry left, the run ends with `runFailure` reason `interrupted`, and its inputs settle `unanswered`.
  - Bot recovery still waits for the person's Resume.
- **Restart-limited tasks end instead of parking.** `retryTask` and `task_parked` are gone. `BOT_HARNESS_SETTINGS.restartLimit: Infinity` is unchanged.
- **Deferred progress stores.**
  - Partial answers are shown at once but stored with the next `pi.live` commit, or after at most `progress.persistWithinMs` (1,000 ms).
  - A crash loses up to about a second of streamed text, and a stream killed before its first store leaves no aborted entry. Aiden keeps the default.
  - The crash-test child (`test-support/kill-harness.mjs` `stream`) announces STREAMING only once `observeCommits` shows the partial stored.
- **A settled wait can precede its store.**
  - Commits are adopted and then stored, so `submission.wait()` can resolve "done" and the store can still fail. The next read then throws `SessionFailed`.
  - `awaitReply` catches `SessionFailed` from `settledOutcome` and reads the answer back from the reopened session, the same as `replyAfterFailedWait`.
  - Test: "a reply whose answer committed just before a storage failure is delivered".
- **API renames migrated.**
  - watch listeners take `{ kind: "value", value, ops }`
  - `onReport(report)` with `report.kind` / `report.error`
  - `subscribeCommits` → `observeCommits`
  - `pi.live` `reason` → `trigger`
  - `TaskInspection` `ready` → `pending`
- **One-way migration (no downgrade).**
  - The first write moves stored data forward: the `pi.live` document goes to v3 (v2 renamed `reason` → `trigger`, v3 adds `run.turns`), and new `pi.tool` and `pi.generation` tasks are written at v3 and v2.
  - Aiden or a CLI built on Pi 1.4.0 cannot read a Bot conversation 1.5 wrote to.
  - `task_outdated` reasons are now `task_too_old` / `migration_failed`. Aiden matches none of them.
  - Downgrading the app after a Bot ran on 1.5.2 is not supported.
  - The next version-bump PR must add `docs/release-notes/v<version>.md` saying so, as `v0.62.0.md` did for 1.4.0. Per `docs/release-notes/README.md`, these files belong only in the version-bump PR.

## Catalog

pi-ai 1.5.2 removes some models, among them:
- gpt-realtime-2.1 (openai, azure)
- gemini-3.1-flash-lite-image and gemini-3.1-flash-live-preview
- radius gpt-5.3-codex / gpt-5.4 / gpt-5.4-mini / gpt-5.5
- several mistral, fireworks, huggingface, nvidia, opencode, openrouter and vercel IDs

It adds the provider `qwen-token-plan-individual-cn`, which has no bundled logo, so it uses the initial fallback.

No app source references a removed ID. A saved selection of a removed model shows as unavailable until the person picks another. `resources/model-capabilities.json` is display-only.

## CLI branding anchors

`patch-branding.mjs` system-prompt anchors now match 1.5.2's text:
- "running inside Aiden, a coding agent harness"
- "Engine documentation (read only …)"
- "When reading engine docs"

Pi 1.5 dropped the other pi mentions upstream. The `build.mjs` cli.md MCP anchor is `pi mcp <add|remove|list|login|logout> [options]`.

## Validation (local Mac)

- Root and CLI type-check.
- Replay gate `scripts/pi-upgrade-evaluation.mjs`: 7/7 passed, run with a scratch receipt dir and `node` as the executable.
- `test:bot-runtime` (crash suites rerun after the fixes), `test:compaction`, `test:hooks`.
- CLI build plus the CLI tests: 309 pass, 3 skipped.
- `test:ci-policy` 80/80; Bot lifecycle and harness suites 147 pass; `aiden-remote-bot-session.test.ts` 134 pass; `aiden-remote-router.test.ts` 113 pass.
- Bot Playwright E2E in a Cua Space (`bots-persistence`, `bot-messaging`, `bot-open-work`, `bot-plans`, `bots-starter`): 7 passed, 1 skipped.
- Known local environment failure, unrelated to Pi: `scripts/aiden-remote-lan-transport-spike.test.mjs` fails 4 tests on Homebrew OpenSSL 4.1.0, which rejects `x509 -days 0`.
