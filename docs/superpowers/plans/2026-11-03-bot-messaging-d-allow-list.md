# Bot messaging D: the allow list and the repeat-approval nudge Implementation Plan

> **Execution:** Follow the numbered tasks and the review gates in [the master plan](../../plans/bot-messaging-plan.md#how-it-gets-built). The main session owns implementation and commits. Under the owner’s 2026-11-04 update, the main session implements directly and fresh read-only Opus 5.5 medium reviewers check the remaining gates, including the final program review. No additional execution skill is required. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- Limits: at most 50 remembered rule entries per Bot and 1,000 remembered rules in all. Existing selected folders are additional list rows and are paginated, never silently hidden by those rule limits. A ledger keeps at most 100 classes per Bot and 20 approval times per class. The Bot is hinted at most once per class every 7 days.
- Deep links:
  - The list is `/bots/<encodeURIComponent(botId)>?page=allowed`, a new `BotSubpage`. Settings is `/settings?section=bots`.
  - A Bot's reply can't carry an in-app link: assistant markdown opens `https:` only (`markdown.tsx` `RestrictedLink`). So the link lives on Aiden's own UI: a toast after Always allow, and the profile row. The Bot's hint names the place in words.
- Phones show the list, can Remove from it, and get the Always choice (owner pick 10). The shared `POST /approvals/{id}/respond` route already takes `scope`; `aiden-remote-bot-session.ts:1906` accepts `"always"` only for a device with `bot:allowed` on a card that offers it.
- Remote: claim the next contract revision after `main`'s at merge, provisionally 57 after this stack's A54/B55/C56. Recheck `main` and the complete stack before merge. Update these together: iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md`, and the revision assertion in `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift`.
- Use an opt-in capability (`bot:allowed`), not a feature token. Phones already hear the most feature tokens shipped clients accept (see revision 49's note).
- New tests go in a new `"test:bot-allowed"` script, with `"pretest:bot-allowed": "npm run build:lease-flock"`. Append it to the `test:serial` chain, and if `main` changed the chain, resolve by union. Register every new test file in `scripts/ci-test-registry.json` too. Extended existing test files stay in their scripts.
- Modules under `main/services/` don't import `electron`, except `*-main.ts` wiring. The CLI bundles `bot-tool-assembly.ts`, `bot-extension.ts` and `bot-approvals.ts`. The CLI passes no allow-list port, so it never offers or matches. Run `npm run test:cli`.
- No new analytics events. No onboarding change: the nudge appears in context and isn't a first-run choice.
- UI follows `GUI.md`, `docs/design-guide.md` and `docs/settings-design-system.md`: grouped `FieldSet` cards, inset rows, trailing controls, the shared button shapes, no decorative borders, visible `focus-visible` rings. Copy stays minimal.
- Pre-1.0: no migration. The document stays `version: 1`, and `botRules` is optional.
- This plan depends on Plan B (`request_access`) only in Task 5, step 5. Plan B lands first in the stack (A → B → C → D), so the hook goes into B's real settle point, `answerBotAccessRequest` in `main/services/bot-runtime/bot-access-requests-main.ts`, and B's tool result in `bot-access-request-tool.ts`.

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
- Produces, in `main/services/tool-approval-rules.ts`: `ToolApprovalRulesDocument.botRules?: BotApprovalRuleView[]` and `botGrantOperations` publication/revocation receipts, plus these `ToolApprovalRuleBook` methods:
  ```ts
  matchBot(botId: string, target: BotApprovalRuleTarget): Promise<BotApprovalRuleView | undefined>;
    grantBot(botId: string, target: BotApprovalRuleTarget, label: string, operationId: string): Promise<
      { status: "published"; rule: BotApprovalRuleView } | { status: "revoked" }
    >; // replay-safe per immutable publication operation, not only target
  listBot(botId?: string): Promise<BotApprovalRuleView[]>;   // newest first; every Bot when omitted
  recordBotUse(botId: string, ruleId: string): Promise<void>;
  revokeBot(botId: string, ruleId: string): Promise<boolean>;
  forgetBot(botId: string): Promise<number>;
  onBotChange(listener: (botId: string) => void): () => void;
  botConsentRevision(botId: string, target: BotApprovalRuleTarget): Promise<string>; // main-only target-relevant receipt digest, independent of usage
  ```
  `list()`, `revoke()`, `revokeAll()` and `onChange()` keep their meaning: workspace rules only. `grantBot` enforces both the 50-per-Bot and 1,000-profile limits inside one `store.update`, including concurrent grants. Persist an immutable operation-id receipt atomically with publication. A duplicate operation returns its recorded publication, or `revoked`, without granting again. `revokeBot` atomically removes the entry and tombstones every publication operation that referenced it. A replay of an old operation cannot recreate authority even if the target currently has no entry. A later fresh person decision with a new operation id may intentionally grant it again. Retain publication/revocation receipts while their originating tasks can replay, independently of visible entries. The service also rejects grants for deleted/unknown Bots.

- Publication receipts are main-owned records `{ operationId, botId, targetKey, ruleId, status: "published" | "revoked", publishedAt, revokedAt? }` stored with the rule document. Preserve them through normalization and atomic revoke, and never expose them as another visible list entry.

- [x] **Step 1: Write the failing tests** in `tool-approval-rules.test.ts`. Use the file's in-memory store, a fixed `now`, and `CAL = {kind:"connection", serverId:"gcal", tool:"create_event"}`:
  - `a Bot entry covers only its own Bot and exact target`: after `grantBot("bot:a", CAL, "Google Calendar · Create event", "decision-1")`:
    - `matchBot("bot:a", CAL)?.label === "Google Calendar · Create event"`;
    - `matchBot("bot:b", CAL) === undefined`;
    - `matchBot("bot:a", {...CAL, tool: "delete_event"}) === undefined`.
  - `granting the same target twice keeps one entry and its first createdAt`; two distinct valid person-operation ids receive separate receipts for that same publication.
  - Publish with operation d1, crash before acknowledgement, Remove, then replay d1: it returns `revoked`, creates no entry and releases no waiting card. A fresh decision d2 can intentionally grant again. Reopening the store preserves both receipts and tombstones.
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
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/tool-approval-rules.test.ts`. Expected: FAIL (`grantBot is not a function`).
- [x] **Step 3: Implement.**
  - Reuse `validWorkspaceId`'s checks for `botId`, `serverId` and `tool` (at most 256 characters, no control characters).
  - A stored `host` must already be canonical: lowercase, no leading `www.`, `[a-z0-9.-]`, at most 253 characters. A hand edit can't widen it, the same rule `normalizeRule` uses for patterns.
  - Labels are trimmed and kept to 200 characters.
  - `grantBot` throws `Aiden keeps at most 50 things a Bot can do without asking. Remove some on its profile.`
  - Writes go through the existing `store.update`. `notifyBot(botId)` mirrors `notify()`.
- [x] **Step 4: Run the tests.** `npx tsx --test main/services/tool-approval-rules.test.ts renderer/components/settings/tool-approval-settings.test.tsx`. Expected: PASS.
- [x] **Step 5: Commit.** "Remember Bot approvals in the tool approval store"

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
    /** Persists decision receipt, tally and hint entitlement in one transaction. Replays return the stored result. */
    record(botId: string, key: BotApprovalTallyKey, decision: {
      id: string; authorizationFingerprint: string; source: "person" | "expiry" | "allow_list";
      answer: BotApprovalAnswer; offered: boolean; decidedAt?: number;
    }): Promise<{ counted: boolean; hintCount?: number }>;
    /** First terminal publication result sticks; grants nothing and never resets later history on replay. */
    completePublication(botId: string, decisionId: string, authorizationFingerprint: string, status: "published" | "revoked"): Promise<void>;
    decision(botId: string, id: string, authorizationFingerprint: string): Promise<BotApprovalDecision | undefined>;
    /** Approvals in the window when ≥ threshold and none denied in it; else undefined. */
    nudge(botId: string, key: BotApprovalTallyKey): Promise<{ count: number } | undefined>;
    // Hint ownership is assigned inside record(), at most once per class per cooldown.
    forget(botId: string, key: BotApprovalTallyKey): Promise<void>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotApprovalTallies(options: { profileDir(): string; now?(): number }): BotApprovalTallies;
  ```
  The file is `<profile>/bots/<dir>/approval-tallies.json`: `{version:1, classes:[{key, allowed:number[], allowedDecisionIds:string[], deniedAt?, hintedAt?}], decisions:[...]}`. Each decision receipt contains the host-owned wait/decision id, immutable answer, provenance, target key, timestamp and recorded hint result. Atomically record receipt + tally + hint ownership under one per-Bot serial. A duplicate id with different target/answer is an error; exact replay returns the saved result and does not recount.

Historical host-journal recovery supplies the original `decidedAt`; exact replay without a time uses the saved receipt, and a supplied conflicting time is refused. Always publication completion is a separate durable, idempotent transition. It clears only preceding history and its own completed Always event, preserving other equal-time events, all later decisions and the original weekly hint entitlement. A revoked completion grants nothing and clears nothing. Publication recovery must never call a blanket `forget()` after a later denial.

Aligned private `allowedDecisionIds` prove exact cache membership; missing or inconsistent identities preserve evidence and fence bookkeeping rather than guessing from timestamps.

Class history keeps 20 times per class and 100 classes, pruning timestamps outside the window. Decision receipts are separate from these display/count limits and remain while their durable tasks can replay. Collect them only after proven task settlement, never because a class was evicted or an Always grant cleared the tally. Unreadable receipt bookkeeping fails closed for remembered-approval settlement and preserves the file; it must not reset replay protection. Only `source: "person"` changes approval/denial counts or hint cooldowns. Expiry, withdrawal and release under an allow-list entry are not human choices; withdrawal has no decision at all.

- [x] **Step 1: Write the failing tests** in `bot-approval-tallies.test.ts`. Use a temp profile dir and a settable clock; `DAY = 86_400_000`. Every human-answer fixture uses a unique host-owned decision id and source `person`:
  - `offers on the third approval in 14 days`: two `record(…,"allowed")` give `nudge === undefined`; a third gives `{count: 3}`.
  - `approvals older than 14 days don't count`: three at day 0, and at day 14 plus 1 ms `nudge === undefined`.
  - `a denial withholds the offer for 14 days` (Review Focus 2):
    - five approvals on days 0–2 and a denial on day 3 give `undefined` on day 4;
    - approvals on days 15, 16 and 17 give `{count: 3}` on day 17.5 (the denial is now more than 14 days old).
  - `the hint is assigned once a week`: eligible distinct person decisions at day 0, day 6 and day 7 plus 1 ms get a stored hint result only on days 0 and 7. Replay of any decision returns its original result without moving the cooldown.
  - `classes are independent`: a folder `"/Users/p/Taxes"` key and `CAL` count separately. `forget(CAL)` resets only `CAL`.
  - `counts survive a reopen and stay bounded`: 30 approvals in a day give `count === 20` from a fresh instance on the same dir.
  - `forgetBot removes the file`: the Bot directory has no `approval-tallies.json` afterwards.
  - Crash after the receipt/tally commit but before the task memo: reopen and settle the same decision repeatedly; the count remains one and the original hint result is returned.
  - Expiry denial and automatic sibling allowance never change human counts, denials or hint timestamps. Corruption never makes replayable decisions count again. Clearing a class leaves its replay receipts intact.
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-approval-tallies.test.ts`. Expected: FAIL, module not found.
- [x] **Step 3: Implement `createBotApprovalTallies`.** Per-Bot serial writes. Keys are `botApprovalRuleKey`, or `JSON.stringify(["folder", path])` for folders.
- [x] **Step 4: Run the tests.** Same command. Expected: PASS.
- [x] **Step 5: Register and commit.** Add the file to `test:bot-allowed` and to the CI registry lane that holds `main/services/bot-rules/*.test.ts`. Commit: "Count a Bot's approvals per class".

### Task 3: Which class a call is, and the policy check

**Files:**
- Create: `main/services/bot-runtime/bot-allow-target.ts`, `main/services/bot-runtime/bot-allow-target.test.ts`
- Modify: `main/services/bot-runtime/bot-extension.ts:120-135` (`BotApprovalRequirement.remember`)
- Modify: `main/services/bot-runtime/bot-tool-assembly.ts:113-122` (ports), `:276-293` (the no-rule branch); update the header comment's "Routines go ahead" paragraph with one line on entries
- Test: `main/services/bot-runtime/bot-tool-assembly.test.ts` (extend)
- Modify: `main/services/bot-runtime/test-support/assembly-fixtures.ts` (optional allow-list port and real harness fixtures only)

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
    /** Target-specific durable consent generation, unchanged by usage or unrelated targets. */
    consentRevision(botId: string, target: BotApprovalRuleTarget): Promise<string>;
    match(botId: string, target: BotApprovalRuleTarget): Promise<{ id: string } | undefined>;
    offer(botId: string, target: BotApprovalRuleTarget): Promise<{ count: number } | undefined>;
    used(botId: string, ruleId: string): Promise<void>;
  }
  // BotToolAssemblyPorts.allowList?: BotAllowListPort
  ```
The runtime also exposes a main-only, read-only `approvalRequirements(botId, toolName, call)` probe for Task 4. It returns an eligible baseline target, a requirements fingerprint, the current consent revision, their combined authorization fingerprint, and an optional matched rule ID. The requirements fingerprint binds the durable execution identity, canonical operation/arguments, full effective authority and complete effective rules, host input ownership/ingress and explicit browser binding. It excludes usage, tally counts, presentation text and callback identity. Snapshot caller inputs before awaits. Read consent revision around the match lookup and reject an unstable result, then finish fresh authority/rule checks. Missing or unreadable consent identity disables remembered authorization and offers for that call. This probe never reserves C coverage, records entry usage or invokes `onAllow`. Ordinary `checkPolicy` still evaluates C exactly once before D. Every eligible pending card will retain private requirements/target metadata in Task 4, even when no Always offer is present; none is copied into public prompts.

- Integrate with C's single decision sequence rather than adding an earlier return:
  1. Check fresh authority, ingress, deadlines and classification; load rules fail closed. Locked rules, hand-offs and refusals return first.
  2. Apply the existing eligible routine go-ahead behavior.
  3. Evaluate C's plan coverage exactly once, with its durable execution identity and every matching Ask first rule. A match returns `preapproved` and reserves only plan counters.
  4. Only when no rule matched, baseline approval exists, no preceding path covered the call, and the tool is not Computer Use, derive `botApprovalTargetOf` and consult the allow list.
  5. A match preserves baseline `onAllow`, then records entry usage after that binding check succeeds. No match attaches `remember` and any offer to the ordinary card. An error asks normally, without an offer if necessary.
  6. A rule-made ask never reaches the allow list; uncovered unattended asks retain the existing block. With no allow-list/rules port, the CLI keeps its existing behavior.

The precedence is authority/ingress, rules, existing routine go-ahead, plan coverage, allow list, then ordinary card/block. When a plan cap runs out, an otherwise eligible persistent entry may handle the call; there is no plan reservation for that call and only the entry usage increases. A rule-made ask still requires a card if the plan does not cover all matching rules. Do not call C's side-effecting coverage function through both `asBaseline` and `ask`.

- [x] **Step 1: Write the failing target tests** in `bot-allow-target.test.ts`:
  - `a mutating connection call is its server and tool`: `{surface:"mcp", serverId:"gcal", remoteName:"create_event", annotations:{title:"Create event"}, …}` gives `target {kind:"connection", serverId:"gcal", tool:"create_event"}` and `title "Create event"`. Without a title, `title === "create_event"`.
  - `hosts ignore case and a leading www.` (Review Focus 5): browser_click on `https://WWW.Amazon.com/cart` and on `https://amazon.com/` give the same `botApprovalRuleKey`, with `host "amazon.com"` and `action "click"`. `browser_type` gives `"type"`.
  - `no class`: `computer_use`, `computer`, `mcp` with `serverId: ""`, and a browser URL of `file:///x` or `about:blank` all give `undefined`.
