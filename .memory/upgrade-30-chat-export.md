# Chat export suggested filename visibility — 2026-09-19

- A chat titled `.env setup` previously exported to `.env setup.aiden-chat.json`. A synthetic write succeeded, but an ordinary directory listing hid the result.
- `safeExportFileName` now removes leading dots and spaces after its existing Unicode normalization and invalid-character cleanup. Dot-only titles use `Aiden chat`; internal dots and serialized chat titles remain unchanged.
- Two new regressions failed on baseline, then passed after the fix: normalized/dotfile filename cases and a real temporary-file export that retains the original title. The existing file remains registered in `test:slash-commands`.
- Scope is the suggested filename only. No export schema, transcript, attachment, native-client, UI layout, onboarding, or plan-status changes.
- Reference study: Hermes `apps/desktop/src/lib/session-export.ts`, OMP `packages/coding-agent/src/export/html/index.ts`, Pi `packages/coding-agent/src/core/export-html/index.ts` (MIT; conceptual comparison only, no code copied). Exact source SHA receipts and rejected hypotheses live in campaign lane `30-chat-export.json`.
- Rejected hypotheses: descriptor accounting omission is bounded in normal operation by 40 artifacts/chat; >255-byte filenames write successfully on this Mac; cancellation releases export admission in `finally`. Linux filename portability was not validated because SSH authentication and the local Docker daemon were unavailable.
- Validation with isolated lockfile dependencies: 13/13 focused export/session/contract tests, `npm run type-check`, scoped ESLint, and `git diff --check` passed. Independent campaign reviewer confirmed the baseline and found no additional in-scope defect. Hosted checks remain separate.
