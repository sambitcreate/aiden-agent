# Keep going until it's done

Give a chat a goal and Aiden keeps working on it in new rounds until it is done, it needs you, or a limit pauses it. You don't have to type "continue".

## Setting a goal

- Type `/goal` and what should be finished, for example `/goal Get the test suite passing and write up what changed`, and send. The objective is sent as your own message, so the first round starts at once. It can be up to 2,000 characters on one line. The slash menu lists it as **Keep going until done**.
- A chat has one goal. Setting a new one replaces the old one.
- `/goal` can be a new chat's first message: the chat is created with the objective and the goal starts with it. In a chat that is answering, finish or stop the answer first.
- Goals work in any ordinary chat on this computer, with or without a workspace folder. They are not available in Bot chats, the Assistant, agent-harness chats (such as Google Antigravity), chats hosted on a paired Mac, chats with no model chosen, or a Temporary Quick Chat until you save it or attach it to a workspace.

- `/until` followed by a check, for example `/until npm test`, sets a goal that Aiden judges by running the command instead of reading the conversation: it passes and the goal is done, or it fails and the next round gets its output. These goals stop after 5 checks ("check 2 of 5"), and Keep going grants 5 more. See [keep going until a check passes](coding-follow-through.md#keep-going-until-a-check-passes). It needs a workspace chat with folder access.

Other commands:

| Command | What it does |
| --- | --- |
| `/goal` | Shows the goal and where it stands. |
| `/goal pause` | Pauses it after the current answer. |
| `/goal resume` | Starts it again from round 1. |
| `/goal clear` | Removes it. |

## Aiden can suggest a goal

When a request in a chat you're typing in looks like longer work, Aiden can suggest a goal instead of setting one. A card above the composer shows "Keep going until:" and the objective, with **Start** and **Not now**. A suggested objective is one line of up to 300 characters with no invisible characters (such as right-to-left overrides or zero-width spaces), and the card shows all of it, so you see everything Start would send. Nothing starts until you press Start: Start sends the objective as your message and sets the goal, as if you had typed `/goal`, and Not now removes the card. Setting any goal, or deleting the chat, removes it too, and a chat shows one suggestion at a time.

Aiden can only suggest a goal in a turn you started in a chat that can have one and has no goal at work. It can't suggest one in a goal round, a follow-up or check-back answer, a scheduled task's run (including a trigger's and Run now), a phone turn, a Bot or the Assistant. Suggestions are kept in memory only, so a restart clears them. The suggestion shows in the answer's activity as **Suggest a goal**.

## The goal bar

While a chat has a goal, a bar above the composer shows it:

| State | Shows | Actions |
| --- | --- | --- |
| Working | "Working · round 3 of 50" and the objective | Pause, Clear |
| Paused by you | "Paused" | Resume, Clear |
| Paused by Aiden | "Paused" and why (for example "Not making progress") | Keep going, Clear |
| Needs you | "Needs you" and what it needs | Keep going, Clear |
| Done | "Done" and the reason | Clear |

Resume and Keep going both start again from round 1 with a fresh progress count; the limit stays 50 rounds. A round counts only once it starts: if you send a message while Aiden is checking, your message's answer is that round's work and the count stays. Taps take effect at once, and the bar's buttons wait while one change is on its way. If Aiden can't make the change, the bar goes back and says why.

## How a round works

1. After an answer in the chat ends, Aiden waits a moment and checks the chat is still idle. If you sent something in the meantime, your message goes first and the check happens after it; an answer that ends while the check is running starts the check over. Anything else that holds the chat (a scheduled task's run, a phone's message, news being saved) also goes first, and the check happens once the chat is idle again. While Aiden checks, the computer is kept awake (Settings → Scheduled tasks → **Keep this computer awake while Aiden works**), so it doesn't sleep between rounds.
2. The chat's own model reads the conversation and judges the goal: **done**, **needs you**, **paused** (your latest message asked to stop), **wait** (background jobs are still running), or **continue**. It judges on evidence in the conversation, such as command output and files read, not on claims. This check reuses the chat's cached prompt and is counted as "goal review" in usage.
3. On **continue**, a new round starts with a "Keep going · round 4 of 50" card in the chat. Rounds are ordinary answers: your approval mode applies exactly as for your own messages, and a goal never raises access. A round cannot set check-backs. A round always runs for this computer, even after a message from your phone.

### Approvals, helpers and notices in rounds

- **Approvals and questions** from a round show in the chat (and on a paired phone) like any other, and wait 30 minutes instead of an owed turn's 5, also in a round running in a window. One nobody answers is denied, the round is told, and the goal moves to **Needs you**.
- Tools that only the chat's own window can approve (image classification and image generation) are refused in rounds that run without a window; the round is told why. A round in a window can use them (see below).
- A round may run **read-only helpers** (scout, planner and reviewer, without writes, shell, mutating connectors or nesting). A helper that would change something is refused, and the round does the change itself.
- While a goal is working, news that would wake the chat (a background job ending, a pull request update) starts a goal round instead of an unattended follow-up, in a focused window showing the chat when there is one. News that arrives while Aiden is checking the goal cancels that check, and the news round is checked when it ends. These rounds don't count toward the 6 automatic wake-ups an hour; each counts as a round toward the goal's 50, and at the limit the goal pauses and the news wakes the chat as usual. An `/until` goal's news rounds use none of its 5 checks: only the check that runs after each round counts. If Aiden can't read the chat to start the round, the news is saved in the chat without waking it and the goal keeps going.
- A goal at **Needs you** shows in the Inbox's **Needs you** section with its reason, and counts toward the Dock badge, until you press Keep going or clear it.

### Rounds on screen: the browser and Computer Use

- When a round is due and a focused Aiden window shows the chat (and the screen isn't locked), the round starts in that window, as if you had sent it there. It can use everything your own message could: the browser, Computer Use, the to-do list and the approvals only the window can give. Computer Use keeps its own access card and approval mode.
- Focus is checked only when the round starts. Computer Use brings other apps to the front, so Aiden losing focus during the round is fine.
- If that window closes, reloads or switches to another chat (a new chat, a Bot, or a chat on a paired Mac) during the round, the round stops and the goal pauses with "The chat was closed". Keep going starts it again. Opening Settings or another page in that window doesn't stop the round.
- Otherwise rounds run without a window, and a call that needs one (the browser, Computer Use) is refused; the round is told why. The goal bar then says "Open this chat to let Aiden use the browser or Computer Use" with **Continue here** once the goal stops at Needs you or Aiden pauses it because of that round; pressing it starts the next round from that window. Any other stop, and Keep going, show the goal's own reason again.

## When a goal pauses on its own

- You pressed Stop, or the last answer failed. Stop also ends a check that was still judging the answer before it.
- Something went wrong between rounds, for example the chat's model is no longer set up ("The goal couldn't continue").
- Aiden restarted. Goals that were working come back paused; press Keep going to continue.
- 50 rounds ran.
- Three rounds in a row made no progress: the same reason as the round before, or a round that ran no tools and wrote little. A round that wrote a long answer without tools still counts as progress, so writing goals keep going.
- The check couldn't produce a usable answer twice in a row.
- It waited 30 minutes for background work or a helper.
- The chat reached its spending limit. **Allow more** doesn't restart the goal; Keep going does.
- The chat's folder access changed.
- The window running a round on screen closed, reloaded or switched chats.

A round's approval or question that waits 30 minutes with no answer moves the goal to **Needs you** instead.

A chat with a working goal can't be moved to another workspace; pause or clear the goal first. Deleting the chat removes its goal, and forks don't copy it.

## Notifications

When a goal finishes on its own (Done, Needs you, or paused by Aiden), Aiden shows one desktop notification, unless the chat is already open in a focused window. Clicking it opens the chat. Your own Pause or Clear doesn't notify.

## Privacy

The objective and the reviewer's reasons stay on your device. Anonymous usage data records only that a goal started (from `/goal` or `/until`) and how it ended, with the number of rounds in ranges; see [analytics](analytics.md).

## Not yet

Phones show the round cards but can't set or change goals, and don't show suggested goals.