- [x] **Step 2: Write the failing policy tests** in `bot-tool-assembly.test.ts`. Use a fake `allowList` that records calls and build on the existing helpers: `ruledTurn`, `rulesWith`, `PLACE_ORDER`, and the connection fixture from `a mutating connection tool asks for approval…` (line ~413). For browser cases, add `"browser"` to the test authority's other grants the way `BOT_COMPUTER_TOOL_NAME` adds `"computer"`.
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
  - `a plan and entry match the same call`: only the plan reservation increases and the list is not queried. At the plan cap, a no-rule call can use the entry; a rule-made ask cannot. Test concurrent calls at the cap with the real plan store.
  - `a routine run that goes ahead neither matches nor offers`: `routinesGoAhead: () => true` on `routine:daily:fire-1`. Expect `match` and `offer` not called.
- [x] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-allow-target.test.ts main/services/bot-runtime/bot-tool-assembly.test.ts`. Expected: FAIL.
- [x] **Step 4: Implement** `botApprovalTargetOf` and the `checkPolicy` branch above. Hosts come from `new URL(url).hostname`.
- [x] **Step 5: Run the tests.** The same files, then `npm run test:bot-runtime` and `npm run test:bot-rules`. Expected: PASS.
- [x] **Step 6: Register and commit.** Add `bot-allow-target.test.ts` to `test:bot-allowed` and the registry. Commit: "Let a Bot's allow list skip a plain approval, never a rule".

### Task 4: The card's Always allow and the Bot's hint

**Files:**
- Modify: `main/services/bot-runtime/bot-approvals.ts` (offer, scope, answer)
- Create: `main/services/bot-runtime/bot-approvals.test.ts`
- Modify: `main/services/bot-runtime/bot-extension.ts:200-209` (`BotApprovalRequest`), the `BotExtensionDeps` block (~`:259`), `:619-655` (`beforeTool` approval branch), the `ToolTask` hook (~`:538`) for `afterTool`
- Modify: `packages/cli/src/bot-durable.ts:150` only if the type change requires it (no behavior)
- Test: `main/services/bot-runtime/bot-extension.test.ts` (extend)
- Modify as required for the structured decision migration: `main/services/bot-runtime/test-support/fixtures.ts`, `test-support/assembly-fixtures.ts`, `test-support/extension-scenario.ts`, `main/services/bot-runtime/bot-session-main.ts` (approval request/provenance adapter only), `main/services/bot-messages/courier.ts` and its provenance tests, plus existing attention fixtures.
- Task 4 may extend assembly's private fingerprint/revalidation evidence for all ordinary and rule-made approval attempts. The eligible baseline-only requirements probe remains read-only; do not reserve C coverage while rechecking a saved decision or sibling release.


**Interfaces:**
- Consumes: `remember` from Task 3, and `botApprovalRuleKey` from Task 1.
- Produces:
  ```ts
  // bot-extension.ts
  export type BotApprovalAnswer = "allow" | "allow_always" | "deny";
  export interface BotApprovalDecision {
    id: string; // host-owned authorization-attempt waitId, never a provider call id
    authorizationFingerprint: string; // exact operation + current approval requirements
    answer: BotApprovalAnswer;
    source: "person" | "expiry" | "allow_list";
  }
  // BotApprovalRequest gains: always?: { key: string; count: number }
  // BotExtensionDeps.requestApproval(request): Promise<BotApprovalDecision>
  // BotExtensionDeps gains:
  settleApproval?(input: {
    botId: string;
    remember: NonNullable<BotApprovalRequirement["remember"]>;
    decision: BotApprovalDecision;
  }, context?: { validatePublication?(): Promise<void> }): Promise<{ hint?: string; publication?: BotAllowListRelease }>;

  // bot-approvals.ts
  // BotApprovalPrompt gains: always?: { key: string; count: number }
  // BotApprovals.request(request): Promise<BotApprovalDecision>
  // BotApprovals.decide(waitId: string, decision: "allow" | "deny", scope?: "always", source?: "person" | "expiry" | "allow_list"): boolean
  ```
- Behavior:
  - Tests below refer to the decision's `answer` field when they say "resolves allow/deny/allow_always"; assert source and stable id as well.
  - Compute a canonical authorization fingerprint from host execution identity, normalized tool/arguments/target, current baseline/binding requirements, current matching Ask first rule fingerprints and the applicable grant/revocation generation. The durable tool identity and authorization-attempt identity are distinct. The extension retains/memoizes a wait id per current attempt and fingerprint; retransmissions/replay of the SAME requirements reuse it, while changed requirements create a fresh wait id/card and withdraw any old attempt. Never reuse an old allowance for a newly added/edited rule.
  - `request` first checks a durable settled decision for this attempt id AND authorization fingerprint. Replay returns that exact answer/provenance without reopening a card only while the fingerprint still matches, while current authority, rules, deadlines and page binding are still rechecked before an effect. Otherwise pass `scopes: ["once", "always"]` to the coordinator only when `request.always` is set. Read its offered scope on allow and return `{id: waitId, authorizationFingerprint, answer, source}`. Wire the optional persisted-decision lookup through an injected port to `BotApprovalTallies.decision`; with no port the CLI keeps ordinary once-only approvals. The coordinator still drops an unoffered scope. Provenance is supplied internally, never by renderer or Remote request bodies.
  - `beforeTool` sets `always: {key: botApprovalRuleKey(remember.target), count: remember.offer.count}` when there is an offer.
  - `deny` blocks as today. `allow` and `allow_always` both run `onAllow`.
  - Before publication-capable Always settlement, compare fresh exact evidence for the captured attempt. Supply a separate main-only revocable validatePublication guard. Task5 must await it inside the atomic first-publication path after exact operation replay lookup and before mutation, alongside the captured consent-generation compare. Replays of committed publications acknowledge history without calling the stale guard. Never serialize or retain the callback; settlement revokes it. Historical Once/deny receipts remain the actual person event even when later requirements changed.
  - After any answer with `remember`, key the settlement cache by BOTH `decision.id` and `decision.authorizationFingerprint`, for example `aiden.approval.settled:<id>:<fingerprint>`. A cache record also contains those identities and is accepted only for the current attempt. An old task-level cache for a different attempt cannot suppress settlement. When this attempt's cache is absent, call idempotent `settleApproval` with its durable decision and cache that exact recorded result. The store commits decision id + provenance + tally/hint effects atomically; the task memo is only a replay cache, not the exactly-once guarantee. A crash between store and memo reuses the saved result. Fresh current-policy/page checks precede execution even when the human answer was already settled.
  - `afterTool` appends `{type:"text", text: "\n\n" + hint}` to `result.output` only from the executed attempt's matched decision-id/fingerprint cache, when the result is not `isError` and output is an array. Never reuse a previous attempt's hint; retain the executed attempt identity in host-owned execution context.

- [x] **Step 1: Write the failing bridge tests** in `bot-approvals.test.ts`. Use `createBotApprovals({publish})` and capture prompts:
  - `Always is honored only when the card offered it`:
    - with `always: {key:"k", count:3}`, `decide(waitId, "allow", "always")` resolves `"allow_always"`, and the published prompt has `always.count === 3`;
    - without `always`, the same decide resolves `"allow"`.
  - `a deny with a scope is still a deny`.
  - `pending lists the offer` until the answer, then nothing.
- [x] **Step 2: Write the failing extension tests** in `bot-extension.test.ts`. Use the existing scenario helpers, and a `checkPolicy` returning an approval with `remember: {target: CAL_TARGET, title: "Create event", offer: {count: 3}}`:
  - `an offered card asks with always and settles allow_always without a hint`: the recorded request has `always.count === 3`. `settleApproval` is called once with `answer "allow_always"`, the tool runs, and the result text has no `Aiden note`.
  - `Allow once on an offered card appends the hint to the tool's result`: `settleApproval` returns `{hint: "Aiden note: test"}`. The committed tool result ends with `Aiden note: test`. A tool that returns `isError` gets no hint.
  - `Deny settles a denial and blocks`: one settle with `"deny"`, and the result is "The person declined this action.".
  - `an approval without remember never settles`.
  - `a crash between settlement and memo preserves one decision`: inject the interruption, reopen the actual tally store and resume; no duplicate count, hint entitlement or remembered entry.
  - Allow a baseline call, crash before execution, add an Ask first rule, then Resume: the new fingerprint gets a new card/decision identity, and the saved baseline answer cannot satisfy it. Repeat after editing a custom rule and after a relevant revocation-generation change.
  - Allow once, persist its settlement cache, crash before execution, change binding requirements while keeping an eligible baseline approval, Resume and choose Always. The new id/fingerprint must settle and publish once despite the old cache; retransmissions do not recount and `afterTool` never emits the old attempt's hint.
  - `a re-run hook settles once`: run `beforeTool` twice for the same call through the scenario's resume path, like the existing share_image resume test, answering allow both times. Expect `settleApproval` called once.
