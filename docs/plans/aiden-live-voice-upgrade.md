# Aiden Live voice upgrade

## PR 4: Live moves through Aiden's own window

Status: built on `claude/project-thread-kc0y85-live-app-control` (2026-11-06).

Aiden Live can look at and use Aiden's own window by reading its accessibility
tree. It needs no Accessibility or Screen Recording permission and works
wherever Live runs, because it only touches Aiden's own renderer. It still
cannot act on other apps or the rest of the screen unless Computer Use is on;
Live's system instruction says so whenever these tools exist.

### Tools

One provider group in `LIVE_TOOL_PROVIDER_FACTORIES`
(`main/services/gemini-live/app-control/`), null when **Let Live move through
Aiden** (`aidenLiveAppControl`, on by default) is off:

- `look_at_aiden({focus?})` reads `Accessibility.getFullAXTree`, a
  `DOMSnapshot.captureSnapshot` of the same document and the layout viewport
  over the Live owner's `webContents.debugger`, and returns a numbered list:
  headings, landmarks and dialogs for orientation, then controls with their
  role, accessible name, state (checked, pressed, expanded, selected, disabled,
  focused) and the value of ordinary fields. At most 200 controls and 12,000
  characters; an open dialog comes first, then the focus words, then what is
  visible, and the rest is counted as omitted. Password, one-time code and card
  fields (`isSensitiveField`, shared with the in-app browser) and every text
  field inside a `data-live-guard="you"` region never show a value.
- `use_aiden({element, action, text?, key?})` acts on a number from the latest
  look with `press`, `type`, `toggle`, `select`, `scroll` or `key`. Main
  resolves the element with `DOM.resolveNode` and runs one page function with
  `Runtime.callFunctionOn`: it re-checks the guards on the live element, then
  acts with DOM events (pointer and mouse events plus `click()`, the native
  value setter plus `input`/`change`, `KeyboardEvent`s), never synthetic OS
  input. The result carries a fresh compact look (120 controls, 8,000
  characters) with new controls marked, so Live rarely has to look again.
- `open_in_aiden({place})` reuses `aidenAppNavigation` and the `aiden_open`
  destinations.

Numbers expire on the next look and on any navigation, including in-app route
changes (`did-navigate-in-page`). Nothing else attaches a debugger to the main
window (the in-app browser attaches only to its own tab views); a debugger that
is already attached and not Live's, such as DevTools, is a fixed
`window_inspected` error. Live detaches when the session ends.

### Guards

Enforced in main and the page function, not only in Live's instructions:

- `data-live-guard="you"`: never pressed or typed into by Live, and listed as
  "(only you can use this)". Marked: approval cards (chat, Bot and Computer Use
  access), the Usage data switch, the whole Aiden Live and Computer Use
  Settings pages (so every Live switch, this one included), the window's
  Minimize/Maximize/Close buttons, the MCP secret value field, and onboarding
  (`data-onboarding-active`). Secret fields count
  as "you" wherever they are.
- `data-live-guard="confirm"`: destructive buttons (`Button variant="destructive"`,
  so every destructive `AlertDialog` confirm such as Delete chat, Delete Bot,
  Remove workspace, Sign out), red menu rows, and MCP Sign out. `use_aiden`
  returns `waiting_for_user` at once and the pending OK is bound to that one
  element and action. The renderer shows the ribbon's confirm state (tap works
  at once) and sends Live a note asking it to prompt the user. Speech counts
  only after that note was accepted: the next whole utterance (one per user
  turn) must be a `confirm` phrase from `matchLiveVoicePhrase`, in any of the
  11 languages. If the note is refused, the OK is tap-only. Cancel, a deny
  phrase, any other speech, Escape, 20 seconds without an answer, a new look or
  any navigation refuse it. An answer is used once: a second phrase or a late
  tap acts on nothing. Live hears the outcome as a note. The wait is not tied
  to the Gemini call, so the user's barge-in to say "confirm" doesn't cancel
  it. One OK also covers the very next action if it is the confirm button of a
  dialog, within 15 seconds (a menu row whose dialog asks again).

### Limits and take-over

- At most 30 actions per user request, counted in the renderer; the user's
  next finalized speech starts a new count.
- The user's own `keydown` (Escape included), `pointerdown`, `wheel` or
  `touchstart` in the window takes over at once: the renderer refuses further
  actions until the user speaks again and ends main's watch, which aborts the
  in-flight action before it touches the page. Live's own events are
  untrusted, so they never trigger it. A barge-in (`interrupt()`) stops the
  running action too, and the ribbon's Take over does the same.
- Each session allows 150 calls of these tools, leaving room under Gemini
  Live's 256 tool-call ids.

### What the user sees

While Live acts, the layer publishes `liveActivity.set("app-control", {kind:
"acting", label, takeOver})` for PR 1's ribbon and draws the **Live outline**:
a soft glow around the window edges in the ribbon's colours (Spectrum by
default, the theme accent when chosen), turning slowly; Reduce Motion leaves
the ring still. The outline never takes input. A guarded control replaces the
acting state with `{kind: "confirm"}`.

### Tests

`main/services/gemini-live/app-control/screen.test.ts` (fixture CDP payloads:
secrets blank, you-only marked, budget and priority), `provider.test.ts` (a
happy-dom page behind a fake DevTools port and the real renderer controller:
refs expire, guards refused, confirm by voice, tap, Escape, other speech and
timeout, the 30-action cap, take-over, barge-in, DevTools, `open_in_aiden`,
the switch), `renderer/lib/live-app-control.test.ts`, `protocol.test.ts` (the
instruction), and `tests/e2e/live-app-control.spec.ts` (the real window read
and pressed over DevTools).

### Not done here

- PR 1's ribbon should mark itself `data-live-guard="you"`, so Live can't
  press its own Confirm. Main already refuses every `use_aiden` while an OK is
  pending.
- Live can type into the chat composer and press Send through the window; such
  a message carries no "By voice" label (PR 2's chat tools add that).
