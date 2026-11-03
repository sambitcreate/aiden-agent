# Bots that talk to each other: research

Research, 2026-11-03, against `main` at `2c3cda1cf`. The owner's final decisions and the implementation plan are in [bot-messaging-plan.md](bot-messaging-plan.md). Where the two differ, that plan wins: §4–§6 here are the first-round thinking, kept as the record.

## 1. The problem

A person with two Bots (for example Jester and COS) asks one to talk to the other. Today the Bot correctly says it has no way to do that. Bot-to-Bot messaging was out of scope in both the original Bots plan (`docs/plans/completed/bots-mode-plan.md:91`) and the October rework (`docs/superpowers/specs/2026-10-07-bots-rework-design.md` §13). No code path, tool or memory note covers it.

## 2. What other projects do

| Project | Mechanism | Sync or async | Loop guard | Who can talk to whom |
| --- | --- | --- | --- | --- |
| **Hermes Agent, Bot Mode** (closest to Aiden: a roster of Bots, one canonical chat each) | `message_agent(target, message)` in `tools/bot_mode_dm.py`. Server adds `Message from 🤖 Name:`; the message waits in the target's chat queue behind its running turn and queued human prompts | Async. Returns `queued` + `delivery_id`; the reply wakes the sender later. Relay capped at 10 min | One reply per message; 20 bot messages per 5 min per chat, then a 10 min cooldown; status chatter (`Working…`) never crosses; prompt rule "never ping-pong acknowledgements" | Only the canonical Bot Chat gets the tool (not subagents or routines); targets checked against the live roster; no self-messages |
| **Hermes group rooms** | 2–6 Bots in one room, @mentions | Serial rounds | 3 rounds and 10 messages per human message; a Bot may pass; `@user` escalates to the person | Room members |
| **OpenClaw** | `sessions_send({agentId, message, timeoutSeconds})`, plus `sessions_list` / `sessions_history` | `timeoutSeconds: 0` is fire-and-forget; a positive value waits inline, and a late reply still arrives as a new turn | Since 2026.9.8: exactly one reply per request. The old ping-pong loop (`maxPingPongTurns`, `REPLY_SKIP`, `ANNOUNCE_SKIP`) was removed after sentinels leaked and loops ran | `tools.agentToAgent.allow[]` (empty means everyone — a reported footgun); per-agent send-only grants; per-session Receive: Always / Ask / Never |
| **rakazo** (pi-based Bots) | `message_bot{bot_id, message, intent: request|result|question|status|fyi}` | Async; the recipient's final answer returns to the sender automatically, failures too | Hop counter, max 6, reset by a human message; FYI may be silently ignored; idempotent delivery key | Same owner |
| **omp** | `hub` tool over an in-process `IrcBus` | Optional `await` with a 120 s timeout | Relayed replies never wake anyone ("or two idle peers ping-pong forever") | Registry of running agents |
| **Letta** | `send_message_to_agent_and_wait_for_reply`, `…_async`, by-tag broadcast | Both | None in the tools; group managers cap turns. Shared memory blocks preferred over chatter | Any agent |
| **CrewAI / AutoGen / OpenAI Agents SDK** | Delegate-to-coworker, group chat, `transfer_to_<agent>` handoffs | Synchronous in one run | Turn caps and termination conditions. CrewAI #6414 reports A→B→A ping-pong "burning thousands of dollars" | Configured crew |
| **Claude Code agent teams** | `SendMessage` into file mailboxes | Async | Teammates can't nest teams; a message from a peer can never grant permission or consent | Team members |
| **Google A2A** | Agent cards, tasks (`input_required`, `auth_required`), `SendMessage`, SSE, webhooks | Both | None in the protocol | Over HTTP with auth |

"OpenBots" is not a relevant project (an older RPA suite and small repos). A2A is too heavy for Bots in one process; Hermes and OpenClaw both say to use it only across machines or frameworks. Its task vocabulary is still worth borrowing.

