# Bots that hand work back: hand-offs, sign-in, rules, pause and Bot computers

Status: Implemented in PR #559 (2026-10-21); owner-Mac acceptance pending. The owner picked these five ideas from a study of Cua's `cua-bots-macos` sample. On 2026-10-20 the owner took the recommended option (a) for all nine decisions in [§10](#10-decisions-for-the-owner). All five features are built: hand-offs, Pause, rules, the Remote contract (revision 37) with the iOS and Android clients, the Bot browser and `sign_in`, and Bot computers (host, viewer with Take over, the `computer` and `computer_shell` tools, and the guest driver lane with computer sign-in). Real-VM behaviour waits on the packaged acceptance on the owner's Mac (`npm run test:bot-computers:packaged`); the plan moves to `completed/` once it passes.

## 1. Goal

Five features for Aiden Bots:

| | Feature | One line |
|---|---|---|
| A | **Hand-off cards** | A Bot can say "you do this part" (a 2FA code, a payment, a password change), and the person taps **Done** or **Skip**. |
| B | **Sign-in for Bots** | A Bot gets its own browser profile. When it needs an account, it asks the person to sign in there. The model never sees the password. |
| C | **Plain-language rules** | "When Ada wants to make a purchase → Ask first", "Move money → Hand off to me (locked)". Aiden enforces them. They can only make a Bot stricter. |
| D | **Pause a Bot** | One switch stops the current turn, disarms every routine and stops the Bot's computer, until **Resume**. |
| E | **Bot computers** | An opt-in macOS VM per Bot (Lume, Apple Virtualization), started only when needed, cloned from one shared base. The Bot can work there while the person is away, with a live view and **Take over**. |

### Platforms

| Feature | Mac | Linux | CLI | iOS / Android |
|---|---|---|---|---|
| A Hand-off | yes | yes | follow-up (the CLI Bot runtime has no durable waits yet) | yes (Remote rev 36) |
| B Sign-in | yes | yes | no (no browser) | "Finish on your Mac" |
| C Rules | yes | yes | follow-up (same reason) | read-only list, later |
| D Pause | yes | yes | `aiden bots pause/unpause` | yes (Remote rev 36) |
| E Bot computers | Apple silicon only | no (later: QEMU/Docker) | no | status only; live view later |

Bots already run on `darwin` and `linux` (`main/services/host-platform-capabilities.ts:22`). Bot computers add a separate `botComputers` flag that is true only on `darwin` + `arm64`.

### Source and license

Ideas only. `trycua/cua` `examples/cua-bots-macos` (at commit `524b7c4`) is **FSL-1.1-MIT**, so none of its code may be copied. The parts Aiden would ship, `lume` (`libs/lume`, v0.6.1, 2026-10-04) and `cua-driver` (already pinned at 0.34.1), are **MIT**. Add their notices to `THIRD_PARTY_NOTICES.md`.

## 2. What Aiden already has

Every feature below plugs into an existing piece:

