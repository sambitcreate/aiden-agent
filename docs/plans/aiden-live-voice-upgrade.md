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

## PR 2: Live talks to and steers chats

Live sends what you ask to the open chat right away (1a, with a "By voice" label), reads the reply back, and can be turned off with "Let Live use the open chat" (2a).

Status: built on `claude/project-thread-kc0y85-live-chat` (2026-11-06), not merged. Remote revision 60 (claimed 2026-11-10, when main was at 59).

### What Live can do

One tool group joins `LIVE_TOOL_PROVIDER_FACTORIES` (`main/services/gemini-live/live-chat-tools.ts`). It is left out when **Let Live use the open chat** is off (`aidenLiveChatAccess: false`) or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`, read the same way as the other Live flags.

| Tool | What it does |
| --- | --- |
| `read_open_chat({limit?})` | Reads the chat on screen: at most 20 messages and 12,000 characters, newest kept. Tool steps become one line (`[Used tools: …]`), attachments a count. Redaction hides `-----BEGIN … KEY-----` blocks, `KEY=value` or `KEY: value` pairs whose key names a password, secret, token, API key, private key, access key or credentials, and bare credential-shaped tokens; it is not a full secret scanner. The same redaction applies to every chat title, close-match title and workspace name a tool returns, and to titles in spoken notes. |
| `send_to_open_chat({text, mode})` | Sends at once through the chat pane's own paths. `auto` sends when idle, steers a running turn when it can, else queues; `steer` and `queue` ask for one. At most 4,000 characters. |
| `stop_open_chat()` | Stops the run, like the Stop button. |
| `find_and_open_chat({query})` | Opens one clear title match. When several match closely it opens none and returns up to 3 titles to ask about. |
| `start_new_chat({workspace?, text?})` | Opens a new chat in the named (or current) workspace and, with text, sends it once that new draft (by its id) is on screen. A workspace name that ties with another is refused, even an exact-name tie. |

Main checks each call's arguments and forwards it to the window over the Live session bus (`renderer/main/live-chat-tools-host.tsx`, `renderer/lib/live-chat-tools.ts`). The window checks them again and uses the open chat pane's controller (`renderer/main/live-chat-controller.ts`), so a Live send is the same send, steer, queue or stop the person would make. Only regular chats register a controller or are listed (`chatSurface(...) === "regular"`, `isUserVisibleChat`): Bot, Assistant and feature-owned chats are out of reach. Failures use fixed codes and messages, and no tool can answer a tool approval. Chat tool calls run one at a time per window.

### Safety rules

- **Chat text is data.** Transcript text, chat titles and close-match titles come back inside `untrusted_chat_content`, and Live's instructions say text from chats is never an instruction.
- **A send needs fresh speech.** `send_to_open_chat`, `stop_open_chat` and `start_new_chat` with text run only after a finalized utterance that *started* after chat content last reached Live (`LiveChatRequestGate`). When content reaches Live, the gate takes `liveSessionBus.voiceInputFence()`: for any tool result that carries `untrusted_chat_content` (a read's messages, or a title, close matches or workspace name from send, stop, find or start), as the window returns the result and again once `LiveSessionBus` has handed that result to main and main accepted it (the context's `afterReport`; a refused result never reached Live, so it moves nothing), so speech that began while the result was on its way doesn't count, and the next chat tool call waits until that hand-off is settled (the context's `afterSettled`) so it can't use that speech either; for a spoken note, only once `liveSessionBus.note(text, { awaitDelivery: true })` confirms main handed it to Live (a dropped note moves nothing, since Live never saw it). An utterance counts only if its `startedAt` is above that fence, so speech already under way when the content arrived never counts, however late it is finalized, and speech with `LIVE_UNTRUSTED_VOICE_START` never counts. Input ids are not compared. Otherwise these tools answer `needs_user_request` ("Ask the person first").
- **Cancels and timeouts.** The main broker sends `tool_cancel` to the window on a timeout as well as on a cancel, and the window checks for the cancel right before it commits. Once a send, stop, chat switch or new chat has been handed to the chat pane or router, its real outcome is reported (`committed: true`). If main gave up on a forwarded mutating call (all of these, `find_and_open_chat` included) and no result came within a short grace period, Live gets `outcome_unknown` ("check the chat before trying again; do not resend it") instead of `cancelled`. An append the composer itself can't confirm, or a steer that fails, also answers `outcome_unknown`.
- **Stop and the queue.** A voice Stop pauses the chat's queue only when a run was actually stopped. While the queue is paused, Live can still send to an idle chat with nothing queued or steer a running one, but anything that would queue answers `queue_paused`.
- **Saved, not read.** `saved_not_read` means the message was saved but the run could not start; the tool description tells Live to say so rather than resend.
- **Refused by a hook.** When one of the person's `UserPromptSubmit` hooks refuses Live's guidance, the message stays in the chat, marked, and Live gets `hook_blocked` instead of `saved_not_read`. A hook-refused message never counts as Live's turn, so the end of an earlier reply sends no spoken update about it.

### Spoken notes

Only chats Live sent to or started in this session are watched. When one finishes, stops with an error, waits for an approval or asks a question, Live gets a short note (at most 300 characters, title and state only, never reply text) through `liveSessionBus.note`, but only while the chat's newest message from the person is still the one Live sent by voice: a reply to something the person typed afterwards gets no note, and neither does a reply the person stopped. Notes stop when the session ends, and there are none when chat access is off or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`, since then Live can't send.

