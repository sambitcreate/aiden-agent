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

- **Ribbon pill** (`renderer/components/assistant/live-ribbon.tsx`, `live-ribbon-wave.tsx`, `use-live-ribbon-placement.ts`). Dark glass, about 380×64, centred on the chat column above the composer. It can be dragged; the place is remembered per window in local storage and double-click puts it back. A canvas ribbon follows the microphone while listening and Live's voice while speaking, and shimmers slowly while thinking. Reduce Motion holds a still pose. States: listening, thinking, speaking, acting (label and Take over), approval (title, chat, Deny and Allow, and "Say “allow” or “deny”" only while Live is listening for the answer) and confirm (label, Cancel and Confirm, "Say “yes, do it”"). An approval without an allow callback offers only Deny and says to open the chat. Captions show in a card above the pill. Mute, a ••• menu (voice, speaking speed, ribbon colours) and End sit on the pill; Esc on the pill ends Live. The pill's root carries `data-live-guard="you"`, so Live never presses its own controls.
- **Spectrum colours** are the tokens `--live-spectrum-1` to `--live-spectrum-5` in `renderer/styles.css`; the glass is `--live-glass-*`. The pill stays dark in light themes.
- **Voice**: `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` from `aidenLiveVoice`, read through the service's `resolveVoice` option each time Live starts. A new voice applies the next time Live starts.
- **Speaking speed**: pitch-preserving WSOLA time-stretch (`renderer/lib/live-time-stretch.ts`, no new dependency) inside the PCM player. Speed changes apply at once; a barge-in flush still clears everything queued.
- **Goodbye**: Live's `end_session` tool (`main/services/gemini-live/end-session-tool.ts`) asks the renderer to end Live after the goodbye has played, waiting at most 4 s. Saying an exact end phrase ends Live the same way. Neither ends Live while an approval or confirmation shows; talking over the goodbye cancels it.
- **One utterance, one voice input**: Google transcribes speech in pieces. The renderer joins them and publishes one voice input per user turn, when Google marks it finished, Live starts replying (caption, audio, text or a tool call), the turn completes, or 2 s pass in silence. Approval receipts follow the same rule and keep the id taken at the first piece, so speech that began before an approval cannot answer it.
- **Settings**: Settings → Voice & Speech → Aiden Live gains a "Voice and look" group (`renderer/components/settings/aiden-live-voice-settings.tsx`).
- **Onboarding**: the Aiden Live tile draws the ribbon pill above a composer.

## PR 2: chat by voice

Live sends what you ask to the open chat right away (1a, with a "By voice" label), reads the reply back, and can be turned off with "Let Live use the open chat" (2a).

## PR 3: approvals by voice

Approvals and guarded confirmations shown on the ribbon can be answered with the fixed phrases in 11 languages (3a). `voice: true` on an approval means Live has read it out and is listening for the answer.

## PR 4: Live moves through Aiden

Live reads Aiden's own window through the accessibility tree and can open settings, find and open chats, and start new ones (4b). It never presses anything inside `[data-live-guard="you"]`.