- **Durable waits.** `ask_user_question` for Bots (`main/services/bot-runtime/bot-question-tool.ts`, `bot-questions.ts`) stores its `waitId` in a tool-task memo, so Resume after a quit asks again under the same id. Approvals do the same in `bot-extension.ts` (`beforeTool` → `requestApproval`, memo `aiden.approval`).
- **Turn ingress.** `bot-tool-policy.ts` `botIngressAllowsTool` withholds interactive tools on `routine:` and `tg:` turns.
- **Approvals.** These already ask: Computer Use input actions (`bot-computer-use-approval.ts`, descriptor from `computer-use/controller.ts` `approvalFor`, with the target element's `role`), mutating MCP tools and `share_image` (`botToolApprovalSummary`).
- **Live projection and side panel.** `bot-runtime/live-projection.ts` carries `question` and approvals. The Bot side panel has Activity, Files, Memory and Routines tabs (`renderer/main/bots/bot-workbench.tsx`), and "Needs you" comes from `bot-attention.ts`.
- **Interrupted turns.** `BotSessionState.kind === "interrupted"` already has Resume/Dismiss UI. Routines skip with reason `bot_paused` while a Bot is interrupted (`scheduled-bot-routines.ts:171`) and catch up after it (`createBotRoutineCatchUp`).
- **Browser.** Workspace-scoped tabs, persistent profiles, human-takeover invalidation and Ask approvals (`main/services/browser/*`, `browser-tools.ts`). Bots are excluded today: `canUseBrowserTools({ bot: true })` returns false, and the Bot "Browser" capability is declared but hard-wired unavailable (`bot-capability-inventory-ports.ts:273`).
- **Connection hand-over to the Mac.** Remote `POST /bots/{id}/connection-requests` opens a Mac flow from a phone (`bot-connection-setup.ts`).
- **Computer Use.** `ComputerUseController` takes a `CuaDriverHostFactory`, and `CuaDriverSession` takes a `Transport` (`computer-use/session.ts`). That gives Bot computers a seam to plug a different host into.

## 3. Principles

1. **Enforced, not just instructed.** Cua's rules are only text in the bot's instructions. Aiden checks every rule in `beforeTool`, and also renders the rules into the prompt so the model can plan around them.
2. **Rules only tighten.** A rule can turn *allowed* into *ask*, or *ask* into *hand off*, never the other way. The one place Aiden relaxes anything is the Bot's own computer, and that relaxation comes from the VM boundary, not from a rule (§8.7).
3. **Durable like questions.** Every new wait (a hand-off or a sign-in) stores its `waitId` in a tool-task memo and is asked again after a restart. An answer is applied exactly once.
4. **Manual-only network.** Lume ships inside the app and the guest driver is copied from Aiden's own pinned `cua-driver`; only the macOS restore image is downloaded, and only after an explicit **Set up** action. Lume telemetry and update checks are off in every child process. No `lume serve`, no installer, no `PATH` lookup. Same posture as `cua-driver` and Antigravity.
5. **One Remote revision** (36) for hand-offs and pause, gated per device (see §9 for why it can't be a new `/server` feature token).

## 4. A: Hand-off cards

### 4.1 Experience

- In the Bot chat, a card appears with the Bot's avatar: **"Your turn: Enter the 2FA code for your bank."** It shows the reason, an optional **Open** button (a URL or app to open), **Done**, and **Skip**.
- The composer works as it does for a pending question: the person can also type, which answers the card as **Done** with a note.
- The sidebar shows "Needs you" (`bot-attention.ts`), the same way a pending question does. If notifications are on, a Mac notification and a phone notification say "Ada needs you to: …".
- **Done** gives the tool this result: `The person says they did this: <action>. Check the result before continuing.` plus their note.
- **Skip** gives: `The person chose not to do this: <action>. Do not try another way to do it; say what you will do instead.`
- **Stop**, Dismiss, delete or quit withdraws the card, and no result is recorded. That matches questions.

### 4.2 Model tool `hand_off`

`main/services/bot-runtime/bot-handoff-tool.ts`, built like `bot-question-tool.ts`:

```ts
hand_off({
  action: string,        // ≤ 160 chars, imperative, shown as the card title
  why?: string,          // ≤ 400 chars
  open?: { url: string } // https only; opens in the Bot's browser (B) or the system browser
})
```

- `replay: "safe"`, `interactive: true`, `executionMode: "sequential"`, memo `aiden.handoff` `{ waitId }`.
- Description: use it for steps the Bot must not or cannot do (passwords, 2FA, payments, CAPTCHAs, legal sign-offs, anything its rules hand to the person). Wait for the answer.
- Offered only on attended turns. `botIngressAllowsTool` withholds it on `routine:` and `tg:` (decision 2).

### 4.3 Bridge, projection and IPC

- `bot-runtime/bot-handoffs.ts` follows `bot-questions.ts`: `request`, `answer(botId, waitId, { outcome: "done" | "skipped", note? })` → `answered | not_waiting | invalid`, `pending`, `onChange`. Wire it from `bot-handoffs-main.ts` into `bot-attention.ts`.
- Live projection: a `handoff` snapshot field and `handoff` events through the same per-feed queue as `question` (`live-projection.ts`). Catch-up on subscribe.
- Transcript: the tool result's `details` becomes a `handoff_result` entry ("You did this" or "You skipped this"), so the history reads naturally. Remote shows it as a user-side line.
- IPC: `bots:answerHandoff({ botId, waitId, outcome, note? })` with a strict parser in `bot-params.ts` and a handler in `main/handlers/bot-handoffs.ts`.
- Desktop UI: `renderer/components/bots/handoff-card.tsx` in Aiden's design system (shared squircle buttons, semantic tokens, no decorative borders, visible `focus-visible`). Hosted by `renderer/main/bots/bot-chat-pane.tsx` above the composer. Review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` first, as `AGENTS.md` requires.

### 4.4 Rule-driven hand-offs (with C)

When a rule decides *hand off* for a tool call (§6.3), `beforeTool` opens a hand-off wait itself, using the memo `aiden.approval` with `kind: "handoff"`, instead of an approval card. The tool never runs. **Done** blocks the call with `The person did this themselves: <summary>. Continue from there.`, and **Skip** blocks it with the Skip text above. This works even when the model never calls `hand_off`.

On unattended turns (routine, Telegram), a rule hand-off doesn't wait. It blocks the call with `This needs the person (<rule>). Tell them in your reply.`, so the routine's result notification says what is needed.

### 4.5 CLI

CLI Bots (`packages/cli/src/bots.ts`) run on their own runtime, without the desktop's durable waits or approval cards. Hand-offs and rules there are a follow-up. Say so in `packages/cli/README.md` when A and C ship.

### 4.6 Tests

- `bot-handoff-tool.test.ts`: the memo keeps the `waitId` across a simulated restart, Done and Skip produce the right result text, an abort leaves no result, and an invalid outcome keeps the wait open.
- Extend `bot-tool-policy` tests: withheld on `routine:` and `tg:`, and on a run that a steer joined from either.
- Extend `live-projection.test.ts` (snapshot, catch-up, settle) and `bot-chat-pane.test.tsx` (card renders, Done and Skip send the IPC, the composer note path, focus order).

## 5. B: Sign-in for Bots

### 5.1 B1: a browser for Bots

1. **Capability.** Make the Bot `browser` capability real in `bot-capability-inventory-ports.ts` (available when global browser access is on). Add it to `bot-tool-policy.ts` and `bot-tool-sources-main.ts`.
2. **Profile.** Each Bot gets its own persistent partition, `persist:aiden-bot-<botDirectoryName>`, outside the user's profile list (decision 1). Its cookies never mix with the person's workspace browsing, and deleting the Bot clears it: add a `browser_profile` step to the `delete_bot` lifecycle journal (`bot-lifecycle-journal-core.ts`).
3. **Where tabs live.** Bot tabs belong to the Bot's managed workspace (`resolveManagedWorkspace(botId)`). Add a **Browser** tab to the Bot side panel (`bot-workbench.tsx` `TAB_META`) that hosts the existing browser surface bound to that workspace. It stays hidden until the Bot has a tab, like workspace Artifacts.
4. **Tools.** `createBrowserAgentTools` needs `workspaceId`, `chatId` and `generationId`. Bots pass the managed workspace, the canonical Bot chat, and the run's submission id. Allow `canUseBrowserTools` for Bots only with the capability. The discovery gateway (`browser`) stays the first-offered tool. All tools are `replay: "unsafe"` except snapshot and status.
5. **Approvals.** Bot browser interaction and evaluation follow the Bot's approval path (§2). Ask-mode approvals bind to tab, revision and arguments, as they do in workspaces (`browser/approval.ts`). Navigation and reads don't ask.
6. **Secrets never reach the model.** "Sensitive fields" are `input[type=password]` and any field whose `autocomplete` names a credential, one-time code or card (`current-password`, `new-password`, `one-time-code`, `cc-*`). Every model-visible output is covered, not just snapshot text:
   - **No arbitrary script.** Bots don't get `browser_evaluate`, because a script can read a field's `.value` directly. They don't get `browser_recording_start` or `browser_recording_stop` either. Workspace chats keep both.
   - **Snapshot text.** Sensitive field values are dropped from the snapshot.
   - **Snapshot images.** After capture, main gets the bounding boxes of sensitive fields in every frame and paints over them in the PNG before the image reaches the model. Doing this in main means a page's own CSS can't undo it. If a frame's boxes can't be read (for example a cross-origin iframe), that snapshot goes out without an image, and its text says why.
   - **During sign-in.** While a sign-in card or human takeover holds the tab, Bot snapshots of that tab are refused. After release, masking applies as above.
   - **Typing.** `browser_type` into a sensitive field is the locked credentials rule (§6), so the Bot can't even attempt it.

### 5.2 B2: `sign_in`

- `sign_in({ site, why? })` is a hand-off variant (`kind: "sign_in"` on the hand-off prompt). Normalize `site` to an `https://` origin (no userinfo, no port except 443).
- The card reads **"Sign in to github.com for Ada"**. **Open sign-in** opens that origin in a new tab of the Bot's browser and focuses the Bot panel's Browser tab. Automation on that tab is locked until the card settles (the human-takeover state). The person signs in, then taps **I'm signed in** or **Skip**.
- Result: `The person says they signed in to <origin>. Check with browser_snapshot; never ask for or type their password.`
- Phones: the card shows **Finish on your Mac** (calls the same Mac-opening path as `connection-requests`) and **Skip**. Signing in on the phone itself is out of scope.
- Bot computers (E) reuse the same card with **Open my computer** instead of a browser tab (§8.8).

### 5.3 Tests

- Inventory test (the Browser capability becomes available), the policy verdict, and the ingress rules for the browser tools.
- Partition isolation: a Bot tab's cookies aren't visible to a workspace tab, as a Playwright e2e in `tests/e2e/` alongside `browser-agent.spec.ts`. Bot delete removes the partition.
- Credential boundary, against a fixture page with password, OTP and card fields, both before a sign-in and after takeover is released: no sensitive value appears in snapshot text; the image's sensitive-field boxes are painted over (pixel check); a cross-origin frame drops the image; and `browser_evaluate` and the recording tools aren't offered to Bots.
- `sign_in` origin normalization (rejects `http:`, userinfo, IP literals and `localhost`) and the tab lock while the card waits.

## 6. C: Plain-language rules

### 6.1 Model

```ts
type BotActionClass = "credentials" | "money" | "purchase" | "communicate" | "delete" | "publish" | "install";
type BotRuleBehavior = "ask" | "hand_off";          // "allowed" is only a baseline, never a rule
interface BotRule {
  id: string;
  actionClass?: BotActionClass;  // built-in rules
  text?: string;                 // custom rules, the person's words (≤ 120 chars)
  behavior: BotRuleBehavior;
  locked: boolean;               // code constants, never stored
}
```

Defaults for every Bot:

| Rule (as shown) | Class | Behavior | Locked |
|---|---|---|---|
| Enter a password or 2FA code, or change account security | credentials | Hand off to me | yes |
| Move money or enter card details | money | Hand off to me | yes |
| Make a purchase or booking | purchase | Ask first | no (can change to Hand off) |
| Send a message or email to someone | communicate | Ask first | no |
| Post or publish something publicly | publish | Ask first | no |
| Permanently delete something | delete | Ask first | no |
| Install software (on your Mac) | install | Ask first | no |

Custom rule: "When Ada wants to *[text]* → Ask first | Hand off to me" (decision 3).

### 6.2 Where actions are classified

`main/services/bot-rules/classify.ts` turns a pending call into `{ classes: Set<BotActionClass>, evidence }`. It uses structured signals first and words second:

| Surface | Strong signals | Word signals |
|---|---|---|
| Computer Use (`approvalFor` descriptor + captured element) | element `role` `AXSecureTextField` → credentials; menu leaf; app bundle (Mail, Messages → communicate) | the element label or title: "Pay", "Place order", "Buy", "Send", "Delete", "Transfer", "Publish", "Post" |
| Browser (`browser_type`/`browser_click` target) | `input[type=password]`, `autocomplete` `one-time-code`/`cc-*`/`current-password`/`new-password`; a form posting to a payment host | the button or link accessible name, as above |
| MCP mutating tools | tool annotations (`destructiveHint`), name verbs (`send_*`, `delete_*`, `post_*`, `create_payment*`) | summary text |
| `hand_off` / `sign_in` / shell / files | not classified (shell stays governed by the Shell grant, which the rules editor says plainly) | |

A labeled corpus (`main/services/bot-rules/fixtures/actions.json`, at least 80 real-looking descriptors across the surfaces) is the independent oracle for the classifier tests.

### 6.3 Enforcement

In `bot-tool-assembly.ts` `checkPolicy`, after today's verdict and approval requirement:

```
baseline = approval ? "ask" : "allowed"         // today's behavior, untouched
ruled    = max(baseline, strictest matching rule)  // allowed < ask < hand_off
```

- `ask` with no existing approval: create one with summary `Rule · Make a purchase — <summary>`.
- `ask` with an existing approval: keep it and prefix the rule name. A remembered approval scope (`tool-approval-scope.ts`) never skips a rule-made ask.
- `hand_off`: the rule-driven hand-off of §4.4.

Property test: for every rule set and every call, `ruled >= baseline`.

### 6.4 Storage, editor and prompt

- **Store:** `main/services/bot-rules/store.ts`, a per-Bot DataStore (`<profile>/bots/<dir>/rules.json`, `writeJsonAtomic`, revisioned). It holds only non-locked rules. Locked rules come from code, so a tampered file can't remove them. Deleted with the Bot.
- **Editor:** a **Rules** section in the Bot profile (`renderer/main/bots/bot-advanced.tsx` or a new `bot-rules.tsx`), following `docs/settings-design-system.md`: one grouped card, each row "Make a purchase · Ask first" with a trailing menu, locked rows showing a lock glyph and "Always", and **Add a rule**. No decorative borders. Choices are radio rows with fill states.
- **Prompt:** render the rules into the `aiden-authority` section (`bot-extension.ts`) so the Bot plans around them and calls `hand_off` itself where it can.
- **Phones:** read-only list later (needs a rule field on Bot detail, revision 37+). Not in this plan's first ship.

### 6.5 Tests

- The classifier against the labeled corpus (precision and recall reported; locked classes must have no misses on the corpus's password, OTP and card fields).
- The tightening property test, plus `beforeTool` integration: a rule-made ask creates exactly one approval card, a hand-off rule never runs the tool, and an unattended hand-off blocks without waiting.
- Editor render tests (Testing Library, behavior only: add, change, delete, locked rows not editable).

## 7. D: Pause a Bot

### 7.1 Semantics

- **Pause** (Bot `•••` menu, profile, phone):
  1. persist `paused: { since, by: "mac" | "phone" | "cli" }` in `main/services/bot-pause-store.ts`, which is separate from `BotDefinition` so it never bumps the identity revision;
  2. if a turn is running, leave it **interrupted** (resumable, like a quit) rather than dismissed;
  3. withdraw open questions and hand-offs (they come back on Resume);
  4. stop the Bot's computer (E).
- **While paused:**
  - the composer shows "Ada is paused" with **Resume** (decision 5);
  - Remote `POST /bots/{id}/messages` returns 409 `bot_paused`;
  - Telegram replies with one fixed line;
  - routine fires are recorded as `skipped` with a new reason, `paused_by_person` (the existing `bot_paused` means interrupted and stays as is);
  - background memory review is held.
- **Resume:** clear the flag. An interrupted turn shows the existing Resume/Dismiss card. A notice entry says "3 routines skipped while paused" with **Run now** per routine (decision 4: no automatic catch-up).

### 7.2 Code

- `bot-session-service.ts`: `pause(botId)` and `unpause(botId)`. `resume` is already the method for an interrupted turn, so the code, IPC (`bots:pause`, `bots:unpause`) and Remote names say *unpause*, even though the button reads **Resume**. Pausing needs a way to close one Bot's harness while a task is live. `harness-host.ts` only idle-closes today ("only with no live task"), so add a forced per-Bot close with the same bounded abort used at quit, and test that the turn comes back `interrupted`.
- `BotSessionState` gains `{ kind: "paused"; interrupted?: string }`. `bot-status-line.tsx` and `bot-sidebar-rows.ts` show "Paused".
- **Legacy wire projection (in this PR, before Remote rev 36).** Shipped iOS (`AidenBotSessionStateKind`) and Android (`AidenBot.kt`) clients decode Bot state as a closed enum, and `projectBotSessionState` (`aiden-remote-bot-session.ts`) passes kinds straight through. So it must map `paused` to `{ state: "unavailable", interrupted: false }` everywhere a state goes out: session snapshots, `state` frames, list and detail `sessionState`, and mutation responses. Only devices holding `bot:handoffs` (rev 36) see `paused`. Phone writes to a paused Bot (messages, resume, dismiss, running a routine) are refused with an error code shipped clients already know, picked from `AIDEN_REMOTE_ERROR_CODES` in this PR. `bot_paused` goes only to `bot:handoffs` devices.
- `scheduled-bot-routines.ts`: check the pause store before the state switch, and add `paused_by_person` to `ScheduledRunSkipReason` (`main/services/types.ts:497`). `createBotRoutineCatchUp` ignores it.
- Telegram ingress (`telegram/bot-reply-outbox.ts` path): reply with the fixed line instead of submitting.
- CLI: `aiden bots pause <id>` and `aiden bots unpause <id>` through the running `aiden serve`. Update `packages/cli/README.md`.

### 7.3 Tests

Cross-version decoding: a paused Bot's snapshot, frames, list and detail responses decode with the current (rev 35) contract fixture and native parsers. `bot-session-service.test.ts` (pause while running → interrupted; send while paused refused; resume restores the interrupted card), `scheduled-bot-routines` tests (skip reason, no catch-up), the Telegram ingress test, render tests for the paused composer and sidebar row, and the Remote route tests.

## 8. E: Bot computers (Lume)

### 8.1 What the person sees

- Settings → **Bot computers** (Apple silicon only): what it is, disk and memory needs, **Set up** (downloads the macOS restore image, about 17 GB, with progress and size up front; Lume itself is bundled), maximum running computers, an idle stop time, disk used, and **Remove everything**.
- Bot profile → **Computer**: **Give Ada a computer** (per Bot, decision 9). Creating it is a near-instant APFS clone of the shared base.
- The Bot side panel gains a **Computer** tab: the live screen with the Bot's avatar at its pointer, a status line ("Ada is using Safari"), and **Take over** / **Give back**. **Float over chat** reuses the device floating player.
- The computer starts only when the Bot needs it (a `computer` tool call, the person opening the tab, or a routine that uses it), and stops after the idle time. A banner shows "Starting Ada's computer…".

### 8.2 Runtime and pinning

- **Vendored Lume.** Vendor the notarized `lume-<version>-darwin-arm64.tar.gz` from the `lume-v0.6.1` release. Pin the archive and binary SHA-256 values, the Team ID and the signing identifier in `resources/bot-computers/lume-artifact.json`, and compile the security-critical values into main, as `cua-driver` does (`docs/computer-use-integration.md`). Upgrades come only with Aiden releases.
- **Bundle the binary.** The Lume binary is small enough to ship inside the app, which avoids a second network action. Only the macOS image is downloaded, on Set up.
- **Process rules.**
  - Run only the vendored path, with `LUME_TELEMETRY_ENABLED=false` and `LUME_UPDATE_CHECK=false`.
  - Never run `lume serve`: its HTTP API on `localhost:7777` has no authentication.
  - Never run the installer, `lume update` or `lume pull` from a registry.
  - Every command names Aiden's storage path (`<userData>/bot-computers/vms`) explicitly: `--storage` where a command takes it, and `--source-storage` plus `--dest-storage` for `clone`, which has no `--storage` flag. That way Aiden never touches the person's own `~/.lume` VMs or configuration.
- **Entitlement check (E0).** Lume needs `com.apple.security.virtualization`, which its own signature carries. Confirm that a vendored, upstream-signed `lume` launched from Aiden's helper keeps working inside the notarized Aiden bundle, as `CuaDriver.app` does.

### 8.3 The base image and clones

1. **Restore image.** Pin the IPSW URL, size and SHA-256 in source (`main/services/bot-computers/release.ts`, like `antigravity/release.ts`), decision 8. Download it with resume and hash verification.
2. **Base VM.** `lume create aiden-base --ipsw <file> --unattended tahoe --storage …`. Then Aiden, over `lume ssh` with the preset's default `lume`/`lume`:
   - installs an Aiden SSH key (ed25519, `0600` in userData), disables password SSH, and sets a random `lume` password kept in the encrypted credential store;
   - turns off guest telemetry prompts and automatic updates (updates come with a new base);
   - creates `~/Shared` (the shared folder mount point, §8.6).
3. **Per Bot.** `lume clone aiden-base bot-<dir> --source-storage <path> --dest-storage <path>` copies disk and NVRAM together. Disks are sparse, so a clone costs only what the Bot writes. A **Reset computer** action deletes and re-clones it.
4. **New base.** When a new Aiden release pins a newer IPSW, Set up offers **Update base**. Existing Bot clones keep running on the old base until the person resets them (shown in the Computer section).

### 8.4 Lifecycle and limits

- `main/services/bot-computers/host.ts` owns `lume run <vm> --detach --display none --vnc-password <random per run> --shared-dir <botHome>/Computer:rw --storage …`, `lume get --format json` (state, IP, VNC URL), `lume shutdown`/`stop` with bounded timeouts, and crash recovery: on startup, `provisioning (stale)` VMs are reported and offered for reset.
- **Concurrency.** Apple allows at most two macOS VMs running at once on a Mac. E0 must confirm the exact Virtualization.framework error. Enforce `maxRunning` (default 2, setting 1–2). A start beyond the limit stops the least recently used idle computer first, or else queues with "Waiting for another Bot's computer".
- **Memory and disk.** Lume asks for about 8 GB free memory per running macOS VM and about 50 GB for the base. Check both before Set up and before each start, and refuse with a clear message.
- **Idle stop:** default 10 minutes after the last `computer` call or viewer close. **Pause** (D) stops the computer immediately.
- **Delete Bot:** a `computer` step in the `delete_bot` journal (stop, then `lume delete bot-<dir>`), idempotent like the other steps.

### 8.5 Seeing and taking over

- **Viewer.** Lume starts a VNC server per run with a random password. Two options for E0 to decide between:
  - (a) noVNC (MPL-2.0) in the renderer over a main-process WebSocket↔TCP bridge to the loopback port;
  - (b) a small RFB client in main that turns frames into the existing flat device viewer's MJPEG path.
  - *Lean: (b)*, because it keeps the VNC password and socket in main and reuses the device viewer, floating player and phone viewer pipeline later.
  - *Shipped (2026-10-21, PR #559): (b).* A main-side RFB client feeds a loopback viewer hub behind its own device hub proxy, and the Computer tab uses the existing `createDeviceStreamClient` with `preferMjpeg`.
- **VNC binding.** E0 must confirm Lume's VNC listener binds only to loopback. If it doesn't, Aiden must not use it.
- **Take over.** It interrupts the Bot's current `computer` call (the turn stays alive and waits), switches the viewer to interactive, and shows **Give back**. Giving back resumes with a tool result note: `The person used the computer; take a fresh capture first.` Any physical input in the viewer also counts as Take over. While the person has control, `computer` captures are refused, so the model never sees a sign-in in progress. After Give back, macOS secure fields show only dots, but a plaintext one-time code left on screen is not masked in the VNC lane. That gap is listed in §13.
- **Pointer avatar.** Draw the Bot's avatar at the last action point the Bot used (from the action arguments). That needs no guest cursor query.

### 8.6 How the Bot drives it

- **New tool `computer`**, separate from `computer_use`, so the model and policy can't mix up "my own computer" with "the person's Mac". Same schema family and guidance as `computer_use` (capture, click, type, key, scroll, drag, wait, verify). It is offered when the Bot has a computer and the `computer` capability (`bot-capability-catalog-core.ts`).
- **Control lane (decision 7):**
  - **VNC lane** (recommended first): screenshots and pointer/keyboard input go through the VNC session from the host. It needs no guest software and no guest permissions, and works even at the login window. It's vision-only, with no accessibility tree.
  - **Guest driver lane** (second): run the pinned `cua-driver` inside the guest as a LaunchAgent in the logged-in session, and reach its MCP over an SSH-forwarded stdio channel. This plugs into `ComputerUseController` through a new `CuaDriverHostFactory` and a `Transport` over SSH (`computer-use/session.ts`). It gives the som/ax modes. It needs Accessibility and Screen Recording granted *inside the guest* once. The base-image setup walks the person through that in the live view, and clones inherit it.
- **Shell in the computer:** `computer_shell({ command })` over SSH as `lume`, with a bounded output (reuse `bounded-shell-command.ts`) and a timeout. This lets the Bot install tools inside its own computer without touching the person's Mac.
- **Files:** `<botHome>/Computer` is shared read-write at `/Volumes/My Shared Files` in the guest. That's the one way files move between the computer and the Bot's Files panel. Nothing else of the person's Mac is shared.
- *Shipped (2026-10-21, PR #559):* both lanes. The VNC lane is the default. The guest driver lane uses Aiden's pinned cua-driver 0.36.0 (the same pin as Computer Use, not the 0.34.1 assumed here). Only its upstream-signed executable is copied into the base, and the guest checks its hash and signature. It is bridged with `cua-driver mcp --embedded --socket` over SSH rather than `nc -U`. The lane is used only after the base's grant probe passes, and only for `capture` with `app` and element clicks; screenshots, typing, keys, drags and scrolls stay on VNC.

### 8.7 Policy inside the Bot's computer

- **Baseline is allowed.** Actions inside the Bot's own VM don't ask per click. That's the point of the feature, and the VM is the boundary.
- **Rules still apply** (§6): purchase, communicate, publish and delete ask, and credentials and money hand off. VNC-lane clicks are coordinates, so every mutating `computer` action carries a required short `intent` ("Click Place order"). The classifier reads that intent and the window title, plus the guest driver's element roles once that lane exists. *Known gap:* in the VNC-only lane the classifier depends on the Bot's own description, so the guidance also tells the Bot to call `hand_off` for credentials and payments. The rules editor says so.
- **Routines may use the computer unattended.** That is new. Today routines can't use Computer Use, because it asks per action.
- **Network:** the guest uses Lume's default NAT, so it has the open internet. Note in docs that services listening on the Mac's interfaces are reachable from the guest. Aiden Remote stays authenticated, so that's acceptable.

### 8.8 Sign-in in the Bot's computer

`sign_in` on a Bot that is using its computer shows **Open Ada's computer**. It opens the Computer tab in Take over mode with Safari at the origin. The person signs in and taps **I'm signed in**, and the session stays in the guest. Nothing goes into a vault, and the model never sees the password.

*Shipped (2026-10-21, PR #559).* `sign_in` takes `where: "computer"` when the Bot has a computer and Bot computers are on. Open hands the computer to the person before anything opens, stops the guest driver, and runs `/usr/bin/open -b com.apple.Safari <origin>`. The computer is given back when the card settles or is withdrawn. Give-back-on-settle lives in the computer opener (`bot-runtime/bot-computer-handoff.ts`), not in a separate holds module. Known limit: stopping the guest driver is one sweep, so a program the Bot left running in the guest is not stopped by it ([docs/bot-computers.md](../bot-computers.md)).

### 8.9 Phones

v1 shows the computer's state on Bot detail ("Ada's computer is running"). A live phone view reuses the simulator viewer pipeline (`simulators:mobile`) in a later revision.

*Not built yet (2026-10-21, PR #559).* Phones show "Using its computer" through the existing activity phases while the Bot uses it, but Bot detail has no computer state, and the Remote contract has no field for one.

### 8.10 Tests and acceptance

- `tests/e2e/lume-fake.mjs`: a fake `lume` CLI (like `agent-device-fake.mjs`) that records arguments and emulates `create`, `clone`, `run`, `get` and `delete`, including the stale and limit errors. Host tests cover pinning, the environment (telemetry off), storage isolation (the fake fails any call without Aiden's `--storage`, or for `clone` without both `--source-storage` and `--dest-storage`), lifecycle, the concurrency cap, idle stop, and delete idempotence.
- RFB client tests against recorded frame fixtures.
- `main/services/bot-computers/integration.test.ts` runs a real Bot session with the real host (driving the fake Lume, whose VM forwards its VNC listener to the fake RFB server), sessions, RFB screen, viewer, IPC handlers and the `computer` tool. It covers Give, a capture that boots the VM, a click that lands, Take over interrupting the call and Give back returning the note, Pause stopping the VM, and Delete Bot removing it.
- Packaged acceptance script `scripts/bot-computers-packaged-acceptance.mjs` (owner Mac only, like `computer-use-packaged-acceptance.mjs`): create the base, clone, run, capture, click, take over, then delete.
  - *Shipped (2026-10-21, PR #559):* `AIDEN_BOT_COMPUTERS_ACCEPTANCE=1 npm run test:bot-computers:packaged`. The operator follows the prompts while the script plays the model: Set up, Give, a capture and a click, Take over and Give back, `computer_shell`, Pause, Delete Bot and Remove everything. It writes `build/bot-computers-acceptance-receipt.json`. Its pure core is tested in CI.

## 9. Remote contract revision 36

Claim 36 (the next after `main`'s 35) at merge time, and update the fixture, OpenAPI, iOS and Android together.

**The `/server` feature budget is full.** `/server` already announces 32 feature tokens (30 in `aiden-remote-protocol.ts` plus the provider-create and TTS tokens), and shipped iOS clients reject more than 32 (`AidenRemoteClient.swift:226`). So revision 36 adds **no new feature token**. (Since main's 004d2f9b, `/server` features are scoped per device type, and a fully wired host gives phones 30 tokens and desktops 28. Two spare tokens are still too few to spend here, so the capability route stays; it shipped as revision 37.) Instead:

- add a negotiable device capability `bot:handoffs` (with `AIDEN_REMOTE_NEGOTIABLE_CAPABILITIES`). New clients request it in **its own** `POST /device/capabilities` call, so an older host's 400 for an unknown capability only means "unsupported" and never blocks other grants;
- for devices holding `bot:handoffs`:
  - `BotSession.handoff` (required, nullable: `{ waitId, kind: "action" | "sign_in", action, why?, open? }`) and `handoff` frames;
  - `POST /bots/{id}/handoffs/{waitId}/answer` (`bot:read` + `bot:write`, Idempotency-Key, body `{ outcome, note? }`, `handoff_expired` once nothing waits);
  - `POST /bots/{id}/handoffs/{waitId}/open-on-mac` for sign-in;
  - `paused` on Bot detail and summary;
  - `POST /bots/{id}/pause` to pause and `DELETE /bots/{id}/pause` to unpause (`POST /bots/{id}/resume` already exists for resuming an interrupted turn, so unpausing must not reuse it);
  - error `bot_paused`;
- devices without it get a `state` frame and a text notice "Ada needs you on your Mac", the same fallback pattern as `bot:cards`, and see a paused Bot as `unavailable` (the legacy projection that ships in PR 2, §7.2).

Clients:

- iOS: `Models/AidenBotSession.swift`, `Features/Bots/AidenBotSessionChatView.swift` (card), `AidenBotProfileView.swift` (Pause).
- Android: `features/bots/AidenBotSessionScreen.kt`, `AidenBotSessionController.kt`, and a new `AidenBotHandoffCard.kt` next to `AidenBotApprovalCard.kt`.
- Run the native suites, which `AGENTS.md` requires for shared contract changes.

## 10. Decisions for the owner

Answer in shorthand ("1a 2a …"). **Bold** marks the recommendation that work proceeds on unless told otherwise.

1. **Bot browser profile:** **a) a separate profile per Bot** · b) share the person's Default profile (the Bot sees all their sign-ins).
2. **Hand-offs on routine and Telegram turns:** **a) no card; a rule hand-off ends that step and the result says what's needed** · b) the routine waits on a card and notifies.
3. **Custom rules:** **a) prompt plus word matching that can only tighten** · b) prompt only, like Cua · c) a small model classifies each action (cost and latency on every call).
4. **Missed routines while paused:** **a) skip them and offer Run now on Resume** · b) catch up the newest automatically, as after an interruption.
5. **Messages to a paused Bot:** **a) blocked, with a Resume button** · b) sending a message resumes the Bot.
6. **Bot computer OS:** **a) macOS guests only first** · b) also Linux guests (Lume `--os linux`; the guest driver story on Linux is weaker, see `linux-cua-driver-gap-audit.md`).
7. **Control lane:** **a) VNC lane first, guest driver second** · b) guest driver from the start (better element targeting, more setup).
8. **macOS image:** **a) a pinned Apple IPSW (URL and hash in source, updated with Aiden releases)** · b) whatever `lume ipsw` says is latest at Set up · c) Cua's prebuilt registry images.
9. **Who gets a computer:** **a) per-Bot opt-in, started on demand** · b) every Bot by default.

