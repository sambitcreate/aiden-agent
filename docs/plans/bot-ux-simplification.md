# Simpler Bots and approvals: adopt Rakazo's model

Date: 2026-11-12
Status: **Phases 1–5 implemented on branch `claude/aiden-bot-ux-simplify-cdd73d` (2026-11-12); Phase 6a (the wire and server half of Phase 6, provisional contract revision 61) implemented on the same branch (2026-11-13); the iOS half (6b) implemented on the same branch (2026-11-13); the Android half (6c) implemented on the same branch (2026-11-13). The owner chose Rakazo's model on 2026-11-12 ("Ok lets use how rakazo does it"); this revision replaces the earlier hybrid. The owner answered the five open questions the same day (§9).**
Baseline: `main` at `6f4d0385f` (after 0.65.0)
Deliverable: product and engineering plan in six phases, each its own PR.
Inputs: four explorer reports (Rakazo approvals, Rakazo bot UX, Aiden approvals inventory, Aiden bot UX inventory), spot-checked against this repo and `/Users/sambitbiswas/projects/opp/rakazo`.

Owner brief: "right now there's a lot of dialogue boxes/options etc. I want to simplify but also keep options for users to tweak in advanced settings."

Related plans this one supersedes in part or must stay consistent with: [bot hand-offs, rules and computers](bot-handoffs-rules-computers-plan.md) (per-Bot Rules UI is replaced, hand-off behaviour is kept), [bot messaging](bot-messaging-plan.md) (allow-list stores are kept as legacy-scoped rows), [bot continuity](bot-continuity-plan.md), [Aiden hooks](aiden-hooks-plan.md), [Inbox sidebar](inbox-sidebar-plan.md), [nontechnical user journey UX](nontechnical-user-journey-ux-plan.md), and the completed tool-approval-scopes plan.

## 1. Problem

| Measure | Today | Target |
| --- | --- | --- |
| Distinct prompt surfaces | ~31 (14 workspace cards, 7 Bot cards, 10 modals, sheets, OS dialogs, toasts) | 11 |
| Permission and trust settings | ~35 over 11 Settings pages, plus per-workspace and per-Bot pages | 1 mode and 1 rules list, the rest under Advanced |
| Approval card systems | 2 (`ChatApprovalCard`, `BotApprovalCard`) with separate allow lists | 1 card model on every client |
| Meanings of "Always allow" | 4 | 1 (a rule on the rules page) |
| Lifetimes of "Allow for this chat" | 3 | 1 (Mac cards only, persisted) |
| Pages that hold remembered grants | 6 or more | 1 |
| Bot chat card, chip and line types | ~23 | 7 families |
| Bot dialogs | ~22 (two-step create, 4+ "Discard changes?" guards) | about 10 |
| Create a Bot | 2 screens, 1 required and 3+ optional decisions | 1 field |
| Bot settings | 12-group Profile page plus an Advanced page with 3 save models | Side-panel tabs plus one Advanced tab |

Top eight pain points:

1. **Two approval systems.** Workspace chats use `renderer/components/chat-approval-card.tsx`; Bot chats use a different card. Their grants are revoked on different tabs.
2. **Overloaded words.** "Always allow" means a workspace rule, every chat globally (Computer Use), one Bot, or one folder. "Allow for this chat" has three lifetimes, and chat-scoped tool grants cannot be listed.
3. **"Full access" still asks** for disclosure tools, memory, schedules, Computer Use, subagent grants and hooks.
4. **Footer pile-up.** Plan, access, hand-off and one approval card per pending prompt stack above the composer, with up to five status cards below.
5. **Five look-alike proposal cards**, and the routine one adds a "Why not?" step.
6. **Bot Profile is a 12-group scroll**, and Advanced mixes three save models.
7. **Six overlapping permission phrases on a Bot** ("What it can use", Rules, "Allowed without asking", "Always for this folder", "Always allow", "Go ahead without asking"), and Bot messaging has five switches in three places under three names.
8. **Phones are second-class.** Most specialised cards are deny-only there, and several card types and settings are missing.

## 2. What we take from Rakazo, and the six deviations

We take the model whole:

- **One global mode**, Ask / Auto / Never ask, with Auto as the default when a model exists.
- **One pure gate function** in Rakazo's order, fixed tool sets, a name heuristic for connector tools, and taint tracking.
- **The Bot's own things never ask.** The person's Mac is a separate class with its own cards.
- **One inline card shape** with Rakazo's buttons and status lines. Cards never block the chat.
- **Global rules that grow from cards**, with a per-workspace Customize as the only override.
- **Take control** for steps only the person should do.
- **Silent first Bot, one-field New bot, versioned Templates.**
- **Settings in the side panel** with an Advanced tab, Rakazo's save model, and the mobile two-level structure.
- **Tool activity hidden by default.**
- **Settings from chat that apply and offer Undo.** A Bot never widens its own powers from chat.
- **One backend card model for every client.**

Deliberate deviations, each an existing Aiden security decision:

| | Deviation | Reason |
| --- | --- | --- |
| (a) | Migration never switches an existing user to Auto. Their behaviour maps to Ask or Never ask, and the repeat-approval nudge offers Auto. | A model starting to approve actions must be the person's choice, not an upgrade side effect. |
| (b) | Schedule and automation mutations keep their foreground one-shot confirmation. Rakazo exempts a bot's schedules. | Audit fix recorded in `.memory/security-cli-schedule-approval-2026-10-27.md`: a schedule is unattended authority on the person's Mac. Owner confirmed 2026-11-12. |
| (c) | Mac cards keep **Allow once** beside "Allow in this workspace". Rakazo offers only the space-wide grant. | Ask workspaces are used for coding, where reviewing each command is the point. |
| (d) | Computer Use OS permissions (Accessibility, Screen Recording) are granted on the Mac only. | macOS owns those prompts; they cannot be answered remotely. |
| (e) | Disclosure tools (`share_image`, `generate_image`, `classify`) ask in every mode, Never ask included, as explicit-only tools. Rakazo's Never ask would let them run. | Sending the person's data to another service stays their call, as today. Owner decision 2026-11-12. |
| (f) | Computer Use keeps one grant for all apps: "Use your Mac with Computer Use?". Rakazo asks per app. | Fewer cards; matches today's grant. Owner decision 2026-11-12. |

Aiden also keeps per-class "Hand off to me", which Rakazo lacks, as the row-menu option "Do it myself" on Always-ask rows (owner decision 2026-11-12).

Things Rakazo has that Aiden lacks are omitted, not invented: group chats (the Create menu has no "New group"), a credential vault (the secret card has no "Save to Vault" switch), "Manage other Bots", and a saved payment method (see §3.4).

## 3. Target permission model

### 3.1 One global mode

Settings → **Approvals**, one control:

| Mode | Helper | 
| --- | --- |
| **Auto** (default when a usable model exists) | "A model approves routine actions and asks you about the rest." |
| **Ask** | "Asks before sending, spending or changing anything." |
| **Never ask** | "Asks only before purchases, sharing your data and the first use of your Mac. Only Block rules apply." |

- With no usable model, Auto is hidden and the mode is Ask.
- There is no per-Bot mode. Every Bot follows the global mode.
- A workspace follows the global mode unless the person chooses **Customize** in Workspace settings. Only a customized workspace shows the mode chip in its composer.
- Workspace access is separate. "No access" stays as the workspace access setting **Chat only**.

### 3.2 The gate

One pure function, `planActionGate(context, action)`, called by workspace chats, Bot turns, subagents, ACP harness permission requests and `aiden serve`. Order:

1. **Block rule** → refuse.
2. **Purchase or money** → always ask.
3. **Explicit-only tool** → ask. Once only, never judged, never Always.
4. **Never ask** → allow.
5. **Ask rule** → ask.
6. **New destination** → judge in Auto, ask in Ask.
7. **Always-allow rule** → allow.
8. **Consequential** → judge in Auto, ask in Ask.
9. Otherwise allow.

Tool classes (fixed sets in code, not settings):

| Class | Members | Behaviour |
| --- | --- | --- |
| **Exempt** | A Bot's own memory, its home folder, its schedules and wake-ups (subject to deviation b), its subagents, its Bot computer (Lume VM), its browser profile reads | Never asks |
| **Mac** | Shell, files outside a Bot's home or inside a workspace, Computer Use (one grant for all apps, deviation f), ACP harness execute and edit | First use asks in every mode (§3.3) |
| **Consequential** | Today's built-in rule classes (communicate, delete, publish, install), mutating connection tools, browser click and type that submit, forget memory, background jobs, device actions, app-control changes | Step 8 |
| **Explicit-only** | Schedule mutations, MCP server connect, pairing-adjacent actions, whole-Mac folder access, disclosure tools (deviation e) | Step 3 |
| **Held changes** | Hook proposals, access or rule changes | Never applied by the agent. Always a person's Apply / Dismiss. |

Connector and MCP tools are classed by Rakazo's name heuristic: verbs such as send, create, delete, pay are writes; get, list, search, find, read are reads; unknown is a write. A tool declared `readOnly: false` always asks, and a declared read never relaxes anything. Aiden's Bot action classifier (`main/services/bot-rules/classify.ts`) stays as one extra input that can only raise an action to consequential.

**Taint.** Once outside content enters a run (web pages, files, connector data), the first use of a connector not yet used in that run, even a read, and any fetch to a site the person did not name are "new destinations" (step 6). In Never ask, explicit-only tools still ask when outside text could have steered the call.

**Unattended runs** (routines, wake-ups, watches, webhook-style triggers) have nobody to ask. Where the gate says ask, they refuse the step and report it, except in Never ask. The routines switch "Go ahead without asking" is removed from Settings; for people who turned it on it survives as a hidden legacy override with the same effect as today.

**Subagents** get exactly the parent's gate result for the same action, never more. Their four dedicated cards go away.

**Hooks.** A hook `deny` wins over everything. A hook `ask` shows an Allow once / Deny card in every mode. A hook `allow` keeps today's semantics.

