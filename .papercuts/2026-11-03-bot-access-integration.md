# Bot access integration, 2026-11-03

- Delegation helper storage was absent on the next completion wake. Recover the task ID from the completion message/project handoff instead of treating the implementation as missing or spawning a duplicate.
- The new Electron E2E's inline whole-Mac payload widened its literal types across app.evaluate. Give it the real public BotPendingAccessRequest type before transport; the first spec type-check caught this before any window run.

- First Cua access-card run failed twice before a window opened, firstWindow 30s timeout; only sanitized routine catch-up TypeError in dev log. Added temporary process-output probe to identify production startup fault; no timeout or assertion changes.

- Startup probe confirmed access-requests-main → tool-sources-main → messages-main → session-main → uninitialized bridge.onChange. Load answer-only application/authority/tool-source dependencies inside answerBotAccessRequest; keep the singleton bridge light. Removed all temporary platform/fixture probes. The --run probe also needed a fresh build because sandbox sync removes build/.

- After startup correction, Cua reached the real card, both theme screenshots and answer busy-state checks. Playwright parsed getByText(/…/u).first() as regex flags "u >> nth=0" and threw, so use the same literal message substring locator. Production toast/card remained correct.

- Root type-check overlapped active Remote host edits and saw incomplete protocol union/parser/paired-desktop exhaustive switch. Sent all three diagnostics to owning worker; rerun after host completion before acceptance.

- Final root type-check found new host test compatibility errors: Array.at outside configured ES lib, two stale grant/private-issue fixtures, and answer receipt widened boolean instead of literal true. Sent exact diagnostics to host owner; CLI types run separately because chained && stopped before it.

- Backend confirmed Task6 initial failing run was not captured; first116-test run already passed. Leave its red-run checkbox unchecked and report the evidence limit; passing final behavior tests are separate. Host test fixture type issues are fixed and final root typecheck passes.

- Gate3 R1 found new phone retry-choice mismatch, stale live-card lockout, access-issue no-dismiss/refresh gap, private-parent recursive-read exposure, journal startup blast radius, hidden-root overlap and durable-save-after-owner-end ambiguity. Three implementation workers own native/runtime/storage fixes. Root behavioral red run reproduces dismiss parser/UI absence, future-save success notice absence, and duplicate notification wording; log /tmp/bot-access-r1-root-red.log.

- Initial combined Python docs/E2E patch had a syntax error before any mutation. Applied the changes with apply_patch, then E2E type-check and scoped lint passed. Root focused23 tests pass after four red behavior gaps; new expected saved-future receipt is exercised through the existing hook.
