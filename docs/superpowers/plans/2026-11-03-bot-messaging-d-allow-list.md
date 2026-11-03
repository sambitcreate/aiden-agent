# Bot messaging D: the allow list and the repeat-approval nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aiden counts a Bot's approvals per action class in main. After the third approval of the same class in 14 days with no denial, that class's card offers **Always allow for <Bot>** and the tool result tells the Bot so it can mention it. Each Bot gets an **Allowed without asking** list (desktop profile, Settings → Bots, and phones) with Remove. An entry never skips a locked rule, a rule-made ask, or Computer Use on the person's Mac.

**Architecture:** What Bots remember today, found in the code:
- A Bot tool approval is binary. `bot-approvals.ts` puts it on a `ToolApprovalCoordinator` without `scopes`, so the coordinator treats every answer as "once". `.memory/bot-rules.md` records the invariant: "Bot approvals never pass `scopes`, so a remembered approval scope never skips a rule-made ask".
- The only remembered "always" approvals are the workspace chat's. `ToolApprovalRuleBook` (`main/services/tool-approval-rules.ts`) holds exact `run_command`/`write_file`/`edit_file` rules in `<userData>/tool-approval-rules.json`. The coordinator only honors a scope a card offered (`settleDecision`), and `takeDecisionPayload` hands it back to the caller.
- Computer Use's "Always allow" (`settings.computerUseAlwaysAllow` and the chat's `computerUseAllowed`) is a global access switch, not a per-action approval. It stays as it is.

This plan extends those pieces. It does not invent a parallel store:
1. Bot entries become a second list in the same `ToolApprovalRuleBook` document (`botRules`), typed next to `ToolApprovalScope` in `renderer/shared/tool-approval-scope.ts`.
2. Bot cards pass `scopes: ["once","always"]` only when the nudge applies. The answer's scope comes back through `takeDecisionPayload`, as it does for workspace chats.
3. The policy check (`bot-tool-assembly.ts` `checkPolicy`) consults the list only where no rule matched (`rule === undefined`). Locked rules and rule-made asks always set `rule`, so they never reach the list. A match reuses the existing `preapproved` path that "routines go ahead" uses.
4. Counting lives in a small per-Bot ledger next to `rules.json` (`approval-tallies.json`). Counts change on every answer and must disappear with the Bot's folder, so they are not remembered approvals.