**The judge (Auto).** Rubric, taken from Rakazo: pass when the action "plausibly serves what the owner asked for or the bot's job, including steps they did not spell out"; ask only when it "clearly goes beyond that and would be hard to undo: messaging people the owner did not mention, spending money, deleting, or publishing, when nobody asked for it".

- Fails closed: on error, timeout or an unsure verdict, a consequential action shows the card.
- Model: the chat's own model and provider, so nothing reaches a destination the turn was not already using. Advanced can name a different approval model, including a local one. Aiden never picks another provider itself.
- Cost: one short call per judged action (action, the person's request, the Bot's job). Verdicts are cached per effect within a run. Spend counts toward the spending limit and shows in usage.
- The judge passes or defers. It never denies silently and never writes a rule.

### 3.3 One card

| Card | Title | Buttons |
| --- | --- | --- |
| Generic | "Review before {tool → target}" | Allow once / Always allow this tool (or Always allow {site}) / Deny |
| Explicit-only | Same | Allow once / Deny |
| Mac, shell | "Run on your Mac?" with the command | Allow once / Allow in this workspace (workspace chat) or Allow in this chat (Bot chat) / Deny |
| Mac, files | "Change files on your Mac?" with the path or diff | Same |
| Mac, Computer Use | "Use your Mac with Computer Use?" (one grant covers every app) | Same |
| Batch | "Approve this plan?" with one row per action | Allow once / Always allow (saves one rule per action) / Deny |
| Held change | "Update instructions?", "Add this hook?" with the diff or command | Apply / Edit (where it makes sense) / Dismiss |
| MCP connect | "Connect MCP server “{name}”" with the launch command | Approve / Not now |
| Payment | Receipt card | Allow once / Deny |

Rules for every card:

- Arguments are listed `key: value`, short values first, so recipients and destinations are visible.
- Answered cards collapse to a status line: "Allowed once", "Always allowed", "Allowed in this workspace", "Allowed in this chat", "Denied". A stale card reads "No longer active".
- Parallel calls that need approval share one card. A denied action is not asked again in the run. A pending card never blocks the chat; new messages still run.
- Only the run's owner can press Always.
- "Allow in this workspace" and "Allow in this chat" are persisted, listed on the rules page and removable. Whole-Mac folder access stays Allow once / Deny.
- Aiden Live voice answers Allow once only, as today.

### 3.4 Take control, secrets and money

- **Take control** replaces the hand-off card and the rule behaviour "Hand off to me". The Bot calls the take-control request; the Needs-you slot shows "Needs you" with **Take control**, then **I'm done** / **Skip**. Sign-ins and 2FA use it.
- **Secrets** use an inline secret card that shows the HTTPS origin. The value never reaches the model. Aiden has no vault, so there is no save switch.
- **Money.** Purchases always ask. Aiden has no saved payment method today, so a purchase is a take-control step; the receipt card ships with any future payment feature.
- **Spending limit.** One limit for the Mac, shown only once a metered provider is connected. Existing per-Bot limits stay as overrides and remain editable where they exist.

### 3.5 Rules page

Settings → Approvals, under the mode. Three groups: **Always allow**, **Always ask**, **Blocked**. Each row has an Allow / Ask / Block segmented control and Remove. **Add rule** opens a searchable tool picker. A natural-language rule kind ("When a Bot wants to …") is kept, so today's custom Bot rules lose nothing.

- Rules are global to this Mac. A customized workspace has its own copy.
- Resolution: Block wins, else the most specific rule (site > tool > connector).
- In Never ask, rows that are not Block are dimmed because they do not apply.
- There are no new per-Bot rules. Rows migrated from a Bot show that Bot as a legacy scope (§7).
- Lists grow from cards: pressing Always on a card adds the row.
- Mac grants ("Allowed in this workspace / chat") appear in a fourth read-and-remove group.
- Trust anchors that keep their own pages (hook approvals, approved folders, paired devices) appear as link rows.

### 3.6 Mapping of today's 31 surfaces

