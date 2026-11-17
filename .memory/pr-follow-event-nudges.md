# Followed pull requests react to events (W9) — 2026-11-11

Branch `claude/pr-follow-event-nudges`. It is adapted from T3 Code PR #33548. Only the upstream clone was read; none of its code was run. Phase A is implemented here; phase B is a spike and stays unimplemented.

## Phase A: what shipped

**Nudges.** `PullRequestFollows.nudge(chatId, kind, which?)` and `nudgeAll(kind)` ask for a sooner look.

- Nudges are debounced 5 s from the last one and capped at 30 s from the first, per follow. One timer covers the soonest nudge and runs the normal `kick()`, so a nudge never adds a second loop.
- There are two kinds:
  - "action": the agent's `run_command` matched `commandMayChangePullRequest`, a desktop Git panel push or a phone push to the same `host/owner/name`, or opening the Following list. It waits at least 30 s after the last look.
  - "ambient": window focus, `powerMonitor` resume or unlock, or the renderer's `online` event. It waits at least the settled 5 min after the last look, so it is never faster than before.
- Every nudge still waits out `holdUntil` (rate limit or failed read).
- Nothing is read for a stopped, ended or deleted follow, after shutdown, or while the chat is paused.
- A nudge that arrives during that follow's own read survives the read and gets exactly one more read.

**Probes.** Before the GraphQL read, `PullRequestFollowReader.read(…, probe)` sends conditional REST requests with the stored ETags:

- the pull request;
- when the head sha is known, the head's `check-runs?per_page=100&filter=latest` and `status`.

All three answering 304, with `skipIfUnchanged` set, returns `{kind:"unchanged"}`, and `poll` then only stamps `lastCheckedAt` and bumps `quietReads`. A rate limit on a probe returns retry, and the follow is held as before.

**Backoff.** `followPollDelay`:

- 2 min while checks are pending;
- otherwise 5, 10, 20, then 30 min max for consecutive quiet looks;
- any change resets it to 5 min.

A forced full read (probedUnchanged) keeps backing off.

**Assumptions the plan got wrong or left open.**

- The PR object's ETag ignores check status, which is why the check-runs and status probes exist.
- It is unverified whether submitting a review changes the PR ETag. `FOLLOW_FULL_READ_MS` (30 min) bounds that gap with a full read.
- No probe is sent while a check is failing, because the failing-for-an-hour clock needs real reads.
- There is no in-app PR comment tool. Agent comments go through `gh` in `run_command`, so they are matched by command text.

**No new hosts, credentials or analytics.** The probes use the same `GitHubApi` and `gh` credential path.

## Phase B: GitHub App webhooks (spike notes, not built)

Upstream design (T3 Code #33548):

- A GitHub App subscription: POST an event subscription for `review.submitted`, `head.changed`, `state.changed` and `merge_conflict`, then read an SSE `events_url` (api.github.com only).
- Heartbeats arrive every 15 s or less, and 45 s of silence counts as dead.
- A `github.stream.end` frame means reconnect or renew. A connection counts as healthy after 2 min.
- Reconnect backoff is capped at 60 s, and the stream is given up after 6 failures.
- A 403 pauses the host for 1 h, a 422 for 10 min, and a 404 pauses that PR.
- An app installation token is tried first, then the user's token.
- The subscription is DELETEd when the follow ends.
- Events only coalesce into reads (a capacity-1 buffer); the timed sweep stays the fallback.

Before Aiden could adopt it:

- It needs a GitHub App and a long-lived streaming connection. That means a new background network posture, which is an AGENTS.md change and an owner decision.
- It does not work on GitHub Enterprise hosts.
- The event endpoint's availability and auth need checking against current GitHub docs.

If adopted, an event should only call `nudge(chatId, "action", which)`. Phase A's debounce, hold and backoff then apply unchanged.
