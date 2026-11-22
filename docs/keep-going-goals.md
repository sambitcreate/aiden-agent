# Keep going until it's done

Give a chat a goal and Aiden keeps working on it in new rounds until it is done, it needs you, or a limit pauses it. You don't have to type "continue".

## Setting a goal

- Type `/goal` and what should be finished, for example `/goal Get the test suite passing and write up what changed`, and send. The objective is sent as your own message, so the first round starts at once. It can be up to 2,000 characters on one line. The slash menu lists it as **Keep going until done**.
- A chat has one goal. Setting a new one replaces the old one.
- `/goal` can be a new chat's first message: the chat is created with the objective and the goal starts with it. In a chat that is answering, finish or stop the answer first.
- Goals work in any ordinary chat on this computer, with or without a workspace folder. They are not available in Bot chats, the Assistant, agent-harness chats (such as Google Antigravity), chats hosted on a paired Mac, or chats with no model chosen.

- `/until` followed by a check, for example `/until npm test`, sets a goal that Aiden judges by running the command instead of reading the conversation: it passes and the goal is done, or it fails and the next round gets its output. These goals stop after 5 checks ("check 2 of 5"), and Keep going grants 5 more. See [keep going until a check passes](coding-follow-through.md#keep-going-until-a-check-passes). It needs a workspace chat with folder access.

Other commands:

| Command | What it does |
| --- | --- |
| `/goal` | Shows the goal and where it stands. |
| `/goal pause` | Pauses it after the current answer. |
| `/goal resume` | Starts it again from round 1. |
| `/goal clear` | Removes it. |

## The goal bar

While a chat has a goal, a bar above the composer shows it:

| State | Shows | Actions |
| --- | --- | --- |
| Working | "Working · round 3 of 50" and the objective | Pause, Clear |
| Paused by you | "Paused" | Resume, Clear |
| Paused by Aiden | "Paused" and why (for example "Not making progress") | Keep going, Clear |
| Needs you | "Needs you" and what it needs | Keep going, Clear |
| Done | "Done" and the reason | Clear |

Resume and Keep going both start again from round 1 with a fresh progress count; the limit stays 50 rounds. Taps take effect at once. If Aiden can't make the change, the bar goes back and says why.

## How a round works

1. After an answer in the chat ends, Aiden waits a moment and checks the chat is still idle. If you sent something in the meantime, your message goes first and the check happens after it.
2. The chat's own model reads the conversation and judges the goal: **done**, **needs you**, **paused** (your latest message asked to stop), **wait** (background jobs are still running), or **continue**. It judges on evidence in the conversation, such as command output and files read, not on claims. This check reuses the chat's cached prompt and is counted as "goal review" in usage.
3. On **continue**, a new round starts with a "Keep going · round 4 of 50" card in the chat. Rounds are ordinary answers: your approval mode applies exactly as for your own messages, and a goal never raises access. A round cannot set check-backs.

### Approvals, helpers and notices in rounds

- **Approvals and questions** from a round show in the chat (and on a paired phone) like any other, and wait 30 minutes instead of an owed turn's 5. One nobody answers is denied, the round is told, and the goal moves to **Needs you**.
- Tools that only the chat's own window can approve (image classification and image generation) are refused in rounds that run without a window; the round is told why.
- A round may run **read-only helpers** (scout, planner and reviewer, without writes, shell, mutating connectors or nesting). A helper that would change something is refused, and the round does the change itself.
- While a goal is working, news that would wake the chat (a background job ending, a pull request update) starts a goal round instead of an unattended follow-up. These rounds don't count toward the 6 automatic wake-ups an hour, and the goal's own limits apply.
- A goal at **Needs you** shows in the Inbox's **Needs you** section with its reason, and counts toward the Dock badge, until you press Keep going or clear it.

## When a goal pauses on its own

- You pressed Stop, or the last answer failed.
- Aiden restarted. Goals that were working come back paused; press Keep going to continue.
- 50 rounds ran.
- Three rounds in a row made no progress: the same reason as the round before, or a round that ran no tools and wrote little. A round that wrote a long answer without tools still counts as progress, so writing goals keep going.
- The check couldn't produce a usable answer twice in a row.
- It waited 30 minutes for background work or a helper.
- The chat reached its spending limit. **Allow more** doesn't restart the goal; Keep going does.
- The chat's folder access changed.

A round's approval or question that waits 30 minutes with no answer moves the goal to **Needs you** instead.

A chat with a working goal can't be moved to another workspace; pause or clear the goal first. Deleting the chat removes its goal, and forks don't copy it.

## Notifications

When a goal finishes on its own (Done, Needs you, or paused by Aiden), Aiden shows one desktop notification, unless the chat is already open in a focused window. Clicking it opens the chat. Your own Pause or Clear doesn't notify.

## Privacy

The objective and the reviewer's reasons stay on your device. Anonymous usage data records only that a goal started (from `/goal` or `/until`) and how it ended, with the number of rounds in ranges; see [analytics](analytics.md).

## Not yet

Phones show the round cards but can't set or change goals. Rounds run without a window, so browser, Computer Use and other window-only tools are refused in rounds.
