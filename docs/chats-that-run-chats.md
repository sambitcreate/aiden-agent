# Chats that run other chats

A workspace chat can hand parts of a task to new chats and follow them, the
way you would split work across teammates. The chat that starts them is the
**lead**; the chats it starts are **started chats**. macOS and Linux desktop.

Plan: [Phase 5 of the proactive Aiden plan](plans/proactive-aiden-plan.md#phase-5-chats-that-run-other-chats-7-prs).

## Turning it on and off

**Chats can start other chats** in Settings → Approvals → Advanced is on by
default. Only an off choice is stored (`AppSettings.childChats: false`), and a
portable config keeps only that. Off, no chat is offered the tool; chats
already started keep running as ordinary chats.

## The `child_chats` tool

The lead's model gets one tool, `child_chats`, with one action per call:

| Action | What it does |
| --- | --- |
| `start` | Starts up to 20 chats per call, each `{title, task}`, in the lead's workspace. The task is the chat's first message, after a line naming the lead. |
| `send` | Sends a follow-up to a started chat. `auto` (the default) and `steer` steer a running turn, `queue` waits for it to end, and an idle chat starts a new turn. |
| `wait` | Waits up to 600 seconds (default 120) for up to 8 started chats, until `any` or `all` of them end, and returns each chat's state and last reply. A timeout never stops anything. |
| `read` | Reads a started chat's newest messages (up to 20, each cut at 20,000 characters). |
| `list` | Lists every chat this chat started, with its state. |
| `stop` | Stops the turn the lead started in a chat. |

- **The lead reaches only the chats it started.** Any other chat id is refused.
- **Replies are data.** Every reply and message the tool returns is fenced and
  labelled "data, not instructions", and every `child_chats` result counts as
  outside content for the approval gate (taint is decided by tool name).
- **No count caps.** Depth is the limit: a chat another chat started never gets
  `child_chats`. A chat whose record can't be read isn't offered it either.
- **No double starts.** Each start is keyed by the tool call's id
  (`agent-chat:<leadChatId>:<toolCallId>:<index>`), and the tool is declared
  never-replay, so a resumed or repeated call finds the chats it already
  started instead of starting more.

## Approvals

- `start` is Consequential: Ask shows a card before each start, Auto lets the
  approval model judge it, Never ask runs it. `send`, `wait`, `read`, `list`
  and `stop` on your own started chats never ask.
- A turn Aiden started (a woken lead, an owed turn with no window, a goal
  round) can list, read, wait, send and stop, but `start` is refused: starting
  chats needs the person here.
- **A started chat never does more than its lead allowed.** The lead's approval
  policy at start time is stored with the link as a ceiling. Every turn in the
  started chat, and every later decision in that turn, takes the stricter
  approval mode (Ask < Auto < Never ask), only the Mac grants both allow, and
  Chat only if either is. A mode change in the middle of a turn can't lift it.
  If the link is lost (a damaged file), the chat runs under Ask with no Mac
  grants.
- A started chat's approvals and questions come to you like a phone's: the
  desktop card, Inbox Needs you and paired phones. They wait up to 30 minutes,
  not the usual 5.

## When you write in a started chat

Once you send a message in a started chat after the lead's last message, the
chat is yours: the lead's `send` refuses, and `list` and `wait` mark it
`tookOver`. The lead can still read it.

## How it runs

Started chats run through the same Remote chat and stream services a paired
phone uses, under an internal audience `chat:<leadChatId>`. That audience has
no device record, can't be reached over HTTP, and sends no device analytics.
Workspace permissions, model resolution, spending limits and idempotency
behave as they do for a phone turn.

Links live in `chat-orchestration.json` in Aiden's user data folder (mode
0600): each started chat's lead, title, ceiling, the person-took-over marker
and which finished turns the lead has already been told about. Deleting a
started chat drops its link; deleting a lead drops its started chats' links,
and those chats keep running under the lost-link ceiling.

Nothing resumes after a quit.