## 11. Phases and PRs

| # | PR | Depends on | Size |
|---|---|---|---|
| 1 | **Hand-off core + desktop** (§4 without Remote) | — | M |
| 2 | **Pause core + desktop + CLI**, including the legacy wire projection (§7.2) so shipped phones keep decoding | — | M |
| 3 | **Rules** (§6: classifier, corpus, store, enforcement for Computer Use and MCP, editor, prompt) | 1 | M–L |
| 4 | **Remote rev 36 + iOS + Android** for hand-offs and pause (§9) | 1, 2 | L |
| 5 | **Bot browser** (§5.1, plus browser signals in the rules classifier) | 3 | L |
| 6 | **`sign_in`** (§5.2, desktop plus the phone "Finish on your Mac" path) | 4, 5 | M |
| E0 | **Lume spike** on the owner's Apple silicon Mac: vendored and signed Lume runs from the Aiden bundle; base from a pinned IPSW; clone; detached run; loopback-only VNC; the two-VM limit error; RFB capture and input; `--shared-dir`; SSH key setup. Output: a short spike note and a go/no-go. | — (parallel) | S–M |
| E1 | **Bot computers host** (§8.2–8.4): Settings page, base setup, clone, lifecycle, limits, delete step, `AGENTS.md` network rule | E0, 2 | L |
| E2 | **Viewer + Take over** (§8.5) in the Bot panel and floating player | E1 | M–L |
| E3 | **`computer` tool, VNC lane + `computer_shell` + shared folder**, with rules baseline (§8.6–8.7) and routine use | E2, 3 | L |
| E4 | **Guest driver lane** (§8.6) and computer sign-in (§8.8) | E3, 6 | L |