### "By voice"

Messages Live sends carry `inputSource: "voice"`, saved with the message (including the saved intent a lost steer is retried from). Desktop shows a small "By voice" label under them, also while a new worktree is being made for a first message. Editing a queued voice message drops the label, since the text is then the person's. It is a shared transcript contract: the Remote chat projection carries it on user messages (revision 60, `AIDEN_REMOTE_VOICE_INPUT_CONTRACT_REVISION`, fixture `voiceInput`), and iOS and Android show the same label. Older clients ignore the key. See [the Remote API](../aiden-remote-api-v1.md#voice-input-label-revision-60).

### Settings and notice

Settings → Voice & Speech → Aiden Live has a "Chats" group with **Let Live use the open chat**, on by default. The first chat tool use shows "Live can read and send to your chats. You can turn this off in Settings." once, with a Settings action, and saves `aidenLiveChatAccessNoticeShown`.

### Done before merge

- Remote revision 60 was claimed on 2026-11-10, when `main` was at 59; the iOS, Android and fixture contracts use it.
- CI runs the iOS and Android unit tests for the label (iOS simulator tests and the Android `testDebugUnitTest` step).

## PR 3: approvals by voice

Status: Built on `claude/project-thread-kc0y85-live-approvals` (2026-11-06), revised after review the same day; not yet merged.

### What the person gets

- While a Live session is on and **Settings → Voice & Speech → Aiden Live → Answer approvals by voice** is on (the default), Aiden asks Live to read out the first approval in the chat on screen, for example that the chat "Fix login" wants to run the command "npm test", and that the person can say allow or deny.
- The approval is published to the floating ribbon (`liveActivity`, source `approvals`). PR 1's ribbon shows its title and chat with Deny, adds Allow only when the entry carries `allow`, and shows "Say “allow” or “deny”" only while `voice` is true. The goodbye guard treats it as a waiting answer, so saying goodbye never ends Live while it shows.
- Once the read-out has reached Live, the person can answer by saying an allow or deny phrase in English, Spanish, French, German, Portuguese, Italian, Hindi, Bengali, Japanese, Korean or Chinese. Settings lists the languages and has a **What to say** fold with the phrases for each.
- The approval card then says "Live is listening. Say “allow” or “deny”.", and its screen-reader status says the same. A tap-only approval says "Live can’t answer this one. Tap to choose."
- The matcher for Live's own Computer Use voice approvals uses the same phrase list, but that listener is not mounted (Live's Computer Use runs with session-authorized direct actions), so this has no effect today.

