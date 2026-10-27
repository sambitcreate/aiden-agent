# Agent loop resilience

Status: Step 1 in review (2026-10-26). The owner chose the order, the split and each behavior below on 2026-10-26.

The agent loop sends the conversation to the model, runs the tools the model asks for, feeds the results back, and repeats until the task is done. A 2026-10-26 comparison against OpenCode, Pi's coding agent and pi-gui found five places where Aiden's loop gives up sooner than it needs to. Each step is its own pull request, in this order.

Usage limits (a rate limit, an overloaded model or a subscription window that turns a request away before any content) are not part of this plan: they wait in their own gate, from the usage-limit work. This plan covers the failures that pass on their own: a dropped connection, a server error, a timeout.

## 1. Retry failed model requests with backoff

Before: a chat retried a failed request once, after half a second, then failed the turn.

Now (desktop chats and Bots):

- A request that fails for a passing reason (Pi's `isRetryableAssistantError`) is sent again up to 5 times, waiting 2, 4, 8, 16 and 32 seconds (each capped at a minute). Errors that cannot pass (a bad key, a bad request, billing or quota) still fail at once.
- A request that timed out is tried at most 3 times in all.
- Any answer that succeeds between failures starts a fresh set of retries, so a long run is not failed by two blips an hour apart.
- The working row counts down: "Trying again in 8s (2 of 6)". Stop cancels the wait and sends nothing more.
- Bots use the same count and waits through Pi Durable's `retry` setting (Pi's own default is 3 retries), without the timeout cap; their waits survive a restart. The CLI keeps Pi's coding-agent retry settings.

Code: `main/services/model-call-retry.ts` (policy), `PiCompactionCoordinator.check` (decides each retry), `PiAgentRuntimeHarness.runManaged` (waits, reports `retry` events, caps the run), `renderer/shared/model-call-retry.ts` and `renderer/lib/agent-activity.ts` (the countdown). Phones see the reply as working; no Remote protocol change.

## 1b. A failure card with a fitting button

When a reply still fails, the red card gets one button that fits the cause: Try again (connection, timeout, server), Open Providers (sign-in, key, model, credit), Continue (output limit), Compact chat (context too long), plus a Switch model link.

## 2. Continue a cut-off reply

A reply cut off by a dropped stream or by the model's output limit keeps what was written and continues automatically, up to 2 times. Tool calls that were cut off never run (Pi's agent loop already fails them on a length stop).

## 3. Run safe tools side by side

Reads, grep, find, web fetch and MCP reads in one batch run in parallel; anything else keeps the batch sequential. Approvals are still asked one at a time before anything runs.

## 4. Resume after a relaunch (desktop)

A chat that was mid-answer when Aiden quit or crashed shows a Resume button. Aiden never resumes on its own, so a half-finished command never re-runs without the person seeing it.
