## PR 2: Live talks to and steers chats

Status: built on `claude/project-thread-kc0y85-live-chat` (2026-11-06), not merged. Remote revision 60 is provisional and is re-claimed at merge, after whatever `main` holds then.

### What Live can do

One tool group joins `LIVE_TOOL_PROVIDER_FACTORIES` (`main/services/gemini-live/live-chat-tools.ts`). It is left out when **Let Live use the open chat** is off (`aidenLiveChatAccess: false`) or `AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT=0`, read the same way as the other Live flags.

| Tool | What it does |
| --- | --- |
| `read_open_chat({limit?})` | Reads the chat on screen: at most 20 messages and 12,000 characters, newest kept. Tool steps become one line (`[Used tools: …]`), attachments a count, and credential-shaped text is redacted. |
| `send_to_open_chat({text, mode})` | Sends at once through the chat pane's own paths. `auto` sends when idle, steers a running turn when it can, else queues; `steer` and `queue` ask for one. At most 4,000 characters. |
| `stop_open_chat()` | Stops the run, like the Stop button. |
| `find_and_open_chat({query})` | Opens one clear title match. When several match closely it opens none and returns up to 3 titles to ask about. |
| `start_new_chat({workspace?, text?})` | Opens a new chat in the named (or current) workspace and, with text, sends it. |

Main checks each call's arguments and forwards it to the window over the Live session bus (`renderer/main/live-chat-tools-host.tsx`, `renderer/lib/live-chat-tools.ts`). The window checks them again and uses the open chat pane's controller (`renderer/main/live-chat-controller.ts`), so a Live send is the same send, steer, queue or stop the person would make. Bot and Assistant chats are never listed or opened. Failures use fixed codes and messages, cancelled calls stop early, and no tool can answer a tool approval.

### Spoken notes

After Live sends to a chat, that chat (and the open chat) is watched for the session. When it finishes, stops with an error, waits for an approval or asks a question, Live gets a short note (at most 300 characters, title and state only, never reply text) through `liveSessionBus.note`. Notes stop when the session ends or chat access is off.

### "By voice"

Messages Live sends carry `inputSource: "voice"`, saved with the message. Desktop shows a small "By voice" label under them. It is a shared transcript contract: the Remote chat projection carries it on user messages (revision 60, `AIDEN_REMOTE_VOICE_INPUT_CONTRACT_REVISION`, fixture `voiceInput`), and iOS and Android show the same label. Older clients ignore the key. See [the Remote API](../aiden-remote-api-v1.md#voice-input-label-revision-60-provisional).

### Settings and notice

Settings → Voice & Speech → Aiden Live has a "Chats" group with **Let Live use the open chat**, on by default. The first chat tool use shows "Live can read and send to your chats. You can turn this off in Settings." once, with a Settings action, and saves `aidenLiveChatAccessNoticeShown`.

### Open items

- Re-claim the Remote revision against `main` at merge and update the iOS, Android and fixture contracts together.
- iOS and Android unit tests were written but not run in the build environment; run them before merge.
