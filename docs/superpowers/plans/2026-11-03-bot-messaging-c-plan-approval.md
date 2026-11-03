# Bot messaging C: plan approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bot can ask the person to approve a whole task once with `propose_plan`. After that, approval-gated calls inside the plan's covered items run without a card, the card becomes a checklist, and everything outside the plan still asks.

**Architecture:**
- A new `main/services/bot-plans/` module validates proposals against the Bot's current access, keeps approved plans durably per Bot, and answers one question at call time: does an active plan bound to this run cover this call, and does it still have calls left?
- `bot-tool-assembly.ts` asks that question where it already turns approvals into `preapproved` for "routines go ahead", so direct calls and codemode's nested calls pass the same check.
- The card is a live waiting card (like questions and hand-offs) on desktop and phones.

**Tech Stack:** TypeScript, Electron main and renderer (React), Pi Durable (pinned, unchanged), `node:test` through `tsx --test`, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/plans/bot-to-bot-messaging-research.md`](../../plans/bot-to-bot-messaging-research.md) §11.1, §12 and §14 step 3. Section numbers (§n) below refer to it. Plan A (`message_bot`, §8) and Plan B (`request_access`, §9) are sibling plans in this program. This plan consumes them only through the two ports in "Cross-plan contracts".

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only: never `readFileSync` production source and `assert.match` against it, and no tautological or change-detector tests.
- Register every new test file twice: in a `package.json` script (new `"test:bot-plans"`, with `"pretest:bot-plans": "npm run build:lease-flock"` like `test:bot-pause`), and in a lane of `scripts/ci-test-registry.json` (the lane that holds `main/services/bot-rules/*.test.ts`). `scripts/ci-test-registry.test.mjs` fails if either is missing. Append to the root `test` chain and resolve conflicts by union.
- A plan never widens access. It can only turn an approval that today's policy would ask for into `preapproved`. Verdicts, hand-offs, locked rules and refusals are unchanged.
- Never covered: the locked rules (`locked.credentials`, `locked.money`), any rule whose behavior is `hand_off`, `computer_use` (the person's Mac keeps its own access card), and any call whose approval has a `rule` that the plan does not list by name.
- A plan lasts for the run that proposed it, plus inputs that join that run (follow-ups and steers), and at most `BOT_PLAN_MAX_MS = 3_600_000` (60 minutes) after approval. It ends at Stop, Dismiss, Bot delete, the card's Stop plan, when every step is marked, or when the Bot goes idle.
- Plan approvals never write remembered approval scopes (`renderer/shared/tool-approval-scope.ts`). That is the allow list's job (§13, Plan D).
- No network calls. Nothing runs at startup or during onboarding.
- Modules under `main/services/` don't import `electron`. Only `*-main.ts` wiring does.
- UI follows `GUI.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Use the shared squircle buttons and semantic tokens. No decorative or colored borders, and keep visible `focus-visible` rings. Checklist ticks are icons plus labels in soft semantic fills. No brain icons.
- Remote: claim the next contract revision after `main`'s at merge time (today `AIDEN_REMOTE_CONTRACT_REVISION` is 53 in `main/services/aiden-remote-protocol.ts:288`; Plans A and B may claim before this one). Update iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md` and the iOS revision assertion in `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift` together.
- Desktop and phones only. The CLI durable host (`packages/cli/src/bot-durable.ts`) has no cards, so it neither offers the tools nor passes the coverage port. A Mac viewing a paired Mac's Bot (`renderer/main/remote-bot-chat-view.tsx`) doesn't negotiate `bot:plans` in this plan. It sees only the "waiting for you" activity. Say both in `packages/cli/README.md` and `docs/aiden-remote-api-v1.md`.
- Pre-1.0: no migrations. `plans.json` starts at `version: 1`, and a file that doesn't parse reads as no plans (it fails closed: nothing is covered).
- Never use bare `git stash`. Update a shared PR branch by merging `origin/main`.

## Cross-plan contracts

This plan defines these ports, and the wiring in Task 5 connects them to whatever Plans A and B export. Until a sibling plan has landed, wire its port as absent. The tools then behave as described for "absent".

```ts
// main/services/bot-plans/ports.ts
/** Plan A (§8, §11.1). Absent: `bot:` turns can't raise a plan card (the tool says so). */
export interface BotPlanBotTurnPort {
  /** Plan A: `botMessageTurnOf` (renderer/shared/bot-messages.ts) over the run's request ids; the first `{kind: "message"}` gives the asking Bot's id. */
  originOf(requestIds: readonly (string | undefined)[]): { originBotId: string } | undefined;
  /** Plan A: `botMessages().announceWaiting(botId, requestIds, title, planId)`. Returns the delivery deadline (epoch ms) to race the card against, or undefined. Must not throw. */
  announceWaiting(botId: string, requestIds: readonly (string | undefined)[], what: string, waitId: string): Promise<{ deadline: number } | undefined>;
}
/** Plan B (§9). Absent: a folder outside the Bot's access is a refusal, not an access item. */
export interface BotPlanAccessPort {
  /** "inside": one of the Bot's file locations already holds it; "outside": Plan B can grant it; "invalid": not a folder Plan B accepts. */
  scopeOf(botId: string, path: string): Promise<"inside" | "outside" | "invalid">;
  /** The same grant Plan B's Allow once makes, bound to these request ids. */
  allowOnce(botId: string, grant: { path: string; access: "read" | "write"; requestIds: readonly string[] }): Promise<void>;
}
```

Plan B (`docs/superpowers/plans/2026-11-03-bot-messaging-b-request-access.md`) already names the pieces. Wire `scopeOf` as follows:
- `resolveBotAccessTarget(path, deps)`, then `coveredByBotLocations(root, await botFileLocations(admission))`;
- a covered folder is "inside", any other `folder` resolution is "outside", and `whole_mac` or `refused` is "invalid".

Wire `allowOnce` as `botRunAccess.grant(botId, { requestIds, target: "folder", key: root, root, label, identity, policyRevision, grantedAt })`.

Plan B keeps one grant per run, in memory. So a plan may open at most one outside folder, and its `access` is display-only. After a quit, that folder needs `request_access` again; Task 9 documents this.

Plan A's ingress: `botTurnOf(requestId)` gains `bot: boolean` (for `bot:`) and `botReply: boolean` (for `botreply:`). This plan reads those two fields in `botIngressAllowsTool`.

## Design decision: ticking steps

The Bot ticks steps with a second, tiny tool, `plan_step({ step, status })`. Only the Bot knows when a plain-language step is done. Mapping calls to sentences would tick wrongly, or never tick steps that have no gated call. A separate idempotent mark also keeps `propose_plan`'s schema single-purpose and replay-safe.

## Review Focus

1. **An item's cap runs out mid-task.** The next call inside that item gets its own ordinary card, is not blocked, and the checklist line reads "5 of 5 used". Task 3 (`a call past the item's cap is not covered`) and Task 4 (`past the cap the call asks on its own card`) test this.
2. **The app quits after the person taps Approve, before the tool result commits.** Resume returns "approved" with no second card, and covered calls still run without a card. Task 3 (`an approved plan survives a restart`) and Task 5 (`a re-run propose_plan returns the stored approval without asking`) test this.
3. **The person sends a new message after the plan's run ended.** That new run's calls get cards: a plan never leaks into a later run. Task 3 (`a run that shares no request id is not covered`, and `stop and endRuns end active plans` for the idle path Task 6 wires) tests this.
4. **A connector item whose Bot-written `action` understates the tool** (it says "update events" for a tool the classifier files under delete). The delete rule's ask still shows a card unless the card lists "Rule · Permanently delete something". Task 4 tests this (`a rule-made ask needs its rule on the card`).
5. **Access narrows after approval** (a connection is removed from Custom access). A covered call is refused by the verdict and never runs, and the plan doesn't resurrect it. Task 4 tests this (`a plan never widens access`).

