# Bot messaging B: `request_access` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Custom-access Bot that is held to its own folder can ask the person to use a folder outside it, or the whole Mac. The person answers on a card with **Allow once**, **Always for this folder** or **Not now**, on the Mac or a phone. On turns nobody watches, the request becomes a "Needs you" Bot issue.

**Architecture:**
- **The tool.** A new durable tool, `request_access`, follows the `hand_off` pattern. The memo holds a `waitId`, the tool is `interactive` and `replay: "safe"`, and a new bridge, `bot-access-requests.ts`, holds the waiting card.
- **Allow once** is an in-memory grant for the run that asked. The file tools reach it through one stable extra location, `run.access`, which is resolved at each call. Tools are only rebuilt when a run starts, so this extra location is what lets the same run use the folder.
- **Always** adds an `approved_location` to the Bot's Custom grants through a new `grantBotFolder`. It uses the same `updateBotAccess({ refuseDriftedGrants: true })` path as "Add to this Bot" for connections, under the policy revision.
- **Unattended turns** raise an `access_needed` Bot issue instead of a card.
- **Phones** get the card and the new issue kind under one Remote revision.

**Tech Stack:** TypeScript, Electron main and renderer (React), Pi Durable (pinned, unchanged), `node:test` through `tsx --test`, Testing Library, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/plans/bot-to-bot-messaging-research.md`](../../plans/bot-to-bot-messaging-research.md) §3 (constraints 1 and 3), §9, §11.2–11.3, §14 step 2. Plan A (`message_bot`) lands first and defines the `bot:` turn kind. This plan refers to it only by its request-id prefix, `bot:<originBotId>:<hop>:<deliveryId>`.

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only: never `readFileSync` production source and `assert.match` it, and write no tautological or change-detector tests.
- Register every new test file in a new `"test:bot-access"` script, with `"pretest:bot-access": "npm run build:lease-flock"`, and in the `scripts/ci-test-registry.json` lane that holds `bot-handoff-*` tests. `scripts/ci-test-registry.test.mjs` fails if either is missing. Append `test:bot-access` to the root `test` chain.
- **Who gets the tool.** It is offered only when `authority.accessMode === "custom" && authority.files.mode === "scoped"`. New Bots keep Full access (spec §11.2), so Full-access Bots, Custom Bots that already have Full Mac, and Bots with Files off never get it.
- **Whole Mac** is only ever **Allow once**. It is never Always, never an issue action, and never a saved grant.
- **Only the person grants.** A Bot's model, another Bot's `bot:` message, or a routine can never answer the card or the issue (spec §3, constraint 1). Always goes only through `grantBotFolder`, which saves with `refuseDriftedGrants`.
- **Unattended turns** never show a card: `routine:`, `tg:`, plan A's `bot:`, and plan A's `botreply:` if plan A defines it. A run joined by any of those counts as unattended, the same rule `hand_off` uses.
- **No network.** Nothing here contacts a server.
- **Remote.** Claim the next contract revision after `main`'s at merge. It is 53 today (`main/services/aiden-remote-protocol.ts:288`), and plan A claims one first. Change these together: iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md` and `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:174`.
- **UI.** Follow `GUI.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Use the shared squircle buttons and `BotNoticeCard`. Use no decorative borders, keep `focus-visible` rings, and use no brain icons.
- **Electron imports.** Modules under `main/services/` must not import `electron`, except the `*-main.ts` wiring files.
- **CLI.** The CLI's durable Bot host (`packages/cli/src/bot-durable.ts`) builds its own tool list and gets no `request_access`. The docs say so.
- **Pre-1.0:** delete legacy shapes rather than migrating them. Never use bare `git stash`.

## Review Focus

1. **Allow once must not outlive its run.** A follow-up turn uses new request ids, so it is refused. A person's steer that joins the run is allowed. After a quit, Resume has no grant, so the Bot asks again. Task 3 tests this.
2. **Always must not widen access.** If the Bot asks for `~/Documents/Taxes` while `~/Documents` is already an approved root, Always is not offered, and the larger root is never granted. Task 2 tests this.
3. **Access can change while the card waits.** If the person edits the Bot's access in Settings meanwhile, Always refuses with no write and no new approved root, and the card stays open with the message. A policy-revision change also drops an Allow once. Tasks 3 and 4 test this.
4. **Symlinks.** A requested path that resolves into Aiden's private storage (other Bots' homes, settings) is refused after `realpath`. Task 2 tests this.
5. **Asking again after Not now.** In the same run, no second card is shown, and the result says the person already declined. Task 7 tests this.

---

### Task 1: Shared access-request contract

**Files:**
- Create: `renderer/shared/bot-access-requests.ts`, `renderer/shared/bot-access-requests.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BOT_REQUEST_ACCESS_TOOL_NAME = "request_access";
  export const BOT_ACCESS_WHY_MAX_CHARS = 400;
  export const BOT_ACCESS_PATH_MAX_BYTES = 4_096;
  export const BOT_ACCESS_LABEL_MAX_CHARS = 120;
  export const BOT_ACCESS_PLACE_MAX_CHARS = 512;
  export const BOT_RUN_ACCESS_LOCATION_ID = "run.access";
  export const BOT_RUN_ACCESS_LOCATION_LABEL = "Allowed for this task";
  export const BOT_WHOLE_MAC_REQUEST = "whole_mac";
  export type BotAccessTarget = "folder" | "whole_mac";
  export type BotAccessChoice = "once" | "always" | "not_now";
  export interface BotPendingAccessRequest {
    botId: string; waitId: string; toolCallId: string;
    target: BotAccessTarget;
    label: string;               // "Taxes"; for whole_mac "your whole Mac"
    place?: string;              // folder only: home-relative, e.g. "~/Documents/Taxes"
    why: string;
    choices: BotAccessChoice[];  // card order; the last one is primary
  }
  export type BotAccessOutcome = BotAccessChoice | "already_allowed" | "declined_earlier" | "asked_later";
  export interface BotAccessResultDetails { target: BotAccessTarget; label: string; outcome: BotAccessOutcome }
  export function botAccessChoicesFor(input: { target: BotAccessTarget; alwaysOffered: boolean }): BotAccessChoice[];
  export function parseBotAccessChoice(value: unknown): BotAccessChoice | null;
  export function botPendingAccessRequestOf(value: unknown): BotPendingAccessRequest | null; // strict: exact keys, bounds
  export function botAccessCardTitle(botName: string, request: Pick<BotPendingAccessRequest, "target" | "label">): string;
  export function botAccessResultLine(details: BotAccessResultDetails): string;
  ```
- Copy (exact):
  - Titles: `"{Bot} wants to use {label}"` and `"{Bot} wants to use your whole Mac"`.
  - Buttons: `"Not now"`, `"Always for this folder"`, `"Allow once"`.
  - Result lines: `"Allowed {label} once"`, `"Always allowed {label}"`, `"Not now: {label}"`.

- [ ] **Step 1: Write the failing tests** in `bot-access-requests.test.ts`:
  - `whole Mac is only ever Allow once`: `botAccessChoicesFor({target: "whole_mac", alwaysOffered: true})` deep-equals `["not_now", "once"]`.
  - `a folder offers Always only when allowed`: `{target: "folder", alwaysOffered: true}` gives `["not_now", "always", "once"]`, and `false` gives `["not_now", "once"]`.
  - `the parser refuses a whole-Mac card that offers always`: `botPendingAccessRequestOf({...valid, target: "whole_mac", choices: ["not_now", "once", "always"]})` is `null`.
  - `the parser refuses unknown keys, a blank why, and a why over 400 characters`.
  - `titles read as the card says`: `botAccessCardTitle("Ada", {target: "folder", label: "Taxes"}) === "Ada wants to use Taxes"`.
  - `parseBotAccessChoice` accepts the three choices and rejects `"allow"`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test renderer/shared/bot-access-requests.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `why` and `label` go through `withoutBotHandoffControls` (`renderer/shared/bot-handoffs.ts`) before the bounds are checked. Bounds use `isBoundedBotText`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Register `test:bot-access` and the CI lane, then commit:** "Add the Bot access-request contract".

### Task 2: Resolve what the Bot asked for

**Files:**
- Create: `main/services/bot-runtime/bot-access-target.ts`, `main/services/bot-runtime/bot-access-target.test.ts`

**Interfaces:**
- Consumes: `isPathInside` (`main/shared/path-containment.ts`), `AidenRemoteApprovedRoot` (`main/services/aiden-remote-state.ts`), `BotFileToolLocation` (`main/services/bot-file-tool-router.ts`).
- Produces:
  ```ts
  export type BotAccessAlways =
    | { kind: "existing"; rootId: string }   // an approved root with exactly this path
    | { kind: "new" }                         // no approved root touches it
    | { kind: "none"; reason: "covered" | "overlaps" | "home" };
  export type BotAccessResolution =
    | { kind: "folder"; root: string; label: string; place: string; device: string; inode: string; always: BotAccessAlways }
    | { kind: "whole_mac" }
    | { kind: "refused"; reason: "not_absolute" | "too_long" | "not_found" | "private" | "filesystem_root" };
  export interface BotAccessTargetDeps {
    homeDirectory(): string;
    privateRoots(): readonly string[];   // Aiden's userData: every Bot's home, session and settings files
    approvedRoots(): Promise<readonly Pick<AidenRemoteApprovedRoot, "id" | "folderPath">[]>;
    filesystem?: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ dev: bigint; ino: bigint; isDirectory(): boolean }> };
  }
  export function resolveBotAccessTarget(requested: string, deps: BotAccessTargetDeps): Promise<BotAccessResolution>;
  export function coveredByBotLocations(root: string, locations: readonly Pick<BotFileToolLocation, "root">[]): boolean;
  ```
- Rules:
  - `"whole_mac"` gives `whole_mac`.
  - Leading `~` and `~/` expand to the home folder. Any other relative path gives `not_absolute`. More than 4,096 bytes gives `too_long`.
  - The path is resolved with `realpath`. A file resolves to its parent folder.
  - `/` gives `filesystem_root`, so the tool tells the Bot to ask for `"whole_mac"`.
  - Anything inside a `realpath`'d private root gives `private`.
  - `place` is the path relative to home, written with `~`.
  - Always:
    - `existing` when an approved root's `folderPath` equals the resolved path.
    - `covered` when a larger root contains it.
    - `overlaps` when it contains a root (`addLocalFolder` refuses that).
    - `home` for the home folder itself.
    - `new` otherwise.

- [ ] **Step 1: Write the failing tests** with `mkdtemp` folders and a fake home:
  - `a file resolves to its folder`: requesting `<tmp>/Taxes/2025.pdf` gives `kind: "folder"`, `root: <real tmp>/Taxes`, `label: "Taxes"`.
  - `a symlink into Aiden's storage is refused` (Review Focus 4). `<tmp>/link -> <private>/bots/x` gives `{kind: "refused", reason: "private"}`.
  - `a folder inside an approved root never offers Always` (Review Focus 2). With roots `[{id: "root_a", folderPath: <tmp>/Documents}]`, requesting `<tmp>/Documents/Taxes` gives `always.kind === "none"` and `reason === "covered"`.
  - `an exact approved root is reused`: this gives `{kind: "existing", rootId: "root_a"}`.
  - `a folder holding an approved root offers no Always`: this gives `reason: "overlaps"`.
  - `the home folder is Allow once only`: this gives `reason: "home"`.
  - `~ paths expand and relative paths are refused`.
  - `coveredByBotLocations` is true for a subfolder of a location root, and false for a sibling whose name shares a prefix (`/a/b` against `/a/bc`).
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-access-target.test.ts`.
- [ ] **Step 3: Implement** with the default filesystem from `node:fs/promises` (`stat` with `{ bigint: true }`), as `aiden-remote-approved-roots.ts` does.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Register and commit:** "Resolve the folder a Bot asks for".

### Task 3: Allow once is the run's own location

**Files:**
- Create: `main/services/bot-runtime/bot-run-access.ts`, `main/services/bot-runtime/bot-run-access.test.ts`
- Modify: `main/services/bot-file-tool-router.ts`:
  - `BotFileToolRouterOptions` gains `lateLocation`;
  - `locationParameter` lists it;
  - the `byId` miss falls through to it.
- Modify: `main/services/bot-runtime/bot-file-candidates.ts` (the `runAccess` input)
- Modify: `main/services/bot-runtime/bot-tool-sources-main.ts`:
  - `BotToolSourceDeps.policyRevision`;
  - pass `runAccess` to `botFileCandidates` for scoped Custom Bots.
- Modify: `main/services/bot-runtime/bot-session-main.ts:832`. In `onStateChange`, `botRunEnded(state)` calls `botRunAccess.clearBot(botId)`. The Bot-delete fan-out calls `clearBot` too.
- Test: `main/services/bot-file-tool-router.test.ts`, `main/services/bot-runtime/bot-file-candidates.test.ts` (extend both)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_RUN_ACCESS_MAX_AGE_MS = 60 * 60_000;
  export interface BotRunAccessGrant {
    requestIds: readonly string[];          // the run's defined request ids when the person answered
    target: "folder" | "whole_mac";
    key: string;                            // the folder root, or "whole_mac"
    root: string;                           // "/" for whole_mac
    label: string;
    identity?: { device: string; inode: string };
    policyRevision: string;                 // the Bot policy revision after the answer
    grantedAt: number;
  }
  export interface BotRunAccess {
    grant(botId: string, grant: BotRunAccessGrant): void;             // the newest grant for an overlapping run replaces the older one
    location(botId: string, requestIds: readonly (string | undefined)[], policyRevision: string): BotFileToolLocation | undefined;
    decline(botId: string, requestIds: readonly string[], key: string): void;
    declined(botId: string, requestIds: readonly (string | undefined)[], key: string): boolean;
    clearBot(botId: string): void;
  }
  export function createBotRunAccess(deps: { now(): number }): BotRunAccess;
  export function botRunEnded(state: BotSessionState): boolean; // idle, needs_model, model_error, unavailable, or paused without `interrupted`
  ```
  - `location` returns `{ id: BOT_RUN_ACCESS_LOCATION_ID, label: BOT_RUN_ACCESS_LOCATION_LABEL, root, expectedIdentity }` only when one of the call's request ids is in `grant.requestIds`, the revision matches, and the grant is younger than 60 minutes.
  - The store is in memory only. A quit ends Allow once, and the Bot asks again on Resume.
