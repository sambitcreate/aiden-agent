# Usage limits and spending limits

Aiden handles two kinds of limits on the Mac and Linux desktop app: the ones a provider sets (rate limits and plan windows), and the dollar limits the owner sets. Both live in **Settings → Context & Limits**. Nothing about either leaves the computer. The two settings travel with Aiden's portable settings like other preferences; the saved waits and the spending ledger stay on this computer only.

The CLI does not wait for provider usage limits. Its Bot runner records paid response costs in the profile-local `spending.json` and enforces the monthly Bot and routine-run limits configured in the profile's `aiden.json`. It uses the same API-key versus subscription classification as desktop. The CLI has no Context & Limits editor or temporary spending-allowance controls.

## Waiting out a provider's usage limit

When a provider turns a request away **before any reply has streamed** because of a rate limit, an overload or a plan's usage window, Aiden waits for the limit to clear and sends the same request again. The request keeps its model, context and options: Aiden never switches to another model or provider to get around a limit. A rejected request costs nothing, so a wait never counts toward a spending limit.

Once any content has streamed, a failure goes through as it did before, so nothing the person already saw is replayed.

### What waits

Workspace chats, Bot chats, Bot routines, Telegram replies from a Bot and the helpers (subagents) a chat starts all wait. Background chores, such as a Bot's memory tidy-up, never wait: they fail as they did before.

### How long

**Longest wait for a usage limit** offers Don't wait, 1, 6 (the default), 12 and 24 hours. When the next try would land past that, Aiden stops waiting and the reply fails with the reset time in its message. The longest wait counts from when the limit was first hit, and it applies to requests that join a limit another reply (or an earlier run of Aiden) already holds. Changing the setting applies at once: a shorter wait ends waits now past it, and Don't wait sends the waiting requests straight away.

- **The provider gave a time.** Aiden reads `retry-after` / `retry-after-ms`, the `x-ratelimit-*`, `ratelimit-*` and `anthropic-ratelimit-*` reset headers, the Codex `x-codex-primary-*` / `x-codex-secondary-*` windows, and reset times written in the error text. It tries again at that time. No wait is shorter than 5 seconds.
- **No time given.** It backs off: 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min, for at most 30 minutes in total.
- **A plan's usage limit with no time** (for example "You've reached your usage limit" with no reset) is tried about every 15 minutes, up to the longest wait.
- **Limits that are days away are not waited for.** A window longer than 5 hours (a weekly limit, for example) and billing or credit problems fail at once. The message names the reset time when the provider gave one.

Only the rate-limit headers listed above are kept from a response; nothing else is read. Google's adapters do not expose response headers, so for Gemini Aiden relies on the error text.

### One test request, then the rest

A limit can cover one model (a 429 or an overload) or the whole sign-in or key (a plan window, which every model of that provider shares). While a limit is active, every request it covers waits behind it. At the try time **one** request goes out as a test. If it gets through, the others go one at a time, oldest first, so a queue of waiting chats and routines does not trip the limit again. If the test is turned away, everyone waits for the new time.

### Retry now, restarts and giving up

- The chat shows a **"Waiting for <provider>'s usage limit · next try at 3:40 PM"** row, and a Bot's chat a "Waiting for <provider>'s usage limit" card, each with **Retry now**. Retry now sends the test request at once, at most once every 30 seconds per limit. Stop still stops the reply.
- Waits are saved in `userData/usage-limits.json` (provider ids, model ids and times only), so a reply that was waiting when Aiden quit or the Mac restarted still knows when to try again. Entries older than 25 hours are dropped.
- Aiden sends a notification only when it **gives up** on a wait, not when a wait starts. After a give-up, new requests on that limit fail at once with "<provider> is still at its usage limit, and Aiden stopped waiting for it a few minutes ago." for 5 minutes, or until the reset time.

### Automatic retries

A workspace chat retries a failed request up to five times, waiting 2 to 32 seconds (see the [agent loop resilience plan](plans/agent-loop-resilience-plan.md)), and a Bot does the same through Pi Durable's retry setting. Aiden's wait sits underneath those retries, in the stream function, so a usage limit is waited out before they see it.