---

### Task 1: The shared plan contract

**Files:**
- Create: `renderer/shared/bot-plans.ts`
- Create: `renderer/shared/bot-plans.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BOT_PROPOSE_PLAN_TOOL_NAME = "propose_plan";
  export const BOT_PLAN_STEP_TOOL_NAME = "plan_step";
  export const BOT_PLAN_MAX_MS = 3_600_000;
  export const BOT_PLAN_ENDED_SHOWN_MS = 1_800_000;      // an ended plan stays as a compact line this long
  export const BOT_PLAN_LIMITS = { titleChars: 80, whyChars: 300, steps: 10, stepChars: 200, covers: 8,
    actionChars: 60, toolsPerItem: 5, defaultMax: 10, maxCeiling: 25 } as const;

  /** What the model sends (`covers` entries). */
  export type BotPlanCoverInput =
    | { connector: string; action: string; tools: string[]; max?: number }
    | { site: string; action: "browse"; max?: number }
    | { files: string; action: "read" | "write" }
    | { shell: "bot_home" }
    | { rule: string; max?: number };            // a rule id or its exact label (botRuleLabel)

  /** A validated item, as main stores and enforces it. */
  export type BotPlanItem =
    | { id: string; kind: "connector"; app: string; action: string; tools: { modelName: string; serverId: string; remoteName: string; title: string }[]; max: number }
    | { id: string; kind: "site"; host: string; max: number }
    | { id: string; kind: "files"; path: string; access: "read" | "write"; grant: boolean } // grant: a Plan B Allow once on approval
    | { id: string; kind: "shell" }
    | { id: string; kind: "rule"; ruleId: string; label: string; max: number };

  export type BotPlanStepStatus = "pending" | "done" | "skipped";
  export type BotPlanStatus = "pending" | "active" | "finished" | "stopped" | "expired";
  export interface BotPlanItemView { id: string; line: string; details: string[]; used?: number; max?: number }
  export interface BotPlanView {
    planId: string; botId: string; status: BotPlanStatus; title: string; why: string;
    steps: { text: string; status: BotPlanStepStatus }[]; items: BotPlanItemView[];
    expiresAt?: number; revision: number; from?: string;   // from: the asking Bot's name (a `bot:` turn)
  }
  export function botPlanItemView(item: BotPlanItem, used: number): BotPlanItemView;
  export function botPlanProgress(view: Pick<BotPlanView, "steps">): { done: number; total: number }; // done counts done and skipped
  export const BOT_PLAN_CHANNELS = { respond: "bots:plans:respond" } as const; // invoke({botId, planId, decision}) → { result: "done" | "not_waiting" }
  export type BotPlanDecision = "approve" | "not_now" | "stop";
  export function parseBotPlanResponse(value: unknown): { botId: string; planId: string; decision: BotPlanDecision }; // throws on anything else
  ```
- The exact card lines, which phones mirror:
  - connector: `${app} · ${action} (up to ${max})`
  - site: `${host} · click and type (up to ${max})`
  - files with `grant: false`: `Files · ${access === "write" ? "change" : "read"} ${path}`
  - files with `grant: true`: `Files · use ${path} for this plan`
  - shell: `Commands · in its own folder`
  - rule: `Rule · ${label} (up to ${max})`
