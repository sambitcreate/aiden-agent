# Bot wake sources

Status: In progress (2026-10-28). Stacked PRs on top of [PR #633](https://github.com/sambitcreate/aiden-agent/pull/633) (desktop Bot sends never say "Sending…").

## Why

Asked "what are the ways you can wake yourself up?", a Bot (COS) answered that it can only propose time-based routines, one pending card at a time, never on events, and that "check back in 5 minutes" needs a full routine. After Bot autonomy (PR #627), part of that is stale: up to 2 cards can be pending, and file-change and link (webhook) event routines exist. But the Bot cannot see or propose event routines, every wake spends a full model turn, and there is no short self wake-up and nothing more frequent than daily.

The owner decided on 2026-10-28 that a Bot **may set bounded self wake-ups without an approval card**.

## Reference: Hermes

Read from `NousResearch/hermes-agent` on 2026-10-28 (product reference, no copied code). The ideas taken:

- An agent-created one-shot delay (`cronjob` with `30m`). Jobs created from a cron run cannot schedule more jobs unless configured (loop prevention), and the agent cannot pick the model for unattended runs.
- **Cheap checks before the model** (`cron/monitor.py`): a script or bounded URL GET runs first. Its output is hashed, and an unchanged hash ends the tick with no model call and no delivery. A changed hash passes a diff plus the new output to the agent. The new hash is saved before the agent runs, so a failed run does not re-alert. A source failure is an error, never a change.
- A noisy watcher is backed off and then switched off, with one summary instead of a stream.
- Wake events wait until the session is idle and coalesce instead of stacking. `[SILENT]` ends a wake without notifying anyone.

## Steps (one PR each, stacked)

1. **The Bot sees every wake source** (`feature/bot-wake-sources`).
   - The `routines` tool `list` also returns this Bot's event routines.
   - `propose` accepts a `trigger` (`webhook`, `file_change`) as an alternative to `schedule`, so the person accepts an event routine from the same card.
   - A new `revise` action replaces a pending card's content instead of stacking a new one.
   - The card shows the timezone a schedule runs in.
   - The tool description and the Bot system prompt list every way a Bot can be woken.
   - Phones render the new card shape (Remote revision claimed at merge).
2. **Self wake-ups** (`feature/bot-self-wake`).
   - A `wake_up` tool (`set`, `list`, `cancel`): a one-time wake in the same Bot chat, 1 minute to 24 hours ahead, at most 3 pending per Bot, with no approval card.
   - Offered only in turns the person started. A routine, event or wake-up run cannot set one, which keeps Hermes-style loop prevention; repeated checking belongs to step 3.
   - Fires go through the existing one-time routine claim, recovery and delivery funnel, so quiet hours, the daily limit, pause and `[SILENT]` apply.
   - The person sees each pending wake-up (with Cancel) in the chat and the Bot's routines, and can switch the tool off per Bot.
3. **Watch routines** (`feature/bot-watch-routines`).
   - A `watch` event trigger: a bounded HTTPS GET or a script in the Bot's folder, checked every N minutes (at least 5).
   - The output is hashed, and the Bot is woken only when it changes, with a bounded diff as the event payload. The first check records a baseline.
   - The hash is saved before the run. A failed check counts as a failure, never a change, and repeated failures raise a Bot issue and pause the watch.
   - Watches go through the event dispatcher's limits (5-minute gap, 24 a day), and the Bot proposes them with step 1's card.
   - Use cases: CI status (`gh run list …`), a status page, an inbox count.
   - Built (2026-10-28): `main/services/bot-routine-events/watch.ts` (scheduler, hash, diff) and `watch-sources.ts` (URL and script checks), with the state kept in `event-routines.json`. Redirects are not followed: a 3xx is a failed check that asks for the final address. The event id is the hash plus the check time, so a status that flips back is a new event. Three failures turn the watch off (`enabled: false`) with one `routine_paused` issue.

## Follow-ups (not in this stack)

- Wake when a background shell job finishes (Hermes `notify_on_complete`).
- Email and calendar watches (Bot autonomy D2 spike), likely as watch sources.
- Keeping the Mac awake shortly before a due routine.
- Remote/phone management of event and watch routines.
