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
  - Capture order, not arrival order, decides. The microphone worklet stamps each 20 ms packet with `capturedUntil`, the AudioContext time none of its audio was captured after. Taking a fence notifies the tracker (`liveSessionBus.onVoiceInputFence`), which reads that clock with 50 ms slack. Speech that opens in a packet that may hold audio from before the fence gets a mark at the fence, however long the queue that delayed it. Speech captured after the fence is fresh at once. Only for packets without a stamp does a fallback apply: speech that opens in the first 500 ms of audio handled after a fence sits at the fence.
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

## PR 4: Live moves through Aiden

Live reads Aiden's own window through the accessibility tree and can open settings, find and open chats, and start new ones (4b). It never presses anything inside `[data-live-guard="you"]`.
