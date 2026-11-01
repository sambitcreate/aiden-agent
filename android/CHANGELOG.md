# Changelog

Aiden On The Go for Android. Earlier Android changes are recorded in the pull requests and plans under `docs/plans/`.

## Unreleased

- **Inbox (Beta).** The sidebar's organization menu gains **Inbox (Beta)** beside Workspaces and Recents, remembered on this phone. Chats are grouped into **Needs you** (an approval, a question, or a failed run you haven't seen), **Pinned**, **Updates** (unread replies), **Earlier** (the last seven days, the newest 20 with the rest behind **Show more**) and a **Working** shelf, in compact rows that show the workspace, the status and how long it has waited. The Mac or `aiden serve` host sorts each chat; this phone keeps the chat it has open out of Updates, wakes a snooze on its own clock and ages out old chats, and sorts the chats of an older host itself with the desktop's rules. Swipe right to **Mark read** (when the host shares read state) and left for **Done** or **Snooze** (1 hour, this evening, tomorrow, next week) when the host offers triage to phones. Each change shows at once with Undo in a snackbar, and is put back with a message if the host refuses it. TalkBack offers the same actions on each row. Workspaces and Recents now list chats by recency, as on the Mac, instead of putting chats that need you first.
- The Working indicator on chat rows is now the desktop's open ring turning once every 1.5 seconds, instead of a breathing dot, and it holds still when Reduce Motion is on.
