# Bot messaging C: plan approval Implementation Plan

> **Execution:** Follow the numbered tasks and the review gates in [the master plan](../../plans/bot-messaging-plan.md#how-it-gets-built). The main session owns implementation and commits. Fresh read-only Opus 5.5 medium and OpenCode Go DeepSeek V4.1 Flash high reviewers check each gate. No additional execution skill is required. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bot can ask the person to approve a whole task once with `propose_plan`. After that, approval-gated calls inside the plan's covered items run without a card, the card becomes a checklist, and everything outside the plan still asks.

**Architecture:**
- A new `main/services/bot-plans/` module validates proposals against the Bot's current access, keeps approved plans durably per Bot, and answers one question at call time: does an active plan bound to this run cover this call, and does it still have calls left?
- `bot-tool-assembly.ts` asks that question where it already turns approvals into `preapproved` for "routines go ahead", so direct calls and codemode's nested calls pass the same check.
- The card is a live waiting card (like questions and hand-offs) on desktop and phones.

**Tech Stack:** TypeScript, Electron main and renderer (React), Pi Durable (pinned, unchanged), `node:test` through `tsx --test`, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/plans/bot-to-bot-messaging-research.md`](../../plans/bot-to-bot-messaging-research.md) §11.1, §12 and §14 step 3. Section numbers (§n) below refer to it. Plan A (`message_bot`, §8) and Plan B (`request_access`, §9) are sibling plans in this program. This plan consumes them only through the two ports in "Cross-plan contracts".

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only: never `readFileSync` production source and `assert.match` against it, and no tautological or change-detector tests.
- Register every new test file twice: in a `package.json` script (new `"test:bot-plans"`, with `"pretest:bot-plans": "npm run build:lease-flock"` like `test:bot-pause`), and in a lane of `scripts/ci-test-registry.json` (the lane that holds `main/services/bot-rules/*.test.ts`). `scripts/ci-test-registry.test.mjs` fails if either is missing. Append to `test:serial`, which the CI registry uses for membership, and resolve conflicts by union.
- A plan never widens access. It can only turn an approval that today's policy would ask for into `preapproved`. Verdicts, hand-offs, locked rules and refusals are unchanged.
- Never covered: the locked rules (`locked.credentials`, `locked.money`), any rule whose behavior is `hand_off`, `computer_use` (the person's Mac keeps its own access card), and any call whose approval has a `rule` that the plan does not list by name.
- A plan lasts for the run that proposed it, plus inputs that actually join that run (steers; queued follow-ups start a new run), and at most `BOT_PLAN_MAX_MS = 3_600_000` (60 minutes) after approval. It ends at Stop, Dismiss, Bot delete, the card's Stop plan, when every step is marked, or when the Bot goes idle.
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
// Import BotAccessAuthorization from Plan B's core bot-access-requests.ts, as a type.
export interface BotPlanAuthorization {
  policyRevision: string; bindingRevision: string; proposalFingerprint: string;
  rules: readonly { id: string; fingerprint: string }[];
  folder?: BotAccessAuthorization;
}
/** Plan A (§8, §11.1). Absent: `bot:` turns can't raise a plan card (the tool says so). */
export interface BotPlanBotTurnPort {
  /** Plan A: `botMessageTurnOf` (renderer/shared/bot-messages.ts) over the run's request ids; the first `{kind: "message"}` gives the asking Bot's id. */
  originOf(requestIds: readonly (string | undefined)[]): { originBotId: string } | undefined;
  /** Plan A: `botMessages().announceWaiting(botId, requestIds, title, planId)`. Returns the delivery deadline (epoch ms) to race the card against, or undefined. Must not throw. */
  announceWaiting(botId: string, requestIds: readonly (string | undefined)[], what: string, waitId: string): Promise<{ deadline: number; expired: boolean } | undefined>;
}
/** Plan B (§9). Absent: a folder outside the Bot's access is a refusal, not an access item. */
export interface BotPlanAccessPort {
  /** "inside": one of the Bot's file locations already holds it; "outside": Plan B can grant it; "invalid": not a folder Plan B accepts. */
  scopeOf(botId: string, path: string, requiredAccess: "read" | "write"): Promise<
    { kind: "inside" | "outside" | "invalid"; authorization?: BotAccessAuthorization }
  >; // an outside result must include its captured authorization snapshot
  /** The same grant Plan B's Allow once makes, bound to these request ids. */
  allowOnce(botId: string, grant: { path: string; access: "read" | "write"; requestIds: readonly string[];
    planId: string; expiresAt: number; authorization: BotAccessAuthorization }): Promise<void>;
  revokePlan(botId: string, planId: string): void; // only the matching plan-owned grant
}
```

Plan B (`docs/superpowers/plans/2026-11-03-bot-messaging-b-request-access.md`) already names the pieces. Wire `scopeOf` as follows:
- `resolveBotAccessTarget(path, deps)`, then `coveredByBotLocations(root, await botFileLocations(admission), requiredAccess)`;
- return `{kind: "inside"}` for a covered folder, `{kind: "outside", authorization}` for a valid outside folder with B's captured policy/path/identity snapshot, and `{kind: "invalid"}` for `whole_mac` or a refusal.

Wire `allowOnce` through B's captured-authorization revalidation, then `botRunAccess.grant` with `access`, `owner: {kind: "plan", id: planId}`, `expiresAt`, pinned identity and the validated policy revision. Wire `revokePlan` to `botRunAccess.revokeOwner`. Apply/revoke operations are serialized against this plan's status transitions, never against a Bot session host.

Plan B keeps one grant per run, in memory. A plan may open at most one outside folder. Its read/write mode is enforced by B's file router for newly granted access; it does not narrow authority the Bot independently already has. The grant ends at the earliest of run end, plan termination, plan expiry, policy change or quit. Replay of stored approval never recreates an ephemeral folder grant; after a quit the Bot must use `request_access` again. Task 9 documents this.

Use A's `botMessageTurnOf` and `isBotMessageRequestId` directly for the distinction between a request, a reply, a person and unattended ingress. A's `botTurnOf().botMessage` remains its combined policy flag; this plan adds no `bot`/`botReply` fields or raw-prefix checks. Malformed ids fail closed. Recover delivery deadlines from host-owned ingress plus A's ledger even after a delivery expires.

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
    | { id: string; kind: "rule"; ruleId: string; ruleFingerprint: string; label: string; max: number };

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
  - files with `grant: true`: `Files · ${access === "write" ? "change" : "read"} ${path} for this plan`
  - shell: `Commands · in its own folder`
  - rule: `Rule · ${label} (up to ${max})`
- The details: a connector lists each tool's `title`; a site reads `Clicks, typing and key presses on ${host} and its subdomains`; files read `${path}` plus, for a grant, `${access === "write" ? "Read and change" : "Read only"} · allowed once, for this plan only`; a rule reads `Steps your rule “${label}” would ask about`.

- [x] **Step 1: Write the failing tests** in `renderer/shared/bot-plans.test.ts`:
  - `connector line names the app, the action and its cap`: `botPlanItemView({kind:"connector", app:"Google Calendar", action:"create events", max:5, …}, 0).line === "Google Calendar · create events (up to 5)"`, and its `details` equals the tools' titles.
  - `a folder grant reads as for this plan only`: a `files` item with `grant: true` has line `Files · change ~/Documents/Taxes for this plan` for a write grant and `Files · read ~/Documents/Taxes for this plan` for read. The corresponding details say `Read and change` or `Read only`, on desktop and both phones.
  - `progress counts done and skipped steps`: steps `[done, skipped, pending]` give `{done: 2, total: 3}`.
  - `parseBotPlanResponse refuses unknown decisions and extra keys`: `{decision: "allow"}` throws, `{…, decision: "approve", extra: 1}` throws, and `{botId: "b", planId: "p", decision: "stop"}` parses.
  - `used and max appear only on counted items`: a `shell` view has neither `used` nor `max`, and a `rule` view with `used = 2` has `used === 2` and `max`.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test renderer/shared/bot-plans.test.ts`. Expected: FAIL, module not found.
- [x] **Step 3: Implement** the module. It has no imports beyond types.
- [x] **Step 4: Run the tests.** Same command. Expected: PASS.
- [x] **Step 5: Register** it in `test:bot-plans` and the CI lane, then commit: "Add the Bot plan contract".

### Task 2: Validating a proposal against the Bot's current access

**Files:**
- Create: `main/services/bot-plans/validate.ts`, `main/services/bot-plans/ports.ts` (the two ports above)
- Create: `main/services/bot-plans/validate.test.ts`

**Interfaces:**
- Consumes: `BotToolFacts` (`bot-tool-policy.ts`), `describeMcpAction` (`bot-rules/mcp-action.ts`), `botToolApp` (`renderer/shared/bot-activity.ts`), `botRuleLabel` and `BOT_LOCKED_RULES` (`renderer/shared/bot-rules.ts`), `isPaymentHost` (`bot-rules/words.ts`), `COMPUTER_USE_TOOL_NAME`.
- Produces:
  ```ts
  export interface BotPlanProposal { title: string; why: string; steps: string[]; items: BotPlanItem[]; authorization: BotPlanAuthorization }
  // Main-only snapshot: policy/binding revision, canonical item identities, rule fingerprints,
  // and B's folder authorization when applicable. Not model-supplied or projected to phones.
  export type BotPlanValidation = { ok: true; proposal: BotPlanProposal } | { ok: false; problems: string[] };
  export interface BotPlanValidationContext {
    botId: string;
    facts: BotToolFacts;              // a fresh admission's facts
    policyRevision: string; bindingRevision: string; // same admission's authorization identity
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
  - `files`: the path and requested read/write mode go to `access.scopeOf`, which expands `~` (Plan B) and requires sufficient current access. A `kind: "inside"` result gives `grant: false`, `kind: "outside"` gives `grant: true` and preserves its authorization snapshot, and `kind: "invalid"` or no port gives "`<path>` isn't a folder this Bot can use." `whole_mac` or `/` is a problem: "Ask for the whole Mac with request_access on its own." A second outside folder is a problem too: "A plan can open one folder outside this Bot's access."
  - `shell`: needs `facts.authority.shell.enabled`.
  - `rule`: matched by id or case-insensitive exact `botRuleLabel`. Capture a fingerprint of its id, behavior and exact normalized definition; an edited custom rule is not covered just because its id is unchanged. Locked rules get "Passwords, codes and money always go to the person." A `hand_off` rule gets "`<label>` hands steps to the person; a plan can't cover it." An unknown rule is a problem too.
  - No item kind can name `computer_use`. A connector entry that names it fails the granted-MCP check ("Computer Use on the person's Mac always asks on its own card.").
  - Revalidate the captured proposal at the person's approve action. A changed policy, tool binding, folder identity or named rule refuses the stale answer with no approved record or folder grant. Do not silently substitute changed items into the card.
  - `max` defaults to `defaultMax`, and a value above `maxCeiling` is a problem. Item ids are `i1`…`i8` in input order.

- [x] **Step 1: Write the failing tests** in `validate.test.ts`. Build facts the way `bot-tool-assembly.test.ts` builds MCP grants (`testAuthority` with a connection whose tools are mutating and read-only):
  - `a mutating connector tool becomes a connector item with its server identity`: `{connector:"Calendar", action:"create events", tools:["gcal__create_event"], max:5}` gives `items[0]` of kind connector with `serverId` equal to the connection's `sourceId`, `remoteName === "create_event"` and `max === 5`.
  - `read-only and ungranted tools refuse the whole plan`: two bad tools give two problems and `ok === false`.
  - `locked and hand-off rules are never covered`: `{rule:"locked.money"}` and a purchase rule switched to `hand_off` each give a problem. `{rule:"Make a purchase or booking"}` (Ask first) gives a rule item with `ruleId === "default.purchase"`.
  - `Computer Use can't be covered`: `{connector:"Computer Use", action:"click", tools:["computer_use"]}` gives `ok === false`.
  - `an outside folder becomes an access item, and without Plan B it is refused`: with an `access` port returning `{kind: "outside", authorization}`, the item has `grant: true`. Without the port the plan is refused. Two outside folders refuse the plan.
  - `a site needs the browser and is never a payment host`.
  - `a cap above the ceiling is refused; a missing cap is the default`.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-plans/validate.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement `validateBotPlanProposal`.**
- [x] **Step 4: Run the tests.** Expected: PASS.
- [x] **Step 5: Register and commit:** "Validate Bot plans against the Bot's access".

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
    executionId: string;                             // host-owned durable ToolTask identity, never the provider call id
    operationFingerprint: string;                    // canonical tool/arguments/target identity bound to this reservation
    toolName: string;
    requestIds: readonly (string | undefined)[];     // the calling run's inputs
    action?: BotClassifiableAction;                  // mcp: serverId + remoteName; browser: url
    baseline: boolean;                               // today's approval (before rules) exists
    rules: readonly { id: string; fingerprint: string }[]; // every currently matching Ask first rule
  }
  /** Item ids the call would count against, or undefined when the plan doesn't cover it. Pure. */
  export function botPlanCoveredItems(plan: BotPlanRecord, used: ReadonlyMap<string, number>, check: BotPlanCoverCheck, now: number): string[] | undefined;

  // plans.ts
  export interface BotPlanRecord {
    planId: string; botId: string; toolCallId: string; proposal: BotPlanProposal;
    requestIds: string[]; status: Exclude<BotPlanStatus, "pending">;
    steps: BotPlanStepStatus[]; from?: string;
    approvedAt: number; expiresAt: number; deadline?: number; endedAt?: number; revision: number;
    counted: Record<string, { operationFingerprint: string; itemIds: string[]; admittedAt?: number }>; // executionId → reservation/admission
  }
  export interface BotPlanRequest {
    botId: string; planId: string; toolCallId: string; proposal: BotPlanProposal;
    requestIds: readonly string[]; from?: string; deadline?: number; signal: AbortSignal | undefined;
  }
  export type BotPlanStepOutcome = "marked" | "finished" | "no_plan" | "no_step" | "already_done" | "already_skipped";
  export interface BotPlanPermit {
    planId: string; botId: string; executionId: string; operationFingerprint: string;
  }
  export interface BotPlans {
    /** A fresh approval, stored active approval replay, declined wait, or an already-ended plan. */
    request(request: BotPlanRequest): Promise<
      { status: "approved"; fresh: boolean; expiresAt: number } | { status: "declined" | "ended" }
    >;
    /** Installs fresh ephemeral access only for the original live approval, serialized with termination. */
    grantFreshAccess(botId: string, planId: string, apply: () => Promise<void>): Promise<boolean>;
    /** approve and not_now settle a waiting card; stop ends an active plan. */
    respond(botId: string, planId: string, decision: BotPlanDecision): Promise<"done" | "not_waiting">;
    /** Reserves caps atomically and returns an opaque host-only permit; current authority is still required at execution admission. */
    cover(botId: string, check: BotPlanCoverCheck): Promise<BotPlanPermit | undefined>;
    /** Final admission after fresh authority/page checks. The plan serial invokes start before releasing. */
    admit<T>(permit: BotPlanPermit, start: () => Promise<T>): Promise<
      { admitted: false } | { admitted: true; started: Promise<T> }
    >;
    markStep(botId: string, requestIds: readonly (string | undefined)[], step: number, status: "done" | "skipped"): Promise<BotPlanStepOutcome>;
    /** Turn Stop or Dismiss → "stopped"; the Bot went idle → "finished". Ends every active plan of the Bot. */
    endRuns(botId: string, reason: "stopped" | "finished"): Promise<void>;
    /** The waiting card, else the active plan, else one that ended under BOT_PLAN_ENDED_SHOWN_MS ago; else null. */
    current(botId: string, planId?: string): Promise<BotPlanView | null>; // omitted: visible card; supplied: exact retained plan
    onChange(listener: (botId: string) => void): () => void;
    forgetBot(botId: string): Promise<void>;
  }
  export function createBotPlans(options: { profileDir: string; knownBot(botId: string): Promise<boolean>; now?(): number;
    revalidate(botId: string, proposal: BotPlanProposal): Promise<void>; revokeAccess(botId: string, planId: string): void;
  }): BotPlans;
  ```
- Coverage, in `botPlanCoveredItems`:
  - The plan must be `active`, with `now < expiresAt`, and `check.requestIds` must share at least one id with `plan.requestIds`.
  - `toolName === COMPUTER_USE_TOOL_NAME` is never covered.
  - With `baseline`, one surface item must match:
    - a connector item: `action.surface === "mcp"`, the same `serverId`, and `remoteName` among its tools;
    - a site item: `action.surface === "browser"`, with the URL's hostname equal to `host` or ending in `.${host}`.
  - Every current matching Ask first rule needs its own rule item with the same id and definition fingerprint. The winning display rule alone is insufficient when several rules match. Extend the rule decision helper to expose matching rules without changing which rule wins display precedence. Locked/hand-off rules still return before coverage.
  - Every matched counted item needs `used < max`. Check and reserve all matched caps in one per-Bot transaction. A replay of the same `executionId` and `operationFingerprint` reuses its reservation only while the same plan remains active, live and authorized. A distinct task that reuses a provider call id consumes a new slot. Different arguments/actions cannot reuse an existing reservation. File/shell declarations do not introduce new per-call approval where none existed; only connector/site/rule approval items consume these caps.
- The store lives in `<profile>/bots/<dir>/plans.json` as `{version: 1, plans: BotPlanRecord[], receipts: [...]}`. It keeps the newest 20 full plan records per Bot and drops ended display history after 24 hours. Compact immutable receipts retain proposal identity and ended/expired status while the originating durable task can replay; pruning display history cannot make a previously ended plan show a new approval card. Writes are serialized per Bot and atomic. Nothing is written for a Bot that `knownBot` doesn't know.
- Only approved plans are stored. A waiting card lives in memory, keyed by `planId`, like `bot-questions.ts`. Approve revalidates the immutable authorization snapshot, then writes the record before settling the waiter. Only that original live waiter receives `fresh: true`; looking up a saved approval always gives `fresh: false`. A stored ended/expired plan returns `ended`, never a new card or active authority. Not now writes nothing. Request replay verifies the stored proposal identity and never replaces it with changed arguments.
- `grantFreshAccess` consumes a process-local, one-use fresh-approval entitlement. Under the plan serial it checks active status, deadline and original live entitlement before the bounded grant callback. This callback performs no session operation. It cannot run for a stored replay or after Stop. Every termination path calls `revokeAccess(botId, planId)` before acknowledging the transition: Stop plan, Stop/Dismiss, all steps marked, replacement, idle, expiry and delete. The callback only revokes that plan's grant. A quit drops all ephemeral grants and fresh entitlements automatically.
- A new approval ends every other active plan of the Bot as `finished`, revoking its owned access first. `current` and `cover` check expiry and revoke an expired owner before returning; lazy history persistence must not delay permission revocation. The file location resolver also checks the saved `expiresAt` independently. `onChange` fires once.

- [x] **Step 1: Write the failing tests** in `plans.test.ts`, against a temp profile and a fake `now`:
  - `approving stores the plan and resolves the wait`: `request` stays pending until `respond(…, "approve")`, then resolves `{status: "approved", fresh: true, expiresAt}`, and `current` returns status `active` with `expiresAt === approvedAt + 3_600_000`.
  - `not now resolves {status: "declined"} and stores nothing`: `current` is then null.
  - `an approved plan survives a restart`: a second `createBotPlans` over the same directory gives `request` with the same `planId` resolving `{status: "approved", fresh: false, expiresAt}` without a waiter, and `cover` returning a permit for a matching independently authorized call. `grantFreshAccess` returns false and creates no folder grant.
  - `covers a matching connector operation and reserves once per durable task`: replaying one executionId counts 1; two distinct tasks with the same provider call id count 2. Reusing a reservation for changed arguments or a changed target fails.
  - `a call past the item's cap is not covered`: with `max: 2`, the third distinct call gives `undefined` and `current().items[0]` has `used === 2`.
  - `a rule-made ask needs its rule item`: `{baseline: false, rules: [purchaseRef]}` returns undefined without a rule item and a permit with one. `{baseline: true, rules: [purchaseRef]}` needs both the surface item and the rule item. Two matching asks require both named rules; editing a named custom rule invalidates its fingerprint.
  - `a run that shares no request id is not covered`: `requestIds: ["req-2"]` against a plan bound to `["req-1"]` returns undefined, and a joined run `["req-1", "req-3"]` returns a permit.
  - `Computer Use is never covered`, even with an item that would otherwise match.
  - `expires after 60 minutes`: at `approvedAt + 3_600_000` cover returns undefined and `current().status === "expired"`.
  - `stop and endRuns end active plans`: after `respond(…, "stop")` cover returns undefined and the status is `stopped`. `endRuns(…, "finished")` gives `finished`.
  - `marking every step finishes the plan`: `markStep` returns `"marked"`, then `"finished"` on the last step. A step out of range gives `"no_step"`, and a run with no plan gives `"no_plan"`.
  - `an unreadable plans file covers nothing`: garbage in `plans.json` makes `cover` return undefined and `current` return null.
  - `forgetBot removes the file and refuses later writes`.
  - Concurrent calls at the last cap admit one reservation, and plan+allow-list matches consume only the plan reservation.
  - Fresh-approval crash before tool-result commit returns replayed approval without restoring the outside folder. Stop, all-steps-done, replacement, expiry and run end each revoke only their own folder grant; a subsequent operation in the still-running Bot fails.
  - A joined steer stays covered; a queued follow-up and a later run are not covered, verified with the real harness.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-plans/plans.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** `botPlanCoveredItems`, `createBotPlans` and the singleton `botPlans` in `plans-main.ts` (`profileDir: app.getPath("userData")`, `knownBot` through `botStore.get(id) != null`, like `bot-rules/store-main.ts`).
