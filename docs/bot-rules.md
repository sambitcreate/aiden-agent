# Bot rules

A Bot's rules say what it stops for: steps it asks about first, and steps it
hands back to the person to do themselves. Every rule now lives on one page,
**Settings → Bots & Approvals → Approvals**, under the mode (see
[The rules page](#the-rules-page)); there is no Rules screen on a Bot's Profile
any more. Main checks the rules at every tool call they cover. A Bot's
built-in rules only make it stricter: the strictest of the Bot's own approval
and every matching built-in or worded rule wins, so no worded rule can let
through a step the Bot would otherwise ask about. You can approve a bounded
plan for the current task, as described below.
Settings → Bots & Approvals also has a routines-only go-ahead setting
(see [Routines and the approval mode](#routines-and-the-approval-mode-settings--bots--approvals--approvals)).

The design is in `docs/plans/bot-handoffs-rules-computers-plan.md` §6;
implementation notes are in `.memory/bot-rules.md`.

## The rules

| Rule | What the Bot does | Can it change? |
| --- | --- | --- |
| Enter a password or 2FA code, or change account security | Hands off | No (locked) |
| Move money or enter card details | Hands off | No (locked) |
| Make a purchase or booking; Send a message or email to someone; Post or publish something publicly; Permanently delete something; Install software on your Mac | Asks first | Ask first or Hand off to me; never removed |
| The person's own rules, "When a Bot wants to …" (120 characters each), added on the rules page for every Bot, or kept from a Bot's old Rules screen for that Bot | Ask first, or Do it myself (hand off) | Changed or removed on the rules page |

- The locked rules are code, not settings: a missing, edited or corrupt rules
  file can never remove them.
- A rule that asks shows an approval card for that call unless an approved
  plan covers it and every matching Ask first rule. Remembered approval
  scopes never answer it.
  Each answer belongs to the call and requirements shown. If access, rules or
  the page binding changes before execution, Aiden checks again and may ask
  with a fresh card. Stopping a waiting turn withdraws its card without
  recording a decline. Once the person denies a card, the same call (same
  tool, request and arguments) is refused without another card for the rest
  of that reply; a call that differs in any argument still asks. Calls from
  the same reply waiting at the same time share one card in the chat only
  when they are the same call (same tool, request and arguments), and then one
  answer covers them all; any other call gets its own card.
- A rule that hands off shows a hand-off card ("Needs you: …") with Take
  control, Skip and I'm done; the Bot waits for the answer and never does the
  step itself.
- On a routine or Telegram turn nobody is there to answer, so a step a rule
  would hand off doesn't run, nor does a step a rule would ask about that has
  no approval of its own. The Bot is told why. A step with an approval of its
  own (a connection tool that changes something) waits under Needs you until
  the person answers. Settings → Bots & Approvals can let routines go ahead instead.

## Approve a plan once

A desktop-hosted Bot can propose a task with a reason, numbered steps and the
access or actions it needs. Review the coverage lines and use **Show details**
to see the exact connected-app actions. Choose **Approve plan** or **Not now**
in the Bot's chat on the desktop or a supported paired iPhone or Android phone.
Phone coverage identifies a folder by its host-owned location, including its
name and read/change scope. If its exact location cannot fit safely in the
phone review, approve on the host desktop instead; the phone cannot approve
that pending plan. A visible pending plan holds Send while your draft stays
editable. If the phone cannot show the review, it keeps the waiting signal
and can still send a message; approval remains on the host desktop.

Approval applies to the current task for at most 60 minutes from approval.
A task requested by another Bot keeps that exchange's earlier deadline. A
queued follow-up is a new task and cannot inherit the plan; a steer that joins
the current task shares its existing limits. Routine and Telegram turns cannot
propose plans, and another Bot cannot approve one for you.

Covered steps can use the listed connected-app actions, browser sites and
Ask first rules without opening another approval card. Every matching Ask first
rule must be covered, and every applicable usage limit must have room. When
several limits apply, the call counts against each. A canceled or interrupted
attempt may still use a slot. A step outside the plan, or over a limit, returns
to its ordinary approval, hand-off or refusal behavior. Files and commands
still use the Bot's own access settings; listing them does not grant a new
connection, skill or Shell permission or narrow independently saved access.

Passwords, verification codes, account security, money and card details still
come to you. Payment-provider subdomains still ask, even when the plan names
their parent site. **Hand off to me** rules remain hand-offs. A plan never approves
Computer Use on your own Mac. Changing the Bot's access, model, connected-tool
binding or effective rules invalidates the captured approval rather than
silently applying it to new authority.

The approved card becomes a checklist. The Bot marks steps done or skipped;
counted actions show how much of each limit has been used. **Stop plan** ends
that plan's approval and its extra folder access. Calls that already started
can finish; later calls use ordinary checks. Finishing the steps, completing
the task, a run ending because its model is unavailable, stopping or dismissing
its turn, or reaching the deadline also ends the plan. An ended card shows
its compact progress line.

A plan may request one outside folder with read-only or read-and-change access.
Approval grants that folder only for this plan and current task, within the
Bot's current permission ceiling. It does not save an Always grant or allow
your whole Mac. The extra folder ends with the plan, the run, expiry, a policy
change or quitting Aiden. Stored approval can recover with the task, but it
never recreates that in-memory folder grant after a quit. The Bot must ask
again through [request_access](bot-access-requests.md). Protected Aiden storage
stays protected. The read/write choice does not reduce access the Bot already
held independently.

Direct calls and each nested call in a codemode script use the same coverage,
limits and final checks. A script cannot use one covered call to authorize the
rest of its calls. The CLI host does not offer plan tools or coverage, and a
desktop viewing another desktop's Bot does not show plan cards. Such a viewer
can still show Waiting for you; answer on the host desktop or a supported phone.

## Routines and the approval mode (Settings → Bots & Approvals → Approvals)

Every Bot follows the one approval mode in Settings → Bots & Approvals →
Approvals: **Auto**, **Ask** or **Never ask** (see
[docs/plans/bot-ux-simplification.md](plans/bot-ux-simplification.md) §3.1).
There is no per-Bot mode.

- **Ask**: a step an Ask first rule covers, or a consequential step (a
  connection tool that changes something, sharing an image), shows its card.
- **Auto**: before a consequential step's card, the approval model (the one
  named under Approvals → Advanced, else the Bot's own model) reads the Bot's
  instructions, what the owner asked for and the action, with typed text and
  secrets left out. If it is sure the step is what the owner asked for, the
  step runs; otherwise the card shows as in Ask. No model (an ACP agent), an
  error, a slow or unsure reply, or a turn that has already read a
  connection's data or a web page all show the card. Rules you wrote, page
  rules, sharing an image, purchases, hand-offs and your Mac are never
  judged. A routine still refuses a step the model would ask about. Each check
  shows in usage as `approval-judge` and counts toward the Bot's spending
  limit when it costs money.
- **Never ask**: only Block rules apply. Ask first rules and consequential
  steps run without a card. Hand off to me rules, the locked password and
  money rules, and the first use of the person's Mac (shell, Computer Use)
  still come to the person; disclosure tools and schedule changes still ask.

In a workspace chat, once outside content has entered the chat, Aiden is
more careful about where things go next. Outside content is a web page or
search result, anything from the browser (except resizing it or changing its
appearance), a simulator screenshot, a subagent's report, a pull request's
comments, codemode, or any connector's result, and it counts for the rest of
the chat, earlier turns included. From then on **Ask** also asks before a fetch
to a site you didn't name in the chat and before the first use of each
connector, even one that only reads; **Auto** has the approval model judge
those; **Never ask** runs them. Expect a few more cards in Ask after a chat has
used the browser or a subagent: that is by design, since text you didn't write
could be steering the model.

A routine run (scheduled, manual, event or missed-fire input, and a Bot's own
wake-up) has nobody to ask. Where the gate would show a card, the routine
refuses the step and the Bot says in its reply that it needs the person's OK,
except in Never ask. This includes a connection tool that changes something
and Computer Use on the person's Mac, which no longer wait under Needs you.

The older **Go ahead without asking** switch (`AppSettings.botRoutinesGoAhead`)
is no longer offered. For someone who had it on it keeps working as before and
shows under Approvals → Advanced, where it can only be turned off. Main reads
the mode and the switch fresh at every tool call (`checkPolicy` in
`bot-tool-assembly.ts`). The CLI's durable Bot host has no rules or judge,
runs in Ask and keeps asking for every MCP call.

## The rules page

Settings → Bots & Approvals → Approvals lists every rule under the mode, in
three groups: **Always allow**, **Always ask** and **Blocked**. Each row has an
Allow / Ask / Block control and Remove; **Add rule** in a group opens a
searchable picker of Aiden's tools, connected apps and their tools, a website,
or words ("When a Bot wants to …", Ask or Block only, never Allow).

- **Resolution.** Block wins anywhere. Otherwise the most specific rule
  decides: a site, then a tool, then a whole connector. A rule a workspace or
  a Bot owns answers only for that owner and beats the Mac's rule at the same
  specificity; a Mac Block still wins.
- **Modes.** In Never ask only Block rules apply, so the page dims the other
  rows and says so; a row with **Do it myself** is not dimmed, since the
  hand-off still comes to the person. In Ask and Auto an Ask rule shows the
  card even for a read. An Allow rule runs a consequential action without a card but never
  reaches the person's Mac (shell, file changes, Computer Use).
- **Locked.** Passwords, 2FA codes, account security, purchases and money
  always come to the person; the page says so and no rule changes it.
- **Allowed on this Mac.** Mac grants ("Allowed in this workspace" from a Mac
  card) and the folders a Bot may change are listed to read and remove.
- **Also decides what runs.** Link rows open hook approvals, approved folders
  and paired devices, which keep their own pages.
- Rules are global to this Mac. A customized workspace's remembered commands
  and files stay its own rows.
- Site rules match calls that name the site in their address (navigate,
  fetch), a Bot's browser actions on a page with that address, and a
  workspace chat's browser actions on the address its tab shows at that
  moment.
- A Block applies everywhere the gate runs, including a workspace chat bound
  to a Bot. Sharing an image offers only Ask and Block: it always asks unless
  blocked.
- **A rules file Aiden can't read.** If `approval-rules.json` doesn't parse,
  was written by a newer release, or holds a rule this release can't read,
  Aiden never reads around it or writes over it, since its Block rules may be
  the ones it can't see. Until it is fixed, a workspace action that changes
  or sends something, uses a connected app, reaches a site or is one of the
  actions Add rule offers asks once first, in every mode (Never ask included,
  and never judged), and Bots don't act. A plain local read, such as reading,
  listing or searching files, goes by the approval mode. The page hides the rules, says so, and offers **Try
  again** or **Start over**, which renames the file to
  `approval-rules.json.unreadable-<time>` beside it and starts empty.
- Deleting a Bot or removing a workspace removes the rules only it owned.

### Rows kept from before

Nothing is copied when the page first opens. Each older grant is shown where
it is stored and answers only for its old owner:

| Stored before | Row |
| --- | --- |
| A Bot's "Always allow for <Bot>" | Always allow, "Only for <Bot>" |
| A Bot's own rule in words | Always ask, that Bot only |
| A Bot's built-in rule set to Hand off to me | Always ask, with **Do it myself** checked in the row's menu |
| A workspace's remembered command or file | Always allow, that workspace |
| A folder a Bot may change | Allowed on this Mac, that Bot |

Remove goes through the row's own store, so a Bot's allow list keeps its
receipts, tombstones and counts: a removed entry is never brought back by a
replayed decision, and the 50-per-Bot and 1,000-per-profile caps still hold.
Turning a Bot's Allow row into Block first asks (a site Block covers the
whole site and its subdomains), then adds a Block owned by that Bot and
removes the allowance only once the Block is saved. A change the page can't
store as written is refused and the row stays as it was. The previous release reads every older file unchanged; the
page's own rules live in `approval-rules.json`, which it ignores.

## Allowed without asking (from cards)

After you approve the same app action or website action three times in 14 days,
with no denial in that period, the next eligible card offers **Always allow
for <Bot>**. A class is one exact connected app tool, or one website host and
action such as click, type or press. Website names ignore letter case and a
leading `www.`; other subdomains and actions remain separate. The row appears
in Always allow on the rules page, and Remove there stops it on the next call.
Paired iOS and Android clients still show the Bot's list when the host grants
`bot:allowed`.

Choosing Always saves that allowance for this Bot. While this Mac is in Ask
and a model could judge, the card with the repeat count also offers **Switch
to Auto**, which changes the Mac's mode as Settings → Approvals would. A
workspace card offers it too once the same kind of action was allowed three
times in that workspace since Aiden opened, unless the workspace keeps its
own mode. Allow once keeps the card for next time; when an offer was present, the Bot may mention the option in
one short sentence, at most once a week for that class. Decisions on a
Bot-message turn still count, but do not send or consume that hint because the
reply goes to another Bot. Expiry and automatic
answers do not count as your approvals or denials. A denial withholds an
offer for 14 days. Transport retries and recovery do not count a choice twice.

Remembered entries follow current access, rules, routine behavior and approved
plan coverage. They apply to eligible calls on every turn kind, but never
provide a new tool or override a locked rule, a rule-made ask, a hand-off or
Computer Use on your Mac. Actions on payment-provider hosts, including payment
subdomains of an otherwise eligible site, never use remembered approval or
offer Always. If rules or page binding change while a card waits,
Aiden checks again before saving Always or running the action. If saving
fails, the current one-time answer still applies; it does not promise a saved
entry.

Removing a folder deselects it for this Bot and keeps other Bots' selections
and the approved folder itself. Full-access Bots have no extra Custom-folder
rows. There are at most 50 remembered app/site entries per Bot and 1,000
across the profile; folders do not consume those limits.

Folder cards use their separate **Always for this folder** choice and can show
the repeat count and a short hint after Allow once. Whole-Mac requests never
count. Home or another folder without an Always choice never offers the nudge.
The CLI host has no remembered-approval port. Counts, saved entries and replay
receipts stay in the host profile; recovery acknowledges history and never
recreates removed access. If remembered-approval evidence is damaged,
remembered approvals fail closed. Bot file tools cannot write the remembered
approval store or folder-publication journal, including through symlinks or
codemode. Rule-made and Computer Use cards still work.
Deleting a Bot preserves the damaged evidence and continues removing that Bot’s
data; a genuine storage-write failure still requires deletion to be retried.

## What rules check

- **Computer Use** on the person's Mac: clicks, typing, key presses and menu
  items, read from the app, window, element and focused field. Typed text
  never reaches the rules.
- **The Bot's browser**: clicks, typing and key presses, read from a probe of
  the targeted element (tag, type, autocomplete, role, accessible name, form
  host), never field values or typed text. See `docs/environment-browser.md`.
- **The Bot's own computer** (`computer`): see
  [Bot computers](bot-computers.md#how-the-bot-uses-its-computer). On the VNC lane a
  click is only coordinates, so the rules read the Bot's stated intent; on
  the guest driver lane they also read the element it acts on.
  - A key that types a character is typing. Backspace or Delete (no
    modifier but Shift) is typing only while the guest driver lane has the
    Bot in a text field it clicked, so "Delete the extra letter" there never
    reads as deleting something. Anywhere else (a selected message in Mail,
    or the VNC lane, where Aiden can't see what has focus) the same key can
    delete what is selected, so it presses something, like a click, and an
    intent that says delete asks first. Command-Delete always presses
    something.
- **Connection (MCP) tools the Bot is granted as mutating**: the tool's name,
  its call summary, and the live server's title, first description sentence
  and annotations. Arguments never reach the rules.

## What rules don't check

- **Shell commands.** `run_command` follows the Shell setting, and
  `computer_shell` in a Bot's own computer follows its Bot computer access.
  The rules page says so in its locked note.
- **File tools and web search.**
- **Read-only connection tools.** A tool its server declares read-only
  (`readOnlyHint: true`, without `destructiveHint: true`) changes nothing a
  rule covers, so no rule, custom ones included, is checked for it.
- **Looking and waiting**: scrolling, moving the pointer, captures,
  screenshots and the like match no rule.

### Connection tools are taken at their word

Aiden reads a server's annotations as the server states them:

- A tool marked read-only isn't ruled at all, whatever it really does.
- A tool marked `destructiveHint: false` (additive) is never put under
  **Permanently delete something** by its name, title or description, so a
  `delete_repository` tool that claims to be additive avoids that rule. The
  locked password and money rules still read its name and summary, and a
  custom rule whose words all appear in its name or description still
  matches.

Grant connection tools only from servers you trust to describe them honestly.

## Rules in codemode scripts

A Bot with connection, file, shell or lookup tools also gets `codemode`, which
lets it script those tools. Every call a script makes is checked like a direct
call: its ingress, access, rules and any approved plan coverage. An uncovered
Ask first step opens the same approval card, which waits as long as a direct call's and is
asked again under the same card after Resume; the script picks up where it
was. A script has no time limit unless it sets one. A rule that hands a step to the person doesn't
open a card from inside a script: the call is refused and the Bot is told to
make it directly, so the person gets the hand-off card as usual. Scripts never
reach cards, the Bot's own computer or browser, routines or subagents.

## Hand-off cards from rules

- A card the password-or-code rule opened takes no note: the composer is off
  while it waits and says why, and main refuses a note sent with its answer,
  so a password or code typed into the chat can never reach the Bot. Other
  cards, sign-ins aside, say the Bot reads any note sent with them.
- A card the password or money rule opened never quotes what the Bot was
  typing. Its reason, and the Done the Bot reads, name the field instead
  ("was about to: type into the “Card number” field").
- A card a rule opened for the Bot's browser or computer tools is a step on
  the Bot's own screen: on the Mac its Take control opens the Bot's browser
  or its computer (never the person's own browser), and on a phone
  (a device holding `bot:handoff-on-mac`) Finish on your Mac opens it there.
  The Mac's Bot panel then shows that browser tab or the Computer tab, once
  per card and without moving keyboard focus. A browser step that names no
  page holds the tab the Bot is on, as it is; with no tab open, only the
  chat comes forward.
- Each turn's answer is its own transcript row, even when a provider reuses
  the same tool-call id in every turn.

## The rules file

- `<userData>/bots/<dir>/rules.json` holds only what the person changed
  (built-in behaviors and custom rules) with a revision. Every edit names the
  revision it was made against; a stale edit is refused with the current
  rules.
- A missing file is the defaults.
- A file that doesn't parse exactly (bad JSON, an unknown field or version, a
  rule that isn't valid) fails closed: the defaults may be looser than what
  the person set, so the Bot doesn't run any step its rules would check, and
  is told "This Bot's rules couldn't be read, so this action didn't run." The
  next change from the rules page starts again from the defaults and replaces
  the file. Before replacing it, Aiden keeps the
  damaged bytes beside it as `rules.json.unreadable` (then
  `rules.json.unreadable.2`, and so on, never over an earlier copy), so rules
  the person wrote can be recovered by hand. A file that can't be read at all
  (permissions, a directory in its place) fails closed the same way.
- Deleting the Bot removes the file and its kept copies, and refuses later writes.
- Phones don't show rules yet.

## Messages from other Bots

A `bot:` or `botreply:` turn still follows every rule. An uncovered Ask first step opens the real approval card in the receiving Bot's chat and waits for the person within the exchange's deadline. A plan can cover eligible steps only after the person approves it in that recipient's chat, and cannot extend the exchange's deadline. Hand off to me blocks the step; another Bot cannot answer or accept it. The routines go-ahead switch never applies to Bot-message turns. See [Bot messaging](bot-messaging.md).

For local plan enforcement checks, `npm run test:bot-plans` builds its lease and file-write helpers automatically before running the behavioral suite. No prior app build is required.
