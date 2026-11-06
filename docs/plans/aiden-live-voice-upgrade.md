# Aiden Live voice upgrade

Status: Active. PR 1 (ribbon, voice, speed, goodbye) is in progress; PRs 2–4 are being built in parallel.
Date: 2026-11-06
Related: [Aiden Live Assistant](gemini-live-assistant-plan.md)

## Outcome

Aiden Live gets a new look and becomes something you can run Aiden with by voice:

1. A floating dark ribbon pill above the chat composer replaces the corner orb and HUD while Live runs. You can choose Live's voice and speaking speed, and saying goodbye ends the session.
2. Live can talk to the open chat: it sends what you ask straight to the chat and reads back the answer.
3. Approvals can be answered by voice in 11 languages.
4. Live can move through Aiden's own window (open settings, find a chat, start a new one) through the accessibility tree.

## Owner decisions

- **1a** Messages Live sends to a chat go right away, and the message shows a small "By voice" label.
- **2a** "Let Live use the open chat" is on by default, with a one-time notice.
- **3a** Fixed voice phrases in English, Spanish, French, German, Portuguese, Italian, Hindi, Bengali, Japanese, Korean and Chinese (`renderer/shared/live-voice-phrases.ts`). A phrase counts only when it is the whole utterance, and never when the utterance ends in a question mark.
- **4b** Live can also find and open other chats, and start new ones.
- **5a** The new look is a floating dark "ribbon" pill above the composer.
- **6a** The ribbon uses a Spectrum gradient by default, with a choice to follow the theme accent.

## Shared base

The four PRs build on one shared base:

- Main: `LiveToolProvider`, `LiveToolRegistry`, `LiveRendererToolBroker` (`main/services/gemini-live/live-tools.ts`) and `LIVE_TOOL_PROVIDER_FACTORIES` (`live-tool-providers.ts`). Each PR adds its tools as one factory entry.
- Renderer: `liveSessionBus` (renderer tools, finalized voice input, spoken notes), `liveOpenChat`, `liveActivity` (acting, approval, confirm), `matchLiveVoicePhrase`, and `aidenLivePreferences` with the new `AppSettings` fields.

## PR 1: ribbon, voice, speed and goodbye (in progress)

