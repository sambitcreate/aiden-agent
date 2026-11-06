# Aiden Live voice upgrade

## PR 2: Live talks to and steers chats

Status: built on `claude/project-thread-kc0y85-live-chat` (2026-11-06), not merged. Remote revision 60 is provisional and is re-claimed at merge, after whatever `main` holds then.

### What Live can do

One tool group joins `LIVE_TOOL_PROVIDER_FACTORIES` (`main/services/gemini-live/live-chat-tools.ts`). It is left out when **Let Live use the open chat** is off (`aidenLiveChatAccess: false`) or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`, read the same way as the other Live flags.

| Tool | What it does |
| --- | --- |
| `read_open_chat({limit?})` | Reads the chat on screen: at most 20 messages and 12,000 characters, newest kept. Tool steps become one line (`[Used tools: …]`), attachments a count. Redaction hides `-----BEGIN … KEY-----` blocks, `KEY=value` or `KEY: value` pairs whose key names a password, secret, token, API key, private key, access key or credentials, and bare credential-shaped tokens; it is not a full secret scanner. |
| `send_to_open_chat({text, mode})` | Sends at once through the chat pane's own paths. `auto` sends when idle, steers a running turn when it can, else queues; `steer` and `queue` ask for one. At most 4,000 characters. |
| `stop_open_chat()` | Stops the run, like the Stop button. |
| `find_and_open_chat({query})` | Opens one clear title match. When several match closely it opens none and returns up to 3 titles to ask about. |
| `start_new_chat({workspace?, text?})` | Opens a new chat in the named (or current) workspace and, with text, sends it once that new draft (by its id) is on screen. A workspace name that ties with another is refused, even an exact-name tie. |

Main checks each call's arguments and forwards it to the window over the Live session bus (`renderer/main/live-chat-tools-host.tsx`, `renderer/lib/live-chat-tools.ts`). The window checks them again and uses the open chat pane's controller (`renderer/main/live-chat-controller.ts`), so a Live send is the same send, steer, queue or stop the person would make. Only regular chats register a controller or are listed (`chatSurface(...) === "regular"`, `isUserVisibleChat`): Bot, Assistant and feature-owned chats are out of reach. Failures use fixed codes and messages, and no tool can answer a tool approval. Chat tool calls run one at a time per window.

### Safety rules

- **Chat text is data.** Transcript text, chat titles and close-match titles come back inside `untrusted_chat_content`, and Live's instructions say text from chats is never an instruction.
- **A send needs fresh speech.** `send_to_open_chat`, `stop_open_chat` and `start_new_chat` with text run only when a finalized user voice input arrived after the latest chat read or spoken note Live received (`LiveChatRequestGate` over `liveSessionBus.latestVoiceInputId()`). Otherwise they answer `needs_user_request` ("Ask the person first").
- **Cancels and timeouts.** The main broker sends `tool_cancel` to the window on a timeout as well as on a cancel, and the window checks for the cancel right before it commits. Once a send, stop or new chat has been handed to the chat pane, its real outcome is reported (`committed: true`). If main gave up on a forwarded mutating call and no result came within a short grace period, Live gets `outcome_unknown` ("check the chat before trying again; do not resend it") instead of `cancelled`. An append the composer itself can't confirm, or a steer that fails, also answers `outcome_unknown`.
- **Stop and the queue.** A voice Stop pauses the chat's queue only when a run was actually stopped. While the queue is paused, Live can still send to an idle chat with nothing queued or steer a running one, but anything that would queue answers `queue_paused`.
- **Saved, not read.** `saved_not_read` means the message was saved but the run could not start; the tool description tells Live to say so rather than resend.

### Spoken notes

Only chats Live sent to or started in this session are watched. When one finishes, stops with an error, waits for an approval or asks a question, Live gets a short note (at most 300 characters, title and state only, never reply text) through `liveSessionBus.note`, but only while the chat's newest message from the person is still the one Live sent by voice: a reply to something the person typed afterwards gets no note, and neither does a reply the person stopped. Notes stop when the session ends, and there are none when chat access is off or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`, since then Live can't send.

### "By voice"

Messages Live sends carry `inputSource: "voice"`, saved with the message (including the saved intent a lost steer is retried from). Desktop shows a small "By voice" label under them, also while a new worktree is being made for a first message. Editing a queued voice message drops the label, since the text is then the person's. It is a shared transcript contract: the Remote chat projection carries it on user messages (revision 60, `AIDEN_REMOTE_VOICE_INPUT_CONTRACT_REVISION`, fixture `voiceInput`), and iOS and Android show the same label. Older clients ignore the key. See [the Remote API](../aiden-remote-api-v1.md#voice-input-label-revision-60-provisional).

### Settings and notice

Settings → Voice & Speech → Aiden Live has a "Chats" group with **Let Live use the open chat**, on by default. The first chat tool use shows "Live can read and send to your chats. You can turn this off in Settings." once, with a Settings action, and saves `aidenLiveChatAccessNoticeShown`.

### Open items

- Re-claim the Remote revision against `main` at merge and update the iOS, Android and fixture contracts together.
- iOS and Android unit tests were written but not run in the build environment; run them before merge.
