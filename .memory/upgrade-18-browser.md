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

## Pullfrog: queued native crash notifications

PR #164 review `PRRT_kwDOTctvDc6j9uyL` demonstrated the reverse ordering: navigation starts before the old crash notification is delivered. Verified Electron `v43.1.1` `shell/browser/api/electron_api_web_contents.cc:2045-2065`: `PrimaryMainFrameRenderProcessGone` posts delivery, and details contain only reason/exitCode, with no originating document identity. The pinned Chromium `150.0.7871.114` implementation backs `isCrashed()` with native main-frame process status and resets it when the primary process becomes alive. Source links:
- https://github.com/electron/electron/blob/v43.1.1/shell/browser/api/electron_api_web_contents.cc#L2045-L2065 (SHA-256 `0ee59ca23c4706734a5f46681f9a8cff1b4a71f9d287104bf603227ab1885060`, MIT)
- https://github.com/chromium/chromium/blob/150.0.7871.114/content/browser/web_contents/web_contents_impl.cc#L12486-L12492 (SHA-256 `19371b9936b62a08fd58bc99e47ab1dd9e71cf47ab1d22ae438cbaeabfaa59ae`, Chromium BSD-style license)

Ignore a queued notification when the current native page is no longer crashed or a replacement main-frame load is underway. Do this before touching recovery state; also invalidate recovery at main-frame commit. This uses current native ownership because Electron does not expose the crashed document's identity in the queued event.

Two additional tests forcefully crash actual Electron guest renderers, hold native notification delivery until replacement navigation is pending/committed, and verify no stale retry is scheduled. Both fail published head `fc47fea7` (one unexpected timer each). Fixed lifecycle suite: 8/8 pass. Final extended native cases: 2/2 pass, including a fresh crash after commit with a stalled subresource; genuine current crashes still recover. Browser suite 140/140 and type checks/lint/build pass. Earlier full-suite baseline UI obstruction remains separately recorded above.

## Luna: current crash while the main-frame response is pending

The preceding broad native-loading check was insufficient. A real initial-navigation crash with a held main-frame response reports `isCrashed=true, isLoadingMainFrame=true`; published head `6287ef56` schedules no retry and leaves the browser state falsely uncrashed. The subsequent-navigation control can instead clear the native loading flag, so tests must distinguish these lifecycle states rather than require identical flags.

Capture whether the native renderer is already crashed when a new main-frame navigation starts. Such a navigation supersedes that crash. A crash that happens after navigation began still owns recovery even with a pending main-frame response. Reset suppression when Electron emits `frame-created` for the active primary main frame or commits navigation, so renderer recreation admits fresh crashes. The pinned Electron `RenderFrameCreated` source excludes speculative frames (`electron_api_web_contents.cc:1952-1974`).

The new initial-navigation test also proves `reload()` cannot revive a tab without a committed history entry. Capture the interrupted navigation URL and retry it with `loadURL`; keep ordinary reload for committed documents. Regression coverage requires native recovery to the intended URL and truthful `crashed=true, loading=false` state before recovery. No sleeps or arbitrary delays choose event ownership.

The initial zero-history regression now runs in a standalone native Electron child using the real BrowserService. It asserts empty URL/zero history before death, uses the real retry timer, and observes exactly two requests to the intended URL plus recovered native/service state. This exact test fails `6287ef56` with `{nativeCrashed:true,nativeLoading:true,crashed:false,loading:true}` and passes the corrected source. No about:blank commit weakens the case. The `.spec.ts` wrapper uses existing Playwright discovery; the native entry itself is not separately discovered.

Final verification for this correction: 10/10 lifecycle/native Electron cases pass, 140/140 browser tests pass, and application/E2E TypeScript, lint and build pass. The standalone zero-history regression fails exact prior head `6287ef56337768b5dc717a857b30a602a84f67d3` on the expected service-state mismatch, then passes the corrected source. Its private native owner bypasses IPC admission only; the real BrowserService, Chromium guest, HTTP requests, crash event and retry timer run unchanged.
