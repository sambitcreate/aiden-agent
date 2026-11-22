# Coding follow-through — 2026-10-26

Background jobs, following a pull request until it merges, and `/until <check>`. Plan: docs/plans/coding-follow-through-plan.md; guide: docs/coding-follow-through.md. Code lives in `main/services/follow-through/` with shared contracts in `renderer/shared/{agent-notices,background-jobs,follow-through}.ts`.

Owner rules (2026-10-26): job ends are reported to the chat; macOS and Linux; following builds on `main/services/github/`; only owner/write-access comments reach the agent; logs are data; the check loop stops after 5 tries. Do not name the research source in PRs, commits, code or docs.

Design decisions worth keeping:

- A notice is a user-role message with a `notice` field (`AgentNoticeV1`); the content is model-facing and fences untrusted text with `fenceAsData`. Clients without a card show `agentNoticeDisplayText` (the Remote projection does this, so phones need no change and there is no protocol revision).
- Delivery order: queue into a running turn (`llmClient.admitAgentNotice`), else start an unattended turn (headless owner, approvals and questions detached, no subagents/Computer Use/MCP) when `wake` is true and the chat has wake budget left (6/hour), else append only. Never wake for passes, merges or closes, or the loop never settles.
- The agent's own GitHub comments come back as `byViewer` comments; they are dropped only when made during that chat's run windows (from `hostRunRegistry`), so the person writing on GitHub with the same account still counts.
- `BackgroundJobs.settle` marks a job watched so a job that ends during the tool's start wait is reported once (in the tool result), not twice.
- Crash reaping matches pid and `ps -o lstart=` start time before signalling a leftover process group. If the shell had already exited, it signals only group members whose environment has `AIDEN_BACKGROUND_JOB=<job id>` (`/proc/<pid>/environ` on Linux, `ps -E` on macOS), re-listed before each of up to 3 SIGKILL rounds (a TERM handler can spawn a child); marked survivors stay in `running.json` via `carriedOver`, which every record write includes. While Aiden runs, a shell's `exit` ends the rest of its group, because `close` waits for every holder of the output pipes.
- Seen comment ids always keep every id the latest read returned (up to 660 per read) plus 300 older ones.
- `/until` replacing a running check with runNow waits for the old run to stop (`runWhenFree`), then runs.
- A done-when check interrupted by quit returns to waiting with its count restored; nothing reruns on launch.
- `llm-client.ts` imports follow-through tools dynamically to avoid an import cycle; only `background-job-tool.ts` is imported statically (for the Ask-mode approval check).

Tests: `npm run test:follow-through` (registered in `test:serial` and the core-git/renderer-other lanes). coding-tools.test.ts needs `npm run build:worktree-file-io`, `node scripts/build-worktree-file-io.mjs --test` and `npm run build:subagent-file-mutator` first in a fresh container, or 9 pinned-write tests fail.

Found by driving the real app (2026-10-26), now fixed:

- A notice saved without a turn must also send `chats:follow-through-changed` with `transcript: true`; plain `chats:changed` only refreshes the chat list, so the open chat never showed the card.
- Follow-through slash actions commit with the draft-only guard (like clone/export/worktree); the full guard left `/until npm test` in the composer with a "newer draft" toast.
- The jobs list refreshes its clock when it opens; it used to show the time since the chip first appeared.

Screenshots: a throwaway Playwright spec (never committed) seeds PR notices, captures with `webContents.capturePage()` at 2880x1800 / zoom 2, and switches theme through the command palette (Search settings, then Use dark appearance); setting `nativeTheme.themeSource` alone does not change Aiden's theme.

Open: native phone cards, CLI support, hand check on a real Mac.

## macOS marker-visibility limitation, 2026-10-26

CI on the countdown PR exposed that Apple platform executables such as `/bin/sh` and `/bin/sleep` hide their launch environment from `ps -E`. The crash-leftover fixture now uses Node descendants, with a readiness signal after installing its TERM handler, to exercise real observable environment markers, late-spawn cleanup and bystander protection. Production ownership checks are unchanged. If the original leader is gone and a descendant's marker is unobservable, recovery skips that descendant and does not retain its record; this pre-existing limitation remains unresolved and is documented in `docs/coding-follow-through.md`. Do not weaken ownership verification to make that case pass.

