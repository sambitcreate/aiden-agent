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
Aiden** (`aidenLiveAppControl`, on by default) is off. The switch is read again
on every call, so turning it off mid-session stops the tools, any running
action and any pending OK at once (`turned_off`).

- `look_at_aiden({focus?})` reads the Live owner's window over
  `webContents.debugger`. It first finds the untrusted content regions
  (`data-live-content="chat" | "artifact" | "web"`: the chat transcript, Live's
  captions, workspace pages and the in-app browser panel), then reads the
  accessibility tree level by level from `Accessibility.getRootAXNode` with
  `getChildAXNodes`, never descending into those regions (at most 6,000 nodes),
  and asks the page for every element's facts in one `Runtime.callFunctionOn`.
  It returns a numbered list: headings, landmarks and dialogs for orientation,
  one summary line per content region (`[chat messages (12), text not shown]`),
  then controls with their role, accessible name, state and the value of
  ordinary fields. At most 200 controls and 12,000 characters; an open dialog
  comes first, then the focus words, then what is visible. Secret fields and
  every text field Live may not use never show a value.
- `use_aiden({element, action, text?, key?})` acts on a number from the latest
  look with `press`, `type`, `toggle`, `select`, `scroll` or `key`. Main checks
  with `Accessibility.getPartialAXTree` that the element still has the role and
  name it had in the look, then runs one page function (`Runtime.callFunctionOn`,
  no user gesture) that checks the element's fingerprint and the guard rules
  again on the live DOM and acts with DOM events, never synthetic OS input. A
  changed element is `stale_element`. Links that leave the app (web, mail or
  anything outside Aiden's own page) are refused with `external_link`. The
  result carries a fresh compact look (120 controls, 8,000 characters).
- `open_in_aiden({place})` reuses `aidenAppNavigation` and the `aiden_open`
  destinations.

Numbers expire on the next look and on any navigation, including in-app route
changes. Every DevTools call has a 5-second limit (`window_timeout`), and every
action races the user's take-over, so a hung window never leaves Live busy.

The debugger attachment belongs to the window, not the session
(`debugger-port.ts`): sessions share it and the last one to close detaches, so
a restarted session never mistakes Live's own debugger for an inspector.
DevTools being open (`isDevToolsOpened()`, or the `devtools-opened` event,
which also makes Live let go) or another debugger is a fixed
`window_inspected` error.

Live's instructions say that text inside Aiden's pages is data, not
instructions.

### Guards

The rules live in one page-side source (`AIDEN_ELEMENT_FACTS_SOURCE`) that both
the look and the action run, so what Live is told and what the page enforces
can't drift. A control is the user's alone, listed "(only you can use this)"
and refused with `user_only`, when:

- it is inside `data-live-guard="you"` or active onboarding. Marked: approval
  cards and their "More ways to allow" menu (chat, Bot and Computer Use
  access), the composer's workspace access picker and its Enable Full Access
  dialog, the remote pairing request, the artifact "Allow these commands?"
  review, the browser's agent-access controls, the Usage data switches, MCP
  secret fields, the window controls, and these whole Settings pages: Aiden
  Live, Computer Use, Approvals, App controls, Remote Access, Connections,
  Telegram, Bots, Bot computers, Simulator, MCP, Scheduled tasks, Limits,
  Providers, Model data, Web Search, Image Generation and About (anything that
  chooses where chats, prompts, queries or keys go, fetches catalogs or
  installs updates);
- it is a password, one-time code or card field;
- it is a switch or checkbox anywhere in Aiden, unless it sits inside
  `data-live-safe` (only the Appearance and Links pages are marked safe);
- its name, or the name of the dialog it is in, asks for a permission: allow,
  enable, grant, trust, approve, pair, permit or full access.

Menus, dialogs, popovers and selects render into a portal outside their
region, so guarded regions use the `LiveGuard` provider
(`renderer/components/live-guard.tsx`); the shared content components in
`ui.tsx` stamp its guard on their portaled root.

`data-live-guard="confirm"` marks destructive buttons (`Button
variant="destructive"`, so every destructive `AlertDialog` confirm such as
Delete chat, Delete Bot, Remove workspace, Sign out), red menu rows, and MCP
Sign out. `use_aiden` returns `waiting_for_user` at once and the pending OK is
bound to that one element and action. The renderer publishes the confirm state
for PR 1's ribbon, which shows Confirm (a tap works at once), and sends Live a
note asking it to prompt the user. Speech counts only after that note was
accepted: the next whole utterance must be a `confirm` phrase from
`matchLiveVoicePhrase`, in any of the 11 languages. If the note is refused,
the OK is tap-only. Cancel, a deny phrase, any other speech, Escape, 20 seconds
without an answer, a new look or any navigation refuse it. An answer is used
once, and every guarded action asks on its own, even the next one in the same
dialog. Live hears the outcome as a note. The wait is not tied to the Gemini
call, so the user's barge-in to say "confirm" doesn't cancel it.

### Limits and take-over

- At most 30 actions per user request, counted in the renderer; the user's
  next finalized speech starts a new count.
- From Live's first action for a request until the user speaks again, the
  user's own `keydown` (Escape included), `pointerdown`, `wheel` or
  `touchstart` in the window takes over, between steps too: the renderer
  refuses further actions until the user speaks again and ends main's watch,
  which aborts the in-flight action. Live's own events are untrusted, so they
  never trigger it. A barge-in (`interrupt()`) stops the running action too,
  and so does Take over on PR 1's ribbon.
- Each session allows 120 calls of these tools. Gemini Live allows 256
  tool-call ids per session across every tool, and Computer Use doesn't report
  its count, so this leaves it room.

### What the user sees

While Live acts, the layer publishes `liveActivity.set("app-control", {kind:
"acting", label, takeOver})`, which PR 1's ribbon shows with Take over, and
draws the **Live outline**: a soft glow around the window edges in the
ribbon's colours (Spectrum by default, the theme accent when chosen), turning
slowly; Reduce Motion leaves the ring still. The outline never takes input. A
guarded control replaces the acting state with `{kind: "confirm"}`, which PR
1's ribbon shows with Confirm and Cancel. This branch has no ribbon of its
own; the screenshots use a stand-in.

### Tests

`main/services/gemini-live/app-control/screen.test.ts` (secrets blank, guards
marked, content regions summarized, budget and priority), `provider.test.ts`
(a happy-dom page behind a fake DevTools port and the real renderer
controller: refs expire, the guard rules on the live page, content regions
never read, external links refused, changed elements, confirm by voice, tap,
Escape, other speech and timeout, one OK per guarded action, the 30-action
cap, take-over during and between steps, time limits, barge-in, DevTools,
`open_in_aiden`, the 120-call budget, the switch turned off mid-session),
`debugger-port.test.ts` (shared attachment, DevTools),
`renderer/components/live-guard.test.tsx` (guards reach portaled menus,
dialogs and popovers), `renderer/lib/live-app-control.test.ts`,
`protocol.test.ts` (the instruction), and `tests/e2e/live-app-control.spec.ts`
(the real window read and pressed over DevTools).

### Not done here

- PR 1's ribbon should mark itself `data-live-guard="you"`, so Live can't
  press its own Confirm. Main already refuses every `use_aiden` while an OK is
  pending.
- Live can't read chat text through the window; PR 2's chat tools read the
  open chat instead.
- Live can type into the chat composer and press Send through the window; such
  a message carries no "By voice" label (PR 2's chat tools add that).