**Tech Stack:** TypeScript, Electron main and renderer (React, TanStack Router and Query), Pi Durable (pinned; uses its existing `afterTool` hook), `node:test` through `tsx --test`, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/plans/bot-to-bot-messaging-research.md`](../../plans/bot-to-bot-messaging-research.md) §13 and §14 step 4, with §11.5 and §12's Computer Use and locked-rule limits. Section numbers (§n) below refer to it.

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only. Never `readFileSync` production source and `assert.match` against it. No tautological or change-detector tests.
- Values from the spec, verbatim:
  - The threshold is "the same class 3 times in 14 days, with no recent denial". "Recent denial" means a denial of that class in the same 14 days.
  - The card choice is "**Always allow for <Bot>**".
  - The list is "**Allowed without asking**". Each entry shows what it covers, when it was added and how often it has been used, with **Remove**.
  - "They never skip a locked rule or a rule-made ask."
  - "Computer Use on the person's own Mac keeps its own access card."
  - "The nudge also covers repeated `request_access` for the same folder."
- What counts as a class (decided here):
  - A connection tool: `{kind:"connection", serverId, tool}` from `describeMcpAction`'s `serverId` and `remoteName`.
  - A browser step on one site: `{kind:"site", host, action}` from the browser action's URL. The host is lowercased and loses a leading `www.`. The action is `click`, `type` or `press`.
  - A folder: `{kind:"folder", path}` from `request_access`. Its "Always" stays Plan B's "Always for this folder". Once saved it shows in the list (owner pick 12): every `approved_location` the Bot's Custom access holds is an entry, and Remove takes the folder out of that Bot's access. Folder entries show when they were added but no use count, because file tools don't report uses per folder.
  - Share image and the Bot's own computer have no class: share image has no classifiable action, and the Bot computer needs no approval. The Bot shell needs no approval today, so it has no entries.
- Limits: at most 50 entries per Bot and 1,000 in all. A ledger keeps at most 100 classes per Bot and 20 approval times per class. The Bot is hinted at most once per class every 7 days.
- Deep links:
  - The list is `/bots/<encodeURIComponent(botId)>?page=allowed`, a new `BotSubpage`. Settings is `/settings?section=bots`.
  - A Bot's reply can't carry an in-app link: assistant markdown opens `https:` only (`markdown.tsx` `RestrictedLink`). So the link lives on Aiden's own UI: a toast after Always allow, and the profile row. The Bot's hint names the place in words.
- Phones show the list, can Remove from it, and get the Always choice (owner pick 10). The shared `POST /approvals/{id}/respond` route already takes `scope`; `aiden-remote-bot-session.ts:1906` accepts `"always"` only for a device with `bot:allowed` on a card that offers it.
- Remote: claim the next contract revision after `main`'s at merge, provisionally 54 (this branch's tip is `AIDEN_REMOTE_NEW_WORKTREE_CONTRACT_REVISION = 53`, `main/services/aiden-remote-protocol.ts:282`). Plans A–C may claim revisions first. Update these together: iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md`, and the revision assertion in `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift`.
- Use an opt-in capability (`bot:allowed`), not a feature token. Phones already hear the most feature tokens shipped clients accept (see revision 49's note).
- New tests go in a new `"test:bot-allowed"` script, with `"pretest:bot-allowed": "npm run build:lease-flock"`. Append it to the `test:serial` chain, and if `main` changed the chain, resolve by union. Register every new test file in `scripts/ci-test-registry.json` too. Extended existing test files stay in their scripts.
- Modules under `main/services/` don't import `electron`, except `*-main.ts` wiring. The CLI bundles `bot-tool-assembly.ts`, `bot-extension.ts` and `bot-approvals.ts`. The CLI passes no allow-list port, so it never offers or matches. Run `npm run test:cli`.
- No new analytics events. No onboarding change: the nudge appears in context and isn't a first-run choice.
- UI follows `GUI.md`, `docs/design-guide.md` and `docs/settings-design-system.md`: grouped `FieldSet` cards, inset rows, trailing controls, the shared button shapes, no decorative borders, visible `focus-visible` rings. Copy stays minimal.
- Pre-1.0: no migration. The document stays `version: 1`, and `botRules` is optional.
- This plan depends on Plan B (`request_access`) only in Task 5, step 5. Plan B lands first in the stack (A → B → C → D), so the hook goes into B's real settle point, `answerBotAccessRequest` in `main/services/bot-runtime/bot-access-requests.ts`, and B's tool result in `bot-access-request-tool.ts`.

## Review Focus

1. **A rule the person adds after an entry exists.** For example, a custom rule "create events" set to Ask first, after Calendar · Create event was always-allowed. The card must come back, prefixed "Rule · …". Task 3 tests this.
2. **One denial among many approvals.** Five Allow and then one Deny must withhold the offer for 14 days from the denial, and a later run of three approvals offers again. Task 2 tests this.
3. **Two cards for the same class waiting at once** (two connection calls in one reply). Answering the first with Always allow must also let the second through, not leave it waiting. Task 5 tests this.
4. **Remove while the Bot is mid-turn.** The very next matching call must ask again, with no cached match. Task 3 tests this.
5. **`www.` and letter case in site hosts.** `https://WWW.Amazon.com/cart` and `https://amazon.com/` must be one class, so the count and the entry agree. Task 3 tests this.

---

### Task 1: Bot entries in the remembered-approval store

**Files:**
- Modify: `renderer/shared/tool-approval-scope.ts` (append the Bot types)
- Modify: `main/services/tool-approval-rules.ts:36-44` (document), `:149-170` (normalize), `:185-295` (`ToolApprovalRuleBook`)
- Test: `main/services/tool-approval-rules.test.ts` (extend)

**Interfaces:**
- Produces, in `renderer/shared/tool-approval-scope.ts`:
  ```ts
  export type BotApprovalSiteAction = "click" | "type" | "press";
  export type BotApprovalRuleTarget =
    | { kind: "connection"; serverId: string; tool: string }
    | { kind: "site"; host: string; action: BotApprovalSiteAction };
  export interface BotApprovalRuleView {
    id: string; botId: string; target: BotApprovalRuleTarget;
    label: string;            // "Google Calendar · Create event", captured when added
    createdAt: string; uses: number; lastUsedAt?: string;
  }
  export const BOT_APPROVAL_RULES_PER_BOT_MAX = 50;
  export function botApprovalRuleKey(target: BotApprovalRuleTarget): string; // stable JSON tuple
  export function describeBotApprovalRule(rule: Pick<BotApprovalRuleView, "target" | "label">): string;
  // connection → label; site → "Click on amazon.com" | "Type on amazon.com" | "Press keys on amazon.com"
  export function botAlwaysAllowLabel(botName: string): string; // "Always allow for Jester"
  /** One row of the list: a remembered approval, or a folder in the Bot's Custom access. */
  export type BotAllowedEntry =
    | { kind: "rule"; id: string; botId: string; what: string; createdAt: string; uses: number; lastUsedAt?: string }
    | { kind: "folder"; id: string; botId: string; what: string; createdAt: string };   // id: "folder_<sourceId>"; what: "Folder · ~/Documents/Taxes"
  ```
- Produces, in `main/services/tool-approval-rules.ts`: `ToolApprovalRulesDocument.botRules?: BotApprovalRuleView[]`, plus these `ToolApprovalRuleBook` methods:
  ```ts
  matchBot(botId: string, target: BotApprovalRuleTarget): Promise<BotApprovalRuleView | undefined>;
  grantBot(botId: string, target: BotApprovalRuleTarget, label: string): Promise<BotApprovalRuleView>; // idempotent per (botId, key)
  listBot(botId?: string): Promise<BotApprovalRuleView[]>;   // newest first; every Bot when omitted
  recordBotUse(botId: string, ruleId: string): Promise<void>;
  revokeBot(botId: string, ruleId: string): Promise<boolean>;
  forgetBot(botId: string): Promise<number>;
  onBotChange(listener: (botId: string) => void): () => void;
  ```
  `list()`, `revoke()`, `revokeAll()` and `onChange()` keep their meaning: workspace rules only.

- [ ] **Step 1: Write the failing tests** in `tool-approval-rules.test.ts`. Use the file's in-memory store, a fixed `now`, and `CAL = {kind:"connection", serverId:"gcal", tool:"create_event"}`:
  - `a Bot entry covers only its own Bot and exact target`: after `grantBot("bot:a", CAL, "Google Calendar · Create event")`:
    - `matchBot("bot:a", CAL)?.label === "Google Calendar · Create event"`;
    - `matchBot("bot:b", CAL) === undefined`;
    - `matchBot("bot:a", {...CAL, tool: "delete_event"}) === undefined`.
  - `granting the same target twice keeps one entry and its first createdAt`.
  - `recordBotUse counts uses and stamps lastUsedAt`: two calls give `uses === 2` and `lastUsedAt === now().toISOString()`. An unknown rule id changes nothing.
  - `Bot entries stay out of Settings → Tool approvals`:
    - `list()` returns only workspace rules;
    - `revokeAll()` leaves `listBot()` unchanged;
    - `forgetBot("bot:a")` returns 2 and leaves `bot:b`'s entries.
  - `the 51st entry for one Bot is refused`: rejects with `/at most 50/`. A different Bot can still add one.
  - `a hand-edited Bot entry that is not canonical is dropped`: `normalizeToolApprovalRulesDocument` keeps one valid entry and drops:
    - `host: "WWW.Amazon.com"`;
    - `kind: "shell"`;
    - `uses: -1`;
    - an empty `label`;
    - a duplicate `(botId, key)`.
  - `onBotChange hears the Bot id on grant, use, revoke and forget`, and `onChange` (the workspace listener) hears none of them.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/tool-approval-rules.test.ts`. Expected: FAIL (`grantBot is not a function`).
- [ ] **Step 3: Implement.**
  - Reuse `validWorkspaceId`'s checks for `botId`, `serverId` and `tool` (at most 256 characters, no control characters).
  - A stored `host` must already be canonical: lowercase, no leading `www.`, `[a-z0-9.-]`, at most 253 characters. A hand edit can't widen it, the same rule `normalizeRule` uses for patterns.
  - Labels are trimmed and kept to 200 characters.
  - `grantBot` throws `Aiden keeps at most 50 things a Bot can do without asking. Remove some on its profile.`
  - Writes go through the existing `store.update`. `notifyBot(botId)` mirrors `notify()`.
- [ ] **Step 4: Run the tests.** `npx tsx --test main/services/tool-approval-rules.test.ts renderer/components/settings/tool-approval-settings.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit.** "Remember Bot approvals in the tool approval store"

### Task 2: The per-Bot approval tally

**Files:**
- Create: `main/services/bot-runtime/bot-approval-tallies.ts`
- Create: `main/services/bot-runtime/bot-approval-tallies.test.ts`
- Modify: `package.json` (new `test:bot-allowed` and `pretest:bot-allowed`, appended to `test:serial`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `BotApprovalRuleTarget` and `botApprovalRuleKey` (Task 1); `botSessionDirectory` and `createKeyedSerial` (`main/services/bot-routine-notes.ts`); `writeJsonAtomic` (`main/services/durable-fs.ts`). Follow `main/services/bot-delivery/log.ts` for layout and serial writes.
- Produces:
  ```ts
  export const BOT_APPROVAL_TALLIES_FILE = "approval-tallies.json";
  export const BOT_APPROVAL_NUDGE_THRESHOLD = 3;
  export const BOT_APPROVAL_NUDGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  export const BOT_APPROVAL_HINT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
  export type BotApprovalTallyKey = BotApprovalRuleTarget | { kind: "folder"; path: string };
  export interface BotApprovalTallies {
    record(botId: string, key: BotApprovalTallyKey, outcome: "allowed" | "denied"): Promise<void>;
    /** Approvals in the window when ≥ threshold and none denied in it; else undefined. */
    nudge(botId: string, key: BotApprovalTallyKey): Promise<{ count: number } | undefined>;
    /** True at most once per class per cooldown; marks the hint as given. */
    takeHint(botId: string, key: BotApprovalTallyKey): Promise<boolean>;
    forget(botId: string, key: BotApprovalTallyKey): Promise<void>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotApprovalTallies(options: { profileDir(): string; now?(): number }): BotApprovalTallies;
  ```
  The file is `<profile>/bots/<dir>/approval-tallies.json`: `{version:1, classes:[{key, allowed:number[], deniedAt?, hintedAt?}]}`. Every write drops entries outside the window, keeps 20 times per class and 100 classes (least recent dropped). An unreadable file reads as empty and is replaced on the next write.

- [ ] **Step 1: Write the failing tests** in `bot-approval-tallies.test.ts`. Use a temp profile dir and a settable clock; `DAY = 86_400_000`:
  - `offers on the third approval in 14 days`: two `record(…,"allowed")` give `nudge === undefined`; a third gives `{count: 3}`.
  - `approvals older than 14 days don't count`: three at day 0, and at day 14 plus 1 ms `nudge === undefined`.
  - `a denial withholds the offer for 14 days` (Review Focus 2):
    - five approvals on days 0–2 and a denial on day 3 give `undefined` on day 4;
    - approvals on days 15, 16 and 17 give `{count: 3}` on day 17.5 (the denial is now more than 14 days old).
  - `the hint is given once a week`: `takeHint` is `true`, then `false` at day 6, then `true` at day 7 plus 1 ms.
  - `classes are independent`: a folder `"/Users/p/Taxes"` key and `CAL` count separately. `forget(CAL)` resets only `CAL`.
  - `counts survive a reopen and stay bounded`: 30 approvals in a day give `count === 20` from a fresh instance on the same dir.
  - `forgetBot removes the file`: the Bot directory has no `approval-tallies.json` afterwards.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-approval-tallies.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `createBotApprovalTallies`.** Per-Bot serial writes. Keys are `botApprovalRuleKey`, or `JSON.stringify(["folder", path])` for folders.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Register and commit.** Add the file to `test:bot-allowed` and to the CI registry lane that holds `main/services/bot-rules/*.test.ts`. Commit: "Count a Bot's approvals per class".

### Task 3: Which class a call is, and the policy check

**Files:**
- Create: `main/services/bot-runtime/bot-allow-target.ts`, `main/services/bot-runtime/bot-allow-target.test.ts`
- Modify: `main/services/bot-runtime/bot-extension.ts:120-135` (`BotApprovalRequirement.remember`)
- Modify: `main/services/bot-runtime/bot-tool-assembly.ts:113-122` (ports), `:276-293` (the no-rule branch); update the header comment's "Routines go ahead" paragraph with one line on entries
- Test: `main/services/bot-runtime/bot-tool-assembly.test.ts` (extend)

**Interfaces:**
- Consumes: `BotClassifiableAction` (`main/services/bot-rules/classify.ts:61`), `COMPUTER_USE_TOOL_NAME`, and the Task 1 types.
- Produces:
  ```ts
  // bot-allow-target.ts
  export function botApprovalTargetOf(
    toolName: string, action: BotClassifiableAction | undefined,
  ): { target: BotApprovalRuleTarget; title: string } | undefined;
  // mcp → connection (title: annotations.title ?? remoteName); browser http(s) → site (title: host);
  // computer_use, computer, a missing serverId, a non-http(s) URL → undefined

  // bot-extension.ts, on BotApprovalRequirement
  remember?: { target: BotApprovalRuleTarget; title: string; offer?: { count: number } };

  // bot-tool-assembly.ts
  export interface BotAllowListPort {
    match(botId: string, target: BotApprovalRuleTarget): Promise<{ id: string } | undefined>;
    offer(botId: string, target: BotApprovalRuleTarget): Promise<{ count: number } | undefined>;
    used(botId: string, ruleId: string): Promise<void>;
  }
  // BotToolAssemblyPorts.allowList?: BotAllowListPort
  ```
- Rule for `checkPolicy`: replace `if (ruled === "allowed" || rule === undefined) return asBaseline;` with this branch. When `rule === undefined && baseline !== undefined && !goAhead && toolName !== COMPUTER_USE_TOOL_NAME` and `botApprovalTargetOf` gives a target:
  - `match` hits: return `{allowed:true, approval:{...baseline, preapproved:true, onAllow}}`. The new `onAllow` runs the baseline's `onAllow` first (the browser binding still asserts the page), then `used(...)`, which never fails the call.
  - Otherwise: return `ask({...baseline, remember:{target, title, ...(offer && {offer})}})`.
  - A rejected `match` asks. A rejected `offer` asks without an offer.
  - Every other path is unchanged. With no `rules` port (the CLI) nothing reaches this branch.
  - Stacked on Plan C, where `asBaseline` is a function and `ask` already checks plan coverage. Keep this order: the rule decision, then plan coverage, then this allow-list match. A call a plan covers counts against the plan and doesn't use the entry.

- [ ] **Step 1: Write the failing target tests** in `bot-allow-target.test.ts`:
  - `a mutating connection call is its server and tool`: `{surface:"mcp", serverId:"gcal", remoteName:"create_event", annotations:{title:"Create event"}, …}` gives `target {kind:"connection", serverId:"gcal", tool:"create_event"}` and `title "Create event"`. Without a title, `title === "create_event"`.
  - `hosts ignore case and a leading www.` (Review Focus 5): browser_click on `https://WWW.Amazon.com/cart` and on `https://amazon.com/` give the same `botApprovalRuleKey`, with `host "amazon.com"` and `action "click"`. `browser_type` gives `"type"`.
  - `no class`: `computer_use`, `computer`, `mcp` with `serverId: ""`, and a browser URL of `file:///x` or `about:blank` all give `undefined`.
- [ ] **Step 2: Write the failing policy tests** in `bot-tool-assembly.test.ts`. Use a fake `allowList` that records calls and build on the existing helpers: `ruledTurn`, `rulesWith`, `PLACE_ORDER`, and the connection fixture from `a mutating connection tool asks for approval…` (line ~413). For browser cases, add `"browser"` to the test authority's other grants the way `BOT_COMPUTER_TOOL_NAME` adds `"computer"`.
  - `an entry lets a matching connection call run without a card and counts its use`: `match → {id:"r1"}`. Expect `deps.approvals` to be `[]`, one execution, and `used` called with `["bot", "r1"]`.
  - `an entry's browser call still checks its page binding`: browser_click on a site with a match, and an `onAllow` that throws `"The page changed."`. Expect the call blocked with that text and `used` not called.
  - `an entry never covers a rule-made ask, a locked rule or Computer Use` (Review Focus 1): with `match` always hitting:
    - `PLACE_ORDER` under `rulesWith("ask")` gives one card `Rule · ${PURCHASE_LABEL} — …`;
    - a custom rule whose words match the connection call gives one `Rule · …` card;
    - a credentials-typing browser action gives a hand-off and no execution;
    - `computer_use` with an action no rule matches gives one card.
    - In all four, `match` is never called.
  - `without an entry the approval carries its class and the offer`: call `checkPolicy` directly with `offer → {count: 3}`. Expect `decision.approval.remember` to deep-equal `{target: CAL_TARGET, title: "Create event", offer: {count: 3}}`. With `offer → undefined` there is no `offer` key.
  - `a failing allow list falls back to the card`: `match` rejects. Expect one card and no execution before Allow.
  - `Remove takes effect on the very next call` (Review Focus 4): two connection calls in one reply, with `match` hitting for the first and missing after a flag flips between them. Expect one execution without a card, then one card.
  - `a routine run that goes ahead neither matches nor offers`: `routinesGoAhead: () => true` on `routine:daily:fire-1`. Expect `match` and `offer` not called.
- [ ] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-allow-target.test.ts main/services/bot-runtime/bot-tool-assembly.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `botApprovalTargetOf` and the `checkPolicy` branch above. Hosts come from `new URL(url).hostname`.
- [ ] **Step 5: Run the tests.** The same files, then `npm run test:bot-runtime` and `npm run test:bot-rules`. Expected: PASS.
- [ ] **Step 6: Register and commit.** Add `bot-allow-target.test.ts` to `test:bot-allowed` and the registry. Commit: "Let a Bot's allow list skip a plain approval, never a rule".

### Task 4: The card's Always allow and the Bot's hint

**Files:**
- Modify: `main/services/bot-runtime/bot-approvals.ts` (offer, scope, answer)
- Create: `main/services/bot-runtime/bot-approvals.test.ts`
- Modify: `main/services/bot-runtime/bot-extension.ts:200-209` (`BotApprovalRequest`), the `BotExtensionDeps` block (~`:259`), `:619-655` (`beforeTool` approval branch), the `ToolTask` hook (~`:538`) for `afterTool`
- Modify: `packages/cli/src/bot-durable.ts:150` only if the type change requires it (no behavior)
- Test: `main/services/bot-runtime/bot-extension.test.ts` (extend)

**Interfaces:**
- Consumes: `remember` from Task 3, and `botApprovalRuleKey` from Task 1.
- Produces:
  ```ts
  // bot-extension.ts
  export type BotApprovalAnswer = "allow" | "allow_always" | "deny";
  // BotApprovalRequest gains: always?: { key: string; count: number }
  // BotExtensionDeps.requestApproval(request): Promise<BotApprovalAnswer>
  // BotExtensionDeps gains:
  settleApproval?(input: {
    botId: string;
    remember: NonNullable<BotApprovalRequirement["remember"]>;
    answer: BotApprovalAnswer;
  }): Promise<{ hint?: string }>;

  // bot-approvals.ts
  // BotApprovalPrompt gains: always?: { key: string; count: number }
  // BotApprovals.request(request): Promise<BotApprovalAnswer>
  // BotApprovals.decide(waitId: string, decision: "allow" | "deny", scope?: "always"): boolean
  ```
- Behavior:
  - `request` passes `scopes: ["once", "always"]` to the coordinator only when `request.always` is set. On `"allowed"` it reads `coordinator.takeDecisionPayload(\`bot:${botId}\`, toolCallId)?.scope`, and `"always"` returns `"allow_always"`. The coordinator already drops a scope it didn't offer.
  - `beforeTool` sets `always: {key: botApprovalRuleKey(remember.target), count: remember.offer.count}` when there is an offer.
  - `deny` blocks as today. `allow` and `allow_always` both run `onAllow`.
  - After any answer to an approval with `remember`, `beforeTool` checks the tool-task memo `aiden.approval.settled`. If the memo is absent, it calls `settleApproval` and memoizes `{hint: hint ?? null}`, so a re-run hook never counts twice.
  - `afterTool` appends `{type:"text", text: "\n\n" + hint}` to `result.output` when the memo has a hint, the result isn't `isError`, and `output` is an array.

- [ ] **Step 1: Write the failing bridge tests** in `bot-approvals.test.ts`. Use `createBotApprovals({publish})` and capture prompts:
  - `Always is honored only when the card offered it`:
    - with `always: {key:"k", count:3}`, `decide(waitId, "allow", "always")` resolves `"allow_always"`, and the published prompt has `always.count === 3`;
    - without `always`, the same decide resolves `"allow"`.
  - `a deny with a scope is still a deny`.
  - `pending lists the offer` until the answer, then nothing.
- [ ] **Step 2: Write the failing extension tests** in `bot-extension.test.ts`. Use the existing scenario helpers, and a `checkPolicy` returning an approval with `remember: {target: CAL_TARGET, title: "Create event", offer: {count: 3}}`:
  - `an offered card asks with always and settles allow_always without a hint`: the recorded request has `always.count === 3`. `settleApproval` is called once with `answer "allow_always"`, the tool runs, and the result text has no `Aiden note`.
  - `Allow once on an offered card appends the hint to the tool's result`: `settleApproval` returns `{hint: "Aiden note: test"}`. The committed tool result ends with `Aiden note: test`. A tool that returns `isError` gets no hint.
  - `Deny settles a denial and blocks`: one settle with `"deny"`, and the result is "The person declined this action.".
  - `an approval without remember never settles`.
  - `a re-run hook settles once`: run `beforeTool` twice for the same call through the scenario's resume path, like the existing share_image resume test, answering allow both times. Expect `settleApproval` called once.
- [ ] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-approvals.test.ts main/services/bot-runtime/bot-extension.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the bridge and the extension changes above. The `answer !== "allow"` check at `:648` becomes `answer === "deny"`.
- [ ] **Step 5: Run the tests.** The same files, then `npm run test:bot-runtime` and `npm run test:cli`. Expected: PASS.
- [ ] **Step 6: Register and commit.** Add `bot-approvals.test.ts` to `test:bot-allowed` and the registry. Commit: "Offer Always allow on a repeated Bot approval".

### Task 5: The allow-list service, wiring, folders and delete

**Files:**
- Create: `main/services/bot-runtime/bot-allow-list.ts`, `main/services/bot-runtime/bot-allow-list.test.ts`
- Modify: `main/services/bot-runtime/bot-session-main.ts:239-245` (assembly `allowList` port), `:414` (`settleApproval`), `:802-826` (`deleteEffects`)
- Modify: `main/services/bot-runtime/bot-access-requests.ts` (`answerBotAccessRequest`, Plan B Task 5) and `main/services/bot-runtime/bot-access-request-tool.ts` (its tool result, Plan B Task 7) for the folder nudge
- Modify: `.memory/bot-rules.md` (Enforcement: the "never pass `scopes`" line becomes "pass scopes only for an Always allow offer; rule-made asks never get one"; a new "Allow list" section), `.memory/bot-durable-runtime.md` (Approvals line), `docs/bot-rules.md` (new "Allowed without asking" section after "Routines that go ahead")

**Interfaces:**
- Consumes: `ToolApprovalRuleBook` Bot methods (Task 1), `BotApprovalTallies` (Task 2), `BotAllowListPort` (Task 3), `settleApproval`'s input (Task 4), and `BotApprovals.pending/decide` (Task 4).
- Produces:
  ```ts
  export interface BotAllowList extends BotAllowListPort {
    settle(input: { botId: string; remember: NonNullable<BotApprovalRequirement["remember"]>; answer: BotApprovalAnswer }): Promise<{ hint?: string }>;
    /** Rules plus the Bot's Custom `approved_location` selections, newest first; every Bot when omitted. */
    list(botId?: string): Promise<BotAllowedEntry[]>;
    /** A rule: `revokeBot`. A folder: `BotApplicationService.revokeBotFolder`. */
    remove(botId: string, entryId: string): Promise<boolean>;
    folderOffer(botId: string, path: string): Promise<{ count: number } | undefined>;
    settleFolder(input: { botId: string; path: string; answer: "once" | "always" | "not_now"; offered: boolean }): Promise<{ hint?: string }>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotAllowList(deps: {
    rules: Pick<ToolApprovalRuleBook, "matchBot" | "grantBot" | "listBot" | "recordBotUse" | "forgetBot">;
    tallies: BotApprovalTallies;
    approvals: Pick<BotApprovals, "pending" | "decide">;
    botName(botId: string): Promise<string | undefined>;
    connectionName(serverId: string): Promise<string | undefined>;
    log?(message: string, error: unknown): void;
  }): BotAllowList;
  export function botApprovalNudgeHint(input: { label: string; count: number; choice: string; place?: string }): string;
  ```
- Exact hint copy:

  `Aiden note: the person has approved “${label}” ${count} times in the last 14 days. Once, in one short sentence of your own, tell them they can stop being asked: “${choice}” on the next card${place ? `, or ${place}` : ""}. Don't bring it up again.`

  - Connections and sites: `choice = botAlwaysAllowLabel(name)` and `place = "Allowed without asking on your profile"`.
  - Folders: `choice = "Always for this folder"` and no `place`.
  - `count` is the offer's count plus this approval.
- Settle rules:
  - `deny` records a denial.
  - `allow` records an approval. With an offer and `takeHint`, it returns the hint.
  - `allow_always`:
    1. Calls `grantBot` with the label: `${connectionName ?? "Connected app"} · ${title}`, or `describeBotApprovalRule` for a site.
    2. Forgets the tally.
    3. Decides `"allow"` on every other pending prompt of that Bot whose `always.key` matches.
    4. Returns no hint.
  - A `grantBot` failure is logged and counted as `allow`.
  - `offer` returns `undefined` when the Bot already has 50 entries.

- [ ] **Step 1: Write the failing tests** in `bot-allow-list.test.ts`. Use a real `ToolApprovalRuleBook` on an in-memory store, real tallies on a temp dir, and a fake `approvals`:
  - `Always allow adds an entry named after the app and clears the count`: `connectionName("gcal") → "Google Calendar"`, three `allow` settles, then `allow_always`. Expect:
    - `listBot("bot")[0].label === "Google Calendar · Create event"`;
    - `match` returns its id;
    - `offer` is `undefined` afterwards.
  - `Always allow also lets the other waiting card for the same class through` (Review Focus 3): pending prompts `w1` (key `K`), `w2` (key `K`) and `w3` (another key). Settling `w1`'s call with `allow_always` decides `w2` with `"allow"`, and leaves `w1` (already answered) and `w3` alone.
  - `Allow once on an offered card hints once a week`:
    - the first settle returns a hint containing `“Google Calendar · Create event”`, `4 times`, `“Always allow for Jester”` and `Allowed without asking on your profile`;
    - a second settle the next day returns no hint.
  - `no offer without three approvals, and none at 50 entries`.
  - `used counts a use`: after `used("bot", id)`, `listBot("bot")[0].uses === 1`.
  - `folders nudge the fourth request for the same folder`:
    - three `settleFolder({answer:"once"})` make `folderOffer("bot", "/Users/p/Taxes")` give `{count: 3}`;
    - the next once-settle with `offered: true` hints `“Always for this folder”` without `Allowed without asking`;
    - `answer: "always"` forgets the count;
    - `"not_now"` records a denial.
  - `forgetBot removes the Bot's entries and its tally file`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-allow-list.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `createBotAllowList`.**
- [ ] **Step 4: Wire it in `bot-session-main.ts`:**
  - `const botApprovalTallies = createBotApprovalTallies({ profileDir: () => app.getPath("userData") })`, the same root `bot-delivery/funnel-main.ts` uses;
  - `const botAllowList = createBotAllowList({ rules: toolApprovalRules, tallies: botApprovalTallies, approvals: botApprovals, botName, connectionName: async (id) => (await configStore.listMcpServers()).find((s) => s.id === id)?.name, log: (m, e) => logger.warn("bots", m, e) })`;
  - pass `allowList: botAllowList` to `createBotToolAssembly`;
  - pass `settleApproval: (input) => botAllowList.settle(input)` and `requestApproval: (request) => botApprovals.request(request)` (the type changes, the call doesn't);
  - add `(botId) => botAllowList.forgetBot(botId)` to `deleteEffects` before `eraseBotData`.
- [ ] **Step 4b: Add `revokeBotFolder` and folder entries (owner pick 12).** In `main/services/bot-application-service.ts`, next to Plan B's `grantBotFolder`, add `revokeBotFolder(input: { audienceId: string; botId: string; sourceId: string }): Promise<boolean>`. It saves through `updateBotAccess` with `nextBotFileScopeIds(policy.custom.fileScopeIds, snapshot.catalog.fileScopes, option.id, false)` and the same `refuseDriftedGrants` message; a Full-access Bot or an unselected folder returns `false`. It leaves the approved root in place. Tests:
  - `list includes the folders in a Custom Bot's access`: a Custom Bot with one rule and one `approved_location` gives one `kind: "rule"` and one `kind: "folder"` row whose `what` is `Folder · ~/Documents/Taxes`. A Full-access Bot gives no folder rows.
  - `removing a folder entry takes it out of the Bot's access`: `remove(bot, "folder_root_a")` returns true, the saved `custom.fileScopeIds` no longer holds that option, `bot_home` stays, and the next `list` has no folder row.
  - `removing a folder another Bot uses leaves that Bot's access alone`.
- [ ] **Step 5: Hook `request_access` (Plan B).** Make these three changes at B's card settle point and its tool result:
  - before raising a folder card, call `folderOffer(botId, path)`, and when it returns a count show the line `You’ve allowed this folder ${count} times in the last 2 weeks.` (B's card already has Always for this folder);
  - after the answer, call `settleFolder`;
  - append the returned hint to the tool result.
  
  Whole Mac requests are never counted, since only Allow once exists for them. Extend B's card test: `the fourth request for the same folder shows the count`, and `a Whole Mac request never does`.
- [ ] **Step 6: Run the tests.** `npm run test:bot-allowed`, `npm run test:bot-runtime`, `npm run test:bot-rules`, and B's suite. Expected: PASS.
- [ ] **Step 7: Update** `.memory/bot-rules.md`, `.memory/bot-durable-runtime.md` and `docs/bot-rules.md`. The doc section covers: what counts as a class; 3 in 14 days with no denial; Always allow for <Bot>; what entries never cover (locked rules, rule-made asks, Computer Use on your Mac); entries apply on every turn kind; Remove.
- [ ] **Step 8: Register and commit.** Add the test file to `test:bot-allowed` and the registry. Commit: "Count, remember and hint repeated Bot approvals".

### Task 6: Desktop: the card, the profile list and Settings → Bots

**Files:**
- Modify: `main/handlers/bot-params.ts:241-252` (`parseBotApprovalDecision` takes `scope?: "always"`; add parsers)
- Create: `main/handlers/bot-allowed.ts`, `main/handlers/bot-allowed.test.ts`
- Modify: `main/handlers/bots.ts:210-214` (pass the scope; register the new handlers)
- Modify: `renderer/preload-channels.ts:~100` (`"bots:allowed:changed"`), `renderer/lib/ipc.ts:~1776` (`botsApi`), `renderer/lib/queries.ts:~79` (`queryKeys.botAllowed`)
- Modify: `renderer/lib/bot-routes.ts` (`botAllowedLocation`)
- Modify: `renderer/main/bots/bot-chat-pane.tsx:174-243` (`BotApprovalCard`), `:1517-1530` (answer)
- Create: `renderer/components/bots/bot-allowed-list.tsx`, `renderer/components/bots/bot-allowed-list.test.tsx`, `renderer/main/bots/bot-allowed-page.tsx`, `renderer/main/bots/use-bot-allowed.ts`
- Modify: `renderer/main/bots/bot-page-search.ts` (`"allowed"`), `renderer/main/bots-view.tsx:146-178`, `renderer/main/bots/bot-profile.tsx:~332` (row after `<BotRules>`), `renderer/components/settings/bots-settings.tsx`
- Test: extend `main/handlers/bot-params.test.ts`, `renderer/main/bots/bot-chat-pane.test.tsx`, `renderer/main/bots/bot-profile.test.tsx`, `renderer/main/bots-view.test.tsx`, `renderer/components/settings/bots-settings.test.tsx`
- Docs: `docs/settings-design-system.md` (Bots section), `README.md` and `PRODUCT.md` (Bot approvals line), `resources/aiden-help/manifest.json` (`bots` topic sentence), `docs/plans/README.md` (status row)

**Interfaces:**
- Consumes: `BotApprovalRuleView`, `describeBotApprovalRule` and `botAlwaysAllowLabel` (Task 1); `BotApprovals.decide(..., scope)` (Task 4); `ToolApprovalRuleBook.listBot/revokeBot/onBotChange` (Task 1).
- Produces:
  ```ts
  // main/handlers/bot-params.ts
  export function parseBotApprovalDecision(input: unknown): { waitId: string; decision: "allow" | "deny"; scope?: "always" };
  export function parseBotAllowedList(input: unknown): string | undefined;            // botId, or every Bot
  export function parseBotAllowedRemove(input: unknown): { botId: string; entryId: string };
  // main/handlers/bot-allowed.ts
  export function registerBotAllowedHandlers(deps: {
    handle(channel: string, handler: (event: unknown, input: unknown) => unknown): void;
    allowed: Pick<BotAllowedService, "list" | "remove">;   // Task 5
    onChange(listener: (botId: string) => void): () => void;  // rule book onBotChange, plus Bot access saves
    botExists(botId: string): Promise<boolean>;
    broadcast(channel: "bots:allowed:changed", payload: { botId: string }): void;
  }): void;   // "bots:allowed:list" → BotAllowedEntry[]; "bots:allowed:remove" → { removed: boolean }
  // renderer/lib/ipc.ts botsApi
  approve(waitId: string, decision: "allow" | "deny", scope?: "always"): Promise<{ decided: boolean }>;
  allowedList(botId?: string): Promise<BotAllowedEntry[]>;
  removeAllowed(botId: string, entryId: string): Promise<{ removed: boolean }>;
  onAllowedChanged(handler: (payload: { botId: string }) => void): () => void;
  // renderer/lib/bot-routes.ts
  export function botAllowedLocation(botId: string): { to: "/bots/$botId"; params: { botId: string }; search: { page: "allowed" } };
  // renderer/components/bots/bot-allowed-list.tsx
  export function BotAllowedList(props: { entries: BotAllowedEntry[]; onRemove(entry: BotAllowedEntry): void; removing?: string }): JSX.Element;
  ```
- Copy:
  - Card line: `You’ve allowed this ${count} times in the last 2 weeks.` Card button: `botAlwaysAllowLabel(name)`, a transparent button between Deny and Allow. Allow stays the accent button and keeps ⌘↩.
  - Toast after Always: `${name} won’t ask about this again.` with action `Manage`, which navigates to `botAllowedLocation(botId)`.
  - Row description: `Added ${date} · Used ${uses} time(s)` (`Not used yet` at 0); a folder row reads `Added ${date}`. Trailing `Remove`.
  - Page title and profile row: "Allowed without asking". The profile row's secondary line is the entry count, or `Nothing yet`.
  - Empty page: `${name} asks before changes in your apps and on websites. Choose ${botAlwaysAllowLabel(name)} on a card to stop a question you keep answering.`
  - Settings → Bots: a third `FieldSet`, "Allowed without asking", with one group per Bot that has entries (the Bot's name as the group label). With no entries anywhere: `No Bot does anything without asking yet.` Its `Always comes to you` rows stay unchanged.

- [ ] **Step 1: Write the failing main tests.**
  - `bot-params.test.ts`: `{waitId, decision:"allow", scope:"always"}` parses. `scope` with `deny`, `scope:"chat"` and an extra key throw `Invalid bot approval fields.` `parseBotAllowedRemove` rejects an `entryId` outside `[A-Za-z0-9_-]{1,80}`.
  - `bot-allowed.test.ts` (register-and-invoke with a `Map` of handlers and a real rule book on a memory store):
    - `list` with no Bot returns both Bots' entries, and with `"bot:a"` only its own;
    - `remove` returns `{removed: true}`, then `list` is empty;
    - an unknown Bot throws `This Bot no longer exists.`;
    - a `grantBot` broadcasts `bots:allowed:changed` with `{botId}`.
- [ ] **Step 2: Write the failing renderer tests.**
  - `bot-chat-pane.test.tsx`: `a repeated approval offers Always allow for Ada and answers with that scope`. Push a `bots:approval` prompt with `always: {key:"k", count: 3}`, and expect:
    - the text `You’ve allowed this 3 times in the last 2 weeks.`;
    - clicking `Always allow for Ada` invokes `bots:approve` with `{waitId, decision:"allow", scope:"always"}`;
    - a toast `Ada won’t ask about this again.`
    
    A prompt without `always` has no such button.
  - `bot-allowed-list.test.tsx`: two entries render their `describeBotApprovalRule` text and `Added 3 Nov 2026 · Used 12 times`. `Remove` on the second calls `onRemove` with it, and the button is disabled while `removing` names it.
  - `bot-profile.test.tsx`: the `Allowed without asking` row shows `2` and navigates to `/bots/bot%3Aa?page=allowed`. `bots-view.test.tsx`: that URL renders the page heading `Allowed without asking`, and its back button returns to Profile.
  - `bots-settings.test.tsx`: entries for Ada and Jo render under their names. Remove on Jo's entry invokes `bots:allowed:remove` with `{botId:"bot:jo", entryId}`. No entries shows `No Bot does anything without asking yet.`
- [ ] **Step 3: Run and see them fail.** `npx tsx --test main/handlers/bot-params.test.ts main/handlers/bot-allowed.test.ts renderer/main/bots/bot-chat-pane.test.tsx renderer/components/bots/bot-allowed-list.test.tsx renderer/main/bots/bot-profile.test.tsx renderer/main/bots-view.test.tsx renderer/components/settings/bots-settings.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `use-bot-allowed.ts` is a query on `queryKeys.botAllowed(botId)`, invalidated on `bots:allowed:changed` (all Bots when the key's id is `"all"`).
  - Before styling the card button and the list rows, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` (AGENTS.md). Rows reuse the profile's `FieldSet`/`Field` inset-row treatment, and Remove uses the shared small transparent button.
- [ ] **Step 5: Run the tests.** The same command, then `npm run test:bots`, `npm run test:bot-rules` and `npm run type-check`. Expected: PASS.
- [ ] **Step 6: Update the docs** listed above. Settings → Bots gains its third group. The help topic adds one sentence: after you approve the same thing three times, the card offers Always allow for that Bot, and you can remove it from the Bot's profile or Settings → Bots. Mark Plan D's row in `docs/plans/README.md`.
- [ ] **Step 7: Register and commit.** Add the two new test files to `test:bot-allowed` and the registry. Commit: "Show what each Bot may do without asking".

### Task 7: Remote: the list on phones (contract revision 54, provisional)

**Files:**
- Modify: `main/services/aiden-remote-protocol.ts`: revision constant after `:282`; capability block near `:509-605`; DTOs and parsers near `:1700`; fixture interface near `:2155`
- Create: `main/services/aiden-remote-bot-allowed.ts`, `main/services/aiden-remote-bot-allowed.test.ts`
- Modify: `main/services/aiden-remote-router.ts`: route table `:550`; dependency field near `:285`; the route block next to `botSpendingMatch` (`:3067`); capability offer next to `chat:jobs`
- Modify: `main/services/aiden-remote-state.ts:~264` (opt-in doc comment), `main/services/aiden-remote-service-main.ts` (wire `botAllowed`)
- Modify: `protocol/aiden-remote/v1/fixtures/contract.json` (`botAllowed`), `protocol/aiden-remote/v1/openapi.json` (two paths), `docs/aiden-remote-api-v1.md`
- Modify: `main/services/aiden-remote-bot-session.ts:1890-1925` (`scope: "always"`) and `wireApproval` (`alwaysCount`)
- Test: extend `main/services/aiden-remote-router.test.ts`, `main/services/aiden-remote-protocol.test.ts`, and `main/services/aiden-remote-bot-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const AIDEN_REMOTE_BOT_ALLOWED_CONTRACT_REVISION = 54 as const; // re-claim at merge; becomes AIDEN_REMOTE_CONTRACT_REVISION
  export const AIDEN_REMOTE_BOT_ALLOWED_CAPABILITIES = ["bot:allowed"] as const; // in OPT_IN, NEGOTIABLE and CAPABILITIES lists
  export interface AidenRemoteBotAllowedEntry { id: string; kind: "rule" | "folder"; what: string; addedAt: string; uses?: number; lastUsedAt?: string }
  // AidenRemoteBotApproval gains `alwaysCount?: number`, sent only to a device with bot:allowed and only when the card offers Always.
  export interface AidenRemoteBotAllowedList { botId: string; entries: AidenRemoteBotAllowedEntry[] }   // ≤ 50
  export function parseAidenRemoteBotAllowedList(value: unknown): AidenRemoteBotAllowedList;           // exact keys
  // aiden-remote-bot-allowed.ts
  export function createAidenRemoteBotAllowedService(deps: {
    allowed: Pick<BotAllowedService, "list" | "remove">;
    botExists(botId: string): Promise<boolean>;
  }): { list(botId: string): Promise<AidenRemoteBotAllowedList>; remove(botId: string, entryId: string): Promise<AidenRemoteBotAllowedList> };
  ```
- Routes:
  - `GET /bots/{botId}/allowed` needs `bot:read` plus `bot:allowed`.
  - `POST /bots/{botId}/allowed/{entryId}/remove` takes body `{}` and needs `bot:write`, `bot:read` and `bot:allowed`. It returns the list and is naturally idempotent (an entry already gone returns the list unchanged).
  - `what` is the entry's `what`, at most 200 characters.
  - `POST /approvals/{id}/respond` with `scope: "always"`: allowed only for a device with `bot:allowed`, on a Bot card whose prompt carries `always`. It calls `approvals.decide(waitId, "allow", "always")`. Any other case stays `invalid_request`.
  - An unknown Bot is `not_found`.
  - `bot:allowed` is offered only when the host wires `botAllowed`.

- [ ] **Step 1: Write the failing tests.**
  - `aiden-remote-bot-allowed.test.ts`:
    - `list` maps one connection and one site entry to `{id, kind, what, addedAt, uses}` with `what === "Google Calendar · Create event"` and `"Click on amazon.com"`, and `lastUsedAt` only when used;
    - a folder entry maps to `{id, kind: "folder", what, addedAt}` with no `uses`;
    - `remove` drops one and returns the rest;
    - a second `remove` of the same id returns the same list;
    - an unknown Bot throws `AidenRemoteServiceError` `not_found`.
  - `aiden-remote-router.test.ts`:
    - without `bot:allowed`, GET is refused with the capability error `requireDeviceCapabilities` gives;
    - with it, 200 and the list;
    - POST with `bot:read` only is refused, and a non-empty body is `invalid_request`;
    - `bot:allowed` appears in `serverCapabilities` only with the dependency wired.
  - `aiden-remote-protocol.test.ts`: the `botAllowed` fixture parses, and an extra key in an entry throws.
  - `aiden-remote-bot-session.test.ts`:
    - `a phone with bot:allowed can answer Always on an offered card`: `respondApproval(..., "allow", "always")` calls `decide` with the scope, and the wire approval carried `alwaysCount: 3`;
    - `Always is refused on a card that doesn't offer it`, and `for a device without bot:allowed`: both `invalid_request`, and that device's wire approval has no `alwaysCount`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/aiden-remote-bot-allowed.test.ts main/services/aiden-remote-router.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-bot-session.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Do the protocol constants, parsers and service. Add the router block modelled on `botSpendingMatch` with `requireNoQuery`, `requireEmptyJsonObject` and `requireDeviceCapabilities(device, ["bot:allowed"])`. Wire it in `aiden-remote-service-main.ts` with `toolApprovalRules` and the Bot store.
- [ ] **Step 4: Update the contract artifacts.**
  - `contract.json` gets `botAllowed`: a list with a folder entry, the list after a remove, the capability refusal, and an approval with `alwaysCount`.
  - `openapi.json` gets both paths.
  - `docs/aiden-remote-api-v1.md` gets a "Revision 54 (`bot:allowed`)" section.
- [ ] **Step 5: Run the tests.** `npm run test:aiden-remote`. Expected: PASS.
- [ ] **Step 6: Register and commit.** Add `aiden-remote-bot-allowed.test.ts` to `test:aiden-remote` and the registry. Commit: "Show a Bot's allow list on phones (Remote rev 54)".

### Task 8: iOS and Android

**Files:**
- iOS:
  - Modify `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift` (`.botAllowed` and `phoneNegotiable`, asked for alone; the revision constant), `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift` (`botAllowed(botId:)`, `removeBotAllowed(botId:entryId:)`, next to `botMemory` at `:2711`), `ios/AidenOnTheGo/Features/Bots/AidenBotProfileView.swift` (row, and a `navigationDestination` like Memory's at `:214`).
  - Create `ios/AidenOnTheGo/Models/AidenBotAllowed.swift`, `ios/AidenOnTheGo/Features/Bots/AidenBotAllowedView.swift`, `ios/AidenOnTheGoTests/AidenBotAllowedTests.swift`.
  - Modify `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift` (revision).
- Android:
  - Modify `android/app/src/main/java/sbtbiswas/AidenOnTheGo/protocol/AidenRemoteProtocol.kt` (`BOT_ALLOWED`, revision), `android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt` (next to `botMemory` at `:2094`), `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotProfileScreen.kt` (row and `onNavigateToAllowed`), `android/app/src/main/java/sbtbiswas/AidenOnTheGo/MainActivity.kt:~430` (`AidenScreen.BotAllowed(botId)`).
  - Create `android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenBotAllowed.kt`, `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotAllowedScreen.kt`, `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotAllowedTest.kt`.
- Docs: `ios/CHANGELOG.md` and `android/CHANGELOG.md` (new entries).

**Interfaces:**
- Consumes: the Task 7 wire shapes and the `botAllowed` fixture.
- Produces: on the Bot approval card, when `alwaysCount` is present, the line `You’ve allowed this N times in the last 2 weeks.` and a third button `Always allow for <Bot>` that responds with `scope: "always"`. And a profile row "Allowed without asking" (with the count) shown only when the Mac granted `bot:allowed`. It opens a list of `what` with "Added …" and "Used N times", and a Remove action. Remove is a swipe action on iOS and a trailing text button on Android; both ask for no confirmation, matching the desktop. A failed Remove keeps the row and shows the existing error banner.

- [ ] **Step 1: Write the failing tests.**
  - iOS `AidenBotAllowedTests`:
    - `testDecodesFixtureList` decodes `botAllowed.list` from `contract.json` like `AidenBackgroundJobsTests`;
    - `testRemoveReplacesListWithResponse` uses a stub client returning the post-remove fixture, and the model has one entry;
    - `testRowHiddenWithoutCapability`;
    - `testApprovalOffersAlwaysOnlyWithCount`: a fixture approval with `alwaysCount` shows the button and responds with `scope: "always"`; one without it shows Allow and Deny only.
  - Android `AidenBotAllowedTest`: the same four cases, mirroring `AidenBackgroundJobsTest`.
- [ ] **Step 2: Run and see them fail.**
  - iOS: `xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -only-testing:AidenOnTheGoTests/AidenBotAllowedTests -destination 'platform=iOS Simulator,name=iPhone 17'`, or the command in `ios/README.md`.
  - Android: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AidenBotAllowed*'`.
  - Expected: FAIL.
- [ ] **Step 3: Implement** the models, client calls, capability negotiation (asked for alone, like `chat:jobs`), screens and profile rows.
- [ ] **Step 4: Run the tests,** plus `AidenRemotePhase0Tests` and the Android protocol tests. Expected: PASS.
- [ ] **Step 5: Commit.** "Allowed without asking on iOS and Android"

---

## Self-review notes

- Spec coverage:
  - Counting in main per Bot and class: Tasks 2, 3 and 5.
  - 3 in 14 days with no recent denial: Task 2.
  - The Always allow choice: Tasks 4 and 6.
  - The tool result telling the Bot: Tasks 4 and 5.
  - `request_access` folders: Task 5, step 5.
  - The profile list and Settings → Bots: Task 6.
  - Reusing the remembered "always" scopes: Tasks 1 and 4.
  - Never skipping locked rules or rule-made asks: Task 3.
  - Phones: Tasks 7 and 8.
- Deliberately out of scope: CLI parity (no allow-list port); a Bot-shell class (the shell isn't approval-gated).
