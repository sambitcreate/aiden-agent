# Agent loop resilience

Status: Steps 1, 1b and 2 in review (2026-10-26). The owner chose the order, the split and each behavior below on 2026-10-26.

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

When a reply still fails, the red card on the latest reply gets one button that fits the cause, plus Switch model (which opens the model list in the command palette):

| Cause (`ProviderFailureV1.category`) | Button | What it does |
| --- | --- | --- |
| network, timeout, service unavailable, rate limit, interrupted, unknown | Try again | Sends a visible "Try that again." turn |
| authentication, quota, invalid request | Open Providers | Opens Settings → Providers |
| output limit | Continue | Sends a visible "Continue from where you stopped." turn |
| context window, context management | Compact and try again | Compacts the chat, then sends "Try that again." if it compacted |

Older failure cards keep their text but show no buttons, and the buttons wait while one action runs. Desktop only; the phones keep their current failure card.

Code: `providerFailureAction` in `renderer/shared/provider-failure.ts`, `ProviderFailureCallout` in `renderer/components/message-list.tsx`, `runFailureAction` in `renderer/main/chat-pane.tsx`.

## 2. Continue a cut-off reply

Before: a reply that hit the model's output limit ended with the red card, and a stream that dropped mid-answer threw away what it had written and asked again from the start.

Now (desktop chats):

- A reply that stops at the output limit after writing text keeps that text, and Aiden asks the model, in a hidden host message, to continue exactly where it stopped. The continuation joins the text directly, so the reply reads as one answer.
- A stream that drops after the reply started (a retryable error from step 1) keeps the text it wrote, waits like any retry ("Trying again in 2s"), then asks the model to continue. The kept text stays on screen through the wait. A failure before any text still retries from the start.
- Each reply continues at most 2 times. After that it ends the way it did before: the output-limit card with its Continue button, or a plain retry.
- Tool calls that were cut off never run. Pi's agent loop fails them on a length stop, and a dropped stream keeps only its text (its thinking and partial tool calls are left out).
- The kept text and the continue request go into the chat's Pi journal, so later turns replay what the person saw. A kept reply does not count as a success that starts a fresh set of retries.
- A retry that does start over now drops only the failed step's text; earlier steps of the same reply stay visible, as they stay in the model's context.

Bots, subagents and the CLI keep their current behavior.

Code: `main/services/cut-off-reply.ts` (what is kept and the continue request), `PiAgentRuntimeHarness.runManaged` (`maxCutOffContinuations`, `onContinue`, `keepsPartial` on retries), `llm-client.ts` (joins the continuation without a paragraph break). Tests: the harness suite and `tests/e2e/cut-off-reply.spec.ts`, using the fixture hook `cutOffCompletions`.

## 3. Run safe tools side by side

Reads, grep, find, web fetch and MCP reads in one batch run in parallel; anything else keeps the batch sequential. Approvals are still asked one at a time before anything runs.

## 4. Resume after a relaunch (desktop)

A chat that was mid-answer when Aiden quit or crashed shows a Resume button. Aiden never resumes on its own, so a half-finished command never re-runs without the person seeing it.