- [x] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-approvals.test.ts main/services/bot-runtime/bot-extension.test.ts`. Expected: FAIL.
- [x] **Step 4: Implement** the bridge and the extension changes above. Read `decision.answer` explicitly. The deny check becomes `decision.answer === "deny"`; callers and CLI adapters adopt the wrapper while preserving ordinary allowance behavior.
- [x] **Step 5: Run the tests.** The same files, then `npm run test:bot-runtime` and `npm run test:cli`. Expected: PASS.
- [x] **Step 6: Register and commit.** Add `bot-approvals.test.ts` to `test:bot-allowed` and the registry. Commit: "Offer Always allow on a repeated Bot approval".

### Task 5: The allow-list service, wiring, folders and delete

**Files:**
- Create: `main/services/bot-runtime/bot-allow-list.ts`, `main/services/bot-runtime/bot-allow-list.test.ts`
- Modify: `main/services/bot-runtime/bot-session-main.ts:239-245` (assembly `allowList` port), `:414` (`settleApproval`), `:802-826` (`deleteEffects`)
- Modify: `main/services/bot-runtime/bot-access-requests-main.ts` (`answerBotAccessRequest`, Plan B Task 5) and `main/services/bot-runtime/bot-access-request-tool.ts` (its tool result, Plan B Task 7) for the folder nudge
- Modify: `main/services/bot-folder-grant-journal.ts`, `main/services/bot-application-service.ts` and existing application tests (optional original tally context, historical receipts, selected folder rows/removal).
- Modify: `main/services/tool-approval-rules.ts` and existing tests, `bot-runtime/bot-approval-tallies.ts` and existing tests (atomic first-publication proof and immutable pending-publication recovery context).
- Modify: `main/services/tool-approval-rules-main.ts`, `main/services/bot-application-service-main.ts` (active-Bot/deletion check and bounded historical reconciliation after journal recovery).
- Modify: B private authorizer/bridge/candidate source and existing tests, plus shared access-card type/parser tests for the safe folder approvalCount. Remote55 wire shape stays unchanged; Task7/8 controls any new phone count projection.
- Modify: `.memory/bot-rules.md` (Enforcement: the "never pass `scopes`" line becomes "pass scopes only for an Always allow offer; rule-made asks never get one"; a new "Allow list" section), `.memory/bot-durable-runtime.md` (Approvals line), `docs/bot-rules.md` (new "Allowed without asking" section after "Routines that go ahead")

**Interfaces:**
- Consumes: `ToolApprovalRuleBook` Bot methods (Task 1), `BotApprovalTallies` (Task 2), `BotAllowListPort` (Task 3), `settleApproval`'s input (Task 4), and `BotApprovals.pending/decide` (Task 4).
- Produces:
  ```ts
  export interface BotAllowList extends BotAllowListPort {
    settle(input: BotApprovalSettlementInput, context?: BotApprovalSettlementContext): Promise<BotApprovalSettlement>;
    /** Rules plus the Bot's Custom `approved_location` selections, newest first; every Bot when omitted. */
    list(botId?: string): Promise<BotAllowedEntry[]>;
    /** A rule: `revokeBot`. A folder: `BotApplicationService.revokeBotFolder`. */
    remove(botId: string, entryId: string): Promise<boolean>;
    folderOffer(botId: string, path: string): Promise<{ count: number } | undefined>;
    settleFolder(input: { botId: string; path: string; decisionId: string; authorizationFingerprint: string; source: "person"; answer: "once" | "always" | "not_now"; offered: boolean }): Promise<{ hint?: string }>;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotAllowList(deps: {
    rules: Pick<ToolApprovalRuleBook, "matchBot" | "grantBot" | "listBot" | "recordBotUse" | "revokeBot" | "forgetBot" | "botConsentRevision" | "botGrantOperation" | "onBotChange">;
    folderEntries(botId?: string): Promise<BotAllowedEntry[]>; // main wiring reads selected approved locations
    revokeFolder(botId: string, sourceId: string): Promise<boolean>; // main wiring calls revokeBotFolder
    tallies: BotApprovalTallies;
    approvals: Pick<BotApprovals, "pending" | "releaseFromAllowList">;
    botName(botId: string): Promise<string | undefined>;
    connectionName(serverId: string): Promise<string | undefined>;
    log?(message: string, error: unknown): void;
  }): BotAllowList;
  export function botApprovalNudgeHint(input: { label: string; count: number; choice: string; place?: string }): string;
  ```
Atomic connection/site publication takes the captured consent generation plus a live pure validation callback inside the existing rule-book transaction. Exact prior-operation replay is handled first and grants nothing after Remove; it does not invoke a stale live guard. First publication compares the generation from that same draft, validates current full requirements/owner/deadline, then mutates. The transient callback is never persisted. Tally publicationContext stores only the original consentRevision, canonical label and title beside the exact person decision. The exact publication and pendingPublications queries return that immutable context. Startup reconciliation completes only known committed/revoked rule-book receipts; a missing operation remains pending and cannot create authority without a live resumed call.

B's optional journal approvalTally stores version1, the original authorization fingerprint, offered flag and original decidedAt before the first pending write. The decoder rejects malformed context and input replacement before writing. botFolderApprovalReceipts returns only committed desktop operations with D context, excluding deleted and deleting Bots. Legacy B receipts remain acknowledgeable without inventing a D event. Reconciliation never calls grantBotFolder, installs a run alias or changes selected folders. An incoming Once/Not now after earlier Always publication records the earlier Always, not a new choice. Publication completion is idempotent and preserves later history; it never calls a blanket forget after recovery.

- Exact hint copy:

  `Aiden note: the person has approved “${label}” ${count} times in the last 14 days. Once, in one short sentence of your own, tell them they can stop being asked: “${choice}” on the next card${place ? `, or ${place}` : ""}. Don't bring it up again.`

  - Connections and sites: `choice = botAlwaysAllowLabel(name)` and `place = "Allowed without asking on your profile"`.
  - Folders: `choice = "Always for this folder"` and no `place`.
  - `count` is the offer's count plus this approval.
- Settle rules:
  - First record the immutable attempt decision, authorization fingerprint and tally/hint result atomically. Only a person's `deny` records a denial, and only a person's `allow`/`allow_always` records an approval. Non-person sources neither count nor hint. Replays return the saved settlement result.
  - `allow` returns the hint only when the stored settlement assigned one. `allow_always` records an idempotent pending grant obligation alongside its decision; grant publication can then be retried by stable target key without recounting.
  - `allow_always`:
    1. Calls `grantBot` with `operationId = decision.id` and the label: `${connectionName ?? "Connected app"} · ${title}`, or `describeBotApprovalRule` for a site.
    2. Only a published, still-current grant clears the tally. A `revoked` operation receipt ends the old obligation without restoring authority or releasing cards.
    3. Recheck fresh policy/rules and release every other matching pending prompt with decision source `allow_list`. Associate the release with the real remembered target even when that older card did not yet offer Always. Never release a rule-made ask or a stale/changed-page approval. These releases do not count as human approvals.
    4. Returns no hint.
  - A `grantBot` failure is logged and the current call keeps its one-time human allowance. The saved grant obligation/result records that persistence failed, so replay cannot manufacture another human approval. Do not clear the tally or release sibling cards unless the remembered grant actually published.
  - `offer` returns `undefined` when the Bot already has 50 remembered rules or the profile has 1,000. `grantBot` enforces both limits atomically under its store update; folder rows do not consume this rule limit.

- [x] **Step 1: Write the failing tests** in `bot-allow-list.test.ts`. Use a real `ToolApprovalRuleBook` on an in-memory store, real tallies on a temp dir, and a fake `approvals`:
  - `Always allow adds an entry named after the app and clears the count`: `connectionName("gcal") → "Google Calendar"`, three `allow` settles, then `allow_always`. Expect:
    - `listBot("bot")[0].label === "Google Calendar · Create event"`;
    - `match` returns its id;
    - `offer` is `undefined` afterwards.
  - `Always allow also lets the other waiting card for the same class through` (Review Focus 3): pending prompts `w1` (key `K`), `w2` (key `K`) and `w3` (another key). Settling `w1`'s call with `allow_always` decides `w2` with `"allow"`, and leaves `w1` (already answered) and `w3` alone.
  - `Allow once on an offered card hints once a week`:
    - the first settle returns a hint containing `“Google Calendar · Create event”`, `4 times`, `“Always allow for Jester”` and `Allowed without asking on your profile`;
    - a second settle the next day returns no hint.
  - `no offer without three approvals, none at 50 Bot rules or 1,000 profile rules`; simultaneous final-slot grants admit only one.
  - `used counts a use`: after `used("bot", id)`, `listBot("bot")[0].uses === 1`.
  - Expiry denials and sibling releases preserve provenance through `BotApprovals` and the extension and do not affect person-decision tallies.
  - Allow once, quit, Resume and answer Not now: B's new attempt records a distinct denial. Repeating Allow once on the new card records a new approval. Reposting either native answer with its same attempt id counts once.
  - `folders nudge the fourth request for the same folder`:
    - three `settleFolder({answer:"once"})` make `folderOffer("bot", "/Users/p/Taxes")` give `{count: 3}`;
    - the next once-settle with `offered: true` hints `“Always for this folder”` without `Allowed without asking`;
    - `answer: "always"` forgets the count;
    - `"not_now"` records a denial.
  - `forgetBot removes the Bot's entries and its tally file`.
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-allow-list.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement `createBotAllowList`.**
- [x] **Step 4: Wire it in `bot-session-main.ts`:**
  - `const botApprovalTallies = createBotApprovalTallies({ profileDir: () => app.getPath("userData") })`, the same root `bot-delivery/funnel-main.ts` uses;
  - `const botAllowList = createBotAllowList({ rules: toolApprovalRules, tallies: botApprovalTallies, approvals: botApprovals, botName, connectionName: async (id) => (await configStore.listMcpServers()).find((s) => s.id === id)?.name, log: (m, e) => logger.warn("bots", m, e) })`;
  - pass `allowList: botAllowList` to `createBotToolAssembly`;
  - pass `settleApproval: (input) => botAllowList.settle(input)` and `requestApproval: (request) => botApprovals.request(request)` (the type changes, the call doesn't);
  - add `(botId) => botAllowList.forgetBot(botId)` to `deleteEffects` before `eraseBotData`.
- [x] **Step 4b: Add `revokeBotFolder` and folder entries (owner pick 12).** In `main/services/bot-application-service.ts`, next to Plan B's `grantBotFolder`, add `revokeBotFolder(input: { audienceId: string; botId: string; sourceId: string }): Promise<boolean>`. It saves through `updateBotAccess` with `nextBotFileScopeIds(policy.custom.fileScopeIds, snapshot.catalog.fileScopes, option.id, false)` and the same `refuseDriftedGrants` message; a Full-access Bot or an unselected folder returns `false`. It leaves the approved root in place. Tests:
  - `list includes the folders in a Custom Bot's access`: a Custom Bot with one rule and one `approved_location` gives one `kind: "rule"` and one `kind: "folder"` row whose `what` is `Folder · ~/Documents/Taxes`. A Full-access Bot gives no folder rows.
  - `removing a folder entry takes it out of the Bot's access`: `remove(bot, "folder_root_a")` returns true, the saved `custom.fileScopeIds` no longer holds that option, `bot_home` stays, and the next `list` has no folder row.
  - `removing a folder another Bot uses leaves that Bot's access alone`.
- [x] **Step 5: Hook `request_access` (Plan B).** Make these three changes at B's card settle point and its tool result:
  - before raising a folder card, call `folderOffer(botId, path)`, and when it returns a count show the line `You’ve allowed this folder ${count} times in the last 2 weeks.` (B's card already has Always for this folder);
  - after a successfully validated person answer, call `settleFolder` with this authorization attempt's wait id as `decisionId` and source `person`; B's logical request id is not a decision id. Quit/Resume reapproval creates a new attempt, whereas transport retries keep the current attempt and native idempotency key; stale/aborted answers do not count. Replays are deduplicated by the same durable receipt mechanism;
  - append the returned hint to the tool result.

  Whole Mac requests are never counted, since only Allow once exists for them. Extend B's card test: `the fourth request for the same folder shows the count`, and `a Whole Mac request never does`.
- [x] **Step 6: Run the tests.** `npm run test:bot-allowed`, `npm run test:bot-runtime`, `npm run test:bot-rules`, and B's suite. Expected: PASS.
- [x] **Step 7: Update** `.memory/bot-rules.md`, `.memory/bot-durable-runtime.md` and `docs/bot-rules.md`. The doc section covers: what counts as a class; 3 in 14 days with no denial; Always allow for <Bot>; what entries never cover (locked rules, rule-made asks, Computer Use on your Mac); entries apply on every turn kind; Remove.
- [x] **Step 8: Register and commit.** Add the test file to `test:bot-allowed` and the registry. Commit: "Count, remember and hint repeated Bot approvals".

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
    allowed: Pick<BotAllowList, "list" | "remove">;   // Task 5
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

- [x] **Step 1: Write the failing main tests.**
  - `bot-params.test.ts`: `{waitId, decision:"allow", scope:"always"}` parses. `scope` with `deny`, `scope:"chat"` and an extra key throw `Invalid bot approval fields.` `parseBotAllowedRemove` rejects an `entryId` outside `[A-Za-z0-9_-]{1,80}`.
  - `bot-allowed.test.ts` (register-and-invoke with a `Map` of handlers and a real rule book on a memory store):
    - `list` with no Bot returns both Bots' entries, and with `"bot:a"` only its own;
    - `remove` returns `{removed: true}`, then `list` is empty;
    - an unknown Bot throws `This Bot no longer exists.`;
    - a `grantBot` broadcasts `bots:allowed:changed` with `{botId}`.
- [x] **Step 2: Write the failing renderer tests.**
  - `bot-chat-pane.test.tsx`: `a repeated approval offers Always allow for Ada and answers with that scope`. Push a `bots:approval` prompt with `always: {key:"k", count: 3}`, and expect:
    - the text `You’ve allowed this 3 times in the last 2 weeks.`;
    - clicking `Always allow for Ada` invokes `bots:approve` with `{waitId, decision:"allow", scope:"always"}`;
    - a toast `Ada won’t ask about this again.`

    A prompt without `always` has no such button.
  - `bot-allowed-list.test.tsx`: two entries render their `describeBotApprovalRule` text and `Added 3 Nov 2026 · Used 12 times`. `Remove` on the second calls `onRemove` with it, and the button is disabled while `removing` names it.
  - `bot-profile.test.tsx`: the `Allowed without asking` row shows `2` and navigates to `/bots/bot%3Aa?page=allowed`. `bots-view.test.tsx`: that URL renders the page heading `Allowed without asking`, and its back button returns to Profile.
  - `bots-settings.test.tsx`: entries for Ada and Jo render under their names. Remove on Jo's entry invokes `bots:allowed:remove` with `{botId:"bot:jo", entryId}`. No entries shows `No Bot does anything without asking yet.`
- [x] **Step 3: Run and see them fail.** `npx tsx --test main/handlers/bot-params.test.ts main/handlers/bot-allowed.test.ts renderer/main/bots/bot-chat-pane.test.tsx renderer/components/bots/bot-allowed-list.test.tsx renderer/main/bots/bot-profile.test.tsx renderer/main/bots-view.test.tsx renderer/components/settings/bots-settings.test.tsx`. Expected: FAIL.
- [x] **Step 4: Implement.**
  - `use-bot-allowed.ts` is a query on `queryKeys.botAllowed(botId)`, invalidated on `bots:allowed:changed` (all Bots when the key's id is `"all"`).
  - Before styling the card button and the list rows, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` (AGENTS.md). Rows reuse the profile's `FieldSet`/`Field` inset-row treatment, and Remove uses the shared small transparent button.
- [x] **Step 5: Run the tests.** The same command, then `npm run test:bots`, `npm run test:bot-rules` and `npm run type-check`. Expected: PASS.
- [x] **Step 6: Update the docs** listed above. Settings → Bots gains its third group. The help topic adds one sentence: after you approve the same thing three times, the card offers Always allow for that Bot, and you can remove it from the Bot's profile or Settings → Bots. Mark Plan D's row in `docs/plans/README.md`.
- [x] **Step 7: Register and commit.** Add the two new test files to `test:bot-allowed` and the registry. Commit: "Show what each Bot may do without asking".

### Task 7: Remote: the list on phones (contract revision 57, provisional)

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
  export const AIDEN_REMOTE_BOT_ALLOWED_CONTRACT_REVISION = 57 as const; // re-claim at merge; becomes AIDEN_REMOTE_CONTRACT_REVISION
  export const AIDEN_REMOTE_BOT_ALLOWED_CAPABILITIES = ["bot:allowed"] as const; // in OPT_IN, NEGOTIABLE and CAPABILITIES lists
  export interface AidenRemoteBotAllowedEntry { id: string; kind: "rule" | "folder"; what: string; addedAt: string; uses?: number; lastUsedAt?: string }
  // AidenRemoteBotApproval gains `alwaysCount?: number`, sent only to a device with bot:allowed and only when the card offers Always.
  export interface AidenRemoteBotAllowedList { botId: string; entries: AidenRemoteBotAllowedEntry[]; nextCursor?: string } // ≤ 50 per page; includes ALL rules and folders across pages
  export function parseAidenRemoteBotAllowedList(value: unknown): AidenRemoteBotAllowedList;           // exact keys
  // aiden-remote-bot-allowed.ts
  export function createAidenRemoteBotAllowList(deps: {
    allowed: Pick<BotAllowList, "list" | "remove">;
    botExists(botId: string): Promise<boolean>;
  }): { list(botId: string, cursor?: string): Promise<AidenRemoteBotAllowedList>; remove(botId: string, entryId: string): Promise<AidenRemoteBotAllowedList> };
  ```
- Routes:
  - `GET /bots/{botId}/allowed` accepts an optional bounded opaque `cursor` and needs `bot:read` plus `bot:allowed`. First read captures the combined rule/folder view into a short-lived, bounded, device-and-Bot-bound snapshot, sorted by createdAt then id. Cursors page that same snapshot in groups of 50; expired/foreign cursors fail with a refreshable error. No entry is truncated because 50 remembered rules already exist. Folder grants do not consume the remembered-rule admission limit. Both native clients load subsequent pages and can remove every row.
  - `POST /bots/{botId}/allowed/{entryId}/remove` takes body `{}` and needs `bot:write`, `bot:read` and `bot:allowed`. It invalidates that device's old list snapshots and returns a fresh first page. Clients refresh and page the new view after removal. It is naturally idempotent; removing an entry already gone changes no authority.
  - `what` is the entry's `what`, at most 200 characters.
  - `POST /approvals/{id}/respond` with `scope: "always"`: allowed only for a device with `bot:allowed`, on a Bot card whose prompt carries `always`. It calls `approvals.decide(waitId, "allow", "always")`. Any other case stays `invalid_request`.
  - An unknown Bot is `not_found`.
  - `bot:allowed` is offered only when the host wires `botAllowed`.

- [x] **Step 1: Write the failing tests.**
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
  - Combined-list case: 50 remembered rules plus several existing folders page through host, iOS and Android parsers without omissions; every row can be removed. Exercise a foreign/expired cursor, remove during pagination and refresh. Fixtures include `nextCursor` and the next page.
  - `aiden-remote-bot-session.test.ts`:
    - `a phone with bot:allowed can answer Always on an offered card`: `respondApproval(..., "allow", "always")` calls `decide` with the scope, and the wire approval carried `alwaysCount: 3`;
    - `Always is refused on a card that doesn't offer it`, and `for a device without bot:allowed`: both `invalid_request`, and that device's wire approval has no `alwaysCount`.
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/aiden-remote-bot-allowed.test.ts main/services/aiden-remote-router.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-bot-session.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement.** Do the protocol constants, parsers and service. Add the router block modelled on `botSpendingMatch` with a strict optional cursor parser for GET, `requireNoQuery` for remove, `requireEmptyJsonObject` and `requireDeviceCapabilities(device, ["bot:allowed"])`. Wire it in `aiden-remote-service-main.ts` with `toolApprovalRules` and the Bot store.
- [x] **Step 4: Update the contract artifacts.**
  - `contract.json` gets `botAllowed`: a list with a folder entry, a paginated maximum-rule-plus-folders example, the first page after a remove, the capability refusal, and an approval with `alwaysCount`.
  - `openapi.json` gets both paths.
  - `docs/aiden-remote-api-v1.md` gets a "Revision 57 (`bot:allowed`)" section.
- [x] **Step 5: Run the tests.** `npm run test:aiden-remote`. Expected: PASS.
- [x] **Step 6: Register and commit.** Add `aiden-remote-bot-allowed.test.ts` to `test:aiden-remote` and the registry. Commit: "Show a Bot's allow list on phones (Remote rev 57)".

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

- [x] **Step 1: Write the failing tests.**
  - iOS `AidenBotAllowedTests`:
    - `testDecodesFixtureList` decodes `botAllowed.list` from `contract.json` like `AidenBackgroundJobsTests`;
    - `testRemoveReplacesListWithResponse` uses a stub client returning the post-remove fixture, and the model has one entry;
    - `testRowHiddenWithoutCapability`;
    - `testApprovalOffersAlwaysOnlyWithCount`: a fixture approval with `alwaysCount` shows the button and responds with `scope: "always"`; one without it shows Allow and Deny only.
  - Android `AidenBotAllowedTest`: the same four cases, mirroring `AidenBackgroundJobsTest`.
- [x] **Step 2: Run and see them fail.**
  - iOS: `xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -only-testing:AidenOnTheGoTests/AidenBotAllowedTests -destination 'platform=iOS Simulator,name=iPhone 17'`, or the command in `ios/README.md`.
  - Android: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AidenBotAllowed*'`.
  - Expected: FAIL.
- [x] **Step 3: Implement** the models, client calls, capability negotiation (asked for alone, like `chat:jobs`), screens and profile rows. Decode `nextCursor`, load all subsequent pages on request, and refresh the list after remove or an expired cursor. Do not cap the combined list at 50. Test maximum rules plus folders on both native clients.
- [x] **Step 4: Run the tests,** plus `AidenRemotePhase0Tests` and the Android protocol tests. Expected: PASS.
- [x] **Step 5: Commit.** "Allowed without asking on iOS and Android"

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


### Phase D started, 2026-11-04

Both Gate5R4 reviewers accepted C at55678558e; C status commit69662649f is the phase-D base. Work is on feature/bot-allow-list. Follow Tasks1–8 in order, with real behavioral RED/GREEN evidence and parent-owned commits. Task1 starts with the shared rule types and existing remembered-approval store; Task2 waits for Task1 validation/commit. Root owns registration, integration, docs/status and review gates. Provisional Remote revision57 follows A54/B55/C56 and must be reclaimed against main before PR merge. No network/catalog changes, dependency/pin changes, CLI allow-list port or analytics expansion. D source acceptance, final Astra review, four stacked PRs and exact-head CI remain pending. No merge is authorized.


### Task 1 complete locally, 2026-11-04

The shared Bot target/view/list types and existing ToolApprovalRuleBook are implemented. The optional fourth constructor options argument supplies knownBot; Bot matches/publication fail closed without an authoritative validator, which root wires in Task5. Workspace methods/listeners remain isolated. Atomic50perBot/1000profile admission, exact targets, usage metadata, immutable publication receipts and revocation tombstones survive reopen. botConsentRevision hashes only target-relevant publication/revocation identity/status; usage, unrelated targets/Bots and receipt ordering do not affect it. Every fresh publication emits one Bot change event, including a fresh operation sharing an existing entry; transport replay emits none.

The existing512KiB document ceiling remains. Publication reserves future usage/revocation growth; receipts never prune without authoritative task-settlement GC, so byte capacity can refuse new remembered consent before count limits. Malformed/unreadable receipt state preserves evidence and fences Bot operations while workspace operations may proceed within capacity. No singleton wiring or new user-facing allow-list behavior is active yet.

Worker initial RED8pass10fail, consentRED20pass2fail and API quarantineRED are retained at /tmp/bot-allowed-d-task1-*.log. Parent event-contract RED is /tmp/bot-allowed-d-task1-parent-event-red.log, then final store/settings27pass, wholetypes0, scopedlint0 and diffclean at /tmp/bot-allowed-d-task1-parent-{final,types,lint}.log. Worker final checks also passed. New tests extend existing files, so no registry addition yet. Task2 follows only after this commit; runtime Tasks3–5 preparation is read-only and held. No fullD/native/device/live/package/CI acceptance.


### Task 2 complete locally, 2026-11-04

Per-Bot approval tallies now atomically persist immutable decisions, provenance, person-only counts and seven-day hint ownership in a 0600 file. Counts keep 20 events across at most100 cached classes; immutable receipts remain indefinitely until an authoritative task-settlement collection boundary exists. Corrupt, unreadable or lost previously observed receipt state preserves evidence and fails closed. Bot deletion immediately fences queued writers, removes only its tally file and preserves sibling files and other Bots. Exact replay returns the saved decision result without recounting or moving the hint cooldown.

Historical recovery uses original decidedAt. First publication completion is durable and idempotent, removes earlier history and the exact completed Always event, and preserves other equal-time events, later history and weekly hint ownership. Revoked completion clears nothing. Aligned private allowedDecisionIds prevent guesses when an event was capped, forgotten or evicted. No public contract or file version changed; these new files are not wired into live approvals yet.

The original missing-module RED and recovery RED32pass6fail are retained. Parent official suite initially38passed; inspection then found the own-Always reset gap. Follow-up RED38pass7fail became registered test:bot-allowed48pass0fail. Whole types, scoped lint and diff checks passed. Logs: /tmp/bot-allowed-d-task2-own-reset-{red,green,official,types,lint}.log. Root registered the test script/pretest and CI lane, with registry15pass at /tmp/bot-allowed-d-task2-parent-registry.log. Task3 follows this commit; Tasks4–8 remain held. D source review, native, Cua, package, live-provider and hosted-CI acceptance remain pending.


### Task 3 complete locally, 2026-11-04

Exact connection/server/tool and normalized site/action classes now feed D only after fresh rules, eligible routine go-ahead and C's single coverage attempt. Remembered entries skip eligible baseline approvals only; rule-made asks, locked hand-offs and Computer Use stay outside. Actual page binding precedes use recording. Consent, full effective rules, authority, operation, browser binding and live input ownership are rechecked through execution. Unstable or unreadable book evidence re-admits ordinary policy with both C and D lookup disabled, so it cannot reuse stale Ask/hand-off classification or spend another plan reservation.

The required target-specific consentRevision port and private read-only approvalRequirements probe are available for Task4. Usage and display changes do not change the authorization identity; Remove and binding/rule changes do. The probe never reserves a plan, records a use, offers consent or invokes a binding callback. Main singleton wiring remains deferred to Task5.

Worker focused target/assembly123pass, runtime441pass, rules62pass, wholetypes/scopedlint/diff0. Initial RED95pass16fail includes missing module/API; two later genuine drift REDs caught stale Ask/hand-off fallback, and a separate RED caught probing a browser page before initial authority refusal. Logs: /tmp/bot-allowed-d-task3-{red,drift-red,probe-order-red}.log and /tmp/bot-allowed-d-task3-{focused,runtime,rules,types,lint,diff}-final.log. Parent registered the target suite in test:bot-allowed and the rules CI lane: official51pass and registry15pass at /tmp/bot-allowed-d-task3-parent-{allowed,registry}.log. Task4 follows this commit; Tasks5–8 remain held. No fullD/native/Cua/live/package/CI acceptance.


### Task 4 complete locally, 2026-11-04

Structured decisions and attempt-specific authorization fingerprints now cover ordinary and rule-made approvals. Durable execution IDs remain separate from provider call IDs; changed authority, full rules, page binding or target consent produces a fresh host attempt. Exact-pair receipt lookup and settlement caches survive restart without recounting or mixing hints. The coordinator honors Always only when offered; expiry and automatic sibling provenance remain main-owned. Validated sibling release uses a fresh automatic pair, including older eligible cards without an offer. Public prompts copy safe fields explicitly, including only offer key/count. Hint output comes only from the exact executed settlement and never from failed tools. CLI adapters retain once-only behavior with no allow-list port.

Parent inspection found stale Always could reach publication before the post-answer check. Real-book REDs reproduced page and new-Ask-rule drift. The follow-up validates before settlement and exposes a revocable live publication guard for Task5's atomic first grant. Original target/title/requirements/consent remain immutable private data; callbacks never enter a cache or receipt. Committed publication proofs still permit their one-time call after the intentional generation change, without surviving Remove.

Final focused275pass and runtime474pass; rules62, messaging89, access84 and plans144 passed in the preceding validation. Rebuilt CLI183pass with3 existing skips; whole-project/CLI types, scoped lint and diff passed. Parent registered bridge tests: test:bot-allowed64pass and registry15pass results are in /tmp/bot-allowed-d-task4-parent-{allowed,registry}.log; current root types in /tmp/bot-allowed-d-task4-parent-types.log passed. Original actual REDs and setup-only failures are separated in the Task4 papercut. Publication correction evidence is /tmp/bot-allowed-d-task4-publication-{red,focused,runtime,types-final,cli-types,lint}.log. Task5 follows this commit; Tasks6–8 remain held. No fullD/native/Cua/live/package/hosted-CI acceptance.


### Task 5 integration in progress, 2026-11-04

Runtime/service and book/tally changes have separate bounded ownership; root owns journal/application storage, active-Bot main wiring, startup integration, docs and registration. Root application tests captured4 failures before the APIs/context support, then a genuine first-await snapshot failure and a strict-schema coercion failure. Current application suite74pass, scoped storage lint0 and its type-check passed. A selected Bot folder is removed through the existing expected-revision policy save under the inventory lock, preserving its home, other grants, other Bots and the approved root. Private journal input is immutable and rolls forward original D metadata. Root is checking the book's final awaited guard ordering; full Task5 validation and commit remain pending. No Task6–8 source work or D acceptance yet.


### Task 5 complete locally, 2026-11-04

The desktop service now wires exact per-class offers, immutable decisions/hints, atomic consent publication, validated sibling release, combined rule/folder listing/removal, deletion fencing and bounded historical reconciliation. First publication's final awaited authorization is its live guard, followed by synchronous deletion intent before mutation. An original committed operation bypasses stale guards only to acknowledge history. Pending original consent/title/label survives renames and acknowledgement loss; missing history never publishes a grant at startup. A corrupt Bot's tally does not stop later Bots from reconciling. B records only validated effective decisions at its private settle boundary, using original journal context for earlier Always and never incoming retry choice. Whole Mac never counts; folders without Always never offer a nudge. Safe desktop approvalCount is bounded3..20, and private hints remain tool output. Remote55 DTOs did not change.

Root application suite74pass; book/settings35pass after actual final-guard Stop/expiry REDs. Runtime/service focused92, runtime474, rules62, access96, messaging89, plans144, Bots1003 and affected host adapters147 passed. Root registered the new service test: official allowed95pass, storage/settings109pass, registry15pass and current wholetypes0 at /tmp/bot-allowed-d-task5-parent-{allowed,storage,registry,types}.log. Scoped root5files, store4files and runtime12files lint passed; whitespace clean. Worker handoff /tmp/aiden-bot-allow-d-task5-runtime-handoff.md separates actual REDs from setup failures. Root initial storageRED4, snapshotRED1 and schema-coercionRED1 are retained; all new tests extend existing registered modules except the explicitly registered service pair. Task6 follows this commit, with Tasks7–8 still held. No fullD source/native/Cua/live/package/hosted-CI acceptance.

### 2026-11-04 — Task 6 implementation started

Task5 committed50d834881 after parent95allowed/109storage/15registry/types0. Root main IPC and saved-access change events are implemented; desktop renderer work is in progress. The planned toast “<Bot> won’t ask about this again” is replaced with “Always allow requested.” because bots:approve acknowledges the bridge choice before asynchronous grant publication, which may fail while preserving the current one-time allowance. The authoritative saved list and host change events confirm persistence. Settings now has four groups, including Other Bots from A, rather than the older three-group count. B’s safe approvalCount is rendered by its existing access card during Task6. No new DTO or native contract is introduced here.

### 2026-11-04 — Task 6 source ready, verification in progress

Desktop Always/count, private strict main handlers, profile/list/settings routing and host-ID-only invalidations are implemented. Shared B access cards show their safe count. Remove keeps a disabled row until the host responds; failure retains and re-enables it with an inline error. A process-lifetime application access listener covers all successful selection saves, including Remote and folder paths, while failed saves emit nothing. Focused renderer135, Bots1010, rules66, rootmain/application89, registeredallowed102 andregistry15 passed. Whole types and Cua final acceptance are pending. The initial Cua flow reached rule removal, then exposed a test navigation mistake at narrow width, where the sidebar was intentionally collapsed. The corrected test reopens navigation; no retry/timeout/production behavior was changed.

### 2026-11-04 — Task 6 complete locally

Task6 source is frozen and all planned files/tests are registered. Focused renderer135, Bots1010, rules66, parentmain/application89, registeredallowed102, registry15, wholetypes0 and scopedlint/diff0 passed. Final type log is /tmp/bot-allowed-d-task6-renderer-types-after-root-fix.log. Parent Cua /tmp/bot-allowed-d-task6-cua-final2.log passed2 tests with retries0 in11.4s, covering existing B access cards and the complete repeated-approval→Manage→profile removal→Settings removal path. Light1280/dark600 card screenshots, dark list and Settings screenshots were inspected. Two earlier runs exposed test-navigation setup mistakes, not product failures: narrow sidebar collapse, then the distinct Bots sidebar’s Back to Aiden step. Both logs and corrective details remain in the root papercut. No assertion or timeout was weakened. Truthful acknowledgement copy and pending Remove behavior are recorded above. Task7 host may start after this commit; native implementation waits for its stable fixture manifest. No wholeD/Gate6, physical/rendered-native/live/package/hostedCI acceptance.

### 2026-11-04 — Task 7 started

Task6 committed18d547748 clean. Task7 host is implementing revision57 provisionally, explicit device/Bot-bound immutable cursor views and capability-gated ordinary/B-folder approval counts. The service API adds deviceId first to list/remove because the plan’s snapshot ownership cannot be enforced from botId alone. Cursor snapshots use50rows/page,2minuteTTL,64global/4perdevice plus an aggregate byte budget; oversized views fail with a refreshable error rather than truncate rows. Native implementation remains held until the canonical fixture manifest is stable. Root owns registration/status/commit and native coordination.

### 2026-11-04 — Stable Task 7 fixture, native Task 8 started

Remote57 canonical botAllowed fixtures are stable, with rule/folder list and complete pagination beyond50, remove/refusal examples, eligible ordinary Always counts and B folder counts, and exact legacy projections. Protocol behavioralRED→GREEN1 and the existing B count rejection are captured by the host worker. Root registered the new Remote service suite. NativeTask8 starts from this stable manifest while host implementation/tests finish, with no shared file ownership. Both native clients must reject malformed/extra/null data, page all rows, isolate capability negotiation and retain exact per-decision/scope retry identities. No host/native completion or wholeD acceptance is claimed at this milestone.

### 2026-11-04 — Task 7 host complete locally

Remote57 host source and stable canonical fixtures are frozen. Parent registered the new service suite in test:aiden-remote and the CI lane. Focused314, fullRemote1300pass+2existing conditional skips, final B holder/legacy SSE3pass, wholetypes0/scoped10-filelint0/diff0. Handoff /tmp/aiden-bot-allowed-d-task7-host-handoff.md lists exact files and actual REDs. Parent rebuiltCLI268files/27.1MiB, full183pass+3existing skips andCLItypes0. An extended existing real HTTPS test proves CLI never advertises bot:allowed and its allow-list route is unavailable. Its standalone run hit the existing A messaging reply deadline before those assertions, then passed on the one allowed unchanged-limit rerun; this remains a reported timing flake, not a resolved bug. Logs /tmp/bot-allowed-d-task7-cli-{build,tests,types,exclusion,exclusion-rerun}.log. No test assertion/timeout/retry was weakened. NativeTask8 is implementing the stable contract separately, so wholeD/native/Gate6/physical/rendered/live/package/CI acceptance remains pending. Reclaim revision57 against main before the PR.


### 2026-11-04 — Task 8 locally complete, Gate6 pending

Both native clients implement independent bot:allowed negotiation, strict list/count decoding, complete pagination, pending Remove with failure recovery, held-capability counts, scoped Always retry identities and lifecycle fences. Xcode explicitly registers the new Swift model, view and tests. The canonical Remote57 fixture is unchanged. Actual offered-count and control/bidi/trailing-newline REDs were captured before their corrections, without weakening assertions, timeouts or retries. Final iOS simulator checks passed406 with5existing conditional configuration/physical-device skips; Android focused225 plus navigation22 passed, lint reported0errors/51warnings/5hints and instrumented tests compiled. No native rendered UI or physical-device claim is made. Native handoff: /tmp/aiden-bot-allowed-d-task8-native-handoff.md.

Parent final checks passed Bots1012/runtime474/rules66/messaging89/access98/plans144/allowed102, whole types and registry15. Post-Task7 production startup and desktop flows passed2Cua tests with retries0. Task7 host Remote1300+2existing skips and rebuiltCLI183+3existing skips remain the relevant full checks. The standalone CLI messaging timing flake remains recorded, despite its one unchanged-limit passing rerun. Whole-D Gate6, final Astra high review, four stacked PRs and exact-head hosted CI remain pending. Main a5c5db8b1/Remote53 was freshly fetched and remains an ancestor of A; revision57 is still provisional until the pre-PR recheck. No full-D, live-provider, packaging, release or hosted-CI acceptance is claimed.


### 2026-11-04 — Gate6 first review, corrections underway

Both independent reviewers rejected whole-D checkpoint5c43f4a81. Opus identified live folder hints inferred from clock equality, unreadable rule receipts wedging deletion, recomputed offer state conflicting with an exact replay receipt, unnecessary tally lookup on rule/Computer Use cards, and unsafe publication-label boundaries. DeepSeek independently confirmed deletion. Bounded workers own settlement and deletion corrections; root reproduced the bridge failure with actual corrupt tally bytes, captured2RED failures and15GREEN tests, and limits durable lookup to eligible remembered classes.

DeepSeek's combined-order Low is rejected on independent evidence: list already sorts the combined rule/folder array. A real-module probe with rules atT1/T3 and a folder atT2 returnsT3,T2,T1; moving the folder toT4 puts it first. Logs /tmp/bot-allowed-g6r1-root-order.log and /tmp/bot-allowed-g6r1-order-confirm.log. The first probe's later log reflected a reused row object after mutation; the second probe snapshots each returned row and records both correct orders. No ordering production edit is warranted. Fresh reviewers must consider this disposition and all retained objections. Gate6, final Astra, PRs and exact-headCI remain pending.


### 2026-11-04 — Gate6 first-round corrections locally verified

All five Opus findings are corrected. Live folder settlement uses explicit provenance instead of equality between captured and observed time; historical journal reconciliation cannot earn a new hint. New hint text is saved in its immutable receipt. Once/Deny replay uses the receipt's original offered state while retaining all other identity checks. The actual third-approval SIGKILL case now resumes through the real service with one receipt and one execution after the offer changes. Publication display text trims after bounding, strips bare URL schemes and unpaired surrogates, and never cuts a Unicode scalar.

The global book uses a private typed quarantine error so forgetBot can abort without changing damaged evidence and continue deletion. Healthy deletion still tombstones its own receipts; genuine write errors still fail and retry. Real session/DataStore/allow-list/tally tests cover direct and startup deletion through all downstream cleanup, pending-journal clearing, restarts, byte preservation and fail-closed grants. The approval bridge reads D receipts only for eligible remembered classes, preserving unrelated rule-made and Computer Use cards during tally corruption. DeepSeek ordering remains rejected as described above; an independent interleaved real-book test passes the existing production sort.

Actual REDs: settlement9fail/49pass, threshold-crash1fail, deletion9fail/2pass and bridge2fail/13pass. Worker final checks passed settlement192 plus final service27, deletion84, whole types/scoped lint and diff checks. Parent integrated suites passed allowed113/runtime480/access101/plans144/rules66/messaging89/Bots1012/types0/registry15; all12changedTypeScript files lint clean. Full Remote, rebuiltCLI and Cua follow before freezing a correction head. No native/wire/revision change; prior native406+5conditional skips/Android225+22 evidence remains applicable to unchanged clients. Fresh dual Gate6 review is required, followed by final Astrahigh, four PRs and exact-headCI.

Parent fullRemote also passed1300 with2existing conditional skips, and the rebuilt production startup plus desktop Cua flows passed2 withretries0 in11.9s. Logs /tmp/bot-allowed-g6r1-parent-{remote,cua}.log. CLI rebuild passed; fullCLI and CLItypes finish before the correction freeze. The original standalone messaging timing flake remains unresolved and reportable.

CLI final correction validation passed183 with3existing PTY skips, rebuilt268files/27.1MiB and CLItypes0; /tmp/bot-allowed-g6r1-cli-{build,tests,types}.log. All correction checks are now green and workers stopped. Root freezes a new commit for fresh independent whole-D Opus5.5medium and OpenCodeGoDeepSeekV4.1Flashhigh review, carrying both complete first reports, the ordering rejection and all unresolved objections. No source acceptance is claimed before both accept this same correction head.


### 2026-11-04 — Owner workflow update and Gate6 round2 corrections

The owner now requires direct implementation by the main session and only Opus5.5medium review. Sol implementation workers are stopped and OpenCode round2 cancelled; the earlier finalAstra request is superseded too. Prior reports remain dated evidence. Opus rejected930e9392e with a Medium regression for control-character folder names and a Low for long site display labels. The main session captured13actualRED failures through real directories/resolution/authorizer/bridge/journal/tallies and real service/site publication, then fixed those paths directly. Tabs/newlines/DEL are legal private JSON-encoded path identities, while NUL, canonical/absolute/root and4096UTF8-byte boundaries remain enforced. Display labels still use sanitized bounded text. Recovery attempts each independent receipt before surfacing failures, so a malformed receipt does not suppress valid later history.

The bridge comment now states its actual scope-proven lookup boundary. The reviewer’s possible remember-without-requirements crash replay remains an unproven Low observation, not a claimed fix; carry it into the narrow re-review and final program review. No native/RemoteDTO/revision changes. Broader checks and a new frozen correction review follow; source/whole-program/hosted-CI acceptance remains pending.

Root direct correction validation passed149focused, allowed118/runtime480/access110/rules66/types0/registry15, sixchangedTSfileslint0 anddiff0. Logs /tmp/bot-allowed-g6r2-root-{red,green,focused,allowed,runtime,access,rules,types,registry,lint}.log. RED13fail becameGREEN13, and private-path guards independently refuse NUL/relative/root/noncanonical/oversizedUTF8 identities without creating a ledger. No import/wire/native/CLI behavior changed, so prior Remote1300+2skips/Cua2/CLI183+3skips/native406+5/Android225+22 remain prior checkpoint evidence, not rerun counts for this delta. Root freezes a new correction commit and requests only Opus5.5medium review.


### 2026-11-04 — Gate6 accepted and final display Low fixed directly

Opus5.5medium accepted whole-D source correctness at eaa4ae9b00e054f6a851620ceb728bf28ebcc9a9, with noBlocking/Important/Medium findings. The narrowround3 delta review relies on round2’s full-D read as prior evidence; its report closes the canonicalfixture/OpenAPI read gaps and independently runs real grantBotFolder for control-character names. Report /tmp/aiden-bot-allowed-GATE6-opus-r3.md. It retains the unproven fallback remember/no-requirements crash replay and earlier accepted observations.

Root fixed the new display-only Low directly: botFolderEntries removes existing hand-off controls/bidi characters and collapses whitespace only in its display path. Its exact root path, id and Remove remain unchanged. A real-grant/API-visible RED1 becameGREEN86 across application, Remote list and renderer suites; scopedlint0, /tmp/bot-allowed-g6r3-display-{red,green,lint}.log. Final whole-program Opus5.5medium review remains required. No newnative/wire/revision claim.

Fresh pre-PR fetch found origin/main advanced to581aee4f8282444e13e3db1a2d7fefceaae65de9 by docs-onlyPR724; Remote stays53. Root will merge it intoA and carry the merge bottom-up throughB/C/D, preserving all branch histories. Revisions54–57 still apply. No merge of PRs is authorized; local main synchronization is separate.

Main synchronization completed without conflicts: A0dbffbd40/B5d46dd9a2/C11d70ba4b/D38411d77d before this final status commit. The incoming main delta changes only two plan documents; no accepted runtime contract changed. MainRemote53 and stack54–57 rechecked. Finaltop integration passedBots1013/types/registry15/CLIbuild+types/Cua5retries0. FinalwholeprogramOpus5.5medium is the remaining source gate; currentcheckpoint is supplied directly to that freshreview. PR/CI/device/live/release remainunclaimed.


### 2026-11-04 — Final whole-program review round 1 corrections

Opus rejected `071e92e1c` with two reproduced Important findings. The main session fixed both directly: the production fixed-location write list now includes `tool-approval-rules.json` and `bot-folder-grants.json`; the same pure helper is used by production registration and behavioral tests. Direct, symlink and nested codemode writes/edits leave both files unchanged while application grant/revoke still works. D now refuses remembered classes for actual payment-provider hosts before host normalization. Real durable turns with existing saved entries still ask, and repeated approvals never produce an Always offer. Ordinary mail subdomains remain eligible. No shell sandbox claim is added.

Low L3 is fixed by allowing an expiry deny to settle a card while an automatic release awaits validation. The resumed release cannot win. Low L4 is fixed with host-owned turn routing: person decisions on Bot-message turns still count, but cannot consume or emit the weekly hint. Actual durable input metadata and real tally/service tests cover the boundary. No public DTO or Remote revision changes.

Low L1 is being corrected by untracking only papercut notes added by this stack, preserving them locally. The seven notes already on main remain tracked. Low L2 is accepted as a display-only limitation: an unanswered plan on a Bot-message turn can produce the sender’s generic “didn't answer” timeout rather than “gave up”; the actual plan deadline and effect fence still hold. No approval is implied, no step starts, and Stop remains available. A proposed courier/plan-state coupling was discarded rather than expanding the private lifecycle contract for this wording change. Carry this bounded observation into the PR and final review.

The final reviewer did not read the whole implementation, clients or contracts. The next fresh Opus5.5medium round must close every listed read gap before whole-program source acceptance. Four stacked PRs and exact-head CI remain pending; no merge is authorized. The CLI timing flake remains unresolved and must be disclosed without another targeted rerun or weaker limits.


### 2026-11-04 — Final round 1 correction validation and local-note cleanup

The main session committed the consent corrections at `2aa8b3136`. Validation passed: focused file-router/assembly/extension231, allow-list122, runtime487, access110, plans144, messaging89, rules66, Bots1022, whole TypeScript and registry15. Full Remote passed1300 with2 existing conditional skips. The rebuilt CLI passed183 with3 existing PTY skips and its own types. The CLI build first caught a desktop helper import reaching Electron; the helper was split into a desktop-only module, the shared CLI policy stayed unchanged, and the rebuilt CLI graph check passed. Root suites used Node22.23.4; the CLI shell resolved Node26.12.1 for this run, so that count is not new pinned-CI-runtime evidence. No test assertion, timeout or retry was weakened. Earlier standalone CLI messaging timing flake remains unresolved and reportable.

Cua passed5 withretries0 in24.9s across messaging, access/Always+Manage+Remove, plan/checklist/Stop and onboarding. Logs `/tmp/bot-program-r1-{allowed,runtime,access,plans,messaging,rules,bots,registry}-final.log`, `/tmp/bot-program-r1-types-final2.log`, `/tmp/bot-program-r1-lint-final2.log`, `/tmp/bot-program-r1-remote.log`, `/tmp/bot-program-r1-cli-{build,tests,types}-final.log`, `/tmp/bot-program-r1-cua.log`. This remains fake-provider/headless/Cua evidence, not native rendering, physical-device, live-provider, package or hosted-CI acceptance. No public/native contract changed; earlier native evidence remains prior-checkpoint evidence.

Papercut cleanup is complete at every stack layer without rewriting history. Actual tracked inventory before cleanup was41 versus7 on main, so34 added notes were preserved locally and untracked. All four branch diffs against main now have no `.papercuts` changes; the7 main notes remain tracked. Backup manifest and copies are under `/tmp/bot-program-papercut-preserved`, and local ignored copies remain in `.papercuts`. A=`5514e28a7`, B=`b0c0550b6`, C=`3f2def1f5`; D’s runtime tree is unchanged from the validated correction after the cleanup merges. Historical entries about previously staged notes remain history. Final fresh complete Opus5.5medium review and PR/CI work remain pending, with Low L2 explicitly retained.


### 2026-11-04 — Final round 2 cleanup correction and remaining review scope

Opus round2 found no Blocking, Important or Medium findings and no runtime, consent, replay, privacy or contract defect at `dad62ed83`. Whole-program acceptance is still withheld because required historical reports and several small source/contract sections were not fully read. A fresh narrow Opus5.5medium round will read those remaining sections, verify this correction and carry the existing retained observations; the main session has not waived any read requirement.

The earlier cleanup record was too broad: it counted only the root `.papercuts` directory. Its41tracked/34added counts were correct for that directory, but omitted `ios/.papercuts/bot-messaging-task9-native.md`. Across the repository the original inventory was42tracked/35added. The nested note is now also preserved locally and in `/tmp/bot-program-papercut-preserved/nested/ios/.papercuts/`, untracked on A and merged upward through B/C/D without rewriting history. A repository-wide path-component check now finds no `.papercuts` changes against main on any of the four layers; the7 baseline notes remain unchanged. This corrects, rather than silently rewriting, the previous dated “complete” claim.

The OpenAPI plan response route now describes `planId` as the exact plan ID returned by the Bot session; the access route keeps its correct waitId description. Only a description changed, with no schema, wire shape, revision or native behavior change. Runtime validation remains the round1 correction evidence. The unresolved CLI timing flake and all accepted A–D observations, including the generic plan-timeout sender copy and corrupt tally blocking B Once/Not now, remain explicit PR disclosures. No merge is authorized.

Correction validation: existing Remote protocol/schema suite64passed, JSON decoded successfully, full-stack diff-check clean. No behavior test was added for a description-only edit. Runtime/client sources are unchanged from `dad62ed83`; prior runtime/native/Cua counts are not new reruns. The remaining full-history, small renderer/art, delete-path and exact fixture/OpenAPI reads are assigned to the next fresh Opus review rather than waived.


### 2026-11-04 — Final source acceptance and interrupted-delete recovery Low

Opus accepted whole-program source correctness and conformance at `32fb4645991130618083de76b040612e16f75529`, based on round2’s completed production/client read plus round3’s full completion of histories, remaining renderer/art, deletion and raw fixture/OpenAPI reads. No required scope was waived. This is source acceptance only. Reports `/tmp/aiden-bot-program-final-opus-r3.md` and its identical REVIEWER copy retain all A–D limitations.

Root chose to fix the newly reproduced Low startup wedge before PRs. The B-owned correction `37ef50fb0` treats a genuine capability-unavailable exception as no root selection during folder recovery, allowing interrupted deletes to finish. Disk errors and same-name impostors remain fail-closed with unchanged evidence. B’s application/journal/root80, types and lint pass; merged through C`9bd81c398` and D without rewriting history. The one test append conflict retained both existing D observer assertions and all new recovery cases. On the integrated top: application/journal/root/protocol152, Bots1027, access110, whole TypeScript, scoped lint and full diff-check pass. RED3fail/2controls and all logs `/tmp/bot-program-r3-recovery-{red-final,b-green-final,b-types-final,b-lint-final,top-green,top-types,top-lint,top-bots,top-access}.log`. Prior CLI, native, Cua and full Remote results are unchanged-source prior evidence, not new runs. Narrow Opus verification of this runtime correction remains required.

R3’s receipt-description Low is fixed: `savedForFuture` explicitly records the earlier durable approval, including replay after Remove, and does not confirm current access or restore temporary authority. The pre-existing `accepts.maxItems`23 versus26 vocabulary discrepancy is retained as a documentation Low; shipped clients negotiate capabilities separately, and the runtime parser’s actual bounds remain authoritative. The unused `.oa-bots-bubble` CSS and import-before-header placement are retained cosmetic observations with no behavior effect. They are disclosed rather than expanded into unrelated UI changes.

The PR disclosures also carry the history details newly enumerated by round3: a person’s joined steer contributes to the answer routed back to the sending Bot; Bot message labels use the routine icon and previews omit message/status rows; Xcode diagnostics/main-thread/compiler warnings remain unclaimed; adding roots can invalidate other Bots’ leases; exact-root conversion may leave overlapping phone roots; one temporary folder per task is the accepted replacement design; failed journal recovery writes retain the lifecycle fence; B Task6’s initial RED was never captured; Compose UI tests were compiled, not executed; deleting a Bot can retain unselected hidden roots and committed path receipts on disk, with no grant. The CLI timing flake, generic sender timeout copy and corrupt tally blocking B Once/Not now remain explicit limitations.

Fresh main recheck still `581aee4f8`/Remote53; stack54–57 remain provisional until merge. No PR or merge yet. Root implements directly, only Opus5.5medium reviews; no implementation/OpenCode/Astra agents.


### 2026-11-04: Final round 4 recovery correction

Opus round 4 rejected `d35506d72` with Important R4-1. The earlier interrupted-delete fix incorrectly treated every `BotCapabilityUnavailableError` as proof that a policy was absent. Production also uses that error while its checkpoint is paused after an uncertain commit. In that state the broad catch could remove a root whose policy had already published, mark the journal rolled back and drop the service fence. The previous dated statements about compensation during that pause were incorrect and are superseded here.

The B correction `5d7f861be` now requires a fresh, readable inventory audit to name the exact Bot in `missingBotIds` before compensation can treat an unavailable policy or binding as absent. A poisoned checkpoint cannot provide that proof, so recovery retains the pending journal, root and lifecycle fence. Actual interrupted deletes still recover. The binding-deletion test now removes authority before throwing, rather than using the broad error class as its evidence.

A new test uses the real disk-backed capability store, checkpoint, key store, application service, folder journal and root service with a failing in-memory anchor. Its meaningful RED observed `rolled_back` where `pending` was required. GREEN verifies the original grant failure, retained root, zero removals and fenced mutations; reopening the real store and service then commits the receipt and replays the same operation as `already_allowed`. The simulated anchor failure is not live or signed Keychain evidence. Initial incomplete inventory, notice, error-message and audience fixtures were setup errors, not behavioral RED evidence.

B validation passed 125 tests, whole TypeScript and scoped lint. After clean merges through C `e0b25d3b9` and D `891c4a25a`, integrated application/checkpoint/store/roots/journal/protocol tests passed 197, Bots passed 1,028 and access passed 110. Whole TypeScript and scoped lint passed again. Logs are `/tmp/bot-program-r4-checkpoint-red-final.log`, `/tmp/bot-program-r4-b-{green-final,types,lint}.log` and `/tmp/bot-program-r4-top-{green,types,lint,bots,access}.log`. Prior native, Cua, full Remote and CLI counts remain prior-checkpoint evidence, not new runs.

A fresh narrow Opus 5.5 medium round must verify R4-1 and R4-2 before PR creation. Whole-program source scope otherwise rests on the completed round 2 and round 3 reads; no read requirement was waived. All retained A–D observations and the unresolved CLI timing flake remain PR disclosures. Remote revisions 54–57 require a fresh main check before the four stacked PRs. The main session implements directly and uses only Opus reviewers. No merge is authorized.


### 2026-11-04: Final source gate accepted and PR stack preparation

Opus 5.5 medium accepted `803b50cfa0455c63ede73c04abe2e71c9069c5f1` in round 5, with no Blocking, Important or Medium findings. R4-1 and R4-2 are fixed, and the original interrupted-delete recovery still works. This acceptance combines the completed round 2 and round 3 whole-program reads with round 5's narrow recovery review; it is not a fresh full reread or a merge authorization. Runtime and client sources are unchanged by this status update.

The reviewer independently passed 133 focused tests and TypeScript, plus eight real-store probes and three mutation checks. Real-store probes cover interrupted deletion, shared roots, publication failure, committed-head failure and repeated anchor failure across restart. The in-memory anchor is a test double, not live Keychain evidence. The reviewer made one unnecessary `git fetch --dry-run` despite the read-only review's no-network rule; its output was discarded and no ref moved. Root separately fetched main before PR preparation and confirmed `581aee4f8`, Remote 53. Stack revisions 54–57 remain valid for creation and must be rechecked at merge.

R5-1 is retained as a nonblocking defensive test gap, not an unresolved runtime defect. A mutant that ignores `missingBotIds` after a readable audit passes the suite, although the reviewer found no production path to an unavailable lookup followed by a readable audit naming that Bot as present. Current code still checks that exact ID and rethrows otherwise. R5-2 corrects the earlier dated wording: the grant rejects with the typed pause error. Recovery replaces the uncertain-commit subclass, so the test does not prove preservation of the original subclass or cause. No behavior relies on that distinction.

All retained A–D observations and the unresolved CLI reply-poll flake remain explicit in the PR descriptions. Local papercut notes stay untracked; repository-wide checks show no note changes on any layer. Four stacked PRs and their exact-head hosted CI are the remaining delivery work. No merge, rendered-native, physical-device, live-provider, package or release acceptance is authorized or claimed.