- The details: a connector lists each tool's `title`; a site reads `Clicks, typing and key presses on ${host} and its subdomains`; files read `${path}` plus, for a grant, `Allowed once, for this plan only`; a rule reads `Steps your rule “${label}” would ask about`.

- [ ] **Step 1: Write the failing tests** in `renderer/shared/bot-plans.test.ts`:
  - `connector line names the app, the action and its cap`: `botPlanItemView({kind:"connector", app:"Google Calendar", action:"create events", max:5, …}, 0).line === "Google Calendar · create events (up to 5)"`, and its `details` equals the tools' titles.
  - `a folder grant reads as for this plan only`: a `files` item with `grant: true` has line `Files · use ~/Documents/Taxes for this plan` and its details include `Allowed once, for this plan only`.
  - `progress counts done and skipped steps`: steps `[done, skipped, pending]` give `{done: 2, total: 3}`.
  - `parseBotPlanResponse refuses unknown decisions and extra keys`: `{decision: "allow"}` throws, `{…, decision: "approve", extra: 1}` throws, and `{botId: "b", planId: "p", decision: "stop"}` parses.
  - `used and max appear only on counted items`: a `shell` view has neither `used` nor `max`, and a `rule` view with `used = 2` has `used === 2` and `max`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test renderer/shared/bot-plans.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the module. It has no imports beyond types.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Register** it in `test:bot-plans` and the CI lane, then commit: "Add the Bot plan contract".

### Task 2: Validating a proposal against the Bot's current access

**Files:**
- Create: `main/services/bot-plans/validate.ts`, `main/services/bot-plans/ports.ts` (the two ports above)
- Create: `main/services/bot-plans/validate.test.ts`

**Interfaces:**
- Consumes: `BotToolFacts` (`bot-tool-policy.ts`), `describeMcpAction` (`bot-rules/mcp-action.ts`), `botToolApp` (`renderer/shared/bot-activity.ts`), `botRuleLabel` and `BOT_LOCKED_RULES` (`renderer/shared/bot-rules.ts`), `isPaymentHost` (`bot-rules/words.ts`), `COMPUTER_USE_TOOL_NAME`.
- Produces:
  ```ts
  export interface BotPlanProposal { title: string; why: string; steps: string[]; items: BotPlanItem[] }
  export type BotPlanValidation = { ok: true; proposal: BotPlanProposal } | { ok: false; problems: string[] };
  export interface BotPlanValidationContext {
    botId: string;
    facts: BotToolFacts;              // a fresh admission's facts
    rules: readonly BotRule[];        // the Bot's effective rules, read fresh
    access?: BotPlanAccessPort;       // Plan B; absent: outside folders are problems
  }
  export function validateBotPlanProposal(input: unknown, context: BotPlanValidationContext): Promise<BotPlanValidation>;
  ```
- Rules:
  - The shape: `{title, why, steps:[{text}], covers:[…]}` with no extra keys, inside `BOT_PLAN_LIMITS`. Text is trimmed, whitespace is collapsed, and control and direction marks are stripped.
  - An invalid item refuses the whole proposal, and every problem is listed. The person never approves something other than what the Bot asked for.
  - `connector`: every entry of `tools` must be a granted tool in `facts.mcpTools()` whose `effect === "mutating"`. Each tool's `serverId` and `remoteName` come from `describeMcpAction(name, {}, facts)`, and its `title` from the live descriptor's annotation title or else `remoteName`. All tools must share one `serverId`. `app = botToolApp(tools[0])`, falling back to the Bot's `connector` text. A read-only tool gets the problem "`<tool>` doesn't need approval; leave it out."
  - `site`: needs the `browser` capability. `host` is the lower-cased hostname with no scheme, path or port, and it contains a dot. `isPaymentHost(host)` gets "Payments always go to the person."
  - `files`: the path goes unchanged to `access.scopeOf`, which expands `~` (Plan B). "inside" gives `grant: false`, "outside" gives `grant: true`, and "invalid" or no port gives "`<path>` isn't a folder this Bot can use." `whole_mac` or `/` is a problem: "Ask for the whole Mac with request_access on its own." A second outside folder is a problem too: "A plan can open one folder outside this Bot's access."
  - `shell`: needs `facts.authority.shell.enabled`.
  - `rule`: matched by id or case-insensitive exact `botRuleLabel`. Locked rules get "Passwords, codes and money always go to the person." A `hand_off` rule gets "`<label>` hands steps to the person; a plan can't cover it." An unknown rule is a problem too.
  - No item kind can name `computer_use`. A connector entry that names it fails the granted-MCP check ("Computer Use on the person's Mac always asks on its own card.").
  - `max` defaults to `defaultMax`, and a value above `maxCeiling` is a problem. Item ids are `i1`…`i8` in input order.

- [ ] **Step 1: Write the failing tests** in `validate.test.ts`. Build facts the way `bot-tool-assembly.test.ts` builds MCP grants (`testAuthority` with a connection whose tools are mutating and read-only):
  - `a mutating connector tool becomes a connector item with its server identity`: `{connector:"Calendar", action:"create events", tools:["gcal__create_event"], max:5}` gives `items[0]` of kind connector with `serverId` equal to the connection's `sourceId`, `remoteName === "create_event"` and `max === 5`.
  - `read-only and ungranted tools refuse the whole plan`: two bad tools give two problems and `ok === false`.
  - `locked and hand-off rules are never covered`: `{rule:"locked.money"}` and a purchase rule switched to `hand_off` each give a problem. `{rule:"Make a purchase or booking"}` (Ask first) gives a rule item with `ruleId === "default.purchase"`.
  - `Computer Use can't be covered`: `{connector:"Computer Use", action:"click", tools:["computer_use"]}` gives `ok === false`.
  - `an outside folder becomes an access item, and without Plan B it is refused`: with an `access` port answering "outside", the item has `grant: true`. Without the port the plan is refused. Two outside folders refuse the plan.
  - `a site needs the browser and is never a payment host`.
  - `a cap above the ceiling is refused; a missing cap is the default`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-plans/validate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `validateBotPlanProposal`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Register and commit:** "Validate Bot plans against the Bot's access".

