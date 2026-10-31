# Usage limits and spending limits

Aiden handles two kinds of limits on the Mac and Linux desktop app: the ones a provider sets (rate limits and plan windows), and the dollar limits the owner sets. Both live in **Settings → Limits & spending**. Nothing about either leaves the computer. The two settings travel with Aiden's portable settings like other preferences; the saved waits and the spending ledger stay on this computer only.

The CLI does not wait for usage limits or keep spending limits yet.

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

Not counted yet: Bot conversation summaries made during compaction, the Bot memory review and chat titles.

### The three limits

| Limit | Where it is set | What it covers |
| --- | --- | --- |
| **Each chat** | Settings → Limits & spending | The whole workspace chat, with the helpers it starts. |
| **Each Bot, per month** | Settings (the default) and the Bot's Profile → Spending → Monthly limit | Everything the Bot spends in its month, routines included. A Bot can use the default, its own amount, or no limit. |
| **Each routine run** | Settings → Limits & spending | One run of a routine. It also counts toward its Bot's month. |

Amounts are picked from $1, $2, $5, $10, $25, $50, $100, $250 and $500, or set to no limit (the default for all three). **A Bot's month starts on** picks the day of the month a Bot's month starts over, from the 1st (the default) to the 28th, at local midnight.

### What happens at the limit

- From **80%** of the limit, the chat or Bot shows a quiet line above the composer: "This chat has used $4.10 of its $5.00 limit."
- The request that crosses the limit still finishes its step, so nothing is cut off mid-answer. The next request is refused with a clear line, for example "This chat reached its $5.00 spending limit. Allow more to keep going." The chat's or Bot's message box shows the same line and sends nothing until more is allowed. Telegram chats with a Bot get the same line.
- The reached notice offers **Allow $X more**, which adds the limit's amount again (a $5 limit becomes $10). A chat keeps its extra amount; a Bot's extra amount ends with its month. When a Bot's month starts over, an open Bot chat can send again without being reopened.
- A **routine run** that reaches its limit stops: "This routine run reached its $X spending limit. The next run starts fresh." There is no Allow more for a run.

The ledger is saved in `userData/spending.json` (chat ids, Bot ids, recent routine run ids and dollar amounts only), so a routine run resumed after a restart keeps what it already spent.

### On a phone (Remote revision 47)

Aiden On The Go for iPhone and Android shows the same 80% line and reached notice in a workspace chat and a Bot chat, with **Allow $X more**, when the Mac announces `spending-limits-v1`. The phone reads the status when the chat opens, after a reply settles and after a refused send. Allow more uses the status's revision, so a tap that crossed one on another device (or on the Mac) adds nothing and the phone shows what the Mac has now. Changing the limits themselves happens on the Mac. Older phones need nothing new: a send over the limit is refused with the same line. See [Spending limits, revision 47](aiden-remote-api-v1.md#spending-limits-revision-47-spending-limits-v1-provisional).

## Code map

- `main/services/usage-limit-core.ts`: reading a rejection (status, headers, text), wait times, and the gate that lets one test request through per limit. `usage-limit-stream.ts` wraps a Pi stream function with it; `usage-limit-service.ts` saves waits and broadcasts them; `usage-limit-main.ts` binds it to Electron.
- `main/services/provider-failure.ts`: the existing provider-failure classifier the wait builds on.
- `main/services/spending-core.ts`, `spending-service.ts`, `spending-main.ts`: the ledger, the meter wrapped around each request, and its Electron binding. `aiden-remote-spending.ts` is the phone projection.
- `renderer/shared/usage-limits.ts` and `renderer/shared/spending.ts`: settings, parsing and the words the app shows.
- `renderer/components/settings/limits-settings.tsx`: Settings → Limits & spending. `renderer/components/spending/` and `renderer/main/bots/bot-spending-section.tsx`: the notices and the Bot Profile row.
