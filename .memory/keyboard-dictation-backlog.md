# Keyboard and dictation backlog — 2026-11-02

Validation baseline: `origin/main` at `9b2875d65f316265323d3d06a73904fbe00e2277`, clean original `1f02` worktree; new branch `feature/keyboard-dictation-backlog`.

## Finding dispositions

- **8.1 — confirmed_current.** Real Composer + useVoiceRecorder, with fake microphone/audio graph and local voice IPC, displayed a partial transcript but Arrow-Up invoked the fork callback for the prior prompt. Existing dictation/edit-last suites had no combined case. Guard edit-last during recording and final transcription, including before the first preview and while a batch decode has no visible text. The final decode still inserts and sends exactly once; empty decode restores edit-last.
- **8.2 — confirmed_current.** The real validator accepted a model-change binding on Alt-Up or Shift-F6. With the command provider mounted, window-capture navigation consumed it and ran zero model commands. The initial correction moved focus navigation to document bubble after saved commands; the nested-input follow-up below supersedes that ordering for F6. A live disable restores built-in navigation; unchanged keys, overlays and nonempty text keep their existing rules. No binding migration or reserved-key expansion.
- **8.3 — confirmed_current.** On the real Bot chat route, Shift-F10 and the Menu key on a message action opened no menu. Reuse `openContextMenuFromKeyboard` on BotMessageActions, as sidebar rows and workspace messages do. Both menu keys now reach Reply with the correct message text; Enter on the overflow button and pointer context menus retain the primitive behavior.

Open PR overlap check: #711 changes message/media ordering and its native tests, not Composer, focus regions or BotMessageActions; #712 changes Android recording ownership. No duplicate fix found among open PRs #702–712, #687, #648 or #609–614. Other worktrees were not changed.

## Scope

Desktop input handling only. Inspected Composer callers (local/paired workspace and Bot chats), the shared local/paired Bot TranscriptEntries, and native iOS/Android transcript action/dictation consumers. No transcript content, quote format, Remote wire contract, native mobile interaction, network policy, layout or theme token changes. Existing onboarding feature inventory and completed keyboard plan status are unchanged. README, PRODUCT, CLI guide and plan index checked; detailed keyboard guide and shortcut-list copy updated.

## Validation

Before fixes: 13 existing focused tests passed; added behavioral repros failed for live dictation, saved Alt-Up/Shift-F6 and both Bot message menu keys. After fixes: focused suites and lifecycle controls pass. Final validation:

- `npm run test:command-system`: 148 passed.
- `npx tsx --test renderer/components/composer-dictation.test.tsx renderer/lib/use-voice-recorder.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`: 82 passed.
- Root TypeScript and E2E TypeScript checks; scoped ESLint; `git diff --check`: passed.
- Cua Space Electron run (via `test:e2e:space`, 3 cases): saved-key precedence/disable, existing F6/sidebar/find flow, and the starter Bot flow extended with Shift-F10 → Reply all passed. Artifacts under `test-results/cua-space-aiden-e2e-pr694/`. Creating a new Space stalled before tests; interrupted that setup and used the idle existing Space after checking its run lock. No test retry, timeout change or flaky-policy relaxation.
- React Doctor: changed scope against origin/main reports no new issues. Lines scope reports the existing Composer complexity warning; no unrelated refactor or suppression.

No macOS host-window tests or physical microphone run; Linux Electron and the headless real recorder/Composer interaction cover the changed platform-neutral logic. Native clients were inspected but not rebuilt because no shared transcript/server behavior or native interaction changed. This batch is for an open PR; merging is outside this task's authorization.


## Nested-input review follow-up — 2026-11-02

Review `PRRT_kwDOTctvDc6y6Gym` / `discussion_r4448968204` was **confirmed_current** on `5f86a80486957936cd31d6e35ea979a42b99cc69`. F6/Shift-F6 were consumed by `useDeviceStream` (Bot computers and floating players), `DeviceViewer` (flat and 3D) and the inline device-tab rename field before the document-bubble listener. Ghostty also consumes encoded F6 keys. The read-only probe covered 32 outcomes on actual handlers and a capture-order candidate.

The production correction puts F6 area navigation in the same document-capture dispatcher as saved commands: a runnable saved command first, then the F6 fallback, then nested inputs. Overlay/menu/picker, application-modal, IME and shortcut-recorder guards remain. The separate reply-stepping hook stays in bubble phase with its existing draft and reserved-surface rules. No per-device/terminal exception list, key-binding migration, wire change or new layout.

Behavioral coverage mounts the actual stream hook, full flat DeviceViewer and DeviceTabRenameInput with CommandSystemProvider, proving unbound forward/backward navigation, live saved-key priority, disable recovery and no live grant acquisition. Guard cases include modal/menu/dialog/picker/recording/IME, already-handled events, and a matched command with no handler. Electron terminal coverage exercises the actual Ghostty/PTY path, including an ineligible saved command and ordinary shell input; final checks are recorded in the PR.

Follow-up validation: 159 command-system tests, 82 recorder/dictation/Bot chat tests and 15 Ghostty tests passed; root and E2E types, scoped ESLint, diff check and React Doctor changed-scope check passed. Four Electron cases passed on the first run through Cua Space (50.8s), including actual Ghostty F6/Shift-F6 navigation, saved-command ineligibility/disable and subsequent real PTY output. The original dictation/menu and saved-key precedence flows also passed. Physical device streaming and macOS host-window behavior remain separate acceptance gaps. No test retries, timeout changes or policy changes.