### Task 3: Plan store, waits and coverage

**Files:**
- Create: `main/services/bot-plans/coverage.ts`, `main/services/bot-plans/plans.ts`, `main/services/bot-plans/plans-main.ts`
- Create: `main/services/bot-plans/plans.test.ts`

**Interfaces:**
- Consumes: `writeJsonAtomic` (`main/services/durable-fs.ts`), `createKeyedSerial` and `botSessionDirectory` (`bot-routine-notes.ts:40`, `:55`), `BotClassifiableAction` (`bot-rules/classify.ts`).
- Produces:
  ```ts
  // coverage.ts
  export interface BotPlanCoverCheck {
    callId: string;                                  // stable across replays; a nested script call is `<parent>/c<n>`
    toolName: string;
    requestIds: readonly (string | undefined)[];     // the calling run's inputs
    action?: BotClassifiableAction;                  // mcp: serverId + remoteName; browser: url
    baseline: boolean;                               // today's approval (before rules) exists
    ruleId?: string;                                 // the Ask first rule that made or prefixed the approval
  }
  /** Item ids the call would count against, or undefined when the plan doesn't cover it. Pure. */
  export function botPlanCoveredItems(plan: BotPlanRecord, used: ReadonlyMap<string, number>, check: BotPlanCoverCheck, now: number): string[] | undefined;

  // plans.ts
  export interface BotPlanRecord {
    planId: string; botId: string; toolCallId: string; proposal: BotPlanProposal;
    requestIds: string[]; status: Exclude<BotPlanStatus, "pending">;
    steps: BotPlanStepStatus[]; from?: string;
    approvedAt: number; expiresAt: number; endedAt?: number; revision: number;
    counted: Record<string, string[]>;               // callId → item ids it counted, so a replay never counts twice
  }
  export interface BotPlanRequest {
    botId: string; planId: string; toolCallId: string; proposal: BotPlanProposal;
    requestIds: readonly string[]; from?: string; signal: AbortSignal | undefined;
  }
  export type BotPlanStepOutcome = "marked" | "finished" | "no_plan" | "no_step";
  export interface BotPlans {
    /** The stored approval of `planId` at once, or show the card and wait. Rejects when `signal` aborts. */
    request(request: BotPlanRequest): Promise<"approved" | "declined">;
    /** approve and not_now settle a waiting card; stop ends an active plan. */
    respond(botId: string, planId: string, decision: BotPlanDecision): Promise<"done" | "not_waiting">;
    /** Counts the call (idempotent per callId) and returns true when an active, unexpired plan bound to its run covers it. */
    cover(botId: string, check: BotPlanCoverCheck): Promise<boolean>;
    markStep(botId: string, requestIds: readonly (string | undefined)[], step: number, status: "done" | "skipped"): Promise<BotPlanStepOutcome>;
    /** Turn Stop or Dismiss → "stopped"; the Bot went idle → "finished". Ends every active plan of the Bot. */
    endRuns(botId: string, reason: "stopped" | "finished"): Promise<void>;
    /** The waiting card, else the active plan, else one that ended under BOT_PLAN_ENDED_SHOWN_MS ago; else null. */
    current(botId: string): Promise<BotPlanView | null>;
    onChange(listener: (botId: string) => void): () => void;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotPlans(options: { profileDir: string; knownBot(botId: string): Promise<boolean>; now?(): number }): BotPlans;
  ```
- Coverage, in `botPlanCoveredItems`:
  - The plan must be `active`, with `now < expiresAt`, and `check.requestIds` must share at least one id with `plan.requestIds`.
  - `toolName === COMPUTER_USE_TOOL_NAME` is never covered.
  - With `baseline`, one surface item must match:
    - a connector item: `action.surface === "mcp"`, the same `serverId`, and `remoteName` among its tools;
    - a site item: `action.surface === "browser"`, with the URL's hostname equal to `host` or ending in `.${host}`.
  - With `ruleId`, a rule item with that `ruleId` must match as well.
  - Every matched item needs `used < max`. A call already in `counted` returns its recorded ids, whatever the caps say now.
- The store lives in `<profile>/bots/<dir>/plans.json` as `{version: 1, plans: BotPlanRecord[]}`. It keeps the newest 20 plans per Bot and drops ended plans after 24 hours. Writes are serialized per Bot and atomic. Nothing is written for a Bot that `knownBot` doesn't know.
- Only approved plans are stored. A waiting card lives in memory, keyed by `planId`, like `bot-questions.ts`. Approve writes the record before it settles the waiter, so a crash in between still finds the plan. Not now writes nothing.
- A new approval ends every other active plan of the Bot as `finished`. Expiry is evaluated lazily: `current` and `cover` see an expired plan, the next write persists `expired`, and `onChange` fires once.

