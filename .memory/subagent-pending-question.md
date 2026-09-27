# Subagent pending question — 2026-09-27

Source: pi-subagents #2461. `needs_attention` V2 snapshots used to require the
literal activity `Needs attention.`, and the V1 projection forced it, so a
waiting child's question or approval text never reached the UI.

Now:
- `renderer/shared/subagent-runs.ts` exports
  `SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY`, `subagentPendingQuestionActivity`
  (single line, snapshot-redacted, word-boundary cut to 160 chars with ASCII
  `...` because snapshot text must be NFKC-stable) and `subagentPendingQuestion`
  (the question, or `undefined` for the fallback/non-waiting runs).
- The V2 parser still requires an `activity` for `needs_attention`, bounded and
  redaction-checked by the V1 parser; the V1 projection passes it through.
- `BackgroundSubagentLifecycleV2.transition(..., "needs_attention", text)`
  normalizes text through the helper (blank -> fallback).
- Desktop: chip/live-summary status `Needs attention: <question>`, roster second
  line shows the question (`data-subagent-pending-question`), detail heading
  "Waiting on". Orb ignores activity patterns while waiting.
- Aiden Remote unchanged: roster `activity` stays the closed milestone
  vocabulary, so child text never reaches iOS/Android. Mobile shows the
  `needs_attention` state label. No protocol revision.

No production path transitions a child to `needs_attention` yet (background
coordinator not activated); the lifecycle is ready for it.
Tests: `renderer/shared/subagent-runs-v2.test.ts`,
`main/services/subagents/background-lifecycle-v2.test.ts`,
`renderer/components/subagents-panel.test.tsx`.

## Review follow-up

Redact original question text before flattening controls, preserving detection of control-split credentials. Added NUL/vertical-tab/escape regressions; all 11 V2 shared tests pass.
