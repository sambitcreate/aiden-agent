# Google Antigravity in Aiden

Google Antigravity runs Google's own coding agent on your computer, and bills your Google account's Antigravity plan rather than per token. Aiden drives it over the Agent Client Protocol (ACP), so it appears as an ordinary provider in the model picker.

## Set up

1. Open **Settings → Providers → More → Google Antigravity**.
2. Choose **Install Google Antigravity**. The dialog states the download size and source (`dl.google.com`) before anything is downloaded.
   - Aiden verifies the download against hashes pinned in this version of Aiden. It then starts the runtime once to confirm what it is.
   - Supported computers: Apple Silicon and Intel Macs, and Linux on x64 or arm64.
3. Choose **Sign in with Google** and finish signing in in your browser.
   - If the final page does not load, paste its address into the field shown in Aiden.
4. Pick a Gemini model under **Google Antigravity** in the model picker. The thinking control chooses Antigravity's low, medium or high tier.

## What it can do in a chat

Antigravity follows the chat folder's permission setting.

| Setting | What happens |
| --- | --- |
| **Ask** | File changes, commands and web fetches wait for Aiden's approval card. "Allow for this chat" covers the rest of the conversation. |
| **Full** | Antigravity edits files and runs commands without asking. Its commands run with your account's permissions. |
| **Read-only** or **No access** | Changes and commands are refused. |

How Aiden routes its work:

- **File access:** file reads and writes go through Aiden and are limited to the chat's folder.
- **Aiden's tools:** Antigravity can also use Aiden's own tools, such as MCP servers, the browser and the task list. Those calls use Aiden's normal approvals.
- **Activity:** what Antigravity does appears as ordinary activity rows (read, edit, command, search) in the response.
- **Questions:** its questions appear as Aiden's question prompt.

Antigravity keeps its own conversation memory.

- **Rewinding or editing:** if you rewind, edit a message, or fork the chat, Aiden starts a fresh Antigravity session with a summary of the conversation. A "Started a fresh agent session" row marks when this happens.
- **Restarts:** after a restart, Aiden resumes the previous session.

Antigravity is available only in chats open on this computer. It is not available for Bots, scheduled tasks, Aiden Live, Telegram, subagents, or responses started from the iOS or Android app.

## Privacy and network

- **Credentials:** they stay in a private Antigravity profile inside Aiden's app data. Aiden never reads or changes `~/.gemini`.
- **No background network:** Aiden contacts the network for Antigravity only when you install it, sign in, refresh models, or chat with it. There are no background update checks; a new runtime version arrives with a new Aiden release.
- **Sign out:** this removes Antigravity's credentials.
- **Remove runtime:** this deletes the downloaded files; your sign-in and chats are kept.

To hide the provider entirely, start Aiden with `AIDEN_DISABLE_ANTIGRAVITY=1`.