- [ ] **Step 1: Write the failing tests** in `plans.test.ts`, against a temp profile and a fake `now`:
  - `approving stores the plan and resolves the wait`: `request` stays pending until `respond(…, "approve")`, then resolves `"approved"`, and `current` returns status `active` with `expiresAt === approvedAt + 3_600_000`.
  - `not now resolves declined and stores nothing`: `current` is then null.
  - `an approved plan survives a restart`: a second `createBotPlans` over the same directory gives `request` with the same `planId` resolving `"approved"` without a waiter, and `cover` true for a matching call.
  - `covers a matching connector call and counts it once per call id`: the same `callId` three times counts 1, and a second callId counts 2.
  - `a call past the item's cap is not covered`: with `max: 2`, the third distinct call gives `false` and `current().items[0]` has `used === 2`.
  - `a rule-made ask needs its rule item`: `{baseline: false, ruleId: "default.purchase"}` is false without a rule item and true with one. `{baseline: true, ruleId}` needs both the surface item and the rule item.
  - `a run that shares no request id is not covered`: `requestIds: ["req-2"]` against a plan bound to `["req-1"]` gives false, and a joined run `["req-1", "req-3"]` gives true.
  - `Computer Use is never covered`, even with an item that would otherwise match.
  - `expires after 60 minutes`: at `approvedAt + 3_600_000` cover is false and `current().status === "expired"`.
  - `stop and endRuns end active plans`: after `respond(…, "stop")` cover is false and the status is `stopped`. `endRuns(…, "finished")` gives `finished`.
  - `marking every step finishes the plan`: `markStep` returns `"marked"`, then `"finished"` on the last step. A step out of range gives `"no_step"`, and a run with no plan gives `"no_plan"`.
  - `an unreadable plans file covers nothing`: garbage in `plans.json` makes `cover` false and `current` null.
  - `forgetBot removes the file and refuses later writes`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-plans/plans.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `botPlanCoveredItems`, `createBotPlans` and the singleton `botPlans` in `plans-main.ts` (`profileDir: app.getPath("userData")`, `knownBot` through `botStore.get(id) != null`, like `bot-rules/store-main.ts`).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Register and commit:** "Keep approved Bot plans and check calls against them".

### Task 4: Covered approvals run without a card

**Files:**
- Modify: `main/services/bot-runtime/bot-tool-assembly.ts:115-124` (the port), `:226-301` (`checkPolicy`)
- Test: `main/services/bot-runtime/bot-tool-assembly.test.ts` (extend)

**Interfaces:**
- Consumes: `BotPlans["cover"]`, `BotPlanCoverCheck` (Task 3).
- Produces: `BotToolAssemblyPorts.plans?: Pick<BotPlans, "cover">`. When it is absent, behavior is exactly as today.
- Changes inside `checkPolicy`:
  - Compute `action` (`live.action` or `describeMcpAction`) before any return, and make `asBaseline` a function, so coverage counts only for the decision that is actually returned.
  - `ask(approval, ruleId?)` gives `preapproved: true` when `goAhead`, or when `toolName !== COMPUTER_USE_TOOL_NAME` and `plans.cover(botId, {callId, toolName, requestIds, action, baseline: baseline !== undefined, ruleId})` is true. `cover` errors count as not covered.
  - The rule-ask branch passes `rule.id`. On an unattended turn, a rule-made ask with no baseline goes ahead only when the plan covers it. Otherwise it is still blocked with `ruleAskUnattendedBlock`.
  - Hand-offs, verdict refusals and `RULES_UNREADABLE` are untouched.

- [ ] **Step 1: Write the failing tests** in `bot-tool-assembly.test.ts`. Use the existing MCP fixtures (the end-to-end `describeMcpAction` cases) and a real `createBotPlans` on a temp profile, with a plan approved through `request`/`respond` and bound to the turn's request id:
  - `a mutating connector call inside the plan runs with no approval card`: `deps.approvals` stays empty and the tool runs once.
  - `a call outside the plan still asks`: a second granted mutating tool on the same server, not listed, gives exactly one approval.
  - `past the cap the call asks on its own card`: with `max: 1` and two calls, there is one approval (for the second call) and both run after an allow.
  - `a rule-made ask needs its rule on the card`: give a connector tool the delete class (a `delete_event` tool) with `default.delete` Ask first, and a plan listing only the connector item. That gives one approval whose summary starts with `Rule · Permanently delete something`. Adding `{rule:"default.delete"}` to the plan gives no card.
  - `a hand-off rule and the locked money rule still hand off`: a covered call that a `hand_off` rule matches yields `decision.handoff`.
  - `Computer Use keeps its own card`: through `ruledTurn({toolName: "computer_use"})`, a plan record that would otherwise cover still gives one approval.
  - `a plan never widens access`: after approval, remove the connection from the authority (`assemblyState`). The call is blocked with the access-changed or not-available reason, and the tool never runs.
  - `a script's calls are checked against the plan`: build a codemode turn like `(cm1)` in `bot-extension.test.ts` (`scriptTurn`), over `assemblyDeps` with two granted mutating tools. Calls are inside and outside a plan that lists one. There is one approval, its `toolCallId` is `script-1/c2`, and the covered call ran with no card.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/bot-tool-assembly.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the port and the `checkPolicy` changes.
- [ ] **Step 4: Run** `npx tsx --test main/services/bot-runtime/bot-tool-assembly.test.ts main/services/bot-runtime/bot-extension.test.ts`, then `npm run test:bot-rules`. Expected: PASS, including every existing routines-go-ahead case.
- [ ] **Step 5: Commit:** "Let an approved plan cover a Bot's calls".

### Task 5: The `propose_plan` and `plan_step` tools

**Files:**
- Create: `main/services/bot-runtime/bot-plan-tools.ts`, `main/services/bot-runtime/bot-plan-tools.test.ts`
- Modify: `main/services/bot-runtime/bot-tool-policy.ts` (`botIngressAllowsTool` branch, `botToolVerdict` branch)
- Modify: `main/services/bot-runtime/bot-tool-sources-main.ts:477-505` (push both candidates next to `botQuestionCandidate`, and wire `validate`, `access` and `botTurns`)
- Modify: `main/services/bot-runtime/bot-session-main.ts:239` (pass `plans: botPlans` to `createBotToolAssembly`)
- Test: `main/services/bot-runtime/bot-tool-policy.test.ts` (extend)