PRs 1 and 2 can start right away and in parallel. The E0 spike needs the owner's Mac, because cloud sessions run on Linux. It runs through Remote Control, which has dropped after a few minutes before, so the owner should keep the Mac awake for it.

## 12. Docs, onboarding and housekeeping (each PR updates its own)

- `README.md` and `PRODUCT.md` Bots sections. A new `docs/bot-computers.md` for E (setup, disk and memory, limits, privacy and network, removal). `docs/environment-browser.md` (Bots now get browser tools in their own profile). `docs/aiden-remote-api-v1.md` and the OpenAPI for rev 36. `packages/cli/README.md` (pause, hand-off).
- `AGENTS.md`: a release-metadata paragraph for Lume and the IPSW (manual-only, pinned, no `serve`, telemetry off), next to the Antigravity rule.
- `main/services/host-platform-capabilities.ts`: `botComputers` (darwin + arm64).
- Onboarding: the Bots step mentions hand-offs and rules in one line. Add a feature-gallery tile for **Bot computers** once E3 ships, with its own code-drawn illustration in `renderer/components/onboarding-art/`, covered by the onboarding art test.
- Register every new test file in the `package.json` test scripts and `scripts/ci-test-registry.json`.
- Move this plan to `completed/` and update its row in `docs/plans/README.md` as phases land.

## 13. Risks

- **Classifier misses.** Keyword and label matching will miss some purchases or messages. Mitigations: the locked classes use structured signals (secure fields, card autocomplete), rules only tighten, today's approvals stay as the baseline, and the editor says what rules don't cover (shell).
- **VM resource cost.** macOS guests are heavy (RAM, about 50 GB base). Mitigations: per-Bot opt-in, on-demand start, idle stop, a cap of two, and clear checks before Set up.
- **Upstream churn.** Lume is young (0.6.x) and every `cua-driver-rs` release is marked pre-release. Mitigations: exact pins, a reviewed upgrade per Aiden release, and a fake-CLI test suite.
- **Codes on a Bot computer's screen.** In the VNC lane, a one-time code shown in plain text after the person gives control back is visible to the model's next capture. Mitigations: the guidance tells the Bot to hand off codes, and the guest driver lane can mask secure elements by role.
- **Apple licensing.** macOS guests are allowed only on Apple hardware, two at a time. This is why the feature is Apple-silicon-only and the cap is enforced.
- **Remote budget.** Any future Bot feature also has to use negotiated capabilities until the clients' 32-token `/server` cap is raised in a coordinated client release.
