# Bots that message each other

Ask a Bot to get help from another Bot. It writes its own message and finishes its current turn. The other Bot answers in its own chat, then the first Bot receives the answer as a new turn and brings the result back to you.

A message shows who asked or replied. The message and final answer cross between the two Bots; their chat histories, working steps, files, permissions and personal memory stay separate. The receiving Bot uses its own model and access. Another Bot's words never count as your approval.

## Controls

Messaging starts on. You can change it on desktop, iOS and Android:

- **Settings → Bots → Bots can message each other** controls the profile. On a phone, use the same switch on the Bots page.
- A Bot's **Advanced → Other Bots** has **Other Bots can message {name}** and **{name} can message other Bots**.
- Turning messaging off for all Bots disables the per-Bot controls. Older paired hosts without messaging support show no messaging controls.

A switch prevents new sends. An already accepted exchange keeps its original deadline. Deleting a Bot removes its private message work and prevents it from being recreated by recovery.

## Replies and approvals

The recipient can ask the person to approve a step in its own chat. The sender shows a waiting line, such as "COS is waiting for you to approve: Create 3 events". Answer the actual approval card in the recipient's chat on desktop or a paired phone. There are no approval buttons on the sender's waiting line.

The recipient still follows its rules. An Ask first rule still asks; a Hand off to me rule blocks the Bot-started step. The routines setting that goes ahead without asking does not apply to these turns. Bot-message turns cannot answer cards, change settings, save or recall personal memory, create routines or wake-ups, start subagents, or open question, hand-off, sign-in or browser flows.

Only a final answer is forwarded. Silence, failure and an unanswered deadline produce a status row instead of another model turn. If the sender is paused, interrupted, over budget or unable to use its model, the saved answer stays visible without resuming it. A failed or stopped reply turn also keeps the answer as a display row.

The normal final result and status notifications follow the Bot's configured delivery channels. A nested child's answer is relayed into its sender's chat, or shown there as saved text; its answer is never delivered separately through the delivery funnel. Text-free child status notifications can still say that it is waiting or could not finish.

## Nesting and limits

A Bot you ask can message another Bot. That recipient can ask one more Bot, then the answer travels back through the same chain. The final recipient and reply turns cannot send more messages, and no Bot can message one already in the chain. Routine, Telegram and self-introduction turns cannot start an exchange.

Each accepted exchange has a **30-minute window**, including approval waits. A nested request shares the earlier ancestor deadline. Busy Bots finish their current work first. Messaging never resumes, stops or dismisses a person's work, or removes their queued messages.

Limits apply to accepted sends:

| Limit | Amount |
| --- | --- |
| Message | 4,000 characters |
| Forwarded answer | 8,000 characters |
| Unfinished exchanges per sender | 3 |
| Sends per sender in five minutes | 20, followed by a ten-minute cooldown |
| Sends per pair of Bots in a local day | 30, counting both directions |

Refused attempts do not spend a quota slot; an accepted exchange that later fails still counts. A recipient that is paused, has no model or is over budget is refused before a new delivery is accepted.

## CLI host

The serve-only CLI daemon supports the same tool, bounded exchange, controls and durable recovery for its Bots. Paired phones use the same capability-gated Remote contract. The CLI records paid Bot response costs in its profile-local spending ledger and enforces configured monthly and routine-run limits. It does not wait out provider usage limits or offer a spending settings editor. The CLI has no terminal chat interface. See [durable CLI Bots](cli-durable-bots.md).

For storage, recovery and implementation details, see [Bot messaging core](bot-messaging-core.md). The [implementation plan](plans/bot-messaging-plan.md) tracks review and acceptance; source tests and simulator checks do not establish physical-device or live-model acceptance.
