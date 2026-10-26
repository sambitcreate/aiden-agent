# Coding follow-through — 2026-10-26

Background jobs, following a pull request until it merges, and `/until <check>`. Plan: docs/plans/coding-follow-through-plan.md; guide: docs/coding-follow-through.md. Code lives in `main/services/follow-through/` with shared contracts in `renderer/shared/{agent-notices,background-jobs,follow-through}.ts`.

Owner rules (2026-10-26): job ends are reported to the chat; macOS and Linux; following builds on `main/services/github/`; only owner/write-access comments reach the agent; logs are data; the check loop stops after 5 tries. Do not name the research source in PRs, commits, code or docs.

Design decisions worth keeping:

- A notice is a user-role message with a `notice` field (`AgentNoticeV1`); the content is model-facing and fences untrusted text with `fenceAsData`. Clients without a card show `agentNoticeDisplayText` (the Remote projection does this, so phones need no change and there is no protocol revision).
- Delivery order: queue into a running turn (`llmClient.admitAgentNotice`), else start an unattended turn (headless owner, approvals and questions detached, no subagents/Computer Use/MCP) when `wake` is true and the chat has wake budget left (6/hour), else append only. Never wake for passes, merges or closes, or the loop never settles.
- The agent's own GitHub comments come back as `byViewer` comments; they are dropped only when made during that chat's run windows (from `hostRunRegistry`), so the person writing on GitHub with the same account still counts.
- `BackgroundJobs.settle` marks a job watched so a job that ends during the tool's start wait is reported once (in the tool result), not twice.
- Crash reaping matches pid and `ps -o lstart=` start time before signalling a leftover process group.
- A done-when check interrupted by quit returns to waiting with its count restored; nothing reruns on launch.
- `llm-client.ts` imports follow-through tools dynamically to avoid an import cycle; only `background-job-tool.ts` is imported statically (for the Ask-mode approval check).

Tests: `npm run test:follow-through` (registered in `test:serial` and the core-git/renderer-other lanes). coding-tools.test.ts needs `npm run build:worktree-file-io`, `node scripts/build-worktree-file-io.mjs --test` and `npm run build:subagent-file-mutator` first in a fresh container, or 9 pinned-write tests fail.

Found by driving the real app (2026-10-26), now fixed:

- A notice saved without a turn must also send `chats:follow-through-changed` with `transcript: true`; plain `chats:changed` only refreshes the chat list, so the open chat never showed the card.
- Follow-through slash actions commit with the draft-only guard (like clone/export/worktree); the full guard left `/until npm test` in the composer with a "newer draft" toast.
- The jobs list refreshes its clock when it opens; it used to show the time since the chip first appeared.

Screenshots: a throwaway Playwright spec (never committed) seeds PR notices, captures with `webContents.capturePage()` at 2880x1800 / zoom 2, and switches theme through the command palette (Search settings, then Use dark appearance); setting `nativeTheme.themeSource` alone does not change Aiden's theme.

Open: native phone cards, CLI support, hand check on a real Mac.
