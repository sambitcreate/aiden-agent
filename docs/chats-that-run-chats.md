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
| `start` | Starts up to 20 chats per call, each `{title, task}`, in the lead's workspace or a new worktree of it (see below). The task is the chat's first message, after a line naming the lead. |
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
  `child_chats`. A chat whose record can't be read isn't offered it either, nor
  is a turn an outside MCP app sent, so an app can't start chats past its own
  limits.
- **No double starts.** Each start is keyed by the tool call's id
  (`agent-chat:<digest of lead and tool call>:<index>`), and the tool is
  declared never-replay, so a repeated call finds the chats it already started
  instead of starting more. If Aiden quits in the middle of a start, the
  recovery note the lead reads on its next turn (Resume) names each chat that
  call already made, and whether its task was sent, so the model follows them
  with `list` or `wait` instead of starting them again; `list` shows them too.
- **Approvals a started chat waits on** reach the lead with their summary
  fenced as data, and a tool name that isn't a plain name reads "a tool".

## New worktrees

`workspace: "new_worktree"` runs a started chat in a new managed worktree, so
parallel edits don't collide. It goes through the same first-message worktree
coordinator as a phone's New worktree, keyed by the start
(`agent-chat:<digest of lead and tool call>:<index>:worktree`), so a replay
finds the worktree instead of making another. The base is the repository's
default branch unless `base_ref` names a local or remote-tracking branch, and
the branch is named from the chat's title unless `branch_name` gives one. If
a later step of a start fails, the chat (and its worktree) are removed again,
and a worktree made for a chat that then can't move into it (it was deleted,
moved or written in meanwhile) is removed at once, never by force. A lead that is
itself in a managed worktree stacks: the new worktree is made from the
workspace it came from, starting at the lead's branch. Every refusal is a
fixed sentence (an unknown or invalid branch, no free disk space, the source
workspace gone), reported for that chat while the others still start. The
ceiling still comes from the lead.

## Structured results

A start can give each chat a `result_schema`: a JSON Schema of at most 16 KB
whose `$ref`s may only be `#`, `#/$defs/<name>` or `#/definitions/<name>`
(nothing is ever fetched, and no pointer into `default`, `enum`, `const`,
`examples` or another keyword), and that may not contain a regular expression
anywhere, since a crafted one could stall Aiden: no key named `pattern` or
`patternProperties` at any depth, including inside data keywords, `$defs` and
`propertyNames`, so a property literally named `pattern` is refused too. A
schema that is too large, refers anywhere else, contains such a key or doesn't
compile refuses the whole call before any chat is made, and a stored one that
breaks these rules is dropped when the links load. The started chat's first
message shows the schema, and it gets a `submit_result` tool. A submitted
result is checked with ajv; one that doesn't match is refused, naming the
fields to fix (for example `/filesChanged is required`). The newest accepted
result (up to 64 KB) replaces any earlier one, is stored on the link, comes
back from `wait` and `list` as `result`, and is quoted, fenced as data, in the
lead's completion notice (cut at 4,000 characters there). Only the newest 64
links keep their schema and result; older ones drop them to keep the links
file small. A send to a chat that owes a result is always
queued, never steered, so it can finish its turn. `submit_result` never asks
for approval.

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
  Each turn also narrows the stored ceiling by what the lead's workspace allows
  now, so switching the lead to Ask, or taking back a grant there, reaches its
  started chats on their next turn. If the link is lost (a damaged file), the
  chat runs under Ask with no Mac grants.
- **Outside content travels with the lead's words.** When the lead's own run
  holds outside content (a web page, a connector's data, a started chat's
  reply) as it starts a chat or sends to one, the link is marked. That chat's
  runs start tainted, and while it still answers the lead the Auto judge can't
  pass a call on the lead's word: judged calls show their card. A steer or
  queued message into a running turn does the same from then on. Sites the
  lead named there don't count as sites you named, so a fetch to one is still
  a new destination the gate asks about or judges. Once you write in the chat,
  the requests are yours again, though its runs stay tainted.
