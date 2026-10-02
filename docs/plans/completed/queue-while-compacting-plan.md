# Queue Messages While Compaction Runs

Status: Complete (desktop first slice) — merged in [PR #272](https://github.com/sambitcreate/aiden-agent/pull/272) on 2026-09-30; on main after 0.51.0, not yet released.

## Problem

A manual `/compact` (LLM or pi-vcc) made the desktop composer read-only until
compaction settled. On long chats that can take tens of seconds, and the user
could not type or line up follow-ups. Compaction that runs inside a generation
(`compact_context`) already accepted Queue/Steer/Redirect through the busy
composer, so only the standalone command was a dead end.

## Behavior

- While a manual compaction runs in a chat that supports the queue, the
  composer stays editable. Enter and the send button queue the message. The
  send button becomes **Queue message**, the status line says messages wait
  until compaction finishes, and the queue header reads
  `N queued · Sends after compaction`.
- `/compact` is consumed as soon as its asynchronous action starts, leaving a
  clear composer for follow-up text while compaction runs. Other slash session
  actions stay blocked. Synchronous admission allows only one compaction at a
  time, including same-tick activations and attempts after a composer remount.
  Attachments and voice input work during compaction.
  Export, clone, fork, logout and worktree creation still keep the composer
  read-only.
- The per-chat `ChatMessageQueue` owns a `holdReason: "compaction"` flag. A
  held queue never claims a message, and a delivery that was already waiting
  on `chats:waitUntilIdle` defers when a hold appears. The flag lives in the
  queue rather than pane state, so the hold stays in place when the user
  navigates away from the chat and back. The composer reads the queue's hold
  snapshot on mount so its Queue message state, compaction status and Cancel
  action also survive that navigation.
- On a completed compaction (`compacted: true`), or when compaction was
  unnecessary (`already_compact`) or never admitted (`busy`), the hold lifts
  and queued messages deliver in order through the existing
  `deliverQueuedMessage` path.
- On a failed, cancelled, or unavailable-provider compaction, or an IPC error,
  every queued message is kept and the queue is **paused**. The header shows
  `· Paused`, a toast explains that compaction didn't finish, and **Resume
  queue** sends the messages in order. Aiden never sends them automatically
  into the uncompacted context.

## Relationship to open PRs

- #182 (composer unblock during detached drain) parks sends in the same queue
  while a route-detached generation drains. This slice gates on a separate
  queue hold, not the drain predicate, so the two compose without overlap.
- #220 (active-run input admission) adds run-input identity and
  `uncertainIds` to the same queue. This slice adds only `holdReason` and the
  hold/release methods and does not alter settle/claimForRun semantics. A
  merge needs a small union in `claim()` and the queue header.

## Surfaces

- Desktop renderer: `renderer/lib/chat-message-queue.ts`,
  `renderer/components/composer.tsx`, `renderer/components/queued-messages.tsx`,
  `renderer/main/chat-pane.tsx`.
- Aiden Remote / iOS / Android: unchanged. Remote exposes no manual compaction
  command, and the desktop queue is document-local. Native clients already use
  the server-owned run-input queue for active runs, and those runs' in-run
  compaction does not end the run.

## Follow-ups

- Compaction started from Telegram or another document is invisible to this
  renderer's queue. Queued delivery in that window waits for the bounded
  `waitUntilIdle` grace and then pauses with the existing "still saving"
  message. A host-published per-chat compaction state would let every surface
  hold instead.
- If the host exposes a manual compaction command over Remote, native
  composers should adopt the same hold/pause semantics.