| # | Surface | Outcome |
| --- | --- | --- |
| 1 | Plain tool card | Merged (Mac card) |
| 2 | Generic summary card | Merged (generic card) |
| 3 | Classifier disclosure | Merged (explicit-only) |
| 4 | Scheduled task | Merged (explicit-only, foreground confirmation kept) |
| 5 | Computer Use access | Merged ("Use your Mac with Computer Use?", all apps); the OS checklist stays with 29 |
| 6 | Form fill | Merged (batch card, one row per field) |
| 7–9 | Subagent write, shell, MCP mutation | Merged (the parent's ordinary card) |
| 10 | Subagent run grant | **Removed**: subagents inherit the parent's gate |
| 11 | Hook proposal | Merged (held-change card) |
| 12 | ACP harness permission | Merged (Mac card) |
| 13 | Invalid privileged card | **Removed**: the card's deny-only error state |
| 14 | Live voice overlay | **Kept**: another modality reading the same card |
| 15 | Bot tool approval | Merged |
| 16 | Bot folder or whole-Mac request | Merged (Mac card) |
| 17 | Bot plan | Merged (batch card) |
| 18 | Hand-off | **Kept**, as Take control |
| 19 | Skill proposal | Merged (suggestion card) |
| 20 | Needs-you issues | Merged (Needs-you slot) |
| 21 | Connect card | **Kept**, as Rakazo's inline Connect card |
| 22 | "Open this link?" modal | **Moved to Advanced**: new installs open links in Aiden's browser; existing users keep their stored choice |
| 23 | Incoming pairing sheet | **Kept**: code match on the host |
| 24 | Native "Approve Home Folder" | **Kept**: host-side trust anchor |
| 25 | "Review connector launch" | Merged (MCP connect card) |
| 26 | Hooks Settings approve, re-approve, run once | **Kept**: the canonical hook list |
| 27 | App-control "Change {X}?" | Merged |
| 28 | "Allow paired-device chat controls?" | **Moved to Advanced**: inline confirmation on the switch |
| 29 | Enable Computer Use dialog and macOS TCC | **Kept**: OS-owned (deviation d) |
| 30 | Live chat-access toast | **Removed**: its sentence moves into Live's first-start step |
| 31 | Android new-chat-from-link consent | **Kept**: guards an external intent |

Counts: **18 merged, 8 kept, 2 moved to Advanced, 3 removed.** What remains is the 8 kept surfaces, the ask card, the suggestion card and the Needs-you slot: 11.

## 4. Target Bot UX

### 4.1 First Bot

Onboarding creates the first Bot silently: a generic name ("Chief"), a random look, empty instructions. The Bots step becomes a handoff into that chat, where the Bot's first message asks what its job is. A failure shows only "Try again". The onboarding copy keeps one sentence on what a Bot is. The feature-gallery tile for Bots is redrawn in `renderer/components/onboarding-art/` to show this chat, with its art test.

### 4.2 New Bot

The Create (+) menu has **New bot** and **Templates**.

New bot is one field: a large avatar preview, the input "Name your Bot", a colour and shape picker with a random default, Cancel / Create. Return submits. There is no model picker, help field or connections step. If no model is connected, Aiden asks for one first, as Rakazo's mobile app does. The Bot writes its own description and first instructions while it has none.

### 4.3 Templates

The four starters (`renderer/shared/bot-presets.ts`) become Templates: a modal grid of cards, each with a faded sample of its output. The detail view has **Create bot** (or **Open** if it exists), the sample, an **Adds** accordion (Instructions / Skill / "{schedule}, paused until you turn it on") and **Works with** apps, each with a Connected check. Templates are versioned, so a stale preview refuses to create. Routines start paused, nothing is connected automatically, and creating a template twice opens the existing Bot.

### 4.4 Settings in the side panel

The separate Profile and Advanced pages go away. Clicking the Bot's name opens the existing workbench (`renderer/main/bots/bot-workbench.tsx`).

- **Header:** avatar (colour, shape, photo in a popover) and the name, read first and edited on click.
- **Tabs:** Activity · Files · Memory · Routines · Browser · Computer · **Advanced**. Routines holds scheduled, event, watch and wake-up routines in one list.
- **Advanced tab**, in Rakazo's order: Notifications (one switch, "When it finishes or needs input") · Open work · Memory · Model and Thinking (Thinking only when the model has levels) · Computer · Permissions ("Daily check-ins on unfinished work", "Can message other Bots") · Replies · Instructions (with history) · "How other Bots see it" · Tools ("Disable a tool") · Export / Clear.
- **Save model:** switches save at once. Model, computer, name and description batch behind a sticky Save that appears only when something is dirty. This removes the draft toolbar and the "Discard changes?" guards.
- **Menu:** the Bot ••• menu is Pin, Pause, Delete.
- **Phones:** Rakazo's two levels. A Profile hub (avatar, name, Edit, chevron rows for Routines "N on", Files, Computer, a Notifications switch, actions in the native header menu), then Chat settings (Notifications, Open work and Memory cards with "Show more", and a collapsed **Advanced** row that opens when a deep link targets the model).

### 4.5 Tool activity

Tool activity is hidden by default. One per-device switch, Settings → General → Advanced → **Show tool activity**, turns it on; it folds to one line when the run ends. The per-Bot chat-activity levels are removed (§5).

### 4.6 Settings from chat

`update_bot` can change name, description, look, daily check-ins, notifications, instructions, model (only among providers already connected), thinking level and voice. With no fields it reads. It changes things only when the person asks.

- In a turn the owner started, the change applies at once and the chat shows "Instructions updated" or "Settings updated" with **Undo** (compare-and-swap; after Undo the card reads "Restored").
- In a run the owner did not start (a routine, another Bot, Telegram), the change is held: "Update instructions?" **Apply / Edit / Dismiss**. It is also held in the owner's own run when the conversation already read outside content (the same history taint the Auto judge uses), and whenever it turns daily check-ins on or raises notifications a day.
- UI only, never from chat: credentials, disabled tools, Bot management, Bot messaging, computer mode, approval mode and rules, hooks. "A Bot never widens its own powers from chat." This keeps `.memory/agent-config-write-protection.md` intact.

### 4.7 Chat cards

| Family | Replaces |
| --- | --- |
| Ask card (§3.3) | Both approval cards, access request, plan, form fill, hook proposal, connector launch |
| Take control | Hand-off |
| Connect card (logo, name, **Connect** → "Connected") and secret card | Connect card variants, sign-in prompts |
| Suggestion card (Add / Not now) | Routine, skill and lesson proposals |
| Receipt line | Learned, Tidied, Memory updated, Settings updated, wake-up chip, routines skipped |
| Status card (one slot, highest priority wins) | Usage limit, spending, paused, interrupted, model error, saved Resume |
| Question | A–E question, answered in the Needs-you slot |

- **Needs-you slot:** one slot above the composer holds everything waiting on the person, one item at a time with "1 of N", ordered take control, ask card, question. It feeds the Inbox sidebar's "needs you" state.
- **Suggestions** are limited in the prompt as well as the UI: a Bot mentions a missing app once, and one suggestion is visible per chat. "Why not?" becomes an optional link on the dismissed line.
- A connected app is usable by every Bot. Connecting is never per Bot.
- **Bot messaging** is the one name on every platform. The global switch lives under Approvals → Advanced; per Bot it is the Permissions switch plus the approved-pairs row.

## 5. Advanced settings

Where each current capability goes:

| Today | Goes to |
| --- | --- |
| Workspace Full / Ask / No access | Global mode; Workspace settings → Customize; access "Chat only" |
| Tool approvals tab, per-Bot "Allowed without asking", Bot folder grants | Rules page (legacy-scoped rows) |
| Bot Rules: 5 built-ins | The gate's consequential set. A built-in set to "Hand off to me" becomes an Always-ask row with a row-menu option "Do it myself" (take control). |
| Bot Rules: custom rules | Natural-language rows under Always ask or Blocked |
| Locked rules (passwords, 2FA, money) | Code constants in the gate, shown as a locked note on the rules page |
| Bot access Everything / Only what I choose | Bot → Advanced → Tools → "Disable a tool" |
| Bot model, model for photos, routine models | Bot → Advanced → Model and Thinking |
| Interruptions (quiet hours, notifications a day) | Bot → Advanced → Notifications → "Quiet hours" row |
| "Let {Bot} set its own wake-ups" | Bot → Advanced → Permissions → "Daily check-ins on unfinished work" |
| Bot messaging direction switches and pairs | Bot → Advanced → Permissions |
| Telegram connect | Bot → Advanced → Replies |
| Subtitle | "How other Bots see it" |
| Health "Check now" | Bot → Advanced → Model and Thinking |
| Bot computer set up, reset, remove | Computer tab and Advanced → Computer |
| Erase memory, delete | Advanced → Export / Clear, and the ••• menu |
| Computer Use "always allow in every chat", Reset chat permissions | Approvals → Advanced (legacy switch, shown only if it was on), rules page |
| Agent app actions policy, Paired-device chat controls, scheduled-task defaults, Live approval-by-voice, link opening, approval model | Approvals → Advanced |
| Hooks, Connectors, Connections, Computers & VMs | Unchanged pages, linked from the rules page |

**Removals**, with reasons:

| Removed | Why | What remains |
| --- | --- | --- |
| Per-Bot chat-activity levels (Quiet / Summary / Detailed) and status-line choice | Tool activity is hidden by default; one per-device switch replaces three per-Bot levels | "Show tool activity"; the Activity tab |
| Routines "Go ahead without asking" switch | Never ask covers it | Hidden legacy override for people who had it on |
| Per-Bot Rules UI and per-Bot access picker | Replaced by the gate, the rules page and "Disable a tool" | Every stored rule and scope, as legacy rows |
| Per-Bot spending limit as the primary control | One limit for the Mac | Existing per-Bot limits as overrides |
| Plan card, subagent cards, form-fill card, hook-proposal card | One card model | Batch and held-change variants |
| Profile and Advanced pages, their draft toolbar and Discard guards | Side panel and sticky Save | Every field, in the Advanced tab |
| Create step 2, help field, model picker on create, starter carousel | One field; Templates | Connect cards, Instructions, the model row |
| Onboarding Bots carousel step | Silent first Bot | Templates in the Create menu |

## 6. Cross-platform

- **One backend card model.** The host projects every pending ask as one typed card (kind, title, arguments, buttons, status). Desktop, iOS and Android render the same thing.
- **Answerable on every client:** every card in §3.3, including Mac cards with the full command, MCP connect with the launch command, and hook proposals with the full hook. Suggestions, held changes and Undo too.
- **Host only:** macOS permission prompts (TCC), the pairing code match, and Approve Home Folder.
- **Push** has no action buttons. "{Bot} needs approval" opens the chat. It reaches the owner even when the chat is snoozed.
- **Messaging apps** (Telegram) never answer approvals. Answers are entered in the app.
- **Optimistic phones.** A tap collapses the card to its status line at once and rolls back with a toast if the host refuses. Lists show skeletons while loading.
- **Remote protocol.** Each phase that changes the wire claims the next Aiden Remote revision at merge and updates the iOS, Android and fixture contracts together. Old clients see unknown kinds as today's summary-only card.
- **Android** uses the `ui/theme` M3 Expressive layer, verified on a headless AVD. **iOS** follows the tab shell.
- **`aiden serve`** bundles the gate from `main/services`. `aiden bots approvals|approve` keep working. With no approval model configured the server runs in Ask, and unattended runs refuse instead of asking.

## 7. Migration

Principle: no stored grant gets a wider owner, key or lifetime, and no existing user starts being judged by a model without choosing it. Phase 1 records a decision table from the old code as the oracle.

| Stored today | Becomes | Note |
| --- | --- | --- |
| Install with any workspace or Bot in use | Global mode **Ask** | Deviation (a). The nudge offers Auto. |
| Fresh install with a usable model | Global mode **Auto** | Ask when no model |
| Workspace Ask first | Follows global (Ask) | No change |
| Workspace Full access | Customized: **Never ask**, with shell and files "Allowed in this workspace" | Same reach as today |
| Workspace No access | Access Chat only | |
| Tool rules `always` (per workspace) | Always-allow rows scoped to that workspace | Same file and keys; the workspace is marked customized only for its rules |
| Tool rules `chat` (in memory) | Nothing | They ended at quit already |
| Computer Use chat grant | "Allowed in this chat", any app, legacy row | Not widened to the workspace |
| `computerUseAlwaysAllow` | Legacy "everywhere" row and Advanced switch | Not offered to new users |
| Per-Bot allow-list rules | Always-allow rows with that Bot as legacy scope | Receipts, tombstones, tallies and the 50-rule cap preserved (`.memory/bot-allowed.md`) |
| Bot folder grants (`bot-folder-grants.json`) | Mac-files rows with that Bot as legacy scope | |
| Bot built-in rule set to Hand off to me | Always-ask row with "Do it myself", legacy-scoped to that Bot | |
| Bot custom rules | Natural-language Always-ask rows, legacy-scoped to that Bot | Only tighten, as today |
| Bot access "Only what I choose" | Disabled tools = everything the Bot did not have; its folders as legacy Mac-files rows | Exactly its current reach |
| Bot access "Everything" | No disabled tools | |
| Per-Bot spending limit | Per-Bot override | |
| Routines "Go ahead without asking" on | Hidden legacy override | Off for everyone else |
| Per-Bot chat activity level | Dropped; "Show tool activity" on for that device if any Bot was Detailed | |
| Link choice, approved folders, hook approvals, MCP launch fingerprints | Unchanged | |

Nothing is copied between owners. A legacy-scoped row answers only for its original Bot or workspace. Stored formats stay readable by the previous release. Because today's cards for exempt tools (a Bot's memory, subagent grants) stop appearing, a one-time "What changed" note in Settings → Approvals lists them.

## 8. Phased rollout

