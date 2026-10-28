# Bot rules

A Bot's rules say what it stops for: steps it asks about first, and steps it
hands back to the person to do themselves. They live in the Bot's Profile →
Rules, and main checks them at every tool call they cover. Rules only make a
Bot stricter: the strictest of the Bot's own approval and every matching rule
wins, so no rule can let through a step the Bot would otherwise ask about.

The design is in `docs/plans/bot-handoffs-rules-computers-plan.md` §6;
implementation notes are in `.memory/bot-rules.md`.

## The rules

| Rule | What the Bot does | Can it change? |
| --- | --- | --- |
| Enter a password or 2FA code, or change account security | Hands off | No (locked) |
| Move money or enter card details | Hands off | No (locked) |
| Make a purchase or booking; Send a message or email to someone; Post or publish something publicly; Permanently delete something; Install software on your Mac | Asks first | Ask first or Hand off to me; never removed |
| The person's own rules, "When <Bot> wants to …" (up to 20, 120 characters each) | Ask first or Hand off to me | Edited or deleted |

- The locked rules are code, not settings: a missing, edited or corrupt rules
  file can never remove them.
- A rule that asks shows an approval card for that one call. Remembered
  approval scopes never answer it.
- A rule that hands off shows a hand-off card ("Your turn: …") with Done and
  Skip; the Bot waits for the answer and never does the step itself.
- On a routine or Telegram turn nobody is there to answer, so a step a rule
  would hand off doesn't run, nor does a step a rule would ask about that has
  no approval of its own. The Bot is told why.

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
  The rules editor says so under the list.
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
call: its ingress, its access, its approval and the rules. A rule that asks
opens the same approval card, which waits as long as a direct call's and is
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
  rules editor shows the defaults with an alert, and the next change starts
  again from them and replaces the file. Before replacing it, Aiden keeps the
  damaged bytes beside it as `rules.json.unreadable` (then
  `rules.json.unreadable.2`, and so on, never over an earlier copy), so rules
  the person wrote can be recovered by hand. A file that can't be read at all
  (permissions, a directory in its place) fails closed the same way, and the
  editor offers Try again.
- Deleting the Bot removes the file and its kept copies, and refuses later writes.
- Phones don't show rules yet.
