# Usage limits and spending limits

Status: Implemented, in review (2026-10-26). User guide: [docs/usage-limits-and-spending.md](../usage-limits-and-spending.md).

## Goal

When a provider's rate limit or plan window turns a reply away, Aiden waits for it to clear instead of failing, and the owner can put dollar limits on chats, Bots and routine runs. Desktop (macOS and Linux) and Aiden On The Go; the CLI is out of scope.

## Owner decisions (2026-10-26)

Spending model A: each chat has a total limit, each Bot a calendar-month limit, each routine run its own limit. Then:

1. Only pay-as-you-go API keys count; sign-ins and models on the computer are $0.
2. At the limit the current step finishes, then the chat, Bot or run stops.
3. Allow $X more adds the limit's amount again.
4. A quiet note from 80% of the limit.
5. Helpers (subagents) count toward their chat.
6. Routine runs count toward their Bot's month and their own run limit.
7. A routine run that reaches its limit stops; the next run starts fresh.
8. Defaults live in Settings; each Bot can set its own monthly limit.
9. The owner picks the day a Bot's month starts (default the 1st).
10. Allow more works from the phones too, in the same change (iOS, Android and a Remote revision).
11. The longest wait for a usage limit defaults to 6 hours.
12. A weekly (multi-day) limit does not wait.
13. A notification only when Aiden gives up waiting.
14. Waiting requests resume oldest first, one at a time.

The model never changes while waiting.

## What was built

- Waits: rejection reading from status, rate-limit headers and error text; reset time or backoff; one test request per limit; restart-surviving waits; a wait row with Retry now in chats and Bot chats; Settings → Limits & spending.
- Spending: a ledger built on the cost Pi records per response, a meter around every chat, Bot, helper and routine request, notices with Allow more on the Mac, a Bot Profile monthly limit, Telegram refusal lines.
- Phones: Remote revision 43 (`spending-limits-v1`, provisional), spending status and Allow more routes, iOS and Android notices.

## Not done

- A subscription usage meter (how much of a Claude or ChatGPT plan window is used). The only source is an unofficial sign-in endpoint; left out for now.
- Counting Bot compaction summaries, the Bot memory review and chat titles toward spending limits.
- CLI support for either feature.