- Router (`bot-file-tool-router.ts`):
  ```ts
  readonly lateLocation?: { readonly id: string; readonly label: string; resolve(): Promise<BotFileToolLocation | undefined> };
  ```
  - It is declared in the `location` schema after the fixed locations.
  - A call to it resolves its location, then runs the underlying tool for that location. The protected-root, skill-directory and root-redaction checks run exactly as for a fixed location.
  - An unresolved location throws `"Nothing extra is allowed for this task yet. Ask with request_access first."`.
- `BotFileCandidateInput.runAccess?: { resolve(call: BotToolCall): Promise<BotFileToolLocation | undefined> }`. The bound tool passes `lateLocation` with `resolve: () => input.runAccess.resolve(call)`.
- `BotToolSourceDeps.policyRevision(botId: string): Promise<string>`. In `bot-session-main.ts`, this is `(await botCapabilityStore.getBotPolicy(botId)).revision`.
- Exported singleton in `bot-tool-sources-main.ts`: `export const botRunAccess = createBotRunAccess({ now: Date.now })`.

- [ ] **Step 1: Write the failing tests:**
  - In `bot-run-access.test.ts`:
    - `a grant serves only its own run` (Review Focus 1). A grant for `["r1"]` gives a location for `["r1"]` and for `["r1", "r2"]` (a steer joined), and `undefined` for `["r3"]`.
    - `a changed policy revision drops the grant` (Review Focus 3).
    - `a grant expires after 60 minutes`, using a fake clock.
    - `clearBot forgets grants and declines`.
    - `botRunEnded` is true for `{kind: "idle"}`, and false for `running`, `interrupted`, and `paused` with `interrupted`.
  - In `bot-file-tool-router.test.ts`, `a late location reads inside its resolved root`: `read_file` with `location: "run.access"` reads a fixture file. Two more checks:
    - `an unresolved late location explains how to ask`;
    - `a late Full Mac location still refuses writes into protected roots`.
  - In `bot-file-candidates.test.ts`, `a bound file tool uses run access only for the run it serves`. Use a fake `call.runRequestIds` and a real `createBotRunAccess`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-run-access.test.ts main/services/bot-file-tool-router.test.ts main/services/bot-runtime/bot-file-candidates.test.ts`.
- [ ] **Step 3: Implement** the store, the router's `lateLocation` and the candidate input, then wire them in tool sources and session main.
- [ ] **Step 4: Run** the three files and `npm run test:bot-runtime`. Expected: PASS.
- [ ] **Step 5: Register and commit:** "Give a Bot's run the folder the person allowed once".

### Task 4: Always for this folder (`grantBotFolder`)

**Files:**
- Modify: `main/services/bot-application-service.ts`:
  - the new dependency `approvedFolders`;
  - `updateBotAccess`'s `refuseDriftedGrants` accepts `{ message: string }`;
  - the new `grantBotFolder`, next to `grantBotConnection` at `:1725`.
- Modify: `main/services/bot-application-service-main.ts` (wire `approvedFolders` through a dynamic `import("./aiden-remote-service-main.js")`, as `listApprovedLocations` does in `bot-capability-services-main.ts:247`)
- Test: `main/services/bot-application-service.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // BotApplicationDependencies
  approvedFolders?: {
    list(): Promise<readonly { id: string; folderPath: string }[]>;          // runtime.state.snapshot().approvedRoots
    add(folderPath: string): Promise<{ id: string }>;                        // runtime.approvedRoots.addLocalFolder(folderPath)
  };
  // service
  grantBotFolder(input: { audienceId: string; botId: string; folderPath: string; rootId?: string }): Promise<"added" | "already_allowed">;
  ```
- Behavior:
  - When the Bot isn't Custom, the result is `"already_allowed"`.
  - **Drift pre-check.** Before any new approved root is added, run the same `deps.catalog.reconcile(savedBinding, …)` check that `updateBotAccess` runs. If it is not `ready`, throw the drift message and write nothing.
  - **The root.** Use `rootId` only when that root's `folderPath` still equals `folderPath`. Otherwise call `approvedFolders.add(folderPath)`.
  - **The option.** Find the snapshot's `fileScopes` entry with that `sourceId` and `kind: "approved_location"`. If it is missing or unavailable, throw `"That folder can't be added right now."`.
  - If the option is already selected, the result is `"already_allowed"`.
  - **The save.** Call `updateBotAccess` with:
    - `expectedRevision: policy.revision`;
    - `refuseDriftedGrants: { message: "Some of this Bot's access changed since you last saved it. Review it in the Bot's settings first." }`;
    - `fileScopeIds: nextBotFileScopeIds(policy.custom.fileScopeIds, snapshot.catalog.fileScopes, option.id, true)` (`renderer/shared/bot-capabilities.ts:472`, which keeps `bot_home`).
  - The connection grant keeps its current message, so `refuseDriftedGrants: true` reads as before.

- [ ] **Step 1: Write the failing tests**, with the existing fakes for `grantBotConnection`:
  - `grantBotFolder adds one approved location and keeps the rest`. After the call, the saved `custom.fileScopeIds` holds the earlier ids plus the new option id, and `bot_home`'s id is still there.
  - `grantBotFolder reuses an exact approved root`: `approvedFolders.add` is never called.
  - `grantBotFolder refuses drifted grants with no write and no new root` (Review Focus 3). The save count and the `add` count both stay 0, and it rejects with the message above.
  - `grantBotFolder on a Full-access Bot is already_allowed`.
  - `the connection grant's drift message is unchanged`. Extend the existing drift test for `grantBotConnection`.