Every phase updates the docs it makes stale in the same PR (`README.md`, `PRODUCT.md`, `docs/bot-rules.md`, `docs/bot-access-requests.md`, `docs/bot-routines.md`, `docs/settings-design-system.md`, `docs/devices.md`, `docs/aiden-remote-api-v1.md`, `docs/analytics.md`, `packages/cli/README.md`, this plan's index row, `.memory/`), registers new tests in `package.json` and `scripts/ci-test-registry.json`, checks both native clients when a shared contract or transcript UI changes, and attaches light and dark screenshots of every changed surface for owner approval. UI work reviews `docs/chatgpt-desktop-ui-inspiration.md` and the specimen first, and keeps: no borders on choice cards, no focus ring on text inputs, no brain icons.

**Phase 1. One gate, one card (desktop, behaviour preserved).**
Scope: extract `planActionGate` from `main/services/llm-client.ts:4298-4342` and the Bot approval paths, in Rakazo's order, configured to reproduce today's decisions. One card component with Rakazo's titles, buttons and status lines for both chat kinds. Shared parallel card, no re-ask after Deny, non-blocking. Registry events `approval_shown` and `approval_answered` (enum properties only).
Areas: `llm-client.ts`, `tool-approval.ts`, `coding-tools.ts`, `bot-rules/`, `renderer/components/chat-approval-card.tsx`, `renderer/main/bots/bot-chat-pane.tsx`, `main/services/analytics/analytics-events.ts`.
Tests: decision table recorded from the old code (about 200 context and action pairs) asserted against the gate; rendered card tests per kind; analytics registry test.
Risk: medium. Metric: baseline prompts per 100 turns.

*Phase 1 notes (where the plan met the code):*

- The gate (`main/services/approval-gate/gate.ts`) is pure and fact-based. Reads that cost something (a remembered workspace approval, a plan's cover, a Bot's allow list) come back as `lookup` at the step that needs them, and the caller asks again with the answer, so no read moves earlier than it used to. Today's workspace access stands in for the global mode until Phase 2.
- Two pre-approvals that the plan files under "never ask" sit there: Full access, and the legacy routines "Go ahead without asking" switch (which may answer a rule's ask but never a hand-off, so hand-off rules are step 2). A plan's cover is also step 4. Computer Use on the Mac is never pre-approved there.
- Subagent exact cards (a subagent without an implementer run grant) keep their own flow until Phase 2 removes them; the run grant itself goes through the gate.
- Shared parallel cards live in `ToolApprovalCoordinator` for run-scoped cards, and only for a call its caller names exactly: `toolCallApprovalEffect(tool, canonical arguments, browser tab fingerprint)`. Card text is not enough (a browser card names the page, not the script; an MCP card can be just the tool name). llm-client names the generic tool card and the Computer Use hook-ask card; memory, hook, subagent, ACP and Computer Use access cards are never shared. Bot waits carry their own durable ids plus one-way `argumentsHash` and `runHash`, so a Bot chat groups waiting prompts in the renderer only when both match; one answer goes to each wait id, and only the waits it decided leave the card.
- No re-ask after Deny is per stream in the coordinator, under the same named effect (cleared when the run's stream is released), and, for Bots, in memory per reply (keyed by tool, summary and arguments). Neither survives a restart.
- The card's "No longer active" line shows for a Bot card withdrawn while shown here. A workspace card that ends with its run still just leaves.
- The analytics property naming the chat is `chat`, not `surface`: every event already carries a `surface` super property (desktop or server).
- Phones are unchanged and keep their own headlines ("Run this command?") until Phase 6; the Remote approval projection is unchanged and needed no protocol revision.

**Phase 2. Mode and Auto.**
Scope: global Ask / Auto / Never ask, workspace Customize, composer chip only when customized. Tool classes, name heuristic, exempt set, Mac cards with their scopes, taint tracking, unattended refusal, the judge and the approval-model setting. Mode migration (§7). Repeat-approval nudge offers Auto.
Areas: the gate, new `main/services/approval-judge/`, `config-store-core.ts`, Settings Approvals, Workspace settings, composer chip, `packages/cli`.
Tests: gate order table (one case per step and per class); fail-closed table (no model, timeout, error, unsure, tainted run, unattended run); name-heuristic cases including unknown and `readOnly: false`; migration fixtures proving no existing install lands on Auto and Full workspaces keep their reach; a replay set of recorded actions with expected pass or defer; spend accounting.
Risk: high (safety). Metric: prompts per 100 turns in Auto versus Ask; deferral rate; zero judged explicit-only actions.

*Phase 2 notes (where the plan met the code):*

- The mode lives in `renderer/shared/approval-mode.ts` (`effectiveApprovalMode`, `workspaceApprovalPolicy`, `workspaceApprovalPatch`) and is read fresh before every call. Main treats a run as having a usable model (it has one), so only the renderer hides Auto.
- Migration (§7) runs once at seed (`ensureApprovalModeSettings` in `config-store-core.ts`) and records `approvalModeOrigin`. An upgraded profile (`webSearchProfileKind: "upgrade"`), a finished onboarding, a `lastProviderId` or any real workspace means "in use" and writes Ask; anything else stays unset (Auto once a model works). `aidenDirMigratedAt` is set on every profile, so it is not evidence. A value that isn't a mode reads as Ask, never Auto, and so does an unset mode without the seed's `fresh` marker (settings that were never seeded, such as an unreadable file, may belong to an install in use).
- A legacy Full workspace is not rewritten at startup, so the previous release still reads Full. It is read lazily as customized Never ask with shell and files granted. The first change from Workspace settings writes `permission: "ask"` plus explicit `approvalMode` and `macGrants`, which an older release reads as Ask (narrower). An older client (a phone) choosing Full clears the own mode and grants and gets the legacy reading back. Phones still see and set only `permission`. The projected `permission` is the tier that never reads narrower than what runs (`legacyWorkspaceTier`: Chat only is none, Ask with no grants is ask, anything else is full), and a phone choosing Ask sets the workspace's own mode to Ask and clears its grants. The wire shape and protocol revision are unchanged. Saving a different global mode notifies workspace observers, so the host feed sends phones the new tier at once.
- Mac class: `run_command`, `write_file`, `edit_file`, `computer_use`, `form_fill`. Under a mode the Mac card offers Allow once and **Allow in this workspace** (new desktop-only approval scope `workspace`, a class-wide grant saved on `Workspace.macGrants`); the host strips that scope from every Remote projection (phone stream approvals, and the phone, observer and controller run projections) and refuses a Remote answer that names it (`parseRemoteToolApprovalScope`), so a phone or paired Mac answering a Mac card sees only the scopes it can use. Old exact-command and file-path rules are still read. Computer Use keeps its Phase 1 access card and chat grant; there is no workspace Computer Use grant yet.
- Connector and MCP name heuristic (`tool-classes.ts`) applies to a workspace chat's direct MCP tool calls when modes are in use. Codemode-lane MCP calls do not pass `beforeToolCall` and are not classed yet (gap, unchanged from before). Bot connection tools keep their own classification.
- Taint (`run-taint.ts`): outside content is a web fetch or search, any browser tool but resize and appearance, a device screenshot, a subagent's report, a pull request's comments, codemode, or any connector result. Workspace files, attachments and shell output do not taint (a command that fetches runs only on the person's shell grant). A new destination is the first use of a connector in the run, or a fetch to a host the person did not name in this run's messages (subdomains of a named host count as named). Hosts named mid-run by steering are not added, which only causes more asks. A run's starting taint reads the chat journal's whole branch (`runTaintHistoryOfBranch`), the same read that builds the model context, so tool results a compaction folded away still count; a summary whose source isn't on the branch (a compaction with nothing before it, a fork's branch summary) counts as outside content, and a journal that can't be read stops the run before any tool call (Phase 3 review). A history result whose name has the connector `<server>__<tool>` shape counts whether or not that connection is still configured (`hasMcpAgentToolNameShape`), so a removed or renamed connection's earlier read still taints. Accepted trust choice: like a workspace's files, a Bot's memory and notes don't taint, so content a tainted conversation saved there can reach a fresh conversation untainted; the same holds for a file a tainted workspace run wrote.
- The judge (`main/services/approval-judge/`) is wired for workspace chats only. Bots in Auto have no judge yet and fail closed to the card, so Auto equals Ask for Bots (Phase 3 added the Bot judge; see its notes). ACP harness runs have no judge either (their model is the agent's). A judge call uses the chat's runtime (or the Advanced approval model), temperature 0, 8 output tokens, 12 s, no retries, and is recorded in usage as `approval-judge` and counted toward the chat's spending limit even when it fails after a reply. Failures are not cached; a verdict is cached per effect for the run. A remembered exact action is read before the judge, so it never costs a call.
- Exempt (a Bot's memory, routine notes, wake-ups, subagents, Bot computer) skips only the default consequential card: an Ask first rule the person wrote still asks for it.
- Unattended refusal applies to Bot routine runs (`attendance: "routine"`). Telegram and mixed turns keep today's handling, and workspace scheduled runs already settle approvals as unavailable. The decision table changed five Bot routine rows from ask to the refusal ("purchase click", "plain click" and "send email", with and without the go-ahead switch), each marked "Phase 2" in `decision-table.test.ts`. Computer Use and connection sends in a routine now refuse instead of waiting under Needs you.
- In Never ask a Bot's Ask first rules no longer apply ("Only Block rules apply"); legacy Full access never answered a Bot's rule, and that legacy reading is kept for chats that predate modes.
- Not done in Phase 2, kept as today: subagents still use their own cards and get the parent's legacy access (`legacyAccessOf`: Full only for Never ask with shell and files granted); ACP permission requests use the same legacy access. Wiring them to the parent's exact gate result needs the per-call gate to cross the subagent boundary, which Phase 1's subagent cards do not expose safely. The repeat-approval nudge does not offer Auto yet: the only nudge is the Bot allow-list one, and Auto does nothing for Bots until the Bot judge exists (both landed in Phase 3). The Bot Mac card's "Allow in this chat" scope waits for Phase 3's allow-list collapse.
- `aiden serve` runs in Ask, as §6 says for a server with no approval model: its Bot host uses the shared gate with mode Ask, so routines refuse instead of asking, and its workspace chats keep their `full`/`ask`/`none` tiers, which equal Never ask with shell and files granted, Ask, and Chat only for the CLI's shell and file tools.
- Analytics: `approval_mode_changed` (`mode`: ask, auto, never or global; `scope`: global or workspace), and `approval_shown` / `approval_answered` gained the `auto` and `never` modes.

**Phase 3. Rules page and the Bot collapse.**
Scope: rules page with three groups, Add rule, natural-language rule kind, Mac-grant group. Bot Rules UI, allow-list page and access picker replaced; "Disable a tool"; take control replaces hand-off; one spending limit. Legacy-scoped migration.
Areas: `main/services/tool-approval-rules.ts`, `bot-rules/`, Bot access stores, `renderer/components/settings/bots-settings.tsx`, `renderer/main/bots/bot-rules.tsx`, `bot-allowed-page.tsx`, `bot-advanced.tsx`, `bot-panel-handoff.tsx`.
Tests: resolution (Block wins, site > tool > connector); legacy scope answers only for its owner; Custom-access Bot reach is identical before and after (fixtures); allow-list tombstones still prevent resurrection; register-and-invoke IPC for list, change, remove; Playwright from a card's Always to the row to Remove.
Risk: high (stored authority). Metric: grant pages 6+ → 1; per-Bot permission controls → 1 list.

*Phase 3 notes (where the plan met the code):*

- The page's own rules live in `approval-rules.json` (`main/services/approval-rules/store.ts`, a `DataStore`, at most 500 rules and 512 KiB), a new device-local file, so the previous release reads every older file unchanged and simply ignores the new one. The model and resolver are `renderer/shared/approval-rules.ts` (`resolveApprovalRule`): Block wins anywhere, then site > tool (an Aiden tool or one connector tool) > whole connector; a rule a workspace or Bot owns answers only for that owner and beats the Mac's at equal specificity. Words ("When a Bot wants to …") are Bots only and never Allow.
- The gate gained `pageRule`: Block refuses at step 1 in every mode (reason `rule`); Ask asks at step 5 with Allow once (and refuses unattended as `unattended-rule`), and is skipped in Never ask; Allow passes at step 7 but never for the Mac class. Workspace chats read it in `llm-client.ts` (`pageRuleFor`) on every call, so a Block applies wherever the workspace gate runs, including a Bot-bound call and a call with no approval port; Allow and Ask apply only where the chat can show a card. Bots read it in `bot-tool-assembly.ts` through the `pageRules` port (the Mac's rules plus that Bot's own). A Bot's own built-in Ask rule still asks under a page Allow, and a page Ask on a step the Bot would otherwise run adds a "Rule · <rule>" card. Worded Ask rules join the Bot's prompt and classifier as synthetic custom rules; worded Block rules are enforced by the classifier but not yet described in the prompt.
- Site rules match calls that carry the site in `args.url` (navigate, fetch), a Bot's browser actions on a page with that address, and a workspace chat's browser actions on the address its tab shows at that moment (`workspaceRuleHost`).
- An `approval-rules.json` this release can't read back exactly (it doesn't parse, holds a newer version, a rule it can't read, or a duplicate) is never read around and never written over, since its Block rules may be the ones Aiden can't see (`file-store.ts`). The book reports it unreadable: the gate's `pageRule: "unreadable"` asks once in every mode at step 3 (never judged) in workspace chats for every call but `ask_user_question` (reads included, since a newer release's file can Block any valid tool name); Bots refuse the call. The page hides every rule, says so, and offers **Try again** (re-read) or **Start over** (the file is renamed to `approval-rules.json.unreadable-<stamp>`, never deleted). Rule text counts code points and refuses only control and bidi characters, so an emoji sequence survives; duplicates in a file this release wrote keep the stricter rule.
- Converting a row is lossless: a Bot's allowance changed to Block adds the Block first and removes the allowance only once it is saved, and a worded rule, an allow-list site or tool that the book can't store as written is refused with the original kept. Turning a Bot's site allowance into Block asks first, because a Block covers the whole site and its subdomains, not only the page that was allowed.
- Disclosure tools (`share_image`) are explicit-only for Bots: they ask in every mode, Never ask and Auto included, and under a page Allow; only Block skips the card. The Add rule picker offers them Ask and Block only, and the book refuses an Allow for them. The decision table's "share image | approval | routine | go ahead" row changed from allow (go ahead) to block, marked "Phase 3".
- Deleting a Bot or removing a workspace forgets the page rules that owner had (`forgetOwner`); the Mac's rules stay.
- Hand-off rows (Do it myself) are not dimmed in Never ask, because a hand-off still reaches the person there.
- The Bot Auto judge (`bot-approval-judge.ts`, the `judge` port of `bot-tool-assembly.ts`): in Auto, a Bot's consequential step, or a step only an unlocked built-in Ask rule for communicating, deleting, publishing or installing names, goes to the approval model named in Advanced, else the Bot's own model. It reads the Bot's instructions as its job and the owner's request, with arguments redacted as for workspace chats. The owner's request is only words the owner wrote (`bot-owner-request.ts`): the person's own message, or the prompt of a routine they accepted. A run whose inputs carry anything else (an event's payload, the notes a routine kept, a wake-up the Bot set, another Bot's message, Telegram, a peer or a self-introduction) is never judged, since that text could pass someone else's instructions off as the owner's. Telegram stays unjudged for now (fail closed), so a Telegram-started Bot run in Auto still shows its cards. An accepted routine's prompt counts as the owner's words even when the Bot proposed it; `docs/bot-rules.md` tells people to review a proposed prompt before accepting. Verdicts are cached per effect within a run (a run is the inputs it serves, so every step of one turn shares them; the effect includes the Bot browser's target page, and a call with no run identity falls back to its own call id). It fails closed: no model, an ACP agent, an error, a timeout, an unsure reply, or a run that has already read outside content shows the card. Outside content for a Bot is everything that taints a workspace run, plus its own computer and shell, its browser and `inspect_image`. A result already in the conversation's history is classified by its name alone (`botHistoryToolTaints`), so a connection removed or renamed since still counts, and any name not on a short list of the Bot's own harmless tools (memory, notes, questions, hand-offs, plans and its file tools) counts too; taint is read from every tool result the Bot's conversation has committed (`contextToolNames`, scanned once from the start and then incrementally), earlier turns and compacted history included, since the model's context or a compaction summary may still hold that content. So a turn after one that read the inbox, or a resumed or restarted run, stays tainted, and a conversation that can't be read counts as tainted. Explicit-only and disclosure tools, the Mac class, purchases, hand-offs, rules the person wrote and page rules are never judged, and neither is a built-in rule on a Bot's exempt tools (its computer and shell): exempt calls never reach the judge, so the rule keeps its card, and an unattended routine refuses it. With no judge available a rule's card stays. An unattended routine still refuses a step the judge would ask about. Each call is recorded in usage as `approval-judge` and, when it costs money, counted against the Bot's (and a routine run's) spending. `aiden serve` passes no judge, so its Bots stay in Ask. Tests: `bot-approval-judge.test.ts` (fail-closed table, cache per run, spend, replay set) and the Auto rows of `bot-tool-assembly.test.ts`.
- The repeat-approval nudge offers Auto (deviation (a)): a Bot card that shows the repeat count, and a workspace card whose plain action was allowed three times in that workspace since Aiden opened (counted in the renderer only, `renderer/lib/switch-to-auto.ts`), offer **Switch to Auto** while this Mac is in Ask and a model could judge (a provider that runs only inside an agent runtime doesn't count). The offer shows only on a card main marks `autoWouldJudge`: the same call in Auto would reach the judge step (`workspaceAutoWouldJudge` for workspace chats; the Bot gate's own judging conditions for Bots). So a command, a file change, a background job, a saved device screenshot, sharing or creating an image, a purchase, a Bot's shell, a rule Auto can't judge, a tainted run or one whose inputs aren't only the owner's never offer it, and only such cards count toward the workspace tally. The flag is desktop-only; Remote and phone projections copy named fields and leave it out. Switching saves the global mode through `settings:set`, so it records `approval_mode_changed` like Settings → Approvals, and the toast says the card on screen still needs an answer. A workspace with its own mode or Chat only and a paired host's card never offer it.
- Legacy (§7) is a projection, not a copy (`rules-page.ts`): a Bot's allow list (Always allow, that Bot), its worded rules (Always ask, that Bot), a built-in rule set to Hand off (Always ask with Do it myself), a workspace's remembered exact commands and files (Always allow, that workspace), a Bot's selected folders and a workspace's `macGrants` (Allowed on this Mac). Every change and Remove goes through the row's own store, so the allow list's receipts, tombstones, tallies and 50-per-Bot cap are untouched. Allow → Block on a Bot's allowance removes it there and adds a Block owned by that Bot. Tests: `main/services/approval-rules/rules.test.ts` (resolution, owner-only answers, gate steps), `main/handlers/approval-rules.test.ts` (register-and-invoke list, picker, add, change, remove; legacy rows reach their own stores; forged input refused), `renderer/main/bots/bot-access-draft.test.ts` (Custom reach unchanged through the new Tools screen), `renderer/components/settings/approval-rules-settings.test.tsx` (rendered page), `tests/e2e/bot-access-requests.spec.ts` (a card's Always becomes a row and Remove takes it away).
- IPC: `chat:approvalRules:list|picker|add|change|remove` and the `chat:approvalRules:changed` broadcast; Bot ports exist only where the host offers Bots.
- Bot collapse: the Profile's Rules group, allowed list and `?page=allowed` (now a redirect) are gone, as are Always comes to you and the allowed list in Settings → Bots. Advanced's Everything / Only what I choose picker became **Tools** with **Disable a tool**: stored access is unchanged (Full stays Full until a tool is turned off, which writes Custom with every available tool, the whole Mac or every approved folder, and web search as it was; web search alone is its own switch on Full).
- Take control is single-stage in this phase: the hand-off and sign-in cards read "Needs you: …" (sign-ins keep "Sign in to <site> for <Bot>") with **Take control**, Skip and **I'm done**; Finish on <Mac> stays. The two-step Needs-you slot belongs to Phase 4. The model-facing `sign_in` and `hand_off` tool descriptions are unchanged, and phones keep their labels until Phase 6.
- Spending: the Mac's limits and a Bot's Profile override show only once a hosted provider with an API key is connected (`meteredProviderConnected`), or when a limit is already set. A single Mac-wide total across every chat and Bot is not built: it needs a new ledger dimension and refusal kind that reach the phone wire, so it waits for Phase 6. Settings' per-chat, per-Bot and per-routine limits are the Mac's limits for now.
- Not done in Phase 3: the Bot Mac card's "Allow in this chat" has no store yet, so the page cannot list it (per-chat Computer Use grants keep "Reset chat permissions" in Settings → Computer Use); plan coverage does not know page rules, so a plan step a page rule asks about falls back to its card. Phones and Remote are unchanged (no protocol revision); `aiden serve` neither reads nor writes `approval-rules.json`.

**Phase 4. Chat cards.**
Scope: Needs-you slot, batch and held-change cards, Connect and secret cards, suggestion card with prompt-level limits, receipt line, single status slot, tool activity hidden with the per-device switch.
Areas: `bot-chat-pane.tsx` and card components, proposal schedulers in `main/services/bot-runtime/`, Bot prompts, Settings → General.
Tests: slot ordering and "1 of N" as rendered behaviour; suggestion budget with a fake clock; Playwright pile-up scenario showing one slot; activity hidden by default and shown by the switch.
Risk: medium. Metric: cards above the composer 4+ → 1; card types 23 → 7.

*Phase 4 notes (where the plan met the code):*

- **Needs-you slot** (`renderer/components/bots/needs-you-slot.tsx`): one slot above the composer in a Bot chat on this Mac and on a paired Mac, ordered take control, approval, folder or Mac request, plan, question (equal kinds oldest first). With more than one item a header reads "Needs you · 1 of N" with Previous and Next inside a `nav` named "Needs you", and a polite live region (mounted with the chat's footer, empty until then) announces "Needs you, i of N" only when the item on show changes. The item on show stays put: an arriving item only raises the count, so a half-answered question keeps its typed answer. When the item on show is answered the slot moves to the first in priority order, and if this window's focus was inside the slot when the card went (the answer came from here), focus moves to the next card's heading or group, or to the composer when nothing is left (`NeedsYouFocusScope`). An answer from a phone or another window while focus was elsewhere, or on nothing, moves no focus. An approval group keeps one key while its prompts change (`botApprovalGroupKey`). The slot only arranges: every card keeps its answers and wire format. It does not yet feed the Inbox sidebar's "needs you" state, and a Bot's open issues stay where they were (they are not asks).
- **Take control in two steps** (§3.4): a hand-off or sign-in card first offers **Take control** alone (it opens the page, the sign-in or the Bot's own browser or computer when there is one, or Finish on <Mac>), then **I'm done** and **Skip** with Open again. Pressing Take control moves focus to I'm done (to Skip where that is the only answer). Whether control was taken is kept in memory per card (`handoff-taken.ts`), shared by the chat's slot and the floating Bot panel; a reload starts at Take control again. Wire answers are unchanged (`done`, `skipped`). The `sign_in` and `hand_off` tool descriptions now tell the model the person answers with I'm done or Skip.
- **One ask card** (`AskCard` in `approval-card-parts.tsx`): a folder or Mac request reads Allow once / Deny with "Always for this folder" in More ways to allow; a pending plan is "Approve this plan?" with one coverage row per action, Show details and Allow once / Deny. The plan has no Always: there is no per-action rule store a plan's actions could be saved into, so "saves one rule per action" waits. Approving a plan still writes the same `approve` answer, and Deny writes `not_now`. A hook proposal reads Apply / Dismiss; Edit is left out for now (a proposed hook is reviewed as proposed). No secret card is built: no runtime path asks for a secret in chat today. The workspace approval stack is unchanged.
- **Connect card**: one shape, the app's logo and name with **Connect**, settling to "Connected". When the app is connected but this Bot can't reach it, Connect adds it to the Bot (the former "Add to this Bot" variant). Connections stay global.
- **Suggestion card and receipt line** (`suggestion-card.tsx`, `receipt-line.tsx`): routine, skill and lesson proposals show Not now / Add and settle to one quiet line: "Added Morning brief · Every day at 8:00 AM", "Added skill: …", "Added lesson: …", "Not added: …", "… · replaced by a newer suggestion". "Why not?" is offered only right after the person's own Not now on this device and records the reason once (`bot-routine-proposals.ts` accepts one reason on an already-dismissed proposal that has none). Learned, Memory updated (Open), wake-up (Cancel) and routines skipped while paused (Run now → "Started: …") are receipt lines too. An accepted link routine keeps its Copy link / New link card. Only one suggestion shows in full per chat; earlier ones still waiting fold to "Waiting: {name} · Show".
- **Shared suggestion budget** (`main/services/bot-runtime/bot-suggestion-budget.ts`): a Bot's own routine, skill and lesson suggestions count together, at most 3 shown in any rolling 24 hours per Bot, stored in `suggestion-budget.json` in the Bot's session folder. Only a suggestion actually shown counts. A host follow-up never counts. A routine the person asked for (`requested`) is never blocked by a full window but still counts toward it, and the claim is honoured only in a turn the owner's own message started (`botRunStartedByOwner` in `bot-owner-request.ts`, read from the Bot's execution scope); in a routine, event, wake-up, peer, Telegram or intro run it counts for nothing, so the budget and the back-off apply. A full window returns code `suggestion_limit` with a message telling the Bot not to offer another today and that the person can add one in its profile. A stamp from a clock that later moved back is clamped to now rather than dropped, so it stays counted. Folder reviews are not suggestions. The prompt's honesty rules add: mention a missing app once, and keep suggestions rare; `suggest_connection` says to mention a missing app at most once. Tests: `bot-suggestion-budget.test.ts` (fake clock, clock moved back, asked-for while full), routine-proposal tests that the kinds share the window and that a claimed `requested` outside an owner-started turn is refused, and `bot-owner-request.test.ts`. Note: commit "suggestion card and receipt line" already carries the budget's wiring lines and builds only with the next commit.
- **One status slot** (`renderer/main/bots/bot-status-slot.ts`): below the transcript at most one status card, highest first: model error, spending limit reached, paused, interrupted, usage limit, saved Resume, spending nearing, plan (active or ended). A saved Resume also shows with the interrupted card, since its Resume replays the same request. The active or ended plan moved from the footer into the slot.
- **Tool activity** (§4.5): hidden by default, with one per-device **Show tool activity** switch in Settings → Appearance → Chat (there is no General → Advanced page), stored as `showToolActivity` in the device's appearance settings. It is not mapped onto Work details, which has no hidden mode. Until it is set, a computer where any Bot was Detailed keeps showing steps; a Bot that was Summary loses its finished-turn recaps (a deliberate change: Summary maps to off). On, steps show and fold to one line when the run ends; off, the chat shows none while a turn runs, but a finished turn whose step failed or was blocked keeps its one recap line ("… · 1 blocked"), since that may need the person (`botTranscriptRows`). The per-Bot Chat activity page is removed (an old `?page=chat-activity` opens Advanced), but the per-Bot level and wording stay stored and on the wire, because phones still read them; Phase 6 can drop them. The Bot workbench's Activity tab always shows the full log.
- Phones and Remote are unchanged (no protocol revision); a paired Mac's Bot chat on the desktop uses the same slot, cards and switch. No analytics event changed. Phone copy only: the per-Bot Chat activity page on iOS and Android now says it sets the status line's wording, that each computer's Show tool activity switch decides whether steps show, and that Detailed turns them on for a computer that hasn't chosen; it no longer claims to control the desktop chat. `docs/aiden-on-the-go-remote-access.md` describes the two-step hand-off.
- E2E: `bots-starter.spec.ts` gained the pile-up (a hand-off arrives while a question is half answered: one slot, still on the question at "2 of 2" with the pick kept, Previous brings Take control, Next returns to the question, then Take control and I'm done), and the plan, folder-request, Connect and own-screen hand-off specs follow the new labels. The one Cua Space run for this phase could not create its Space (the container engine failed to extract an image layer), so these specs have not yet run in Linux; CI runs them.

**Phase 5. Bot creation and settings.**
Scope: silent first Bot and onboarding handoff, one-field New bot, Templates, side-panel settings with the Advanced tab and sticky Save, `update_bot` with Undo and the hold path, Bot messaging consolidation, gallery tile and art.
Areas: `renderer/components/onboarding-bots-step.tsx`, `onboarding-feature-gallery.tsx`, `onboarding-art/`, `renderer/main/bots/bot-create-flow.tsx`, `bot-starter-carousel.tsx`, `bot-workbench.tsx`, `bot-profile.tsx`, `bot-advanced.tsx`, `bot-menu.tsx`, `renderer/shared/bot-presets.ts`, Bot tool registry.
Tests: name plus Return creates a Bot; a stale template version refuses; re-creating opens the existing Bot; `update_bot` allowed and refused fields, compare-and-swap Undo, not-owner hold; onboarding art test; Playwright from onboarding to the first Bot message.
Risk: medium. Metric: time and clicks to first Bot message; dialogs ~22 → ~10.

*Phase 5 notes (where the plan met the code):*

- **Silent first Bot** (§4.1, `onboarding-bots-step.tsx`, `botStarter().startFirst`): when Bots are on and the store is empty, the last onboarding step makes "Chief" (random look, the starter instructions, no description) once per install under the first-Bot creation key, so a second run returns the same Bot. The card says in one sentence what a Bot is; a failure offers only Try again, and Finish waits while the Bot is being made. Finishing opens its chat, focused on the composer; its first message comes from the one-time intro and asks what it should help with. "No job yet" is the starter instructions rather than empty ones: the system prompt tells a Bot with them to write its own description and first instructions with `update_bot` as soon as the person says what they want. The gallery tile draws that first chat ("What should I help with?" and an "Instructions updated · Undo" receipt) and its description now starts with the first Bot; the starter carousel is deleted.
- **New bot and Templates** (§4.2, §4.3): the sidebar's + and the empty Bots page open one Create menu (New bot, Templates). New bot is one field with a large preview, the colour and shape picker and Return to create; with no usable model it says so and offers Set up…, creating nothing. Templates are the four presets with a version and a faded sample; the detail lists Instructions and the routine ("…, paused until you turn it on", added paused only when the Bot was really made) and Works with apps (Connected or Not connected; nothing connects by itself). A detail from an older version refuses to create; a template whose Bot exists offers Open. There is no Skill row: no preset carries a skill. `bot_created` gained `source` (new, template, onboarding) in the registry and `docs/analytics.md`.
- **`update_bot`** (§4.6): reads with no fields; changes name, description, look, instructions, daily check-ins, notifications and model among connected providers. Thinking and voice are not offered (there are no per-Bot thinking levels or voice settings to change). Access, tools, Bot messaging, the computer, approvals, hooks and spending are refused. Applied changes show an Instructions/Settings updated receipt with a compare-and-swap Undo that settles to Restored; a change from a run the person did not start is held on an "Update instructions?" card in the Needs-you slot with Apply, Edit and Dismiss. Review fixes: a change is also held when the conversation already read outside content (any committed tool result `botHistoryToolTaints` counts; an unreadable history counts) and when it has the Bot reach out more (daily check-ins on, more notifications a day, or quiet hours that stop covering a minute they did: off, shortened or moved); the card says which, shows the whole proposed instructions in a bounded keyboard-scrollable region with added and removed lines marked against the Bot's instructions as they are now (`botInstructionsDiff`), and says Apply replaces them. Apply merges the Bot's own arguments onto the settings as they are then and writes only the fields the card listed. Writes and Undo are tied to the Bot identity and access revisions they read (`BotSettingsConflictError`; Undo then settles to "changed again since"). A model change on a Bot with no model of its own offers no Undo, since there is nothing to restore.
- **Settings in the side panel** (§4.4): the Profile and Advanced pages and `bot-profile.tsx` are gone. The name pill in a Bot chat ("<Bot> settings") opens the workbench on a new last tab, **Advanced** (`bot-advanced.tsx`, `BotAdvancedTab`), and a show request can carry a section (instructions, quiet hours, model) that the tab scrolls to or opens. Its header holds the avatar popover (colour, shape, Default look, Choose / Remove photo, all saved at once) and the name, read first and edited on click (Enter keeps, Escape reverts, empty says "A Bot needs a name."). Groups, in order: Notifications, Open work, Memory, Model, Health, Computer, Permissions, Replies, Instructions, How other Bots see it, Tools, Spending, Clear. Switches and dialogs save at once; name, description, model and tools batch behind a sticky "Unsaved changes" region with Revert and Save that shows only when something differs. There is no draft toolbar and no Discard guard: an unsaved edit is kept per Bot for the window's life, and reopening the tab says "Your unsaved changes are back." Five fixed tabs outgrow the 440px panel, so the Bot panel shows the Open tabs list past four tabs; the shared tab strip scrolls the selected tab into view, clear of a 16px fade on any edge with tabs scrolled past it.
- Deviations in §4.4: Thinking has no row (no per-Bot levels exist). Routine models stay on each routine row; Advanced → Model has a **Routine models** row that opens the Routines tab. Health is its own group after Model. The Computer group's actions keep their own confirmations and act at once, so the computer is not batched. Tools batch with the model, since both are the one access draft. Instructions have no history (there is no store for one); the row opens the instructions dialog, which keeps its own draft. There is no Export, so the last group is **Clear**: Erase memory (in the Memory tab) and Delete Bot…. The Routines tab gains the event routines and connected-app watches as their own groups under the scheduled list (wake-ups were already in that list); they are not merged into one list. Open work and What I've learned stay full pages; their Back returns to the chat with Advanced open. The Open work, Approved Bot pairs and routine-model dialogs keep their own discard guards.
- **Old links**: `?page=` targets redirect (`botPageTarget`): memory → Memory tab; instructions → Advanced + instructions dialog; interruptions → Advanced + Quiet hours; advanced, profile and chat-activity → Advanced; allowed → Settings → Approvals; open-work and learning stay pages. The ••• menu is Pin (or Unpin), Pause (or Resume) and Delete; Files, Memory, Routines, Profile and Advanced items are gone (the panel's tabs reach them).
- **Field checklist** (old place → new place): Name, Subtitle → header name, How other Bots see it; look, photo, Default look → avatar popover; Instructions → Instructions row and dialog; Memory, What I've learned → Memory group (Memory tab, learning page); Open work → Open work row; Approvals → Permissions → Approvals row; Bot messaging (Manage Bot messaging) → Permissions → Approved Bot pairs; Advanced → Other Bots (two direction switches) → Permissions → Can message other Bots; Advanced → Chat (Let <Bot> set its own wake-ups) → Permissions → Daily check-ins on unfinished work; Advanced → Interruptions (quiet hours, notifications a day) → Notifications switch and Quiet hours dialog; AI model, Model for photos → Model; Health → Health; Computer → Computer; Spending → Spending; Telegram → Replies; Tools, Disable a tool, Files, Use everything → Tools; scheduled, event routines, connected-app watches → Routines tab; Pause, Pin, Delete → ••• menu (Delete also in Clear); Erase memory → Clear → Memory tab.
- **Bot messaging** (§4.7 of this phase's scope): one name. The Settings → Bots tab is gone; **Bot messaging** sits in Settings → Approvals → Advanced and saves the same `botMessaging` setting. The page is now **Approvals** (tabs Approvals and Controls in chat); the `bots` section id is kept as a spot on it that opens the Approvals tab and scrolls to the switch, so older links land. Per Bot, Permissions has **Can message other Bots**, which is on only when both stored directions are on and writes both; nothing changes without a flip, and phones keep their two switches on the unchanged wire. In-app copy, help topics and docs say Settings → Approvals.
- **Tests**: `renderer/main/bots/bot-advanced.test.tsx` (new; order, rename, Escape, empty name, a failed save keeps the edit, an unsaved edit survives a remount, model and tools batch, switches save at once, quiet hours, messaging switch semantics, global off, Default look, Approvals row) is in `test:bots`; the panel, chat, sidebar, memory, wake-up and redirect suites were updated; `approval-mode-settings.test.tsx` covers the Bot messaging switch, a failed save and the scroll to it; `settings-section.test.ts` the `bots` spot. `bot-profile.test.tsx`, `bot-messaging-fields.test.tsx` and `bots-settings.test.tsx` were removed with their components. E2E: `bots-starter.spec.ts` (New bot → chat; onboarding → the first Bot's first message), `bots-persistence.spec.ts` (the same through the real runtime on macOS), `guided-setup.spec.ts` (failed create keeps the name; Disable a tool and Save in the Advanced tab), and the watches, routine-model, Open work, peers, plan-tour and settings specs follow the new places. The one Cua Space run for this phase could not create its Space (the container engine failed to extract an image layer, as in Phase 4), so these specs have not run locally; CI runs them.
- **Phone follow-ups for Phase 6** (no protocol revision and no wire change here): phones keep the Profile and Advanced screens, the two messaging direction switches and their own create flow; Phase 6 should bring the two-level settings, the single Can message other Bots switch (reading on only when both directions are on), one-field create and Templates (with the template version and Open for an existing template Bot), and the Approvals → Advanced home for Bot messaging. The held `update_bot` card shows on desktop only; phones see a held change as nothing until Phase 6 projects the card. Phone copy that says "Settings → Bots & Approvals" is server-supplied and now reads "Settings → Approvals".

**Phase 6. Phones and the wire.**
Scope: the typed card model on the wire; iOS and Android render and answer every card optimistically; mobile two-level settings; mode and rules pages on phones; one-field create and Templates. Until this phase, phones keep working through the existing approval projection with updated labels.
Areas: `main/services/aiden-remote-*`, `docs/aiden-remote-api-v1.md` and fixtures, `ios/`, the Android app, App Store and Play metadata if screenshots change.
Tests: router and stream contract tests; fixture round-trips on both clients; native view-model tests for optimistic rollback; old-client degradation; Telegram cannot answer an approval.
Risk: medium to high. Metric: share of approvals answerable on phones (target: all but the three host-only kinds); median time to answer.

Phase 6a notes (2026-11-13, the wire and server half; provisional revision 61, claimed for real at merge):
- **Capabilities.** Five opt-in capabilities, negotiated through `POST /device/capabilities` and advertised in `serverCapabilities` only where the host wires them, never issued at pairing and with no feature token: `approval:cards`, `approvals:settings`, `bot:settings-changes`, `bot:suggestions`, `bot:templates`. `approval:cards` is wired wherever runs or Bot sessions are, so `aiden serve` advertises it too; the other four are desktop-only (the CLI has no ports for them). An old client that never negotiates sees the unchanged projection.
- **Typed card.** `renderer/shared/approval-card-model.ts` (`buildApprovalCard`) is the one card model for the desktop and the wire: kind, title, Deny-first buttons with their answered lines, arguments (short values first), body and previous, rows, notes. It is complete or Deny-only: a card whose body or rows do not fit, whose details were omitted or malformed, whose kind is unknown, or that the host marks `canAllow: false` carries no allow button and adds `allowOnMac`. A holder may allow only what its card offers (`approvalCardAllows`); anything else is refused. Stream approvals, run `approval_required` events and gap snapshots, and Bot approvals carry `card` for holders, and for stream and run approvals `canAllow` and `scopes` follow the card's buttons. A hook proposal is a held change (Apply / Dismiss) answerable only when its event, matcher and command are all in the body; a sub-agent's file change shows its diff and a connector call its arguments, deny-only when truncated or too long; a sub-agent's run-wide grant is host-only on every payload; Computer Use calls stay on the Mac except the access grant; form fill is answerable when every row fits.
- **Needs-you items.** `bot:settings-changes` projects the held `update_bot` card (`settings_change` entries: held with the field diff against the instructions as they are now, or a receipt with Undo) and answers it at `POST /bots/{botId}/settings-changes/{changeId}/respond`. `bot:suggestions` projects skill proposals, lessons and tidy-ups with `POST /bots/{botId}/skill-proposals/{proposalId}/respond`, `/lessons/{lessonId}/respond`, `/lessons/{lessonId}/remove` and `/learning/{changeId}/undo`. A skill preview longer than 16,000 characters is cut and flagged `previewTruncated`, and Add on it from a device is 409 (add it on the Mac). Lesson routes answer 404 for a lesson that does not exist or is not in the state the route needs (respond: waiting; remove: active); learning undo answers 404 for an unknown change.
- **Templates and one-field create.** With `bot:templates`, `GET /bot-presets` adds each template's `version` and, for a template that already made a Bot, that Bot's id (Open). `POST /bots/from-preset` with a `version` that is no longer current is refused with 409 `revision_conflict`. `POST /bots` from a holder without `instructions` gets the starter instructions and the Bot introduces itself, as on the desktop.
- **Approval mode and rules.** `approvals:settings` (with `approval:respond`) reads and sets the Mac's mode (`GET`/`PUT /approvals/mode`, Auto refused without a usable model) and the rules page (`GET`/`POST /approvals/rules`, `GET /approvals/rules/picker`, `POST /approvals/rules/change`, `POST /approvals/rules/remove`) through the desktop's own Settings save path and rules page. Writes fail closed while the rules file can't be read; refusals are generic. These routes are reachable only from a paired device, never from a Bot or agent.
- **Client-only, no wire change:** two-step Take control (the existing `done` / `skipped` answers), the single Can message other Bots switch over the two stored directions, the per-device Show tool activity switch (the per-Bot `chatActivity` stays on the wire for older phones), Disable a tool through the existing `PATCH /bots/{botId}/capabilities`. MCP connect review stays host-only (a native dialog). Telegram never answers an approval.
- **Contract.** `protocol/aiden-remote/v1/fixtures/contract.json` is at 61; `protocol/aiden-remote/v1/fixtures/bot-ux-revision-61.json` holds sample cards, a complete and a deny-only stream approval and phone run `approval_required` event, entries (including a truncated skill), templates, mode, rules, picker, requests and the stale-template error, generated from the real builders (`AIDEN_WRITE_FIXTURES=1`). OpenAPI lists the ten new paths and the new capabilities; the API doc section is "Bot UX on phones, revision 61". The iOS and Android revision asserts moved to 61; their apps are unchanged.
- **Tests.** `main/services/aiden-remote-bot-ux.test.ts` (new, `test:aiden-remote`): the fixture equals the builders, parser round-trips, refusals, approval settings validation and fail-closed writes. Router, host-run, Bot session and protocol tests cover negotiation, advertising, the new routes, holders versus old clients and the revision; `renderer/shared/approval-card-model.test.ts` (in `test:tool-approval-card`) covers the card; the Telegram core test covers that Telegram never answers an approval.
- **For 6b and 6c.** Negotiate each capability separately and fall back to today's screens without it. Render the card in its order (title, arguments, body and previous, rows, notes, then the buttons with Deny first) and send only the decision and scope a button offers; show `allowOnMac` instead of allow buttons (a sub-agent run grant always reads this way); show the answered line after a tap, optimistically, and roll back on refusal. Show `settings_change` held cards with the diff and Apply / Dismiss, receipts with Undo; skill, lesson and tidy-up cards with their routes (a skill with `previewTruncated` offers Not now only and says to add it on the Mac; treat 404 as the card being gone). Templates: show the version, Open for a template that already has a Bot, and refresh on 409. One-field New bot. An Approvals page with the mode (Auto disabled when unavailable) and the rules page with Add rule from the picker. The single messaging switch and Show tool activity per device.

Phase 6b notes (2026-11-13, the iOS half):
- **Negotiation.** `AidenHostConnection` asks for each of the five capabilities in its own `POST /device/capabilities` call after the existing opt-ins, only when the Mac lists it; `AidenInstallation.offersBotUX` (the Mac lists `approval:cards` in `serverCapabilities`) gates the client-only changes. Without a capability the matching screen is today's.
- **Typed card.** `Models/AidenBotUX.swift` decodes the card strictly, mirroring the TypeScript parser (Deny first, every allow on a button, every offered scope on a button, `canAllow` equal to "has an allow button", unknown kinds refused). `Features/Chat/AidenTypedApprovalCard.swift` renders it in order for stream, run and Bot approvals (the primary allow as a button, others in a menu, `allowOnMac` instead of allow buttons). A button shows only when its route can send its scope (a run's offered scopes; for a Bot, Always only with `bot:allowed` and the Mac's count). A tap sends only that button's decision and scope, shows its answered line at once (a cross for Deny), and takes it back if the answer doesn't land, including an expired or already answered approval; the card returns while the Mac still waits. The line goes when the next approval arrives, a new turn starts or the run ends. A scheduled task on a device without `schedule:write` shows Deny only, with the reason.
- **Bot cards.** `Features/Bots/AidenBotSuggestionCards.swift`: the held settings change (the Mac's held reason, the full new instructions, a line diff, Apply / Dismiss, "To edit it first, open this Bot on your Mac."), receipts with Undo while the receipt is still `pending` and `undoable`, skill proposals (Not now only and "Add it on your Mac" when `previewTruncated`), lessons (Not now / Add; Learned with Undo) and memory tidy-ups with Undo. `AidenBotSessionModel` answers through the six routes optimistically; 404 drops the card, other refusals roll back and show the Mac's message.
- **Templates and New Bot.** With `bot:templates` the New Bot button is a menu (New Bot / Templates); Templates shows each version and Open for `existingBotId`, sends `version` with `from-preset`, and reloads on 409 `revision_conflict`. New Bot is one "Name your Bot" field and sends no `instructions`.
- **Settings → Approvals** (`approvals:settings` with `approval:respond`): `AidenApprovalSettingsModel` / `AidenApprovalSettingsView` show the mode with the Mac's helper lines (Auto disabled with "Auto needs an approval model. Choose one on your Mac." when `autoAvailable` is false) and the rules in Always allow, Always ask, Blocked and Allowed on this Mac, each row with the decisions it offers and Remove (a 404 counts as removed); Add Rule picks from the Mac's grouped, searchable picker. Writes are optimistic; only the latest write rolls back, and after any refused write the page is read again once no write is in flight, so overlapping writes settle on what the Mac holds.
- **Client-only.** Two-step Take Control (Take Control opens the page or Finish on Mac, then I’m Done, Skip and Open Again); one Can message other Bots switch that reads on only when both stored directions are on and writes both; Disable a Tool turns Full Access into Custom with everything else Full access certainly grants and the widest file scope, leaving Web search off because Full grants it only with a flag the wire doesn't carry (it tells Web search apart by the Mac's label, as the desktop does); the per-Bot Chat activity page is hidden and Bot chats follow a per-device Settings → Show tool activity switch (off by default).
- **Tests.** `AidenBotUXTests` (22, with the `bot-ux-revision-61.json` resource): fixture round-trips and refusals (including an unknown card kind), fallback without the capabilities, an expired Bot approval leaving no answered line, optimistic answers with rollback and 404, the truncated skill, a Deny-only card never sending allow, Auto refused, rule rollback and Disable a tool. `AidenRemoteClientTests` drives the coordinator against a fake Mac (one call per opt-in, nothing the Mac doesn't list, a refusal keeps the other grants), and `AidenChatTests` covers the scheduled-task Deny and an unconfirmed answer taking its line back. `AidenBotUXUITests` captures every new or changed screen in light and dark on the `-AidenDemoBotUX` demo Mac (local only; CI runs only the shell smoke test). New files are in `scripts/check-ios-shipping-target.test.mjs`.

Phase 6c notes (2026-11-13, the Android half):
- **Negotiation.** `aidenBotUxCapabilitiesToRequest` asks for each of the five capabilities in its own `POST /device/capabilities` call, only when the Mac lists it; `AidenInstallation.offersBotUx` (the host lists `approval:cards`, which `aiden serve` does too; safe there, because the client-only changes use only routes and fields older hosts have) gates the client-only changes, and each screen checks its own negotiated capability. Without one the matching screen is today's.
- **Typed card.** `models/AidenApprovalCard.kt` decodes the card strictly, mirroring the TypeScript parser; `AidenTypedApprovalCardContent` renders it in order for stream, run and Bot approvals with `allowOnMac` instead of allow buttons. A tap sends only that button's decision and scope, shows its answered line at once and puts the card back if the Mac refuses; the line clears when the next approval arrives, the run ends or another run starts. A Bot card keeps only the answers its route can send (once and Always); with no allow left it is Deny alone with `allowOnMac`, and an unsendable tap shows an error rather than nothing.
- **Bot cards.** Held settings changes (diff, Apply / Dismiss), receipts with Undo, skill proposals (Not now only and "Add it on your Mac" when `previewTruncated`), lessons and tidy-ups, answered optimistically through the six routes; a 404 drops the entry, a 400 or 409 rolls back with the Mac's message, anything else with a generic one.
- **Templates and New bot.** With `bot:templates` the template card shows its version and Open for `existingBotId`, sends `version` with `from-preset`, and on 409 `revision_conflict` says the template changed and reloads. New bot is one name field and sends only the name and look.
- **Settings → Approvals** (`approvals:settings` with `approval:respond`): `AidenApprovalSettingsController` and its two screens show the mode as Auto, Ask, Never ask (the desktop's `APPROVAL_MODES` order) with the Mac's helper lines (Auto disabled with "Auto needs an approval model. Choose one on your Mac." when `autoAvailable` is false) and the rules in Always allow, Always ask, Blocked and Allowed on this Mac, each row with the decisions it offers and Remove; Add rule picks a tool or connected app from the Mac's grouped picker and shows a pending row. Writes are optimistic and roll back; 404 removes the row; after a failed write, or one overtaken by a newer write, the page rereads the Mac's rules once no write is waiting; nothing is sent while the rules file is unreadable.
- **Client-only.** Two-step Take control (Take control opens the page or Finish on Mac, then I’m done, Skip and Open again); one Can message other Bots switch that reads on only when both directions are on and writes both; Disable a tool under Full access turns it into Custom with everything Full certainly grants and the widest file scope, so it only narrows: web search is left off, because Full grants it only while the Mac's web search switch is on and the wire doesn't carry that switch (a Bot that had web search loses it, and the person can turn it back on in Custom; the Full / Custom selector stays, as on iOS); the per-Bot Chat activity page is hidden and Bot chats follow a per-device Settings → Appearance → Chat → Show tool activity switch. The switch is off by default (plan §4.5), so an untouched phone reads Thinking.
- **Tests.** Unit (43 new, all JVM): the fixture contract test (16), `AidenApprovalSettingsControllerTest` (11, including two failed overlapping writes), `AidenBotUxSessionControllerTest` (9), `AidenBotClientOnlyUxTest` (5, including that Disable a tool grants nothing Full doesn't), `AidenChatAnsweredApprovalTest` (the answered line, its rollback and its clearing) and one-field create in `AidenBotModelChoiceTest`; the full `testDebugUnitTest` run is 1,369 tests with no failures. `AidenBotUxRevision61UiTest` (7, instrumented, reads the shared fixtures as androidTest assets) passes in light and dark on a headless emulator and, with `aidenScreenshots=1`, saves each screen for review.

## 9. Owner decisions (2026-11-12)

1. **Schedule and automation changes keep their foreground confirmation** (deviation b). Yes.
2. **Disclosure tools still ask in Never ask** (deviation e). Yes. The Never ask helper reads "Asks only before purchases, sharing your data and the first use of your Mac. Only Block rules apply."
3. **Auto is the default even when the only model is local or metered.** Yes. A slow judge times out to a card, and judge spend shows in usage.
4. **"Hand off to me" stays** as the row-menu option "Do it myself" on Always-ask rows. Yes.
5. **Computer Use grants per app?** No. One grant covers all apps (deviation f).