## Lifecycle fixes — 2026-11-02

Workspace access changes and managed-worktree removal cancel generations, drain command handoffs and checks, and confirm tracked jobs stopped. Active checks, follows and pending notices hold an empty chat in its workspace. Check commands start behind a pipe until the shared process ledger records the group identity. Recovery runs before startup deletes worktrees or admits new processes. PR polls carry an abort signal through the GitHub read and each failed-job log, and legacy follow records resolve ownership from the chat.

The macOS Electron regression suite is `test:e2e:follow-through`. It kills Electron during a real check, verifies recovery in the same profile, exercises a replaced then removed Git worktree, and revokes a restored follow without contacting GitHub.

Check recovery records carry chat and workspace ownership. A failed signal leaves the record in place and workspace revocation or removal fails until Aiden verifies that no live process remains in the group.

Workspace changes suspend polling and interrupt check attempts before draining jobs. They end the follows and clear the checks only after the permission save, workspace removal, or managed Git destructive boundary. Rejected operations resume polling and keep waiting checks. Chat moves verify retained process liveness while configuration admission is held.

A check whose process cleanup cannot be confirmed returns to waiting with its prior attempt count and posts an informational notice without waking the agent. Workspace cleanup still fails until the group exits.

A failed check-ledger admission keeps the shell gated and leaves the check waiting without a wake or a spent attempt. After verified exit, a failed ledger release is logged and the command keeps its actual result. The stale durable entry is rechecked during recovery.

2026-11-11 (W9 phase A, `claude/pr-follow-event-nudges`): pull request follows take debounced nudges (push, `gh` command, opening the list, focus, wake, online), probe with ETags so an unchanged look skips the full read, and back off quiet pull requests to 30 minutes. Details and the phase B webhook spike notes: `pr-follow-event-nudges.md`.

2026-11-22 (Proactive Aiden C2): chats that check back (`check_back` tool, `CheckBacks` in `follow-through/check-backs.ts`, `checkBacks` in `state.json`, notice source `check_back`) and the args-aware turn refusal in `chat-turn-tool-policy.ts`. Details: `chat-check-backs.md`.

2026-11-22 (Proactive final review): `admitAgentNotice` queues only into the chat's own turn (`agentNoticeRun` in `notice-delivery.ts`; the active entry has an `owedTurn`, i.e. `owesItsChatTurns`). A scheduled task's run (or another feature's run) in the chat returns `"busy"` → `QueueIntoRunResult` `busy` → `NoticeDelivery` waits on `waitForRunToSettle` (main: `waitForChatIdleWithin(chatId, 30 min)`) and then joins or wakes as usual, so a child "ended" or check-back notice never lands, marked delivered, in a run without `child_chats`.
Loop-closing review: a notice waits out another feature's run once (`waitForRunToSettle`, 30 min); still busy after that (check D), it waits again (`waitForRunToEnd`, main: `waitForChatIdleWithin(chatId, LONG_RUN_WAIT_MS)` = 24 h; check E: scheduled and chat runs have NO time limit, so the cap is what frees the chat's notice chain), still with `hasPending` false, then goes to `record` (wake-unavailable / not-waking, never a wake); a record that still finds the chat held drops it and reports through `onError` (logged). Check F: `busy` carries `holder` (stream id; `agentNoticeRun` returns `{busyWith}`, `admitAgentNotice` passes it through); `waitForRunToEnd` returns false on timeout and `NoticeDelivery.outlasted` remembers that holder per chat, so later notices that find the same holder skip both waits and go straight to `record` (one report per run); cleared once the chat is free or held by another run. `append` returns `failed` (not `gone`) when the chat still exists but saving threw, and logs; `record` turns it into a non-gone drop, which the long-wait path reports. `record`'s own busy path only uses the short `waitForIdle` before dropping. `hasPending` is false while a notice waits on another run (`waitingOnRun`), so a goal look isn't held back. Delivery is in memory: only a started chat's ending survives a quit (link `owed` → `recoverOwed`). Bot, Assistant and Telegram runs count as "busy" for notices on purpose: no notice source targets their chats (follow-through, check-back and child_chats tools need `usageSource === "chat"`, no Bot/Assistant/Telegram; Telegram uses its own backing chats; scheduled tasks never bind to Bot chats).