- [x] **Step 4: Run the tests.** Expected: PASS.
- [x] **Step 5: Register and commit:** "Keep approved Bot plans and check calls against them".

### Task 4: Covered approvals run without a card

**Files:**
- Modify: `main/services/bot-runtime/bot-tool-assembly.ts:115-124` (the port), `:226-301` (`checkPolicy`), `bot-extension.ts` (`beforeTool` durable identity), `tool-adapter.ts` (final execution admission) and `main/services/bot-rules/decide.ts` (matching rule references)
- Test: `main/services/bot-runtime/bot-tool-assembly.test.ts`, `bot-extension.test.ts` and `main/services/bot-rules/decide.test.ts` (extend)

**Interfaces:**
- Consumes: `BotPlans["cover"]`, `BotPlanCoverCheck` (Task 3).
- Produces: `BotToolAssemblyPorts.plans?: Pick<BotPlans, "cover" | "admit">`, and a host-only `planPermit?: BotPlanPermit` on the approval requirement/execution context, never on model arguments or Remote DTOs. When it is absent, behavior is exactly as today.
- Changes inside `checkPolicy`, its caller and the execution adapter:
  - In the real durable `beforeTool`, memoize a host UUID under `aiden.execution.id` before policy checks; pass it as `executionId` in `BotToolCallCheck`. Each nested codemode ToolTask gets its own stable identity. Keep provider `callId` for UI/correlation only. Build `operationFingerprint` from the canonical tool, arguments and classified target; never send it to analytics.
  - Apply this single sequence: fresh authority/ingress/deadline verdict; fresh classification and all matching rules; locked/hand-off/refusal decisions; existing eligible routine go-ahead; plan coverage once; eligible allow-list match in D; ordinary card or existing unattended block.
  - Coverage receives `{executionId, operationFingerprint, toolName, requestIds, action, baseline: baseline !== undefined, rules: matchingAskRuleRefs}`. A permit result returns `preapproved: true` plus that permit while preserving the original `onAllow`, including browser page binding. Coverage errors mean not covered. Do not compute a side-effecting baseline/coverage result speculatively or twice.
  - Rule-made asks pass all current matching Ask first rule references and require every one on the card. An unattended rule-made ask without baseline is permitted only by existing routine go-ahead or valid explicit plan coverage; otherwise retain the existing block. D's allow list never covers a rule-made ask.
  - Existing verdict refusals, `RULES_UNREADABLE`, locked rules and hand-offs remain fail closed. A stop/expiry between policy and an effect is rechecked through the plan permit as well as A's host-owned ingress and the fresh grant resolver.
  - After all awaited `onAllow`/page-binding and fresh authority checks, the tool adapter submits the permit to `plans.admit`. Under the same per-Bot plan serial used by Stop/finish/expiry, verify plan status/deadline, execution identity and operation fingerprint, consume admission, and synchronously invoke the actual tool execution callback. Return its promise inside `{admitted: true, started}` without awaiting external I/O under that serial. This invocation is the execution-admission boundary; persist its admission identity before starting, without converting an unsafe tool into a replay-safe one. The durable runtime's existing safe/unsafe replay rules still govern uncertain external effects. Stop before admission invalidates the permit; re-evaluate ordinary policy to ask/block, without another speculative plan reservation. Stop after admission revokes future admissions but cannot undo an already-started external action.
  - The adapter applies this boundary to direct and nested codemode calls. Add a barrier test after coverage and after `onAllow` but before execution: Stop plan wins, no connector side effect starts, and an ordinary card or block replaces the stale permit. Another test admits first, then Stop, and permits only that already-started action to finish.

