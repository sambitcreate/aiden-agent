# Aiden Live voice upgrade

## PR 3: answer the open chat's approvals by voice, in 11 languages

Status: Built on `claude/project-thread-kc0y85-live-approvals` (2026-11-06), revised after review the same day; not yet merged.

### What the person gets

- While a Live session is on and **Settings → Voice & Speech → Aiden Live → Answer approvals by voice** is on (the default), Aiden asks Live to read out the first approval in the chat on screen, for example that the chat "Fix login" wants to run the command "npm test", and that the person can say allow or deny.
- The approval is published to the floating ribbon (`liveActivity`, source `approvals`); the ribbon itself is PR 1's.
- Once Live has accepted the read-out, the person can answer by saying an allow or deny phrase in English, Spanish, French, German, Portuguese, Italian, Hindi, Bengali, Japanese, Korean or Chinese. Settings lists the languages and has a **What to say** fold with the phrases for each.
- The approval card then says "Live is listening. Say “allow” or “deny”.", and its screen-reader status says the same. A tap-only approval says "Live can’t answer this one. Tap to choose."
- The matcher for Live's own Computer Use voice approvals uses the same phrase list, but that listener is not mounted (Live's Computer Use runs with session-authorized direct actions), so this has no effect today.

### Safety rules

- **Only the person's own speech.** It counts only from `liveSessionBus.onVoiceInput` (the user's finalized transcript), and only when the whole utterance is an allow or deny phrase (`matchLiveVoicePhrase`). A longer sentence, a bare "yes", a confirm phrase or Live's own words never answer. There is no model-callable approve tool.
- **Only after the read-out.** Voice is armed only after `liveSessionBus.note(...)` resolves true, plus a 2.5 s arm delay (Live spaces its notes 2 s apart). The speech baseline (`latestVoiceInputId()`) is taken when it arms, so a repeated "allow" meant for one approval cannot answer the next one before Live has said it.
- **Refused read-outs.** A refused note (the session is reconnecting, the note queue is full) leaves the approval tap-only. It is retried every 3 s, up to 5 tries, and again when the session changes.
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