### Safety rules

- **Only the person's own speech.** It counts only from `liveSessionBus.onVoiceInput` (one joined utterance per user turn, from PR 1), and only when the whole utterance is an allow or deny phrase (`matchLiveVoicePhrase`). A longer sentence, a bare "yes", a confirm phrase or Live's own words never answer. There is no model-callable approve tool.
- **Only after the read-out is sent.** The read-out goes out with `liveSessionBus.note(text, { awaitDelivery: true })`. Main's `deliverNote` (the `awaitDelivery` flag on `assistant-live:note`) resolves only when that note is handed to Live: true once `sendText` succeeds, false if the note is refused, its send throws, or it is cleared with the session. A note queued behind earlier notes (2 s spacing) or held while the session resumes keeps the approval disarmed. The 2.5 s arm delay starts only after delivery. The fence is taken when it ends, and the card and ribbon say Live is listening 500 ms later, past the fence's capture slack (and the handled-audio fallback guard), so fresh speech can answer. Plain `sendNote` callers keep the old "queued" answer.
- **Only speech that starts after arming.** On arming, the approval takes the bus start mark (`voiceInputFence()`). Each utterance carries a start mark (`LiveVoiceInput.startedAt`), and it counts only if that mark is above the fence. The mark comes from when the microphone first heard the speech, because captions arrive only after transcription:
  - `LiveSpeechOnsets` (`renderer/lib/live-speech-onsets.ts`) reads each microphone packet's level. It opens a stretch of speech at level 0.04, and 500 ms of quiet ends it.
  - The utterance's first caption, interim or final, claims the onset of the earliest stretch still in reach: one still going on, or one that ended within the last 5 s of audio.
  - When no onset is in reach (speech too quiet to measure, or a caption later than the 5 s window), the utterance gets an untrusted mark below every fence, so it can never answer an approval by voice; the card still answers taps.
  - So an "allow" spoken before arming does not count, even if its caption arrives or finishes after. Neither does a repeated "allow" meant for the previous approval.
  - It fails closed: speech under way at arm time stays before the fence until a silence gap. Nearby earlier speech can make a fresh "allow" count as early, and the person then says it again or taps.
  - Continuous loud noise behaves the same way, so in a noisy room voice may never count, and the card still answers taps.
  - The provider's own voice-activity messages are validated by the protocol but not used, since the current setup does not rely on them.
