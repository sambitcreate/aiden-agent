# Performance batch 1 orchestration

Status: implementation in progress. User authorized separate worktrees, GPT-6 Astra medium implementers, fresh-context GPT-6 Astra medium edge-case reviewers, PR publication, then 15-minute CI/comment remediation cycles until exact-head checks are green and no actionable comments remain. Merging is not included.

All four lanes start independently at `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Three concurrent subagent slots mean implementation/review waves. Reviews use `fork_turns: none`; reviewers receive scope, worktree, base and verification obligations, without inheriting implementer reasoning.

| Lane | Worktree (under ~/.codex/worktrees/) | Branch | Implementation | Independent review | PR / CI |
| --- | --- | --- | --- | --- | --- |
| Browser throttling DP-01 | perf-browser-throttling/aiden-agent | feature/perf-browser-throttling | Running | Pending fresh reviewer | Pending |
| Stream accounting SDR-1 | perf-stream-accounting/aiden-agent | feature/perf-stream-accounting | Baseline preparation | Pending fresh reviewer | Pending |
| Android images AND-03 | perf-android-images/aiden-agent | feature/perf-android-images | Running | Pending fresh reviewer | Pending |
| iOS chat loading IOS-03 | perf-ios-chat-loading/aiden-agent | feature/perf-ios-chat-loading | Running | Pending fresh reviewer | Pending |

## Gates per lane

1. Revalidate current source, read working agreements/memory and capture deterministic baseline evidence with synthetic fixtures.
2. Implement one bounded optimization; preserve ownership, authority, durability and cancellation. Update the lane's `docs/performance/` before/after record and project memory.
3. Run local focused behavior tests and applicable static/build checks. Distinguish device execution from compile-only and deterministic counters from hardware energy.
4. Fresh-context Astra medium reviewer inspects code and tests, probes edge cases, and reports actionable findings. Implementer addresses findings; review corrected diff before publication.
5. Publish independent PR against main, attach it to this chat. Do not rebase/force-push a reviewed/shared branch.
6. After publication, check exact-head CI and all review/issue comments at 15-minute intervals. Address valid findings, run local affected checks, push, and repeat. No broad retries, skipped tests or hidden failures.
7. Stop monitoring only when all PRs have passing applicable checks on their current SHA, no unresolved actionable comments, and no requested review in progress. Report environmental or external blocks honestly.

## Existing concurrent work

Open mobile model/transcript and dictation PRs were inspected by title/scope to avoid duplicated work. This batch does not modify their branches. Shared recovery, native response ownership and browser navigation fixes already on main remain correctness constraints.

## Progress log

- Created four attached managed worktrees from current origin/main; existing audit worktree retains the central ledger.
- Started browser, Android and iOS implementers; installed pinned root dependencies in the stream worktree for baseline preparation. No catalog refresh or real-account traffic.