- [ ] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-application-service.test.ts`.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run** the file and `npm run test:bots`. Expected: PASS.
- [ ] **Step 5: Commit:** "Let the person add a folder to a Bot's access".

### Task 5: The access-request bridge and its answer

**Files:**
- Create: `main/services/bot-runtime/bot-access-requests.ts`, `main/services/bot-runtime/bot-access-requests.test.ts`
- Create: `main/services/bot-runtime/bot-access-requests-main.ts`

**Interfaces:**
- Produces, in `bot-access-requests.ts`, built like `bot-questions.ts`:
  ```ts
  export interface BotAccessRequestPrompt extends BotPendingAccessRequest {
    /** Main-only: what Always grants. Never projected to the renderer or the wire. */
    grant?: { folderPath: string; rootId?: string };
  }
  export type BotAccessAnswerOutcome = "answered" | "not_waiting" | "invalid";
  export interface BotAccessRequests {
    request(prompt: BotAccessRequestPrompt & { signal: AbortSignal | undefined }): Promise<BotAccessChoice>;
    answer(botId: string, waitId: string, choice: BotAccessChoice, always: (prompt: BotAccessRequestPrompt) => Promise<void>): Promise<BotAccessAnswerOutcome>;
    pending(botId?: string): BotPendingAccessRequest[];   // without `grant`
    get(botId: string, waitId: string): BotPendingAccessRequest | undefined;
    onChange(listener: (botId: string) => void): () => void;
  }
  export function createBotAccessRequests(): BotAccessRequests;
  ```
  - A choice that is not in `prompt.choices` is `invalid`, and the card keeps waiting.
  - For `"always"`, `always(prompt)` runs before the card settles. If it throws, the card keeps waiting and the error propagates.
  - While one answer is running, a second answer for the same `waitId` is `not_waiting`.
  - A request under the same `waitId` withdraws the stale card. An abort rejects with `signal.reason`. Listener throws are swallowed.
- Produces, in `bot-access-requests-main.ts`:
  ```ts
  export const botAccessRequests: BotAccessRequests;
  /** Desktop IPC, Remote and the issue card call this. Throws "That answer doesn’t match the card." for invalid. */
  export function answerBotAccessRequest(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean }>;
  ```
  - `always` calls `botApplicationService.grantBotFolder({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, ...prompt.grant })`.
  - It then broadcasts `bots:changed`, as `grantBotConnection` does (`bot-session-main.ts:769`).

- [ ] **Step 1: Write the failing tests** in `bot-access-requests.test.ts`:
  - `the first valid answer wins`.
  - `always is refused on a card that does not offer it`: the result is `invalid` and the card is still pending.
  - `a failing Always keeps the card open` (Review Focus 3): the `always` callback throws, `answer` rejects, and `pending(botId)` still lists the card.
  - `a second answer while Always is running is not_waiting`.
  - `pending never exposes the folder path`: there is no `grant` key in `pending()` items.
  - `abort withdraws the card and rejects with the reason`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Register and commit:** "Hold Bot access requests until the person answers".

### Task 6: `access_needed` Bot issues

**Files:**
- Modify: `renderer/shared/bot-issues.ts`:
  - the new kind `access_needed`;
  - the action `{ kind: "allow_folder" }`;
  - `BotIssue.access?`;
  - `botIssueActionOf` and the store parser.
- Modify: `main/services/bot-issues/service.ts` (the `BotIssueServiceActions.allowFolder` port; `act` case), `main/services/bot-issues/service-main.ts` (wire it to `botApplicationService.grantBotFolder`)
- Modify: `renderer/components/bots/bot-issue-card.tsx` (the action-label switch: `allow_folder` reads "Allow this folder")
- Modify: `main/services/aiden-remote-bot-issues.ts`. `toRemoteBotIssues` leaves out `access_needed` issues for now, because shipped phones decode a closed kind set. Task 9 lets holders of the new capability through.
- Test: `main/services/bot-issues/service.test.ts`, `renderer/components/bots/bot-issue-card.test.tsx`, `main/services/aiden-remote-bot-session.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type BotIssueKind = "preflight_failed" | "routine_failed" | "routine_paused" | "run_stalled" | "access_needed";
  // BotIssueAction gains: | { kind: "allow_folder" }
  // BotIssue gains: access?: { label: string; folderPath?: string; rootId?: string }  // folderPath absent for whole_mac
  // BotIssueServiceActions gains:
  allowFolder(botId: string, access: { folderPath: string; rootId?: string }): Promise<"added" | "already_allowed">;
  ```
  - `act` with `allow_folder` claims the issue, calls `allowFolder`, and settles it `fixed`. If the call throws, the claim is released, as `resume_routine` does.
  - An issue without `access.folderPath` never offers `allow_folder`.

- [ ] **Step 1: Write the failing tests:**
  - In `service.test.ts`:
    - `allow_folder grants the stored folder once and settles as fixed`: the fake `allowFolder` is called once with the issue's `folderPath`.
    - `allow_folder on an issue without a folder is invalid`.
    - `a failed grant leaves the issue open`.
  - In `bot-issue-card.test.tsx`, `an access issue offers Allow this folder and calls onAct with allow_folder`.
  - In `aiden-remote-bot-session.test.ts`, `access_needed issues are not sent to bot:issues devices`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsx --test main/services/bot-issues/service.test.ts renderer/components/bots/bot-issue-card.test.tsx main/services/aiden-remote-bot-session.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** "Raise a Needs you issue when a Bot needs a folder on an unattended turn".

### Task 7: The `request_access` tool and its policy

**Files:**
- Create: `main/services/bot-runtime/bot-access-request-tool.ts`, `main/services/bot-runtime/bot-access-request-tool.test.ts`
- Modify: `main/services/bot-runtime/bot-tool-policy.ts`:
  - `botRunUnattended`;
  - a verdict branch for `BOT_REQUEST_ACCESS_TOOL_NAME`. It is not added to `UNATTENDED_WITHHELD`, because unattended runs call it to raise the issue.
- Modify: `main/services/bot-runtime/bot-tool-sources-main.ts` (push the candidate beside `botHandoffCandidate`)
- Modify: `renderer/shared/bot-activity.ts:74,100`:
  - `TOOL_PHASES` gets `["request_access", "waiting"]`;
  - `TOOL_STEP_LABELS` gets `["request_access", "Asked you for access"]`.
- Test: `main/services/bot-runtime/bot-tool-policy.test.ts` (extend)

**Interfaces:**
- Consumes:
  - Task 1's contract;
  - Task 2's `resolveBotAccessTarget` and `coveredByBotLocations`;
  - Task 3's `botRunAccess`;
  - Task 5's `botAccessRequests`;
  - Task 6's `botIssues.raise`;
  - `botFileLocations(admission)` (`bot-tool-sources-main.ts:113`);
  - plan A's `bot:` prefix.
- Produces:
  ```ts
  // bot-tool-policy.ts
  /** Any input is routine:, tg:, or plan A's bot: / botreply: (use plan A's `isBotMessageRequestId` from renderer/shared/bot-messages.ts, never a second prefix check), so nobody can answer a card on this run. */
  export function botRunUnattended(requestIds: readonly (string | undefined)[]): boolean;
  // bot-access-request-tool.ts
  export const BOT_ACCESS_REQUEST_MEMO = "aiden.access-request";
  export interface BotAccessRequestToolDeps {
    requests: Pick<BotAccessRequests, "request">;
    runAccess: BotRunAccess;
    resolveTarget(requested: string): Promise<BotAccessResolution>;
    currentLocations(): Promise<readonly BotFileToolLocation[]>;   // from a fresh admission
    policyRevision(botId: string): Promise<string>;
    raiseIssue(input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">): Promise<unknown>;
  }
  export function botAccessRequestCandidate(botId: string, deps: BotAccessRequestToolDeps): BotToolCandidate; // replay "safe", interactive, executionMode "sequential"
  ```
- Parameters: `{ path: string (≤ 4,096; an absolute folder, "~/…", or "whole_mac"), why: string (1–400) }`.
- What Always grants is built from the resolution, and only when `always.kind !== "none"`: `{ folderPath: root, rootId?: always.rootId }`. The tool sets it as the card prompt's `grant` (Task 5) and as the issue's `access` (Task 6). Whole Mac carries neither.
- Verdict:
  - When `accessMode !== "custom"` or `files.mode === "full_mac"`, refuse with `"This Bot can already use your whole Mac."`.
  - When `files.mode === "off"`, refuse with `"File access is off for this Bot."`.
  - Otherwise allow.
- Execute order. The first step that applies returns.
  1. A `refused` target returns an error result:
     - `filesystem_root`: `"Ask for \"whole_mac\" to use the whole Mac."`
     - `private`: `"That folder belongs to Aiden and can't be shared with a Bot."`
     - `not_found`: `"That folder doesn't exist."`
     - `not_absolute`: `"Give the folder's full path, like ~/Documents/Taxes."`
  2. A folder that `coveredByBotLocations` already covers, or that matches this run's grant, gives `outcome: "already_allowed"`.
  3. `runAccess.declined(...)` gives `outcome: "declined_earlier"`, with `"The person already said not now to this in this task. Carry on without it."`
  4. On an unattended run, raise an issue and return `outcome: "asked_later"`:
     - the issue: `kind: "access_needed"`, `dedupeKey: "access:" + key`, title `"Wants to use {label}"`, body = `why` bounded to 280;
     - its actions: `[allow_folder]` when `always.kind !== "none"`; for whole Mac and other `none` cases, `[{ kind: "open_settings", section: "access" }]`;
     - the result text: `"Nobody can answer a card on this turn, so the person will see this request in your chat. Carry on without it and say what is waiting on it."`
  5. Otherwise, take the memo `waitId`, request the card (`choices` from `botAccessChoicesFor`), then:
     - `once` or `always`: call `runAccess.grant` with the revision read after the answer. The text is `"The person allowed {label} for this task. Use the file tools with location \"run.access\" to reach it."` Always adds `" It stays allowed from your next task."`
     - `not_now`: call `runAccess.decline`. The text is `"The person said not now. Carry on without {label} and tell them what you couldn't do."`

- [ ] **Step 1: Write the failing tests** in `bot-access-request-tool.test.ts`, with fake deps and a real `createBotAccessRequests` and `createBotRunAccess`:
  - `asks once and grants the run on Allow once`. Answer `once` through the bridge. The result details are `{outcome: "once"}`, and `runAccess.location(botId, ["r1"], rev)` has the folder's root.
  - `a Resume re-asks under the same waitId`: the same `memo` gives the same `waitId` on a second execute.
  - `a whole-Mac card never offers Always`: the pending card's `choices` deep-equal `["not_now", "once"]`.
  - `a routine run raises one access issue and shows no card`, with `runRequestIds: ["routine:t1:1"]`. `raiseIssue` is called once with `kind: "access_needed"`, and `pending()` is empty. Repeat with `tg:1` and `bot:ada:1:d1`.
  - `a second request after Not now shows no card` (Review Focus 5).
  - `a folder the Bot can already use needs no card`.
  - `Stop withdraws the card and records no answer`: abort the signal, and `execute` rejects.
- [ ] **Step 2: Extend `bot-tool-policy.test.ts`:**
  - `request_access is offered to a scoped Custom Bot and refused for Full access, Full Mac and Files off`;
  - `botRunUnattended is true when any input is routine, Telegram or bot`.
- [ ] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-access-request-tool.test.ts main/services/bot-runtime/bot-tool-policy.test.ts`.
- [ ] **Step 4: Implement and wire.** `currentLocations` admits fresh through `deps.admit(botId)` and releases the admission in `finally`.
- [ ] **Step 5: Run** the files and `npm run test:bot-handoffs`. Expected: PASS.
- [ ] **Step 6: Register and commit:** "Let a Bot ask to use a folder outside its own".

### Task 8: The desktop card

**Files:**
- Modify: `main/services/bot-runtime/live-projection.ts`, `renderer/shared/bot-live.ts`, in the same shape as `handoff` (`:926`, `:1016`, `:1159`, `:1410`):
  - the `accessRequest?(botId)` dep;
  - `snapshot.accessRequest?: BotPendingAccessRequest | null`;
  - the `{ type: "access_request"; accessRequest }` event;
  - `refreshAccessRequest(botId)`;
  - `needsYou` counts the card.
- Modify: `main/services/bot-runtime/bot-session-main.ts`. Wire the projection from `botAccessRequests.onChange`, add `accessRequests` to `wireBotAttention`, and add a second `createBotHandoffNotifier` fed by a `watchBotAccessRequests` helper (below).
- Modify: `main/services/bot-runtime/bot-attention.ts` (the `accessRequests: Pick<BotAccessRequests, "onChange">` dep)
- Modify: `main/services/bot-runtime/bot-handoff-notifications.ts`. Add `watchBotAccessRequests(requests, notifier)`, which offers `{ ...request, kind: "action", action: botAccessCardTitle(...), source: "tool" }` to `notifier.opened`, so the body reads "Ada needs you to: …".
- Create: `main/handlers/bot-access-requests.ts`, `main/handlers/bot-access-requests.test.ts`
- Modify:
  - `main/handlers/bot-params.ts`: `parseBotAccessAnswer`;
  - `main/handlers/bots.ts`: register beside `registerBotHandoffHandlers`;
  - `renderer/lib/ipc.ts:1788`: `answerAccessRequest`.
- Create: `renderer/components/bots/access-request-card.tsx`, `renderer/components/bots/access-request-card.test.tsx`
- Modify: `renderer/main/bots/bot-chat-pane.tsx:1503` (mount the card in the approvals container, above the composer, beside `HandoffCard`)

**Interfaces:**
- Produces:
  ```ts
  export const BOT_ANSWER_ACCESS_REQUEST_CHANNEL = "bots:answerAccessRequest";
  export function registerBotAccessRequestHandlers<Event = unknown>(deps: {
    handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
    answer(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean }>; // answerBotAccessRequest
  }): void;
  export function parseBotAccessAnswer(input: unknown): { botId: string; waitId: string; choice: BotAccessChoice };
  // renderer/lib/ipc.ts, bots:
  answerAccessRequest(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean }>;
  // card
  export function AccessRequestCard(props: {
    request: BotPendingAccessRequest; botName?: string; avatar?: BotAvatarValue;
    busy: boolean; onAnswer(choice: BotAccessChoice): void;
  }): JSX.Element;
  ```
- **The card.**
  - It sits on `BotNoticeCard`, with the Bot's avatar in the tile and a lucide `FolderOpen` or `Laptop` glyph.
  - The title comes from `botAccessCardTitle`. Below it are `place` (folder only) and `why`.
  - There is one squircle button per choice, in `choices` order. The last is the primary.
  - All buttons are disabled while an answer is in flight. A thrown answer, such as an Always drift refusal, toasts its message and keeps the card.
  - The composer is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - In `access-request-card.test.tsx`:
    - `a folder card shows its title, place and why, and three buttons in order`;
    - `a whole-Mac card has no Always`;
    - `buttons are reachable in tab order and disabled while busy`;
    - `clicking Always for this folder calls onAnswer("always")`.
  - In `bot-access-requests.test.ts` (handlers):
    - `bots:answerAccessRequest rejects an unknown choice`;
    - `an invalid answer throws the card message`. This is a register-and-invoke test, as in `main/handlers/bot-handoffs.test.ts`.
  - Extend the `live-projection` suite: `a waiting access request makes the Bot need the person, and its answer clears it`.
  - Extend the `bot-attention` suite: `an access request broadcasts bots:attention`.
  - Extend the `bot-handoff-notifications` suite: `an access card notifies once, only when no window is focused`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Reuse the in-flight counting pattern from `use-bot-handoff-actions.ts` for `busy`.
- [ ] **Step 4: Run** `npx tsx --test renderer/components/bots/access-request-card.test.tsx main/handlers/bot-access-requests.test.ts main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-attention.test.ts main/services/bot-runtime/bot-handoff-notifications.test.ts`, and `npm run test:bot-handoffs`. Expected: PASS.
- [ ] **Step 5: Register and commit:** "Show a Bot's access request in its chat".

### Task 9: Phones (Remote `bot:access-requests`)

**Files:**
- Modify: `main/services/aiden-remote-protocol.ts`:
  - `AIDEN_REMOTE_BOT_ACCESS_REQUESTS_CONTRACT_REVISION` (provisional, the next after `main`'s), with `AIDEN_REMOTE_CONTRACT_REVISION` pointing at it;
  - `AIDEN_REMOTE_BOT_ACCESS_REQUEST_CAPABILITIES = ["bot:access-requests"]`, added to `AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES`;
  - `AidenRemoteBotAccessRequest`, `parseAidenRemoteBotAccessRequest` and the answer request and receipt parsers;
  - `AIDEN_REMOTE_BOT_ISSUE_KINDS` and the action kinds gain `access_needed` and `allow_folder`, for holders only.
- Modify:
  - `main/services/aiden-remote-bot-session.ts`: the snapshot `accessRequest`, the `access_request` frame, and the legacy line;
  - `main/services/aiden-remote-bot-issues.ts`: holders get `access_needed`;
  - `main/services/aiden-remote-router.ts`: the route, next to `botHandoffAnswer` at `:534`;
  - `main/services/aiden-remote-service-main.ts`: wiring.
- Modify: `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json` (a `botAccessRequests` section beside `botHandoffs`), `docs/aiden-remote-api-v1.md`
- Modify (iOS):
  - `ios/AidenOnTheGo/Models/AidenBotSession.swift`: decode, and add the issue kind and action;
  - `Networking/AidenRemoteContract.swift`, `Networking/AidenRemoteClient.swift`: negotiation and the answer call;
  - `Features/Bots/AidenBotSessionModel.swift`;
  - `Features/Bots/AidenBotSessionChatView.swift`: a card next to `AidenBotHandoffCard`.
- Modify (Android):
  - `models/AidenBotSession.kt`;
  - `networking/AidenRemoteClient.kt`;
  - `features/bots/AidenBotSessionController.kt`;
  - `features/bots/AidenBotSessionScreen.kt`: a card next to `AidenBotHandoffCard`.
- Test:
  - `main/services/aiden-remote-bot-session.test.ts`, `main/services/aiden-remote-protocol.test.ts`, the router suite;
  - iOS `ios/AidenOnTheGoTests/AidenBotSessionTests.swift` and `AidenRemotePhase0Tests.swift:174`;
  - Android `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotAccessRequestsContractTest.kt` (new; register it wherever `AidenBotHandoffsContractTest.kt` is listed).

**Interfaces:**
- Produces:
  ```ts
  export interface AidenRemoteBotAccessRequest {
    waitId: string;                        // ^[A-Za-z0-9-]{1,64}$
    target: "folder" | "whole_mac";
    label: string;                          // ≤ 120
    place?: string;                         // folder only, ≤ 512, starts with "~/" or "/"
    why: string;                            // 1–400
    choices: Array<"once" | "always" | "not_now">; // whole_mac never has "always"
  }
  // POST /bots/{botId}/access-requests/{waitId}/answer, with Idempotency-Key, body { choice }
  // → 200 { answered: true }; 409 access_request_expired when nothing waits; 400 invalid_request for a choice not offered.
  export interface AidenRemoteBotAccessAnswerRequest { choice: "once" | "always" | "not_now" }
  ```
  - Holders get `accessRequest` in the session snapshot and `{ accessRequest }` frames, through the same serialized projection as `handoff`.
  - Devices without the capability get an assistant line, id `access-notice:<waitId>`, reading `"{Bot} needs you on your Mac: allow access to {label}"`. When the card settles, they get a snapshot, as `legacyHandoffNotice` does in `aiden-remote-bot-handoffs.ts:84`.
  - Paired desktops are a legacy audience in this revision and see that line.
  - The route needs `bot:read`, `bot:write` and `bot:access-requests`. It calls `answerBotAccessRequest`.

- [ ] **Step 1: Failing host tests:**
  - `the access card is sent only to bot:access-requests devices; others get one notice line that a snapshot removes when it settles`;
  - `answer always reaches answerBotAccessRequest once per Idempotency-Key`;
  - `a choice the card doesn't offer is 400`;
  - `an answered card is access_request_expired`;
  - `access_needed issues reach holders and never bot:issues-only devices`;
  - `the server feature list stays within AIDEN_REMOTE_MAX_SERVER_FEATURES`.
- [ ] **Step 2: Implement the host side and the fixtures.**
- [ ] **Step 3: Native clients.**
  - Negotiate `bot:access-requests` in its own `POST /device/capabilities` call, only when the host lists it. A 400 or 404 is ignored (`.memory/bot-handoffs-clients.md`).
  - Decode `accessRequest`, render a card with the offered buttons, and post the answer with a per-`waitId` Idempotency-Key that is kept across a lost response.
  - Claim the card optimistically. On `access_request_expired`, it stays gone. On any other failure it comes back with `"That answer wasn't sent. Please try again."`.
  - Decode `access_needed` and `allow_folder`.
  - Tests: decode the fixture section; tapping each button posts the right body; a whole-Mac card shows no Always.
- [ ] **Step 4: Run** `npx tsx --test main/services/aiden-remote-bot-session.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts`, the iOS focused tests (the command in `ios/README.md`), and `./gradlew :app:testDebugUnitTest --tests '*AidenBotAccessRequests*' --tests '*AidenBotIssue*'`. Expected: PASS.
- [ ] **Step 5: Commit:** "Answer Bot access requests from phones".

### Task 10: Docs, memory, plan index and onboarding check

**Files:**
- Modify: `README.md` and `PRODUCT.md` (Bots: a Custom Bot can ask for a folder; Allow once, Always, Not now; Whole Mac once only)
- Modify: `docs/aiden-remote-api-v1.md` (if Task 9 did not cover every route and error code)
- Modify: `docs/cli-durable-bots.md` and `packages/cli/README.md` (the CLI host doesn't offer `request_access`)
- Modify: `docs/plans/README.md` (add a plan B row under the Bot messaging entry, with its status)
- Create: `.memory/bot-access-requests.md`, covering:
  - layout and constants;
  - the `run.access` late location;
  - that Allow once is memory-only;
  - Always through `grantBotFolder`, and the shared approved-roots list;
  - the Remote revision;
  - known limits: paired desktops see the notice line, and there is no CLI tool.
- Modify: `.memory/bot-durable-runtime.md` (one line under Connections, linking the folder grant beside "Add to this Bot")

- [ ] **Step 1: Search for stale claims.** Run `rg -n "approved location|Custom access|request_access|hand_off" README.md PRODUCT.md docs/*.md packages/cli/README.md`, and fix each statement this plan made stale.
- [ ] **Step 2: Onboarding review.** New Bots keep Full access and never see this tool, so `renderer/components/onboarding-feature-gallery.tsx` and the onboarding flow stay unchanged. Record that decision in the PR description.
- [ ] **Step 3: Run** `npm run test:bot-access`, `npm run test:bot-handoffs`, `npm run test:bot-runtime`, `npm run test:bots` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [ ] **Step 4: Commit:** "Document Bot access requests".