**Interfaces:**
- Consumes: `validateBotPlanProposal` (Task 2), `BotPlans` (Task 3), `BotPlanBotTurnPort` and `BotPlanAccessPort` (`ports.ts`), and `BotToolCall.memo` and `runRequestIds` (`tool-adapter.ts:25`).
- Produces:
  ```ts
  export const BOT_PLAN_MEMO = "aiden.plan";
  export interface BotPlanToolDeps {
    plans: Pick<BotPlans, "request" | "markStep">;
    validate(botId: string, input: unknown): Promise<BotPlanValidation>;  // fresh admission + facts + rules + access
    access?: BotPlanAccessPort;
    botTurns?: BotPlanBotTurnPort;
    botName(botId: string): Promise<string | undefined>;
  }
  export function proposePlanCandidate(botId: string, deps: BotPlanToolDeps): BotToolCandidate; // replay "safe", interactive, executionMode "sequential"
  export function planStepCandidate(botId: string, plans: Pick<BotPlans, "markStep">): BotToolCandidate; // replay "safe"; schema { step: integer 1–10, status: "done" | "skipped" }
  ```
- The model-facing description, verbatim:
  > Ask the person to approve a whole task at once instead of one card per step. Use it before a task that will need several approvals. `steps` are plain sentences the person reads, never commands or code. `covers` lists exactly what may run without asking: connected-app actions that change things (`connector`, with the exact tool names), clicks and typing on one site (`site`), folders (`files`), the shell in your folder (`shell`), and Ask first rules by their name (`rule`). Anything not covered still asks on its own card. Passwords, codes, money and Computer Use on the person's Mac are never covered. Wait for the answer. After approval, call plan_step as you finish each step.
- `execute`:
  1. Validate. On failure, throw `This plan can't be shown: ${problems.join(" ")}`.
  2. `planId` = memo `{waitId: randomUUID()}`.
  3. Read `requestIds` from `call.runRequestIds()`, dropping undefined.
  4. If `botTurns.originOf(requestIds)` is set: with no `botTurns` port, throw "Plans can't be shown on this turn." With the port, set `from` to the origin Bot's name and call `announceWaiting(botId, requestIds, title, planId)` once (memo `announced: true`). Race the wait against the returned `deadline` by aborting a derived signal at that time.
  5. On approve, call `access.allowOnce` for each `files` item with `grant: true`, then return text.
- The results, verbatim:
  - approved: `The person approved “${title}”. Covered steps run without asking for the next 60 minutes or until an item's limit is used; anything else still asks. Call plan_step after each step.`
  - declined: `The person said Not now to “${title}”. Don't start it. Ask what they'd like instead.`
  - deadline passed: `Nobody approved “${title}” in time, so it didn't start.`
  - `plan_step`: `Step ${n} marked ${status}.`, `All steps are marked; the plan has ended.`, `No approved plan is running in this turn.`, or `This plan has no step ${n}.`
- Ingress: in `botIngressAllowsTool`, both tools are allowed only when every request id is a person's turn or a `bot:` turn (Plan A's `botTurnOf(...).bot`). They are withheld on `routine:`, `tg:`, intro and `botreply:` inputs. In `botToolVerdict`: `verdict(turn.telegram !== true && turn.routine !== true, "Plans are off for this Bot turn.")`.

- [ ] **Step 1: Write the failing tests:**
  - In `bot-plan-tools.test.ts`, with a fake `BotPlans` and a `BotToolCall` stub with a real memo map:
    - `an invalid plan throws its problems and shows no card`.
    - `approved returns the approval text and grants outside folders once`: `access.allowOnce` is called once with `{path, access: "write", requestIds: ["req-1"]}`.
    - `a re-run propose_plan returns the stored approval without asking`: a second `execute` with the same memo calls `request` with the same `planId`. The fake resolves at once, and no second waiter is created.
    - `declined returns Not now text`.
    - `a bot: turn announces once and gives up at the delivery deadline`: with `originOf` set and `deadline = now + 50`, `announceWaiting` is called once, the result is the deadline text, and the wait's signal aborted.
    - `plan_step maps each outcome to its text`.
  - In `bot-tool-policy.test.ts`: `plan tools follow ingress`. `botIngressAllowsTool("propose_plan", [id])` is true for `undefined` and `"bot:jester:1:d1"`, and false for `"routine:x"`, `"tg:1"`, `"botreply:d1"` and the intro prefix. The same holds for `plan_step`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/bot-plan-tools.test.ts main/services/bot-runtime/bot-tool-policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools, the policy branches and the wiring:
  - `validate` admits with `deps.admit`, reads `sources.facts` and `botRules.rules`, and releases.
  - `access` is wired to Plan B's exports when present.
  - `botTurns` is wired to Plan A's courier when present.
