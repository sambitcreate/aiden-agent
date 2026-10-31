# Bot rules (plain-language rules + rule-driven hand-offs) — 2026-10-20

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §6 and §4.4 (package P3). Branch `wp/p3-rules`, on top of P1 (hand-offs) and P2 (pause).

## Model
- Shared contract: `renderer/shared/bot-rules.ts`.
  - Classes: credentials, money, purchase, communicate, delete, publish, install. The install rule reads "Install software on your Mac": inside a Bot's own computer installing is not ruled (plan §8.7), so the `computer` surface never yields `install` (a custom rule still can).
  - Behaviors: `ask` and `hand_off`. `allowed` is only a baseline, never a rule.
  - Locked rules (`locked.credentials`, `locked.money`, hand off) are code constants and are never stored.
  - Built-in rules (`default.<class>`, Ask first) can switch to Hand off to me but can't be removed.
  - Custom rules (`custom.<uuid>`) are the person's words completing "When <Bot> wants to …". Limits: 120 characters, 20 rules.
  - The file also holds the labels (`botRuleLabel`, `botRuleBehaviorLabel`), `BOT_RULE_CHANNELS` and `botRuleRefusalText`.
- Rules only make a Bot stricter. `decideBotRule(baseline, rules, classification)` returns `ruled = max(baseline, strictest matching rule)`, ordered allowed < ask < hand_off. On a tie the order is locked, then built-in, then custom. Locked rules are always merged in from code. `decide.test.ts` checks this exhaustively.

## Classifier (`main/services/bot-rules/classify.ts`, `words.ts`)
- Input: `BotClassifiableAction` for one of four surfaces.
  - `computer_use`: built from the Computer Use approval descriptor in `bot-computer-use-approval.ts`. It never carries typed text or a field value.
  - `browser`: fed by `bot-runtime/bot-browser-approval.ts` (P6) from an isolated-world probe of the targeted element; see `.memory/bot-browser.md`. `browserSendKey` makes Enter (Control/Command-Enter on mail hosts) on an editable message composer or a messaging host `communicate`; search boxes, Shift-Enter and unknown boxes are not.
  - `computer`: fed by `bot-runtime/bot-computer-approval.ts` (P10, VNC lane): `{surface:"computer", action, intent}` only (no app, window title or element in that lane). `key` chords that do more than edit text at the caret become action `press`, so their intent reads like a click's (Return to send = communicate); printable chords and `type` stay typing (locked classes only). A plain Backspace/Delete (no modifier but Shift; `botComputerChordErases`) stays typing only when the driver facts' `focused` element has a text-entry role (text field/area, secure, search, combo box), so "Delete the extra letter" in a clicked field is not the delete rule (2026-10-21, H1). Anywhere else (a selected Mail message, the VNC lane with no facts) it is `press`, so "Delete the email" still asks: treating every plain Backspace as typing let a Bot delete a selected message with no question (H1 review). On the guest driver lane those keys keep the focused field (`botComputerChordEditsText`). Typed text never reaches it. The call's `summary` (the intent) is what a rule-made card quotes (`BotLiveApproval.summary`, used when there is no baseline approval). Corpus rows `co-vnc-*` carry only the intent.
  - `mcp`: `describeMcpAction`, for granted mutating tools only. Read-only tools (server `readOnlyHint: true` without `destructiveHint: true`) are not classified, custom rules included. `destructiveHint: false` ("additive") drops the delete class from the name verbs, title and description, so a server that lies avoids the delete rule; the locked classes still read the name and summary, and custom rules still match. Documented in `docs/bot-rules.md`.
- Strong signals:
  - credentials: a secure text role on the element or the focused field; `secureFieldInCapture` while typing; `type=password`; autocomplete `current-password`, `new-password` or `one-time-code`.
  - money: `cc-*` autocomplete, or a payment host (form action, or the URL while typing).
  - communicate: a send key in a messaging app.
  - delete: cmd+Delete in Finder.
  - MCP: the tool-name verbs and `destructiveHint` through `classifySubagentMcpToolV2`.
- Word signals: a suffix stemmer; phrase tables with "a longer phrase wins"; negators ("cancel", "view", "draft", "don't" …) apply within two words, but never to the locked classes.
  - Labels on type, set_value and press count only for the locked classes.
  - An MCP description's first sentence counts only for the non-locked classes.
