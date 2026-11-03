# Bots that work together: implementation plan

Status: planned (2026-11-03). No code written. Branch `feature/bot-messaging`, based on `main` at `286969201`.

This is the master plan. It records the owner's decisions and how the four detailed plans fit together. Research and design: [bot-to-bot-messaging-research.md](bot-to-bot-messaging-research.md).

## What ships

| Step | PR | Plan | What the person gets | Tasks |
| --- | --- | --- | --- | --- |
| A | 1 | [`message_bot`](../superpowers/plans/2026-11-03-bot-messaging-a-message-bot.md) | A Bot sends another Bot a message and carries on. The reply comes back later as a new turn | 11 |
| B | 2 | [`request_access`](../superpowers/plans/2026-11-03-bot-messaging-b-request-access.md) | A Bot limited to its own folder asks to use another one: Allow once, Always for this folder, Not now | 10 |
| C | 3 | [Plan approval](../superpowers/plans/2026-11-03-bot-messaging-c-plan-approval.md) | One plain-language card approves a whole job, and its coverage list is enforced | 9 |
| D | 4 | [Allow list and nudge](../superpowers/plans/2026-11-03-bot-messaging-d-allow-list.md) | After three approvals of the same thing, Always allow appears, and each Bot has an Allowed without asking list | 8 |

Desktop and phones get each step together. The CLI serve daemon gets A's tool and courier; B, C and D are desktop-hosted, and the docs say so. There is no terminal UI work.

## Owner decisions

**Messaging**
1. v1 is send now, reply later. Each message gets exactly one reply.
2. On by default. Each Bot has "Other Bots can message <Bot>" and "<Bot> can message other Bots", and Settings → Bots has a global switch.
3. One level of nesting. Hop 1 may message one more Bot; hop 2 and reply turns can't message anyone; nobody messages back up the chain.
4. Approvals on a Bot-started turn wait as Needs you in the asked Bot's chat. The sender is told at once. After 30 minutes the Bot gives up, and the sender is told.
5. Status lines ("COS is waiting…", "COS didn't answer") are quiet lines for the person. The sender's model doesn't see them.
6. "Hand off to me" rules block on a Bot-started turn. Approvals and Ask first rules wait for the person.
7. Cap: 30 messages a day per pair of Bots, both directions together. Also at most 3 in flight per sender and about 20 per 5 minutes, then a 10-minute cooldown.

**Access**

8. New Bots keep Full access. Each Bot works under its own folder, memory, connector bindings and browser sign-ins.
9. `request_access` is offered only to Bots limited to their own folder, not Bots with Files off.
10. Whole Mac is only ever Allow once.
11. Always for this folder can be answered from a phone.
12. A folder allowed for a Bot stays off paired phones' file browser (`botsOnly` root).

**Plan approval**

13. The person reads sentences. Enforcement uses the `covers` list, checked against the Bot's current access. A plan never widens access.
14. Per-item limit: 10 by default, 25 at most. A plan lasts for its run, at most 60 minutes.
15. Not now: the Bot stops and asks what the person would like.
16. A plan's one outside-folder grant is lost if Aiden quits, and the Bot asks again.
17. Never covered: locked rules, hand-off rules, and Computer Use on the person's Mac. An Ask first rule is covered only when the card names it.

**Allow list**

18. Aiden counts approvals, not a skill: 3 in 14 days with no recent denial.
19. Always allow is on phone approval cards too.
20. Entries apply on unattended turns as well. Locked rules and rule-made asks always win.
21. Folders from `request_access` appear in Allowed without asking, and Remove takes the folder away from that Bot.

## How the pieces connect

- **Turn kinds come from A.** `renderer/shared/bot-messages.ts` owns `bot:<originBotId>:<hop>:<deliveryId>`, `botreply:<deliveryId>`, `botMessageTurnOf` and `isBotMessageRequestId`. B and C use those helpers and never check the prefix themselves.
- **Waiting cards.** A's courier watches tool approvals itself. C's plan card calls `botMessages().announceWaiting(...)`, which tells the sender once and returns the delivery deadline. B doesn't need it: nobody can answer `request_access` on a Bot-started turn, so it raises a Needs you issue.
- **Folders.** C's `BotPlanAccessPort` uses B's `resolveBotAccessTarget`, `coveredByBotLocations` and `botRunAccess.grant`. D's folder entries use B's `grantBotFolder` root and add `revokeBotFolder`.
- **Skipping a card.** C (plan coverage) and D (allow list) both use the `preapproved` path that "routines go ahead" uses in `bot-tool-assembly.ts`. D matches only where no rule applied. C matches a rule only when the card named it. Order in `checkPolicy`: rule decision, then plan coverage, then allow list.

## Order and branches

Stacked PRs, each with its own branch, in this order:

1. `feature/bot-messaging` (A), against `main`.
2. `feature/bot-access-requests` (B), on A.
3. `feature/bot-plan-approval` (C), on B.
4. `feature/bot-allow-list` (D), on C.

Each PR ships working software on its own. Merge bottom-up and let GitHub retarget. After every `main` merge, recheck the root `package.json` `test` chain (union) and the Remote revision.

**Remote.** `main` is at revision 53 today. Each PR claims the next revision after `main`'s when it merges, not when it was written, and updates iOS, Android, `contract.json`, `openapi.json` and `docs/aiden-remote-api-v1.md` together. New capabilities: `bot:messaging`, `bot:access-requests`, `bot:plans`, `bot:allowed`.

## How it gets built

Each task goes to a fresh implementer agent (Opus 5.5, medium effort), followed by a separate review, then a commit. The main session orchestrates, reviews and owns the commits. Plans go in order; tasks inside a plan follow their numbered order.

Before each PR opens:
- Run the narrow suites named in the plan, plus `npm run test:bots`, `npm run test:bot-rules`, `npm run type-check` and `npm run test:aiden-remote`.
- Run `npm run test:cli` for A, and for any change to files the CLI bundles.
- Run the iOS and Android suites for every step with phone work.
- Run window-opening tests through `npm run test:e2e:space`.
- Run a whole-branch review on the strongest model.

## Hand checks the owner should do

Automated tests can't cover these:
- Jester and COS on a real model: does Jester pass the reply on naturally, and does COS treat the framed message as a request rather than an instruction from you?
- Do Bots actually reach for `propose_plan` before a multi-step job, or do they fall back to single cards? This depends on the tool description and may need tuning.
- A Needs you card from a Bot-started turn, answered on a physical iPhone and Android phone.

## Out of scope

Group rooms, Bots talking across machines, A2A, shared memory between Bots, routines or Telegram turns sending messages, and terminal UI. All are possible later on top of this.

## Status

- [ ] A: `message_bot`
- [ ] B: `request_access`
- [ ] C: plan approval
- [ ] D: allow list and nudge
