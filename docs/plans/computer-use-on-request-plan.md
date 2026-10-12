# Computer Use on request (remove the composer toggle)

Status: implemented on `feature/remove-computer-use-button-48b6ae` (2026-10-12),
PR pending. Revised after owner review and after the first code review (the
"Review revisions" section at the end records what changed).

## Goal

Remove the **Computer** toggle from the composer footer. When the Computer Use
beta is on in Settings, the model can ask to use the computer in the middle of a
turn.

- The user answers once per chat with **Deny**, **Allow for this chat** or
  **Always allow**.
- An allowed chat runs Computer Use without further prompts.
- Always allow is a global setting the user can also change in Settings →
  Computer Use.
- If macOS permissions are missing, the turn stops and walks the user through
  System Settings. It then continues, either right away or after the user
  restarts Aiden and clicks Continue.

As a side effect, the composer controls should fit on one row.

## Today

- `composer.tsx` renders the "Computer" button and a "Computer Use is on"
  privacy notice. `chat-pane.tsx` (`changeComputerUse`) writes
  `chat.computerUseEnabled` through `chats:setComputerUse`, or through
  `updateChatDraft` for drafts.
- `llm-client.ts` (~L1007) creates the `ComputerUseController` only when
  `settings.computerUseEnabled && chat.computerUseEnabled && status.ready`.
  Bots use the same gate (`bot-tool-sources-main.ts:175`).
- Each input action (click, type and so on) pauses for its own card.
  `controller.approvalFor` binds a grant to the exact target, and `authorize`
  consumes it. Observations run without a card.
- Approval cards have no timeout, and the card already renders scope buttons
  (`tool-approval-scope.ts`, Remote revision 17 `PendingApproval.scopes`).
- `computerUse:requestPermissions` and `computerUse:status` already exist, and
  the status carries the `accessibility` and `screenRecording` permission
  states.

## Design

### 1. Give the model the tool when the beta is on

In `llm-client.ts` and `bot-tool-sources-main.ts`, the gate becomes: global
setting on, platform supported, bot capability, and `allowComputerUse`.

- The per-chat flag and readiness move out of the gate.
- The controller is created lazily. Its driver host starts only on the first
  call, so creating it before permissions are granted is safe.
- An unsupported platform or build (macOS older than 14.4, an unpackaged dev
  build) still hides the tool, because no permission can fix those. This is a
  cheap static check at generation start (`computerUseCanEverRun()` in
  `computer-use/runtime.ts`); the driver probe runs only at call time.
- Offering the tool does not count as using Computer Use. A stream is marked
  as using it (`computerUseActivated`) only when its first `computer_use` or
  `fill_form` call reaches the access gate, and only such streams are
  cancelled when the beta, Form Fill or the Form Fill model goes away.
- `COMPUTER_USE_AGENT_GUIDANCE` gains one line: the first use in a chat asks the
  user, and a declined request must not be retried in that chat until the user
  asks for it.

### 2. Ask once per chat, before the first `computer_use` call

In `beforeToolCall`, before the per-action path:

- **Already granted:** `settings.computerUseAlwaysAllow` is on, or the chat has
  the grant. The call goes ahead.