- Custom rules match when every content word of the rule appears among the action's words. The window title, URL host and app are used for custom rules only.
- Passive actions (scroll, wait, focus_app, set_window_frame, move …) match no rule at all, custom ones included: a custom "book a flight" must not stop a scroll in a window titled "Book a flight".
- `describeMcpAction` (`mcp-action.ts`) reads the live tools/list entry through `facts.mcpToolDescriptor` (the same live inventory the grant was checked against), so a tool's server title, description and `destructiveHint` count, not only its name. `mcp-action.test.ts` covers it, and `bot-tool-assembly.test.ts` checks it end to end.
- Oracle: `fixtures/actions.json` (158 rows, 14 of them P6's browser send-key rows; password, one-time-code and card rows on all four surfaces). The test reports precision and recall per class. Locked classes must have zero misses and precision ≥ 0.9; the others need ≥ 0.85.

## Store (`store.ts`, singleton `store-main.ts`)
- File: `<userData>/bots/<dir>/rules.json`, `{version:1, revision, behaviors, custom}`, parsed strictly. A missing file reads as the defaults at revision 0.
- Fail closed (2026-10-21, H1): a file that doesn't parse exactly makes `rules()` throw `BotRulesUnreadableError`, so enforcement refuses every classifiable call with "This Bot's rules couldn't be read…" (the defaults can be looser than what the person set). `get()` returns the defaults with `unreadable: true` (optional field on `BotRulesView`, desktop IPC only); the editor shows a red alert ("<Bot>’s saved rules couldn’t be read, so <Bot> won’t take any step its rules check. Change a rule below to start again from these defaults."), and `update(…, 0, change)` applies to the defaults and replaces the file. The prompt still gets the defaults (`promptRules`). A file that can't be read at all (EISDIR, EACCES) throws from every method, as before.
- `update(botId, revision, change)`:
  - Serialized per Bot. It writes only for a Bot the Bot store knows (`knownBot` uses `!= null`).
  - `writeJsonAtomic` with mode 0600 and a `beforePublish` re-check.
  - Refusals are results with the current view: stale, locked, invalid, limit, not_found.
- `forgetBot` (from `deleteEffects` in `bot-session-main.ts`) refuses every later write in the process, removes the file, and removes a directory a racing write may have recreated.

## Enforcement (`bot-tool-assembly.ts` checkPolicy, `bot-extension.ts` beforeTool)
- Baseline:
  - Computer Use: `approvalFor` returns `BotLiveApproval {approval|null, action}`. In `bot-tool-sources-main.ts` it is a `switch` on the tool name, so the Bot browser and Bot computer packages each add a `case`.
  - Everything else: `botToolApprovalSummary`.
  - With no classifiable action, or no `rules` port, the baseline decision stands.
- ask:
  - An existing approval keeps its `onAllow` and gains the prefix `Rule · <label> — <summary>`.
  - With no baseline approval, a new rule-made approval is created.
  - Bot approvals never pass `scopes`, so a remembered approval scope never skips a rule-made ask.
- hand_off: `decision.handoff {rule, summary, action, why}`. beforeTool then:
  - stores the approval memo with `kind:"handoff"` and `rule`;
  - asks through `requestHandoff`, which is `ruleHandoffRequest` from `bot-handoffs.ts`: kind `action`, source `rule`;
  - stores the answer memo `aiden.handoff.answer`;
  - records an `aiden.handoff-result` entry through `recordHandoff(record, conversation)`: `recordRuleHandoffEntry` in `bot-handoffs.ts` writes into the `BotRuleHandoffRowTarget` the extension hands over, the stopped call's own conversation through the harness running it (`conversation.commit(tx => tx.appendEntry(...))`, never a submit; nothing when that toolCallId already has a row). `bot-tool-assembly.test.ts` runs it from inside `beforeTool` on a real conversation;
  - never write it through `botSessionRuntime()` / the harness host: a pause, quit or delete holds the host's per-Bot lock while its close waits for this very call, so such a write deadlocked the close (pause timed out, shutdown hung). The extension test "(k)" pauses while the row is being written and checks the turn closes and Resume applies the answer once; a row the closing turn could not write is written on Resume;
  - blocks the call with "The person did this themselves: …" or the skipped text.
  - The answer memo is read before anything else, so a resume applies the answer without asking again or re-deciding.
- Unattended turns (`routine:`, `tg:`): a hand-off, or a rule-made ask with no baseline, blocks at once with `ruleUnattendedBlock` or `ruleAskUnattendedBlock`. A run with no `requestHandoff` dep also fails closed with the unattended text.
- Settings → Bots, routines go ahead (2026-10-31, owner chose option a of the tool audit's Q1): `AppSettings.botRoutinesGoAhead` (off by default; only literal `true` counts, `botRoutinesGoAhead()` in `renderer/shared/bot-rules.ts`). The assembly port `routinesGoAhead()` is read on every call. When every request id of the run is `routine:` (no `tg:`, no person's turn joined) and the tool isn't `computer_use` (the person's Mac), an approval (baseline or rule-made ask, with or without baseline) comes back with `preapproved: true`; `beforeTool` runs its `onAllow` and lets the call through with no memo and no card. Hand-offs and the locked rules are unchanged. Page: `renderer/components/settings/bots-settings.tsx` (section id `bots`); the Rules group on a Bot's profile says what routines do and links there. The CLI durable host has no such port.
- Memos must be JSON values:
  - The approval memo always writes `kind` and `rule` (null when no rule made it).
  - Memos written before rules have neither field and read as approvals: only `kind === "handoff"` changes the summary.
