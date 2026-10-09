# Scheduled tasks and question composer audit — 2026-10-06

Scope: conversational task creation, approval and persistence, pending-question ownership and display, desktop question composer, and the existing iOS/Android chat consumers. Changes are in this checkout; no release, installation replacement, saved-task mutation, or live scheduled execution was performed.

## Confirmed failures and fixes

1. **Approved tasks failed before dispatch.** Standard scheduling approval attached a hidden Symbol property to the model arguments. Assistant automation approval did the same for exact MCP bindings. Pi hashes arguments after approval and rejects non-JSON properties, so approving the task could immediately fail with “Pi runtime effect arguments are not a plain object.” Approval metadata now lives in invocation-scoped WeakMaps. Canonical Assistant arguments also omit an absent workspace instead of containing `undefined`. Exact approved model, workspace, permissions, and connector bindings remain enforced. The existing tool suite now reproduces both paths through the real Pi tool-call runner and argument digest, then verifies the saved record.

2. **Desktop could miss questions belonging to phone-started runs.** The desktop restored remote approvals but never fetched the pending question. Desktop now restores it through document-guarded Electron IPC and submits it through its original main-process owner. The service checks chat identity, prompt identity, expiry, and the real answer parser; resolution remains one-shot. A stale response cannot clear a newer displayed prompt. The network API and mobile protocol revision are unchanged.

3. **Question presentation diverged across clients.** Desktop used a separate card treatment; native clients listed every question and left the normal composer available. The question UI now occupies the composer area, uses desktop composer/shared button primitives and the native composer surface, and exposes one question at a time with numbered tabs. Custom drafts and selections survive tab changes. Desktop offers explicit Next/Submit and keyboard tab navigation. Native drafts remain keyed to the prompt. Bounded scrolling keeps long prompts and answer actions reachable. Dismissing/resolving restores the message composer without sending its draft.

4. **Schedule suggestions still opened a control-heavy editor.** Suggested tasks now seed editable natural-language requests in chat. The existing manual setup remains available. No task is created merely by choosing a suggestion.

5. **Generic approval UI hid useful schedule detail.** The desktop approval now presents the actual instructions/script, model, workspace/connector scope, timezone, notifications, scheduler-disabled/paused state, and desktop-awake requirement. Claimed schedule payloads that fail validation cannot be approved from this card.

## Reference comparison

Reviewed the official [Codex automations guide](https://learn.chatgpt.com/docs/automations?surface=app): describe work and timing conversationally, review the unattended scope, and make the local execution requirement clear. Also inspected the public [Codex request-user-input handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs) and Aiden's existing desktop UI inspiration/specimen. Implementation uses Aiden's existing tool contracts and semantic styles; no upstream code was copied.

## Validation

- Scheduling and automation suites: 158 and 182 tests passed.
- Question parser, coordinator, and rendered component suite: 21 tests passed; final rendered tab semantics tests also passed.
- Main-process remote-question tests exercise cross-chat rejection, invalid answers, expiry, one-shot resolution, and the phone-visible resolved state. Local adapter tests ensure phone-owned answers use host authority.
- Electron behavioral coverage: suggestion-to-chat draft; actual question → approval → persisted task with pinned provider/model; small-window tabs/custom-draft retention/keyboard navigation; restoring and answering a phone-owned question. All three focused conversational scheduling/question scenarios passed on the final full-file run. After tightening the scroll layout, the small-window tab test passed again with explicit checks that Submit is in the viewport and the card stays outside the sidebar.
- Android: 10 rendered question/schedule tests passed on the API 36.1 emulator, including four-question tab navigation and retained answers inside a 240 dp viewport. All 93 focused Chat/Question/Scheduled unit tests and Android lint passed.
- iOS: all 272 focused Chat and ScheduledTask tests passed, including the new draft-retention test for tab changes and invalid navigation. Simulator: iPhone 17 Pro, iOS 27, Xcode beta, signing disabled. This is simulator evidence, not physical-device/release acceptance.
- Root/e2e TypeScript checks, ESLint, production build, and `git diff --check` passed. The combined final remote-stream/adapter/IPC/dock/render suite passed 95 tests. React Doctor reported one index-key warning on question tabs; this is a reviewed false positive because question indexes are the immutable wire identity within a prompt, and the composer remounts on prompt identity changes. No rule was suppressed.

## Test-run limitation

During one desktop run alongside native verification, the existing exploration test and the question/approval/save test completed their assertions but Electron shutdown exceeded the harness's 35-second bound. The new tab/remote-question tests passed. No timeouts, retries, or flaky-test enforcement were relaxed. Local evidence: `/tmp/aiden-task-e2e3.log`; test artifacts under `test-results/e2e/`. On the single follow-up full-file run, the question/approval/save test and both question-UI tests passed; the exploration test still exceeded the shutdown bound (`/tmp/aiden-task-e2e-final.log`). The full-file run is therefore **3 passed, 1 teardown failure**, not green. The final layout-only question test separately passed (`/tmp/aiden-task-tabs-final.log`). Hosted follow-up is tracked in [PR #369](https://github.com/sambitcreate/aiden-agent/pull/369); these remain the historical local results.

## Scope decisions

Reviewed both native consumers and the onboarding feature gallery. This repairs existing advertised scheduling/questions rather than adding a setup capability; no onboarding illustration, permission expansion, API revision, or plan-status transition is needed. Scheduled work still requires the desktop runtime to be available. Existing saved-task/history data was inspected read-only and was not rewritten or executed.

## PR review follow-up — 2026-10-07

- Restored iOS run cancellation during a pending question by sharing the same Stop control between both composers. It uses the existing ownership/connection/read-only/stopping gates and calls run cancellation without submitting or skipping a question. A hosted question-card test exercises that action and verifies only the run-cancel request is sent.
- Moved one-shot dictation launch consumption into the chat model. Removing/restoring the composer cannot restart capture, and a launch encountered while streaming or read-only is consumed without starting the microphone. The regression test exercises launch, pending-question presentation, and restored composer startup.
- Fixed a remote-adapter test whose overridden mock did not record calls; it now independently verifies the session chat/prompt scope and one host dispatch.
- The initial [hosted Electron shard](https://github.com/sambitcreate/aiden-agent/actions/runs/37568961729/job/112623416000) reported the compact-window tab test as flaky: the card measured at x=257 while the sidebar ended at x=272, then passed the runner's retry. A local diagnostic reproduction traced this to `EnvironmentWorkbench`: its hidden overflow held `scrollLeft=88`, moving the entire chat beneath the sidebar. That outer boundary now uses non-scrollable clipping; the transcript and panels retain their own scrolling. Custom-answer focus also prevents ancestor scrolling, and the layout assertion waits for settled geometry while preserving the same no-overlap requirement. The [Linux x64 gate](https://github.com/sambitcreate/aiden-agent/actions/runs/37568961729/job/112623119730) reported the same narrow-window test failure. No timeout was raised and no retries or flaky-test enforcement were changed.
- Local follow-up: all 274 iOS Chat/ScheduledTask tests passed, including the new cancellation and dictation tests; all six adapter tests passed. The final five Electron compact-window/workbench-focus tests and 22 focused layout/state/adapter/question unit tests passed. Production build, TypeScript, ESLint, and diff checks passed. The original broad desktop shutdown failures remain documented above.

The next hosted run exposed an old iOS shipping-inventory assertion tied to the literal composer-local voice guard. Replaced that assertion with coverage in the existing read-only fixture XCTest: a launch request must never start capture. The full iOS release-policy suite and focused read-only/dictation simulator tests pass. Both review bots found no new issues in the production follow-up.
