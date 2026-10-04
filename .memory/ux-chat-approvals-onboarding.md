# Chat, composer, approvals, onboarding and voice UX pass (2026-10 optimization audit)

Branch `ux/chat-approvals-onboarding`. The finding IDs refer to the audit's renderer-UX report.

## Changes

- **UI-32: IPC errors.** `renderer/lib/ipc-error.ts` strips Electron's "Error invoking remote method '<ch>': Error:" wrapper once, in `ipc.ts` `invoke()`. Screens no longer need to strip it themselves. Use `userFacingErrorMessage(error, fallback)` for caught errors.
- **UI-47: Stop pauses the queue.** Stop calls `messageQueue.pause()` instead of discarding. Queued follow-ups (text and images) stay visible as "Paused", and Resume sends them. The e2e Stop specs in `chat-message-queue.spec.ts` assert this.
- **UI-48: approval focus.** An approval takes focus only when `approvalShouldTakeFocus` (`composer-type-focus.ts`) allows it, so focus is not stolen from a draft.
- **UI-49: approval position and scope.** Approvals show "1 of N", and scope hints are linked through `aria-describedby`.
- **UI-39/40/42/43: chat pane states.**
  - Loading is a `role=status` "Loading conversation…".
  - A failed load with no messages shows an alert EmptyState with "Try again" (`persistedChat.refetch`).
  - With no provider, the pane shows a "Connect a provider" button to Settings → Providers.
  - Shared copy lives in `renderer/lib/provider-setup-copy.ts`.
  - `EmptyState` gained `action` and `role` props.
- **UI-41: generation errors.** The "Generation failed" callout is `role=alert`.
- **UI-44: file drop target.** Dragging files over the composer shows a "Drop to attach" overlay (`.composer-drop-overlay`, squircle, semantic fills, no border).
- **UI-50: ask-user options.**
  - Single-choice options are plain action buttons inside a `role=group`, with ", current answer" exposed to screen readers.
  - Multi-select options keep `role=checkbox`.
- **UI-51: question countdown.** `AskUserQuestionCountdown` shows the time left. It announces once, at 30 s or less.
- **UI-52: thinking control.** `ThinkingControl` takes a `disabledReason`, exposed as a description and in titles.
- **UI-67: voice key error.** The OpenAI voice key error names OpenAI.
- **UI-69: pill error timing.** Pill errors stay up for `errorHideDelayMs(message)`: 60 ms per character, clamped to 4–10 s.
- **UI-24/25/30/31: onboarding.**
  - Next has a visible and described reason when ChatGPT sign-in is pending.
  - The redundant header text, the duplicate toasts and the "Other ways" `aria-live` were removed.
  - Skip provider sits above the absolute drag strip (`relative z-10`); before, mouse clicks landed on the strip.
  - Without `aria-live`, the modal provider dialog correctly hides the background choices, because `hideOthers` skips aria-live nodes. E2E checks behind the dialog need `includeHidden`.

## Deferred

- **UI-45:** needs main to return per-file skip reasons, which is an IPC contract change.
- **UI-46:** cosmetic.
- **UI-49 shortcuts:** the ⌘↩ / ⌘⌫ approval shortcuts could collide with composer chords.
- **UI-41 Retry/Regenerate and UI-43 `role=log` and speaker labels:** these sit inside transcript rows, which belong to the streaming-render branch.
- **UI-42/52/53, model-picker parts:** the picker file belongs to the renderer-bundle branch.
- **UI-54:** per-chat model needs an owner decision (L effort).
- **UI-26:** the shared e2e onboarding fixture and the plan J01 product decision.
- **UI-28:** copy consolidation across the Pi 1.0 PRs (X-6).
- **UI-29:** moving the TTS disclosure, low impact.
- **UI-31 RadioGroup conversion:** it would break `finishLmStudioOnboarding`.
- **UI-68:** needs a new native IPC channel (`x-apple.systempreferences` Privacy_Microphone), plus Live "Allow" retry after a denial.
- **UI-69 and UI-70:**
  - UI-69's hover-hold and Settings action are not done.
  - UI-70 needs a cancel path in `use-voice-recorder` and a pill binding.