### Lessons from issues

- **Only final replies may cross.** Hermes #43047: status messages delivered between Bots caused an endless acknowledgement loop.
- **Don't rely on magic tokens.** OpenClaw removed `REPLY_SKIP` / `ANNOUNCE_SKIP` after they leaked to people or hid real replies.
- **Cap retries; silence is success.** OpenClaw #153417: announce retries looped for hours (219 failed runs, 61 concurrent tasks).
- **Allow-all defaults are dangerous**, and too-low caps frustrate genuine back-and-forth (OpenClaw #43972, cap raised 5 → 20, then the loop was replaced by one reply per request).
- **Telegram can't carry it.** Bots can't see each other's Telegram messages; the channel must be inside Aiden.

## 3. Where it fits in Aiden

All Bots of a profile live in one process (desktop or CLI daemon, `profile-lock.ts`), so a Bot-to-Bot call is in-process. No network protocol is needed.

- **One entry point.** `BotSessionService.send(botId, input)` (`main/services/bot-runtime/bot-session-service.ts:696`) already dedupes by `requestId`, refuses while paused or over a spending limit, queues behind a running turn (`whenBusy: "followUp"`), and `awaitReply` (`:821`) returns `completed | failed | interrupted`. The routine executor (`main/services/scheduled-bot-routines.ts:305-399`) is a working template: send with `ifNotInterrupted`, await, handle `[SILENT]`.
- **Run kinds come from the request-id prefix** (`routine:`, `tg:`, `intro:`, `remote:`; `botTurnOf` in `bot-tool-policy.ts:77`). A new `bot:<fromBotId>:<callId>` prefix gives a durable, replay-safe id and a turn kind the policy can see.
- **Tools.** A new candidate goes next to wake-ups, questions and hand-offs in `bot-tool-sources-main.ts` (~line 477), with a verdict branch in `botToolVerdict` and an ingress rule like `wake_up`'s (offered only on person-started turns). The hand-off and question bridges show the durable-wait pattern (memo-held id, `interactive`, `replay: "safe"`, abort on Stop / Pause / Delete, re-ask on Resume).
- **Phones.** Projecting the incoming request as a labelled user `message` (as routines are, `aiden-remote-bot-session.ts:404-420`) and the reply as a normal assistant message needs no Remote revision and no iOS or Android change. A dedicated `bot_message` entry kind would need a negotiated capability, a revision bump, fixtures and both native parsers.
- **CLI.** `packages/cli/src/bot-durable.ts` shares the session core but builds its own tool list; it has no hand-offs or wake-ups either. Desktop first, CLI as a follow-up, is consistent with recent Bot features.

### Constraints a design must respect

1. **No authority laundering.** The target runs under its own access. A request from another Bot is data, never the person's consent: it can't approve a tool, answer a card, or satisfy a rule. Treat a `bot:` turn as unattended (no questions, hand-offs, sign-ins, browser, routines, wake-ups, subagents), so approval-gated calls block instead of acting.
2. **Privacy.** Memory, `USER.md`, files, rules and connections stay per Bot. Only the message and the reply text cross. Memory review and `bot_recall` must not learn from `bot:` turns (`bot-memory/review.ts`, `withBotMemoryIngress`).
3. **No deadlocks or loops.** A waits on B while B asks A is a cycle (B's input queues behind A's running turn). Refuse self-targets and withhold the tool on `bot:` turns, so there is no nesting at all in v1. Never touch the caller's own session host from inside its tool (`.memory/bot-rules.md:59`).
4. **Paused, deleted or over-budget targets** return a clear tool result (`bot_paused`, `spending_limit`, `needs_model`…). Never resume or dismiss the target's paused turn. Spending is charged to the target Bot.
5. **Mom-friendly UI.** The person should see one quiet line in each chat ("Asked COS: …" / "Jester asked: …"), not a wall of machine chatter.

## 4. Options

**A. Ask and wait (`ask_bot`), recommended for v1.** One tool, `ask_bot({bot, message})`, offered only on turns the person started. It sends a `bot:` turn to the target (unattended, no tools that need a person, no `ask_bot`), waits for the one final reply with a timeout (about 5 minutes), and returns it as the tool result. The caller then answers the person. Exactly one reply per request, no nesting, so loops are impossible by construction. Reuses `send` + `awaitReply` and the hand-off wait pattern; no Remote revision. Covers the screenshot's case.

**B. Send and get woken later (`message_bot`).** Hermes / rakazo style: returns `queued` at once; the reply arrives later as a new turn in the caller's chat. Better for long tasks ("COS, draft the weekly plan"), but needs a durable outbox, a hop counter, a rate window, and a decision about what the person sees when the reply lands while they are away. Natural v2 on top of A (a `wait: false` mode).

**C. Group room.** Several Bots in one thread with @mentions and round caps (Hermes). Highest delight, highest cost: new UI on three clients, a new thread kind and a Remote revision. Later, if A and B prove useful.

**D. Shared notes instead of chatter.** A per-person shared memory block several Bots can read (Letta). Complements A/B; it doesn't replace them, and it reopens the "no shared memory between Bots" decision from the memory spec.

## 5. Recommended v1 shape (option A)

- **Tool:** `ask_bot({ bot: name or id, message: ≤ 4,000 chars })`, model-only (not scriptable from codemode). The description lists the person's other Bots by name and one-line purpose only.
- **Guards:** person-started turns only; never on `routine:`, `tg:`, `intro:` or `bot:` turns; no self-target; at most one `ask_bot` running per Bot; a daily cap per Bot pair (for example 30); 5-minute wait, then "COS is still working; I'll stop waiting" without cancelling COS.
- **Target turn:** request id `bot:<callerId>:<callId>`, input framed as `<bot_message from="Jester">…</bot_message>` and marked as another Bot's words, not the person's. Unattended tool rules. Reply `[SILENT]` maps to "COS had nothing to add".
- **Person's control:** a per-Bot switch in the Bot's profile, "Other Bots can ask <Bot> things" (default on? see §6), plus the existing Pause.
- **What each chat shows:** in Jester's chat, the tool step reads "Asked COS" with the question and answer in the expanded step. In COS's chat, a labelled row "Jester asked: …" followed by COS's answer, like a routine run. Phones see both through existing entry kinds.
- **Tests:** loop refusal (a `bot:` turn can't call `ask_bot`), paused or deleted target, timeout keeps the target running, memory review skips `bot:` turns, approval-gated tool in the target blocks instead of acting.

## 6. Decisions for the owner

1. **Scope of v1:** A only (ask and wait), or A + B (also send-and-get-woken-later)?
2. **Default:** can every Bot ask every other Bot unless switched off, or does each Bot need it switched on?
3. **What the target may do on a `bot:` turn:** answer from what it knows and its read-only tools only, or also use its write tools (calendar, files) under its own access, with anything approval-gated blocked?
4. **Nesting:** none in v1 (COS can't ask a third Bot while answering Jester) — recommended — or one level?
5. **Phones and CLI:** desktop only for v1 (phones see the rows through existing entries), or full parity from the start?

## 7. Owner decisions, 2026-11-03

1. **Send now, reply later** (option B) is v1, not ask-and-wait.
2. **On by default**, with a per-Bot switch in Settings.
3. **The asked Bot works under its own access**: its own workspace, memory, connector bindings and sign-ins. Bots work in their own workspace by default and can ask to go outside it to the rest of the Mac. See §9.
4. **One level of nesting**: COS can message a third Bot while working on Jester's request, but that third Bot can't message anyone.
5. **Desktop and phones.** The CLI is becoming serve-only with no terminal UI. Phones are clients of the desktop, so they get the feature, its rows and its setting.

## 8. Revised v1 design: `message_bot`

**Tool.** `message_bot({ bot, message })`, where `bot` is a name or id from the roster and `message` is at most 4,000 characters. It returns at once with `{ status: "sent", deliveryId }`, or with a typed refusal such as `bot_paused`, `switched_off`, `unknown_bot`, `self`, `limit_reached` or `chain_too_deep`. The description tells the Bot to finish its turn instead of waiting, to write its own message rather than paste the person's words, and to message only one relevant Bot unless the person asks for more.

**Chain and hops.** Every input carries a hop count in its request id, `bot:<originBotId>:<hop>:<deliveryId>`.

| Turn | Hop | Can it call `message_bot`? |
| --- | --- | --- |
| The person's own turn | 0 | Yes |
| The asked Bot's turn | 1 | Yes, once per turn, but not back to a Bot already in the chain |
| A third Bot's turn | 2 | No |
| A reply turn (`botreply:`) | Same as the turn that sent the message | No. A reply ends the exchange, which prevents ping-pong |

`routine:`, `tg:` and `intro:` turns can't message either in v1. A message from the person resets the chain.

**Delivery and replies:**
- `send(target, { requestId, label: "From Jester", whenBusy: "followUp", ifNotInterrupted: true })` queues the message behind the target's running turn.
- A main-side courier records each delivery in a small per-profile ledger, so a quit or crash re-attaches to it: `delivered`, then `answered`, `failed` or `expired`.
- The courier `awaitReply`s and then sends the target's final text into the sender's chat as a `botreply:<deliveryId>` turn labelled "COS replied". The sender Bot reads it and tells the person.
- A `[SILENT]` reply or an expired delivery after 30 minutes becomes one short notice, never a model turn. Failures return once and are never retried in a loop.
- With nesting: when COS asked a third Bot during Jester's request, the reply to COS's `botreply:` turn is also forwarded to Jester, at most once.

**Limits:**
- At most 3 deliveries in flight per sender.
- About 20 messages per Bot every 5 minutes, then a 10-minute cooldown (the same idea as Hermes's guard).
- A daily cap per pair of Bots.
- Spending is charged to whichever Bot runs the turn.
- Only final replies cross between Bots: never status rows, tool steps or "Working…".

**Provenance and privacy:**
- The incoming message is framed as `<bot_message from="Jester" hop="1">…</bot_message>` and escaped. It is another Bot's words, never the person's consent: it can't approve a tool, answer a card, satisfy a rule or change settings.
- Memory review and `bot_recall` skip `bot:` and `botreply:` turns, like routine turns.
- Only the message and the reply text cross. Memory, `USER.md`, files and connections never do.

**Approvals on a Bot-started turn.** This needs an owner decision (§10, question 1). The options are to block as routines do, or to show the card in the asked Bot's chat as "Needs you" and tell the sender "COS is waiting for you to approve …".

**Settings.** Each Bot's profile gets "Other Bots can message <Bot>" and "<Bot> can message other Bots", both on by default. Settings → Bots gets a global switch. All three are on desktop and phones.

**What the person sees:**
- In Jester's chat: a quiet step "Messaged COS", then later a labelled row "COS replied" followed by Jester's answer.
- In COS's chat: "Jester asked: …" followed by COS's answer, the same way a routine run shows.
- If the person is away when the reply lands, the delivery funnel (banner, phone, quiet hours) handles it like a routine result.

**Remote.** Rows can use the existing labelled `message` projection, so no new entry kind is needed. The two switches still need a Remote DTO change, so this claims one Remote revision at merge, with iOS and Android settings rows and fixtures.

**CLI.** The CLI only serves: the desktop and the CLI daemon share the Bot session core, so the tool is wired wherever the host runs Bots. There is no terminal UI work.

## 9. Bot scope: its own workspace, with a way out

**What exists today:**
- **Access level.** Each Bot has Full access or Custom (`main/services/bot-runtime-authority.ts`).
- **File scopes.** These are `bot_home` (the Bot's own folder), `approved_location` (folders the person picked) and `full_mac` (`bot-tool-authority.ts`, `bot-capability-catalog-core.ts`).
- **Connectors.** A Custom Bot binds its own connector connections. Its "Add to this Bot" card grants one connection at a time under the policy revision (`.memory/bot-durable-runtime.md`).
- **Sign-ins.** Every Bot has its own browser profile (`persist:aiden-bot-<dir>`) with its own cookies, behind the credential boundary (`.memory/bot-browser.md`). A Bot computer gives it its own VM.
- **Memory, skills and rules** are per Bot.

So most of "own workspace, own connectors, own sign-ins" is already built.

**The gap** is asking at run time to go outside the workspace. A Custom Bot limited to its home folder has no way to say "I need `~/Documents/Taxes` for this". It just fails.

**Proposal** (could be its own plan in the same program):
- **Tool.** `request_access({ path | "whole_mac", why })` raises a card in the Bot's chat with Allow once, Always for this folder, or Not now.
- **Always** adds an `approved_location` to the Bot's Custom grants under the policy revision, the same path "Add to this Bot" uses for connections. **Allow once** is a grant for that run only.
- **Whole Mac** is only ever offered as Allow once.
- **Unattended turns** can't raise the card. On those turns, `bot:`, `routine:` and `tg:`, a refusal becomes a "Needs you" issue for the person.
- **Default access for new Bots** is an owner decision (§10, question 2): Custom with its own folder, its connectors and its browser, or Full as today.

## 10. Remaining questions for the owner

1. When another Bot's message makes COS want to do something that needs approval, should COS **block** and tell Jester it couldn't, as routines do today, or **wait for you**, with a Needs-you card in COS's chat and Jester told it's waiting?
2. Should new Bots start in **their own folder plus their own connectors and browser** (Custom), with `request_access` to go outside, instead of Full access?
3. Should `request_access` ship **with** `message_bot` or as its own plan right after?

## 11. Owner answers, 2026-11-03 (second round)

1. **Approvals on a Bot-started turn: both.** COS shows the approval card in its own chat as "Needs you" and waits. Jester is told right away: "COS is waiting for you to approve …". If nobody answers within the delivery window (30 minutes), COS gives up, and Jester is told it couldn't.
2. **New Bots keep Full access by default.** `request_access` therefore matters for Custom Bots and for Bots the person has narrowed.
3. **`request_access` ships with `message_bot`.**
4. **New: approve a whole plan at once** (§12).
5. **New: stop asking for the same thing**, using an allow list in Settings and a nudge from the Bot (§13).

## 12. Approve a plan once ("plan approval")

**Problem.** A real task can need ten approval cards, each showing a raw command or tool call. That is tiring and not mom-friendly.

**Tool.** `propose_plan({ title, why, steps: [{ text }], covers: [...] })`.

- **`steps`** is what the person reads: plain sentences such as "Add the three dentist appointments to your calendar". Commands never appear here.
- **`covers`** is what is enforced: structured items in the same action classes the rules already use (`classifyBotAction` / `describeMcpAction`). Examples:
  - `{ connector: "Google Calendar", action: "create events", max: 5 }`
  - `{ files: "~/Documents/Taxes", action: "write" }`
  - `{ shell: "bot_home" }`
  - `{ site: "amazon.com", action: "browse" }`
- **Main validates `covers` against the Bot's current access.** A plan can never widen access. A folder outside the Bot's scope is a `request_access` item, shown on the same card.

**Card.**
- The card shows the title, the plain-language steps and one line per covered item ("Calendar · create up to 5 events").
- Buttons: **Approve plan** and **Not now**. **Show details** reveals the exact actions, for people who want them.

**After approval:**
- An approval-gated call that falls inside a covered item runs without a card. It uses the existing `preapproved` path that "routines go ahead" already uses in `bot-tool-assembly.ts`.
- A call outside the plan still gets its own card.
- Code mode works the same way. The Bot can write one script for the whole plan, and each nested call in the script is checked against the plan, so the person approves the description, not the code.
- The card turns into a checklist that ticks off steps as they run.
- **Stop** ends the plan.

**Limits:**
- A plan lasts for this run and its follow-up turns, at most 60 minutes. Each covered item has a call cap.
- Locked rules (credentials, money) are never covered.
- Computer Use on the person's own Mac keeps its own access card.
- A rule-made ask is covered only when the card lists it by name ("Rule · Spending").

**On Bot-started turns.** A plan card can come from a `bot:` turn too. It is raised as Needs you, per §11.1, so COS can ask for one approval covering the whole job Jester gave it.

## 13. Stop asking for the same thing: the allow list

**Counting is done by Aiden, not by a skill.** Aiden counts approvals per Bot and per action class in main, so the count is exact and never depends on the model remembering.

**When the nudge appears.** Once the person has approved the same class 3 times in 14 days, with no recent denial, two things happen:
- That card gets an extra choice: **Always allow for <Bot>**.
- The tool result tells the Bot, so it can say "I've asked you about Calendar events 4 times this week — you can let me do this without asking in Settings" with a link to the list.

The nudge also covers repeated `request_access` for the same folder.

**Settings.**
- Each Bot's profile gets an **Allowed without asking** list. Each entry shows the connector action, folder, site or shell scope, when it was added and how often it has been used, with **Remove**.
- Settings → Bots shows the same lists across all Bots.
- Entries reuse the remembered "always" approval scopes (`renderer/shared/tool-approval-scope.ts`). They never skip a locked rule or a rule-made ask, which matches today's rule.
- The list is shown on phones too, under the same Remote revision as the messaging switches.

## 14. Proposed shipping order

1. **`message_bot`**: chain and hops, the courier and its ledger, switches, rows, and Needs-you approvals on `bot:` turns.
2. **`request_access`**: the card, Allow once or Always for this folder, and the Needs-you issue on unattended turns.
3. **Plan approval**: `propose_plan`, coverage checks, the checklist card, and code-mode scripts checked against the plan.
4. **Allow list and nudge**: counting, the Always allow choice, the Settings lists and the Bot's hint.

Phones come with each step. One Remote revision is claimed for all four if they land together, or one per step if they ship as separate PRs.

## Sources

- Hermes Agent: [`website/docs/user-guide/bot-mode.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md), [`tools/bot_mode_dm.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/bot_mode_dm.py), `gateway/bot_loop_guard.py`, `tools/delegate_tool.py`; issues #43047, #133153.
- OpenClaw: [`docs/concepts/session-tool.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/session-tool.md), [`docs/gateway/config-tools/sessions-and-subagents.md`](https://github.com/openclaw/openclaw/blob/main/docs/gateway/config-tools/sessions-and-subagents.md), [`src/agents/tools/sessions-send-tool.a2a.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/tools/sessions-send-tool.a2a.ts), [CHANGELOG 2026.9.8](https://github.com/openclaw/openclaw/blob/main/CHANGELOG/2026.9.8.md); issues #43972, #105503, #153417.
- Local clones under `~/projects/opp/`: rakazo (`packages/core/src/bot-messages.ts`, `packages/adapters/src/builtin-tools.ts`), omp (`packages/coding-agent/src/irc/bus.ts`), pi-subagents (`src/intercom/native-supervisor-channel.ts`), prime-agent (`docs/long-running-agents.md`).
- [A2A specification](https://a2a-protocol.org/latest/specification/); Letta `letta/functions/function_sets/multi_agent.py` (archive branch); [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams); CrewAI issue [#6414](https://github.com/crewAIInc/crewAI/issues/6414).