- [ ] **Step 4: Run the tests,** then `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 5: Register and commit:** "Let Bots propose a plan and tick its steps".

### Task 6: Desktop wiring: the live view, Needs you, Stop and IPC

**Files:**
- Modify: `renderer/shared/bot-live.ts:276-306` (`BotLiveSnapshot.plan?: BotPlanView | null`, the event `{ type: "plan"; plan: BotPlanView | null }`, and `applyBotLiveEvent`)
- Modify: `main/services/bot-runtime/live-projection.ts:926`, `:1159`, `:1410-1430`, `:1512` (a `plan?(botId): Promise<BotPlanView | null>` dep, `refreshPlan(botId)`, a `syncPlan` that emits when `planId` or `revision` changes, and `waitingOn` and `needsYouNow` true while `plan.status === "pending"`)
- Modify: `main/services/bot-runtime/bot-attention.ts` (`plans: Pick<BotPlans, "onChange">`)
- Modify: `main/services/bot-runtime/bot-session-service.ts:296` (`onStopped?(botId: string): void`, called by `stop()` after it aborted a running reply and by `dismiss()` after it dismissed an interrupted turn)
- Modify: `main/services/bot-runtime/bot-session-main.ts` (the `plan` dep, `botPlans.onChange` → `refreshPlan`, `onStopped` → `endRuns(id, "stopped")`, `onStateChange` with `state.kind === "idle"` → `endRuns(id, "finished")`, and `(id) => botPlans.forgetBot(id)` in `deleteEffects` before `eraseBotData`)
- Create: `main/handlers/bot-plans.ts`, `main/handlers/bot-plans.test.ts`
- Modify: `main/handlers/bots.ts:218` (register), `renderer/lib/ipc.ts` (`botsApi.respondPlan`)
- Test: `main/services/bot-runtime/live-projection.test.ts`, `main/services/bot-runtime/bot-session-service.test.ts` (extend)

**Interfaces:**
- Consumes: `BotPlans` (Task 3), `BOT_PLAN_CHANNELS`, `parseBotPlanResponse` (Task 1).
- Produces:
  - `botsApi.respondPlan({botId, planId, decision}): Promise<{ result: "done" | "not_waiting" }>`
  - `registerBotPlanHandlers<Event>(deps: { handle(channel, handler): void; plans: Pick<BotPlans, "respond"> }): void`

- [ ] **Step 1: Write the failing tests:**
  - In `live-projection.test.ts`, with a fake `plan` dep:
    - `a plan change pushes a plan event`: a revision bump with the same `planId` emits one `plan` event, and the same revision emits none.
    - `a pending plan makes the Bot need you`: `needsYou(botId) === true` while pending and false once `active`.
  - In `bot-session-service.test.ts`:
    - `stop calls onStopped after aborting a running reply`.
    - `stop on an idle Bot doesn't call it`.
  - In `main/handlers/bot-plans.test.ts` (register-and-invoke with a fake `handle`): `respond forwards a parsed decision` and `a malformed request throws`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-session-service.test.ts main/handlers/bot-plans.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** the same tests, then `npm run test:bot-runtime` and `npm run test:bot-pause`. Expected: PASS.
- [ ] **Step 5: Register and commit:** "Show Bot plans live and end them on Stop".

### Task 7: The plan card on the Mac