- [x] **Step 1: Write the failing tests** in `bot-tool-assembly.test.ts`. Use the existing MCP fixtures (the end-to-end `describeMcpAction` cases) and a real `createBotPlans` on a temp profile, with a plan approved through `request`/`respond` and bound to the turn's request id:
  - `a mutating connector call inside the plan runs with no approval card`: `deps.approvals` stays empty and the tool runs once.
  - `a call outside the plan still asks`: a second granted mutating tool on the same server, not listed, gives exactly one approval.
  - `past the cap the call asks on its own card`: with `max: 1` and two calls, there is one approval (for the second call) and both run after an allow.
  - `a rule-made ask needs its rule on the card`: give a connector tool the delete class (a `delete_event` tool) with `default.delete` Ask first, and a plan listing only the connector item. That gives one approval whose summary starts with `Rule · Permanently delete something`. Adding `{rule:"default.delete"}` to the plan gives no card.
  - `a hand-off rule and the locked money rule still hand off`: a covered call that a `hand_off` rule matches yields `decision.handoff`.
  - `Computer Use keeps its own card`: through `ruledTurn({toolName: "computer_use"})`, a plan record that would otherwise cover still gives one approval.
  - `Stop between coverage and execution invalidates the permit`: a real adapter barrier keeps the connector untouched until admission. Stop first yields a card/block; admission first permits that one action and prevents the next.
  - `a plan never widens access`: after approval, remove the connection from the authority (`assemblyState`). The call is blocked with the access-changed or not-available reason, and the tool never runs.
  - `a script's calls are checked against the plan`: build a codemode turn like `(cm1)` in `bot-extension.test.ts` (`scriptTurn`), over `assemblyDeps` with two granted mutating tools. Calls are inside and outside a plan that lists one. There is one approval, its `toolCallId` is `script-1/c2`, and the covered call ran with no card.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/bot-tool-assembly.test.ts`. Expected: the new tests FAIL.
- [x] **Step 3: Implement** the port and the `checkPolicy` changes.
- [x] **Step 4: Run** `npx tsx --test main/services/bot-runtime/bot-tool-assembly.test.ts main/services/bot-runtime/bot-extension.test.ts`, then `npm run test:bot-rules`. Expected: PASS, including every existing routines-go-ahead case.
- [x] **Step 5: Commit:** "Let an approved plan cover a Bot's calls".

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
    plans: Pick<BotPlans, "request" | "markStep" | "grantFreshAccess" | "respond" | "current">;
    validate(botId: string, input: unknown, call?: BotToolCall): Promise<BotPlanValidation>;  // fresh admission + facts + rules + access
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
  1. Read the memoized plan id and current host-owned ingress. Use A's strict helper to distinguish a request from a reply/unattended input. A message run without A's port is refused before showing a card.
  2. Validate against fresh authority and retain the immutable main-only authorization snapshot. A stored proposal replay must match its saved identity; do not replace it by revalidation against changed inputs.
  3. For a Bot-started run, read `announceWaiting` on EVERY execution, even when its notification was previously announced. Its returned deadline is durable, not a memoized timeout. `expired: true`, an elapsed deadline or missing authoritative Bot delivery returns the deadline/unavailable result with no waiter. Undefined is allowed only for a genuine person run. Deduplicate the notification separately.
  4. Race the card against the earliest delivery deadline and caller abort signal. `respond(approve)` revalidates the exact captured authorization before storing approval. On decline return the Not now text. On stored ended/expired approval return "This plan has ended. Ask again for a new task." without renewing it.
  5. On `{status: "approved", fresh: true}`, use `plans.grantFreshAccess` to apply the single outside-folder grant through `access.allowOnce`, including `planId`, read/write mode, original authorization, run ids and the earliest plan/delivery expiry. Serialize this installation with plan termination. For `fresh: false`, do not install any ephemeral grant; if it is missing, explain that `request_access` is needed again. If fresh grant revalidation fails, stop this plan and return an actionable access error, without widening authority.
  6. Return the approval result only while the plan is active. Existing independent access and covered connector calls can survive restart within the original run and deadline; ephemeral outside-folder access cannot.

- The results, verbatim:
  - approved: `The person approved “${title}”. Covered steps run without asking for the next 60 minutes or until an item's limit is used; anything else still asks. Call plan_step after each step.`
  - declined: `The person said Not now to “${title}”. Don't start it. Ask what they'd like instead.`
  - deadline passed: `Nobody approved “${title}” in time, so it didn't start.`
  - `plan_step`: `Step ${n} marked ${status}.`, `Step ${n} was already marked done.`, `Step ${n} was already marked skipped.`, `All steps are marked; the plan has ended.`, `No approved plan is running in this turn.`, or `This plan has no step ${n}.`