- **Not granted:** raise one approval through the existing
  `ToolApprovalCoordinator`, using the same card and remote payload.
  - It offers scopes `chat` and `always`. There is no "once", so the user is
    asked once per chat.
  - Summary: "Use your computer in this chat". Details: screenshots and
    accessibility text go to the selected model, and Aiden can click and type
    in your apps. This replaces the composer privacy notice.
  - **Allow for this chat** (scope `chat`) persists the grant on the chat
    record. Rename `chat.computerUseEnabled` to `chat.computerUseAllowed`,
    with no migration because this is pre-1.0.
  - **Always allow** (scope `always`) sets the new global setting
    `computerUseAlwaysAllow`.
  - A bare allow or scope `once` (what a phone's **Allow once** sends) covers
    only this response and persists nothing.
  - `fill_form` passes the same gate before its own plan card.
  - **Deny** blocks the call with "The user declined Computer Use in this
    chat." The denial holds for the rest of that response, so the model can't
    nag. The next user message can raise the card again.

### 3. No per-action cards in an allowed chat

When access is granted, `approvalFor` still runs. It keeps validating and
binding the grant to the exact target window or element, and keeps the existing
safety hard-blocks in `safety.ts`. `authorize` is then called automatically
instead of showing a card, so clicks and typing no longer prompt in that chat.

Actions that `safety.ts` already refuses stay refused. Running actions stay
visible in the timeline, and Stop cancels them as it does today.

### 4. Missing macOS permissions: stop, fix, continue

If Accessibility or Screen Recording is missing when the call arrives, the same
access card shows a permissions checklist:

- Each missing permission has an **Open System Settings** action, which uses
  the existing `computerUse:requestPermissions` IPC.
- Status re-checks on window focus and on a 2 s poll while the card is
  visible.
- **Deny** always works. **Allow for this chat** and **Always allow** stay
  disabled until status is ready, so becoming ready is the "continue" step.
- Main re-checks readiness when the decision arrives. A remote allow while the
  Mac isn't ready is blocked with "Finish Computer Use setup on your Mac".

**Restart needed.** macOS often requires a relaunch after granting Screen
Recording, and the card says so. The user quits and reopens Aiden; Aiden never
relaunches itself.

- When main raises the card while status isn't ready, it persists
  `chat.computerUsePendingContinue = true`.
- A deny clears the marker. An allow clears it only if the Mac is ready when
  the decision lands; otherwise the call is blocked with the setup reason and
  the marker stays. The start of the next generation in that chat clears it
  once that generation has actually started.
- **Stop** during the card clears the marker. Only an app quit (and a detached
  renderer) keeps it.
- A granted chat whose Mac is not ready (permissions revoked later, or a
  parallel call after an allow) does not raise the card again: it sets the
  marker and blocks with "Finish Computer Use setup on your Mac".
- After relaunch, a chat with the marker shows a callout above the composer.
  - When status is ready: "Computer Use is ready. Continue where Aiden left
    off?" with **Continue** and **Dismiss**.
  - Otherwise it shows the same permission checklist.
- **Continue** sends `COMPUTER_USE_CONTINUE_PROMPT` as a normal turn. The model
  retries, and the access card appears once more, now answerable. **Dismiss**
  clears the marker through `chats:dismissComputerUseContinue`.

A deny lasts for the rest of that response. Later calls in the same response
are blocked without a card, and the next user message can raise it again.

### 5. Settings → Computer Use

- New row "Always allow in every chat" (a switch), bound to
  `computerUseAlwaysAllow`. Off by default, and set from the card or here.
  Turning it off does not revoke chats that were allowed individually.
- **Reset chat permissions** calls `computerUseApi.resetChatGrants()`
  (`computerUse:resetChatGrants`, returns `{ cleared }`). It clears every
  chat's grant, turns off Always allow, and cancels streams already using
  Computer Use.
- Turning the beta off also turns off Always allow, so re-enabling the beta
  never silently means "always".
- Revocations (reset, Always allow off, beta off) bump a grant revision. A
  running response re-reads its grant on its next call. Once a response has
  seen a granted chat on a ready Mac, later calls skip the readiness probe.
- Remove "Restore privacy notice" along with the notice.
- Turning the beta off still cancels live Computer Use streams.
  `ComputerUseGenerationGate` and the `computer_use_disabled` cancel reason
  stay; `ChatComputerUseMutationGate` was deleted with the toggle.

### 6. Delete the toggle plumbing

These are pre-1.0, so they are deleted rather than migrated:

- Composer:
  - the `computerUse` and `onChangeComputerUse` props
  - the button
  - the sr-only description
  - the notice banner
  - `computerUseSaving` in `composerSubmissionAllowed`
- Chat pane:
  - `changeComputerUse`
  - `computerUseSaving`
  - the per-chat readiness send-blocker
- Main:
  - `chats:setComputerUse` and `chat-computer-use-setting.ts`
  - `chatStore.setComputerUseEnabled`, which becomes an internal grant setter
  - the draft field in `chat-draft.ts`
  - `computerUseEnabled` in `chat-first-message-params.ts` and
    `chat-first-message-commit.ts`
  - the preload channel
- Renderer libs: `computer-use-notice.ts` and `computerUseControlState`.

Out of scope: the Aiden Live dock keeps its own Computer Use toggle and approval.

### 7. Keep the footer on one row

Removing the button saves about 90px. That's not quite enough at the
screenshot's width (about 570px of content). So the footer becomes a no-wrap
row that collapses in priority order:

1. The model picker label truncates.
2. "Full access" collapses to its icon. The `@container composer` breakpoint
   is raised from 520px to about 560px.
3. The context meter drops its percentage.

Wrapping is kept only below about 380px, for the phone-width remote viewer.
This is checked in the running app at 900, 600, 520 and 420px.

### 8. Native clients and onboarding

- Remote: the access request is an ordinary `PendingApproval` with
  `scopes: ["chat","always"]`, so no wire change is needed. A phone may allow
  it from a host-run (`aiden-remote-host-runs.ts`). Phone-owned streams start
  with `allowComputerUse: false`, so they never raise it.
- Bots: durable Bot runs cannot show the card and keep the per-action model.
  Always allow, or a grant on the Bot's chat, enables Computer Use for that
  Bot's runs (with the beta on and a ready Mac).
- iOS and Android: check that both render a scopes-only card (no "once") and
  that their decision payloads omit `once`. Run `AidenChatTests` and
  `AidenChatTest`.
- The permissions state is desktop-only. A remote client shows "Finish setup on
  your Mac", because System Settings can't be opened remotely.
- Onboarding: update the Computer Use tile copy in
  `onboarding-feature-gallery.tsx` to say Aiden asks once per chat. The art
  changes only if it draws the toggle.
- Add a `.memory/` note, and update `docs/design-guide.md` if it lists the
  composer controls.

## Tests

- `llm-client` approval tests (wherever the `beforeToolCall` computer-use path
  is tested today):
  - The first call raises a chat/always card.
  - Deny blocks, and a second call in the same chat is blocked without a card.
  - Chat allow persists, and later input actions run with no card.
  - Always allow skips the card in a new chat.
  - `safety.ts` refusals still refuse.
- Permissions state:
  - The waiting call resolves on Continue once status is ready.
  - Stop clears the marker.
  - The marker survives a restart (chat-store test) and the callout's Continue
    sends the continuation (render or e2e test).
- Settings render test: the Always allow switch reflects and writes
  `computerUseAlwaysAllow`.
- Composer render and Playwright: no Computer button, and a single footer row
  at 600px. The existing composer and queue e2e still pass.
- Remote protocol (Ajv) test: a scopes-only computer-use approval validates.
- Delete the tests for the deleted code: `computer-use-notice`,
  `chat-computer-use-setting`, `computerUseControlState`, and the draft and
  first-message params cases.

## Review revisions (2026-10-12)

- Only streams that actually used Computer Use are cancelled by the beta, Form
  Fill or model-removal paths (`activateComputerUseStream` in
  `generation-gate.ts`); a disable that races a start still wins.
- `fill_form` goes through the access gate.
- A bare or "once" allow grants only the current response.
- Stop clears the continue marker; app quit keeps it.
- Reset chat permissions, the grant revision, and beta-off clearing Always
  allow were added.
- The tool is hidden on builds and OS versions that can never run it, with no
  per-generation driver probe.
- The packaged acceptance script now gates on the beta plus a chat grant or
  Always allow, and its operator steps answer the access card instead of the
  composer toggle and per-action cards.
