# Aiden Live voice upgrade

## PR 3: answer the open chat's approvals by voice, in 11 languages

Status: Built on `claude/project-thread-kc0y85-live-approvals` (2026-11-06), not yet merged.

### What the person gets

- While a Live session is on and **Settings → Voice & Speech → Aiden Live → Answer approvals by voice** is on (the default), an approval in the chat on screen is read out by Live ("The chat “Fix login” wants to run npm test. Say allow or deny.") and shown on the floating ribbon with Allow and Deny.
- The person answers by saying an allow or deny phrase in English, Spanish, French, German, Portuguese, Italian, Hindi, Bengali, Japanese, Korean or Chinese. Settings lists the languages and has a **What to say** fold with the phrases for each.
- The approval card says "Live is listening. Say “allow” or “deny”." while Live is on it, or "Live can’t answer this one. Tap to choose." for a tap-only approval.
- Live's own Computer Use approvals use the same phrase list, so they also work in all 11 languages.

### Safety rules

- Only the user's own finalized speech counts (`liveSessionBus.onVoiceInput`), only with an id above `latestVoiceInputId()` captured when the approval was read out, and only when the **whole utterance** is an allow or deny phrase (`matchLiveVoicePhrase`). A longer sentence, a bare "yes", a confirm phrase or Live's own words never answer.
- There is no model-callable approve tool. The read-out is a Live note; nothing the model says or calls can answer an approval.
- Voice allow is always **allow once**. "Allow for this chat" and "Always allow" stay tap-only.
- Tap-only (Live says "This one needs a tap."): approvals without an allow-once option (`canAllow` false, or `scopes` without `once`), any approval with a specialised review (`details`: schedules, automations, classification, helper writes and shells, run grants, form fill, Computer Use access), every tool outside the plain workspace set (`run_command`, `background_job`, `edit_file`, `write_file`, `read_file`, `delete_file`, `move_file`, `share_image`, `web_fetch`), so browser actions, connector (MCP) tools, image generation and Computer Use need a tap, and any approval whose summary or preview mentions passwords, keys, tokens, payments, cards, banking or hand-offs.
- One approval at a time, in the card's order. When it is answered by tap (card or ribbon), the run ends, the setting is turned off, Live stops, or the chat changes, the ribbon clears and later speech is ignored. Approvals in a chat that is not on screen are never voice-answerable; when the person leaves a chat with a pending approval, Live says it is still waiting there.

### How it works

- `renderer/lib/live-chat-approvals.ts`: `liveChatApprovals` (the chat pane publishes its pending approvals and its own `decideApproval`), the tap-only policy and spoken text, and `LiveChatVoiceApprovals`, which reads the first approval of the chat on screen (`liveOpenChat`), sends the read-out with `liveSessionBus.note`, publishes `liveActivity.set("approvals", {kind: "approval", …})` and answers from voice or ribbon taps.
- `renderer/components/assistant/use-live-chat-voice-approvals.ts`: the hooks. `AssistantDock` starts the controller with the setting; `chat-pane.tsx` publishes its approvals and passes the hint to `ChatApprovalCard`. The publisher never publishes approvals left in state from the previous chat under the next chat.
- A voice or ribbon answer calls the chat pane's `decideApproval` with no scope, the same call as the card's **Allow once** and **Deny**, so the card, the denied-composer hint, paired Remote clients and `chat:approve` behave exactly as for a tap.
- Not done: the approval record has no field for who or how it was answered, so a voice answer is not marked "by voice". Adding one would change the approval and Remote contracts (iOS and Android), so it is left for a follow-up.
- Settings: `renderer/components/settings/live-voice-approval-settings.tsx`, one line in `gemini-live-settings.tsx`.

### Tests

- `renderer/lib/live-chat-approvals.test.ts`: read-out and ribbon, allow in English/Spanish/Hindi/Japanese and deny, speech before the read-out, longer sentences, "yes", Live's own notes, order, tap and ribbon answers, another chat, tap-only kinds, switch off and no session.
- `renderer/components/assistant/use-live-chat-voice-approvals.test.tsx`: a spoken "permitir" sends the same `chat:approve` as tapping Allow once; switch off; no carry-over between chats.
- `renderer/components/settings/live-voice-approval-settings.test.tsx`, the card hint case in `chat-approval-card.test.tsx`, and the multilingual Computer Use case in `assistant-ui.test.tsx`.
