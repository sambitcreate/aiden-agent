# Pi small-context semantic budgets — 2026-09-22

Branch `feature/pi-small-context-budgets`, based on `origin/main` c8c09e0d2. PR #215 remains unchanged at 5f9f5e6e and is an independent model-ownership/startup-recovery repair.

## Verified remaining defect

The scope reconciliation and independent Sol adversarial review found that Aiden already persists custom context/output limits, but semantic LLM compaction retained fixed Pi budgets (reserve 16384, retained tail 20000) even when they could not fit the selected model. An 8192-token window therefore had a negative threshold and summarized short positive-usage responses. It could retain the entire input, append a needless checkpoint, and repeat after restart. Child active-output handling had a regression assertion expecting exactly this unnecessary checkpoint.

## Bounded correction

The common coordinator preserves the existing budgets when reserve is below the context window and retained tail fits in the remaining input. Otherwise it uses Aiden's existing VCC policy: reserve is capped at one quarter of the window, retained tail at half the remainder. VCC retains its existing bounds. An enabled window so small that this produces fewer than two reserve tokens fails before sending a zero-output summary; disabled automatic compaction remains a no-op.

This applies to foreground, child, and explicit manual compaction through their existing coordinator. No new settings map, request contract, provider call, model catalog access, replay policy, journal format, or rollout-stage change is added. Pi remains locked to 0.84.4. Exact-fit default budgets at 36384 tokens and feasible larger defaults remain unchanged. The former 32000-token fixed-reserve test is now a 64000-token feasible-default test, with usage chosen to distinguish Pi's 16384 reserve from an unnecessary quarter-window clamp.

Retained-tail limits remain Pi's soft cut-point targets: an indivisible user/tool group can exceed the target. This change does not replace Pi's cut algorithm, promise reduction of every enormous single turn, or change the existing generation preflight/emergency safeguards.

## Verification

- New core boundary/restart coverage and revised child compatibility assertion: 10 failures against unchanged production core; fixed full suite is 22 VCC + 325 compaction-related tests passing.
- The focused compatibility/rollout audit before this change passed 42/42.
- Type-check, lint, and diff checks pass locally. Both independent Sol medium reviewers cleared the final patch. Adversarial review additionally caught explicit reserve values 0/1 bypassing normalization; final effective-reserve validation and two enabled/disabled controls close that edge case. PR records final latest-head CI and review evidence.
- Native consumers still receive the same compact_context contract. This host efficiency fix has no shared DTO/transcript/activity-shape/UI or onboarding-capability change, so it does not require new native implementation or illustrations.

## Remaining original assignment boundaries

See `pi-compaction-scope-reconciliation-20260922.md`. Configurable per-provider/model compaction policy remains a separate unimplemented product feature. It needs validated portable intent and one policy across foreground/manual/child, preflight/emergency and model switches; adding a coordinator-only map is intentionally excluded. A newer dependency upgrade is not justified by a current-pin API mismatch and still requires its paired-package, migration, rollback and installed acceptance gates. Automatic replay of interrupted external effects and #206's partial subagent/maxTurns work remain excluded.

## PR #228 summary-request follow-up

Pullfrog identified that lowering the retained tail can expose an oversized hidden summary request. The coordinator now fences both Models completion entry points around Pi's fully assembled prompt, before provider transport/accounting. It rejects estimated input + requested output + 5% window safety (minimum 64 tokens) over capacity, with no checkpoint, retry, or automatic replay. Non-ASCII text gets a conservative UTF-8-byte allowance; ASCII uses the existing Pi content heuristic. This is an estimated-capacity preflight, not a provider-tokenizer guarantee. Oversized histories require a larger-context model; this patch does not silently truncate summary input.

Manual/automatic long-history, output-reservation/no-retry/event, and Unicode regressions cover the boundary. Existing fake-provider fixtures previously accepted histories larger than their declared windows; their payloads or windows now fit. The executable semantic replay uses a 64k window with synthetic usage recalibrated around its threshold, preserving the original replay objectives; those synthetic metrics are not installed/provider acceptance evidence. The bot replay has an 8k window. Rollout stages and receipt schemas remain unchanged.