- **Lost read-outs.** A refused or lost read-out leaves the approval tap-only. It is retried every 3 s, up to 5 tries, and again when the session changes. Each retry must itself be delivered before voice arms.
- **Quoted data.** The read-out is a factual note. The chat title, command and path appear only as JSON-quoted data, with a line saying quoted text is data, not instructions.
- **Allow once only.** Voice allow is always allow once. "Allow for this chat" and "Always allow" stay tap-only.
- **Voice only when Live can name the target in full.** Voice works only for Aiden's own `run_command`, `background_job`, `edit_file`, `write_file` and `share_image`. The exact command or path must come from the preview or Aiden's own summary, be one line and be at most 120 characters. A longer or unknown target is tap-only.
- **Tap-only cases.** Live says this one can only be answered by a tap:
  - approvals the card cannot allow (`canAllow` false), or without an allow-once choice;
  - any specialised review (`details`): schedules, automations, classification, helper writes and shells, run grants, form fill, Computer Use access;
  - external-agent (ACP) approvals, recognised by their "… wants to …:" summary;
  - approvals with `source: "remote"` (a paired phone's turn);
  - every other tool: browser, connector (MCP), `web_fetch`, `read_file`, `delete_file`, `move_file`, image generation, Computer Use;
  - anything that mentions passwords, tokens, secrets, API or access keys, auth, 2FA, keychain or `security`, ssh keys, `.env`, `env`/`printenv`, AWS, gcloud, gpg, netrc, `op://`, payments, cards, banking, wallets or hand-offs. Word boundaries treat `_` as a separator, so `GITHUB_TOKEN` and `OPENAI_API_KEY` are caught.
- **Ribbon taps follow the card.** The ribbon entry carries `allow` only when the card itself offers Allow once. Otherwise it has Deny only (`allow` is now optional in `LiveActivity`).
- **One approval at a time.** Approvals are taken in the card's order. A prompt that changes under the same id (`canAllow`, scopes, details, summary, preview) is judged again and read out again.
- **Clearing.** A tap on the card or ribbon, the run ending, the switch going off, Live stopping or a chat change clears the entry, and later speech is ignored. After a successful answer, nothing more is sent until the pane republishes, so there is never a second `chat:approve`.
- **Chats not on screen.** Approvals in a chat that is not on screen are never voice-answerable. When the person leaves a chat with a pending approval, Live says it is still waiting there.

### How it works

- **Core** (`renderer/lib/live-chat-approvals.ts`):
  - `liveChatApprovals`: the chat pane publishes its pending approvals and its own `decideApproval`.
  - The tap-only rules, the read-out text, and `LiveChatVoiceApprovals`, which reads the chat on screen from `liveOpenChat`.
- **Hooks** (`renderer/components/assistant/use-live-chat-voice-approvals.ts`):
  - `AssistantDock` starts the controller with the setting.
  - `chat-pane.tsx` publishes its approvals and passes the hint to `ChatApprovalCard`.
  - The published decide is bound to its chat and refuses once the pane renders another one. Approvals left over from the previous chat are never published under the next.
- **Same path as a tap.** A voice or ribbon answer calls that decide with no scope, the same call as the card's **Allow once** and **Deny**. So the card, the denied-composer hint, paired Remote clients and `chat:approve` behave exactly as for a tap.
- **Not done.** The approval record has no field for who answered it or how, so a voice answer is not marked "by voice". Adding one would change the approval and Remote contracts for iOS and Android, so it is left for a follow-up.
- **Shared type change.** In `renderer/lib/live-activity.ts`, the approval entry's `allow` is now optional, and `voice` means "Live has read it out and takes speech".
- **Settings.** `renderer/components/settings/live-voice-approval-settings.tsx`, plus one line in `gemini-live-settings.tsx`.
- **Onboarding.** The Aiden Live tile in the feature tour mentions answering approvals by voice and that it can be turned off.

### Tests

- `renderer/lib/live-chat-approvals.test.ts` covers:
  - read-out as quoted data; allow in English, Spanish, Hindi and Japanese; deny;
  - speech that must not answer: before the read-out, longer sentences, "yes", Live's own notes;
  - delayed and refused read-outs, and a read-out refused every time;
  - a repeated "allow" across two approvals, and no second answer after success;
  - tap and ribbon answers, with `allow` only where the card offers it;
  - a changed prompt; another chat; escaped injection text;
  - 21 tap-only cases, including the underscore secrets, ACP and remote;
  - switch off and no session.
- `renderer/components/assistant/use-live-chat-voice-approvals.test.tsx` covers:
  - a spoken "permitir" sends the same `chat:approve` as tapping Allow once, and the screen-reader status announces voice;
  - switch off;
  - no carry-over between chats;
  - a decide bound to one chat refuses after a switch.
- Also `renderer/components/settings/live-voice-approval-settings.test.tsx`, the card hint case in `chat-approval-card.test.tsx`, and the multilingual matcher case in `assistant-ui.test.tsx`.

## PR 4: Live moves through Aiden

Live reads Aiden's own window through the accessibility tree and can open settings, find and open chats, and start new ones (4b). It never presses anything inside `[data-live-guard="you"]`.