- A chat never retries a usage limit Aiden gave up on, one that outlasts the longest wait, or one turned away by the give-up rule above. The error carries a marker the chat's retry check reads, so the reply fails once with the reset time instead of showing "Trying again".
- A Bot's stuck-run watchdog does not count a usage-limit wait against a run: it neither stops a routine nor asks "Still working?" while the request is held back. The test request that goes out when the limit clears counts as usual, so a hung one is still caught.
- A Bot's retries are Pi Durable's own and do not read the marker. The give-up rule refuses each of them at once without sending, so the run still ends promptly.
- A plain server error (a 503 or 408 with no reset time and no rate-limit or overload wording) is not a usage limit. It goes straight to those retries, so it shows "Trying again" rather than a wait.
- With waiting off (**Don't wait**), a usage limit is an ordinary failure and is retried like any other.

## Spending limits

Spending limits stop a chat, a Bot or a routine run once it has spent a set amount of money. They are built on the per-response cost Pi already records (the same numbers the usage view shows).

### What counts

Only requests paid for with an **API key** count. A Claude or ChatGPT sign-in (a subscription), and models running on the computer, count as $0. A chat's helpers count toward that chat. Prices come from the model catalog Aiden ships; a model with no price counts as $0.

Bot conversation summaries and helpers run under the originating input’s Bot and routine budget scopes. The Bot memory review and chat titles remain outside this accounting.

### The three limits

| Limit | Where it is set | What it covers |
| --- | --- | --- |
| **Each chat** | Settings → Context & Limits | The whole workspace chat, with the helpers it starts. |
| **Each Bot, per month** | Settings (the default) and the Bot's Profile → Spending → Monthly limit | Everything the Bot spends in its month, routines included. A Bot can use the default, its own amount, or no limit. |
| **Each routine run** | Settings → Context & Limits | One run of a routine. It also counts toward its Bot's month. |

Amounts are picked from $1, $2, $5, $10, $25, $50, $100, $250 and $500, or set to no limit (the default for all three). **A Bot's month starts on** picks the day of the month a Bot's month starts over, from the 1st (the default) to the 28th, at local midnight.

### What happens at the limit

- From **80%** of the limit, the chat or Bot shows a quiet line above the composer: "This chat has used $4.10 of its $5.00 limit."
- The request that crosses the limit still finishes its step, so nothing is cut off mid-answer. In a foreground chat, a cut-off reply keeps its text. Once the step reaches the cap, automatic retries, continuations and model summaries stop. If a reply used reduced history, pi-vcc can still save the required checkpoint locally. Aiden reports a compaction failure if it cannot save that checkpoint within the limit. Chats and helpers also check the current limit before sending a request after a provider wait. A lowered cap or spending by another helper takes effect before the retry; Allow more permits it again. The next user request is refused with a clear line, for example "This chat reached its $5.00 spending limit. Allow more to keep going." The chat's or Bot's message box shows the same line and sends nothing until more is allowed. Telegram chats with a Bot get the same line.
- The reached notice offers **Allow $X more**, which adds the limit's amount again (a $5 limit becomes $10). A chat keeps its extra amount; a Bot's extra amount ends with its month. When a Bot's month starts over, an open Bot chat can send again without being reopened.
- A **routine run** that reaches its limit stops: "This routine run reached its $X spending limit. The next run starts fresh." There is no Allow more for a run.

The ledger is saved in `userData/spending.json`. It includes chat/Bot/routine scope identities, provider-dispatch receipts, amounts, receipt status and billing-period keys; it contains no prompts, replies or credentials. An accepted dispatch is saved before provider I/O, and a known response is charged once with its receipt. Late responses keep the billing periods selected at dispatch even if the timezone or month changes. A routine resumed after restart retains its spending. Receipt capacity is bounded; exhaustion refuses another request instead of forgetting unfinished or consumed identities.

The durable dispatch ledger uses private format version 2. Earlier Aiden builds cannot read that format and may treat its balances as empty, so do not downgrade or alternate builds against a profile after this release writes it. Use the matching build and preserve the ledger when recovering a profile. The new protected routine authority state also requires the matching build; see [routine-model storage](bot-routine-models.md).

### Unconfirmed Bot request costs

If a metered provider request may have run but its cost was not durably confirmed, Aiden retains an unknown receipt and interrupts affected Bot work before another request. A transport error or aborted response with only placeholder zero usage does not prove the request was free. Successful reported zero-cost responses and unmetered local/subscription work can settle normally.

Crash recovery settles a provider charge only against protected evidence for that exact dispatch. The protected record retains original ownership, scopes and response digest plus a bounded reported-cost amount when the provider supplied one. That amount can settle accounting even if a crash prevented saving the response body in the Bot’s private session. A missing or modified body still blocks replay of that observed dispatch: Resume makes no new provider call under its old identity. Dismiss it and send a new request to make another attempt. If no protected evidence was saved, the cost remains unconfirmed.

Deleting a Bot removes its executable claims but retains minimal authenticated financial reservations for its original requests. A late observed charge, including one arriving during deletion or provider revocation, is recorded against those original scopes once. This financial evidence cannot recreate the Bot or authorize tools. When an approved peer recipient is deleted, the original initiating Bot can review its exact retired obligation from a new task, even after the earlier task was dismissed or its routine was removed. This requires that same Bot to remain live without deletion and recreation; the old request keeps its original budget scopes. It cannot acknowledge a different still-active Bot’s request. The actual owning Bot may review an old task’s original budget scopes without changing them to its current task.

On desktop, iPhone or Android, **Resume** first reads the owning host’s status. When confirmation is required, it explains: “The cost of an earlier provider request is unconfirmed. Resuming may incur another charge. Known spending limits still apply.” Confirming is tied to that exact interrupted input and unknown provider request, and permits recovery, including a new request with a new durable dispatch identity when needed. A deferred request keeps its original handle and receipt. The old receipt retains an unknown cost until an authentic late provider response supplies the amount. The Bot, a routine, a background retry or Profile’s unpause control cannot grant this acknowledgement. Dismiss and Stop do not claim earlier effects or unknown charges were undone. Known spending caps still apply and use their existing Allow more controls.

Unknown Resume requests keep the same UUID and body across page changes and restarts. An ordinary pending request cannot acquire cost consent on retry. The host consumes each Resume identity before effects and exact replays return current state without re-entry, and an opaque receipt precondition prevents an old, never-submitted dialog from acknowledging a later unknown charge on the same input. A new foreground confirmation follows only after the earlier request is settled.

### On a phone (Remote revision 47)

Aiden On The Go for iPhone and Android shows the same 80% line and reached notice in a workspace chat and a Bot chat, with **Allow $X more**, when the Mac announces `spending-limits-v1`. The phone reads the status when the chat opens, after a reply settles and after a refused send. Allow more uses the status's revision, so a tap that crossed one on another device (or on the Mac) adds nothing and the phone shows what the Mac has now. Changing the limits themselves happens on the Mac. Older phones need nothing new: a send over the limit is refused with the same line. See [Spending limits, revision 47](aiden-remote-api-v1.md#spending-limits-revision-47-spending-limits-v1-provisional).

## Code map

- `main/services/usage-limit-core.ts`: reading a rejection (status, headers, text), wait times, and the gate that lets one test request through per limit. `usage-limit-stream.ts` wraps a Pi stream function with it; `usage-limit-service.ts` saves waits and broadcasts them; `usage-limit-main.ts` binds it to Electron.
- `main/services/provider-failure.ts`: the existing provider-failure classifier the wait builds on.
- `main/services/spending-core.ts`, `spending-service.ts`, `spending-main.ts`: the ledger, the meter wrapped around each request, and its Electron binding. `aiden-remote-spending.ts` is the phone projection.
- `renderer/shared/usage-limits.ts` and `renderer/shared/spending.ts`: settings, parsing and the words the app shows.
- `renderer/components/settings/limits-settings.tsx`: Settings → Context & Limits. `renderer/components/spending/` and `renderer/main/bots/bot-spending-section.tsx`: the notices and the Bot Profile row.
