# SDD ledger — plan: docs/superpowers/plans/2026-10-27-bot-autonomy-c-learning.md

Inline implementation by controller (owner change). Base bcb1963b1. Review after the plan by Opus 5.5 high.

## Progress
Tasks 1+8: complete (commit 78b64af5e); Ruling C1: approvals are keyed by content fingerprint (skill ids are path-based); Ruling C2: under Custom access the new skill is not auto-granted — the person grants it in Advanced (cost: an extra step).
Tasks 2–7, 9: complete (commit 0d48e88eb, inline).
Ruling C3: reflection reads each run's stored output, failure kind, claim-check tools and fingerprint, not tool names and errors from the transcript — runs already carry these — cost if wrong: thinner evidence.
Ruling C4: fingerprint inputs are the Bot revision, memory revision, lessons revision, approved skill fingerprints and app version (no rules revision or tool list) — cost if wrong: some setup changes don't flip it.
Ruling C5: the memory review counts as one budget request per run (3,072-token cap) — cost if wrong: looser accounting.
Ruling C6: phones keep the Plan C cards read-only and have no learning page (no bot:learning capability yet), consistent with Ruling B3.
Task 10: docs complete (commit fd552d96f). Ruling C7: the onboarding gallery tile for Bots that learn is deferred to a follow-up with the owner (needs a code-drawn illustration and art test).
Full run after merging main: lint clean. npm test failed only in 4 physical-auth tests (local LibreSSL rejects openssl -days 0, environment) and guest-driver-install "suspending removes the enabled file…" (20 s timeout under parallel load; passes 10/10 alone; untouched by this branch). Record both in the PR.
Plan C review (Opus high): Fix first — Critical 1 (case-insensitive skill folders bypass the write guard), Important 2–8 (truncated skill previews, tidy vs person edits, chat tidy Undo, host-side confounded rules, Keep ignores the lesson cap, model-claimed requested bypasses cooling off, expired follow-ups counted as declines).

## Opus 5.5 high review fixes (2026-10-27)
- Critical 1: skill-folder write guard is case-insensitive (.claude/Skills, .Agents, .AIDEN/skills).
- I2–4: skill cards show every preview line; folder skills over 60,000 chars are skipped; dedupe across all statuses; tidy re-reads memory and abandons on a revision change; Undo targets the exact change id with a conflict toast.
- I5: host enforces confounded for <2 cited runs or mixed fingerprints; at most one record_lesson / retire_lesson per pass.
- I6: setStatus("active") applies the 6-per-routine / 12-Bot-wide caps.
- I7: model `requested` bypasses only declined_before; host follow-ups use `hostFollowUp` (bypasses both).
- I8: expired follow-up dismissals carry settledBy "host" and never count as declines.
- Minors: reflection budget settles on usage.output; run fingerprint computed before the send.