- Ingress: in `botIngressAllowsTool`, both tools are allowed only when every `botMessageTurnOf(requestId).kind` is `person` or `message`, with A's host provenance/deadline checks also passing. They are withheld on `routine:`, `tg:`, intro and `botreply:` inputs. In `botToolVerdict`: `verdict(turn.telegram !== true && turn.routine !== true, "Plans are off for this Bot turn.")`.

- [x] **Step 1: Write the failing tests:**
  - In `bot-plan-tools.test.ts`, with a fake `BotPlans` and a `BotToolCall` stub with a real memo map:
    - `an invalid plan throws its problems and shows no card`.
    - `approved returns the approval text and grants outside folders once`: the real B router receives a fresh, plan-owned pinned write grant. Repeat with read: read succeeds and write/edit fail, including codemode calls.
    - `a re-run propose_plan returns the stored approval without asking`: a second `execute` with the same memo calls `request` with the same `planId`. The real store returns `fresh: false`, no second waiter is created, and no ephemeral access is recreated.
    - `declined returns Not now text`.
    - `a bot: turn announces once and gives up at the delivery deadline`: with `originOf` set and `deadline = now + 50`, the notice is published once, the wait expires at that deadline, and replay re-reads the same durable deadline without publishing a duplicate or creating an unlimited wait.
    - `plan_step maps each outcome to its text`.
  - In `bot-tool-policy.test.ts`: `plan tools follow ingress`. `botIngressAllowsTool("propose_plan", [id])` is true for `undefined` and `botMessageRequestId("jester", 1, validUuid)`, and false for `"routine:x"`, `"tg:1"`, `botReplyRequestId(validUuid)`, the intro prefix and malformed `"bot:jester:1:d1"`. The same holds for `plan_step`.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/bot-plan-tools.test.ts main/services/bot-runtime/bot-tool-policy.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** the tools, the policy branches and the wiring:
  - `validate` admits with `deps.admit`, reads `sources.facts`, that admission's policy/binding revisions, B's scoped authorization and `botRules.rules`, then releases. The approval-time validator rechecks the same captured identities.
  - `access` is wired to Plan B's exports when present.
  - `botTurns` is wired to Plan A's courier when present.
- [x] **Step 4: Run the tests,** then `npm run test:bot-runtime`. Expected: PASS.
- [x] **Step 5: Register and commit:** "Let Bots propose a plan and tick its steps".

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

- [x] **Step 1: Write the failing tests:**
  - In `live-projection.test.ts`, with a fake `plan` dep:
    - `a plan change pushes a plan event`: a revision bump with the same `planId` emits one `plan` event, and the same revision emits none.
    - `a pending plan makes the Bot need you`: `needsYou(botId) === true` while pending and false once `active`.
  - In `bot-session-service.test.ts`:
    - `stop calls onStopped after aborting a running reply`.
    - `stop on an idle Bot doesn't call it`.
  - In `main/handlers/bot-plans.test.ts` (register-and-invoke with a fake `handle`): `respond forwards a parsed decision` and `a malformed request throws`.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-session-service.test.ts main/handlers/bot-plans.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** the wiring.
- [x] **Step 4: Run** the same tests, then `npm run test:bot-runtime` and `npm run test:bot-pause`. Expected: PASS.
- [x] **Step 5: Register and commit:** "Show Bot plans live and end them on Stop".

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

- [x] **Step 1: Write the failing tests** (Testing Library):
  - `a pending plan shows its steps and one line per item`.
  - `Show details reveals the exact actions`: the details text is absent until the button is pressed. The button has `aria-expanded`.
  - `Approve plan and Not now respond once each`: a double click sends one `approve`, and the buttons disable while it is on its way.
  - `an active plan ticks steps and offers Stop plan`.
  - `an ended plan is one line`.
  - `keyboard: Tab reaches Approve plan first and Enter activates it`.
- [x] **Step 2: Run them and see them fail.** `npx tsx --test renderer/components/bots/plan-card.test.tsx`. Expected: FAIL.
- [x] **Step 3: Implement** the card from the shared Bot notice card, with squircle buttons and tokens only. Extend `bot-chat-pane.test.tsx` with one case, `a pending plan renders above the composer and Approve calls respondPlan`.
- [x] **Step 4: Run** `npx tsx --test renderer/components/bots/plan-card.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`. Expected: PASS.
- [x] **Step 5: Register and commit:** "Add the Bot plan card".

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

- [x] **Step 1: Write the failing host tests:**
  - `plan is omitted unless bot:plans is negotiated`.
  - `a pending plan reaches holders in the snapshot and as a plan frame`.
  - `respond approve reaches BotPlans.respond once per Idempotency-Key`.
  - `respond on a settled plan is 409 plan_expired and records nothing for its key`.
  - `an unknown decision is 400`.
- [x] **Step 2: Implement the host side.** Add the fixture section that both native suites decode.
- [x] **Step 3: Native.** iOS and Android decode `plan` and render the card with the same copy as Task 7: Approve plan, Not now, Show details, and the checklist with Stop plan. Tests:
  - decode the fixture's pending and active plans;
  - Approve posts `{decision: "approve"}` with one Idempotency-Key reused while the outcome is unknown;
  - a `409 plan_expired` removes the card;
  - a host without `bot:plans` renders nothing.