- **Ribbon pill** (`renderer/components/assistant/live-ribbon.tsx`, `live-ribbon-wave.tsx`, `use-live-ribbon-placement.ts`). Dark glass, about 380×64, centred on the chat column above the composer. It can be dragged; the place is remembered per window in local storage and double-click puts it back. The whole ribbon, including the wider captions card and any cards stacked above the pill, stays inside the window. A canvas ribbon follows the microphone while listening and Live's voice while speaking, and shimmers slowly while thinking. Reduce Motion holds a still pose. States: listening, thinking, speaking, acting (label and Take over), approval (title, chat, Deny and Allow, and "Say “allow” or “deny”" only while Live is listening for the answer) and confirm (label, Cancel and Confirm, "Say “yes, do it”"). An approval without an allow callback offers only Deny and says to open the chat. Captions show in a card above the pill. Mute, a ••• menu (voice, speaking speed, ribbon colours) and End sit on the pill; Esc on the pill ends Live. The ribbon's root and the portaled ••• menu carry `data-live-guard="you"`, so Live never presses its own controls. While Live runs, the Live shortcut first moves focus to End, and a second press while End still has focus ends Live; with no End on the pill (an approval or confirmation shows), the shortcut does not end Live.
- **Spectrum colours** are the tokens `--live-spectrum-1` to `--live-spectrum-5` in `renderer/styles.css`; the glass is `--live-glass-*`. The pill stays dark in light themes.
- **Voice**: `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` from `aidenLiveVoice`, read through the service's `resolveVoice` option each time Live starts. A new voice applies the next time Live starts.
- **Speaking speed**: pitch-preserving WSOLA time-stretch (`renderer/lib/live-time-stretch.ts`, no new dependency) inside the PCM player. Speed changes apply at once; a barge-in flush still clears everything queued. The stretcher keeps its state across short gaps in arriving audio and plays its held tail only when the reply is fully generated or audio stops arriving for 250 ms, so a reply that streams in small pieces keeps its speed.
- **Goodbye**: Live's `end_session` tool (`main/services/gemini-live/end-session-tool.ts`) asks the renderer to end Live after the goodbye has played, waiting at most 4 s. Saying an exact end phrase ends Live the same way, after giving Live's spoken goodbye up to 1.5 s to start (within the same 4 s). Neither ends Live while an approval, a confirmation or the Computer Use approval waits on the user, checked before and after the wait; the tool then answers "Answer the waiting request first." Talking over the goodbye cancels it; a resumption's playback flush does not.
- **One utterance, one voice input**: Google transcribes speech in pieces. The renderer joins them and publishes one voice input per user turn, when Google marks it finished, Live starts replying (caption, audio, text or a tool call), the turn completes, or 2 s pass in silence. Speech that talks over a reply ends only on the finished mark or the silence, because the cut-off reply's leftovers (a late caption, a last chunk, its turn end) can arrive between the user's words. Approval receipts follow the same rule and keep the id taken at the first piece, so speech that began before an approval cannot answer it.
- **Notes**: a spoken update note sent while the session resumes is queued and goes out once it reopens. `liveSessionBus.note(text)` resolves true once the note is queued. `note(text, { awaitDelivery: true })` resolves only when main has handed this note to Live: true once it is sent, false if it is refused, its send throws, or it is cleared with the session. This uses the `awaitDelivery` flag on `assistant-live:note` and `GeminiLiveService.deliverNote`.
- **Voice fence**: anything that must hear only speech begun after a moment takes `liveSessionBus.voiceInputFence()` at that moment. It then accepts an input only if `input.startedAt > fence`.
  - `LiveSpeechOnsets` (`renderer/lib/live-speech-onsets.ts`) stamps `startedAt` from the microphone, since captions arrive only after transcription. A stretch of speech opens at packet level 0.04 and ends after 500 ms of quiet.
  - An utterance's first caption claims the onset of the earliest stretch still going on or ended within 5 s of audio.
  - When an utterance is finished, every stretch that has ended and began before its latest caption is retired (however many pauses split the utterance), so none shadows the next utterance. A stretch still going on is kept, and so is one that began after that caption, since it is the start of the next utterance.
  - Capture order, not arrival order, decides. The microphone worklet stamps each 20 ms packet with `capturedUntil`, the AudioContext time none of its audio was captured after. Taking a fence notifies the tracker (`liveSessionBus.onVoiceInputFence`), which reads that clock with 350 ms slack plus the full input latency the browser reports for the microphone, never cut short. The clock is render time, which trails the sound in the room by the microphone's latency, so audio rendered up to that long after the fence may still have been spoken before it. Speech that opens in a packet that may hold audio from before the fence gets a mark at the fence, however long the queue that delayed it. Speech captured after the fence is fresh at once. Only for packets without a stamp does a fallback apply: speech that opens in the first 500 ms of audio handled after a fence sits at the fence.
  - With nothing in reach, the utterance gets `LIVE_UNTRUSTED_VOICE_START` (0), which is below every fence.
  - It fails closed: speech under way at the fence stays before it.
- **Open chat**: `liveOpenChat` keeps every mounted chat pane in mount order, so when the newest pane closes Live sees the pane still on screen.
- **Saving choices**: voice, speed and colour changes save one after another, and only the newest save's reply is applied, so a quick run of choices ends on the last.
- **Settings**: Settings → Voice & Speech → Aiden Live gains a "Voice and look" group (`renderer/components/settings/aiden-live-voice-settings.tsx`).
- **Onboarding**: the Aiden Live tile draws the ribbon pill above a composer.

## PR 2: chat by voice

Live sends what you ask to the open chat right away (1a, with a "By voice" label), reads the reply back, and can be turned off with "Let Live use the open chat" (2a).

## PR 3: approvals by voice

