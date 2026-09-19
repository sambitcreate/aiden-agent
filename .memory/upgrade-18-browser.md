# Browser crash recovery ownership — 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`; branch `feature/upgrade-18-browser`.

`BrowserService.observe` retained crash-recovery timers after later navigation and after superseding crashes. A stale callback could reload a new page or bypass the three-crash retry cap. Recovery now owns exactly one timer, clears ownership before executing, and cancels on a new main-frame document navigation, manual Reload/Stop, tab close, or another crash. Stop leaves an honest manual-reload error. Same-document and child-frame navigation do not cancel recovery.

Research hypotheses: selected stale crash recovery for demonstrated navigation impact. Deferred the smaller popup/opener listener retention issue. Initial load callbacks already check closing/current URL/ERR_ABORTED. Unowned downloads already cancel and owned downloads use the native Save dialog.

Read-only source lessons; original implementation, no copied source:
- Waku `6d433e875d57091906ec0770d8bb9ffc9aa29b83`, `src/browser.rs` (GPL-3.0): snapshot epochs reject completions after ownership changes. SHA-256 `487c8d0e913d9bff94509f85ed91ba546ece4697c734c5fec52a94b0dae1aafe`.
- OpenCode **v2 study checkout**, `origin/2.0` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, `packages/app/src/context/global-sdk.tsx` (MIT): heartbeat cancellation and attempt cleanup. SHA-256 `0073e401d275e1c2a4eee3ad6bf4afcd04e6b8c35e89aa948d7165e204fa2484`.
- Hermes `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`, `tools/browser_tool.py` (MIT): stop supervisor first, clean up the exact session, avoid renewing expired sessions during teardown. SHA-256 `f81314fe84d1ae6878d71f0491a0760645fca61b93e24894858f040263b748cd`.

Regression evidence: two added Electron lifecycle tests fail against baseline. A stale timer after navigation produces one reload instead of zero; superseded/duplicate/exhausted callbacks produce four reloads instead of one. Tests exercise the real BrowserService listeners, real native guest navigation and reload, with controlled crash events/timers; they do not intentionally crash Chromium. Existing `tests/e2e/*.spec.ts` discovery includes these tests without package-script changes.

No shared server, native-client, permission, new capability, or visual layout contract changes. No onboarding or plan-status change is needed. Full validation and PR status follow in this note.

Validation: 140 browser tests pass; application and E2E TypeScript, lint, production build, and diff check pass. Full native browser Electron run: **21 passed, 1 failed**, including both new passing regressions. The failure is `browser.spec.ts:89`: the existing Live floating launcher intercepts the annotation Add to chat button. Reproduced the identical timeout on unchanged baseline `5cc831a`; logs `/tmp/aiden-18-e2e.log` and `/tmp/aiden-18-annotation-baseline.log`. Reported to campaign root and attachment owner; no unrelated UI edit. Hosted CI and central review remain pending.
