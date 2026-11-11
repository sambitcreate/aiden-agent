# Upstream week of 2026-11-11: integration plan

Status: Planned (2026-11-11) against `main` at `6b1ab304e` (0.64.0, Pi 1.4.0).

This plan covers ten upstream items from Pi, T3 Code and OpenCode. Before writing it, four read-only research passes read each upstream PR or commit diff and traced it to the matching Aiden code. Several items turned out smaller than their headlines, and two turned out not to apply. The findings below record why, so the same items are not re-proposed.

## Findings that change the brief

- **Pi #11961 (provider cleanup when a harness closes) is not in v1.5.2.** It is commit `64c96d00d`, which is still unreleased. pi-ai 1.5.2 already exports `cleanupSessionResources(sessionId)`, so Aiden calls it from the Bot harness close path itself until the fix ships.
- **Pi 473515f9c (suspendable durable work) is not in v1.5.2.** It landed upstream on 2026-11-11, unreleased, together with the durable fixes #12041, #12055 and `628d8ab52`. Its workstream (W3) is blocked on the next Pi release.
- **Pi 1.5.0 breaks the build.** pi-ai no longer exports TypeBox (`Type`, `Static`, `TSchema`, `StringEnum`). About 70 non-test Aiden files import TypeBox from `@earendil-works/pi-ai`. The bump adds `typebox` as an exact direct dependency and codemods those imports.
- **T3 #24138 (steer during auto-compaction) already holds in Aiden.** Steer stays available during in-run compaction on desktop, iOS and Android. Only a manual `/compact` holds the queue, which is T3's new rule.
- **T3 #32583 (keep the interrupted prompt on steer) does not apply.** A Pi steer never cancels the run. It is added at the next turn boundary, so the original prompt stays in context.
- **T3 #31266 (keep thread history on stop) does not apply.** Stop writes no interrupt record. Partial text, reasoning and the timeline are saved on desktop, the server and phones.
- **T3 #31857 maps to background jobs.** Aiden has no user-defined project actions. Its equivalent is agent-started background jobs (`main/services/follow-through/background-jobs.ts`).
- **T3 #33548 uses GitHub's event-subscriptions preview, which only GitHub App sign-ins can use.** Aiden reads GitHub through environment or `gh` credentials. Phase A instead nudges follows from local events and adds ETag-probed reads. Phase B is a spike.

## Workstreams and PRs

Each row is one thread. Rows in the same workstream stack in the order listed. Remote protocol revisions are claimed when a PR merges, not when it is written. iOS, Android and the fixture contract change together.

