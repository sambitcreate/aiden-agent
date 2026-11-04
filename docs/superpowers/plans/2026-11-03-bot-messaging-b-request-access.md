# Bot messaging B: `request_access` Implementation Plan

> **Execution:** Follow the numbered tasks and the review gates in [the master plan](../../plans/bot-messaging-plan.md#how-it-gets-built). The main session owns implementation and commits. Fresh read-only Opus 5.5 medium and OpenCode Go DeepSeek V4.1 Flash high reviewers check each gate. No additional execution skill is required. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Custom-access Bot that is held to its own folder can ask the person to use a folder outside it, or the whole Mac. The person answers on a card with **Allow once**, **Always for this folder** or **Not now**, on the Mac or a phone. On turns nobody watches, the request becomes a "Needs you" Bot issue.

**Architecture:**
- **The tool.** A new durable tool, `request_access`, follows the `hand_off` pattern. The memo holds a logical `requestId`; each genuine authorization attempt has its own `waitId`, the tool is `interactive` and `replay: "safe"`, and a new bridge, `bot-access-requests.ts`, holds the waiting card.
- **Allow once** is an in-memory grant for the run that asked. The file tools reach it through one stable extra location, `run.access`, which is resolved at each call. Tools are only rebuilt when a run starts, so this extra location is what lets the same run use the folder.
- **Always** adds an `approved_location` to the Bot's Custom grants through a new `grantBotFolder`. It uses the same `updateBotAccess({ refuseDriftedGrants: true })` path as "Add to this Bot" for connections, under the policy revision.
- **Unattended turns** raise an `access_needed` Bot issue instead of a card.
- **Phones** get the card and the new issue kind under one Remote revision.

**Tech Stack:** TypeScript, Electron main and renderer (React), Pi Durable (pinned, unchanged), `node:test` through `tsx --test`, Testing Library, Swift (iOS), Kotlin (Android).

**Spec:** [`docs/plans/bot-to-bot-messaging-research.md`](../../plans/bot-to-bot-messaging-research.md) §3 (constraints 1 and 3), §9, §11.2–11.3, §14 step 2. Plan A (`message_bot`) lands first and defines the `bot:` turn kind. This plan consumes A's shared turn helpers and host-owned ingress provenance, not independent prefix parsing.

## Global Constraints

- Read `AGENTS.md` first. Tests are behavioral only: never `readFileSync` production source and `assert.match` it, and write no tautological or change-detector tests.
- Register every new test file in a new `"test:bot-access"` script, with `"pretest:bot-access": "npm run build:lease-flock"`, and in the `scripts/ci-test-registry.json` lane that holds `bot-handoff-*` tests. `scripts/ci-test-registry.test.mjs` fails if either is missing. Append `test:bot-access` to `test:serial`, which the CI registry uses to discover membership.
- **Who gets the tool.** It is offered only when `authority.accessMode === "custom" && authority.files.mode === "scoped"`. New Bots keep Full access (spec §11.2), so Full-access Bots, Custom Bots that already have Full Mac, and Bots with Files off never get it.
- **Whole Mac** is only ever **Allow once**. It is never Always, never an issue action, and never a saved grant.
- **Only the person grants.** A Bot's model, another Bot's `bot:` message, or a routine can never answer the card or the issue (spec §3, constraint 1). Always goes only through `grantBotFolder`, which saves with `refuseDriftedGrants`.
- **Unattended turns** never show a card: `routine:`, `tg:`, plan A's `bot:`, and plan A's `botreply:` if plan A defines it. A run joined by any of those counts as unattended, the same rule `hand_off` uses.
- **No network.** Nothing here contacts a server.
- **A folder allowed for a Bot stays off phones (owner pick 5).** A new root from `grantBotFolder` is marked `botsOnly: true`. It feeds the Bot catalog like any approved root, and it never reaches a paired device's file browser or the count and list in Settings → Aiden on the Go. Reusing an exact root the person already approved leaves that root as it is.
- **Remote.** Claim the next contract revision after `main`'s at merge. It is 53 today (`main/services/aiden-remote-protocol.ts:288`), and plan A claims one first. Change these together: iOS, Android, `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`, `docs/aiden-remote-api-v1.md` and `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:174`.
- **UI.** Follow `GUI.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Use the shared squircle buttons and `BotNoticeCard`. Use no decorative borders, keep `focus-visible` rings, and use no brain icons.
- **Electron imports.** Modules under `main/services/` must not import `electron`, except the `*-main.ts` wiring files.
- **CLI.** The CLI's durable Bot host (`packages/cli/src/bot-durable.ts`) builds its own tool list and gets no `request_access`. The docs say so.
- **Pre-1.0:** delete legacy shapes rather than migrating them. Never use bare `git stash`.

## Review Focus

1. **Allow once must not outlive its run.** A follow-up turn uses new request ids, so it is refused. A person's steer that joins the run is allowed. After a quit, Resume has no grant, so the Bot asks again. Task 3 tests this.
2. **Always must not widen access.** If the Bot asks for `~/Documents/Taxes` while `~/Documents` is already an approved root, Always is not offered, and the larger root is never granted. Task 2 tests this.
3. **Access can change while the card waits.** If the person edits the Bot's access in Settings meanwhile, Always refuses with no write and no new approved root. A definite stale attempt closes with a non-decline access-changed result, so the Bot can ask again. A policy-revision change also drops an Allow once. A card stores the revision it showed; an answer cannot adopt a newer revision. Directory replacement and newly overlapping roots also invalidate the card. Tasks 2-5 and 7 test this.
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

- [x] **Step 1: Write the failing tests** in `bot-access-requests.test.ts`:
  - `whole Mac is only ever Allow once`: `botAccessChoicesFor({target: "whole_mac", alwaysOffered: true})` deep-equals `["not_now", "once"]`.
  - `a folder offers Always only when allowed`: `{target: "folder", alwaysOffered: true}` gives `["not_now", "always", "once"]`, and `false` gives `["not_now", "once"]`.
  - `the parser refuses a whole-Mac card that offers always`: `botPendingAccessRequestOf({...valid, target: "whole_mac", choices: ["not_now", "once", "always"]})` is `null`.
  - `the parser refuses unknown keys, a blank why, and a why over 400 characters`.
  - `titles read as the card says`: `botAccessCardTitle("Ada", {target: "folder", label: "Taxes"}) === "Ada wants to use Taxes"`.
  - `parseBotAccessChoice` accepts the three choices and rejects `"allow"`.
- [x] **Step 2: Run and see them fail.** `npx tsx --test renderer/shared/bot-access-requests.test.ts`. Expected: FAIL, module not found.
- [x] **Step 3: Implement.** `why` and `label` go through `withoutBotHandoffControls` (`renderer/shared/bot-handoffs.ts`) before the bounds are checked. Bounds use `isBoundedBotText`.
- [x] **Step 4: Run.** Expected: PASS.
- [x] **Step 5: Register `test:bot-access` and the CI lane, then commit:** "Add the Bot access-request contract".


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
  export function coveredByBotLocations(root: string, locations: readonly Pick<BotFileToolLocation, "root" | "access">[], requiredAccess: "read" | "write" = "read"): boolean; // write requires a write-enabled containing location
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

- [x] **Step 1: Write the failing tests** with `mkdtemp` folders and a fake home:
  - `a file resolves to its folder`: requesting `<tmp>/Taxes/2025.pdf` gives `kind: "folder"`, `root: <real tmp>/Taxes`, `label: "Taxes"`.
  - `a symlink into Aiden's storage is refused` (Review Focus 4). `<tmp>/link -> <private>/bots/x` gives `{kind: "refused", reason: "private"}`.
  - `a folder inside an approved root never offers Always` (Review Focus 2). With roots `[{id: "root_a", folderPath: <tmp>/Documents}]`, requesting `<tmp>/Documents/Taxes` gives `always.kind === "none"` and `reason === "covered"`.
  - `an exact approved root is reused`: this gives `{kind: "existing", rootId: "root_a"}`.
  - `a folder holding an approved root offers no Always`: this gives `reason: "overlaps"`.
  - `the home folder is Allow once only`: this gives `reason: "home"`.
  - `~ paths expand and relative paths are refused`.
  - `coveredByBotLocations` is true for a subfolder of a location root, and false for a sibling whose name shares a prefix (`/a/b` against `/a/bc`).
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-access-target.test.ts`.
- [x] **Step 3: Implement** with the default filesystem from `node:fs/promises` (`stat` with `{ bigint: true }`), as `aiden-remote-approved-roots.ts` does.
- [x] **Step 4: Run.** Expected: PASS.
- [x] **Step 5: Register and commit:** "Resolve the folder a Bot asks for".


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
    policyRevision: string;                 // revision validated against the card snapshot
    access: "read" | "write";                // request_access grants write; Plan C may grant read
    owner: { kind: "access" | "plan"; id: string }; // waitId or planId
    expiresAt: number;                       // no later than its owner's deadline
    grantedAt: number;
  }
  export interface BotRunAccess {
    grant(botId: string, grant: BotRunAccessGrant): void;             // the newest grant for an overlapping run replaces the older one
    location(botId: string, requestIds: readonly (string | undefined)[], policyRevision: string): BotFileToolLocation | undefined;
    decline(botId: string, requestIds: readonly string[], key: string): void;
    declined(botId: string, requestIds: readonly (string | undefined)[], key: string): boolean;
    revokeOwner(botId: string, owner: { kind: "access" | "plan"; id: string }): void;
    clearBot(botId: string): void;
  }
  export function createBotRunAccess(deps: { now(): number }): BotRunAccess;
  export function botRunEnded(state: BotSessionState): boolean; // idle, needs_model, model_error, unavailable, or paused without `interrupted`
  ```
  - `location` returns `{ id: BOT_RUN_ACCESS_LOCATION_ID, label: BOT_RUN_ACCESS_LOCATION_LABEL, root, expectedIdentity }` only when one of the call's request ids is in `grant.requestIds`, the revision matches, and the grant is younger than 60 minutes and before `expiresAt`. A plan grant is also revoked on every Plan C termination path. Sharing an input is only evidence of the same live run; prove with the real harness that a queued follow-up/new run cannot inherit it. Keep steers that actually join the run supported.
  - The store is in memory only. A quit ends Allow once, and the Bot asks again on Resume.
- Router (`bot-file-tool-router.ts`):
  ```ts
  readonly lateLocation?: { readonly id: string; readonly label: string; resolve(): Promise<BotFileToolLocation | undefined> };
  ```
  - It is declared in the `location` schema after the fixed locations.
  - A call to it resolves its location on each execution, then runs the underlying tool for that location. Add `BotFileToolLocation.access?: "read" | "write"`, with omitted meaning existing write behavior. Preserve it through `checkedLocation` and reject `write_file`/`edit_file` for a read location before invoking any mutator. The protected-root, skill-directory, expected-identity and root-redaction checks run exactly as for a fixed location. A read grant never narrows independently granted fixed locations.
  - An unresolved location throws `"Nothing extra is allowed for this task yet. Ask with request_access first."`.
- `BotFileCandidateInput.runAccess?: { resolve(call: BotToolCall): Promise<BotFileToolLocation | undefined> }`. The bound tool passes `lateLocation` with `resolve: () => input.runAccess.resolve(call)`.
- `BotToolSourceDeps.policyRevision(botId: string): Promise<string>`. In `bot-session-main.ts`, this is `(await botCapabilityStore.getBotPolicy(botId)).revision`.
- Exported singleton in `bot-tool-sources-main.ts`: `export const botRunAccess = createBotRunAccess({ now: Date.now })`.

- [x] **Step 1: Write the failing tests:**
  - In `bot-run-access.test.ts`:
    - `a grant serves only its own run` (Review Focus 1). A grant for `["r1"]` gives a location for `["r1"]` and for `["r1", "r2"]` (a steer joined), and `undefined` for `["r3"]`.
    - `a changed policy revision drops the grant` (Review Focus 3).
    - `a grant expires after 60 minutes`, using a fake clock.
    - `clearBot forgets grants and declines`.
    - `revokeOwner removes only that owner's grant`: stopping a plan does not clear a later independent access grant.
    - `a read grant refuses writes and edits`: real file tools read a fixture but cannot mutate it via direct or nested codemode calls; a write grant permits the intended change.
    - Real-harness run scope: a steer joining the same run can use the grant, while a queued follow-up and a later run cannot, including after restart.
    - `botRunEnded` is true for `{kind: "idle"}`, and false for `running`, `interrupted`, and `paused` with `interrupted`.
  - In `bot-file-tool-router.test.ts`, `a late location reads inside its resolved root`: `read_file` with `location: "run.access"` reads a fixture file. Two more checks:
    - `an unresolved late location explains how to ask`;
    - `a late Full Mac location still refuses writes into protected roots`.
  - In `bot-file-candidates.test.ts`, `a bound file tool uses run access only for the run it serves`. Use a fake `call.runRequestIds` and a real `createBotRunAccess`.
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-run-access.test.ts main/services/bot-file-tool-router.test.ts main/services/bot-runtime/bot-file-candidates.test.ts`.
- [x] **Step 3: Implement** the store, the router's `lateLocation` and the candidate input, then wire them in tool sources and session main.
- [x] **Step 4: Run** the three files and `npm run test:bot-runtime`. Expected: PASS.
- [x] **Step 5: Register and commit:** "Give a Bot's run the folder the person allowed once".


### Task 4: Always for this folder (`grantBotFolder`)

**Files:**
- Modify: `main/services/bot-application-service.ts`:
  - the new dependency `approvedFolders`;
  - `updateBotAccess`'s `refuseDriftedGrants` accepts `{ message: string }`;
  - the new `grantBotFolder`, next to `grantBotConnection` at `:1725`.
- Modify: `main/services/bot-application-service-main.ts` (wire `approvedFolders` through a dynamic `import("./aiden-remote-service-main.js")`, as `listApprovedLocations` does in `bot-capability-services-main.ts:247`)
- Modify: `main/services/aiden-remote-state.ts:56` (`AidenRemoteApprovedRoot.botsOnly?: true`, kept by the state parser)
- Modify: `main/services/aiden-remote-approved-roots.ts` (`addLocalFolder(path, { botsOnly: true })`; a plain `addLocalFolder` of the same folder clears the mark, because the person has now approved it for phones)
- Modify: `main/services/aiden-remote-workspace-browser.ts:130,203` (skip `botsOnly` roots), `main/services/aiden-remote-service.ts:1663` (not counted), `main/handlers/aiden-remote.ts:38` (not listed)
- Test: `main/services/aiden-remote-workspace-browser.test.ts` and the approved-roots test (extend)
- Test: `main/services/bot-application-service.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // BotApplicationDependencies
  approvedFolders?: {
    list(): Promise<readonly { id: string; folderPath: string }[]>;          // runtime.state.snapshot().approvedRoots
    add(folderPath: string): Promise<{ id: string }>;                        // runtime.approvedRoots.addLocalFolder(folderPath, { botsOnly: true })
  };
  // service
  grantBotFolder(input: { audienceId: string; botId: string; folderPath: string; rootId?: string;
    expectedRevision: string; expectedIdentity: { device: string; inode: string }; operationId: string;
  }): Promise<"added" | "already_allowed">;
  ```
- Behavior:
  - First compare the saved policy with `expectedRevision`, re-resolve the requested canonical root and pinned directory identity, recheck private paths and current root overlaps, and confirm that Custom scoped file access still permits this action. A stale authorization snapshot is an error, including after switching to Full or Files off; do not turn the stale card into a successful answer. A fresh service call for an already-allowed exact folder may return `"already_allowed"`.
  - **Drift pre-check.** Before any new approved root is added, run the same `deps.catalog.reconcile(savedBinding, …)` check that `updateBotAccess` runs. If it is not `ready`, throw the drift message and write nothing.
  - **The root and save transaction.** Journal a grant operation under `operationId`, including the authorization snapshot and ownership of any newly created `botsOnly` root. Revalidate under the inventory lease used for binding, before root creation and before policy publish. Use `rootId` only when path AND pinned identity match; otherwise create only the exact revalidated root. If policy saving fails, roll back a root created by this operation only when no other committed grant references it. Never delete a reused root. Recovery completes or compensates an unfinished journal entry before serving another grant, so failed answers leave no orphan root or hidden authority. No network or VM operation is involved.
  - **The option.** Find the snapshot's `fileScopes` entry with that `sourceId` and `kind: "approved_location"`. If it is missing or unavailable, throw `"That folder can't be added right now."`.
  - If the option is already selected, the result is `"already_allowed"`.
  - **The save.** Call `updateBotAccess` with:
    - `expectedRevision: input.expectedRevision`;
    - `refuseDriftedGrants: { message: "Some of this Bot's access changed since you last saved it. Review it in the Bot's settings first." }`;
    - `fileScopeIds: nextBotFileScopeIds(policy.custom.fileScopeIds, snapshot.catalog.fileScopes, option.id, true)` (`renderer/shared/bot-capabilities.ts:472`, which keeps `bot_home`).
  - The connection grant keeps its current message, so `refuseDriftedGrants: true` reads as before.

- [x] **Step 1: Write the failing tests**, with the existing fakes for `grantBotConnection`:
  - `grantBotFolder adds one approved location and keeps the rest`. After the call, the saved `custom.fileScopeIds` holds the earlier ids plus the new option id, and `bot_home`'s id is still there.
  - `grantBotFolder reuses an exact approved root`: `approvedFolders.add` is never called.
  - `grantBotFolder refuses drifted grants with no write and no new root` (Review Focus 3). The save count and the `add` count both stay 0, and it rejects with the message above.
  - `a stale card after switching access mode refuses`: an old expected revision gives no grant or root.
  - Card/issue race tests: replace the folder inode, turn Files off, change selections, and add an overlapping approved root while waiting. Once and Always refuse the stale snapshot.
  - Crash-injection grant journal tests: interruption after root creation or before policy publish is compensated or finished once; a reused/shared root is never removed. A failing save leaves no new root.
  - `a folder allowed for a Bot isn't browsable from a phone`: after `add(path, {botsOnly: true})`, `listRoots(deviceId)` has no entry for it, and browsing its root id is refused the same way as an unknown root. The Bot catalog's `listApprovedLocations` still lists it.
  - `approving the same folder for phones clears the mark`: a later plain `addLocalFolder(path)` returns the same root, and `listRoots` now shows it.
  - `the connection grant's drift message is unchanged`. Extend the existing drift test for `grantBotConnection`.
- [x] **Step 2: Run and see them fail.** `npx tsx --test main/services/bot-application-service.test.ts`.
- [x] **Step 3: Implement and wire.**
- [x] **Step 4: Run** the file and `npm run test:bots`. Expected: PASS.
- [x] **Step 5: Commit:** "Let the person add a folder to a Bot's access".


### Task 5: The access-request bridge and its answer

**Files:**
- Create: `main/services/bot-runtime/bot-access-requests.ts`, `main/services/bot-runtime/bot-access-requests.test.ts`
- Create: `main/services/bot-runtime/bot-access-requests-main.ts`

**Interfaces:**
- Produces, in `bot-access-requests.ts`, built like `bot-questions.ts`:
  ```ts
  export interface BotAccessAuthorization {
    policyRevision: string;
    requestIds: readonly string[];
    target: "folder" | "whole_mac";
    root: string;
    identity?: { device: string; inode: string };
    rootId?: string;
    choices: readonly BotAccessChoice[];
    // Captured from a fresh admission; never supplied by a renderer or model.
  }
  export interface BotAccessRequestPrompt extends BotPendingAccessRequest {
    logicalRequestId: string; // main-only durable tool request, distinct from this card's waitId
    /** Main-only authorization snapshot. Never projected to the renderer or wire. */
    authorization: BotAccessAuthorization;
    grant?: { folderPath: string; rootId?: string };
  }
  export type BotAccessAnswerOutcome = "answered" | "not_waiting" | "invalid";
  export interface BotAccessRequests {
    request(prompt: Omit<BotAccessRequestPrompt, "waitId"> & { signal: AbortSignal | undefined }): Promise<{ choice: BotAccessChoice; waitId: string }>; // allocates or reuses the current live attempt
    // The result carries the attempt id; D may add a recorded hint alongside it.
    answer(botId: string, waitId: string, choice: BotAccessChoice, authorize: (prompt: BotAccessRequestPrompt, choice: BotAccessChoice) => Promise<void>): Promise<BotAccessAnswerOutcome>;
    pending(botId?: string): BotPendingAccessRequest[];   // without `grant`
    get(botId: string, waitId: string): BotPendingAccessRequest | undefined;
    onChange(listener: (botId: string) => void): () => void;
  }
  export function createBotAccessRequests(): BotAccessRequests;
  ```
  - A choice that is not in `prompt.choices` is `invalid`, and the card keeps waiting.
  - Replace the Always-only callback with `authorize(prompt, choice)` for both `once` and `always`. It runs before settlement and revalidates the immutable authorization snapshot, current run/deadline, choices, canonical root and identity. It must not adopt a new revision. A typed, definite pre-effect stale refusal withdraws the attempt and returns `access_changed` without recording a decline. A transient I/O failure keeps the card retryable. The Bot must make a fresh request before a changed scope can be approved. Always additionally runs the journaled persistent grant; once issues only the validated ephemeral grant.
  - While one answer is running, a second answer for the same `waitId` is `not_waiting`.
  - A logical `requestId` identifies the durable tool request, not a person decision. A live unchanged authorization attempt reuses its current `waitId`, including transport retries. After quit/abort, or when a changed authorization snapshot deliberately needs a new card, allocate a new random `waitId` and withdraw the old attempt. A late answer to the old id is `not_waiting`; an abort rejects with `signal.reason`. Listener throws are swallowed. Never reuse a prior decision id for a deliberate reapproval.
- Produces, in `bot-access-requests-main.ts`:
  ```ts
  export const botAccessRequests: BotAccessRequests;
  /** Desktop IPC, Remote and the issue card call this. Throws "That answer doesn’t match the card." for invalid. */
  export function answerBotAccessRequest(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean; savedForFuture?: true }>;
  ```
  - `once` validates and issues a run grant under the captured revision. `always` calls `botApplicationService.grantBotFolder` with the captured revision/identity and stable `operationId = waitId` for this authorization attempt, then issues the run grant under the resulting validated policy revision. Both use `prompt.authorization`, not current values substituted for the original authorization.
  - It then broadcasts `bots:changed`, as `grantBotConnection` does (`bot-session-main.ts:769`).

- [x] **Step 1: Write the failing tests** in `bot-access-requests.test.ts`:
  - `the first valid answer wins`.
  - `always is refused on a card that does not offer it`: the result is `invalid` and the card is still pending.
  - `a transient failing Always keeps the card open`: the `always` callback throws a transient error, `answer` rejects, and `pending(botId)` still lists the card.
  - `a second answer while Always is running is not_waiting`.
  - `pending never exposes the authorization snapshot`: neither `grant` nor `authorization` is in `pending()` items. The intentionally displayed bounded `place` remains.
  - `abort withdraws the card and rejects with the reason`.
- [x] **Step 2: Run and see them fail.**
- [x] **Step 3: Implement both files.**
- [x] **Step 4: Run.** Expected: PASS.
- [x] **Step 5: Register and commit:** "Hold Bot access requests until the person answers".


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
  // BotIssue gains: access?: { label: string; folderPath?: string; rootId?: string; authorization: BotAccessAuthorization }  // folderPath absent for whole_mac; authorization is main-only
  // BotIssueServiceActions gains:
  allowFolder(botId: string, access: { folderPath: string; rootId?: string; authorization: BotAccessAuthorization }, operationId: string): Promise<"added" | "already_allowed">;
  ```
  - `act` with `allow_folder` claims the issue, revalidates its stored authorization snapshot as Always does, calls `allowFolder` with the stable issue id as operation id, and settles it `fixed`. An issue can outlive its original run, so persistent authorization validates the captured policy and filesystem identity without reviving that run or issuing an Allow once grant. Never project the authorization snapshot to a phone. If the call throws, the claim is released, as `resume_routine` does.
  - An issue without `access.folderPath` never offers `allow_folder`.

- [x] **Step 1: Write the failing tests:**
  - In `service.test.ts`:
    - `allow_folder grants the stored folder once and settles as fixed`: the fake `allowFolder` is called once with the issue's `folderPath`.
    - `allow_folder on an issue without a folder is invalid`.
    - `a failed grant leaves the issue open`.
  - In `bot-issue-card.test.tsx`, `an access issue offers Allow this folder and calls onAct with allow_folder`.
  - In `aiden-remote-bot-session.test.ts`, `access_needed issues are not sent to bot:issues devices`.
- [ ] **Step 2: Run and see them fail.** Not captured: the first Task 6 behavioral run already passed 116 tests in `/tmp/bot-access-task6.log`. This is an evidence limitation, not a claimed red run.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `npx tsx --test main/services/bot-issues/service.test.ts renderer/components/bots/bot-issue-card.test.tsx main/services/aiden-remote-bot-session.test.ts`. Expected: PASS.
- [x] **Step 5: Commit:** "Raise a Needs you issue when a Bot needs a folder on an unattended turn".


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
- What Always grants is built from the resolution, and only when `always.kind !== "none"`: `{ folderPath: root, rootId?: always.rootId }`. The tool sets it as the card prompt's `grant` (Task 5) and as the issue's `access` (Task 6), together with the captured main-only authorization snapshot. Whole Mac has its snapshot but no persistent folder grant.
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
  2. Only sufficient read-and-change authority gives `outcome: "already_allowed"`: a fixed write-enabled location covers the folder, or the current matching run grant has `access: "write"`. A read-only Plan C grant does not satisfy `request_access`, which asks for read-and-change. Continue to a fresh approval attempt for that upgrade; the read grant stays effective while waiting or after Not now. Containment alone never proves sufficient access mode.
  3. `runAccess.declined(...)` gives `outcome: "declined_earlier"`, with `"The person already said not now to this in this task. Carry on without it."`
  4. On an unattended run, raise an issue and return `outcome: "asked_later"`:
     - the issue: `kind: "access_needed"`, `dedupeKey: "access:" + key`, title `"Wants to use {label}"`, body = `why` bounded to 280;
     - its actions: `[allow_folder]` when `always.kind !== "none"`; for whole Mac and other `none` cases, `[{ kind: "open_settings", section: "access" }]`;
     - the result text: `"Nobody can answer a card on this turn, so the person will see this request in your chat. Carry on without it and say what is waiting on it."`
  5. Otherwise, take the memoized logical `requestId`, capture a fresh main-only `BotAccessAuthorization`, and request the card (`choices` from `botAccessChoicesFor`). The bridge validates and grants before returning `{choice, waitId}` for the current attempt:
     - `once` or `always`: use the bridge's already-validated grant, bound to `owner: {kind: "access", id: attempt.waitId}`. Never re-grant using a newly read revision after the answer. The text is `"The person allowed {label} for this task. Use the file tools with location \"run.access\" to reach it."` Always adds `" It stays allowed from your next task."`
     - `not_now`: call `runAccess.decline`. The text is `"The person said not now. Carry on without {label} and tell them what you couldn't do."`

- [x] **Step 1: Write the failing tests** in `bot-access-request-tool.test.ts`, with fake deps and a real `createBotAccessRequests` and `createBotRunAccess`:
  - `asks once and grants the run on Allow once`. Answer `once` through the bridge. The result details are `{outcome: "once"}`, and `runAccess.location(botId, ["r1"], rev)` has the folder's root.
  - `Resume reapproves under a new attempt id`: Allow once, quit, then Resume the same logical request. A new card has a fresh waitId. Answer Not now, or Allow once again; each is a new person decision, while retransmissions of either answer count only once. Late answers to the old attempt are refused. Both native clients reuse an idempotency key only within one attempt and mint a new key for the new card.
  - `a whole-Mac card never offers Always`: the pending card's `choices` deep-equal `["not_now", "once"]`.
  - `a routine run raises one access issue and shows no card`, with `runRequestIds: ["routine:t1:1"]`. `raiseIssue` is called once with `kind: "access_needed"`, and `pending()` is empty. Repeat with `tg:1` and `bot:ada:1:d1`.
  - `a second request after Not now shows no card` (Review Focus 5).
  - `a folder with independent read-and-change authority needs no card`.
  - Approve a Plan C outside-folder read grant, then call `request_access` for that same folder. A new card appears and write/edit stay blocked until approval. Allow once upgrades to a validated write grant; Not now keeps the original read-only grant usable and does not widen it. Repeat through a phone answer.
  - `Stop withdraws the card and records no answer`: abort the signal, and `execute` rejects.
  - While a card waits, edit the policy or replace the folder; stale once/always answers grant nothing on desktop and Remote. A fresh request is required for changed authority. The result never substitutes the latest policy revision into the old card.
- [x] **Step 2: Extend `bot-tool-policy.test.ts`:**
  - `request_access is offered to a scoped Custom Bot and refused for Full access, Full Mac and Files off`;
  - `botRunUnattended is true when any input is routine, Telegram or bot`.
- [x] **Step 3: Run and see them fail.** `npx tsx --test main/services/bot-runtime/bot-access-request-tool.test.ts main/services/bot-runtime/bot-tool-policy.test.ts`.
- [x] **Step 4: Implement and wire.** `currentLocations` admits fresh through `deps.admit(botId)` and releases the admission in `finally`.
- [x] **Step 5: Run** the files and `npm run test:bot-handoffs`. Expected: PASS.
- [x] **Step 6: Register and commit:** "Let a Bot ask to use a folder outside its own".


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
    answer(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean; savedForFuture?: true }>; // answerBotAccessRequest
  }): void;
  export function parseBotAccessAnswer(input: unknown): { botId: string; waitId: string; choice: BotAccessChoice };
  // renderer/lib/ipc.ts, bots:
  answerAccessRequest(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean; savedForFuture?: true }>;
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
  - All buttons are disabled while an answer is in flight. A transient save failure toasts its message and keeps the card. A definite stale attempt is removed by the host snapshot; the Bot can request fresh authority. A durable Always that outlives its task reports `savedForFuture: true` and the desktop shows "Saved for future tasks.".
  - The composer is unchanged.

- [x] **Step 1: Write the failing tests:**
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
- [x] **Step 2: Run and see them fail.**
- [x] **Step 3: Implement.** Reuse the in-flight counting pattern from `use-bot-handoff-actions.ts` for `busy`.
- [x] **Step 4: Run** `npx tsx --test renderer/components/bots/access-request-card.test.tsx main/handlers/bot-access-requests.test.ts main/services/bot-runtime/live-projection.test.ts main/services/bot-runtime/bot-attention.test.ts main/services/bot-runtime/bot-handoff-notifications.test.ts`, and `npm run test:bot-handoffs`. Expected: PASS.
- [x] **Step 5: Register and commit:** "Show a Bot's access request in its chat". Registration is complete; staging and commits remain parent-owned.

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
  // → 200 { answered: true, savedForFuture?: true }; 409 access_request_expired when nothing waits; 400 invalid_request for a choice not offered.
  export interface AidenRemoteBotAccessAnswerRequest { choice: "once" | "always" | "not_now" }
  ```
  - Holders get `accessRequest` in the session snapshot and `{ accessRequest }` frames, through the same serialized projection as `handoff`.
  - Devices without the capability get an assistant line, id `access-notice:<waitId>`, reading `"{Bot} needs you on your Mac: allow access to {label}"`. When the card settles, they get a snapshot, as `legacyHandoffNotice` does in `aiden-remote-bot-handoffs.ts:84`.
  - Paired desktops are a legacy audience in this revision and see that line.
  - The route needs `bot:read`, `bot:write` and `bot:access-requests`. It calls `answerBotAccessRequest`.

- [x] **Step 1: Failing host tests:**
  - `the access card is sent only to bot:access-requests devices; others get one notice line that a snapshot removes when it settles`;
  - `answer always reaches answerBotAccessRequest once per Idempotency-Key`;
  - `a choice the card doesn't offer is 400`;
  - `an answered card is access_request_expired`;
  - `access_needed issues reach holders and never bot:issues-only devices`;
  - `the server feature list stays within AIDEN_REMOTE_MAX_SERVER_FEATURES`.
- [x] **Step 2: Implement the host side and the fixtures.**
- [x] **Step 3: Native clients.**
  - Negotiate `bot:access-requests` in its own `POST /device/capabilities` call, only when the host lists it. A 400 or 404 is ignored (`.memory/bot-handoffs-clients.md`).
  - Decode `accessRequest`, render a card with the offered buttons, and post the answer with a per-`waitId` Idempotency-Key that is kept across a lost response.
  - Claim the card optimistically. On `access_request_expired`, it stays gone. On any other failure it comes back with `"That answer wasn't sent. Please try again."`.
  - Decode `access_needed`, `allow_folder` and the access-only `dismiss_access` action, labelled Not now. Same-choice retries retain their key/body; a different choice gets a different key and the newly selected body. A `savedForFuture: true` receipt reports durable success without a current-run grant.
  - Tests: decode the fixture section; tapping each button posts the right body; a whole-Mac card shows no Always.
- [x] **Step 4: Run** `npx tsx --test main/services/aiden-remote-bot-session.test.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts`, the iOS focused tests (the command in `ios/README.md`), and `./gradlew :app:testDebugUnitTest --tests '*AidenBotAccessRequests*' --tests '*AidenBotIssue*'`. Expected: PASS.
- [x] **Step 5: Commit:** "Answer Bot access requests from phones".

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
  - Always through `grantBotFolder`, and `botsOnly` roots that phones never see (an unselected one still appears as a choice on other Custom Bots' Access pages, without being granted);
  - the Remote revision;
  - known limits: paired desktops see the notice line, and there is no CLI tool.
- Modify: `.memory/bot-durable-runtime.md` (one line under Connections, linking the folder grant beside "Add to this Bot")

- [x] **Step 1: Search for stale claims.** Run `rg -n "approved location|Custom access|request_access|hand_off" README.md PRODUCT.md docs/*.md packages/cli/README.md`, and fix each statement this plan made stale.
- [x] **Step 2: Onboarding review.** New Bots keep Full access and never see this tool, so `renderer/components/onboarding-feature-gallery.tsx` and the onboarding flow stay unchanged. Record that decision in the PR description.
- [x] **Step 3: Run** `npm run test:bot-access`, `npm run test:bot-handoffs`, `npm run test:bot-runtime`, `npm run test:bots` and `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.
- [x] **Step 4: Commit:** "Document Bot access requests".

## Backend implementation handoff, Tasks 1–7, 2026-11-03

Implemented in the shared checkout on `feature/bot-access-requests` from
`feefcc26eda414ac937d5aefab1441c0c92d0638`, without commits, staging, branch
changes, dependency changes, live-model calls or window-opening commands.
Tasks 8–10, complete-phase acceptance, commits and PR work belong to the parent.
Commit checklist steps above remain open intentionally. Task 6's first combined
check already passed after the coupled implementation; it has no claimed red-first
run. Other initial failures and their fixes are in the dedicated papercut log.

### Files by task

- Task 1: `renderer/shared/bot-access-requests.ts` and `.test.ts`, `package.json`,
  `scripts/ci-test-registry.json`.
- Task 2: `main/services/bot-runtime/bot-access-target.ts` and `.test.ts`.
- Task 3: `main/services/bot-runtime/bot-run-access.ts` and `.test.ts`,
  `main/services/bot-file-tool-router.ts` and `.test.ts`,
  `main/services/bot-runtime/bot-file-candidates.ts` and `.test.ts`,
  `main/services/bot-runtime/bot-tool-sources-main.ts`,
  `main/services/bot-runtime/bot-session-main.ts`.
- Task 4: `main/services/bot-folder-grant-journal.ts`,
  `main/services/bot-application-service.ts`, `.test.ts` and `-main.ts`,
  `main/services/aiden-remote-state.ts`,
  `main/services/aiden-remote-approved-roots.ts` and `.test.ts`,
  `main/services/aiden-remote-workspace-browser.ts` and `.test.ts`,
  `main/services/aiden-remote-service.ts` and `.test.ts`,
  `main/handlers/aiden-remote.ts`.
- Task 5: `main/services/bot-runtime/bot-access-requests.ts`, `.test.ts` and
  `-main.ts`, `main/services/bot-runtime/bot-access-authorization.ts`.
- Task 6: `renderer/shared/bot-issues.ts`, `main/services/bot-issues/service.ts`,
  `.test.ts` and `service-main.ts`, `main/handlers/bot-issues.ts` and `.test.ts`,
  `renderer/components/bots/bot-issue-card.tsx` and `.test.tsx`,
  `main/services/aiden-remote-bot-issues.ts`,
  `main/services/aiden-remote-bot-session.test.ts`.
- Task 7: `main/services/bot-runtime/bot-access-request-tool.ts` and `.test.ts`,
  `main/services/bot-runtime/bot-tool-policy.ts` and `.test.ts`,
  `main/services/bot-runtime/bot-tool-sources-main.ts`,
  `renderer/shared/bot-activity.ts`.
- Tracking: this plan and `.papercuts/2026-11-03-bot-access-backend.md`.
  Parent-owned initial edits to project memory, the master plan and plan index
  were preserved.

### Root ownership, recovery and authorization contracts

The minimal approved-folder list/add port cannot implement safe compensation.
`BotApplicationDependencies.approvedFolders` therefore additionally supplies
`removeOwned`, reentrant `withInventoryLock`, private/home target dependencies
and a durable journal. Ordinary access saves and normal phone-root approvals
use that same root-inventory lock. The private `bot-folder-grants.json` file is
atomic and mode 0600. An intent preallocates its root id before root creation;
`AidenRemoteApprovedRoot.botGrantOperationId` records ownership alongside
`botsOnly: true`. Compensation compares both markers, checks committed Bot
bindings, and removes approval records only, never filesystem folders. Recovery
runs at initialization and before another grant. Reused or shared roots survive.
An error after actual policy publication is acknowledged only after recovery
verifies that committed binding and its exact revision. A compensation error
fences further Bot mutations in that live service until startup repair.

`grantBotFolder` validates the captured policy, canonical directory, device/inode
and root inventory before creation and again before publication. It uses the
same access-save path and drift refusal as connection grants. The optional live
owner fence also runs at publication. `botFolderGrantPolicyRevision(botId,
operationId)` returns the verified journal publication revision; answer handlers
never read and adopt an arbitrary newer policy revision.

`BotAccessAuthorization` is shared as a type and strict persisted-data parser,
then re-exported from the main bridge. It additionally carries an optional root
inventory fingerprint. The main-only prompt owner contains its live signal,
deadline and validator. The public pending/get projections contain neither the
owner, logical request id, authorization nor grant. A live unchanged attempt
reuses its wait id; abort/restart, changed requirements and deliberate reapproval
allocate a fresh id. The memo holds only the logical request id. No settled
person decision is reused to recreate an ephemeral grant.

Issue authorization stays in the private store and is omitted from list and
transcript projections. Folder actions keep their issue open until the journaled
grant succeeds, claim concurrent taps in memory and retry with the issue id as
operation id. They do not resume the original run or create run access.
Long canonical paths use a SHA-256 dedupe suffix when the literal key would
exceed the existing 400-character issue bound.

### Parent integration seams

- Task 8 imports `botAccessRequests` and `answerBotAccessRequest` from
  `main/services/bot-runtime/bot-access-requests-main.ts`. The existing
  `pending(botId)`, `get`, and `onChange` methods expose only public cards.
  Add access-request snapshots/events, projection refresh/needs-you, attention,
  notification and desktop IPC/card wiring. This worker changed session main
  only for policy-revision injection, terminal-state clearing and shutdown
  clearing. Bot deletion also clears via tool-source forget; shutdown clears
  interrupted grants as well.
- Task 9 must explicitly opt Remote parsers into the new shared vocabulary with
  `botIssueKindOf(value, true)` and `botIssueActionOf(value, true)`, together with
  the new capability gate and DTO revision. Their default calls deliberately
  remain legacy-safe. `toRemoteBotIssue(s)` currently filters `access_needed`
  unconditionally, before applying the legacy issue limit. No protocol, router,
  session contract, iOS, Android or CLI source was changed.
- Task 10 owns product docs, project memory, plan inventory and full integration
  and review. No onboarding change was made. New Bots retain Full access.
  Main/CLI bundled-source validation and native acceptance remain parent-owned.

### Local validation

All commands were headless; no live Aiden inference/network acceptance or
physical-device evidence is claimed. Full Remote verification requires
`/opt/homebrew/opt/openssl@3/bin` ahead of OpenSSL 4.1 for the existing physical
spike fixture. The focused Remote run below used that PATH.

- `npm run test:bot-access`: 31 passed, including real-harness steer/queue scope,
  direct and nested read/write enforcement, Allow once then quit before durable
  result commit followed by a fresh Resume decision, and real issue persistence.
  Log: `/tmp/bot-access-final-access5.log`.
- `npm run test:bot-runtime`: 347 passed.
  Log: `/tmp/bot-access-final-runtime.log`.
- `npm run test:bots`: 980 passed.
  Log: `/tmp/bot-access-final-bots.log`.
- `npm run test:bot-rules`: 61 passed; `test:bot-pause`: 34 passed;
  `test:bot-handoffs`: 67 passed; `test:bot-issues`: 29 passed.
  Logs: `/tmp/bot-access-final-rules.log`, `/tmp/bot-access-final-pause.log`,
  `/tmp/bot-access-final-handoffs.log`, `/tmp/bot-access-final-issues.log`.
- Focused approved-roots, workspace-browser, Bot session, Remote service and
  Remote state tests: 220 passed, one existing skip.
  Log: `/tmp/bot-access-final-remote-focused.log`.
- `npm run test:ci:registry`: 15 passed. Every new test file is in
  `test:bot-access` and the lane holding main Bot handoff tests;
  `pretest:bot-access` builds lease-flock and `test:serial` includes the suite.
  Log: `/tmp/bot-access-final-registry.log`.
- `npm run test:bot-messaging`: 89 passed.
  Log: `/tmp/bot-access-final-messaging.log`.
- A final combined backend pass covered application, router, candidates, issues,
  issue handlers/card and tool policy: 115 passed.
  Log: `/tmp/bot-access-final-backend.log`. Later application and candidate
  checks passed 63 and 2 respectively after the final recovery/pin guards.
  Logs: `/tmp/bot-access-final-application2.log`,
  `/tmp/bot-access-final-candidates.log`.
- Type-check, scoped ESLint and whitespace validation passed.
  Logs: `/tmp/bot-access-final-types7.log`, `/tmp/bot-access-final-lint5.log`.

These are local implementation checks, not phase B acceptance. The dedicated
papercut file is ignored by the checkout's Git rules and was not staged.


## Desktop implementation handoff, Task 8, 2026-11-03

Implemented in the shared checkout on `feature/bot-access-requests` at
`feefcc26e`, preserving the uncommitted Tasks 1–7 backend. No staging, commits,
pushes, PRs, branch changes, nested agents, dependencies, pins, live-provider
calls or window-opening commands. Parent owns E2E, product docs, project memory,
Task 9, Task 10, phase acceptance and reviews. Step 5 above stays open only for
its parent-owned commit.

### Files owned by Task 8

- New desktop IPC: `main/handlers/bot-access-requests.ts` and `.test.ts`.
  Updated `main/handlers/bot-params.ts` and `main/handlers/bots.ts`.
- New UI: `renderer/components/bots/access-request-card.tsx` and `.test.tsx`;
  `renderer/main/bots/use-bot-access-request-actions.ts` and `.test.tsx`.
  Updated `renderer/main/bots/bot-chat-pane.tsx` and `.test.tsx`,
  `renderer/lib/ipc.ts` and `renderer/shared/bot-live.ts`.
- Public projection: `main/services/bot-runtime/live-projection.ts` and
  `.test.ts`; updated the typed projection fake in `main/handlers/bot-live.test.ts`.
- Host attention and notifications: `main/services/bot-runtime/bot-attention.ts`
  and `.test.ts`, `bot-handoff-notifications.ts` and `.test.ts`, plus
  `bot-session-main.ts`. Backend policy-revision injection, terminal-state
  clearing and shutdown run-access clearing remain intact. The watchdog now
  recognizes an access request as waiting on the person too.
- Shared private test prompt: `main/services/bot-runtime/test-support/access-request-fixtures.ts`.
- Registration: all three new test files are in `test:bot-access`, reached by
  `test:serial`, and in the CI lane containing the main handoff tests.
  `package.json` and `scripts/ci-test-registry.json` preserve backend entries.
- Tracking: this plan and `.papercuts/2026-11-03-bot-access-desktop.md`.
  Parent-owned documents, memory, Remote/native/CLI code and E2E were not edited.

### Desktop and Task 9 contracts

- Desktop IPC is `bots:answerAccessRequest` with exactly one body
  `{ botId, waitId, choice }`. Its parser rejects extra keys, malformed ids,
  over-bound ids and unknown choices before invoking the answer port. Production
  registration calls the existing `answerBotAccessRequest` singleton, which
  authorizes or throws its server message; the renderer grants nothing.
- `BotLiveSnapshot.accessRequest?: BotPendingAccessRequest | null` and
  `{ type: "access_request", accessRequest }` events carry only the bridge's
  public `pending/get` projection. No grant, authorization, logical request id or
  live owner is projected. `applyBotLiveEvent` handles the event with the existing
  epoch/sequence checks. Feed creation, serialized refresh, subscribe catch-up,
  activity waiting, `needsYou`, summary and inbox signals all include the card.
- The card's accessible group name is exactly `botAccessCardTitle(botName,
  request)`, matching the parent's E2E contract. The Bot avatar, FolderOpen or
  Laptop icon, folder-only place, reason and offered choices use BotNoticeCard
  and shared Button treatments. Choice order is preserved and the last is
  primary. Every choice disables while any answer for that Bot and `waitId`
  remains in flight. Other Bots and later attempts stay independent.
- Cards are removed by authoritative host snapshots/events, including settled
  or expired cards. A receipt never fabricates approval or optimistically hides
  authorization failure. Errors toast the server message and unlock the card;
  `answered: false` reports that the card was answered or closed. The composer
  is unchanged. An extra renderer-reload experiment was removed after a headless
  timeout; accepted code follows existing host projection delivery and catch-up.
- `watchBotAccessRequests` feeds a second `createBotHandoffNotifier`. The notifier
  accepts public access requests alongside handoffs and derives the access title
  after its single Bot-name lookup. It claims `waitId` before awaiting the name,
  rechecks pending identity and focus afterward, and announces each attempt once.
  Attention broadcasts only the Bot id. New projection/notification listeners and
  attention wiring unsubscribe on runtime shutdown.
- Task 9 still owns capability negotiation, Remote DTO/session frames and legacy
  notices, route/idempotency, protocol revision/fixtures, native cards and client
  tests. No Task 9 wire semantics or CLI tool were added. It can consume the
  shared public optional/nullable snapshot/event contract and existing singleton
  answer entry directly, keeping reapproval keyed by the fresh `waitId`.

### Local verification

- Initial new IPC/card tests failed for missing implementation, as expected:
  `/tmp/bot-access-desktop-red.log`.
- `npm run test:bot-access`: 40 passed.
  `/tmp/bot-access-desktop-access.log`.
- `npm run test:bot-handoffs`: 69 passed, including access notification focus,
  dedupe, settlement/name races and watcher cleanup.
  `/tmp/bot-access-desktop-handoffs.log`.
- Focused IPC/card/actions/attention/notifier run: 25 passed.
  `/tmp/bot-access-desktop-unit.log`.
- Projection, desktop live IPC and chat suites: 146 passed.
  `/tmp/bot-access-desktop-projection-chat.log`.
- Final card/actions/chat run after UI refinements: 84 passed.
  `/tmp/bot-access-desktop-ui-final2.log`.
- Final access-specific chat tests, including an expired/not-waiting card removed
  by a fresh host snapshot: 2 passed.
  `/tmp/bot-access-desktop-expired-final.log`.
- CI registry: 15 passed. `/tmp/bot-access-desktop-registry.log`.
- Type-check and scoped ESLint passed. Logs:
  `/tmp/bot-access-desktop-types-final2.log`,
  `/tmp/bot-access-desktop-lint-final.log`,
  `/tmp/bot-access-desktop-lint-final2.log`. Final whitespace validation passed. No retries or production test timeouts were
  weakened; exploratory failures and fixes are in the papercut log.

These are headless local checks, not visual, native, live-model or complete-phase
acceptance. The parent-owned Cua E2E spec checks actual Tab behavior and light/dark
narrow layouts. This worker did not run it.

## Remote host implementation handoff, Task 9, 2026-11-04

Implemented in the shared checkout without staging, commits, pushes, branch
changes, delegation, dependency changes or live inference/catalog calls. Existing
backend, desktop, root startup/E2E and native-worker edits were preserved.

### Scoped host checklist

- [x] Revision 55 DTOs, strict card/answer/receipt parsers, capability vocabulary,
  session snapshot and SSE access-request shapes, and canonical fixtures.
- [x] Wired-host capability advertisement and negotiation, answer route, all
  three required grants, required idempotency key, stable replay after a lost
  response, unoffered-choice refusal and settled-request expiry.
- [x] Serialized holder projection and legacy assistant notice/removal snapshots.
  Paired desktops keep their legacy reducer behavior and advance unexpected
  access-request frames without exposing a raw phone card.
- [x] Capability-aware access issue cards, actions, summary counts and alerts.
  Legacy issues are filtered before their own projection limit. No private
  authorization or grant data enters any Remote payload.
- [x] Durable alert audience marker and producer/funnel/log/feed coverage,
  including deferred flush and restart after issue-store pruning.
- [x] OpenAPI and `docs/aiden-remote-api-v1.md` updated in this scope. Existing
  fixture/OpenAPI formatting retained. No server feature token was added.
- [ ] Native acceptance, complete phase B review, Task 10, phase status and commit
  remain with the native worker and parent.

### Owned files and integration contracts

Host files are `main/services/aiden-remote-protocol.ts` and `.test.ts`,
`aiden-remote-router.ts` and `.test.ts`, `aiden-remote-bot-session.ts` and
`.test.ts`, `aiden-remote-bot-issues.ts`, and `aiden-remote-service-main.ts`.
The parent additionally authorized the exhaustive legacy reducer case/test in
`renderer/lib/hosts/remote-bot-session.ts` and `.test.ts`, and the alert retention
seams in `bot-routine-notifications.ts` and `.test.ts`,
`bot-delivery/log.ts`, `bot-delivery/funnel.ts` and `.test.ts`, plus the access
issue delivery producer in `bot-issues/service.ts` and `.test.ts`. Only the new
marker and its test were added to the already modified issue service files.
Protocol artifacts are `protocol/aiden-remote/v1/openapi.json` and
`fixtures/contract.json`; the scoped API guide is `docs/aiden-remote-api-v1.md`.
No new test files need CI registration.

The session service takes the public bridge `pending/get/onChange` port and an
`answerAccessRequest` port. Production calls the existing
`answerBotAccessRequest` singleton entry. The answer ledger uses device, route,
Bot, wait id and key, checks the offered choice inside its idempotent action,
and replays `{ answered: true }` after settlement. Refusals before any answer
remain retryable under the same key; a changed body conflicts. Request changes
refresh on the projector lane and the new listener unsubscribes on close.

`botAccessRequests` sits beside `botHandoffs` in the canonical fixture. Its keys
are `capability`, `folder`, `wholeMac`, `session`, `events`, `answer`, `expired`,
`issue`, and `legacy` with `session`, `events`, `settledSession`. All fixture
revision markers, including host health, are 55. Private field and legacy
holder-field injection tests fail closed. The revision is provisional against
main and must still be rechecked by the parent before merge.

For alerts, an access issue's persisted kind produces
`requiredCapability: "bot:access-requests"` on its delivery obligation. The
funnel writes that marker atomically in the delivery row and retains it through
flush/restart; the feed suppresses marked alerts for nonholders even after the
issue record is pruned. The marker never crosses the API. An injected issue-kind
lookup also filters current unmarked access rows; unmarked historical ordinary
rows retain their behavior. No authorization or filesystem path is duplicated
into this marker.

### Local verification

- Eight existing behavioral suites passed together: **357 passed, zero failed**.
  They cover protocol, operation ledger, real HTTP router, serialized session
  projector, notification feed, delivery funnel, issue producer and paired
  desktop reducer. Log: `/tmp/bot-access-remote-host-final-tests.log`.
- After correcting test fixture types, all affected access cases passed again:
  **9 passed, zero failed**. Log:
  `/tmp/bot-access-remote-host-final-cases2.log`.
- `npm run type-check` passed after the test-fixture corrections. Log:
  `/tmp/bot-access-remote-host-final-types3.log`.
- Scoped ESLint passed for all 17 changed TypeScript files. Log:
  `/tmp/bot-access-remote-host-final-lint2.log`.
- Whitespace validation passed. Papercuts are recorded in the ignored workspace
  `.papercuts/2026-11-04-bot-access-remote-host.md`.

These are headless local host checks. No native-device, visual, live-provider,
packaged-app or full phase acceptance is claimed by this worker. Parent Cua,
CLI and native-worker evidence is deliberately kept in their own handoffs.

## Parent integration checkpoint, 2026-11-04

Tasks 1–10 are implemented and recorded in the phase B checkpoint commit. The original per-task commit labels above describe the planned boundaries; the parent assembled the workers' uncommitted changes into one phase commit. Full B acceptance still requires both independent reviewers at the same frozen SHA. Task 6's initial failing run was not captured and stays unchecked.

The parent fixed an actual production startup cycle in `bot-access-requests-main`: answer-only application, authority and tool-source imports are lazy, so the bridge initializes before the runtime subscribes. Temporary stack/output probes were removed. The actual Cua card test passes in light 1280px and dark 600px, with keyboard order/focus, busy answer barrier, failed Always toast/card retention, once/Not now host-driven removal, whole-Mac no-Always and zero inference traffic. Log `/tmp/bot-access-e2e-cua-final.log`; screenshots were visually inspected. The mock profile substitutes only the projected Bot feed, not the card/hooks/IPC behavior.

Parent checks passed: access 40, runtime 350, Bots 982, handoffs 69, rules 61, messaging 89, registry 15. Full Remote passed peer 175 with one existing skip, main 1035 with one existing skip, LAN spike 7 and tail 29, using OpenSSL 3 for the existing transport fixture. Logs `/tmp/bot-access-parent-{runtime,bots,handoffs,rules,messaging,registry,remote}.log`. CLI build produced 268 files/27.0 MiB; its complete suite passed 183 with 3 existing PTY skips and no failures, and CLI type-check passed. Logs `/tmp/bot-access-cli-{build,tests,types-final}.log`. Host's final root type-check and scoped lint passed after correcting test-fixture types, as recorded above.

Native Task 9 passed iOS 158 tests with two environment skips and Android 115 tests. iOS result `/tmp/aiden-bot-access-ios-phase-b.xcresult`, log `/tmp/task9-ios-grant-fix.log`. Android lint and instrumented-test compilation passed; no emulator was attached, so Compose UI tests were not executed. Android lint has 0 errors, 51 warnings and 5 hints. iOS physical pinning/signed-Keychain checks skipped; compiler, main-thread runtime and missing-Keychain-entitlement warnings remain unclaimed as resolved. No physical-device, live-provider, package, release or exact-head hosted CI acceptance is claimed.

Onboarding/tour reviewed and unchanged: new Bots still start with Full access; this is an advanced Custom-access workflow. No dependency, lockfile or Pi pin changes. Docs, project memory, CLI absence, old-client behavior, notification/count capability filtering and durable retention are updated together.

## Gate 3 round 1 corrections, 2026-11-04

The initial frozen checkpoint `f648df31b` was not accepted by either reviewer. The corrected checkpoint will receive fresh, independent reviews from both requested models before C starts. Findings and parent dispositions:

1. Opus high 1: phone retries now bind to the waiting attempt and the selected choice. Failed Always followed by Not now sends Not now with a new key; same-choice retries retain their body/key. Both native suites reproduce the old failure and pass the corrected behavior.
2. Opus high 2 and low 8: definite pre-effect policy, inode or scope staleness withdraws the live attempt as `access_changed`, without recording a decline. A new request gets a new wait ID. Remote maps the refusal to a typed retryable 409, including same-key retries. Transient save failures retain the card. Stale access-issue actions likewise return typed `operation_stale` before an effect.
3. Opus medium 3 and DeepSeek 1: access issues have an explicit `dismiss_access` action, displayed as Not now and restricted to access-needed issues. Changed captured authority supersedes the issue with a fresh identity instead of updating authority under an old card. Supersession status obligations survive restart and retention. Already-authorized paths resolve their access issue without resuming the old run. Unrelated root changes no longer stale requests; only the target's relationship to roots and their identity are hashed.
4. Opus medium 4: model requests cannot select private storage or its enclosing directories, apart from explicit Home/whole-Mac temporary choices with protected-path fences. Temporary reads, writes and recursive list/glob/grep inspect each canonical path, including aliases and `..`-prefixed in-root names. Ordinary files and the own fixed Bot home remain usable; legacy fixed read behavior is unchanged.
5. Opus medium 5: syntax/schema and initial journal read failures preserve evidence and block folder grants only. Ordinary listing, canonical chats, chat creation and access updates work. Failures after recovery begins mutating retain the existing lifecycle fence.
6. Opus medium 6: an explicit visible phone-folder approval may overlap a hidden Bot root. The Bot keeps its exact original binding, and hidden root metadata stays out of phone lists. Existing exact-root conversion remains supported.
7. Opus medium 7: publication is the durable effect boundary. A successful Always followed by owner invalidation reports `{answered:true,savedForFuture:true}`, with no temporary grant. The exact operation receipt is checked before old owner/policy validation on a retry, including after a receipt-read outage or after the prompt disappears. A historical acknowledgement never recreates removed authority. Desktop and phones display Saved for future tasks.
8. Opus low 9: an already-authorized fixed folder can refresh `run.access` safely in the current run, so a tool bound before the saved grant changed can actually read it. No extra authority is requested or synthesized.
9. DeepSeek low 2: the user guide and tool guidance explicitly state the one-extra-folder-per-task replacement limit. Saved fixed Always scopes remain available through validated current access.
10. DeepSeek low 3: access notifications now read "Ada needs you to: use Taxes", without repeating the Bot's name.
11. Opus low 10 is retained as a documented bounded-store limit: the journal keeps 4,096 durable operation receipts. Pruning without durable replay tombstones could recreate removed authority, so this correction does not evict receipts unsafely. The store fails closed at its cap.

Correction evidence is separate from initial-checkpoint evidence above. Storage suites passed 214 broader checks and 92 final affected checks, with real red cases for privacy, journal isolation and overlap behavior. Runtime checks passed 51 access tests, 339 final host/protocol/router/issue checks and 11 final bridge race checks, with explicit red cases for changed authority, durable publication and issue recovery. Native correction checks passed iOS 168 with two environment skips and Android 121; Android lint has zero errors, 51 warnings and five hints, and instrumented tests compiled without an attached emulator. Existing Xcode warnings remain unclaimed as resolved. The actual Cua interaction test passed with the future-save success notice and a transient retryable failure. Parent broader regressions passed runtime 350, Bots 990, Remote 175 plus 1039 plus 7 plus 29 with two existing skips, and CLI 183 with three existing PTY skips. Final handoff and new frozen SHA will be recorded before the next reviews.

Final R1 runtime handoff: `/tmp/aiden-bot-access-runtime-r1-handoff.md`. All three correction workers completed and stopped editing before the corrected freeze. Root type-check and scoped lint passed on the corrected code. No new test files or registry entries were needed; registry still passes all 15 checks. Final root UI/parser/notification tests passed 24, including a red/green ordinary-issue/action mismatch case. CLI type-check also passed. The last bridge-only change cached a successful historical acknowledgement before observing that its prompt had been withdrawn; its 11 behavioral tests passed and no authority or second publication was added.
