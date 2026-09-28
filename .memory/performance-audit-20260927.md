# Whole-app performance audit — 2026-09-27

User requested a fresh worktree, five GPT Astra medium specialists (one per area), a deep optimization backlog, and a continuously updated Markdown before/after record, especially GPU/battery and mobile optimism.

- Worktree: `/Users/sambitbiswas/.codex/worktrees/performance-audit/aiden-agent`.
- Branch: `feature/performance-audit`; baseline `a9baa4aa3027893e5455043083465c34b4c8b4ac` (0.50.0).
- Deliverable: `docs/audits/performance-2026-09-27/README.md`, five specialist reports, measurement protocol and baseline inventory.
- Five specialists cover desktop GPU/rendering, main processes/battery, iOS, Android, and shared data/runtime including CLI. Three concurrent subagent slots require two waves.
- This is an investigation/documentation pass. No executable behavior changed. No runtime GPU/energy/latency baseline or after measurement is claimed. No app/native test suite was run for documentation-only changes; documentation validation is recorded in the main report.
- Keep the original July performance plan as history with an explicit re-audit pointer. Its old perpetual RAF, main-thread local speech and MCP duplicate-connect claims are superseded by current mitigations. Do not automatically replay old findings.
- Preserve mobile request ownership, admitted-but-not-persisted winners, cancellation, idempotency, replay basis and authority gates. Optimistic UI means pending feedback where remote success is not yet known.
- Next implementation should record reproducible synthetic baselines, then apply independently measured changes and append evidence per finding to the audit ledger. Actual GPU attribution and physical-device battery acceptance remain open.

Completed all five reports: 40 ranked findings (10 GPU, 8 processes, 7 iOS, 8 Android, 7 shared), mobile optimism matrices and proposed measurement/run sequence. Documentation whitespace, 13 relative links, 104 qualified/aliased source anchors and inventory JSON validation passed. No application performance improvement is claimed.

## Batch 1 implementation follow-through

Four independent implementation PRs published after individual fresh-context GPT-6 Astra medium reviews: browser #282 (`0a56d0ce`), iOS #283 (`c68550e5`), Android #284 (`e3e28002`), Remote #285 (`c4f195f4`). Audit/tracking PR #281. Full orchestration/evidence: `docs/audits/performance-2026-09-27/batch-1.md`. All published by 2026-09-28T02:40:07Z; first CI/comment pass not before 02:55:07Z. Heartbeat `performance-batch-pr-follow-up` runs every 15 minutes until exact-head applicable CI and actionable reviews clear; no merge authorized. Android test-only cleanup fix 41adca58c/diagnostic evidence were subsequently reviewed and published (see below). Main-after-reset cleanup bug proved; separate initial HTTP loading timeout remains under investigation. Do not treat targeted retries as final full-suite success.

Android follow-up e2d1a5dc independently reviewed (5/5 focused checks) and published to #284. Proven Main teardown cleanup is fixed, while initial HTTP setup timeout remains unresolved; instrumented 252/252 is not a final clean-source full pass.

First hosted pass 02:56 UTC: #281 tsx command suggestion addressed; browser window-wide lease impact and iOS publication-before-revocation findings delegated for fixes + fresh reviews. #284 Linux arm64 AppImage HTTP500; targeted rerun rejected while workflow active, zero retry executions yet. All PRs still have pending CI. See batch-1.md.

First hosted review findings addressed: #281 b6b0eb372 reproducible tsx command; #282 deec0c010 source-verified window-wide exception + native lifecycle coverage (fresh154units/native1); #283 cb53bbe6a synchronous mounted transcript redaction during revoked cleanup (fresh3tests). All three threads replied/resolved. New-head CI pending; #284 arm64 upstream500 retry must wait for workflow completion; no rerun executed. Automation remains ACTIVE, no merges.