**Files:**
- Create: `renderer/components/bots/plan-card.tsx`, `renderer/components/bots/plan-card.test.tsx`
- Modify: `renderer/main/bots/bot-chat-pane.tsx:1503-1520` (render `snapshot.plan` above the approval and hand-off cards; a pending plan holds the composer's Send the way a question does)

**Interfaces:**
- Consumes: `BotPlanView`, `botPlanProgress` (Task 1), `botsApi.respondPlan` (Task 6), `BotNoticeCard` and `BotAvatar` (as `handoff-card.tsx` uses them).
- Produces: `export function PlanCard(props: { plan: BotPlanView; botName: string; avatar: BotAvatarValue; onRespond(decision: BotPlanDecision): Promise<void> }): JSX.Element`.
- The copy:
  - Pending: the eyebrow `${botName} has a plan` (or `${from} asked ${botName} to do this` when `from` is set), the title, `why`, numbered steps, one line per item, and the buttons **Approve plan** (primary), **Not now** and **Show details** (a disclosure that lists each item's `details`).
  - Active: the same card as a checklist, with a check icon for done, a dash icon for skipped and an empty circle for pending (each with an accessible label), `Approved · ends in N min` (minutes left, from `expiresAt`), each counted item's `used of max used`, and **Stop plan**.
  - Ended (finished, stopped or expired): one compact line, `Plan ended · ${done} of ${total} steps`.

- [ ] **Step 1: Write the failing tests** (Testing Library):
  - `a pending plan shows its steps and one line per item`.
  - `Show details reveals the exact actions`: the details text is absent until the button is pressed. The button has `aria-expanded`.
  - `Approve plan and Not now respond once each`: a double click sends one `approve`, and the buttons disable while it is on its way.
  - `an active plan ticks steps and offers Stop plan`.
  - `an ended plan is one line`.
  - `keyboard: Tab reaches Approve plan first and Enter activates it`.
- [ ] **Step 2: Run them and see them fail.** `npx tsx --test renderer/components/bots/plan-card.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the card from the shared Bot notice card, with squircle buttons and tokens only. Extend `bot-chat-pane.test.tsx` with one case, `a pending plan renders above the composer and Approve calls respondPlan`.
- [ ] **Step 4: Run** `npx tsx --test renderer/components/bots/plan-card.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`. Expected: PASS.
- [ ] **Step 5: Register and commit:** "Add the Bot plan card".

### Task 8: Phones: Remote revision, iOS and Android

**Files:**
- Modify: `main/services/aiden-remote-protocol.ts`:
  - `AIDEN_REMOTE_BOT_PLAN_CAPABILITIES = ["bot:plans"]`;
  - `AidenRemoteBotPlan`;
  - the session `plan?` field and `plan` frame;
  - the `plan_expired` code;
  - `AIDEN_REMOTE_BOT_PLANS_CONTRACT_REVISION` (the next after `main`'s at merge), with `AIDEN_REMOTE_CONTRACT_REVISION` pointing at it.
- Modify: `main/services/aiden-remote-bot-session.ts:844-951`, `:1248-1330` (a `readPlan` reader like `readIssues`, sent only to `bot:plans` devices; budget it with `memberBytes`; `respondPlan`)
- Modify: `main/services/aiden-remote-router.ts` (`POST /bots/:botId/plans/:planId/respond`, gated like the `bot:issues` route at `:2021-2032`), `main/services/aiden-remote-service-main.ts` (wire `botPlans`)
- Modify: `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json` (a `botPlans` section)
- Modify (iOS): `ios/AidenOnTheGo/Models/AidenBotSession.swift`, `Networking/AidenRemoteContract.swift`, `Networking/AidenRemoteClient.swift`, `Features/Bots/AidenBotSessionModel.swift`, `Features/Bots/AidenBotSessionChatView.swift` (a plan card next to the issue card)
- Modify (Android): `models/AidenBotSession.kt`, `protocol/AidenRemoteProtocol.kt`, `networking/AidenRemoteClient.kt`, `features/bots/AidenBotSessionController.kt`, `features/bots/AidenBotSessionScreen.kt`, `features/remote/AidenRemoteCoordinator.kt` (negotiation)
- Test: `main/services/aiden-remote-bot-session.test.ts`, `main/services/aiden-remote-protocol.test.ts`, `main/services/aiden-remote-operation-contract.test.ts`, iOS `ios/AidenOnTheGoTests/AidenBotPlanTests.swift`, Android `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotPlanContractTest.kt`

**Interfaces:**
- Produces:
  ```ts
  export interface AidenRemoteBotPlan {
    planId: string;                                       // ^[A-Za-z0-9-]{1,64}$
    status: "pending" | "active" | "finished" | "stopped" | "expired";
    title: string; why: string;                           // ≤ 80, ≤ 300
    steps: { text: string; status: "pending" | "done" | "skipped" }[]; // ≤ 10 × 200
    items: { line: string; details: string[]; used?: number; max?: number }[]; // ≤ 8; line ≤ 120; details ≤ 6 × 160
    expiresAt?: string;                                   // ISO
    from?: string;                                        // ≤ 120
  }
  // POST /bots/{botId}/plans/{planId}/respond  { decision: "approve" | "not_now" | "stop" }
  //   200 { planId, status }   409 plan_expired   needs bot:read, bot:write, bot:plans + Idempotency-Key
  ```
- Devices without `bot:plans` never receive `plan`. The host's existing `needsYou` and summary signals still count a pending plan, so their Inbox shows the Bot as needing them with no client change. Phones negotiate `bot:plans` in a `POST /device/capabilities` call of its own, only when the host lists it in `serverCapabilities`, and treat a 400 or 404 as not offered. The total stays within `AIDEN_REMOTE_MAX_SERVER_FEATURES` (32).

- [ ] **Step 1: Write the failing host tests:**
  - `plan is omitted unless bot:plans is negotiated`.
  - `a pending plan reaches holders in the snapshot and as a plan frame`.
  - `respond approve reaches BotPlans.respond once per Idempotency-Key`.
  - `respond on a settled plan is 409 plan_expired and records nothing for its key`.
  - `an unknown decision is 400`.
- [ ] **Step 2: Implement the host side.** Add the fixture section that both native suites decode.
- [ ] **Step 3: Native.** iOS and Android decode `plan` and render the card with the same copy as Task 7: Approve plan, Not now, Show details, and the checklist with Stop plan. Tests:
  - decode the fixture's pending and active plans;
  - Approve posts `{decision: "approve"}` with one Idempotency-Key reused while the outcome is unknown;
  - a `409 plan_expired` removes the card;
  - a host without `bot:plans` renders nothing.
- [ ] **Step 4: Run** `npx tsx --test main/services/aiden-remote-bot-session.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts`, then the iOS focused tests (`xcodebuild test -only-testing:AidenOnTheGoTests/AidenBotPlanTests`, or the command `ios/README.md` documents), then Android (`./gradlew :app:testDebugUnitTest --tests '*AidenBotPlan*'`). Expected: PASS.
- [ ] **Step 5: Commit:** "Show and approve Bot plans on phones".

### Task 9: Docs, onboarding, memory and the plan index

**Files:**
- Modify: `docs/bot-rules.md` (a section "Approve a plan once", covering what a plan covers and never covers, caps, the 60 minutes, Stop, code mode, and that a plan's one outside folder needs asking again after a quit), `README.md` and `PRODUCT.md` (one line each in the Bots section), `docs/aiden-remote-api-v1.md` (`bot:plans`, the route, the revision), `packages/cli/README.md` (CLI Bots don't offer plans yet)
- Modify: `renderer/components/onboarding-bots-step.tsx` and its test. The Bots line becomes: "Bots hand you the steps only you should do, follow rules you set, and can ask you to approve a whole plan at once."
- Modify: `docs/plans/README.md` (the research row: plan C written or built), `.memory/bot-rules.md` (a "Plan coverage" bullet under Enforcement)
- Create: `.memory/bot-plans.md` (files, constants, the coverage rules, the two cross-plan ports, and the known limits: CLI, paired-Mac viewers, one outside folder per plan, and that folder's in-memory grant not surviving a quit)

- [ ] **Step 1: Search** for claims this plan made stale: `rg -n "approval card|one card per|routines go ahead|preapproved" README.md PRODUCT.md docs/*.md .memory/*.md`. Fix each one.
- [ ] **Step 2: Run** `npx tsx --test renderer/components/onboarding-bots-step.test.tsx`, then `npm run test:bot-plans`, `npm run test:bot-rules`, `npm run test:bot-runtime`, `npm run test:bots` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [ ] **Step 3: Commit:** "Document Bot plan approval".
