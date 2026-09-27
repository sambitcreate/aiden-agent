# Timed ask-user waits — 2026-09-27

Branch: `feature/timed-ask-user`. Plan: `docs/plans/timed-ask-user-plan.md`.

The desktop coordinator owns optional deadlines, `expiresAt`, explicit expired responses, and a bounded recent-prompt set. Attended desktop requests without a timeout continue waiting; unattended requests use the Remote-aligned cap. Timed-out prompts now remain in the desktop composer after generation settles, letting a late answer become a follow-up or queued follow-up.

The CLI adapter must forward the tool's `timeoutSeconds` to the terminal selection UI. The CLI uses one absolute deadline across the complete questionnaire and multi-select steps, passing each `select` only the remaining milliseconds plus the tool-call abort signal. Pi `ExtensionUIContext.select` supports both options.

Relevant validation: `npm run test:ask-user-question`; `npm run test:cli`; `npm --prefix packages/cli run type-check`.