Approvals and guarded confirmations shown on the ribbon can be answered with the fixed phrases in 11 languages (3a). `voice: true` on an approval means Live has read it out and is listening for the answer.

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
  (`data-live-content="chat" | "artifact" | "web"`: the chat transcript, Bot
  transcripts, Live's captions, workspace pages and the in-app browser panel),
  then reads the
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
instructions. That matters because Live still sees the names controls carry,
such as chat titles in the sidebar and Memory items' labels; only message text
in chat, Bot chat, workspace page and web panel regions is never read.

### Guards

The rules live in one page-side source (`AIDEN_ELEMENT_FACTS_SOURCE`) that both
the look and the action run, so what Live is told and what the page enforces
can't drift. A control is the user's alone, listed "(only you can use this)"
and refused with `user_only`, when:

- it is inside `data-live-guard="you"` or active onboarding. Marked: approval
  cards and their "More ways to allow" menu (chat, Bot and Computer Use
  access), the composer's workspace access picker and its Enable Full Access
  dialog, the remote pairing request, the artifact "Allow these commands?"
  review, the browser's agent-access controls, the Usage data switches and
  notice, MCP secret fields, the window controls, every Bot decision card
  (access requests, skill, routine, lesson and plan proposals, hand-offs,
  connect and issue cards), every Bot page (Profile, Instructions, Advanced,
  Allowed, Learning, Memory, Interruptions, Open work, chat activity), the Bot
  panel's Routines, Memory and Computer tabs (the Computer tab itself too,
  since opening it starts the VM), Bot creation, the workspace settings
  dialog, the Scheduled tasks page and editor, cloning a repository from the
  workspace picker, simulator setup and Erase, the chat composer and Send when
  **Let Live use the open chat** is off, and these whole Settings pages: Aiden
  Live, Voice, Speech, Computer Use, Approvals, App controls, Remote Access,
  Connections, Telegram, Bots, Bot computers, Simulator, MCP, Scheduled tasks,
  Limits, Providers, Model data, Web Search, Image Generation and About
  (anything that chooses where chats, recordings, prompts, queries or keys go,
  fetches catalogs, downloads models or installs updates);
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
note asking it to prompt the user. Speech counts only once that note was
delivered to Live (`note(text, { awaitDelivery: true })`), and only speech
begun after it (`input.startedAt > voiceInputFence()` taken on delivery): a
whole utterance that is a `confirm` phrase from `matchLiveVoicePhrase`, in any
of the 11 languages. Speech already under way at the fence, or with no
provable onset, never says yes (a deny phrase there still refuses). If the
note is held, refused or dropped, the OK is tap-only. Cancel, a deny phrase, any other speech, Escape, 20 seconds
without an answer, a new look or any navigation refuse it. So does the user's
own click, scroll, touch or key anywhere but the ribbon's Confirm and Cancel
(marked `data-live-confirm-answer`), which also takes over until they speak
again; Tab and lone modifier keys only move focus, so the keyboard can still
reach Confirm. An answer is used
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
1's ribbon shows with Confirm and Cancel. The ribbon and its ••• menu are
marked `data-live-guard="you"`, so Live lists them as the user's and never
presses them. The outline uses the ribbon's `--live-spectrum-*` tokens.

### Tests

`main/services/gemini-live/app-control/screen.test.ts` (secrets blank, guards
marked, content regions summarized, budget and priority), `provider.test.ts`
(a happy-dom page behind a fake DevTools port and the real renderer
controller: refs expire, the guard rules on the live page, content regions
never read, external links refused, changed elements, confirm by voice, tap,
Escape, other speech, the user's own click and timeout, an undelivered prompt
left tap-only, speech begun before the prompt never confirming, one OK per guarded action, no other move
between the OK and the confirmed action, the 30-action
cap, take-over during and between steps, time limits, barge-in, DevTools,
`open_in_aiden`, the 120-call budget, the switch turned off mid-session),
`debugger-port.test.ts` (shared attachment, DevTools),
`renderer/components/live-guard.test.tsx` (guards reach portaled menus,
dialogs and popovers; a Bot's access card and simulator Erase are the user's),
`composer-attachments-mounted.test.tsx` (the composer and Send are the user's
with chat access off), `remote-bot-chat-view.test.tsx` (a Bot transcript is
one counted chat region), `renderer/lib/live-app-control.test.ts`,
`protocol.test.ts` (the instruction), and `tests/e2e/live-app-control.spec.ts`
(the real window read and pressed over DevTools).

### Not done here

- Live can't read chat text through the window; PR 2's chat tools read the
  open chat instead.
- With **Let Live use the open chat** on, Live can type into the chat composer
  and press Send through the window; such a message carries no "By voice"
  label (PR 2's chat tools add that).