- **Only your own words name sites.** A notice is never counted as yours, in
  any chat: a **Started chat** notice (which quotes the started chat's reply),
  a scheduled task's, a check or check-back's, a goal round's, or a job or pull
  request's. A site that appears only in a notice is still a new destination.
  The sites you named are read from the chat when a run starts; a site you
  name in a steer during a run counts from the next run, so until then a
  fetch to it still asks or is judged.
- A started chat's approvals and questions come to you like a phone's: the
  desktop card, Inbox Needs you and paired phones. They wait up to 30 minutes,
  not the usual 5.

## When a started chat finishes

When a turn the lead started in a chat ends (finished, stopped, failed or
interrupted), the lead gets a **Started chat** notice card with the chat's
last reply fenced as data (up to 4,000 characters; `child_chats read` has the
rest). Like other follow-up notices it is queued into a running lead, or wakes
an idle one within the chat's budget of six unattended follow-up answers an
hour; past that it is only recorded. Chats that end within 10 seconds of each
other share one notice ("2 started chats ended").

- A chat waiting for your approval or answer hasn't ended, so it never wakes
  the lead.
- A turn the lead already got back from `wait`, or stopped itself, isn't
  told again.
- A woken lead can list, read, wait, send and stop, but not start more chats.

## Stop

Stop in the lead (on the desktop or a phone) stops its turn and the running
turn of every chat it started, except chats you've written in. Until you next
send in the lead, its started chats' endings are only recorded and don't wake
it. Stop in a started chat stops only that chat.

## On the desktop

- **The lead's chip.** A lead chat's composer shows a chip with how many of its
  started chats are working ("3 chats working"), or how many it started once
  none is ("3 started chats"). It names any that need you. Its list shows each
  chat's title and state (Working, Needs your approval, Needs your answer,
  Done, Stopped, Interrupted, Stopped with an error, or Yours now after you
  write in it) and the branch of a chat in its own worktree. **Open** goes to
  the chat; **Stop** stops one; **Stop all** works like Stop in the lead, so
  endings don't wake it until you next send there. A chat you stop from the
  list never wakes the lead either.
- **Lineage.** A started chat's header says "Started by “Release prep”", and
  the title links back to the lead; its sidebar row carries a small chat glyph
  with the same text for screen readers. If the lead was deleted, it reads
  "Started by a deleted chat". When a chat somehow carries both a lead and an
  outside app's "Started by \<app>", the lead wins.
- **Messages.** Messages the lead sent there, its steers and queued messages
  included, show "From “Release prep”" under them. The marker is stored on the message (`fromLeadChat`) and is display
  only: phones don't receive it yet.
- **Onboarding.** The feature tour has a **Chats that run chats** tile on macOS
  and Linux.

## When you write in a started chat

Once you send a message in a started chat after the lead's last message
(including a steer or queued message into its running turn, from the desktop
composer or a phone), the chat is yours: the lead's `send` refuses, its Stop leaves the chat alone, and
`list` and `wait` mark it `tookOver`. The lead can still read it, and turns you
start there never notify the lead.

## How it runs

Started chats run through the same Remote chat and stream services a paired
phone uses, under an internal audience `chat:<leadChatId>`. That audience has
no device record, can't be reached over HTTP, and sends no device analytics.
Workspace permissions, model resolution, spending limits and idempotency
behave as they do for a phone turn.

Links live in `chat-orchestration.json` in Aiden's user data folder (mode
0600): each started chat's lead, title, ceiling, the person-took-over marker,
whether a tainted lead wrote in it, an owed notice and which finished turns the lead has already been told about. Deleting a
started chat drops its link; deleting a lead drops its started chats' links,
and those chats keep running under the lost-link ceiling.

After a quit, endings that were still waiting to be told (inside the
10-second group, before an idle lead woke, or after a notice failed because
the lead stayed busy or an error) are posted at the next start as one notice
per lead that is recorded without waking it; a lead whose group is already
gathering takes them into that notice instead, and an ending the lead's
`wait` returned meanwhile isn't posted. Only a lead that is gone ends what is
owed without telling it. Started chats'
interrupted turns show Resume in their own chats.