- [x] **Step 4: Run** `npx tsx --test main/services/aiden-remote-bot-session.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts`, then the iOS focused tests (`xcodebuild test -only-testing:AidenOnTheGoTests/AidenBotPlanTests`, or the command `ios/README.md` documents), then Android (`./gradlew :app:testDebugUnitTest --tests '*AidenBotPlan*'`). Expected: PASS.
- [x] **Step 5: Commit:** "Show and approve Bot plans on phones".

### Task 9: Docs, onboarding, memory and the plan index

**Files:**
- Modify: `docs/bot-rules.md` (a section "Approve a plan once", covering what a plan covers and never covers, caps, the 60 minutes, Stop, code mode, and that a plan's one outside folder needs asking again after a quit), `README.md` and `PRODUCT.md` (one line each in the Bots section), `docs/aiden-remote-api-v1.md` (`bot:plans`, the route, the revision), `packages/cli/README.md` (CLI Bots don't offer plans yet)
- Modify: `renderer/components/onboarding-bots-step.tsx` and its test. The Bots line becomes: "Bots hand you the steps only you should do, follow rules you set, and can ask you to approve a whole plan at once."
- Modify: `docs/plans/README.md` (the research row: plan C written or built), `.memory/bot-rules.md` (a "Plan coverage" bullet under Enforcement)
- Create: `.memory/bot-plans.md` (files, constants, the coverage rules, the two cross-plan ports, and the known limits: CLI, paired-Mac viewers, one outside folder per plan, and that folder's in-memory grant not surviving a quit)

- [x] **Step 1: Search** for claims this plan made stale: `rg -n "approval card|one card per|routines go ahead|preapproved" README.md PRODUCT.md docs/*.md .memory/*.md`. Fix each one.
- [x] **Step 2: Run** `npx tsx --test renderer/components/onboarding-bots-step.test.tsx`, then `npm run test:bot-plans`, `npm run test:bot-rules`, `npm run test:bot-runtime`, `npm run test:bots` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [x] **Step 3: Commit:** "Document Bot plan approval".


## C enforcement progress, 2026-11-04

C starts from B acceptance status commit `1f108d931` on `feature/bot-plan-approval`. Both Gate 3 reviewers accepted B source at `494d6b39f`. Tasks 1–2 are implemented and registered. Worker missing-module red runs are recorded at `/tmp/bot-plans-core-task1-red.log` and `/tmp/bot-plans-core-task2-red.log`. Parent contract/validation checks passed 12 tests and the registry passed 15 checks. Task 3 is in progress. Tasks 4–9 and C review gates remain pending.

The production approval-time option takes `revalidate(botId, proposal)` so the singleton can re-admit the correct Bot. Rule and proposal fingerprints have shared main-only helpers in validate.ts. Compact ended receipts retain only hash identity, necessary IDs, status and deadline until an authoritative durable-task-settlement collection port exists. Full private proposals remain in bounded display history. An admission persisted without its live started promise cannot authorize another callback after restart. These are enforcement contracts awaiting Gate 4 review, not phase acceptance.


Tasks 1–3 complete locally. Parent reran `npm run test:bot-plans` with 49 passes and the registry with 15 passes. Worker whole type-check and scoped lint passed; parent singleton lint and whitespace checks passed. Meaningful audit reds cover time crossing publication, deletion while awaiting admission, equal-time retention, lost stores and queued Stop/endRuns during the final admission await. Stop, step and replacement intents fence invocation while their durable transitions remain serialized. Coverage and admission both revalidate the captured proposal. Final callback invocation has no intervening await after deadline/deletion/termination checks. The production singleton is lazy, holds no static tool-source/session imports, and fails closed until desktop authority ports are configured.

Core handoff: `/tmp/aiden-bot-plan-c-core-handoff.md`. Final evidence: `/tmp/bot-plans-core-final-suite.log`, `/tmp/bot-plans-core-final-typecheck.log`, `/tmp/bot-plans-core-final-lint.log`; parent `/tmp/bot-plan-c-core-parent-suite.log` and `/tmp/bot-plan-c-core-parent-registry.log`. Task 4 runtime enforcement and Task 5 tool wiring are next. Gate 4 remains pending.


Pre-Gate-4 integration correction: the new shared/store identifier guards initially rejected production `bot:<uuid>` identities. Two behavioral red failures, including `newBotId()` from the real application service, are captured at `/tmp/bot-plans-production-id-red.log`. Both guards now reuse the existing shared path-safe identifier grammar and Bot length bound. Approval, restart replay, cap accounting and unsafe-ID checks pass, bringing the plan suite to 51. Scoped lint and whitespace checks pass. A contemporaneous whole type-check found two errors in Task4's active extension edits; no full integration green is claimed until those are resolved.


Task 4 complete locally. Covered approvals now carry invocation-local permits to the actual callback inside the fresh authority fence. Direct and nested durable calls have host execution UUIDs and canonical operation/target identities. All matching Ask-first rules are required without changing display precedence. A stale permit rechecks ordinary policy with coverage disabled, preserves page binding, releases its admission while waiting and reacquires authority before execution.

Raw request IDs remain the ingress authority. Separate host input identities use durable UUID bookkeeping for unlabeled inputs, survive restart and are not reused by a recovered database. The entries remain hidden from transcript and memory projection. Three existing memory fixtures were completed with real host metadata; their assertions were preserved.

Worker runtime 391, focused/memory 153, browser 36, rules 62, registry 15, types, scoped lint and whitespace checks passed. Parent reran the 153 focused/memory tests successfully at `/tmp/bot-plan-c-task4-parent-focused.log`. Meaningful reds covered missing coverage, restored onAllow invalidation, new rule drift and same-URL browser document replacement. Handoff `/tmp/aiden-bot-plan-c-task4-handoff.md` includes exact logs and files. Task 5 must bind complete effective rule-set identity in final admission revalidation, use host input identities consistently for plan/folder ownership and preserve raw IDs for provenance. No Gate 4 or whole-phase acceptance is implied.


Task 5 integration adds a main-only optional delivery deadline to the plan request/record and replay identity. An approved plan expires at the earlier of that immutable deadline and the 60-minute plan maximum; approval at a spent deadline creates no active record. Two behavioral red failures are captured at `/tmp/bot-plan-c-delivery-deadline-red.log`, with corrected core coverage at `/tmp/bot-plan-c-delivery-deadline-green.log`. A held-read test also caught fresh folder installation starting after Stop was requested. The installation checks queued termination before invoking its callback; an already-started callback retains its original serialized completion behavior, then Stop revokes it. The corrected core suite passes 41 at `/tmp/bot-plan-c-fresh-grant-stop-green2.log`. Root wiring lint and registry 15 pass. Full Task 5 checks remain in progress.


### Task 5 checkpoint, 2026-11-04

Tasks 1–5 are implemented and registered. Task5 tools retain immutable original proposal, ownership, attribution and delivery deadline in durable task memos, reread A's authoritative delivery window on every execution, and install a plan-owned B folder only for the one fresh approval. Stored approval cannot recreate temporary access. Final active-plan checks and actionable request_access recovery are covered by real durable restart tests, including restart after folder installation but before the tool result commits. Both tools remain model-only; unnamed person inputs use the runtime's host identities, while raw request IDs keep deciding ingress.

The production authority adapter binds the full admitted authority and complete effective rule set. It snapshots mutable arguments before awaiting, validates mapped owner IDs and exact B policy/path/inode/target-relative inventory, and performs final admission and target checks before synchronous grant installation. Core grantFreshAccess additionally revalidates the captured full proposal before installing a folder; a behavioral red caught a changed binding otherwise reaching that callback. The corrected core has 42 tests. No session singleton is imported by the adapter or tool module.

Parent validation: plan suite **102**, runtime **391**, Bots **992**, access **84**, messaging **89**, rules **62**, pause **34**, registry **15**, full type-check and scoped ESLint (27 TypeScript files) all passed. Production startup and the existing access-card interaction passed **1 Cua E2E**. The CLI build, all **183 tests with 3 existing PTY skips**, and CLI type-check passed; the real fake-SSE Ping/Pong case asserts it offers none of request_access/propose_plan/plan_step. No C phone contract changed at this gate.

Evidence: `/tmp/aiden-bot-plan-c-task5-handoff.md`, `/tmp/bot-plan-c-task5-parent-{plans-final,runtime,bots,access,messaging,rules,pause,registry-final,types-final,lint-final}.log`, `/tmp/bot-plan-c-startup-cua.log`, `/tmp/bot-plan-c-cli-{build,tests,types}.log`. Tool reds include missing implementation/ingress, expired-approved replay wording and concurrent changed-argument replay (`/tmp/bot-plan-tools-task5-*-red.log`). Adapter mutation/inventory audit reds are `/tmp/bot-plan-authority-audit-red.log`; captured-binding-before-grant red is `/tmp/bot-plan-c-fresh-grant-binding-red.log`.

Gate 4 is pending independent Opus 5.5 medium and OpenCode Go DeepSeek V4.1 Flash high reviews of the same committed checkpoint. Tasks 6–9 and D remain gated. These results establish local source/test behavior, not physical-device, live-provider, package/release or hosted-CI acceptance.


### Gate 4 review round 1, 2026-11-04

Both independent reviewers accepted frozen `c9fc2045db1fe2daa3119a9a061996d5de72108b` with no blocking or important findings. Opus 5.5 medium reported five Lows: concurrent non-final step marking can force an ordinary card, A authority-loss replay can falsely report ended while coverage stays active, named inputs unnecessarily scan identity history, site validation/store grammars disagree, and step-change/replay copy can be false. DeepSeek V4.1 Flash high independently reported the Bot-wide current-view precedence problem when another plan is pending. Full reports are `/tmp/aiden-bot-plan-c-opus-r1.md` and `/tmp/aiden-bot-plan-c-deepseek-r1.md`.

All six reported Lows are being addressed before Task6. The core retains the conservative queued-mark termination fence; sequential plan_step scheduling addresses its normal concurrent-tool trigger. Exact plan reads leave the no-ID UI view unchanged. New already_done/already_skipped outcomes are main-only and preserve completed step state; exact final replay is inert. Four core/validation RED failures are recorded at `/tmp/bot-plan-c-r1-core-red.log`, followed by53 passing tests at `/tmp/bot-plan-c-r1-core-green.log`. Tool/identity corrections and a fresh independent correction review remain pending; no Task6/native/Remote work has started.

Retained observations are not reopened as defects: conservative reservations remain charged when invocation does not start, compact receipts carry the already-clamped expiresAt plus hashed original deadline identity, strict revalidation can delay serialized revocation, and a failed durable termination write can only retain its in-process overlay until restart. Existing lifetime, access and cap checks still apply. No physical-device, live-provider, release/package or exact-head hosted-CI evidence is claimed.


### Gate 4 Low corrections implemented, 2026-11-04

The runtime/tool worker stopped all edits. plan_step now executes sequentially, with a real durable mixed-round test that proves a non-final mark produces no ordinary card and a final-first mark still ends coverage before subsequent work. All named inputs keep their original IDs without an identity-history scan; mixed runs preserve exactly one stable host UUID. The core's conservative all-mark intent fence and final admission rules are unchanged.

propose_plan uses current(botId, planId) for every state check. Missing, thrown, explicitly expired or changed A delivery authority stops that same active plan before returning, invalidating even an issued permit and revoking only its folder. A different pending card or newer active plan is preserved. Conflicting marks now report the stored status, and exact final replay reports finished without another write/event/revoke. Site hostname refusal happens in validation before the task memo can become unusable. No public/Remote DTO or revision changed.

Worker evidence: focused tools/policy/extension93, plans115, runtime393, whole types, scoped lint and whitespace checks passed. Full handoff `/tmp/aiden-bot-plan-c-r1-tools-handoff.md` distinguishes actual behavioral REDs from corrected test instrumentation. Runtime/tool RED logs are `/tmp/bot-plan-c-r1-tools-red2.log`, `/tmp/bot-plan-c-r1-scheduling-inputs-red.log`, and `/tmp/bot-plan-c-r1-tools-red.log`; core/validation RED4 is `/tmp/bot-plan-c-r1-core-red.log`. Parent final integration and fresh independent R2 review remain in progress. C6–9/D remain held.


### Gate 4 correction checkpoint ready, 2026-11-04

Root inspected all source/test changes and independently verified the combined correction: plans115, runtime393, Bots992, rules62 and registry15 passed, as did whole-project types, scoped lint for9 TypeScript files and whitespace checks. Rebuilt CLI:268 files/27MiB,186 tests with183 passed and3 existing PTY skips, plus CLI types passed. Production startup/access-card Cua E2E passed1. Logs use `/tmp/bot-plan-c-r1-parent-{plans,runtime,bots,rules,types,lint,registry}.log`, `/tmp/bot-plan-c-r1-cli-{build,tests,types}.log`, and `/tmp/bot-plan-c-r1-startup-cua.log`. The earlier access84/messaging89/pause34 runs belong to c9fc2045d and have not been relabeled as correction-head evidence.

All six R1 Lows have concrete corrections and behavioral coverage. No R1 finding was rejected. The conservative cap-reservation and queued-termination contracts are unchanged. Fresh Opus5.5medium and DeepSeekV4.1Flashhigh correction reviews must read the original brief, both full R1 reports, dispositions and this delta before C6 begins. No source acceptance of the new checkpoint, phone/device, live-model, packaging or hosted-CI outcome is implied yet.


### Gate 4 correction accepted, Task 6 started, 2026-11-04

Both fresh reviewers accepted `054e953fa25e13ca98dafb994d9872ce2db626c3` with no blocking, important or Low correctness findings. All six R1 Lows are closed. Full reports are `/tmp/aiden-bot-plan-c-opus-r2.md` and `/tmp/aiden-bot-plan-c-deepseek-r2.md`. Accepted observations about conservative reservations, indefinite hash receipts, serialized revalidation/revocation latency and failed-write overlays remain documented. No physical/live/package/hosted-CI acceptance is implied.

Task6 has started. The root's strict IPC handler has a missing-module RED and three passing real-store register/invoke tests for approval/decline/Stop, wrong-Bot/plan answers and malformed payloads (`/tmp/bot-plan-c-task6-ipc-{red,green}.log`). Production wiring supplies plan projection/attention, a change subscription with teardown, Stop/dismiss and idle termination, and deletion before final data erasure. Plan termination is fired with error reporting and is never awaited under the session serializer. Live-state/session behavior and final integration are still in progress. Tasks7–9/D remain pending.


### Task 6 complete locally, 2026-11-04

Live snapshots/events expose only BotPlanView. Pending plans contribute Waiting for you/Needs you, including offscreen summary and inbox reads. Identity/revision changes and clear events are serialized per feed; plan attention broadcasts only botId and subscriptions have teardown. The strict desktop response IPC is registered and the renderer wrapper forwards only botId/planId/decision. The new handler and lifecycle tests are registered in test:bot-plans and the CI lane.

Real lifecycle tests caught an integration hazard: a service can report idle before recovering an unfinished run, and natural completion reaches projection onRunSettled rather than service.awaitReply. The new pure bot-plans/lifecycle.ts adapter preserves initial idle approval, ends observed running-to-idle or actual projection settlement, routes successful Stop/Dismiss to stopped, reports asynchronous persistence failures and never awaits a plan serial in a session callback. Main and the real service/projection integration tests use this same adapter. Delete forgets plans before data erasure; shutdown clears ephemeral grants/observation while leaving recoverable stored approvals intact.

Parent final validation: plans123, runtime403, pause34, registry15, full types and scoped lint15 files passed. Real combined session/lifecycle/IPC tests passed46. Rebuilt CLI268 files/27MiB and full186 tests with183 passed/3 existing PTY skips, plus CLI types, passed. Cua production startup/access-card E2E passed1. Logs: `/tmp/bot-plan-c-task6-parent-{plans,runtime,pause,types,lint,registry}.log`, `/tmp/bot-plan-c-task6-root-lifecycle-integrated.log`, `/tmp/bot-plan-c-task6-cli-{build,tests,types}.log`, `/tmp/bot-plan-c-task6-startup-cua.log`. Root IPC/lifecycle missing-module REDs are `/tmp/bot-plan-c-task6-{ipc,lifecycle}-red.log`; worker behavioral REDs and all fixture corrections are documented in `/tmp/aiden-bot-plan-c-task6-live-handoff.md`.

No Remote/native DTO or revision changed. The Mac card is Task7, capability-gated Remote/native support is Task8, and complete C review remains Gate5 after Task9. No new phone, physical-device, live-provider, package/release or hosted-CI acceptance is claimed.


### Task 7 started, 2026-11-04

Task6 is committed at `d2471eb30`. A bounded UI worker owns the new plan card and existing chat-pane implementation/tests, following graphical-ui, Aiden tokens and the mandatory ChatGPT inspiration/specimen references. Root prepared `tests/e2e/bot-plans.spec.ts` against a substituted public host feed, with real renderer controls/IPC/composer and light/dark wide/narrow captures. It has not run yet; source readiness, unit/interaction checks and Cua validation remain pending. No Task8 wire/native code has started.


### Task 7 complete locally, 2026-11-04

The Mac plan card uses the existing Bot notice surface, avatar, buttons and semantic tokens. Pending plans show attribution, reason, ordered steps and coverage with a details disclosure; active plans show accessible step states, remaining time, counts and Stop; ended plans show one compact progress line. Responses have a synchronous duplicate guard, retryable inline errors and plan-isolated local state. Only the host changes or removes a card. A pending plan blocks Send/Enter while preserving an editable draft.

Worker meaningful missing-module and pane behavioral REDs are `/tmp/bot-plan-c-task7-{card,pane}-red.log`. Parent plans137, focused UI98, registry15, whole types, scoped lint and whitespace passed. The registered new card suite is part of test:bot-plans and the renderer CI lane. Cua interaction/visual acceptance passed1 in `/tmp/bot-plan-c-task7-cua-fixed-locator.log`, with light1280/dark600 pending and dark active captures inspected. Real renderer/IPC/composer/keyboard controls used a substituted public host feed; no inference occurred. The initial Cua run failed the pending composer placeholder locator because readiness changes its placeholder. The corrected test locates the textarea and preserves independent Send, Enter and draft assertions. This is not native, physical-device, packaged-app or hosted-CI acceptance. Task8 is next; full C Gate5 remains pending.


### Task 7 long-review acceptance, 2026-11-04

A parent max-length Cua case found a genuine review gap after the first Mac card commit331dc9d6b: ten long steps and eight coverage rows pushed the first steps above the clipped fixed footer. RED `/tmp/bot-plan-c-task7-long-review-red.log` records viewport ratio0. The card now has a bounded keyboard-scrollable Plan review region, preserving its title and approval actions outside the scrolling content and the shared neutral focus treatment. Cua checks Home/End traversal, first/last steps and trailing coverage, persistent visible Approve and preserved draft. GREEN1 `/tmp/bot-plan-c-task7-long-review-green.log`; focused UI99 and scoped lint passed, and the long-review dark screenshot was inspected. The E2E build type-check passed. A concurrent whole-root type-check reports only the Task8 host worker's expected missing APIs in its new RED tests; full whole-root green is deferred until that host implementation is ready.


### Task 8 started, 2026-11-04

Mac card commits331dc9d6b and8bc007425 include normal and maximum-length Cua acceptance. Task8 host work now owns the capability/DTO/snapshot/SSE/response route, revision56 fixture and OpenAPI in a bounded worker. The native worker is read-only until the host publishes its stable canonical fixture manifest, then implements both platforms against that seam. Root owns registration, integrated verification and status. Tasks9/D and Gate5 remain pending.


### Task 8 host complete locally, 2026-11-04

Host revision56 adds bot:plans, strict public plan DTOs, holder-only snapshots/SSE and POST /bots/:botId/plans/:planId/respond with bot:read+bot:write+bot:plans and Idempotency-Key. Exact core identities provide first-answer-wins; settled answers return forgotten409 plan_expired, transient errors remain replay-safe, and post-effect retries cannot approve twice or reinstall authority. Responses use plan-qualified host status through replacement/Stop. Public strings are bounded/redacted before snapshot budgeting; private proposal, binding and input identities stay on the host. Legacy streams remain gapless, paired Macs ignore unsupported frames, and CLI offers no plan tools or capability. The canonical botPlans fixture is shared unchanged with native.

Host final five-file suite335, wholetypes, scopedlint10files and whitespace passed; full handoff `/tmp/aiden-bot-plan-c-task8-host-handoff.md`, final log `/tmp/bot-plan-c-task8-host-final.log`. A final independent schema oracle caught OpenAPI allowing used>max and rejecting valid newline display text; meaningful RED/GREEN3 logs are mapped in the handoff. No fixture/DTO shape changed. Parent broad integration passed plans138/runtime403/Bots997/rules62/access84/messaging89/remote-chat228/registry15 and fullRemote175+1059+7+29 with2existing skips; wholetypes/scopedlint passed. CLIbuild268files27MiB,183pass3existingPTYskips/types passed. Cua production startup/access+plan2 passed13.9s. Parent log map `/tmp/aiden-bot-plan-c-task8-parent-validation.md`. Native validation and Step4/5 remain pending. Task9/Gate5/D remain held. No physical/live/package/hosted-CI claim.


### Task 8 complete locally, 2026-11-04

Both native clients consume the same revision56 canonical fixture and strictly decode public plan snapshots/frames, optional clears, bounded paired counters, ISO dates and error receipts. They negotiate bot:plans separately when offered, preserve legacy hosts, gate controls, retain per-plan/per-decision retry identities, and prevent late receipts/errors from changing replacement cards. Pending cards hold Send while drafts remain editable; host feeds own settlement. Plan reviews are bounded/scrollable with reachable decisions and native accessibility labels. No native rendered-UI acceptance is claimed.

Native handoff `/tmp/aiden-bot-plan-c-task8-native-handoff.md`: iOS419 total,414pass/5existing physical/configuration skips/0fail, final exit0 and finalized result `/tmp/bot-plan-c-task8-native-ios-final.xcresult`; Android1169pass/0fail across96classes, lint0errors/51warnings/5hints and instrumented-test compilation passed. Logs `/tmp/bot-plan-c-task8-native-{ios,android}-final.log`. Meaningful native REDs and coordinator/date-boundary corrections are retained in the handoff. New XCTest membership is registered in the Xcode project; Gradle discovers the Kotlin contract test. Existing Xcode compiler/main-thread warnings and unsigned-simulator entitlement limits remain documented, not claimed fixed. Native source edits stopped after final tests.

Host and parent evidence is recorded above and in both handoffs. Parent final protocol/schema and registry reruns passed after the host schema audit. Task8 is complete for source/local tests; Task9 docs/onboarding and full-C Gate5 remain pending. No physical-device, signed-Keychain, live-provider, package/release or hosted-CI acceptance exists. Remote56 still needs main-time revision recheck.


### Task 9 started, 2026-11-04

Task8 committedbafae36ee. Root searched README, PRODUCT, active guides and project memory for stale per-call approval and platform claims, preserving dated records. Search inventory is /tmp/bot-plan-c-task9-stale-claims.txt. User guidance now describes whole-task approval, conjunctive rule/cap coverage, final permission checks, Stop versus already-started calls, the extra folder's in-memory lifetime after quit, nested codemode checks, Bot-message deadlines and CLI/paired-desktop limits. A bounded onboarding worker owns the exact new first-Bot line and existing Bots gallery/art/tests; root owns Cua tour/interaction acceptance and status. Gate5 is not yet started; D remains held.


### Task 9 complete locally, Gate 5 pending, 2026-11-04

Product, rules, codemode, messaging and CLI guidance now describe plan coverage and limits without claiming D. README/PRODUCT link the plan guide. Project rule memory records conjunctive coverage/final admission. Onboarding uses the required first-Bot sentence and an amended single Bots tile: a code-drawn active checklist with usage cap, Stop and details, using existing art tokens and a complete reduced-motion pose. The gallery retains messaging, routines and hand-off guidance.

Worker meaningful RED3 and GREEN13, fulltypes/scopedlint/diff are mapped in /tmp/aiden-bot-plan-c-task9-onboarding-handoff.md. Broader onboarding initially84pass1fail exposed an already-stale gallery-copy assertion outside worker ownership; parent replaced that rendered expected guidance with independent plan/cap assertions. Parent final onboarding85/plans138/rules62/runtime403/Bots997/registry15, wholetypes and scopedlint7files passed. Cua2 passed9.5s with real onboarding/renderer/IPC/keyboard over deterministic keyless setup; light1280/dark600 art and keyboard-focused description captures were inspected. The existing plan interaction and long-review case also passed. Logs /tmp/bot-plan-c-task9-parent-{onboarding,plans,rules,runtime,bots,registry,types,lint,cua}.log. No native wire or implementation changed after Task8 suites.

All C Tasks1–9 are implemented and locally verified. Gate4 acceptance remains054e953fa; fresh complete-C Gate5 reviews are next on the frozen Task9 commit. D remains held until both accept. The native rendered-UI/physical-device, live-provider, package/release and hosted-CI limits remain unclaimed. Four PRs and final Astra review remain pending.


### Gate 5 round 1 findings, corrections in progress, 2026-11-04

Both reviewed clean6c405ac21. Opus did not accept: Important phone file-scope redaction made distinct actual grants indistinguishable; Low long-rule truncation hid pending caps; Low lifecycle only-idle handling left Approved after observed needs_model/model_error endings. DeepSeek accepted with one Low retained invocation-approval closure after a pre-execution block. Full reports /tmp/aiden-bot-plan-c-GATE5-{opus,deepseek}-r1.md. Root accepts all four concrete findings for correction. D remains held.

Host worker owns a structural host-display fileScope discriminator, truthful bounded folder/cap presentation, unchanged Remote56 DTOs, canonical file examples and API guidance. Unrepresentable pending scope must not offer phone approval; keep waiting signals and allow Stop on active summaries. Native validates updated file examples with existing strict models. Root lifecycle RED5pass4fail verifies actual core approval remains active instead of finished on terminal model states. The correction preserves initial/recoverable states and applies to actual projection settlement too. Root deletes the invocation map entry on a beforeTool rejection, with existing real-harness checks; no debug-only resource oracle is added.

DeepSeek's retained note about pending Not now returning409 is rejected as written: actual pending Not now returns200stopped and is offered on all three clients, as the real-core/ledger test in aiden-remote-bot-session.test.ts verifies. Not now on an already-active plan returns409 by design and no active UI offers it. All other listed retained observations remain nonblocking and are carried into the next fresh review, including queued-revalidation read latency, historical receipt/cap/recovery limits and stale display during failed termination writes.


### Gate 5 round 1 corrections complete locally, 2026-11-04

All four findings have corrections. Host-only fileScope display metadata comes only from strict files formatting and never enters Remote56 DTOs. Phones show the actual host-relative/absolute folder, read/change mode and plan-only lifetime. Counted lines retain their cap. Unsafe/over-capacity pending locations suppress only the phone card; raw waiting signals persist and phone Approve is a forgotten pre-effect409. The unchanged native shape means Send remains available in this desktop-review fallback. Active/ended summaries retain the safe basename/lifetime and active Stop. Bot-written prose keeps redaction. Canonical fixtures now exercise write-granted spaced paths, existing read access and a separate read-only outside grant. Both native decoders/controllers preserve the exact review strings with no production native change.

Root lifecycle handles observed running-to-needs_model/model_error and actual projection settlement, preserving initial/recoverable reads. BeforeTool preapproved rejection deletes its invocation-map entry, because no execute/afterTool/settled cleanup follows a block. Root lifecycle genuine RED5pass4fail -> GREEN9; focused lifecycle/assembly/extension138 passed. No resource-map debug API or artificial source assertion was added.

Final local evidence: parent plans143/runtime403/Bots997/rules62/registry15; whole types and nine-file scoped lint exit0; worker final five-file host349/types/lint exit0. Rebuilt CLI268files27MiB then186total=183pass/3existingPTYskips/0fail and CLI types0. Bundle timestamp is after every changed bundled source. Cua3pass18.2s covers startup/access, plan interaction/max review and onboarding; long-review capture inspected, decisions remain visible. Native focused iOS23pass0skip and Android120pass0skip, test-only changes. No retries, skips, assertions or timeouts were weakened.

Logs /tmp/bot-plan-c-g5r1-parent-{plans,runtime,bots,rules,registry,types,lint,cua}.log and /tmp/bot-plan-c-g5r1-cli-{build,tests,types}.log. Worker handoffs /tmp/aiden-bot-plan-c-g5r1-{phone-scope,native}-handoff.md map genuine host REDs, fixture/setup corrections, focused commands and limits. Native tests were extended against the already-corrected fixture and went green, not a claimed native-production RED. Existing full-native414/1169 and broadRemote counts remain prior evidence. No physical/rendered-native/live/package/release/hostedCI acceptance. Fresh dual Gate5R2 must accept a clean correction checkpoint before D.


### Gate 5 scope completion and payment-subdomain correction, 2026-11-04

DeepSeekR2 accepted5b30e4e82. OpusR2 accepted corrections but disclosed incomplete plan reads, so root required a fresh same-head scope-completion review. That OpusR3 review read both entire plans and found Important F-R3-1: an approved google.com/shopify.com site item covered neutral-button clicks on pay.google.com/pay.shopify.com/checkout.shopify.com despite validation refusing those hosts directly. This predates Gate4. Full reports /tmp/aiden-bot-plan-c-GATE5-{deepseek-r2,opus-r2,opus-r3}.md. D remains held.

Coverage now checks the actual action URL hostname with the existing isPaymentHost policy before matching a site item. Ordinary mail.google.com/admin.shopify.com subdomains remain covered; payment-provider subdomains and nested payment hosts return ordinary policy without charging the plan. Locked money/credential rules and hand-offs remain earlier in the sequence. The plan remains valid for its ordinary parent site. New core and real assembly-policy tests independently reproduce the omitted approval and preserve the positive site case. Initial RED had one valid assembly failure and an invalid dotted plan-ID fixture; corrected fixture RED2fail /tmp/bot-plan-c-g5r3-payment-red2.log, GREEN2 /tmp/bot-plan-c-g5r3-payment-green.log. No assertion/timeout/retry weakening.

The queued OpenAPI description Low is corrected: Bot-written prose is redacted, while host-formatted file items disclose enforced scope/lifetime. No schema shape, Remote56 revision, native DTO or UI changed. Keyboard-order deviation O1 is recorded: since the maximum-review accessibility fix8bc007425, Tab reaches the focusable Plan review scrolling region before answer controls; Approve plan remains the first answer control. This enables keyboard Home/End review and keeps decisions reachable. No UI change is needed.

Retain all prior observations, including waiting-first unrepresentable p2 hiding active p1's card/Stop, while run Stop and the host remain available. The complete-plan scope gap is closed by OpusR3's read, but its new Important finding requires a corrected checkpoint and fresh dual review. No whole-C/D, native rendered/physical, live, package or hostedCI acceptance is claimed.


Payment correction local validation: plans144/runtime404/rules62/protocol62, whole types and three-file scoped ESLint all passed, diff clean. Evidence /tmp/bot-plan-c-g5r3-parent-{plans,runtime,rules,protocol,types,lint}.log. The two targeted actual core/policy REDs and GREEN are mapped above. No native or renderer production/DTO change; prior focused native23/120 and Cua3 are retained previous-head evidence, not rerun. The CLI bundle contains neither plan coverage nor the plan validator; this desktop-only guard changes no CLI behavior, and the last full CLI183pass/3existing skips remains prior evidence. Fresh dual Gate5R4 reviews must accept the clean correction checkpoint before D starts.


### Gate 5 accepted, 2026-11-04

Both fresh R4 reviewers accept the same55678558e1c282ce5345d7afa022f743be292ee0 for whole-C source correctness with zero Blocking/Important/Low correctness defects. Reports /tmp/aiden-bot-plan-c-GATE5-{opus,deepseek}-r4.md. Both read the entire master/C plans without per-line truncation, independently checked actual policy/core and replay/admission boundaries, and retained all objections. Opus also ran a real durable browser-tool harness: payment-host click asks once, executes only after Allow and consumes no plan count. DeepSeek independently verified validation, host boundaries, caps, restart and old-permit refusal. Parent accepted source checkpoint and confirmed clean git status after DeepSeek removed its temporary .g5r4-probe.ts; Opus's earlier foreign-file observation is accounted for, not user data removed by root.

Source acceptance includes Tasks1–9 and fixes all concrete findings. Carry the safe-side site-detail copy overstatement, inferred embedded-payment-frame/top-level-URL limit, rule-only core behavior with no baseline outside current production browser tools, existing PAYMENT_HOSTS policy scope, and all previous retained UI/recovery/reservation observations. No new source correction is requested. The pending Not now409 claim remains rejected. A/B Lows remain unchanged. No physical-device, rendered native UI, signed-Keychain, live-provider, package/release or PR/hosted-CI proof is claimed. D can start next, then final GPT-6 Astra high review and four stacked PRs with exact-head CI. No merge is authorized.


### 2026-11-04: Hosted iOS source-inventory correction

PR #729's renderer-other job passed its renderer tests, then failed the preserved iOS release-policy suite because the explicit reviewed XCTest inventory omitted `AidenBotPlanTests.swift`. The file was already registered in the Xcode test target and had passed simulator tests. Root reproduced two policy failures locally before changing the inventory, then added that exact test filename. The shipping and widget inventories, phase checks, orphan checks and assertions remain intact; no app or test behavior changes. `npm run test:ios-release` is the relevant local validation, followed by fresh exact-head CI. The accepted source review remains unchanged-runtime evidence, not a claim that the earlier CI head passed.


### 2026-11-04 — PR729 identical-snapshot and standalone-suite corrections

Root reproduced both automatic-review findings before editing production. iOS and Android retained a rejected pending plan when an identical snapshot advanced their response-write fences. Both models now leave that fence unchanged for equal plan values. A changed plan, status or connection generation still fences late responses. Tests hold Approve and Not now across an identical pending snapshot, then deliver the host's `409 plan_expired` and assert the card clears and Send is released. Existing replacement, clear, status-change, reconnect, retry-key and host-authoritative success cases remain intact. No DTO/revision, visual layout or authorization change.

The standalone `npm run test:bot-plans` pretest now builds the existing subagent-file-mutator as well as lease-flock. A fresh source archive with only dependencies linked reproduced141pass/3fail from the missing helper; the corrected command passed144/144 under Node22.23.4. Root's normal plan suite also passed144. Focused native GREEN: iOS23/23 on iPhone17 simulator, signing disabled; Android121/121 offline, lint and instrumented-test compilation pass. Release policy20 Ruby tests/42 assertions plus30 Node tests and CI registry15 pass. Logs `/tmp/bot-pr729-{clean-plans-red,clean-plans-green,plans-green,plan-race-ios-red,plan-race-ios-green,plan-race-android-red,plan-race-android-green,ios-policy-green,registry-green}.log`. No assertion, timeout or retry was weakened; initial Android GREEN launch127 from the wrong working directory is a setup error, not a test result. Fresh Opus5.5 medium source review and exact-head hosted CI are pending. Physical/rendered-native, Keychain, live-provider and package acceptance are unclaimed.