- Live projection: the last `aiden.handoff-result` entry for a call becomes the `handoff_result` row (`handoff:<toolCallId>`, or `handoff:<toolCallId>:<entry id>` when a provider reused the id in a later turn), placed after that call's tool result.

## Prompt
- `renderBotRulesSection(name, rules)` adds a `<bot_rules>` block to the `aiden-authority` section (index 2 of `systemSections`).
- Custom text is escaped with `escapePromptText` and introduced as data, not instructions.
- The block tells the Bot to call `hand_off` itself where it can, and says that shell commands are governed by the Shell setting, not by rules.

## Desktop
- IPC (`main/handlers/bot-rules.ts`, parser `parseBotRulesUpdate` in `bot-params.ts`):
  - `bots:rules:get(botId)` returns the view.
  - `bots:rules:update({botId, revision, change})` returns the result.
  - Malformed input throws. An unknown Bot throws "This Bot no longer exists.".
- `botExistsIn(lookup)` in `bot-memory.ts` is the shared existence check for the memory and rules handlers. The Bot store answers null for a missing Bot, so the check is `!= null`. The memory handlers had used `!== undefined`, which let a deleted Bot's memory be read; that is now fixed.
- UI: `renderer/main/bots/bot-rules.tsx` and `use-bot-rules.ts`, a Profile section after Routines.
  - One grouped card. Locked rows show `LockKeyhole` and "Always" with no menu.
  - Other rows have a ••• menu: `DropdownMenuRadioGroup` Ask first / Hand off to me, plus Edit… and Delete for custom rules.
  - Add a rule opens a Dialog with a text Input and a radio choice shown by `has-[[data-state=checked]]:bg-list-selection` fill.
  - A refused change shows a red Callout with `botRuleRefusalText` and the fresh view.
  - There is no cross-window push: the stale refusal covers concurrent edits.
- Onboarding Bots step line: "Bots hand you the steps only you should do, and follow rules you set."

## Tests
- `npm run test:bot-rules`: the services tests in the runtime-subagents lane; handler, editor and shared tests in renderer-other.
- Rule cases extend `bot-tool-assembly.test.ts`, `bot-extension.test.ts`, `computer-use-tool.test.ts`, `bot-delete.test.ts`, `live-projection.test.ts`, `bot-memory.test.ts`, `bot-profile.test.tsx` and `onboarding-bots-step.test.tsx`.
- Testing Library gotcha: never `assert.equal(domNode, null)` inside `waitFor`. Node's assert builds a Myers diff of the inspected node, which blocks the event loop for minutes. Use `assert.ok(!query…)`.

## Docs
- `docs/bot-rules.md` (2026-10-21, H1): the rules, what they check and don't, MCP annotations taken at their word, rule hand-off cards, the file and its fail-closed read.
- Same file, "Routines that go ahead (Settings → Bots)" (2026-10-31); also `docs/bot-routines.md`, `docs/settings-design-system.md` → Bots, README and the aiden-help `bots` topic.

## Not yet
- Phones show no rules. A read-only list needs a Bot-detail field (Remote revision 37+).
- The computer surface's VNC lane depends on the Bot's own stated intent (plan §8.7 known gap; the rules editor notes it where `AppCapabilities.botComputers`). The guest driver lane (P11) adds element roles and window titles. `computer_shell` is not classified.
- The shell is outside rules by design. Under Full access, a shell command could edit `rules.json`; the locked rules still hold because they come from code.