| ID | PR | Depends on | Surfaces | Protocol |
| --- | --- | --- | --- | --- |
| W1a | Pi 1.4.0 → 1.5.2 bump, desktop and CLI in lockstep | — | main, CLI | none |
| W1b | `aiden serve` refuses turns when the workspace folder is missing (parity with desktop) | W1a | CLI | none |
| W1c | Relink folder / continue in a new chat here when a folder is gone (Pi #11975 analog) | W1b | desktop, phones | next revision |
| W2 | MCP OAuth: refresh early, single-flight under a shared lock (OpenCode #63028, #62827) | W1a | main, CLI | none |
| W3 | Suspendable approvals, hook asks and hand-offs on pi-durable signals (Pi 473515f9c) | next Pi release | main, CLI, phones | next revision |
| W4a | Use Aiden from other apps over MCP: core server, `agent` audience, loopback listener (T3 #33196) | — | main, CLI core | none |
| W4b | Settings → Connections → Other apps, Connect sheet, IPC, docs and onboarding tour tile | W4a | desktop | none |
| W4c | `aiden serve` hosts `/mcp`, plus `aiden apps list/connect/revoke`, CLI docs | W4a | CLI | none |
| W4d | Analytics events `mcp_app_connected`, `mcp_chat_started` | W4b, W4c | main, CLI | none |
| W5 | Stopped, not failed: a user-stopped step reads "stopped" and is not an issue (T3 #33291) | — | desktop, iOS, Android | none |
| W6a | Late steer on desktop falls back to the queue instead of throwing (T3 #32899) | — | renderer | none |
| W6b | Input saved after the run's queue closed is answered by a new run (T3 #32899) | W1a | main | none |
| W7 | MCP tool results that break the output schema are returned, not failed (OpenCode #61254) | — | main, CLI | none |
| W8 | Background jobs can stop when their chat settles (T3 #31857) | — | desktop | next revision |
| W9 | Followed PRs check right away after local events, with ETag probes (T3 #33548 phase A) | — | desktop | none |

### W1a: Pi 1.5.2 bump

- **Pins.** Bump every exact Pi pin in the root and `packages/cli` `package.json` to 1.5.2 and add `typebox` at the version coding-agent 1.5.2 depends on. The frozen 0.87.1 alias stays. Install with `npx npm@11.11.0 install`. Bump `PI_AI_VERSION` in `scripts/patch-pi-oauth-branding.mjs` and check that the patch still applies to the changed Anthropic OAuth file. Bump the catalog version and generated-at in `main/services/pi-remote-catalog.ts`.
- **Code changes Pi 1.5 forces:**
  - TypeBox import codemod.
  - pi-durable `WatchCall` and `WatchEnd` are tagged unions. Call sites are in `aiden-remote-bot-session.ts`, `bot-runtime/live-projection.ts`, `bot-runtime/bot-session-service.ts` and `bot-open-work/stop.ts`.
  - `ConversationView.entries` is now a window of the newest entries. Projections and `bot-intro.ts` must read the full transcript.
  - `onReport` receives a tagged `Report`, `session_failed` became `storage_failed`, and `harness.closed` resolves a tagged `SessionEnd`.
  - `Conversation.viewState()` is removed. Move its callers to `Conversation.watch()`: the test harness `kill-harness.mjs` and `main/services/bot-runtime/tool-adapter.test.ts`.
  - New unanswered reasons (`interrupted`, `turn_limit`, `nothing_to_answer`, `restart_limit`). Review `interruptedBots` and the `reason === "aborted"` checks.
  - `afterTool` now runs on harness-written errors. Bot PostToolUse hooks skip them.
- **Behavior Aiden keeps from 1.4.0:**
  - `aiden serve` passes `cacheWarming` from Aiden's `cacheWarmingEnabled` instead of Pi's new `"idle"` default.
  - Desktop cache-warm requests set `disableContinuation: true`.
  - Anthropic message threads stay off until a separate privacy decision is made.
- **Wire up.** Call `cleanupSessionResources` when a Bot harness closes.
- **One-way migration.** A Bot database opened with 1.5.2 cannot be opened by an older build (`task_too_old`). Say so in the release notes.
- **Verification.** Run `test:compaction:evaluate` (replay gate), `test:compaction`, `test:bot-runtime`, the hook suites, `cli:build` plus the bundle and CLI tests, `npm run test`, and the Bot live-view E2E in a Cua Space. Also run the run-lifecycle harness tests named in W6b.
- **Docs.** README, `packages/cli/README.md`, this index, and a new `.memory/pi-1.5.2-upgrade.md`.

### W2: MCP OAuth refresh

- Store an absolute `expiresAt` on `McpOAuthSession`. Older records keep today's refresh-on-401.
- `withRefreshLock(serverId, fn)` is held across the whole refresh. On desktop it is an in-process keyed mutex. In the CLI it is a per-server lease file, not the shared writer lease.
- Inside the lock, re-read the session. If the stored token differs from the rejected one, use the stored token. Otherwise refresh and save with the existing compare-and-swap.
- Refresh 30 s before expiry. On a transient failure, send the current token. `invalid_grant`, `invalid_client` and `unauthorized_client` sign out.
- If pi-mcp 1.5.2's `createMcpAuthProvider` fits Aiden's store, adopt it instead of writing a parallel provider.
- Tests use `mcp-oauth-test-server.ts`:
  - two clients sharing one expired token cause exactly one refresh;
  - two CLI store instances cause one refresh;
  - a token inside the 30 s window is refreshed early, with no 401;
  - a 503 keeps the sign-in.

### W3: suspendable durable work (blocked)

- Each Bot approval, hook ask and hand-off becomes a `readSignal` gate that sleeps with a memoised `until` deadline. Answer paths call `harness.signal`. Expiry comes from the wake reason instead of a JS timer.
- `closeIfIdle` may close a Bot whose only work is parked.
- Async hooks become `hookTask`s, so they survive restarts.
- Bot status reads "Waiting for approval". The run watchdog treats sleeping and waiting as healthy.
- The Remote protocol gains a waiting reason and deadline.
- Daemon workspace-chat todos already survive restarts through journal replay. Durable todo work applies only to Bot task tracking.
- This is a second one-way database upgrade.

### W4: Aiden as an MCP server

- **Architecture.** A thin adapter, `main/services/aiden-mcp-server*.ts`, calls `AidenRemoteChatService` and `AidenRemoteStreamService`. There is no new execution path. It reuses the hardening in `main/services/acp/mcp-bridge.ts`.
- **Transport.** Streamable HTTP on a stable `127.0.0.1` port, with Host/Origin validation and no CORS.
- **Identity.** Each connected app is a remote device of type `agent`. Its capabilities are limited to `server:read`, `chat:read` and, for Supervised, `chat:write`.
- **Audience boundary.** `/api/aiden/v1` refuses `agent` credentials, and `/mcp` refuses phone and Mac credentials.
- **v1 tools:**
  - Reads: `aiden_server_info`, `aiden_workspace_list`, `aiden_chat_list`, `aiden_chat_read` and a bounded `aiden_chat_wait`.
  - Writes: `aiden_chat_start` (idempotent by `clientRequestId`), `aiden_chat_send` and `aiden_chat_stop`.
  - An outside app can never answer an approval or a question. Those stay on the desktop and phones, first responder wins.
- **Auth.** v1 uses a bearer token shown once, with copyable `claude mcp add` and `codex mcp add` snippets. OAuth 2.1 (discovery, PKCE, dynamic registration) is a later PR.
- **Out of scope for v1.** Hosted apps such as ChatGPT or claude.ai need a public tunnel, which is a separate posture decision.
- **Safety.** Per-app turn rate limits and a concurrent-run cap. Revoking an app ends its in-flight streams.
- **Platforms.** Add a new `mcpServer` capability in `host-platform-capabilities.ts`, on wherever Remote Access is.
- **Docs and onboarding.** W4b documents the feature (README, PRODUCT, a new `docs/aiden-mcp-server.md` covering local-only scope, the bearer token, capabilities and revocation) and adds a feature-tour tile with its own code-drawn art in `renderer/components/onboarding-art/`, covered by the onboarding gallery and art tests. W4c documents `/mcp` and `aiden apps` in `packages/cli/README.md` and the same guide.

### W5: stopped, not failed

A step that is `cancelled` in a timeline whose `cancellationOrigin` is `user_stop`:

- reads "X stopped" in a neutral tone;
- does not count as an issue;
- does not force the activity trail open.

Desktop (`renderer/lib/agent-steps.ts`, `activity-feed.tsx`), iOS and Android change together. Android currently draws a red error icon for it.

Steps cancelled by app shutdown or chat deletion keep today's treatment. The decoder-level `isIssue` stays unchanged, because the claim-check validators depend on it, so the new check is display-only.

### W6: late steers

- **W6a.** If the run has already ended, `steerMessage` and `steerQueued` put the message on the document queue instead of throwing.
- **W6b.** Input that the admission step saved after `agent_end` closed the queue becomes the chat's next turn. There is no new queue contract and no protocol revision.
  - Main returns the `follow-up` receipt only after it has registered the owed input as the chat's next turn, inside the same section that commits it. From then on it is an ordinary turn, so the receipt (shown on phones as "Queued to run next") is true.
  - A later Stop stops that turn the normal way. The input stays in history as a stopped turn, like any stopped message, and nothing reruns automatically.
  - If the settling run fails after the commit, the owed turn still starts, because it is its own turn and not a retry. A failure inside the owed turn ends that turn only and never loops.
  - If main cannot register the turn (chat deleted, app shutting down, run lifecycle already closing), it returns `committed`, not `follow-up`. Clients show the existing "saved, not answered" treatment and the person can resend.
  - Phones need nothing new: they already render the `follow-up` and `committed` receipts and see the next turn through the normal stream.
  - Tests: Stop right after a `follow-up` receipt leaves exactly one stopped turn and no rerun; a failure in the settle window still starts the owed turn exactly once; deleting the chat or shutting down before registration gives a `committed` receipt.

### W7: lenient output schemas

`validateResult` in `mcp-tool-inventory.ts` gains a mode:

- **Advisory** (the default for agent-facing calls on desktop, subagents and the CLI) returns the result with at most a short diagnostic.
- **Strict** stays for the Composio facade, connector watches and internal parsers.

The pre-dispatch schema compile stays a hard block.

### W8: stop background jobs when a chat settles

- An optional `stop_when_chat_settles` parameter on `background_job start` is persisted on the job.
- A settlement core with an injected clock starts a 20-minute quiet window when a run ends. A new run cancels the window, and a busy chat or a pending notice defers it.
- `BackgroundJobs.stopSettled(chatId)` stops only opted-in jobs, with the new end reason `chat-settled`. Phones already show unknown reasons as "Stopped". The TypeScript Remote enum gains the value in the next revision.

### W9: followed PRs react to local events

- `PullRequestFollows.nudge(chatId, key)` is rate-limited. It fires when a run ends in a chat with an active follow, when the head branch's remote ref moves, on the Following list or Check now, and on wake or coming back online.
- An optional REST `If-None-Match` probe skips the GraphQL read on a 304.
- The network promise stays the same: reads for that pull request only, until the follow ends. The GitHub notifications API is not used.
- Phase B is a one-shot spike that tests whether the event-subscriptions preview accepts a `gh` token.

## Defaults chosen (owner may override)

1. Anthropic message threads stay off, and `aiden serve` follows `cacheWarmingEnabled`, matching 1.4.0 behavior.
2. W3 waits for a tagged Pi release rather than pinning an unreleased commit.
3. W4 v1 is local apps only, uses a token rather than OAuth, offers Read only and Supervised levels, and does not let outside apps answer agent questions.
4. W5 treats only `user_stop` cancellations as "stopped".
5. W6b reuses the existing `admitted`/`follow-up` receipt, so there is no protocol revision.
6. W8 is an agent opt-in per job with a 20-minute quiet window, and claims a new end reason with a revision.
7. W9 ships phase A. Phase B stays a spike.
