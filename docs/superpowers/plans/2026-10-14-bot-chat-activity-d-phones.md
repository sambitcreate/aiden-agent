# Bot chat activity · Slice D (phones) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a Bot works, iPhone and Android show the same calm status line as the Mac ("Getting ready", "Reading", "Using Notion", "Reconnecting to your Mac"). People can Steer or Queue while it works, queued messages show faded with "Queued", a working Bot's face glances in Bots home, and each Bot's Chat activity choice can be changed from a native page. All of this runs over Aiden Remote contract revision 30 behind `bot-activity-v1`.

**Architecture:** The Remote session projector (`aiden-remote-bot-session.ts`) derives each running turn's phase with slice B's pure `liveBotActivity` over its own conversation watch. It cuts the result to the §11 allow-list `{ phase, app?, startedAt }` and publishes it, with the person's waiting inputs (B's `liveQueuedMessages`), as two new SSE frames under the existing one-seq-after-the-last rule. A device opts into those frames, and into Bot detail `chatActivity`, with the negotiable `bot:activity` (the same pattern as revision 27's `bot:cards`). Every other device gets a no-op `state` frame at that seq. Stop and Resume go through one small process-wide emitter (`botTurnIntents`), so a Stop pressed on the Mac or on a phone reads "Stopping" on both. iOS and Android each keep one phase table, checked against a shared fixture. Each derives a pure status-line value from its session model and draws it with the native activity marks. The Chat activity page saves through `PATCH /bots/{id}` on every pick.

**Tech Stack:** Electron main (Node, `@earendil-works/pi-durable` harness, `node:test` via `tsx --test`, pi-ai faux provider). iOS 18 SwiftUI with XCTest. Android Kotlin, Jetpack Compose Material 3 Expressive (the app's `ui/theme` layer), kotlinx.serialization, JUnit 4 and kotlinx-coroutines-test.

**Spec:** [`docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md`](../specs/2026-10-14-bot-chat-activity-design.md). Slice D covers §2 decisions 3, 4 and 11, the §4 D row, §5 (words, §5.1 and §5.2), §7 (the Chat activity page on phones), §11, §12, §14 and the iOS/Android rows of §16.

**Stack:** A → B → C1 → C2 → D. This plan **consumes slice B's names exactly** ([plan](2026-10-14-bot-chat-activity-b-status-line.md), rulings in `.superpowers/sdd/notes/b-plan-rulings.md`). From `renderer/shared/bot-activity.ts`: `BOT_ACTIVITY_PHASES`, `botActivityDisplay(phase, wording, app?)` and `botElapsedLabel(startedAt, now)`. From `renderer/shared/bot-live.ts`: `BotLiveActivity`. From `main/services/bot-runtime/live-projection.ts`: `liveBotActivity(input: BotLiveActivityInput)` and `liveQueuedMessages(docs)`. From `BotLiveProjection`: `notifyStopping` and `notifyResuming`. From `renderer/shared/bots.ts`: `BOT_CHAT_ACTIVITY_LEVELS`, `BOT_CHAT_ACTIVITY_WORDINGS`, `BotChatActivityLevel`, `BotChatActivityWording`, `BotChatActivity` and `resolveBotChatActivity`, plus `BotDefinition.chatActivity` and `BotUpdateInput.chatActivity` (absent keeps the stored value). D has no code dependency on C1/C2.

## Findings this plan rests on

- **Older phones are strict.** iOS `AidenBotSession` and `AidenBotSessionEvent` call `requireOnlyKeys` and throw on an unknown event `type`. Android `AidenBotWireJson` has `ignoreUnknownKeys = false`, and it also decodes Bot detail with it. A token in `/server.features` therefore isn't enough: the host must know the device can parse the new frames. Revision 27 solved the same problem with the negotiable `bot:cards` and a no-op `state` frame at the same seq. D copies that design with `bot:activity`.
- **The Remote projector is not the desktop projection.** `BotLiveProjector` attaches its own `conversation.watch`, so it can call B's pure `liveBotActivity` with the same `entries` and `docs`. It cannot see the desktop feed's private `stopping`/`resuming` flags, which is why the intents emitter exists.
- **Phones only show a user message once its entry exists.** A queued input sits in `pi.inbox` until its turn starts. A Queued bubble therefore needs the inbox on the wire.
- **The iOS Xcode project does not use synchronized folders.** This plan adds **no new Swift files**, so it needs no `project.pbxproj` edits. All Swift goes into existing files. New Kotlin files need no registration.
- **Android unit tests run on the JVM without Robolectric.** The shared fixture is on the test classpath (`build.gradle.kts` adds `protocol/aiden-remote/v1/fixtures`). `R.string` ids exist. `File("src/main/res/values/strings.xml")` is readable, with `AidenProviderIconTest` reading `src/main/res/drawable` as precedent.
- **Feature-list bound.** iOS `AidenServer` refuses more than 32 features. A phone can receive at most 24 today, so 25 is fine.
- **Revision.** This branch and `origin/main` are both at **29** (`AIDEN_REMOTE_CONTRACT_REVISION`). D provisionally claims **30**. At merge, re-claim the next revision after `main`'s and update TS, iOS, Android and the fixtures together (AGENTS.md).

## Rulings on spec ambiguities

1. **Per-device opt-in.** The spec names only the token. D adds the negotiable `bot:activity` (no authority, any device type), offered only while the token is announced. Holding it changes what the host *sends*: the `activity`/`queued` frames, the snapshot `activity`/`queued` keys, and Bot detail `chatActivity`. The token alone gates what the host *accepts*: `whenBusy`, and `chatActivity` on `PATCH`. Phones show the new UI only when the token is announced **and** the grant is held.
2. **Queued on the wire.** §12's Queued bubble needs data the wire lacks. D adds a `queued` frame and a snapshot `queued` list `{ submissionId, mode: "steer" | "queue", text }`, with at most 20 items and text of at most 32,000 code points. It carries only the person's own inputs, because B's `liveQueuedMessages` leaves out routine and hidden inputs. The `activity` allow-list is unchanged. Phones get **no Remove**: §12 doesn't list it and there is no Remote withdraw route. It is recorded as a follow-up.
3. **Shared Stop/Resume intents.** `botTurnIntents` (`main/services/bot-runtime/bot-turn-intents-main.ts`) is announced by `main/handlers/bots.ts` (replacing B's direct `notifyStopping`/`notifyResuming` calls) and by the Remote Stop/Resume routes. The desktop live projection and every Remote projector listen to it.
4. **When the phone line shows.** It shows when the token and grant are present, the state is `running`, and one of these holds:
   - The stream is down: "Reconnecting to your Mac".
   - No partial text is showing: the activity's phase, or `preparing` before the first activity frame arrives (success criterion 1).

   Elapsed time is the host's `startedAt` against the phone's clock. It is nil under 20 s **and when negative** (clock skew). Phones do **not** show the 2-minute "Still going…" note: §12 lists the phone line's parts, and phones are "always minimal".
5. **Unknown phase ids** decode when they match `^[a-z][a-z_]{0,31}$` and render as `working` (§5.2).
6. **Steer/Queue on phones.**
   - The pill defaults to Queue and resets to Queue when the turn ends, matching normal chats.
   - Stop stays where it is today: in the iOS composer and in Android's top bar.
   - Without the token, phones behave as they do today.
7. **Phone previews.** Each row's looping preview illustrates what that level shows **on the Mac** (the desktop page's script), because the phone's own chat is always minimal. Under Reduce Motion the preview shows its still frame. §12 says "pause", so phones have no Play control.
8. **Faces.** A canonical face's eyes follow the shared `glance` keyframes (docs/activity-marks.md). A photo avatar gets a small `glance` mark badge. Both hold their still pose under Reduce Motion. This replaces the green "working" dot in Bots home.
9. **Detail `chatActivity`** is always present for `bot:activity` holders, resolved with `resolveBotChatActivity` (absent on the record means quiet / follows).
10. **Android copy.** Phase words and page copy go in `strings.xml`. The elapsed label (`"1m 12s"`) stays English, like `AidenTurnElapsed` (the JVM-tested presentation helper exception in `.memory/android-localization.md`).

## Global Constraints

- Contract revision **30** (provisional; claim the next after `main`'s at merge). TS, iOS, Android and `protocol/aiden-remote/v1/fixtures/contract.json` change together.
- `bot-activity-v1` is announced, and `bot:activity` is offered and negotiable, only while **both** the session service has `turnIntents` (`supportsActivity`) and the Bot service has `chatActivity: true` (`supportsChatActivity`).
- Activity wire shape, exactly: `{ phase: string, app?: string, startedAt: number } | null`.
  - `phase` matches `^[a-z][a-z_]{0,31}$`.
  - `app` is 1–40 code points.
  - `startedAt` is an integer from 0 to `Number.MAX_SAFE_INTEGER`.
  - Nothing else crosses: no `step`, `detail`, path, command, query or thinking.
- Queued wire shape, exactly: `{ submissionId: /^[A-Za-z0-9._:-]{1,64}$/, mode: "steer" | "queue", text: 1–32,000 code points }`, at most 20, with unique ids.
- Frames keep the one-seq-after-the-last rule. A device without `bot:activity` gets `state` with its current state view at an `activity`/`queued` seq.
- `whenBusy: "steer" | "queue"` maps to `steer` / `followUp`. Without `whenBusy`, behaviour is today's queue. Hosts without the token reject the key (`invalid_request`).
- `PATCH /bots/{id}` `chatActivity` takes exact keys `level` (`quiet|summary|detailed`) and `wording` (`follows|thinking`). An absent `chatActivity` keeps the stored value (B ruling 2).
- Phase words, marks and ids are exactly §5. Always "Thinking" keeps the words of `waiting`, `stopping` and `reconnecting` only.
- Phones never show steps, recaps or the hover peek in a chat.
- Elapsed after 20 s reads "· 1m 12s". There is no Stop on the line.
- The status line's accessible name is the word. Announcements come at most once every 2 s.
- Copy, exact: "Queued", "Reconnecting to your Mac", "Chat activity", "How much to show", "What the status line says", "On iPhone and Android", "Always just the line, with the same words.", "Quiet", "Summary", "Detailed", "Recommended", "Follows the work", "Always “Thinking”", "Aiden couldn’t save that choice.".
- Motion: marks, faces and previews hold their t = 0 / still pose under Reduce Motion (system or in-app) and while inactive.
- iOS: no new Swift files and no `project.pbxproj` edits. Use the native `Form` for the Chat activity page.
- Android: use the `ui/theme` Expressive layer (`AidenConnectedColumn`, `AidenGroupCard`, `AidenMotion`, `aidenReduceMotion()`). Copy goes in `strings.xml`, following `.memory/android-localization.md`.
- Radio rows have no decorative borders. Selection uses the radio and the tonal or background fill. Keep focus and selection semantics.
- No new desktop test files. Every extended desktop test file is already registered, and `npm run test:ci-policy` must still pass.
- Tests are behavioural. No source greps, no class-string assertions, no tautologies.
- No network calls beyond the existing Remote routes.

## Review Focus

1. **A phone that never negotiated `bot:activity`, or that is paired with an older Mac.** Expected: its stream keeps parsing, every seq stays gapless, it never sees `activity`/`queued` keys, and it never sees `chatActivity` on Bot detail. Tests: Task 2, Step 1, test 2 (stream) and Task 3, Step 1, test 4 (detail).
2. **The session stream drops mid-turn (a Wi-Fi blip).** Expected: the line reads "Reconnecting to your Mac" and returns to the real phase on the next connection's snapshot. It never sticks. Tests: Task 5, Step 1, test 4 (iOS) and Task 9, Step 1, test 4 (Android).
3. **A newer Mac sends a phase this phone doesn't know** (`browsing`). Expected: "Working" with `quad-shuffle`, and no decode failure. Tests: Task 4, Step 1, test 1 (iOS, fixture `teleporting`) and Task 8, Step 1, test 1 (Android).
4. **Stop pressed when nothing is running** (a double-tap after the reply landed). Expected: nothing changes, and the next turn starts at "Getting ready", never "Stopping". Test: Task 2, Step 1, test 3.
5. **Saving a Chat activity choice fails** (revision conflict or offline). Expected: the radio returns to the saved choice, an error shows, and the next pick sends the current revision. Tests: Task 7, Step 1, test 2 (iOS) and Task 11, Step 1, test 2 (Android).

---

## File map

| File | Responsibility |
|---|---|
| Modify `main/services/aiden-remote-protocol.ts` | Revision 30, `bot-activity-v1`, `bot:activity`, activity/queued/chatActivity types and strict parsers, `whenBusy` and `chatActivity` request options, fixture section parser |
| Modify `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json` | Shared `botActivity` and `botActivityPrivacy` fixtures, revision 30, OpenAPI schemas |
| Create `main/services/bot-runtime/bot-turn-intents.ts`, `bot-turn-intents-main.ts` | Process-wide Stop/Resume intents |
| Modify `main/services/aiden-remote-bot-session.ts` | Activity and queued frames, audiences, `whenBusy`, intents |
| Modify `main/services/bot-runtime/bot-session-main.ts`, `main/handlers/bots.ts` | Desktop projection listens to intents; IPC Stop/Resume announce |
| Modify `main/services/aiden-remote-bots.ts`, `aiden-remote-router.ts`, `aiden-remote-state.ts`, `aiden-remote-service-main.ts` | Detail `chatActivity`, PATCH, token, opt-in negotiation, per-device stripping, wiring |
| Modify `ios/AidenOnTheGo/Models/AidenBotSession.swift`, `Models/AidenBot.swift`, `Networking/AidenRemoteContract.swift`, `Networking/AidenRemoteClient.swift`, `Models/AidenInstallation.swift`, `Features/Remote/AidenRemoteCoordinator.swift` | iOS wire models and negotiation |
| Modify `ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift`, `AidenBotSessionChatView.swift`, `AidenBotSemanticAvatarView.swift`, `AidenBotGeneratedAvatarLifecycle.swift`, `AidenBotsHomeView.swift`, `AidenBotAdvancedView.swift` | Phase table, status line, Steer/Queue, Queued bubble, glancing faces, Chat activity page |
| Modify `ios/AidenOnTheGoTests/AidenBotSessionTests.swift`, `AidenRemotePhase0Tests.swift` | iOS tests (four new test classes in the existing file) |
| Modify `android/.../models/AidenBotSession.kt`, `models/AidenBot.kt`, `protocol/AidenRemoteProtocol.kt`, `models/AidenInstallation.kt`, `features/remote/AidenRemoteCoordinator.kt`, `networking/AidenRemoteClient.kt` | Android wire models and negotiation |
| Create `android/.../features/bots/AidenBotActivity.kt`, `features/bots/AidenBotChatActivityScreen.kt` | Phase table, elapsed, announcements, face glance, status line; Chat activity page |
| Modify `android/.../features/bots/AidenBotSessionController.kt`, `AidenBotSessionScreen.kt`, `AidenBotSemanticAvatarView.kt`, `AidenBotCanonicalAvatarView.kt`, `AidenBotsHomeScreen.kt`, `AidenBotAdvancedScreen.kt`, `AidenBotProfileScreen.kt`, `features/chat/AidenComposerView.kt`, `res/values/strings.xml` | Controller state, chat UI, faces, Advanced row |
| Create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotActivityContractTest.kt`, `.../features/bots/AidenBotChatActivityTest.kt`; modify `.../features/bots/AidenBotSessionControllerTest.kt` | Android tests |
| Modify the spec, `docs/plans/README.md`, `.memory/bot-chat-activity.md`, `.memory/bots-rework-ui.md` | Docs and memory |

Paths under `android/...` mean `android/app/src/main/java/sbtbiswas/AidenOnTheGo/`.

---

### Task 1: Revision 30 wire types, strict parsers and shared fixtures

**Files:**
- Modify: `main/services/aiden-remote-protocol.ts`
- Modify: `protocol/aiden-remote/v1/fixtures/contract.json`, `protocol/aiden-remote/v1/openapi.json`
- Test: `main/services/aiden-remote-protocol.test.ts`; revision bumps in `main/services/aiden-remote-operation-contract.test.ts`, `main/services/aiden-remote-router.test.ts`, `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift`

**Interfaces:**
- Consumes: `BOT_ACTIVITY_PHASES`, `botActivityDisplay`, `botElapsedLabel` (B Task 1). `BOT_CHAT_ACTIVITY_LEVELS`, `BOT_CHAT_ACTIVITY_WORDINGS`, `BotChatActivityLevel`, `BotChatActivityWording` (B Task 4).
- Produces (all exported from `aiden-remote-protocol.ts`):
  - `AIDEN_REMOTE_CONTRACT_REVISION = 30`
  - `AIDEN_REMOTE_BOT_ACTIVITY_FEATURE = "bot-activity-v1"`
  - `AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES = ["bot:activity"]` and `AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES` (cards + activity)
  - `AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS = 40`, `AIDEN_REMOTE_BOT_QUEUED_MAX = 20`, `AIDEN_REMOTE_BOT_WHEN_BUSY_MODES = ["steer", "queue"]`, and the type `AidenRemoteBotWhenBusy`
  - `interface AidenRemoteBotSessionActivity { phase: string; app?: string; startedAt: number }`
  - `interface AidenRemoteBotQueuedMessage { submissionId: string; mode: AidenRemoteBotWhenBusy; text: string }`
  - `interface AidenRemoteBotChatActivity { level: BotChatActivityLevel; wording: BotChatActivityWording }`
  - `AidenRemoteBotSession.activity?: AidenRemoteBotSessionActivity | null` and `AidenRemoteBotSession.queued?: AidenRemoteBotQueuedMessage[]`
  - The event payloads `{ type: "activity"; payload: { activity: … | null } }` and `{ type: "queued"; payload: { queued: … } }`
  - `AidenRemoteBotDetail.chatActivity?`, `AidenRemoteBotIdentityPatchRequest.chatActivity?` and `AidenRemoteBotMessageRequest.whenBusy?`
  - `parseAidenRemoteBotSessionActivity(value)`, `parseAidenRemoteBotQueuedMessage(value)`, `parseAidenRemoteBotChatActivity(value)`
  - `parseAidenRemoteBotMessageRequest(value, { allowWhenBusy?: boolean })` and `parseAidenRemoteBotIdentityPatchRequest(value, { allowChatActivity?: boolean })`, both defaulting to refusal
  - `AidenRemoteContractFixture.botActivity?: AidenRemoteBotActivityFixture`

- [ ] **Step 1: Write the failing tests**

In `main/services/aiden-remote-protocol.test.ts`, extend the `./aiden-remote-protocol.js` import with `parseAidenRemoteBotSessionActivity`, `parseAidenRemoteBotDetail`, `parseAidenRemoteBotIdentityPatchRequest`, `parseAidenRemoteBotMessageRequest` and `parseAidenRemoteBotSession` (keep the existing names). Add:

```ts
import { BOT_ACTIVITY_PHASES, botActivityDisplay, botElapsedLabel } from "../../renderer/shared/bot-activity.js";
```

Then append:

```ts
// ---------------------------------------------------------------------------
// Contract revision 30: Bot chat activity on phones
// ---------------------------------------------------------------------------

test("Bot activity frames carry only the §11 allow-list, and every privacy sample is refused", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const fixture = parseAidenRemoteContractFixture(raw);
  const section = fixture.botActivity!;
  assert.deepEqual(section.session, raw.botActivity.session, "the activity session round-trips");
  assert.deepEqual(section.events, raw.botActivity.events, "every activity frame round-trips");
  const shown = [section.session.activity, ...section.events.flatMap((event) => (event.type === "activity" ? [event.payload.activity] : []))];
  for (const activity of shown) {
    if (activity === null || activity === undefined) continue;
    assert.deepEqual(Object.keys(activity).filter((key) => !["phase", "app", "startedAt"].includes(key)), []);
  }
  for (const sample of raw.botActivityPrivacy.rejectedActivities) {
    assert.throws(() => parseAidenRemoteBotSessionActivity(sample), undefined, JSON.stringify(sample));
    const frame = { ...raw.botActivity.events[0], payload: { activity: sample } };
    assert.throws(() => parseAidenRemoteBotSessionEvent(frame), undefined, JSON.stringify(sample));
  }
  for (const sample of raw.botActivityPrivacy.rejectedQueued) {
    assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: [sample] }), undefined, JSON.stringify(sample));
  }
  for (const sample of raw.botActivityPrivacy.rejectedChatActivity) {
    assert.throws(() => parseAidenRemoteBotDetail({ ...raw.botActivity.detail, chatActivity: sample }), undefined, JSON.stringify(sample));
    assert.throws(() => parseAidenRemoteBotIdentityPatchRequest({ chatActivity: sample }, { allowChatActivity: true }));
  }
  const twentyOne = Array.from({ length: 21 }, (_, index) => ({ submissionId: String(index), mode: "queue", text: "x" }));
  assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: twentyOne }), /at most 20/u);
});

test("whenBusy and chatActivity are refused unless the host wires bot-activity-v1", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const send = raw.botActivity.send.request;
  assert.throws(() => parseAidenRemoteBotMessageRequest(send), /unsupported field whenBusy/u);
  assert.deepEqual(parseAidenRemoteBotMessageRequest(send, { allowWhenBusy: true }), send);
  assert.deepEqual(parseAidenRemoteBotMessageRequest({ text: "Hi" }, { allowWhenBusy: true }), { text: "Hi" });
  assert.throws(() => parseAidenRemoteBotMessageRequest({ text: "Hi", whenBusy: "followUp" }, { allowWhenBusy: true }));
  const patch = raw.botActivity.identityPatch.request;
  assert.throws(() => parseAidenRemoteBotIdentityPatchRequest(patch), /unsupported field chatActivity/u);
  assert.deepEqual(parseAidenRemoteBotIdentityPatchRequest(patch, { allowChatActivity: true }), patch);
});

test("the shared phase table is the one the Mac draws, and an unknown phase reads as Working", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const { phases, thinkingKeeps, app, elapsed } = raw.botActivity as {
    phases: Array<{ id: string; word: string; mark: string }>;
    thinkingKeeps: string[];
    app: { app: string; word: string };
    elapsed: Array<{ startedAt: number; now: number; label: string | null }>;
  };
  assert.deepEqual(phases.map((phase) => phase.id), [...BOT_ACTIVITY_PHASES]);
  for (const phase of phases) {
    assert.deepEqual(botActivityDisplay(phase.id, "follows"), { phase: phase.id, word: phase.word, mark: phase.mark });
    assert.equal(botActivityDisplay(phase.id, "thinking").phase, thinkingKeeps.includes(phase.id) ? phase.id : "thinking");
  }
  assert.equal(botActivityDisplay("app", "follows", app.app).word, app.word);
  assert.deepEqual(botActivityDisplay("teleporting", "follows"), botActivityDisplay("working", "follows"));
  for (const row of elapsed) assert.equal(botElapsedLabel(row.startedAt, row.now), row.label, JSON.stringify(row));
});
```

Update the existing assertions the revision changes:
- `aiden-remote-protocol.test.ts:140`: `assert.equal(fixture.contractRevision, 29);` → `30`.
- In the same file's pairing-requests test, under `delete revision19.chatFork;`, add:
  ```ts
  // Bot chat activity is revision 30.
  delete revision19.botActivity;
  delete revision19.botActivityPrivacy;
  ```
- `aiden-remote-protocol.test.ts:1127`: the `BotIdentityPatch properties` list becomes `["name", "purpose", "openingGreeting", "instructions", "avatar", "chatActivity"]`.
- `aiden-remote-operation-contract.test.ts:900`: `29` → `30`.
- `aiden-remote-router.test.ts:4190`: `contractRevision: 29,` → `contractRevision: 30,`.
- `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:139`: `XCTAssertEqual(fixture.contractRevision, 29)` → `30`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/aiden-remote-protocol.test.ts`
Expected: FAIL. The new parsers are not exported, `fixture.botActivity` is undefined, and the revision is 29.

- [ ] **Step 3: Constants, capabilities and the revision**

In `main/services/aiden-remote-protocol.ts`:

1. Add to the imports:
   ```ts
   import {
     BOT_CHAT_ACTIVITY_LEVELS,
     BOT_CHAT_ACTIVITY_WORDINGS,
     type BotChatActivityLevel,
     type BotChatActivityWording,
   } from "../../renderer/shared/bots.js";
   ```
2. Replace the revision block:
   ```ts
    * Contract revision 29: completed `ask_user_question` tool steps on a version 3
    * generation timeline may carry a display-only `questionnaire` recap of the
    * questions and what the owner chose; older clients ignore it.
    *
    * Contract revision 30 (provisional; re-claim the next revision after `main`'s
    * at merge): Bot chat activity on phones (`bot-activity-v1`, `bot:activity`).
    */
   export const AIDEN_REMOTE_CONTRACT_REVISION = 30 as const;
   ```
3. Below `AIDEN_REMOTE_BOT_PROACTIVE_FEATURE`:
   ```ts
   /**
    * Bot chat activity (contract revision 30). Announced only while the host
    * projects the session `activity` and `queued` frames, accepts `whenBusy` on
    * `POST /bots/{botId}/messages`, and serves `chatActivity` on Bot detail and
    * `PATCH /bots/{botId}`. A device opts into the frames and the detail field
    * with the negotiable `bot:activity`.
    */
   export const AIDEN_REMOTE_BOT_ACTIVITY_FEATURE = "bot-activity-v1" as const;
   ```
4. Below `export type AidenRemoteBotCardCapability = …;`:
   ```ts
   /**
    * Contract revision 30: a device holding `bot:activity` receives the session
    * `activity` and `queued` frames and Bot detail `chatActivity`. Like
    * `bot:cards` it grants no authority; any device type may hold it.
    */
   export const AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES = ["bot:activity"] as const;

   /** Opt-ins that change what a device is sent, never what it may do. */
   export const AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES = [
     ...AIDEN_REMOTE_BOT_CARD_CAPABILITIES,
     ...AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES,
   ] as const;
   ```
   Then add `...AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES,` as the last element of both `AIDEN_REMOTE_NEGOTIABLE_CAPABILITIES` and `AIDEN_REMOTE_CAPABILITIES`.
5. In `AIDEN_REMOTE_BOT_SESSION_EVENT_TYPES`, insert `"activity",` and `"queued",` between `"approval",` and `"closed",`.

- [ ] **Step 4: Types**

1. Add to `AidenRemoteBotDetail` (inside the `&` object, after `visionModelSelection?`):
   ```ts
     /** Contract revision 30, only for devices holding `bot:activity`. */
     chatActivity?: AidenRemoteBotChatActivity;
   ```
2. Add to `AidenRemoteBotIdentityPatchRequest`:
   ```ts
     /** Contract revision 30, only on hosts announcing `bot-activity-v1`. Absent keeps the saved choice. */
     chatActivity?: AidenRemoteBotChatActivity;
   ```
3. Directly above `/** State of a Bot's one durable conversation. */`, add:
   ```ts
   // --- Contract revision 30: Bot chat activity.

   export const AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS = 40;
   export const AIDEN_REMOTE_BOT_QUEUED_MAX = 20;
   export const AIDEN_REMOTE_BOT_WHEN_BUSY_MODES = ["steer", "queue"] as const;
   export type AidenRemoteBotWhenBusy = (typeof AIDEN_REMOTE_BOT_WHEN_BUSY_MODES)[number];
   const AIDEN_REMOTE_BOT_ACTIVITY_PHASE = /^[a-z][a-z_]{0,31}$/u;
   const AIDEN_REMOTE_BOT_SUBMISSION_ID = /^[A-Za-z0-9._:-]{1,64}$/u;

   /** What a Bot in a running turn is doing (spec §5). Exactly these keys cross the wire (§11). */
   export interface AidenRemoteBotSessionActivity {
     /** A §5 phase id. Clients render an id they do not know as `working`. */
     phase: string;
     /** The connection's label for `app`, at most 40 code points. */
     app?: string;
     /** When the turn started: the Mac's clock, milliseconds since 1970. */
     startedAt: number;
   }

   /** A message waiting for the running turn: `steer` joins it, `queue` runs after it. */
   export interface AidenRemoteBotQueuedMessage {
     submissionId: string;
     mode: AidenRemoteBotWhenBusy;
     text: string;
   }

   /** A Bot's Chat activity choice (spec §7). */
   export interface AidenRemoteBotChatActivity {
     level: BotChatActivityLevel;
     wording: BotChatActivityWording;
   }
   ```
4. Add to `AidenRemoteBotSession`, after `approval`:
   ```ts
     /** Revision 30, only for `bot:activity` devices: what the running turn is doing, or null. */
     activity?: AidenRemoteBotSessionActivity | null;
     /** Revision 30, only for `bot:activity` devices: the person's messages waiting for the turn. */
     queued?: AidenRemoteBotQueuedMessage[];
   ```
5. Add to `AidenRemoteBotSessionEventPayload`, before the `closed` member:
   ```ts
     | { type: "activity"; payload: { activity: AidenRemoteBotSessionActivity | null } }
     | { type: "queued"; payload: { queued: AidenRemoteBotQueuedMessage[] } }
   ```
6. Replace `AidenRemoteBotMessageRequest`:
   ```ts
   export interface AidenRemoteBotMessageRequest {
     text: string;
     /** Revision 30, only on hosts announcing `bot-activity-v1`. Absent queues, as before. */
     whenBusy?: AidenRemoteBotWhenBusy;
   }
   ```

- [ ] **Step 5: Parsers**

1. Directly above `export function parseAidenRemoteBotIdentityPatchRequest(`, add:
   ```ts
   /** A Chat activity choice: exact keys, known values. */
   export function parseAidenRemoteBotChatActivity(value: unknown): AidenRemoteBotChatActivity {
     if (!isRecord(value)) throw new Error("Bot chat activity must be an object.");
     assertExactKeys(value, ["level", "wording"], "Bot chat activity");
     return {
       level: enumMember(value.level, BOT_CHAT_ACTIVITY_LEVELS, "Bot chat activity level"),
       wording: enumMember(value.wording, BOT_CHAT_ACTIVITY_WORDINGS, "Bot chat activity wording"),
     };
   }
   ```
2. Replace `parseAidenRemoteBotIdentityPatchRequest`:
   ```ts
   export function parseAidenRemoteBotIdentityPatchRequest(
     value: unknown,
     options: { allowChatActivity?: boolean } = {},
   ): AidenRemoteBotIdentityPatchRequest {
     if (!isRecord(value)) throw new Error("Bot identity patch must be an object.");
     const allowed = [
       "name",
       "purpose",
       ...AIDEN_REMOTE_IGNORED_BOT_IDENTITY_FIELDS,
       "instructions",
       "avatar",
       // Revision 30: older hosts reject the key, so phones send it only where it is announced.
       ...(options.allowChatActivity === true ? ["chatActivity"] : []),
     ];
     assertExactKeys(value, allowed, "Bot identity patch");
     if (Object.keys(value).length === 0) {
       throw new Error("Bot identity patch must change at least one field.");
     }
     // A patch carrying only the retired greeting is a valid no-op.
     ignoreRetiredBotGreeting(value, "Bot identity");
     return {
       ...(hasOwn(value, "name")
         ? { name: boundedText(value.name, "Bot identity name", 80) }
         : {}),
       ...(hasOwn(value, "purpose")
         ? { purpose: boundedText(value.purpose, "Bot identity purpose", 280, true) }
         : {}),
       ...(hasOwn(value, "instructions")
         ? { instructions: boundedText(value.instructions, "Bot identity instructions", 32_000) }
         : {}),
       ...(hasOwn(value, "avatar")
         ? { avatar: parseBotSemanticAvatar(value.avatar, true) }
         : {}),
       ...(hasOwn(value, "chatActivity")
         ? { chatActivity: parseAidenRemoteBotChatActivity(value.chatActivity) }
         : {}),
     };
   }
   ```
3. In `parseAidenRemoteBotDetail`, after the `visionModelSelection` spread, add:
   ```ts
       ...(hasOwn(value, "chatActivity")
         ? { chatActivity: parseAidenRemoteBotChatActivity(value.chatActivity) }
         : {}),
   ```
4. Directly above `export function parseAidenRemoteBotSession(`, add:
   ```ts
   /** The §11 allow-list: phase, app and startedAt, and nothing from the step. */
   export function parseAidenRemoteBotSessionActivity(value: unknown): AidenRemoteBotSessionActivity {
     if (!isRecord(value)) throw new Error("Bot session activity must be an object.");
     assertExactKeys(value, ["phase", "app", "startedAt"], "Bot session activity");
     const phase = boundedText(value.phase, "Bot session activity phase", 32);
     if (!AIDEN_REMOTE_BOT_ACTIVITY_PHASE.test(phase)) throw new Error("Bot session activity phase is invalid.");
     return {
       phase,
       ...(hasOwn(value, "app")
         ? { app: boundedText(value.app, "Bot session activity app", AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS) }
         : {}),
       startedAt: boundedIntegerValue(value.startedAt, "Bot session activity startedAt", 0, Number.MAX_SAFE_INTEGER),
     };
   }

   export function parseAidenRemoteBotQueuedMessage(value: unknown): AidenRemoteBotQueuedMessage {
     if (!isRecord(value)) throw new Error("Bot queued message must be an object.");
     assertExactKeys(value, ["submissionId", "mode", "text"], "Bot queued message");
     const submissionId = boundedText(value.submissionId, "Bot queued message submissionId", 64);
     if (!AIDEN_REMOTE_BOT_SUBMISSION_ID.test(submissionId)) throw new Error("Bot queued message submissionId is invalid.");
     return {
       submissionId,
       mode: enumMember(value.mode, AIDEN_REMOTE_BOT_WHEN_BUSY_MODES, "Bot queued message mode"),
       text: boundedText(value.text, "Bot queued message text", AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS),
     };
   }

   function parseBotQueuedList(value: unknown): AidenRemoteBotQueuedMessage[] {
     if (!Array.isArray(value) || value.length > AIDEN_REMOTE_BOT_QUEUED_MAX) {
       throw new Error(`Bot queued messages must contain at most ${AIDEN_REMOTE_BOT_QUEUED_MAX} items.`);
     }
     const queued = value.map(parseAidenRemoteBotQueuedMessage);
     if (new Set(queued.map((message) => message.submissionId)).size !== queued.length) {
       throw new Error("Bot queued message ids must be unique.");
     }
     return queued;
   }
   ```
5. In `parseAidenRemoteBotSession`, add `"activity", "queued"` to the `assertExactKeys` list. After `approval: …` in the returned object, add:
   ```ts
       ...(hasOwn(value, "activity")
         ? { activity: value.activity === null ? null : parseAidenRemoteBotSessionActivity(value.activity) }
         : {}),
       ...(hasOwn(value, "queued") ? { queued: parseBotQueuedList(value.queued) } : {}),
   ```
6. In `parseAidenRemoteBotSessionEvent`'s switch, before `case "closed":`, add:
   ```ts
       case "activity":
         assertExactKeys(payload, ["activity"], "Bot session activity event");
         if (!hasOwn(payload, "activity")) throw new Error("Bot session activity event activity is required.");
         return {
           ...base,
           type,
           payload: { activity: payload.activity === null ? null : parseAidenRemoteBotSessionActivity(payload.activity) },
         };
       case "queued":
         assertExactKeys(payload, ["queued"], "Bot session queued event");
         return { ...base, type, payload: { queued: parseBotQueuedList(payload.queued) } };
   ```
7. Replace `parseAidenRemoteBotMessageRequest`:
   ```ts
   export function parseAidenRemoteBotMessageRequest(
     value: unknown,
     options: { allowWhenBusy?: boolean } = {},
   ): AidenRemoteBotMessageRequest {
     if (!isRecord(value)) throw new Error("Bot message request must be an object.");
     assertExactKeys(value, options.allowWhenBusy === true ? ["text", "whenBusy"] : ["text"], "Bot message request");
     const text = boundedText(value.text, "Bot message text", AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS);
     if (text.trim().length === 0) throw new Error("Bot message text must not be blank.");
     return {
       text,
       ...(hasOwn(value, "whenBusy")
         ? { whenBusy: enumMember(value.whenBusy, AIDEN_REMOTE_BOT_WHEN_BUSY_MODES, "Bot message whenBusy") }
         : {}),
     };
   }
   ```

- [ ] **Step 6: The fixture section parser**

1. Add to `interface AidenRemoteContractFixture`, below `botSessionCards`:
   ```ts
     /** Revision 30: activity sessions, frames, Chat activity and the phase table every client draws. */
     botActivity?: AidenRemoteBotActivityFixture;
   ```
2. Above `export function parseAidenRemoteContractFixture(`, add:
   ```ts
   export interface AidenRemoteBotActivityFixture {
     /** §5 in order: every phase id with its word and mark. */
     phases: Array<{ id: string; word: string; mark: string }>;
     /** Phases that keep their word under Always "Thinking". */
     thinkingKeeps: string[];
     /** "Using {app}" with a sample label. */
     app: { app: string; word: string };
     /** Elapsed labels, including a phone whose clock is behind the Mac's. */
     elapsed: Array<{ startedAt: number; now: number; label: string | null }>;
     session: AidenRemoteBotSession;
     events: AidenRemoteBotSessionEvent[];
     detail: AidenRemoteBotDetail;
     identityPatch: { request: AidenRemoteBotIdentityPatchRequest; response: AidenRemoteBotDetail };
     send: { request: AidenRemoteBotMessageRequest; response: AidenRemoteBotMessageReceipt };
   }

   function parseBotActivityFixture(value: unknown): AidenRemoteBotActivityFixture {
     if (!isRecord(value)) throw new Error("Bot activity fixture must be an object.");
     assertExactKeys(
       value,
       ["phases", "thinkingKeeps", "app", "elapsed", "session", "events", "detail", "identityPatch", "send"],
       "Bot activity fixture",
     );
     if (!Array.isArray(value.events)) throw new Error("Bot activity fixture events must be an array.");
     const identity = requestResponseRecord(value.identityPatch, "Bot activity identity patch");
     const send = requestResponseRecord(value.send, "Bot activity send");
     return {
       phases: value.phases as AidenRemoteBotActivityFixture["phases"],
       thinkingKeeps: value.thinkingKeeps as string[],
       app: value.app as AidenRemoteBotActivityFixture["app"],
       elapsed: value.elapsed as AidenRemoteBotActivityFixture["elapsed"],
       session: parseAidenRemoteBotSession(value.session),
       events: value.events.map(parseAidenRemoteBotSessionEvent),
       detail: parseAidenRemoteBotDetail(value.detail),
       identityPatch: {
         request: parseAidenRemoteBotIdentityPatchRequest(identity.request, { allowChatActivity: true }),
         response: parseAidenRemoteBotDetail(identity.response),
       },
       send: {
         request: parseAidenRemoteBotMessageRequest(send.request, { allowWhenBusy: true }),
         response: parseAidenRemoteBotMessageReceipt(send.response),
       },
     };
   }
   ```
3. In `parseAidenRemoteContractFixture`, directly before `assertNoForbiddenWireKeys(value);` (after the chat-visuals check, so older-revision tests keep failing on their own section first), add:
   ```ts
     let botActivity: AidenRemoteBotActivityFixture | undefined;
     if (value.botActivity !== undefined) {
       if (contractRevision < 30) throw new Error("Bot activity fixtures require contract revision 30.");
       botActivity = parseBotActivityFixture(value.botActivity);
     }
   ```
   In the returned object, add `...(botActivity ? { botActivity } : {}),` as the last property. Do **not** add `botActivity` or `botActivityPrivacy` to `AIDEN_REMOTE_PRIVATE_BOT_FIXTURE_ROOTS`: the privacy section is made of refused samples, and the strict parsers above are the allow-list.

- [ ] **Step 7: The shared fixture**

In `protocol/aiden-remote/v1/fixtures/contract.json`:
- Change both `"contractRevision": 29,` lines (top level and `hostHealth`) to `30`.
- The file ends with the `botSessionCards` object:
  ```json
      "hasOlder": false,
      "question": null,
      "approval": null
    }
  }
  ```
  Replace the last two lines (`  }` and `}`) with:

```json
  },
  "botActivity": {
    "phases": [
      { "id": "preparing", "word": "Getting ready", "mark": "bounce" },
      { "id": "thinking", "word": "Thinking", "mark": "tri-step" },
      { "id": "reading", "word": "Reading", "mark": "scan-grid" },
      { "id": "photo", "word": "Looking at your photo", "mark": "scan-grid" },
      { "id": "searching", "word": "Searching the web", "mark": "scan-grid" },
      { "id": "command", "word": "Running a command", "mark": "quad-shuffle" },
      { "id": "editing", "word": "Editing files", "mark": "quad-shuffle" },
      { "id": "app", "word": "Using an app", "mark": "quad-shuffle" },
      { "id": "helper", "word": "Asking a helper", "mark": "quad-shuffle" },
      { "id": "computer", "word": "Using your Mac", "mark": "quad-shuffle" },
      { "id": "remembering", "word": "Remembering", "mark": "compose" },
      { "id": "routine", "word": "Setting up a routine", "mark": "tri-step" },
      { "id": "working", "word": "Working", "mark": "quad-shuffle" },
      { "id": "writing", "word": "Writing", "mark": "compose" },
      { "id": "waiting", "word": "Waiting for you", "mark": "glance" },
      { "id": "tidying", "word": "Tidying up its notes", "mark": "bounce" },
      { "id": "stopping", "word": "Stopping", "mark": "bounce" },
      { "id": "resuming", "word": "Picking up where it left off", "mark": "bounce" },
      { "id": "reconnecting", "word": "Reconnecting to your Mac", "mark": "bounce" }
    ],
    "thinkingKeeps": ["waiting", "stopping", "reconnecting"],
    "app": { "app": "Notion", "word": "Using Notion" },
    "elapsed": [
      { "startedAt": 1760450000000, "now": 1760450019999, "label": null },
      { "startedAt": 1760450000000, "now": 1760450020000, "label": "20s" },
      { "startedAt": 1760450000000, "now": 1760450072000, "label": "1m 12s" },
      { "startedAt": 1760450000000, "now": 1760450120000, "label": "2m" },
      { "startedAt": 1760450000000, "now": 1760453720000, "label": "1h 2m" },
      { "startedAt": 1760450060000, "now": 1760450000000, "label": null }
    ],
    "session": {
      "botId": "bot_fixture_01",
      "epoch": "epoch_fixture_02",
      "seq": 7,
      "state": "running",
      "interrupted": false,
      "entries": [
        { "type": "message", "id": "entry_30", "role": "user", "text": "Plan dinners for this week.", "createdAt": "2026-10-14T09:00:00.000Z" }
      ],
      "hasOlder": false,
      "question": null,
      "approval": null,
      "activity": { "phase": "app", "app": "Notion", "startedAt": 1760450000000 },
      "queued": [
        { "submissionId": "18", "mode": "queue", "text": "Also add a shopping list." },
        { "submissionId": "19", "mode": "steer", "text": "Keep it vegetarian." }
      ]
    },
    "events": [
      { "protocolVersion": 1, "botId": "bot_fixture_01", "epoch": "epoch_fixture_02", "seq": 8, "type": "activity", "payload": { "activity": { "phase": "searching", "startedAt": 1760450000000 } } },
      { "protocolVersion": 1, "botId": "bot_fixture_01", "epoch": "epoch_fixture_02", "seq": 9, "type": "queued", "payload": { "queued": [ { "submissionId": "18", "mode": "queue", "text": "Also add a shopping list." } ] } },
      { "protocolVersion": 1, "botId": "bot_fixture_01", "epoch": "epoch_fixture_02", "seq": 10, "type": "activity", "payload": { "activity": { "phase": "teleporting", "startedAt": 1760450000000 } } },
      { "protocolVersion": 1, "botId": "bot_fixture_01", "epoch": "epoch_fixture_02", "seq": 11, "type": "activity", "payload": { "activity": null } }
    ],
    "detail": {
      "id": "bot_fixture_01",
      "name": "Scout",
      "purpose": "Finds the signal in a busy week",
      "instructions": "Find the important signal, explain it plainly, and keep the owner in control.",
      "avatar": { "semantic": { "version": 1, "shape": "orb", "color": "rose" }, "asset": { "assetRevision": "avatar_revision_3", "mimeType": "image/png", "width": 512, "height": 512, "byteSize": 1024 } },
      "health": "ready",
      "sessionState": "running",
      "access": { "botId": "bot_fixture_01", "accessMode": "full", "revision": "bot_policy_revision_4", "policyEpoch": "bot_policy_epoch_4", "summary": "Can use your Mac, shell, enabled connections, and skills." },
      "chatActivity": { "level": "summary", "wording": "thinking" },
      "createdAt": "2026-08-18T17:00:00.000Z",
      "updatedAt": "2026-08-18T18:46:00.000Z",
      "revision": "bot_revision_8"
    },
    "identityPatch": {
      "request": { "chatActivity": { "level": "detailed", "wording": "follows" } },
      "response": {
        "id": "bot_fixture_01",
        "name": "Scout",
        "purpose": "Finds the signal in a busy week",
        "instructions": "Find the important signal, explain it plainly, and keep the owner in control.",
        "avatar": { "semantic": { "version": 1, "shape": "orb", "color": "rose" }, "asset": { "assetRevision": "avatar_revision_3", "mimeType": "image/png", "width": 512, "height": 512, "byteSize": 1024 } },
        "health": "ready",
        "access": { "botId": "bot_fixture_01", "accessMode": "full", "revision": "bot_policy_revision_4", "policyEpoch": "bot_policy_epoch_4", "summary": "Can use your Mac, shell, enabled connections, and skills." },
        "chatActivity": { "level": "detailed", "wording": "follows" },
        "createdAt": "2026-08-18T17:00:00.000Z",
        "updatedAt": "2026-08-18T18:47:00.000Z",
        "revision": "bot_revision_9"
      }
    },
    "send": {
      "request": { "text": "Keep it vegetarian.", "whenBusy": "steer" },
      "response": { "submissionId": "19", "deduped": false, "state": "running", "interrupted": false }
    }
  },
  "botActivityPrivacy": {
    "note": "Every decoder must refuse each sample: only phase, app and startedAt cross the wire.",
    "rejectedActivities": [
      { "phase": "command", "startedAt": 1760450000000, "detail": "cat ~/Documents/plan.md" },
      { "phase": "reading", "startedAt": 1760450000000, "step": { "kind": "reading", "label": "Reading", "detail": "plan.md" } },
      { "phase": "reading", "startedAt": 1760450000000, "path": "~/Documents/plan.md" },
      { "phase": "command", "startedAt": 1760450000000, "command": "ls ~/Documents" },
      { "phase": "searching", "startedAt": 1760450000000, "query": "dinner ideas near me" },
      { "phase": "thinking", "startedAt": 1760450000000, "thinking": "The person wants a plan." },
      { "phase": "app", "app": "abcdefghijabcdefghijabcdefghijabcdefghijX", "startedAt": 1760450000000 },
      { "phase": "Reading!", "startedAt": 1760450000000 },
      { "phase": "thinking", "startedAt": -1 },
      { "phase": "thinking", "startedAt": "1760450000000" },
      { "startedAt": 1760450000000 }
    ],
    "rejectedQueued": [
      { "submissionId": "18", "mode": "followUp", "text": "Also add a shopping list." },
      { "submissionId": "18", "mode": "queue", "text": "Also add a shopping list.", "images": 1 },
      { "submissionId": "18 19", "mode": "queue", "text": "Also add a shopping list." }
    ],
    "rejectedChatActivity": [
      { "level": "verbose", "wording": "follows" },
      { "level": "quiet" },
      { "level": "quiet", "wording": "follows", "extra": true }
    ]
  }
}
```

The fixture never names a `/Users/` path (`aiden-remote-protocol.test.ts:178` and the iOS Phase 0 scan check this).

- [ ] **Step 8: OpenAPI**

In `protocol/aiden-remote/v1/openapi.json`:

1. Add `"bot:activity"` after each of the four `"bot:cards"` enum items: two under the `/server` response capabilities, and two under `/device/capabilities`. Keep the JSON valid.
2. In the `/device/capabilities` `accepts` description, append: ` Contract revision 30 adds bot:activity, which any device type may negotiate while the server advertises bot-activity-v1: it grants no authority and only opts the device into the activity and queued Bot session frames and Bot detail chatActivity.`
3. In `components.schemas.BotSessionEvent.properties.type.enum`, insert `"activity", "queued"` before `"closed"`.
4. In `components.schemas.BotSession.properties`, add:
   ```json
   "activity": { "description": "Contract revision 30, only for devices holding bot:activity: what the Bot is doing in its running turn, or null.", "oneOf": [{ "$ref": "#/components/schemas/BotSessionActivity" }, { "type": "null" }] },
   "queued": { "description": "Contract revision 30, only for devices holding bot:activity: the person's messages waiting for the running turn.", "type": "array", "maxItems": 20, "items": { "$ref": "#/components/schemas/BotQueuedMessage" } }
   ```
5. Add to `components.schemas`:
   ```json
   "BotSessionActivity": {
     "description": "Contract revision 30 (bot-activity-v1). Exactly these keys: never a step, detail, path, command, query or thinking. Clients render an unknown phase as working.",
     "type": "object",
     "required": ["phase", "startedAt"],
     "properties": {
       "phase": { "type": "string", "pattern": "^[a-z][a-z_]{0,31}$" },
       "app": { "type": "string", "minLength": 1, "maxLength": 40 },
       "startedAt": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
     },
     "additionalProperties": false
   },
   "BotQueuedMessage": {
     "type": "object",
     "required": ["submissionId", "mode", "text"],
     "properties": {
       "submissionId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,64}$" },
       "mode": { "enum": ["steer", "queue"] },
       "text": { "type": "string", "minLength": 1, "maxLength": 32000 }
     },
     "additionalProperties": false
   },
   "BotChatActivity": {
     "type": "object",
     "required": ["level", "wording"],
     "properties": {
       "level": { "enum": ["quiet", "summary", "detailed"] },
       "wording": { "enum": ["follows", "thinking"] }
     },
     "additionalProperties": false
   }
   ```
6. In `components.schemas.BotDetail.properties`, add `"chatActivity": { "description": "Contract revision 30, only for devices holding bot:activity.", "$ref": "#/components/schemas/BotChatActivity" }`.
7. In `components.schemas.BotIdentityPatch.properties`, add as the **last** property `"chatActivity": { "description": "Contract revision 30, only on hosts announcing bot-activity-v1. Absent keeps the saved choice.", "$ref": "#/components/schemas/BotChatActivity" }`.
8. In `components.schemas.BotMessageRequest.properties`, add `"whenBusy": { "description": "Contract revision 30, only on hosts announcing bot-activity-v1: steer joins the running turn; queue (or no value) runs after it.", "enum": ["steer", "queue"] }`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx --test main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts main/services/aiden-remote-router.test.ts`
Expected: PASS.

Run: `npm run type-check`
Expected: PASS.

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain --tests '*Contract*'`
Expected: PASS. The new fixture sections are top-level keys that the existing decoders ignore.

- [ ] **Step 10: Commit**

```bash
git add main/services/aiden-remote-protocol.ts main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-operation-contract.test.ts main/services/aiden-remote-router.test.ts protocol/aiden-remote/v1/fixtures/contract.json protocol/aiden-remote/v1/openapi.json ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift
git commit -m "Remote revision 30: Bot activity, queued and chatActivity wire shapes with shared fixtures"
```

---

### Task 2: Remote session activity and queued frames, `whenBusy`, shared Stop/Resume intents

**Files:**
- Create: `main/services/bot-runtime/bot-turn-intents.ts`, `main/services/bot-runtime/bot-turn-intents-main.ts`
- Modify: `main/services/aiden-remote-bot-session.ts`, `main/services/bot-runtime/bot-session-main.ts`, `main/handlers/bots.ts`, `main/services/aiden-remote-service-main.ts`
- Test: `main/services/aiden-remote-bot-session.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's types and parsers.
  - `liveBotActivity`, `BotLiveActivityInput` and `liveQueuedMessages` (B Tasks 3 and 8).
  - `BotLiveActivity` (B Task 3).
  - `BotLiveProjection.notifyStopping/notifyResuming` (B Task 3).
- Produces:
  - `type BotTurnIntent = "stopping" | "resuming"`, `interface BotTurnIntents { announce(botId, intent): void; onIntent(listener): () => void }`, `createBotTurnIntents()` and the singleton `botTurnIntents`.
  - `AidenRemoteBotSessionRuntime.send` input gains `whenBusy?: "steer" | "followUp"`.
  - `AidenRemoteBotSessionServiceOptions.turnIntents?: Pick<BotTurnIntents, "announce" | "onIntent">`.
  - `AidenRemoteBotSessionService.supportsActivity: boolean`.
  - `session(botId, { cards?, activity? })` and `openEvents(…, { cards?, activity? })`.
  - Exports `projectBotSessionActivity(live)` and `projectBotSessionQueued(docs)`.

- [ ] **Step 1: Write the failing tests**

In `main/services/aiden-remote-bot-session.test.ts`:

1. Extend the imports:
   ```ts
   import { BOT_ACTIVITY_PHASES } from "../../renderer/shared/bot-activity.js";
   import { createBotTurnIntents } from "./bot-runtime/bot-turn-intents.js";
   ```
2. In `drivenConversation`, add a method next to `emit`:
   ```ts
       /** One watch frame with exactly these docs (`pi.live`, `pi.inbox`). */
       async emitView(entries: RawEntry[], docs: Record<string, unknown>) {
         await listener!({ entries, docs });
       },
   ```
3. Append these helpers and tests:

```ts
// ---------------------------------------------------------------------------
// Contract revision 30: activity and queued frames (`bot:activity`)
// ---------------------------------------------------------------------------

/** Serve one Bot's SSE stream to a device with these opt-ins; keep the raw data lines too. */
async function openAudienceStream(
  service: AidenRemoteBotSessionService,
  audience: { cards?: boolean; activity?: boolean },
  botId = BOT_ID,
) {
  const server = createServer((_request, response) => {
    void service.openEvents("device_1", botId, response, () => {}, audience).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const frames: Frame[] = [];
  const raw: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        raw.push(data.slice(6));
        frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
  })();
  return {
    frames,
    raw,
    async until(predicate: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reading.catch(() => undefined);
    },
  };
}

/** The phases a device saw, in order, with repeats folded; null is "no turn running". */
function phasesOf(frames: Frame[]): Array<string | null> {
  const phases: Array<string | null> = [];
  for (const frame of frames) {
    const activity = frame.type === "activity"
      ? frame.payload.activity
      : frame.type === "snapshot" ? frame.payload.session.activity : undefined;
    if (activity === undefined) continue;
    const phase = activity === null ? null : (activity.phase as string);
    if (phases.length === 0 || phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases;
}

function runningOn(driven: ReturnType<typeof drivenConversation>, fake: ReturnType<typeof fakeRuntime>) {
  return new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({ ...fake.runtime, conversation: async () => driven.conversation as never }),
    turnIntents: createBotTurnIntents(),
  });
}

// Test 1
test("a phone holding bot:activity follows a real turn's phases and never sees what the tool was given", async () => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-activity-"));
  durableRoots.push(profileDir);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const command = countingTool("run_command", async () => {
    await held;
    return "done";
  });
  const planted = "cat /Users/dana/Documents/plan.md && echo sk-live-0123456789abcdef";
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("run_command", { text: planted })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Tidied."),
  ]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps({ tools: [{ tool: command, replay: "unsafe" }] }),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT_ID]),
  });
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => runtime,
    turnIntents: createBotTurnIntents(),
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.payload.session.activity, null, "an idle Bot is doing nothing");
    assert.deepEqual(stream.frames[0]!.payload.session.queued, []);

    await service.send(DEVICE_ID, BOT_ID, "send-request-activity-0001", { text: "Tidy my notes" });
    await stream.until(() => phasesOf(stream.frames).includes("command"), "Running a command");
    release();
    await stream.until(
      () => phasesOf(stream.frames).at(-1) === null && phasesOf(stream.frames).length > 2,
      "the turn to end",
    );

    const phases = phasesOf(stream.frames);
    for (const phase of phases) {
      assert.ok(phase === null || (BOT_ACTIVITY_PHASES as readonly string[]).includes(phase), String(phase));
    }
    for (const frame of stream.frames) {
      const activity = frame.type === "activity" ? frame.payload.activity : undefined;
      if (activity) assert.deepEqual(Object.keys(activity).filter((key) => !["phase", "app", "startedAt"].includes(key)), []);
    }
    const wire = stream.raw.join("\n");
    for (const secret of ["/Users/dana", "plan.md", "sk-live", "echo "]) {
      assert.equal(wire.includes(secret), false, `${secret} reached the phone`);
    }
    const seqs = stream.frames.map((frame) => frame.seq);
    assert.deepEqual(seqs, seqs.map((_, index) => seqs[0]! + index), "gapless");
  } finally {
    release();
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});

// Test 2
test("a device without bot:activity gets the state it already has at each activity seq, and no activity keys", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = runningOn(driven, fake);
  const activity = await openAudienceStream(service, { activity: true });
  const legacy = await openAudienceStream(service, {});
  try {
    await activity.until(() => activity.frames.length >= 1, "the activity snapshot");
    await legacy.until(() => legacy.frames.length >= 1, "the legacy snapshot");
    assert.equal(activity.frames[0]!.payload.session.activity.phase, "preparing", "running with nothing from the model yet");
    assert.equal("activity" in legacy.frames[0]!.payload.session, false);
    assert.equal("queued" in legacy.frames[0]!.payload.session, false);

    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: {}, tools: [{ callId: "call_1", name: "web_search", status: "running" }] },
    });
    await activity.until(() => activity.frames.length >= 2, "the searching frame");
    await legacy.until(() => legacy.frames.length >= 2, "the no-op frame");

    assert.equal(activity.frames[1]!.type, "activity");
    assert.deepEqual(Object.keys(activity.frames[1]!.payload.activity).sort(), ["phase", "startedAt"]);
    assert.equal(activity.frames[1]!.payload.activity.phase, "searching");
    assert.equal(legacy.frames[1]!.type, "state");
    assert.deepEqual(legacy.frames[1]!.payload, { state: "running", interrupted: false });
    assert.equal(legacy.frames[1]!.seq, activity.frames[1]!.seq, "every device stays on one seq");
    assert.equal(legacy.raw.some((data) => data.includes("web_search") || data.includes("searching")), false);
  } finally {
    await activity.close();
    await legacy.close();
    await service.close();
  }
});

// Test 3 (Review Focus 4)
test("a Stop pressed anywhere reads Stopping on phones until the run ends, and a Stop with nothing running changes nothing", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const intents = createBotTurnIntents();
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({ ...fake.runtime, conversation: async () => driven.conversation as never }),
    turnIntents: intents,
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    // The run is live in `pi.live` (slice B reads Stop only while a run exists).
    await driven.emitView([user(1, "Plan dinners")], { "pi.live": { run: {} } });
    intents.announce(BOT_ID, "stopping"); // the Mac's Stop
    await stream.until(() => phasesOf(stream.frames).includes("stopping"), "Stopping");

    fake.setState({ kind: "idle" });
    await driven.emitView([user(1, "Plan dinners"), assistant(2, "Here is a start.")], {});
    await stream.until(() => phasesOf(stream.frames).at(-1) === null, "the run to end");

    const settled = stream.frames.length;
    intents.announce(BOT_ID, "stopping"); // a double-tap after the reply landed
    await service.session(BOT_ID, { activity: true }); // runs after the intent on the projector's lane
    assert.equal(stream.frames.length, settled, "nothing was running, so nothing changed");

    fake.setState({ kind: "running", submissionId: "sub_2" });
    await driven.emitView(
      [user(1, "Plan dinners"), assistant(2, "Here is a start."), user(3, "And lunches")],
      { "pi.live": { run: {} } },
    );
    await stream.until(() => phasesOf(stream.frames).at(-1) !== null, "the next run");
    assert.equal(phasesOf(stream.frames).at(-1), "preparing", "the next turn starts at Getting ready");
  } finally {
    await stream.close();
    await service.close();
  }
});

// Test 4
test("Steer and Queue reach the runtime as steer and followUp, and the person's waiting messages are listed", async () => {
  const driven = drivenConversation([user(1, "Plan dinners")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const sends: Array<{ text: string; whenBusy?: string }> = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({
      ...fake.runtime,
      conversation: async () => driven.conversation as never,
      async send(_botId: string, input: { text: string; requestId: string; whenBusy?: "steer" | "followUp" }) {
        sends.push({ text: input.text, ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}) });
        return { submissionId: String(17 + sends.length), deduped: false };
      },
    }),
    turnIntents: createBotTurnIntents(),
  });
  const stream = await openAudienceStream(service, { activity: true });
  try {
    await service.send(DEVICE_ID, BOT_ID, "send-request-steer-0001", { text: "Keep it vegetarian.", whenBusy: "steer" });
    await service.send(DEVICE_ID, BOT_ID, "send-request-queue-0001", { text: "Also a shopping list.", whenBusy: "queue" });
    await service.send(DEVICE_ID, BOT_ID, "send-request-plain-0001", { text: "Thanks!" });
    assert.deepEqual(sends, [
      { text: "Keep it vegetarian.", whenBusy: "steer" },
      { text: "Also a shopping list.", whenBusy: "followUp" },
      { text: "Thanks!" },
    ]);

    await stream.until(() => stream.frames.length >= 1, "the snapshot");
    await driven.emitView([user(1, "Plan dinners")], {
      "pi.live": { run: {} },
      "pi.inbox": {
        items: [
          { id: 18, mode: "steer", content: [{ type: "text", text: "Keep it vegetarian." }] },
          { id: 19, mode: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine" } } },
          { id: 20, mode: "followUp", content: [{ type: "text", text: "Weekly reset: plan the week." }] },
          { id: 21, mode: "followUp", content: [{ type: "text", text: "Also a shopping list." }] },
        ],
      },
    });
    await stream.until(() => stream.frames.some((frame) => frame.type === "queued"), "the queued frame");
    assert.deepEqual(stream.frames.find((frame) => frame.type === "queued")!.payload.queued, [
      { submissionId: "18", mode: "steer", text: "Keep it vegetarian." },
      { submissionId: "21", mode: "queue", text: "Also a shopping list." },
    ], "a routine's input is not the person's message");
  } finally {
    await stream.close();
    await service.close();
  }
});

// Test 5
test("a host without bot-activity-v1 refuses whenBusy instead of guessing", async () => {
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);
  assert.equal(service.supportsActivity, false);
  await assert.rejects(
    service.send(DEVICE_ID, BOT_ID, "send-request-steer-0002", { text: "Hi", whenBusy: "steer" }),
    isError("invalid_request", 400),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/aiden-remote-bot-session.test.ts`
Expected: FAIL. `./bot-runtime/bot-turn-intents.js` does not exist, and the service has no `turnIntents` option.

- [ ] **Step 3: The intents emitter**

Create `main/services/bot-runtime/bot-turn-intents.ts`:

```ts
// Stop and Resume, shared by every surface that shows a Bot's activity. The
// desktop live projection and the Remote session projector both turn these
// into "Stopping" and "Picking up where it left off" (spec §5), so a Stop
// pressed on the Mac or on a phone reads the same everywhere.

export type BotTurnIntent = "stopping" | "resuming";

export interface BotTurnIntents {
  /** A person pressed Stop or Resume for `botId`. Each listener decides whether a turn is running. */
  announce(botId: string, intent: BotTurnIntent): void;
  onIntent(listener: (botId: string, intent: BotTurnIntent) => void): () => void;
}

export function createBotTurnIntents(): BotTurnIntents {
  const listeners = new Set<(botId: string, intent: BotTurnIntent) => void>();
  return {
    announce(botId, intent) {
      for (const listener of [...listeners]) {
        try {
          listener(botId, intent);
        } catch {
          // A status line that can't update must never block the Stop itself.
        }
      }
    },
    onIntent(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
```

Create `main/services/bot-runtime/bot-turn-intents-main.ts`:

```ts
// The process-wide Bot turn intents. Desktop Stop/Resume (`main/handlers/bots.ts`)
// and Remote Stop/Resume (`aiden-remote-bot-session.ts`) announce here; the
// desktop live projection (`bot-session-main.ts`) and Remote projectors listen.

import { createBotTurnIntents } from "./bot-turn-intents.js";

export const botTurnIntents = createBotTurnIntents();
```

- [ ] **Step 4: The Remote projector**

In `main/services/aiden-remote-bot-session.ts`:

1. Imports:
   - Change the live-projection import to `import { liveBotActivity, livePartialText, liveQueuedMessages, projectBotTranscript } from "./bot-runtime/live-projection.js";`.
   - Add `import type { BotLiveActivity } from "../../renderer/shared/bot-live.js";` and `import type { BotTurnIntent, BotTurnIntents } from "./bot-runtime/bot-turn-intents.js";`.
   - Add to the protocol import: `AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS`, `AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS`, `AIDEN_REMOTE_BOT_QUEUED_MAX`, `type AidenRemoteBotQueuedMessage` and `type AidenRemoteBotSessionActivity`.
2. Update the file header. After the approval bullet, add:
   ```ts
   // - Contract revision 30 (`bot-activity-v1`): devices holding `bot:activity`
   //   also get `activity` (the §5 phase, cut to `{ phase, app?, startedAt }`) and
   //   `queued` (the person's waiting messages) in the snapshot and as frames.
   //   Other devices get the state they already hold at those seqs.
   ```
3. In `AidenRemoteBotSessionRuntime`, change `send`'s input to `{ text: string; requestId: string; whenBusy?: "steer" | "followUp" }`.
4. In `AidenRemoteBotSessionServiceOptions`, add:
   ```ts
     /**
      * Stop and Resume from any surface (`botTurnIntents`). Present means the host
      * projects activity and queued frames and accepts `whenBusy` (revision 30).
      */
     turnIntents?: Pick<BotTurnIntents, "announce" | "onIntent">;
   ```
5. Below `projectBotSessionState`, add:
   ```ts
   /** The §11 allow-list, picked by name: nothing from the step crosses the wire. */
   export function projectBotSessionActivity(
     live: Pick<BotLiveActivity, "phase" | "app" | "startedAt">,
   ): AidenRemoteBotSessionActivity {
     const app = live.phase === "app" && live.app
       ? wireText(live.app, AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS).trim()
       : "";
     return {
       phase: live.phase,
       ...(app ? { app } : {}),
       startedAt: Math.max(0, Math.floor(live.startedAt)),
     };
   }

   /** The person's waiting messages; routine and hidden inputs never show (slice B). */
   export function projectBotSessionQueued(docs: Readonly<Record<string, unknown>>): AidenRemoteBotQueuedMessage[] {
     return liveQueuedMessages(docs)
       .filter((message) => message.text.trim().length > 0)
       .slice(0, AIDEN_REMOTE_BOT_QUEUED_MAX)
       .map((message) => ({
         submissionId: message.submissionId,
         mode: message.mode === "steer" ? "steer" : "queue",
         text: wireText(message.text, AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS),
       }));
   }
   ```
6. Replace the `Subscriber` interface with:
   ```ts
   /** What one device opted into. It changes what the device is sent, never what it may do. */
   interface Audience {
     /** `bot:cards`: memory and routine proposal entries (revision 27). */
     cards: boolean;
     /** `bot:activity`: the `activity` and `queued` frames and snapshot keys (revision 30). */
     activity: boolean;
   }

   interface Subscriber extends Audience {
     frames: string[];
     handle?: CursorSseHandle;
     overflowed: boolean;
   }

   /** Frames only `bot:activity` devices can parse. */
   const ACTIVITY_FRAME_TYPES: ReadonlySet<string> = new Set(["activity", "queued"]);
   ```
7. Replace the whole `class BotLiveProjector { … }` with:

```ts
class BotLiveProjector {
  readonly epoch = `epoch_${randomUUID().replace(/-/gu, "")}`;
  seq = 0;
  entries: AidenRemoteBotSessionEntry[] = [];
  partial: string | undefined;
  state: AidenRemoteBotSessionStateView = { state: "idle", interrupted: false };
  question: AidenRemoteBotQuestion | null = null;
  approval: AidenRemoteBotApproval | null = null;
  /** What the running turn is doing, in the §11 shape; null while no turn runs. */
  activity: AidenRemoteBotSessionActivity | null = null;
  /** The person's messages waiting for the running turn. */
  queued: AidenRemoteBotQueuedMessage[] = [];
  readonly subscribers = new Set<Subscriber>();
  private view: ConversationView | undefined;
  private stopWatch: (() => Promise<unknown>) | undefined;
  private lane: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the current running turn started, on this Mac's clock. */
  private runStartedAt = 0;
  /** Stop was pressed during this run. */
  private stopping = false;
  /** This run is a Resume and has not moved on yet. */
  private resuming = false;
  /** Resume was pressed: the next run reads "Picking up where it left off". */
  private resumeRequested = false;
  closed = false;

  constructor(
    readonly botId: string,
    private readonly readState: () => Promise<AidenRemoteBotSessionStateView>,
    private readonly resolveEntries: (entries: AidenRemoteBotSessionEntry[]) => Promise<AidenRemoteBotSessionEntry[]>,
    private readonly idleMs: number,
    private readonly onClosed: () => void,
    private readonly readQuestion: () => AidenRemoteBotQuestion | null = () => null,
    private readonly readApproval: () => AidenRemoteBotApproval | null = () => null,
    private readonly now: () => number = Date.now,
    /** The host wires revision 30; without it nothing is derived and no activity frame is ever sent. */
    private readonly activityEnabled = false,
  ) {}

  async attach(conversation: Conversation): Promise<void> {
    const watch = await conversation.watch(ctx);
    this.stopWatch = () => watch.stop();
    this.view = watch.value;
    this.entries = await this.resolveEntries(projectBotSessionEntries(watch.value.entries));
    this.partial = projectBotSessionPartial(watch.value);
    this.state = await this.readState();
    this.question = this.readQuestion();
    this.approval = this.readApproval();
    this.trackRun({ state: "idle", interrupted: false }, this.state);
    if (this.activityEnabled) {
      this.activity = this.deriveActivity(watch.value, this.state, this.question !== null || this.approval !== null);
      this.queued = projectBotSessionQueued(watch.value.docs);
    }
    watch.start(async (view) => {
      await this.advance(view);
    });
    void watch.closed.then(() => this.close(), () => this.close());
    this.armIdle();
  }

  /** The session as one device sees it. */
  snapshot(audience: Audience): AidenRemoteBotSession {
    return parseAidenRemoteBotSession({
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...this.state,
      ...(this.partial !== undefined ? { partial: this.partial } : {}),
      ...windowed(audience.cards ? this.entries : withoutBotCards(this.entries)),
      question: this.question,
      approval: this.approval,
      ...(audience.activity ? { activity: this.activity, queued: this.queued } : {}),
    });
  }

  /** The `snapshot` frame for the current seq (first frame of a stream, or a history rewrite). */
  snapshotFrame(audience: Audience): string {
    const session = this.snapshot(audience);
    return sseFrame(`${session.epoch}:${session.seq}`, "snapshot", {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: session.botId,
      epoch: session.epoch,
      seq: session.seq,
      type: "snapshot",
      payload: { session },
    });
  }

  /** Renders a frame once per kind of audience and queues it for every subscriber. */
  private broadcast(render: (audience: Audience) => string): void {
    const rendered = new Map<string, string>();
    for (const subscriber of this.subscribers) {
      if (subscriber.frames.length >= MAX_PENDING_FRAMES) {
        // A stalled client is dropped; it reconnects and gets a fresh snapshot.
        subscriber.overflowed = true;
      } else {
        const key = `${subscriber.cards}:${subscriber.activity}`;
        let text = rendered.get(key);
        if (text === undefined) {
          text = render(subscriber);
          rendered.set(key, text);
        }
        subscriber.frames.push(text);
      }
      subscriber.handle?.wake();
    }
  }

  private frame(event: Omit<AidenRemoteBotSessionEvent, "protocolVersion" | "botId" | "epoch" | "seq">): void {
    this.seq += 1;
    const data = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...event,
    };
    const id = `${this.epoch}:${this.seq}`;
    const text = sseFrame(id, event.type, data);
    const card =
      event.type === "entry" &&
      (AIDEN_REMOTE_BOT_CARD_ENTRY_TYPES as readonly string[]).includes(
        (event.payload as { entry?: { type?: string } }).entry?.type ?? "",
      );
    const activityOnly = ACTIVITY_FRAME_TYPES.has(event.type);
    // A frame a device can't parse must still reach it as its seq: clients
    // refetch on any gap. That device gets the state it already holds instead,
    // which changes nothing it shows.
    const noOp = sseFrame(id, "state", { ...data, type: "state", payload: this.state });
    this.broadcast((audience) =>
      (card && !audience.cards) || (activityOnly && !audience.activity) ? noOp : text,
    );
  }

  /**
   * Watch callbacks and refreshes both project asynchronously. They run one at
   * a time so a slow, older read can never publish after a newer one: frames
   * stay in causal order and every seq is exactly one more than the last.
   */
  private serial<Result>(action: () => Promise<Result>): Promise<Result> {
    const run = this.lane.then(action, action);
    this.lane = run.then(() => undefined, () => undefined);
    return run;
  }

  advance(view: ConversationView): Promise<void> {
    return this.serial(async () => {
      this.view = view;
      await this.publish(view);
    });
  }

  /**
   * Re-project the latest view and re-read the state: Resume, Dismiss, Stop,
   * a lock change or a connection finished on the Mac change what a client
   * should see without committing to the conversation.
   */
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (this.view) await this.publish(this.view);
    });
  }

  /** Stop or Resume pressed anywhere. A Stop with nothing running changes nothing. */
  noteIntent(intent: BotTurnIntent): Promise<void> {
    return this.serial(async () => {
      if (intent === "stopping") {
        if (this.state.state !== "running") return;
        this.stopping = true;
      } else {
        this.resumeRequested = true;
      }
      if (this.view) await this.publish(this.view);
    });
  }

  /** A turn starting resets Stop and picks up a pending Resume; any other state clears both. */
  private trackRun(previous: AidenRemoteBotSessionStateView, next: AidenRemoteBotSessionStateView): void {
    if (next.state === "running" && previous.state !== "running") {
      this.runStartedAt = this.now();
      this.stopping = false;
      this.resuming = this.resumeRequested;
      this.resumeRequested = false;
    } else if (next.state !== "running") {
      this.stopping = false;
      this.resuming = false;
    }
  }

  /** Slice B's derivation from `pi.live`, cut to the wire. A paused Bot keeps `pi.live.run` but is not working. */
  private deriveActivity(
    view: ConversationView,
    state: AidenRemoteBotSessionStateView,
    waiting: boolean,
  ): AidenRemoteBotSessionActivity | null {
    if (state.state !== "running") return null;
    const live = liveBotActivity({
      entries: view.entries,
      docs: view.docs,
      waiting,
      stopping: this.stopping,
      resuming: this.resuming,
      startedAt: this.runStartedAt,
    }) ?? { phase: "preparing" as const, startedAt: this.runStartedAt };
    if (live.phase !== "resuming") this.resuming = false;
    return projectBotSessionActivity(live);
  }

  private async publish(view: ConversationView): Promise<void> {
    if (this.closed) return;
    const next = await this.resolveEntries(projectBotSessionEntries(view.entries));
    const partial = projectBotSessionPartial(view);
    const state = await this.readState().catch(() => this.state);
    const question = this.readQuestion();
    const approval = this.readApproval();
    if (this.closed) return;
    this.trackRun(this.state, state);
    const activity = this.activityEnabled
      ? this.deriveActivity(view, state, question !== null || approval !== null)
      : null;
    const queued = this.activityEnabled ? projectBotSessionQueued(view.docs) : [];

    const previous = this.entries;
    const previousById = new Map(previous.map((entry) => [entry.id, JSON.stringify(entry)]));
    const nextIds = new Set(next.map((entry) => entry.id));
    // Appends and in-place updates are entry events; anything that removes or
    // reorders shown history (a `[SILENT]` routine turn hiding its input) is a snapshot.
    const kept = previous.filter((entry) => nextIds.has(entry.id)).map((entry) => entry.id);
    const order = next.filter((entry) => previousById.has(entry.id)).map((entry) => entry.id);
    const rewritten = kept.length !== previous.length || kept.some((id, index) => order[index] !== id);

    this.entries = next;
    if (rewritten) {
      this.partial = partial;
      this.state = state;
      this.question = question;
      this.approval = approval;
      this.activity = activity;
      this.queued = queued;
      this.seq += 1;
      this.broadcast((audience) => this.snapshotFrame(audience));
      return;
    }
    for (const entry of next) {
      if (previousById.get(entry.id) === JSON.stringify(entry)) continue;
      this.frame({ type: "entry", payload: { entry } });
    }
    if (partial !== this.partial) {
      this.partial = partial;
      // Always explicit: an empty text clears the partial, so a client never
      // has to guess whether an appended entry replaced it.
      this.frame({ type: "partial", payload: { text: partial ?? "" } });
    }
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      this.state = state;
      this.frame({ type: "state", payload: state });
    }
    if (question?.waitId !== this.question?.waitId) {
      this.question = question;
      this.frame({ type: "question", payload: { question } });
    }
    if (approval?.waitId !== this.approval?.waitId) {
      this.approval = approval;
      this.frame({ type: "approval", payload: { approval } });
    }
    // After the state frame, so a phone never sees a phase for a turn that already ended.
    if (JSON.stringify(activity) !== JSON.stringify(this.activity)) {
      this.activity = activity;
      this.frame({ type: "activity", payload: { activity } });
    }
    if (JSON.stringify(queued) !== JSON.stringify(this.queued)) {
      this.queued = queued;
      this.frame({ type: "queued", payload: { queued } });
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    clearTimeout(this.idleTimer);
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      this.armIdle();
    };
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.closed || this.subscribers.size > 0) return;
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.frame({ type: "closed", payload: {} });
    this.onClosed();
    await this.stopWatch?.().catch(() => undefined);
  }
}
```

- [ ] **Step 5: The service**

Still in `aiden-remote-bot-session.ts`, in `AidenRemoteBotSessionService`:

1. Add the field `private readonly stopIntents: (() => void) | undefined;`. At the end of the constructor, add:
   ```ts
       // A Stop or Resume pressed on the Mac or on any phone reaches every open session stream.
       this.stopIntents = options.turnIntents?.onIntent((botId, intent) => {
         void this.projectors.get(botId)?.then((projector) => projector.noteIntent(intent), () => undefined);
       });
   ```
2. Add the getter next to `supportsMemory`:
   ```ts
     /** Activity and queued frames and `whenBusy` (revision 30, `bot-activity-v1`). */
     get supportsActivity(): boolean {
       return Boolean(this.options.turnIntents);
     }
   ```
3. In `projector()`, pass two more `BotLiveProjector` arguments after `() => this.approvalOf(botId)`: `() => this.options.now?.() ?? Date.now()` and `this.supportsActivity`. A host without `turnIntents` therefore never sends an extra frame, so revision-29 streams are byte-for-byte unchanged.
4. Replace `session()`:
   ```ts
     /** `cards`: the device holds `bot:cards`; `activity`: it holds `bot:activity`. */
     async session(botId: string, options: { cards?: boolean; activity?: boolean } = {}): Promise<AidenRemoteBotSession> {
       const bot = await this.options.bots.bot(botId);
       const audience = { cards: options.cards === true, activity: options.activity === true && this.supportsActivity };
       try {
         const state = await this.stateView(bot.id);
         if (state.state === "unavailable") {
           // Bots are held by another Aiden process: nothing can be opened.
           return parseAidenRemoteBotSession({
             botId: bot.id, epoch: "epoch_unavailable", seq: 0, ...state, entries: [], hasOlder: false, question: null, approval: null,
             ...(audience.activity ? { activity: null, queued: [] } : {}),
           });
         }
         const projector = await this.liveProjector(bot.id);
         // A state change without a commit (a desktop Stop, a lock change) is not
         // seen by the watch; a fetch always reports the current state.
         await projector.refresh();
         return projector.snapshot(audience);
       } catch (error) {
         return mapSessionError(error);
       }
     }
   ```
5. In `openEvents`, change the options parameter to `options: { cards?: boolean; activity?: boolean } = {}`. Replace the two lines `const cards = options.cards === true;` and `const subscriber: Subscriber = …` with:
   ```ts
       const audience = { cards: options.cards === true, activity: options.activity === true && this.supportsActivity };
       const subscriber: Subscriber = { frames: [projector.snapshotFrame(audience)], overflowed: false, ...audience };
   ```
6. In `close()`, add `this.stopIntents?.();` as the first line.
7. In `send()`:
   - Replace the parse line with `const parsed = parseOrInvalid((value) => parseAidenRemoteBotMessageRequest(value, { allowWhenBusy: this.supportsActivity }), input, "The Bot message is invalid.");`.
   - Replace the `runtime.send(…)` call with:
   ```ts
             const sent = await runtime.send(bot.id, {
               text: parsed.text,
               requestId: `remote:${deviceId}:${key}`,
               // Steer joins the running turn; Queue (or nothing) runs after it.
               ...(parsed.whenBusy ? { whenBusy: parsed.whenBusy === "steer" ? "steer" as const : "followUp" as const } : {}),
             });
   ```
8. In `control()`, replace the three action lines inside the idempotent action with:
   ```ts
             if (action === "resume") {
               this.options.turnIntents?.announce(bot.id, "resuming");
               return projectBotSessionState(await runtime.resume(bot.id, requestId));
             }
             if (action === "dismiss") return projectBotSessionState(await runtime.dismiss(bot.id, requestId));
             // Stop ends a running turn; a paused one belongs to Dismiss.
             this.options.turnIntents?.announce(bot.id, "stopping");
             return projectBotSessionState(await runtime.stop(bot.id));
   ```

- [ ] **Step 6: Desktop wiring**

1. `main/services/bot-runtime/bot-session-main.ts`: add `import { botTurnIntents } from "./bot-turn-intents-main.js";`. Below the `botQuestions.onChange(…)` block, add:
   ```ts
   // A Stop or Resume from any surface (the Mac or a phone) reads "Stopping" or
   // "Picking up where it left off" in open desktop chats; Remote projectors
   // listen to the same emitter (`aiden-remote-service-main.ts`).
   botTurnIntents.onIntent((botId, intent) => {
     if (intent === "stopping") botLiveProjection().notifyStopping(botId);
     else botLiveProjection().notifyResuming(botId);
   });
   ```
2. `main/handlers/bots.ts`: add `import { botTurnIntents } from "../services/bot-runtime/bot-turn-intents-main.js";`. In the `bots:resume` and `bots:stop` handlers that slice B Task 3 wrote, replace `botLiveProjection().notifyResuming(botId);` with `botTurnIntents.announce(botId, "resuming");`, and `botLiveProjection().notifyStopping(botId);` with `botTurnIntents.announce(botId, "stopping");`. Drop `botLiveProjection` from that file's imports if nothing else there uses it.
3. `main/services/aiden-remote-service-main.ts`: add `import { botTurnIntents } from "./bot-runtime/bot-turn-intents-main.js";`. In `new AidenRemoteBotSessionService({ … })`, add `turnIntents: botTurnIntents,` after `approvals: botApprovals,`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test main/services/aiden-remote-bot-session.test.ts`
Expected: PASS. That covers the 5 new tests plus the existing ones, including the revision-27 card test, whose legacy stream still gets `state` no-ops.

Run: `npm run test:bot-runtime && npm run type-check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add main/services/bot-runtime/bot-turn-intents.ts main/services/bot-runtime/bot-turn-intents-main.ts main/services/aiden-remote-bot-session.ts main/services/aiden-remote-bot-session.test.ts main/services/bot-runtime/bot-session-main.ts main/handlers/bots.ts main/services/aiden-remote-service-main.ts
git commit -m "Remote: Bot activity and queued frames for bot:activity devices; Steer and Queue; shared Stop intents"
```

---

### Task 3: Bot detail `chatActivity`, `PATCH`, the token and the `bot:activity` opt-in

**Files:**
- Modify: `main/services/aiden-remote-bots.ts`, `main/services/aiden-remote-router.ts`, `main/services/aiden-remote-state.ts`, `main/services/aiden-remote-service-main.ts`
- Test: `main/services/aiden-remote-bots.test.ts`, `main/services/aiden-remote-router.test.ts`, `main/services/aiden-remote-state.test.ts`

**Interfaces:**
- Consumes: `parseAidenRemoteBotIdentityPatchRequest(value, { allowChatActivity })`, `AIDEN_REMOTE_BOT_ACTIVITY_FEATURE`, `AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES` and `AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES` (Task 1). `AidenRemoteBotSessionService.supportsActivity` (Task 2). `resolveBotChatActivity` (B Task 4).
- Produces:
  - `AidenRemoteBotServiceOptions.chatActivity?: boolean` and `AidenRemoteBotService.supportsChatActivity`.
  - The router helpers `botActivityWired(dependencies)` and `botDetailForDevice(detail, device)`.
  - `/server` announces `bot-activity-v1`, and `serverCapabilities` lists `bot:activity`, only while wired.
  - `POST /device/capabilities` accepts `bot:activity` only while wired (otherwise `not_found`).

- [ ] **Step 1: Write the failing tests**

`main/services/aiden-remote-bots.test.ts`: add `chatActivity?: boolean;` to `fixture()`'s options type. It already spreads `...options` into the service. Then add:

```ts
// Test 1
test("a phone saves Chat activity with PATCH only where bot-activity-v1 is wired", async () => {
  const wired = fixture([bot("bot_1")], { chatActivity: true });
  const before = await wired.service.get("bot_1");
  assert.deepEqual(before.chatActivity, { level: "quiet", wording: "follows" }, "a Bot that never chose reads as the default");

  const saved = await wired.service.updateIdentity("bot_1", before.revision, {
    chatActivity: { level: "summary", wording: "thinking" },
  });
  assert.deepEqual(saved.chatActivity, { level: "summary", wording: "thinking" });
  assert.notEqual(saved.revision, before.revision);
  assert.equal(saved.name, before.name, "only the choice changed");
  assert.deepEqual((await wired.service.get("bot_1")).chatActivity, { level: "summary", wording: "thinking" });

  for (const invalid of [
    { level: "verbose", wording: "follows" },
    { level: "quiet" },
    { level: "quiet", wording: "follows", extra: true },
  ]) {
    await assert.rejects(
      wired.service.updateIdentity("bot_1", saved.revision, { chatActivity: invalid }),
      (error: unknown) => (error as { code?: string }).code === "invalid_request",
      JSON.stringify(invalid),
    );
  }
});

// Test 2
test("a Mac without bot-activity-v1 neither shows nor accepts chatActivity", async () => {
  const older = fixture([bot("bot_1", { chatActivity: { level: "detailed", wording: "follows" } })]);
  const detail = await older.service.get("bot_1");
  assert.equal("chatActivity" in detail, false);
  await assert.rejects(
    older.service.updateIdentity("bot_1", detail.revision, { chatActivity: { level: "summary", wording: "follows" } }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});
```

`main/services/aiden-remote-state.test.ts`:

```ts
// Test 3
test("bot:activity is an opt-in any paired device may negotiate and keep", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({ name: "iPhone", type: "iphone", clientVersion: "1.0" });
  const upgraded = await state.registry.upgradeDeviceCapabilities(issued.device.id, ["bot:cards", "bot:activity"]);
  assert.deepEqual(upgraded?.capabilities.slice(-2), ["bot:cards", "bot:activity"]);
  const authenticated = await state.registry.authenticate(issued.credential);
  assert.equal(authenticated?.capabilities.has("bot:activity"), true);
  assert.equal(authenticated?.acceptsProgressCapabilities, false, "an opt-in is not a progress grant");
});
```

`main/services/aiden-remote-router.test.ts`:
1. Add `chatActivity?: boolean;` to `fixture()`'s options type.
2. In its `bots: {` object, add `...(options.chatActivity ? { supportsChatActivity: true } : {}),` and make `get` return:
   ```ts
        return {
          ...botDetail,
          id: botId,
          access: { ...botAccess, botId },
          ...(options.chatActivity ? { chatActivity: { level: "summary" as const, wording: "follows" as const } } : {}),
        };
   ```
3. In the fake `upgradeDeviceCapabilities`, add `capability !== "bot:activity" &&` before `capability !== "bot:cards"`.
4. Add:

```ts
function recordingActivitySessions(seen: string[], supportsActivity: boolean) {
  const base = recordingRevision27Sessions([], { memory: false, proactive: false }) as unknown as Record<string, unknown>;
  return {
    ...base,
    supportsActivity,
    session: async (botId: string, options: { activity?: boolean } = {}) => {
      seen.push(`session:${options.activity === true ? "activity" : "plain"}`);
      return { botId, epoch: "epoch_1", seq: 0, state: "idle", interrupted: false, entries: [], hasOlder: false };
    },
    openEvents: async (
      _deviceId: string,
      _botId: string,
      response: import("node:http").ServerResponse,
      admit: () => void,
      options: { activity?: boolean } = {},
    ) => {
      seen.push(`events:${options.activity === true ? "activity" : "plain"}`);
      admit();
      response.writeHead(204);
      response.end();
    },
  } as unknown as NonNullable<import("./aiden-remote-router.js").AidenRemoteRouterDependencies["botSessions"]>;
}

// Test 4 (Review Focus 1)
test("bot-activity-v1 and bot:activity are offered only while activity frames and chatActivity are both wired", async () => {
  const headers = { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1" };
  const negotiate = { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ accepts: ["bot:activity"] }) };
  for (const [sessionsActivity, chatActivity, wired] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const) {
    const app = await fixture({
      capabilities: ["server:read", "bot:read", "chat:read"],
      acceptsBotCapabilities: true,
      deviceType: "iphone",
      botSessions: recordingActivitySessions([], sessionsActivity),
      chatActivity,
    });
    try {
      const server = await (await fetch(`${app.base}/server`, { headers })).json();
      assert.equal(server.features.includes("bot-activity-v1"), wired, `${sessionsActivity}/${chatActivity}`);
      assert.equal(server.serverCapabilities.includes("bot:activity"), wired);
      assert.equal((await fetch(`${app.base}/device/capabilities`, negotiate)).status, wired ? 200 : 404);
    } finally {
      await app.close();
    }
  }
});

// Test 5 (Review Focus 1)
test("only a device holding bot:activity is served activity frames and a Bot's chatActivity", async () => {
  const headers = { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1" };
  const seen: string[] = [];
  for (const capabilities of [
    ["server:read", "bot:read", "chat:read"],
    ["server:read", "bot:read", "chat:read", "bot:activity"],
  ] as AidenRemoteCapability[][]) {
    const app = await fixture({
      capabilities,
      acceptsBotCapabilities: true,
      deviceType: "iphone",
      botSessions: recordingActivitySessions(seen, true),
      chatActivity: true,
    });
    try {
      await fetch(`${app.base}/bots/bot-1/session`, { headers });
      await fetch(`${app.base}/bots/bot-1/session/events`, { headers });
      const detail = await (await fetch(`${app.base}/bots/bot-1`, { headers })).json();
      seen.push(`detail:${"chatActivity" in detail ? "activity" : "plain"}`);
    } finally {
      await app.close();
    }
  }
  assert.deepEqual(seen, [
    "session:plain", "events:plain", "detail:plain",
    "session:activity", "events:activity", "detail:activity",
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/aiden-remote-bots.test.ts main/services/aiden-remote-state.test.ts main/services/aiden-remote-router.test.ts`
Expected: FAIL.
- `chatActivity` is absent from detail.
- The PATCH is refused as an unsupported field.
- `bot:activity` is not negotiable (the state upgrade returns null).
- The token is never announced.

- [ ] **Step 3: The Bot service**

In `main/services/aiden-remote-bots.ts`:
1. Import `resolveBotChatActivity` from `../../renderer/shared/bots.js`. Add it to the existing import from that module, or add the import.
2. Add to `AidenRemoteBotServiceOptions`:
   ```ts
     /** Contract revision 30 (`bot-activity-v1`): Bot detail carries `chatActivity` and `PATCH` accepts it. */
     chatActivity?: boolean;
   ```
3. Add to the class:
   ```ts
     get supportsChatActivity(): boolean {
       return this.options.chatActivity === true;
     }
   ```
4. In `detail()`, add to the object passed to `parseAidenRemoteBotDetail`, after `visionModelSelection`:
   ```ts
         ...(this.supportsChatActivity ? { chatActivity: resolveBotChatActivity(bot.chatActivity) } : {}),
   ```
5. In `updateIdentity()`:
   - Replace the parser argument with `(value: unknown) => parseAidenRemoteBotIdentityPatchRequest(value, { allowChatActivity: this.supportsChatActivity })`.
   - In the `updateBot({ … })` input, add after `avatar: …,`:
   ```ts
           // Absent keeps the saved choice (slice B ruling 2); only an explicit pick changes it.
           ...(parsed.chatActivity ? { chatActivity: parsed.chatActivity } : {}),
   ```

- [ ] **Step 4: The device state**

In `main/services/aiden-remote-state.ts`:
- Import `AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES` in place of `AIDEN_REMOTE_BOT_CARD_CAPABILITIES`.
- Replace `isBotCardCapability` with:

```ts
/** Revision 27/30 opt-ins (`bot:cards`, `bot:activity`): no authority, any device type. */
function isBotOptInCapability(
  value: unknown,
): value is (typeof AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES)[number] {
  return (
    typeof value === "string" &&
    (AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES as readonly string[]).includes(value)
  );
}
```

and rename its two call sites in `upgradeDeviceCapabilities` (`!isBotCardCapability(capability)` and `isBotCardCapability(capability)`).

- [ ] **Step 5: The router**

In `main/services/aiden-remote-router.ts`:
1. Import `AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES`, `AIDEN_REMOTE_BOT_ACTIVITY_FEATURE` and `type AidenRemoteBotDetail` from the protocol.
2. Dependencies types:
   - In `bots?`'s `Partial<Pick<AidenRemoteBotService, …>>`, add `| "supportsChatActivity"`.
   - In `botSessions`'s revision-27 `Partial<Pick<…>>` list, add `| "supportsActivity"`.
3. Below `advertisedServerCapabilities`, add:
   ```ts
   /** Revision 30: the activity frames and the Chat activity field ship together, or not at all. */
   function botActivityWired(dependencies: AidenRemoteRouterDependencies): boolean {
     return dependencies.botSessions?.supportsActivity === true && dependencies.bots?.supportsChatActivity === true;
   }

   /** Bot detail as one device may read it: `chatActivity` only for `bot:activity` holders. */
   function botDetailForDevice(
     detail: AidenRemoteBotDetail,
     device: AidenRemoteRouterAuthenticatedDevice,
   ): AidenRemoteBotDetail {
     if (device.capabilities.has("bot:activity")) return detail;
     const { chatActivity: _hidden, ...visible } = detail;
     return visible;
   }
   ```
4. In `advertisedServerCapabilities`, after the `AIDEN_REMOTE_BOT_CARD_CAPABILITIES` spread, add:
   ```ts
       ...(device.acceptsBotCapabilities === true && botActivityWired(dependencies)
         ? AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES
         : []),
   ```
5. In `/server`'s `features`, after the `AIDEN_REMOTE_BOT_PROACTIVE_FEATURE` line, add:
   ```ts
               // Bot chat activity on phones (contract revision 30).
               ...(botActivityWired(dependencies) ? [AIDEN_REMOTE_BOT_ACTIVITY_FEATURE] : []),
   ```
6. In `POST /device/capabilities`, the per-capability `if / else if` chain starts with the `bot:cards` branch. Insert a branch between it and `else if (capability === "simulators:control")`, so the chain reads:
   ```ts
             if ((AIDEN_REMOTE_BOT_CARD_CAPABILITIES as readonly string[]).includes(capability)) {
               // (unchanged) An opt-in to two session entry types, not an authority: …
               if (!dependencies.botSessions) {
                 throw new AidenRemoteServiceError("not_found", "Bot sessions are unavailable on this Aiden installation.", 404);
               }
             } else if ((AIDEN_REMOTE_BOT_ACTIVITY_CAPABILITIES as readonly string[]).includes(capability)) {
               // Revision 30: an opt-in to the activity frames and the detail field, offered only while they are wired.
               if (!botActivityWired(dependencies)) {
                 throw new AidenRemoteServiceError("not_found", "Bot chat activity is unavailable on this Aiden installation.", 404);
               }
             } else if (capability === "simulators:control") {
               // (unchanged)
   ```
7. In `GET /bots/{id}/session` and `GET /bots/{id}/session/events`, change `{ cards: device.capabilities.has("bot:cards") }` to `{ cards: device.capabilities.has("bot:cards"), activity: device.capabilities.has("bot:activity") }`.
8. Wrap the three Bot detail responses:
   - `POST /bots`: `botDetailForDevice(await dependencies.bots.create(device.id, key, body), device)`
   - `GET /bots/{id}`: `botDetailForDevice(await dependencies.bots.get(botMatch[1]!, device.id), device)`
   - `PATCH /bots/{id}`: `botDetailForDevice(await dependencies.bots.updateIdentity(botMatch[1]!, revision, body, device.id), device)`

- [ ] **Step 6: Wire the Mac**

In `main/services/aiden-remote-service-main.ts`, in `new AidenRemoteBotService({ … })`, add `chatActivity: true,` before `idempotency,`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test main/services/aiden-remote-bots.test.ts main/services/aiden-remote-state.test.ts main/services/aiden-remote-router.test.ts`
Expected: PASS.

Run: `npm run test:aiden-remote && npm run type-check && npm run test:ci-policy`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add main/services/aiden-remote-bots.ts main/services/aiden-remote-bots.test.ts main/services/aiden-remote-router.ts main/services/aiden-remote-router.test.ts main/services/aiden-remote-state.ts main/services/aiden-remote-state.test.ts main/services/aiden-remote-service-main.ts
git commit -m "Remote: chatActivity on Bot detail and PATCH; bot-activity-v1 and the bot:activity opt-in"
```

---

### Task 4: iOS wire models, the `bot:activity` opt-in, the phase table and elapsed time

**Files:**
- Modify: `ios/AidenOnTheGo/Models/AidenBotSession.swift`, `ios/AidenOnTheGo/Models/AidenBot.swift`
- Modify: `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift`, `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift`, `ios/AidenOnTheGo/Models/AidenInstallation.swift`, `ios/AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift`
- Modify: `ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift`
- Test: `ios/AidenOnTheGoTests/AidenBotSessionTests.swift` (new class `AidenBotActivityContractTests` at the end of the file)

**Interfaces:**
- Consumes: the Task 1 fixture sections `botActivity` and `botActivityPrivacy`.
- Produces:
  - `struct AidenBotSessionActivity { phase: String; app: String?; startedAt: Int }` and `struct AidenBotQueuedMessage { submissionId: String; mode: AidenStreamInputMode; text: String }`.
  - `AidenBotSession.activity: AidenBotSessionActivity?` and `AidenBotSession.queued: [AidenBotQueuedMessage]`.
  - `AidenBotSessionEvent.Kind.activity(AidenBotSessionActivity?)` and `.queued([AidenBotQueuedMessage])`.
  - `AidenBotMessageRequest(text:whenBusy:)`.
  - `enum AidenBotChatActivityLevel { quiet, summary, detailed }`, `enum AidenBotChatActivityWording { follows, thinking }` and `struct AidenBotChatActivity { level; wording; static let standard }`.
  - `AidenBotDetail.chatActivity` and `AidenBotIdentityPatch(chatActivity:)`.
  - `AidenRemoteCapability.botActivity`, `AidenServer.botActivityFeature`, `AidenServer.offersBotActivity` and `AidenServer.supportsBotActivity`.
  - `AidenBotHostFeature.activity`.
  - `enum AidenBotActivityPhase { struct Display { phase; word; mark }; static let table; static func display(phase:wording:app:) -> Display }`.
  - `enum AidenBotElapsed { static func label(startedAt: Int, nowMs: Int) -> String? }`.

- [ ] **Step 1: Write the failing tests**

Append to `ios/AidenOnTheGoTests/AidenBotSessionTests.swift`:

```swift
/// Contract revision 30: the activity wire, read from the fixture every client shares.
final class AidenBotActivityContractTests: XCTestCase {
    private func shared() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func section(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try shared()[name] as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    private func encoded<T: Encodable>(_ value: T) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary)
    }

    // Test 1 (Review Focus 3)
    func testActivitySessionFramesAndDetailDecodeAsTheMacSendsThem() throws {
        let activity = try section("botActivity")
        let started = 1_760_450_000_000
        let session = try decode(AidenBotSession.self, try XCTUnwrap(activity["session"]))
        XCTAssertEqual(session.activity, AidenBotSessionActivity(phase: "app", app: "Notion", startedAt: started))
        XCTAssertEqual(session.queued.map(\.submissionId), ["18", "19"])
        XCTAssertEqual(session.queued.map(\.mode), [.queue, .steer])

        let events = try XCTUnwrap(activity["events"] as? [Any]).map { try decode(AidenBotSessionEvent.self, $0) }
        XCTAssertEqual(events.map(\.kind), [
            .activity(AidenBotSessionActivity(phase: "searching", startedAt: started)),
            .queued([AidenBotQueuedMessage(submissionId: "18", mode: .queue, text: "Also add a shopping list.")]),
            .activity(AidenBotSessionActivity(phase: "teleporting", startedAt: started)),
            .activity(nil),
        ])
        // A newer Mac's phase decodes and reads as Working.
        XCTAssertEqual(
            AidenBotActivityPhase.display(phase: "teleporting", wording: .follows, app: nil),
            AidenBotActivityPhase.display(phase: "working", wording: .follows, app: nil)
        )

        let detail = try decode(AidenBotDetail.self, try XCTUnwrap(activity["detail"]))
        XCTAssertEqual(detail.chatActivity, AidenBotChatActivity(level: .summary, wording: .thinking))
        let older = try decode(AidenBotDetail.self, try XCTUnwrap(try shared()["botDetail"]))
        XCTAssertNil(older.chatActivity, "a revision-29 detail has no choice to show")
    }

    // Test 2
    func testEveryPrivacySampleIsRefused() throws {
        let privacy = try section("botActivityPrivacy")
        for sample in try XCTUnwrap(privacy["rejectedActivities"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, sample), "\(sample)")
        }
        for sample in try XCTUnwrap(privacy["rejectedQueued"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotQueuedMessage.self, sample), "\(sample)")
        }
        for sample in try XCTUnwrap(privacy["rejectedChatActivity"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotChatActivity.self, sample), "\(sample)")
        }
    }

    // Test 3
    func testRequestsEncodeExactlyTheFixtureBodies() throws {
        let activity = try section("botActivity")
        let send = try XCTUnwrap((activity["send"] as? [String: Any])?["request"] as? NSDictionary)
        XCTAssertEqual(try encoded(try AidenBotMessageRequest(text: "Keep it vegetarian.", whenBusy: .steer)), send)
        XCTAssertEqual(try encoded(try AidenBotMessageRequest(text: "Hi")), ["text": "Hi"] as NSDictionary, "no whenBusy unless one was chosen")
        let patch = try XCTUnwrap((activity["identityPatch"] as? [String: Any])?["request"] as? NSDictionary)
        XCTAssertEqual(try encoded(try AidenBotIdentityPatch(chatActivity: AidenBotChatActivity(level: .detailed, wording: .follows))), patch)
    }

    // Test 4
    func testThePhaseTableIsTheOneTheMacDraws() throws {
        let activity = try section("botActivity")
        let phases = try XCTUnwrap(activity["phases"] as? [[String: String]])
        let keeps = Set(try XCTUnwrap(activity["thinkingKeeps"] as? [String]))
        XCTAssertEqual(Set(AidenBotActivityPhase.table.keys), Set(phases.compactMap { $0["id"] }))
        for row in phases {
            let id = try XCTUnwrap(row["id"])
            let shown = AidenBotActivityPhase.display(phase: id, wording: .follows, app: nil)
            XCTAssertEqual(shown.phase, id)
            XCTAssertEqual(shown.word, row["word"], id)
            XCTAssertEqual(shown.mark.rawValue, row["mark"], id)
            XCTAssertEqual(
                AidenBotActivityPhase.display(phase: id, wording: .thinking, app: nil).phase,
                keeps.contains(id) ? id : "thinking",
                id
            )
        }
        let app = try XCTUnwrap(activity["app"] as? [String: String])
        XCTAssertEqual(AidenBotActivityPhase.display(phase: "app", wording: .follows, app: app["app"]).word, app["word"])
    }

    // Test 5
    func testElapsedTimeMatchesTheMacIncludingAPhoneWhoseClockIsBehind() throws {
        let rows = try XCTUnwrap(try section("botActivity")["elapsed"] as? [[String: Any]])
        for row in rows {
            let startedAt = try XCTUnwrap(row["startedAt"] as? NSNumber).intValue
            let now = try XCTUnwrap(row["now"] as? NSNumber).intValue
            XCTAssertEqual(AidenBotElapsed.label(startedAt: startedAt, nowMs: now), row["label"] as? String, "\(row)")
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -derivedDataPath /private/tmp/claude-501/aiden-ios-dd -parallel-testing-enabled NO -only-testing:AidenOnTheGoTests/AidenBotActivityContractTests`
Expected: build FAILS. `AidenBotSessionActivity`, `AidenBotChatActivity` and `AidenBotActivityPhase` are undefined.

- [ ] **Step 3: Session wire types**

In `ios/AidenOnTheGo/Models/AidenBotSession.swift`:

1. Directly above `/// `GET /bots/{botId}/session`: the newest entries …`, add:

```swift
// MARK: Contract revision 30 (`bot-activity-v1`, `bot:activity`)

/// What a Bot in a running turn is doing (spec §5). Exactly `phase`, `app`
/// and `startedAt` cross the wire; any other key is refused (§11).
struct AidenBotSessionActivity: Codable, Equatable, Sendable {
    static let maxAppLength = 40

    let phase: String
    /// The connection's label for the `app` phase.
    let app: String?
    /// When the turn started: the Mac's clock, milliseconds since 1970.
    let startedAt: Int

    init(phase: String, app: String? = nil, startedAt: Int) {
        self.phase = phase
        self.app = app
        self.startedAt = startedAt
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["phase", "app", "startedAt"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        phase = try values.decode(String.self, forKey: .phase)
        guard Self.isPhaseID(phase) else { throw AidenBotContractError.invalidField("activity.phase") }
        app = try AidenBotWire.optionalString(values, forKey: .app, maxLength: Self.maxAppLength)
        startedAt = try values.decode(Int.self, forKey: .startedAt)
        guard (0...AidenRemoteProtocol.maxSafeInteger).contains(startedAt) else {
            throw AidenBotContractError.invalidField("activity.startedAt")
        }
    }

    /// `^[a-z][a-z_]{0,31}$`: a newer Mac's phase still decodes, and reads as Working.
    static func isPhaseID(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard (1...32).contains(scalars.count), let first = scalars.first, (97...122).contains(first.value) else {
            return false
        }
        return scalars.allSatisfy { (97...122).contains($0.value) || $0 == "_" }
    }

    private enum CodingKeys: String, CodingKey { case phase, app, startedAt }
}

/// A message waiting for the running turn: `steer` joins it, `queue` runs after it.
struct AidenBotQueuedMessage: Codable, Equatable, Sendable {
    static let maxCount = 20

    let submissionId: String
    let mode: AidenStreamInputMode
    let text: String

    init(submissionId: String, mode: AidenStreamInputMode, text: String) {
        self.submissionId = submissionId
        self.mode = mode
        self.text = text
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["submissionId", "mode", "text"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        submissionId = try AidenBotWire.requiredString(
            values,
            forKey: .submissionId,
            maxLength: AidenBotSessionWire.maxSubmissionIDLength
        )
        guard submissionId.unicodeScalars.allSatisfy({ scalar in
            switch scalar.value {
            case 48...57, 65...90, 97...122, 46, 95, 58, 45: true
            default: false
            }
        }) else { throw AidenBotContractError.invalidField("queued.submissionId") }
        mode = try values.decode(AidenStreamInputMode.self, forKey: .mode)
        text = try AidenBotWire.requiredString(values, forKey: .text, maxLength: AidenBotSessionWire.maxMessageLength)
    }

    /// At most 20, each id once.
    static func validate(_ list: [Self]) throws {
        guard list.count <= maxCount, Set(list.map(\.submissionId)).count == list.count else {
            throw AidenBotContractError.invalidField("queued")
        }
    }

    private enum CodingKeys: String, CodingKey { case submissionId, mode, text }
}
```

2. In `struct AidenBotSession`:
   - Add the stored properties after `approval`:
     ```swift
         /// Revision 30 (`bot:activity`): what the running turn is doing, or nil.
         let activity: AidenBotSessionActivity?
         /// Revision 30 (`bot:activity`): the person's messages waiting for the turn.
         let queued: [AidenBotQueuedMessage]
     ```
   - Add `activity: AidenBotSessionActivity? = nil, queued: [AidenBotQueuedMessage] = []` as the last memberwise `init` parameters, and assign them.
   - In `init(from:)`, add `"activity", "queued"` to `requireOnlyKeys`'s `allowed` list. After `approval = …`, add:
     ```swift
             activity = try values.decodeIfPresent(AidenBotSessionActivity.self, forKey: .activity)
             if values.contains(.queued) {
                 let list = try values.decode([AidenBotQueuedMessage].self, forKey: .queued)
                 try AidenBotQueuedMessage.validate(list)
                 queued = list
             } else {
                 queued = []
             }
     ```
   - In `encode(to:)`, add after `approval`:
     ```swift
             try values.encodeIfPresent(activity, forKey: .activity)
             if !queued.isEmpty { try values.encode(queued, forKey: .queued) }
     ```
   - Change `CodingKeys` to `case botId, epoch, seq, partial, entries, hasOlder, question, approval, activity, queued`.
3. In `struct AidenBotSessionEvent`:
   - Add to `Kind` before `closed`:
     ```swift
             /// Revision 30: what the running turn is doing now, or nil when none runs.
             case activity(AidenBotSessionActivity?)
             /// Revision 30: the person's messages still waiting for the turn.
             case queued([AidenBotQueuedMessage])
     ```
   - In `wireType`, add `case .activity: "activity"` and `case .queued: "queued"`.
   - In `init(from:)`'s switch, before `case "closed":`, add:
     ```swift
             case "activity":
                 try AidenBotWire.requireOnlyKeys(payload, allowed: ["activity"])
                 guard fields.contains(.activity) else { throw AidenBotContractError.invalidField("activity") }
                 kind = .activity(try fields.decode(AidenBotSessionActivity?.self, forKey: .activity))
             case "queued":
                 try AidenBotWire.requireOnlyKeys(payload, allowed: ["queued"])
                 let list = try fields.decode([AidenBotQueuedMessage].self, forKey: .queued)
                 try AidenBotQueuedMessage.validate(list)
                 kind = .queued(list)
     ```
   - In `encode(to:)`'s switch, add `case let .activity(activity): try fields.encode(activity, forKey: .activity)` and `case let .queued(list): try fields.encode(list, forKey: .queued)`.
   - Change `PayloadKeys` to `case session, text, entry, question, approval, activity, queued`.
   - If the compiler reports another exhaustive `switch` over `AidenBotSessionEvent.Kind` (apart from `AidenBotSessionModel.apply`, which Task 5 updates), add `case .activity, .queued: break` there.
4. Replace `struct AidenBotMessageRequest` with:

```swift
/// `POST /bots/{botId}/messages` body.
struct AidenBotMessageRequest: Codable, Equatable, Sendable {
    let text: String
    /// Revision 30 (`bot-activity-v1`): Steer joins the running turn; Queue runs after it.
    let whenBusy: AidenStreamInputMode?

    init(text: String, whenBusy: AidenStreamInputMode? = nil) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.unicodeScalars.count <= AidenBotSessionWire.maxMessageLength else {
            throw AidenBotContractError.invalidField("text")
        }
        self.text = text
        self.whenBusy = whenBusy
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["text", "whenBusy"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            text: try values.decode(String.self, forKey: .text),
            whenBusy: try values.decodeIfPresent(AidenStreamInputMode.self, forKey: .whenBusy)
        )
    }

    private enum CodingKeys: String, CodingKey { case text, whenBusy }
}
```

- [ ] **Step 4: Chat activity on Bot detail and the identity patch**

In `ios/AidenOnTheGo/Models/AidenBot.swift`:

1. Below `struct AidenBotModelSelection`, add:

```swift
/// A Bot's Chat activity choice (spec §7, contract revision 30).
enum AidenBotChatActivityLevel: String, Codable, CaseIterable, Sendable {
    case quiet, summary, detailed
}

enum AidenBotChatActivityWording: String, Codable, CaseIterable, Sendable {
    case follows, thinking
}

struct AidenBotChatActivity: Codable, Equatable, Sendable {
    var level: AidenBotChatActivityLevel
    var wording: AidenBotChatActivityWording

    /// What a Bot that never chose shows: Quiet, Follows the work.
    static let standard = AidenBotChatActivity(level: .quiet, wording: .follows)

    init(level: AidenBotChatActivityLevel, wording: AidenBotChatActivityWording) {
        self.level = level
        self.wording = wording
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["level", "wording"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        level = try values.decode(AidenBotChatActivityLevel.self, forKey: .level)
        wording = try values.decode(AidenBotChatActivityWording.self, forKey: .wording)
    }

    private enum CodingKeys: String, CodingKey { case level, wording }
}
```

2. In `struct AidenBotDetail`:
   - Add the property `/// Revision 30 (`bot:activity`): the Bot's Chat activity choice. let chatActivity: AidenBotChatActivity?`.
   - In `init(from:)`, after `visionModelSelection = …`, add:
     ```swift
             chatActivity = try AidenBotWire.optional(
                 AidenBotChatActivity.self,
                 from: values,
                 forKey: .chatActivity
             )
     ```
3. In `struct AidenBotIdentityPatch`:
   - Add the property `let chatActivity: AidenBotChatActivity?`.
   - Add the memberwise parameter `chatActivity: AidenBotChatActivity? = nil` after `avatar`, assigned as `self.chatActivity = chatActivity`.
   - Extend both "empty identity patch" guards with `|| chatActivity != nil`.
   - In `init(from:)`, add `chatActivity = try values.decodeIfPresent(AidenBotChatActivity.self, forKey: .chatActivity)` before the final guard.
   - Change `CodingKeys` to `case name, purpose, instructions, avatar, chatActivity`.

- [ ] **Step 5: The opt-in and the host flags**

1. `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift`, in `AidenRemoteCapability`:
   - In the `phoneNegotiable` doc comment, add: "Contract revision 30 adds `bot:activity`, which only opts the device into the activity and queued session frames and Bot detail `chatActivity`."
   - Add `Self(rawValue: "bot:activity")` to the list after `Self(rawValue: "bot:cards")`.
   - Below `static let botCards`, add:
     ```swift
         /// Revision 30: the device receives activity and queued frames and Bot
         /// detail `chatActivity`. It grants no authority.
         static let botActivity = Self(rawValue: "bot:activity")
     ```
2. `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift`:
   - In `AidenServer`, below `static let mobileSimulatorsFeature`, add `static let botActivityFeature = "bot-activity-v1"`.
   - Below `var supportsBotCards`, add:
     ```swift
         /// The Mac offers `bot:activity` (revision 30), so this device may ask for it.
         var offersBotActivity: Bool {
             serverCapabilities?.contains(.botActivity) == true
         }

         /// The Mac announces `bot-activity-v1` and this device holds `bot:activity`:
         /// show the status line, Steer and Queue, Queued bubbles and Chat activity.
         var supportsBotActivity: Bool {
             features.contains(Self.botActivityFeature) && capabilities.contains(.botActivity)
         }
     ```
   - In `updateDeviceCapabilities`'s `allowed` set, add `.botActivity` after `.botCards`.
3. `ios/AidenOnTheGo/Models/AidenInstallation.swift`: in `updateNegotiatedDeviceCapabilities`'s `progress` set, add `.botActivity` after `.botCards`.
4. `ios/AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift`: in `negotiateProgressCapabilitiesIfNeeded`, after `if server.supportsBotCards { requested.append(.botCards) }`, add `if server.offersBotActivity { requested.append(.botActivity) }`.

- [ ] **Step 6: The phase table and elapsed time**

In `ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift`:

1. Add to `AidenBotHostFeature`:
   ```swift
       /// Contract revision 30: the status line, Steer and Queue, Queued bubbles and Chat activity.
       static let activity = "bot-activity-v1"
   ```
2. Add to `AidenBotSessionCopy`: `static let queued = "Queued"`.
3. Below `enum AidenBotSessionCopy`, add:

```swift
/// The status line's words and marks (spec §5). Kept in step with
/// `renderer/shared/bot-activity.ts` by the shared fixture's `botActivity.phases`.
enum AidenBotActivityPhase {
    struct Display: Equatable {
        let phase: String
        let word: String
        let mark: AidenActivityMarkKind
    }

    static let table: [String: (word: String, mark: AidenActivityMarkKind)] = [
        "preparing": ("Getting ready", .bounce),
        "thinking": ("Thinking", .triStep),
        "reading": ("Reading", .scanGrid),
        "photo": ("Looking at your photo", .scanGrid),
        "searching": ("Searching the web", .scanGrid),
        "command": ("Running a command", .quadShuffle),
        "editing": ("Editing files", .quadShuffle),
        "app": ("Using an app", .quadShuffle),
        "helper": ("Asking a helper", .quadShuffle),
        "computer": ("Using your Mac", .quadShuffle),
        "remembering": ("Remembering", .compose),
        "routine": ("Setting up a routine", .triStep),
        "working": ("Working", .quadShuffle),
        "writing": ("Writing", .compose),
        "waiting": ("Waiting for you", .glance),
        "tidying": ("Tidying up its notes", .bounce),
        "stopping": ("Stopping", .bounce),
        "resuming": ("Picking up where it left off", .bounce),
        "reconnecting": ("Reconnecting to your Mac", .bounce),
    ]

    /// These change what the person should do, so Always "Thinking" keeps them.
    static let keepsItsWord: Set<String> = ["waiting", "stopping", "reconnecting"]

    /// What the line shows for any phase id: an id this build doesn't know reads as Working.
    static func display(phase: String, wording: AidenBotChatActivityWording, app: String?) -> Display {
        let known = table[phase] == nil ? "working" : phase
        let shown = wording == .thinking && !keepsItsWord.contains(known) ? "thinking" : known
        let entry = table[shown] ?? ("Working", .quadShuffle)
        if shown == "app", let app, !app.isEmpty {
            return Display(phase: shown, word: "Using \(app)", mark: entry.mark)
        }
        return Display(phase: shown, word: entry.word, mark: entry.mark)
    }
}

/// Elapsed time on the status line (§5.2): from the Mac's `startedAt`, after 20 seconds.
enum AidenBotElapsed {
    static let showAfterMs = 20_000

    /// Nil before 20 seconds, and while this phone's clock reads behind the Mac's.
    static func label(startedAt: Int, nowMs: Int) -> String? {
        let elapsed = nowMs - startedAt
        guard elapsed >= showAfterMs else { return nil }
        return duration(ms: elapsed)
    }

    /// "18s", "1m 12s", "2m", "1h 2m", the Mac's wording.
    static func duration(ms: Int) -> String {
        let seconds = max(1, ms / 1_000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let rest = seconds % 60
        if minutes < 60 { return rest > 0 ? "\(minutes)m \(rest)s" : "\(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder > 0 ? "\(hours)h \(remainder)m" : "\(hours)h"
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run the Step 2 command again.
Expected: PASS (5 tests).

Run the existing Bot suites to check nothing else moved:
`xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -derivedDataPath /private/tmp/claude-501/aiden-ios-dd -parallel-testing-enabled NO -only-testing:AidenOnTheGoTests/AidenBotSessionTests -only-testing:AidenOnTheGoTests/AidenBotContractTests -only-testing:AidenOnTheGoTests/AidenRemotePhase0Tests`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ios/AidenOnTheGo/Models/AidenBotSession.swift ios/AidenOnTheGo/Models/AidenBot.swift ios/AidenOnTheGo/Networking/AidenRemoteContract.swift ios/AidenOnTheGo/Networking/AidenRemoteClient.swift ios/AidenOnTheGo/Models/AidenInstallation.swift ios/AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift ios/AidenOnTheGoTests/AidenBotSessionTests.swift
git commit -m "iOS Bots: revision 30 activity wire, bot:activity opt-in, shared status words"
```

---

### Task 5: iOS session model: status line, Reconnecting, Queued and Steer/Queue

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift`
- Test: `ios/AidenOnTheGoTests/AidenBotSessionTests.swift` (extend `FakeBotSessionTransport`; new class `AidenBotSessionActivityTests`)

**Interfaces:**
- Consumes: Task 4's types, `AidenBotActivityPhase` and `AidenBotElapsed`.
- Produces on `AidenBotSessionModel`:
  - `var activitySupported: Bool` and `var wording: AidenBotChatActivityWording`.
  - `private(set) var activity`, `queued` and `isStreamDown`.
  - `var offersBusyModes: Bool`.
  - `func statusLine(nowMs: Int) -> AidenBotStatusLine?`.
  - `func send(_:whenBusy:) async -> Bool`.
- Also produces `struct AidenBotStatusLine { display; elapsed; accessibilityLabel }` and `struct AidenBotStatusAnnouncer { mutating func offer(_:at:) -> (announce: String?, retryAfter: TimeInterval?) }`.

- [ ] **Step 1: Write the failing tests**

In `AidenBotSessionTests.swift`, change `FakeBotSessionTransport`:
- Replace `private var _streams: [[AidenBotSessionEvent]] = []` with `private var _streams: [(events: [AidenBotSessionEvent], staysOpen: Bool)] = []`.
- Replace `queueStream` with `func queueStream(_ events: [AidenBotSessionEvent], staysOpen: Bool = false) { locked { _streams.append((events, staysOpen)) } }`.
- Add `private var _sendModes: [AidenStreamInputMode?] = []` and `var sendModes: [AidenStreamInputMode?] { locked { _sendModes } }`.
- In `sendBotMessage`, add `_sendModes.append(request.whenBusy)` beside `_sendTexts.append(request.text)`.
- Replace `botSessionEvents` with:

```swift
    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        let next = locked { () -> (events: [AidenBotSessionEvent], staysOpen: Bool) in
            _streamRequests += 1
            return _streams.isEmpty ? ([], false) : _streams.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            for event in next.events { continuation.yield(event) }
            // A stream that stays open ends only when its listener is cancelled.
            if next.staysOpen { return }
            if next.events.isEmpty {
                continuation.finish(throwing: URLError(.networkConnectionLost))
            } else {
                continuation.finish()
            }
        }
    }
```

Append:

```swift
@MainActor
final class AidenBotSessionActivityTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let started = 1_760_450_000_000

    private func running(
        _ activity: AidenBotSessionActivity?,
        epoch: String = "epoch_a",
        seq: Int = 4,
        partial: String? = nil
    ) throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: epoch,
            seq: seq,
            stateView: try AidenBotSessionStateView(state: .running),
            partial: partial,
            entries: [],
            hasOlder: false,
            activity: activity
        )
    }

    private func event(epoch: String = "epoch_a", seq: Int, _ kind: AidenBotSessionEvent.Kind) -> AidenBotSessionEvent {
        AidenBotSessionEvent(botId: botID, epoch: epoch, seq: seq, kind: kind)
    }

    private func loaded(
        _ transport: FakeBotSessionTransport,
        _ session: AidenBotSession,
        supported: Bool = true
    ) async -> AidenBotSessionModel {
        transport.queueSession(.success(session))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        model.activitySupported = supported
        await model.load()
        return model
    }

    private func waitUntil(_ condition: () -> Bool, what: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    // Test 1
    func testTheLineShowsUntilTheReplyStreamsAndFollowsTheChosenWording() async throws {
        let model = await loaded(FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "reading", startedAt: started)))
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Reading")
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.mark, .scanGrid)
        model.wording = .thinking
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Thinking")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "waiting", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Waiting for you", "a card that needs the person keeps its word")
        _ = await model.apply(event(seq: 6, .partial("Here is")))
        XCTAssertNil(model.statusLine(nowMs: started + 1_000), "the reply's words are the signal")
        _ = await model.apply(event(seq: 7, .state(try AidenBotSessionStateView(state: .idle))))
        _ = await model.apply(event(seq: 8, .partial("")))
        XCTAssertNil(model.statusLine(nowMs: started + 1_000), "nothing shows once the turn ended")
    }

    // Test 2 (Review Focus 3)
    func testAnUnknownPhaseReadsAsWorkingAndElapsedTimeAppearsAfterTwentySeconds() async throws {
        let model = await loaded(FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "browsing", startedAt: started)))
        let early = try XCTUnwrap(model.statusLine(nowMs: started + 19_000))
        XCTAssertEqual(early.display.word, "Working")
        XCTAssertEqual(early.display.mark, .quadShuffle)
        XCTAssertNil(early.elapsed)
        let later = try XCTUnwrap(model.statusLine(nowMs: started + 72_000))
        XCTAssertEqual(later.elapsed, "1m 12s")
        XCTAssertEqual(later.accessibilityLabel, "Working, 1m 12s")
    }

    // Test 3
    func testBeforeTheFirstActivityFrameItSaysGettingReadyAndOlderMacsShowNothing() async throws {
        let fresh = await loaded(FakeBotSessionTransport(), try running(nil))
        XCTAssertEqual(fresh.statusLine(nowMs: started)?.display.word, "Getting ready")
        let older = await loaded(
            FakeBotSessionTransport(),
            try running(AidenBotSessionActivity(phase: "reading", startedAt: started)),
            supported: false
        )
        XCTAssertNil(older.statusLine(nowMs: started))
        XCTAssertFalse(older.offersBusyModes)
    }

    // Test 4 (Review Focus 2)
    func testADroppedStreamReadsReconnectingUntilTheNextConnection() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueStream([]) // the first connection drops at once
        transport.queueStream(
            [event(epoch: "epoch_b", seq: 1, .snapshot(try running(AidenBotSessionActivity(phase: "searching", startedAt: started), epoch: "epoch_b", seq: 1)))],
            staysOpen: true
        )
        let model = await loaded(transport, try running(AidenBotSessionActivity(phase: "reading", startedAt: started)))
        let listener = Task { await model.listen() }

        try await waitUntil({ model.isStreamDown }, what: "the drop")
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Reconnecting to your Mac")
        try await waitUntil({ !model.isStreamDown && model.epoch == "epoch_b" }, what: "the next connection")
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Searching the web")

        listener.cancel()
        await listener.value
    }

    // Test 5
    func testSteerAndQueueGoOutOnlyWhileTheBotWorksOnAMacThatOffersThem() async throws {
        let transport = FakeBotSessionTransport()
        let supported = await loaded(transport, try running(nil))
        XCTAssertTrue(supported.offersBusyModes)
        XCTAssertTrue(await supported.send("Keep it vegetarian.", whenBusy: .steer))
        let older = await loaded(transport, try running(nil), supported: false)
        XCTAssertTrue(await older.send("Also a list.", whenBusy: .queue))
        XCTAssertEqual(transport.sendModes, [.steer, nil], "an older Mac would refuse whenBusy")
    }

    // Test 6
    func testQueuedMessagesFollowTheirFramesAndAFreshSnapshotReplacesThem() async throws {
        let waiting = [AidenBotQueuedMessage(submissionId: "18", mode: .queue, text: "Also add a shopping list.")]
        let model = await loaded(FakeBotSessionTransport(), try running(nil))
        _ = await model.apply(event(seq: 5, .queued(waiting)))
        XCTAssertEqual(model.queued, waiting)
        _ = await model.apply(event(seq: 6, .snapshot(try running(nil, seq: 6))))
        XCTAssertEqual(model.queued, [])
    }

    // Test 7
    func testScreenReadersHearAStatusChangeAtMostEveryTwoSeconds() {
        var announcer = AidenBotStatusAnnouncer()
        XCTAssertEqual(announcer.offer("Reading", at: 0).announce, "Reading")
        XCTAssertNil(announcer.offer("Reading", at: 0.5).announce, "the same word is not repeated")
        let early = announcer.offer("Searching the web", at: 1)
        XCTAssertNil(early.announce)
        XCTAssertEqual(early.retryAfter ?? 0, 1, accuracy: 0.001)
        XCTAssertEqual(announcer.offer("Searching the web", at: 2).announce, "Searching the web")
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotSessionActivityTests` (the Task 4 command with this target).
Expected: build FAILS. `activitySupported`, `statusLine(nowMs:)` and `AidenBotStatusAnnouncer` are undefined.

- [ ] **Step 3: Implement**

In `AidenBotSessionModel.swift`:

1. Below `enum AidenBotElapsed`, add:

```swift
/// What the Bot chat's status line shows (spec §12).
struct AidenBotStatusLine: Equatable {
    let display: AidenBotActivityPhase.Display
    /// "1m 12s" after 20 seconds, else nil.
    let elapsed: String?

    var accessibilityLabel: String {
        elapsed.map { "\(display.word), \($0)" } ?? display.word
    }
}

/// Screen readers hear a status change at most once every 2 seconds (§14).
struct AidenBotStatusAnnouncer {
    static let gap: TimeInterval = 2
    private var current: (text: String, at: TimeInterval)?

    /// The text to announce now, or nil. `retryAfter` says when to offer the newest text again.
    mutating func offer(_ text: String, at now: TimeInterval) -> (announce: String?, retryAfter: TimeInterval?) {
        if let current, current.text == text { return (nil, nil) }
        if let current, now - current.at < Self.gap { return (nil, Self.gap - (now - current.at)) }
        current = (text, now)
        return (text, nil)
    }
}
```

2. In `AidenBotSessionModel`, add after `respondingProposals`:

```swift
    /// Revision 30: the Mac announces `bot-activity-v1` and this phone holds `bot:activity`.
    var activitySupported = false
    /// The Bot's Chat activity wording, from its detail.
    var wording: AidenBotChatActivityWording = .follows
    /// What the running turn is doing (revision 30), or nil.
    private(set) var activity: AidenBotSessionActivity?
    /// The person's messages waiting for the running turn (revision 30).
    private(set) var queued: [AidenBotQueuedMessage] = []
    /// The session stream dropped and is reconnecting.
    private(set) var isStreamDown = false
```

   Change `retainedMessage` to `@ObservationIgnored private var retainedMessage: (text: String, whenBusy: AidenStreamInputMode?, key: UUID)?`.

3. In `listen()`:
   - Inside the `for try await` loop, add `isStreamDown = false` after `failures = 0`.
   - After `guard !Task.isCancelled else { return }`, add:
   ```swift
               // Closed or dropped: while a turn runs the line says "Reconnecting to your Mac".
               isStreamDown = true
   ```
4. In `apply(_ event:)`'s switch, add before `case .closed:`:
   ```swift
           case let .activity(next):
               activity = next
           case let .queued(next):
               queued = next
   ```
5. In `apply(snapshot:authoritative:)`, add `activity = session.activity` and `queued = session.queued` after `approval = session.approval`.
6. Add below `canSend`:

```swift
    /// Steer and Queue while the Bot works need the Mac's `bot-activity-v1`.
    var offersBusyModes: Bool { activitySupported && isRunning }

    /// The status line now (spec §12), or nil when it is hidden.
    func statusLine(nowMs: Int) -> AidenBotStatusLine? {
        guard activitySupported, isRunning else { return nil }
        let elapsed = activity.flatMap { AidenBotElapsed.label(startedAt: $0.startedAt, nowMs: nowMs) }
        if isStreamDown {
            return AidenBotStatusLine(
                display: AidenBotActivityPhase.display(phase: "reconnecting", wording: wording, app: nil),
                elapsed: elapsed
            )
        }
        // While the reply's words stream, the words are the signal (§5.2).
        guard (partial ?? "").isEmpty else { return nil }
        guard let activity else {
            // Sent, and the first activity frame is on its way.
            return AidenBotStatusLine(
                display: AidenBotActivityPhase.display(phase: "preparing", wording: wording, app: nil),
                elapsed: nil
            )
        }
        return AidenBotStatusLine(
            display: AidenBotActivityPhase.display(phase: activity.phase, wording: wording, app: activity.app),
            elapsed: elapsed
        )
    }
```

7. Replace the start of `send(_:)`, through the end of the key selection, with:

```swift
    /// Sends one message. A Bot that needs an AI model sends nothing. While it
    /// works, on a Mac offering `bot-activity-v1`, `whenBusy` says Steer or Queue.
    @discardableResult
    func send(_ rawText: String, whenBusy mode: AidenStreamInputMode? = nil) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        let whenBusy = offersBusyModes ? mode : nil
        guard canSend, let request = try? AidenBotMessageRequest(text: text, whenBusy: whenBusy) else { return false }
        let key: UUID
        if let retainedMessage, retainedMessage.text == text, retainedMessage.whenBusy == whenBusy {
            key = retainedMessage.key
        } else {
            key = UUID()
            retainedMessage = (text, whenBusy, key)
        }
```

   The rest of `send` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotSessionActivityTests -only-testing:AidenOnTheGoTests/AidenBotSessionTests`
Expected: PASS. That is the 7 new tests plus the existing session tests, including `testClosedEndsTheConnectionAndListenReconnectsForANewSnapshot`.

- [ ] **Step 5: Commit**

```bash
git add ios/AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift ios/AidenOnTheGoTests/AidenBotSessionTests.swift
git commit -m "iOS Bots: status line state, Reconnecting, queued messages and Steer/Queue in the session model"
```

---

### Task 6: iOS chat: the status line, the busy pill, Queued bubbles and glancing faces

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift`, `ios/AidenOnTheGo/Features/Bots/AidenBotSemanticAvatarView.swift`, `ios/AidenOnTheGo/Features/Bots/AidenBotGeneratedAvatarLifecycle.swift`, `ios/AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift`
- Test: `ios/AidenOnTheGoTests/AidenBotSessionTests.swift` (new class `AidenBotFaceGlanceTests`)

**Interfaces:**
- Consumes: Task 5's model API. `AidenActivityMark`, `AidenActivityMarkSpec.make(_:)` and `AidenActivityMarkEvaluator.pose(of:atTime:)`. `AidenStreamInputMode.busyModes`, `busyLabel`, `busyDetail` and `busyActionLabel`.
- Produces:
  - `struct AidenBotFaceGlancePose { dx: Double; blink: Double; static let still }` and `func aidenBotFaceGlancePose(at:) -> AidenBotFaceGlancePose`.
  - The new parameters `AidenBotSemanticAvatarView(…, working:)` and `AidenBotCanonicalAvatarView(…, working:)`.
  - `struct AidenBotStatusLineView`.

- [ ] **Step 1: Write the failing test**

Append to `AidenBotSessionTests.swift`:

```swift
/// A working Bot's face follows the shared `glance` keyframes (docs/activity-marks.md).
final class AidenBotFaceGlanceTests: XCTestCase {
    func testTheEyesLookLeftThenRightAndBlinkOnTheGlanceTimeline() {
        XCTAssertEqual(aidenBotFaceGlancePose(at: 0), .still, "t = 0 is the still pose Reduce Motion shows")
        // 1.28 s is 32% of the 4 s period: held at translateX −2.6 of 24.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 1.28).dx, -2.6 / 24, accuracy: 0.0005)
        // 2.4 s is 60%: held at +2.6.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 2.4).dx, 2.6 / 24, accuracy: 0.0005)
        // 3.6 s is 90%: the blink's lowest point.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 3.6).blink, 0.1, accuracy: 0.0005)
        XCTAssertEqual(aidenBotFaceGlancePose(at: 4).dx, 0, accuracy: 0.0005, "the timeline loops")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotFaceGlanceTests`
Expected: build FAILS. `aidenBotFaceGlancePose` is undefined.

- [ ] **Step 3: The glancing face**

In `ios/AidenOnTheGo/Features/Bots/AidenBotSemanticAvatarView.swift`:

1. Above `struct AidenBotSemanticAvatarView`, add:

```swift
/// The canonical face's glance while its Bot works: the eyes look left and
/// right and blink, on the shared `glance` keyframes. `dx` is a fraction of the
/// avatar's size; `blink` scales the eyes' height.
struct AidenBotFaceGlancePose: Equatable {
    var dx: Double
    var blink: Double

    static let still = AidenBotFaceGlancePose(dx: 0, blink: 1)
}

private let aidenBotGlanceSpec = AidenActivityMarkSpec.make(.glance)

func aidenBotFaceGlancePose(at time: TimeInterval) -> AidenBotFaceGlancePose {
    let look = AidenActivityMarkEvaluator.pose(of: aidenBotGlanceSpec.groups[0].tracks, atTime: time)
    let eye = AidenActivityMarkEvaluator.pose(of: aidenBotGlanceSpec.shapes[0].tracks, atTime: time)
    // The mark's view box is 24 wide.
    return AidenBotFaceGlancePose(dx: look.translateX / 24, blink: eye.scaleY)
}
```

2. In `AidenBotSemanticAvatarView`:
   - Add `var working = false`, `@Environment(\.accessibilityReduceMotion) private var systemReduceMotion` and `@Environment(\.aidenReduceMotion) private var appReduceMotion`.
   - Change `AidenBotEyeMark(size: size)` to `AidenBotEyeMark(size: size, glancing: working && !systemReduceMotion && !appReduceMotion)`.
3. Replace `AidenBotEyeMark` with:

```swift
/// The one eye mark every Bot shares: two short, slightly tilted strokes.
/// While its Bot works they glance; otherwise (and under Reduce Motion) they hold still.
private struct AidenBotEyeMark: View {
    let size: CGFloat
    var glancing = false

    var body: some View {
        TimelineView(.animation(paused: !glancing)) { context in
            let pose = glancing ? aidenBotFaceGlancePose(at: context.date.timeIntervalSinceReferenceDate) : .still
            HStack(spacing: size * 0.09) {
                Capsule()
                    .frame(width: size * 0.09, height: size * 0.2)
                    .scaleEffect(x: 1, y: pose.blink)
                Capsule()
                    .frame(width: size * 0.09, height: size * 0.2)
                    .scaleEffect(x: 1, y: pose.blink)
            }
            .foregroundStyle(Color(aidenRGB: aidenBotAvatarFaceRGB))
            .offset(x: pose.dx * size)
            .rotationEffect(.degrees(-12))
            .offset(x: size * 0.08, y: -size * 0.02)
        }
        .accessibilityHidden(true)
    }
}
```

4. In `AidenBotGeneratedAvatarLifecycle.swift`'s `AidenBotCanonicalAvatarView`:
   - Add `var working = false` and `@Environment(\.aidenPalette) private var palette`.
   - Pass `working: working` to the inner `AidenBotSemanticAvatarView`.
   - After the `if let canonicalImage { … }` block inside the `ZStack`, add:
   ```swift
               // A photo can't glance; a small glance mark says the Bot is working.
               if working, canonicalImage != nil {
                   AidenActivityMark(mark: .glance, size: size * 0.32, color: palette.foreground)
                       .padding(size * 0.04)
                       .background(palette.canvas, in: Circle())
                       .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
               }
   ```
5. In `AidenBotsHomeView.swift`'s `botRow`, pass `working: row.isWorking` to `AidenBotCanonicalAvatarView`, and delete the `.overlay(alignment: .bottomTrailing) { if row.isWorking { Circle()… } }` green dot. The row's accessibility label keeps "Working".

- [ ] **Step 4: The status line, the busy pill and Queued bubbles**

In `AidenBotSessionChatView.swift`:

1. Add the state `@State private var busyMode: AidenStreamInputMode = .queue`.
2. In `start()`, after `self.model = model`, add `model.activitySupported = coordinator.server?.supportsBotActivity == true`.
3. In `loadSummary()`, inside the `if let detail = …` block, add `model?.wording = detail.chatActivity?.wording ?? .follows`.
4. Add to the view's modifiers, after `.task(id: filesLookupKey) { … }`:
   ```swift
           // Chat activity is changed in Advanced; reread the Bot when it closes.
           .onChange(of: isShowingAdvanced) { _, showing in
               if !showing { Task { await loadSummary() } }
           }
           .onChange(of: model?.isRunning == true) { _, running in
               if !running { busyMode = .queue }
           }
   ```
5. In `transcript`, after the `if let partial = model.partial { … }` block, add:
   ```swift
                           ForEach(model.queued, id: \.submissionId) { message in
                               queuedBubble(message)
                           }
                           AidenBotStatusLineView(model: model)
                               .id("status")
   ```
   Also add `.onChange(of: model.queued.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }` next to the other `onChange`s.
6. Add to the view:

```swift
    private func queuedBubble(_ message: AidenBotQueuedMessage) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(message.text)
                .foregroundStyle(palette.foreground)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                // A queued message waits for the reply; a steer has already joined it.
                .opacity(message.mode == .queue ? 0.55 : 1)
            if message.mode == .queue {
                Text(AidenBotSessionCopy.queued)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityHint(message.mode == .queue ? "Sends when the current reply finishes" : "")
    }

    private var draftIsEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Steer or Queue while the Bot works (desktop and Android parity): the mode's
    /// name sends in that mode; touch and hold for the menu.
    private func busyPill(_ model: AidenBotSessionModel) -> some View {
        let enabled = canWrite && model.canSend && !draftIsEmpty
        return Menu {
            ForEach(AidenStreamInputMode.busyModes, id: \.self) { mode in
                Button {
                    busyMode = mode
                } label: {
                    if busyMode == mode {
                        Label { Text(mode.busyLabel); Text(mode.busyDetail) } icon: { Image(systemName: "checkmark") }
                    } else {
                        Text(mode.busyLabel)
                        Text(mode.busyDetail)
                    }
                }
                .accessibilityAddTraits(busyMode == mode ? .isSelected : [])
            }
        } label: {
            Text(busyMode.busyLabel)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .foregroundStyle(enabled ? palette.onAccent : palette.secondary)
                .background(enabled ? palette.accent : palette.raised, in: Capsule())
        } primaryAction: {
            let text = draft
            let mode = busyMode
            Task { if await model.send(text, whenBusy: mode) { draft = "" } }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(busyMode.busyActionLabel)
        .accessibilityHint("Touch and hold to choose Steer or Queue")
    }
```

7. In `composer(_:)`, inside `if model.isRunning {`, put `if model.offersBusyModes { busyPill(model) }` before the Stop `Button`.
8. At the end of the file, add:

```swift
/// The status line while a Bot works (spec §12): a native activity mark and the
/// shared word, plus the elapsed time after 20 seconds. No steps, no Stop.
struct AidenBotStatusLineView: View {
    let model: AidenBotSessionModel

    @Environment(\.aidenPalette) private var palette
    @State private var announcer = AidenBotStatusAnnouncer()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let line = model.statusLine(nowMs: Int(context.date.timeIntervalSince1970 * 1_000)) {
                HStack(spacing: 8) {
                    AidenActivityMark(mark: line.display.mark, size: 18, color: palette.secondary)
                    Text(line.display.word)
                    if let elapsed = line.elapsed {
                        Text("· \(elapsed)").monospacedDigit()
                    }
                }
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(line.accessibilityLabel)
                .accessibilityAddTraits(.updatesFrequently)
                .onChange(of: line.display.word, initial: true) { _, word in announce(word) }
            }
        }
    }

    /// VoiceOver hears a change at most once every 2 seconds; the newest word wins.
    private func announce(_ word: String) {
        let offer = announcer.offer(word, at: Date().timeIntervalSinceReferenceDate)
        if let text = offer.announce {
            AccessibilityNotification.Announcement(text).post()
        } else if let retry = offer.retryAfter {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(retry))
                if let latest = model.statusLine(nowMs: Int(Date().timeIntervalSince1970 * 1_000))?.display.word {
                    announce(latest)
                }
            }
        }
    }
}
```

- [ ] **Step 5: Run the tests and look at it**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotFaceGlanceTests -only-testing:AidenOnTheGoTests/AidenBotSessionActivityTests -only-testing:AidenOnTheGoTests/AidenBotHomeProfileTests`
Expected: PASS.

Then build and run the app on the iPhone 17 Pro simulator against a Mac running this branch. Check four things:
1. Send to a Bot: the line shows "Getting ready" → "Thinking" → … and disappears as the reply streams.
2. While it works, the pill reads Queue, and touch-and-hold offers Steer. A queued message shows faded with "Queued".
3. In Bots home, the working Bot's face glances.
4. With Settings → Accessibility → Reduce Motion on, the face and mark hold still.

Capture screenshots, light and dark.

- [ ] **Step 6: Commit**

```bash
git add ios/AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift ios/AidenOnTheGo/Features/Bots/AidenBotSemanticAvatarView.swift ios/AidenOnTheGo/Features/Bots/AidenBotGeneratedAvatarLifecycle.swift ios/AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift ios/AidenOnTheGoTests/AidenBotSessionTests.swift
git commit -m "iOS Bots: status line, Steer/Queue pill, Queued bubbles and glancing faces"
```

---

### Task 7: iOS Advanced → Chat activity

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift`
- Test: `ios/AidenOnTheGoTests/AidenBotSessionTests.swift` (new class `AidenBotChatActivityTests`)

**Interfaces:**
- Consumes:
  - `AidenBotChatActivity*` and `AidenBotIdentityPatch(chatActivity:)` (Task 4).
  - `AidenBotActivityPhase.display` (Task 4).
  - `AidenRemoteClient.updateBotIdentity(id:revision:patch:)`.
  - `AidenServer.supportsBotActivity` (Task 4).
- Produces:
  - `enum AidenBotChatActivityCopy` (labels, descriptions, `summary(_:)`).
  - `enum AidenBotChatActivityPreview { struct Frame; static let durations; static let stillFrame; static func frameIndex(elapsed:) -> Int; static func frame(index:level:) -> Frame }`.
  - `@Observable final class AidenBotChatActivityModel { value; isSaving; errorMessage; func pick(_:) async }`.
  - `struct AidenBotChatActivityView`.

- [ ] **Step 1: Write the failing tests**

Append to `AidenBotSessionTests.swift`:

```swift
@MainActor
final class AidenBotChatActivityTests: XCTestCase {
    private struct SaveFailure: Error {}

    private func detail(revision: String, _ activity: AidenBotChatActivity?) throws -> AidenBotDetail {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let shared = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var object = try XCTUnwrap(shared["botDetail"] as? [String: Any])
        object["revision"] = revision
        if let activity { object["chatActivity"] = ["level": activity.level.rawValue, "wording": activity.wording.rawValue] }
        return try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: JSONSerialization.data(withJSONObject: object))
    }

    // Test 1
    func testAPickSavesAtOnceWithTheBotsRevisionAndTheNextPickUsesTheNewOne() async throws {
        var calls: [(AidenBotChatActivity, String)] = []
        var saved: [AidenBotDetail] = []
        let start = try detail(revision: "rev_1", nil)
        let model = AidenBotChatActivityModel(bot: start, save: { next, revision in
            calls.append((next, revision))
            return try self.detail(revision: revision == "rev_1" ? "rev_2" : "rev_3", next)
        }, onSaved: { saved.append($0) })
        XCTAssertEqual(model.value, .standard, "a Bot that never chose reads as Quiet, Follows the work")

        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        await model.pick(AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(calls.map(\.1), ["rev_1", "rev_2"])
        XCTAssertEqual(model.value, AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(saved.map(\.revision), ["rev_2", "rev_3"])

        await model.pick(AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(calls.count, 2, "picking the current choice sends nothing")
    }

    // Test 2 (Review Focus 5)
    func testAFailedSaveReturnsToTheSavedChoiceAndSaysSo() async throws {
        var revisions: [String] = []
        var fail = true
        let model = AidenBotChatActivityModel(bot: try detail(revision: "rev_1", AidenBotChatActivity(level: .quiet, wording: .follows)), save: { next, revision in
            revisions.append(revision)
            if fail { throw SaveFailure() }
            return try self.detail(revision: "rev_2", next)
        }, onSaved: { _ in })
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value, AidenBotChatActivity(level: .quiet, wording: .follows))
        XCTAssertEqual(model.errorMessage, "Aiden couldn’t save that choice.")
        XCTAssertFalse(model.isSaving)

        fail = false
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(revisions, ["rev_1", "rev_1"], "a failed save leaves the revision where it was")
        XCTAssertEqual(model.value.level, .detailed)
    }

    // Test 3
    func testPreviewsShowWhatEachLevelLooksLikeOnTheMac() {
        let reading = 1
        let reply = AidenBotChatActivityPreview.durations.count - 1
        XCTAssertEqual(AidenBotChatActivityPreview.frame(index: reading, level: .quiet).phase, "reading")
        XCTAssertEqual(AidenBotChatActivityPreview.frame(index: reading, level: .quiet).steps, [])
        XCTAssertEqual(AidenBotChatActivityPreview.frame(index: 2, level: .detailed).steps, ["Read 1 file", "Searched the web"])
        XCTAssertNil(AidenBotChatActivityPreview.frame(index: reply, level: .quiet).recap)
        let summary = AidenBotChatActivityPreview.frame(index: reply, level: .summary)
        XCTAssertEqual(summary.recap, "Worked for 18s · read 1 file, searched the web, edited 1 file")
        XCTAssertFalse(summary.recapOpen)
        let detailed = AidenBotChatActivityPreview.frame(index: reply, level: .detailed)
        XCTAssertTrue(detailed.recapOpen)
        XCTAssertEqual(detailed.steps.count, 3)
        XCTAssertNil(detailed.phase, "the reply has landed")

        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 0), 0)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 1.5), 1)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 6.5), reply)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 8.8), 0, "the turn loops")
        XCTAssertNotNil(AidenBotChatActivityPreview.frame(index: AidenBotChatActivityPreview.stillFrame, level: .quiet).phase,
                        "Reduce Motion's still frame shows the line mid-turn")
    }

    // Test 4
    func testTheAdvancedRowSummarizesTheChoice() {
        XCTAssertEqual(AidenBotChatActivityCopy.summary(nil), "Quiet · Follows the work")
        XCTAssertEqual(AidenBotChatActivityCopy.summary(AidenBotChatActivity(level: .detailed, wording: .thinking)), "Detailed · Always “Thinking”")
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotChatActivityTests`
Expected: build FAILS. `AidenBotChatActivityModel` is undefined.

- [ ] **Step 3: The model, copy and previews**

Append to `ios/AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift`:

```swift
// MARK: - Chat activity (spec §7, contract revision 30)

/// Copy shared with the desktop page (`bot-chat-activity-page.tsx`) and Android.
enum AidenBotChatActivityCopy {
    static let title = "Chat activity"
    static let levelTitle = "How much to show"
    static let wordingTitle = "What the status line says"
    static let phonesTitle = "On iPhone and Android"
    static let phonesFooter = "Always just the line, with the same words."
    static let recommended = "Recommended"
    static let saveFailed = "Aiden couldn’t save that choice."

    static func label(_ level: AidenBotChatActivityLevel) -> String {
        switch level {
        case .quiet: "Quiet"
        case .summary: "Summary"
        case .detailed: "Detailed"
        }
    }

    static func detail(_ level: AidenBotChatActivityLevel) -> String {
        switch level {
        case .quiet: "One line that says what it’s doing."
        case .summary: "Adds a short recap above each reply."
        case .detailed: "Also shows its last few steps while it works."
        }
    }

    static func label(_ wording: AidenBotChatActivityWording) -> String {
        switch wording {
        case .follows: "Follows the work"
        case .thinking: "Always “Thinking”"
        }
    }

    static func detail(_ wording: AidenBotChatActivityWording) -> String {
        switch wording {
        case .follows: "Says what it’s doing, like Reading or Searching the web."
        case .thinking: "One calm word, whatever it’s doing."
        }
    }

    /// Advanced's trailing value: "Quiet · Follows the work".
    static func summary(_ value: AidenBotChatActivity?) -> String {
        let resolved = value ?? .standard
        return "\(label(resolved.level)) · \(label(resolved.wording))"
    }

    static func description(botName: String) -> String {
        "What you see in \(botName)’s chat on your Mac while it works. Changes save as you pick them."
    }
}

/// One scripted turn, as each level shows it on the Mac: think, read, search, edit, reply.
enum AidenBotChatActivityPreview {
    struct Frame: Equatable {
        /// The line's phase, or nil on the reply frame.
        let phase: String?
        /// Step rows: Detailed while live, or the open recap after the reply.
        let steps: [String]
        let recap: String?
        let recapOpen: Bool
    }

    static let durations: [TimeInterval] = [1.4, 1.6, 1.6, 1.4, 2.8]
    /// Reduce Motion's still frame: mid-turn, with the line showing.
    static let stillFrame = 2
    static let prompt = "Plan dinners for this week"
    static let reply = "Here’s a plan for the week."
    static let recap = "Worked for 18s · read 1 file, searched the web, edited 1 file"

    private static let phases: [String?] = ["thinking", "reading", "searching", "editing", nil]
    private static let stepLabels = ["Read 1 file", "Searched the web", "Edited 1 file"]

    static func frameIndex(elapsed: TimeInterval) -> Int {
        let total = durations.reduce(0, +)
        var time = elapsed.truncatingRemainder(dividingBy: total)
        if time < 0 { time += total }
        for (index, duration) in durations.enumerated() {
            if time < duration { return index }
            time -= duration
        }
        return durations.count - 1
    }

    static func frame(index: Int, level: AidenBotChatActivityLevel) -> Frame {
        let clamped = min(max(index, 0), phases.count - 1)
        if let phase = phases[clamped] {
            return Frame(phase: phase, steps: level == .detailed ? Array(stepLabels.prefix(clamped)) : [], recap: nil, recapOpen: false)
        }
        switch level {
        case .quiet: return Frame(phase: nil, steps: [], recap: nil, recapOpen: false)
        case .summary: return Frame(phase: nil, steps: [], recap: recap, recapOpen: false)
        case .detailed: return Frame(phase: nil, steps: stepLabels, recap: recap, recapOpen: true)
        }
    }
}

/// Saves each pick at once (no Save button), like the Mac page.
@MainActor
@Observable
final class AidenBotChatActivityModel {
    private(set) var value: AidenBotChatActivity
    private(set) var isSaving = false
    var errorMessage: String?

    @ObservationIgnored private var revision: String
    @ObservationIgnored private let save: @MainActor (AidenBotChatActivity, String) async throws -> AidenBotDetail
    @ObservationIgnored private let onSaved: @MainActor (AidenBotDetail) -> Void

    init(
        bot: AidenBotDetail,
        save: @escaping @MainActor (AidenBotChatActivity, String) async throws -> AidenBotDetail,
        onSaved: @escaping @MainActor (AidenBotDetail) -> Void
    ) {
        value = bot.chatActivity ?? .standard
        revision = bot.revision
        self.save = save
        self.onSaved = onSaved
    }

    /// Shows the pick at once; a failed save returns to the saved choice.
    func pick(_ next: AidenBotChatActivity) async {
        guard next != value, !isSaving else { return }
        let previous = value
        value = next
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await save(next, revision)
            revision = saved.revision
            value = saved.chatActivity ?? next
            onSaved(saved)
        } catch is CancellationError {
            value = previous
        } catch {
            value = previous
            errorMessage = AidenBotChatActivityCopy.saveFailed
        }
    }
}
```

- [ ] **Step 4: The page and the Advanced row**

Append to the same file:

```swift
struct AidenBotChatActivityView: View {
    let botName: String
    let canWrite: Bool
    @State private var model: AidenBotChatActivityModel
    @Environment(\.aidenPalette) private var palette

    init(bot: AidenBotDetail, canWrite: Bool, model: AidenBotChatActivityModel) {
        botName = bot.name
        self.canWrite = canWrite
        _model = State(initialValue: model)
    }

    var body: some View {
        Form {
            Section {
                Text(AidenBotChatActivityCopy.description(botName: botName))
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            Section(AidenBotChatActivityCopy.levelTitle) {
                ForEach(AidenBotChatActivityLevel.allCases, id: \.self) { level in
                    choiceRow(
                        title: AidenBotChatActivityCopy.label(level),
                        detail: AidenBotChatActivityCopy.detail(level),
                        recommended: level == .quiet,
                        selected: model.value.level == level,
                        preview: AidenBotChatActivityPreviewView(level: level, wording: model.value.wording)
                    ) { Task { await model.pick(AidenBotChatActivity(level: level, wording: model.value.wording)) } }
                }
            }
            Section(AidenBotChatActivityCopy.wordingTitle) {
                ForEach(AidenBotChatActivityWording.allCases, id: \.self) { wording in
                    choiceRow(
                        title: AidenBotChatActivityCopy.label(wording),
                        detail: AidenBotChatActivityCopy.detail(wording),
                        recommended: false,
                        selected: model.value.wording == wording,
                        preview: AidenBotChatActivityPreviewView(level: .quiet, wording: wording)
                    ) { Task { await model.pick(AidenBotChatActivity(level: model.value.level, wording: wording)) } }
                }
            }
            Section {
                AidenBotChatActivityPreviewView(level: .quiet, wording: model.value.wording)
            } header: {
                Text(AidenBotChatActivityCopy.phonesTitle)
            } footer: {
                Text(AidenBotChatActivityCopy.phonesFooter)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle(AidenBotChatActivityCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(!canWrite || model.isSaving)
        .alert(
            "Couldn’t Save",
            isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
        ) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? AidenBotChatActivityCopy.saveFailed)
        }
    }

    /// A radio row: the radio and the row's background show the choice; there is no border.
    private func choiceRow(
        title: String,
        detail: String,
        recommended: Bool,
        selected: Bool,
        preview: AidenBotChatActivityPreviewView,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? palette.accent : palette.secondary)
                    .font(.title3)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(title).foregroundStyle(palette.foreground)
                        if recommended {
                            Text(AidenBotChatActivityCopy.recommended)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(palette.secondary)
                        }
                    }
                    Text(detail).font(.footnote).foregroundStyle(palette.secondary)
                    preview
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? palette.raised : nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(detail)
    }
}

/// A small chat replaying one scripted turn. It holds its still frame under Reduce Motion.
struct AidenBotChatActivityPreviewView: View {
    let level: AidenBotChatActivityLevel
    let wording: AidenBotChatActivityWording

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @State private var started = Date()

    private var still: Bool { systemReduceMotion || appReduceMotion }

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.2, paused: still)) { context in
            let index = still
                ? AidenBotChatActivityPreview.stillFrame
                : AidenBotChatActivityPreview.frameIndex(elapsed: context.date.timeIntervalSince(started))
            content(AidenBotChatActivityPreview.frame(index: index, level: level))
        }
        .padding(10)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview")
    }

    @ViewBuilder
    private func content(_ frame: AidenBotChatActivityPreview.Frame) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(AidenBotChatActivityPreview.prompt)
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
            if let recap = frame.recap {
                Label(recap, systemImage: frame.recapOpen ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(palette.secondary)
            }
            ForEach(frame.steps, id: \.self) { step in
                Text(step).font(.caption2).foregroundStyle(palette.secondary).padding(.leading, 14)
            }
            if let phase = frame.phase {
                let shown = AidenBotActivityPhase.display(phase: phase, wording: wording, app: nil)
                HStack(spacing: 6) {
                    AidenActivityMark(mark: shown.mark, size: 14, active: !still, color: palette.secondary)
                    Text(shown.word).font(.caption)
                }
                .foregroundStyle(palette.secondary)
            } else {
                Text(AidenBotChatActivityPreview.reply).font(.caption).foregroundStyle(palette.foreground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
```

In `AidenBotAdvancedView`:
1. In `form(_:)`, after `accessSection(catalog)`, add `chatActivitySection`.
2. Add:

```swift
    /// Revision 30: hidden for Macs that don't announce `bot-activity-v1` (§11, Older Macs).
    @ViewBuilder
    private var chatActivitySection: some View {
        if coordinator.server?.supportsBotActivity == true, let baselineBot {
            Section {
                NavigationLink {
                    AidenBotChatActivityView(
                        bot: baselineBot,
                        canWrite: canWrite,
                        model: AidenBotChatActivityModel(bot: baselineBot, save: { next, revision in
                            let context = try coordinator.requestContext()
                            let client = try coordinator.remoteClient(for: context)
                            return try await client.updateBotIdentity(
                                id: baselineBot.id,
                                revision: revision,
                                patch: try AidenBotIdentityPatch(chatActivity: next)
                            )
                        }, onSaved: { saved in
                            // Keep Advanced's own Save on the newest revision.
                            self.baselineBot = saved
                        })
                    )
                } label: {
                    LabeledContent(AidenBotChatActivityCopy.title, value: AidenBotChatActivityCopy.summary(baselineBot.chatActivity))
                }
                .disabled(isDirty)
            } footer: {
                Text(isDirty ? "Save or cancel your changes first." : "What you see in its chat on your Mac while it works.")
            }
        }
    }
```

`.disabled(isDirty)` keeps the identity revision single-writer: Advanced's Save and a Chat activity pick never race on one revision.

- [ ] **Step 5: Run the tests and look at it**

Run: `xcodebuild test … -only-testing:AidenOnTheGoTests/AidenBotChatActivityTests -only-testing:AidenOnTheGoTests/AidenBotSessionTests`
Expected: PASS (4 new tests).

Run the app against a revision-30 Mac. Check:
1. Advanced shows "Chat activity · Quiet · Follows the work".
2. Picking Summary saves at once, and the Mac's chat shows the recap on its next reply.
3. Previews loop, and hold still under Reduce Motion.
4. Against a revision-29 Mac, the row is absent.

- [ ] **Step 6: Commit**

```bash
git add ios/AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift ios/AidenOnTheGoTests/AidenBotSessionTests.swift
git commit -m "iOS Bots: Advanced → Chat activity with looping previews, saved on pick"
```

---

### Task 8: Android wire models, the `bot:activity` opt-in, the phase table and elapsed time

**Files:**
- Modify: `android/.../models/AidenBotSession.kt`, `android/.../models/AidenBot.kt`, `android/.../protocol/AidenRemoteProtocol.kt`, `android/.../models/AidenInstallation.kt`, `android/.../features/remote/AidenRemoteCoordinator.kt`, `android/.../networking/AidenRemoteClient.kt`, `android/app/src/main/res/values/strings.xml`
- Create: `android/.../features/bots/AidenBotActivity.kt`
- Test: create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotActivityContractTest.kt`

**Interfaces:**
- Consumes: Task 1's fixture sections.
- Produces:
  - `data class AidenBotSessionActivity(phase, app?, startedAt: Long)` and `data class AidenBotQueuedMessage(submissionId, mode: AidenStreamInputMode, text)`.
  - `AidenBotSession.activity: AidenBotSessionActivity?` and `AidenBotSession.queued: List<AidenBotQueuedMessage>?`.
  - `AidenBotSessionEventPayload.Activity(activity?)` and `AidenBotSessionEventPayload.Queued(queued)`.
  - `AidenBotSessionSendRequest(text, whenBusy?)`.
  - `enum AidenBotChatActivityLevel`, `enum AidenBotChatActivityWording` and `data class AidenBotChatActivity(level, wording) { companion DEFAULT }`.
  - `AidenBotDetail.chatActivity` and `AidenBotIdentityPatch.chatActivity`.
  - `AidenRemoteProtocol.BOT_ACTIVITY_FEATURE`, `AidenRemoteCapability.BOT_ACTIVITY` and `PHONE_BOT_ACTIVITY`.
  - `AidenServer.offersBotActivity` and `AidenServer.supportsBotActivity`.
  - `AidenRemoteClient.sendBotMessage(botId, text, idempotencyKey, whenBusy = null)`.
  - In `AidenBotActivity.kt`:
    - `enum class AidenBotActivityPhase(id, @StringRes word, mark) { companion fun of(id) }`
    - `data class AidenBotActivityDisplay(phase, app?)` and `aidenBotActivityDisplay(phase, wording, app)`
    - `aidenBotElapsedLabel(startedAt, nowMs): String?` and `aidenBotDurationLabel(ms)`
    - `data class AidenBotAnnouncement(text, atMs)`, `data class AidenBotAnnouncementStep(shown, retryInMs)` and `aidenBotNextAnnouncement(current, text, nowMs, gapMs = 2_000)`
    - `data class AidenBotFaceGlance(dxFraction, blink)` and `aidenBotFaceGlance(timeMs)`

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotActivityContractTest.kt`:

```kotlin
package sbtbiswas.AidenOnTheGo

import androidx.annotation.StringRes
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotActivityPhase
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotActivityDisplay
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotElapsedLabel
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotFaceGlance
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotNextAnnouncement
import sbtbiswas.AidenOnTheGo.models.*
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Contract revision 30: the activity wire, read from the fixture every client shares. */
class AidenBotActivityContractTest {
    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val activity get() = fixture.getValue("botActivity").jsonObject
    private val privacy get() = fixture.getValue("botActivityPrivacy").jsonObject
    private val started = 1_760_450_000_000L

    /** The English copy in `strings.xml`, by resource name. */
    private val strings: Map<String, String> by lazy {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/res/values/strings.xml"))
        val nodes = document.getElementsByTagName("string")
        (0 until nodes.length).associate { index ->
            val element = nodes.item(index) as org.w3c.dom.Element
            element.getAttribute("name") to element.textContent
        }
    }

    private fun english(@StringRes id: Int): String =
        strings.getValue(R.string::class.java.fields.first { it.getInt(null) == id }.name)

    // Test 1 (Review Focus 3)
    @Test
    fun activitySessionFramesAndDetailDecodeAsTheMacSendsThem() {
        val session = json.decodeFromJsonElement(AidenBotSession.serializer(), activity.getValue("session"))
        assertEquals(AidenBotSessionActivity("app", "Notion", started), session.activity)
        assertEquals(listOf("18", "19"), session.queued?.map { it.submissionId })
        assertEquals(listOf(AidenStreamInputMode.QUEUE, AidenStreamInputMode.STEER), session.queued?.map { it.mode })

        val events = json.decodeFromJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), activity.getValue("events"))
        assertEquals(
            listOf(
                AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("searching", null, started)),
                AidenBotSessionEventPayload.Queued(listOf(AidenBotQueuedMessage("18", AidenStreamInputMode.QUEUE, "Also add a shopping list."))),
                AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("teleporting", null, started)),
                AidenBotSessionEventPayload.Activity(null),
            ),
            events.map { it.payload }
        )
        // Frames re-encode as the Mac sent them.
        assertEquals(activity.getValue("events"), json.encodeToJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), events))
        // A newer Mac's phase decodes and reads as Working.
        assertEquals(
            aidenBotActivityDisplay("working", AidenBotChatActivityWording.FOLLOWS, null),
            aidenBotActivityDisplay("teleporting", AidenBotChatActivityWording.FOLLOWS, null)
        )

        val detail = json.decodeFromJsonElement(AidenBotDetail.serializer(), activity.getValue("detail"))
        assertEquals(AidenBotChatActivity(AidenBotChatActivityLevel.SUMMARY, AidenBotChatActivityWording.THINKING), detail.chatActivity)
        assertNull(json.decodeFromJsonElement(AidenBotDetail.serializer(), fixture.getValue("botDetail")).chatActivity)
    }

    // Test 2
    @Test
    fun everyPrivacySampleIsRefused() {
        for (sample in privacy.getValue("rejectedActivities").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotSessionActivity.serializer(), sample)
            }
        }
        for (sample in privacy.getValue("rejectedQueued").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotQueuedMessage.serializer(), sample)
            }
        }
        for (sample in privacy.getValue("rejectedChatActivity").jsonArray) {
            assertThrows(sample.toString(), Exception::class.java) {
                json.decodeFromJsonElement(AidenBotChatActivity.serializer(), sample)
            }
        }
        val session = activity.getValue("session").jsonObject
        val twentyOne = JsonArray((0..20).map {
            JsonObject(mapOf("submissionId" to JsonPrimitive("$it"), "mode" to JsonPrimitive("queue"), "text" to JsonPrimitive("x")))
        })
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotSession.serializer(), JsonObject(session + ("queued" to twentyOne)))
        }
    }

    // Test 3
    @Test
    fun requestsEncodeExactlyTheFixtureBodies() {
        val send = activity.getValue("send").jsonObject.getValue("request")
        assertEquals(send, json.encodeToJsonElement(AidenBotSessionSendRequest.serializer(), AidenBotSessionSendRequest("Keep it vegetarian.", AidenStreamInputMode.STEER)))
        assertEquals(
            JsonObject(mapOf("text" to JsonPrimitive("Hi"))),
            json.encodeToJsonElement(AidenBotSessionSendRequest.serializer(), AidenBotSessionSendRequest("Hi"))
        )
        val patch = activity.getValue("identityPatch").jsonObject.getValue("request")
        assertEquals(
            patch,
            json.encodeToJsonElement(
                AidenBotIdentityPatch.serializer(),
                AidenBotIdentityPatch(chatActivity = AidenBotChatActivity(AidenBotChatActivityLevel.DETAILED, AidenBotChatActivityWording.FOLLOWS))
            )
        )
    }

    // Test 4
    @Test
    fun phaseTableIsTheOneTheMacDraws() {
        val phases = activity.getValue("phases").jsonArray.map { it.jsonObject }
        val keeps = activity.getValue("thinkingKeeps").jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(phases.map { it.getValue("id").jsonPrimitive.content }, AidenBotActivityPhase.entries.map { it.id })
        for (row in phases) {
            val id = row.getValue("id").jsonPrimitive.content
            val shown = aidenBotActivityDisplay(id, AidenBotChatActivityWording.FOLLOWS, null)
            assertEquals(id, shown.phase.id)
            assertEquals(id, row.getValue("word").jsonPrimitive.content, english(shown.phase.word))
            assertEquals(id, row.getValue("mark").jsonPrimitive.content, shown.mark.wireName)
            val thinking = aidenBotActivityDisplay(id, AidenBotChatActivityWording.THINKING, null)
            assertEquals(id, if (id in keeps) id else "thinking", thinking.phase.id)
        }
        val app = activity.getValue("app").jsonObject
        val named = aidenBotActivityDisplay("app", AidenBotChatActivityWording.FOLLOWS, app.getValue("app").jsonPrimitive.content)
        assertEquals(app.getValue("word").jsonPrimitive.content, english(R.string.bot_activity_app_named).replace("%1\$s", named.app!!))
    }

    // Test 5
    @Test
    fun elapsedMatchesTheMacIncludingAPhoneWhoseClockIsBehind() {
        for (row in activity.getValue("elapsed").jsonArray.map { it.jsonObject }) {
            val label = row.getValue("label").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(
                row.toString(),
                label,
                aidenBotElapsedLabel(row.getValue("startedAt").jsonPrimitive.longOrNull!!, row.getValue("now").jsonPrimitive.longOrNull!!)
            )
        }
    }

    // Test 6
    @Test
    fun screenReadersHearAStatusChangeAtMostEveryTwoSeconds() {
        val first = aidenBotNextAnnouncement(null, "Reading", 0)
        assertEquals("Reading", first.shown?.text)
        val same = aidenBotNextAnnouncement(first.shown, "Reading", 500)
        assertEquals(first.shown, same.shown)
        val early = aidenBotNextAnnouncement(first.shown, "Searching the web", 1_000)
        assertEquals("Reading", early.shown?.text)
        assertEquals(1_000L, early.retryInMs)
        assertEquals("Searching the web", aidenBotNextAnnouncement(early.shown, "Searching the web", 2_000).shown?.text)
    }

    // Test 7
    @Test
    fun aWorkingFaceFollowsTheGlanceKeyframes() {
        assertEquals(0f, aidenBotFaceGlance(0).dxFraction, 0.0005f)
        assertEquals(1f, aidenBotFaceGlance(0).blink, 0.0005f)
        assertEquals(-2.6f / 24f, aidenBotFaceGlance(1_280).dxFraction, 0.0005f)
        assertEquals(2.6f / 24f, aidenBotFaceGlance(2_400).dxFraction, 0.0005f)
        assertEquals(0.1f, aidenBotFaceGlance(3_600).blink, 0.0005f)
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain --tests 'sbtbiswas.AidenOnTheGo.AidenBotActivityContractTest'`
Expected: compilation FAILS. `AidenBotSessionActivity`, `AidenBotActivityPhase` and the other new names are undefined.

- [ ] **Step 3: Session wire types**

In `android/.../models/AidenBotSession.kt`:

1. Above `/** `GET /bots/{botId}/session`: …`, add:

```kotlin
/**
 * Contract revision 30 (`bot-activity-v1`, `bot:activity`): what a Bot in a running turn is
 * doing. Exactly `phase`, `app` and `startedAt` cross the wire; the strict wire JSON refuses
 * any other key (§11). An unknown phase id still decodes and reads as Working.
 */
@Serializable
data class AidenBotSessionActivity(
    val phase: String,
    val app: String? = null,
    /** When the turn started: the Mac's clock, milliseconds since 1970. */
    @Serializable(with = AidenStrictLongSerializer::class) val startedAt: Long
) {
    init {
        if (!PHASE_ID.matches(phase)) throw AidenBotContractException.InvalidField("activity.phase")
        app?.let { AidenBotWire.validateString(it, "activity.app", MAX_APP_LENGTH) }
        if (startedAt < 0 || startedAt > AidenRemoteProtocol.MAX_SAFE_INTEGER) {
            throw AidenBotContractException.InvalidField("activity.startedAt")
        }
    }

    companion object {
        const val MAX_APP_LENGTH = 40
        private val PHASE_ID = Regex("^[a-z][a-z_]{0,31}$")
    }
}

/** A message waiting for the running turn: STEER joins it, QUEUE runs after it. */
@Serializable
data class AidenBotQueuedMessage(
    val submissionId: String,
    val mode: AidenStreamInputMode,
    val text: String
) {
    init {
        if (!SUBMISSION_ID.matches(submissionId)) throw AidenBotContractException.InvalidField("queued.submissionId")
        AidenBotWire.validateString(text, "queued.text", AidenBotSessionWire.MAX_MESSAGE_LENGTH)
    }

    companion object {
        const val MAX_COUNT = 20
        private val SUBMISSION_ID = Regex("^[A-Za-z0-9._:-]{1,64}$")
    }
}
```

2. `AidenBotSession`:
   - Add `val activity: AidenBotSessionActivity? = null` and `val queued: List<AidenBotQueuedMessage>? = null` as the last constructor parameters.
   - Add to `init`:
   ```kotlin
           queued?.let { list ->
               if (list.size > AidenBotQueuedMessage.MAX_COUNT || list.map { it.submissionId }.toSet().size != list.size) {
                   throw AidenBotContractException.InvalidField("queued")
               }
           }
   ```
3. `AidenBotSessionFields`: add the same two properties with the same defaults as its last parameters.
   - In `AidenBotSessionSerializer.serialize`, pass `value.activity, value.queued` to `AidenBotSessionFields(…)`. `explicitNulls = false` omits them when null, so revision-29 sessions re-encode unchanged.
   - In `deserialize`, pass `activity = fields.activity, queued = fields.queued` to `AidenBotSession(…)`.
4. `AidenBotSessionSendRequest` becomes:
   ```kotlin
   @Serializable
   data class AidenBotSessionSendRequest(
       val text: String,
       /** Revision 30 (`bot-activity-v1`): Steer joins the running turn, Queue runs after it. */
       val whenBusy: AidenStreamInputMode? = null
   ) {
       init {
           AidenBotWire.validateString(text, "text", AidenBotSessionWire.MAX_MESSAGE_LENGTH)
           if (text.isBlank()) throw AidenBotContractException.InvalidField("text")
       }
   }
   ```
5. `AidenBotSessionEventPayload`: add before `Closed`:
   ```kotlin
       /** Revision 30: what the running turn is doing now, or null when none runs. */
       data class Activity(val activity: AidenBotSessionActivity?) : AidenBotSessionEventPayload()
       /** Revision 30: the person's messages still waiting for the turn. */
       data class Queued(val queued: List<AidenBotQueuedMessage>) : AidenBotSessionEventPayload() {
           init {
               if (queued.size > AidenBotQueuedMessage.MAX_COUNT || queued.map { it.submissionId }.toSet().size != queued.size) {
                   throw AidenBotContractException.InvalidField("queued")
               }
           }
       }
   ```
6. `AidenBotSessionEvent.type`: add `is AidenBotSessionEventPayload.Activity -> "activity"` and `is AidenBotSessionEventPayload.Queued -> "queued"`.
7. `AidenBotSessionEventSerializer.serialize`'s `when`: add
   ```kotlin
               is AidenBotSessionEventPayload.Activity -> buildJsonObject {
                   put("activity", p.activity?.let { wire.encodeToJsonElement(AidenBotSessionActivity.serializer(), it) } ?: JsonNull)
               }
               is AidenBotSessionEventPayload.Queued -> buildJsonObject {
                   put("queued", wire.encodeToJsonElement(ListSerializer(AidenBotQueuedMessage.serializer()), p.queued))
               }
   ```
   `decode`'s `when`: add before `"closed" ->`:
   ```kotlin
               "activity" -> {
                   payload.requireKeys(setOf("activity"))
                   val element = payload.getValue("activity")
                   AidenBotSessionEventPayload.Activity(
                       if (element is JsonNull) null else wire.decodeFromJsonElement(AidenBotSessionActivity.serializer(), element)
                   )
               }
               "queued" -> {
                   payload.requireKeys(setOf("queued"))
                   AidenBotSessionEventPayload.Queued(
                       wire.decodeFromJsonElement(ListSerializer(AidenBotQueuedMessage.serializer()), payload.getValue("queued"))
                   )
               }
   ```
   Add `import kotlinx.serialization.builtins.ListSerializer` if the file lacks it.

- [ ] **Step 4: Chat activity on Bot detail and the identity patch**

In `android/.../models/AidenBot.kt`:

```kotlin
/** A Bot's Chat activity choice (spec §7, contract revision 30). */
@Serializable
enum class AidenBotChatActivityLevel {
    @SerialName("quiet") QUIET,
    @SerialName("summary") SUMMARY,
    @SerialName("detailed") DETAILED
}

@Serializable
enum class AidenBotChatActivityWording {
    @SerialName("follows") FOLLOWS,
    @SerialName("thinking") THINKING
}

@Serializable
data class AidenBotChatActivity(
    val level: AidenBotChatActivityLevel,
    val wording: AidenBotChatActivityWording
) {
    companion object {
        /** What a Bot that never chose shows: Quiet, Follows the work. */
        val DEFAULT = AidenBotChatActivity(AidenBotChatActivityLevel.QUIET, AidenBotChatActivityWording.FOLLOWS)
    }
}
```

- In `AidenBotDetail`, add `/** Revision 30 (`bot:activity`). */ val chatActivity: AidenBotChatActivity? = null,` after `visionModelSelection`.
- In `AidenBotIdentityPatch`:
  - Add `val chatActivity: AidenBotChatActivity? = null` as the last parameter.
  - Change its `init` emptiness check to `if (name == null && purpose == null && instructions == null && avatar == null && chatActivity == null)`.

- [ ] **Step 5: The opt-in, the host flags and the client**

1. `android/.../protocol/AidenRemoteProtocol.kt`:
   - Add `/** Contract revision 30: the status line, Steer and Queue, Queued bubbles and Chat activity. */ const val BOT_ACTIVITY_FEATURE = "bot-activity-v1"` below `BOT_PROACTIVE_FEATURE`.
   - In `AidenRemoteCapability`'s companion, below `BOT_CARDS`, add:
   ```kotlin
           /**
            * Contract revision 30: this phone receives the activity and queued session frames and
            * Bot detail `chatActivity`. It grants no authority.
            */
           val BOT_ACTIVITY = AidenRemoteCapability("bot:activity")
   ```
   - Below `PHONE_BOT_CARDS`, add `/** Negotiable behind `bot-activity-v1`. */ val PHONE_BOT_ACTIVITY = listOf(BOT_ACTIVITY)`.
   - Append `+ PHONE_BOT_ACTIVITY` to both `NEGOTIABLE` and `PHONE_KNOWN`.
2. `android/.../models/AidenInstallation.kt`, in `AidenServer`, below `offersBotCards`:
   ```kotlin
       /** The Mac offers `bot:activity` (revision 30), so this phone asks for it. */
       val offersBotActivity: Boolean
           get() = features.contains(AidenRemoteProtocol.BOT_ACTIVITY_FEATURE)

       /** Announced and held: show the status line, Steer and Queue, Queued bubbles and Chat activity. */
       val supportsBotActivity: Boolean
           get() = offersBotActivity && capabilities.contains(AidenRemoteCapability.BOT_ACTIVITY)
   ```
3. `android/.../features/remote/AidenRemoteCoordinator.kt`, after the `offersBotCards` block:
   ```kotlin
               // Contract revision 30: activity frames and Chat activity. Older Macs never announce it.
               if (server.offersBotActivity) {
                   for (capability in AidenRemoteCapability.PHONE_BOT_ACTIVITY) {
                       if (!installation.hasNegotiatedAccess(capability)) add(capability)
                   }
               }
   ```
4. `android/.../networking/AidenRemoteClient.kt`: change `sendBotMessage` to take `whenBusy: AidenStreamInputMode? = null` as its last parameter, and build the body with `AidenBotSessionSendRequest(text, whenBusy)`.

- [ ] **Step 6: The phase table, elapsed time, announcements and the glance**

Add to `android/app/src/main/res/values/strings.xml`, in the Bots section:

```xml
    <!-- Bot chat activity (contract revision 30): the status line's words, shared with the Mac and iOS (spec §5). -->
    <string name="bot_activity_preparing">Getting ready</string>
    <string name="bot_activity_thinking">Thinking</string>
    <string name="bot_activity_reading">Reading</string>
    <string name="bot_activity_photo">Looking at your photo</string>
    <string name="bot_activity_searching">Searching the web</string>
    <string name="bot_activity_command">Running a command</string>
    <string name="bot_activity_editing">Editing files</string>
    <string name="bot_activity_app">Using an app</string>
    <string name="bot_activity_app_named">Using %1$s</string>
    <string name="bot_activity_helper">Asking a helper</string>
    <string name="bot_activity_computer">Using your Mac</string>
    <string name="bot_activity_remembering">Remembering</string>
    <string name="bot_activity_routine">Setting up a routine</string>
    <string name="bot_activity_working">Working</string>
    <string name="bot_activity_writing">Writing</string>
    <string name="bot_activity_waiting">Waiting for you</string>
    <string name="bot_activity_tidying">Tidying up its notes</string>
    <string name="bot_activity_stopping">Stopping</string>
    <string name="bot_activity_resuming">Picking up where it left off</string>
    <string name="bot_activity_reconnecting">Reconnecting to your Mac</string>
    <string name="bot_activity_status_elapsed">%1$s · %2$s</string>
    <string name="bot_session_queued">Queued</string>
    <string name="bot_session_queued_hint">Sends when the current reply finishes</string>
```

Create `android/.../features/bots/AidenBotActivity.kt`:

```kotlin
package sbtbiswas.AidenOnTheGo.features.bots

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkProperty
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.spec
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording

/**
 * The status line's words and marks (spec §5), in §5's order. Kept in step with
 * `renderer/shared/bot-activity.ts` and iOS by the shared fixture's `botActivity.phases`.
 */
enum class AidenBotActivityPhase(val id: String, @StringRes val word: Int, val mark: AidenActivityMarkKind) {
    PREPARING("preparing", R.string.bot_activity_preparing, AidenActivityMarkKind.BOUNCE),
    THINKING("thinking", R.string.bot_activity_thinking, AidenActivityMarkKind.TRI_STEP),
    READING("reading", R.string.bot_activity_reading, AidenActivityMarkKind.SCAN_GRID),
    PHOTO("photo", R.string.bot_activity_photo, AidenActivityMarkKind.SCAN_GRID),
    SEARCHING("searching", R.string.bot_activity_searching, AidenActivityMarkKind.SCAN_GRID),
    COMMAND("command", R.string.bot_activity_command, AidenActivityMarkKind.QUAD_SHUFFLE),
    EDITING("editing", R.string.bot_activity_editing, AidenActivityMarkKind.QUAD_SHUFFLE),
    APP("app", R.string.bot_activity_app, AidenActivityMarkKind.QUAD_SHUFFLE),
    HELPER("helper", R.string.bot_activity_helper, AidenActivityMarkKind.QUAD_SHUFFLE),
    COMPUTER("computer", R.string.bot_activity_computer, AidenActivityMarkKind.QUAD_SHUFFLE),
    REMEMBERING("remembering", R.string.bot_activity_remembering, AidenActivityMarkKind.COMPOSE),
    ROUTINE("routine", R.string.bot_activity_routine, AidenActivityMarkKind.TRI_STEP),
    WORKING("working", R.string.bot_activity_working, AidenActivityMarkKind.QUAD_SHUFFLE),
    WRITING("writing", R.string.bot_activity_writing, AidenActivityMarkKind.COMPOSE),
    WAITING("waiting", R.string.bot_activity_waiting, AidenActivityMarkKind.GLANCE),
    TIDYING("tidying", R.string.bot_activity_tidying, AidenActivityMarkKind.BOUNCE),
    STOPPING("stopping", R.string.bot_activity_stopping, AidenActivityMarkKind.BOUNCE),
    RESUMING("resuming", R.string.bot_activity_resuming, AidenActivityMarkKind.BOUNCE),
    RECONNECTING("reconnecting", R.string.bot_activity_reconnecting, AidenActivityMarkKind.BOUNCE);

    companion object {
        private val byId = entries.associateBy { it.id }

        /** An id this build doesn't know reads as Working (§5.2). */
        fun of(id: String): AidenBotActivityPhase = byId[id] ?: WORKING
    }
}

/** These change what the person should do, so Always "Thinking" keeps them. */
private val KEEPS_ITS_WORD = setOf(AidenBotActivityPhase.WAITING, AidenBotActivityPhase.STOPPING, AidenBotActivityPhase.RECONNECTING)

/** What the line shows: a phase plus, for "Using {app}", the connection's label. */
data class AidenBotActivityDisplay(val phase: AidenBotActivityPhase, val app: String?) {
    val mark: AidenActivityMarkKind get() = phase.mark
}

fun aidenBotActivityDisplay(phase: String, wording: AidenBotChatActivityWording, app: String?): AidenBotActivityDisplay {
    val known = AidenBotActivityPhase.of(phase)
    val shown = if (wording == AidenBotChatActivityWording.THINKING && known !in KEEPS_ITS_WORD) AidenBotActivityPhase.THINKING else known
    return AidenBotActivityDisplay(shown, if (shown == AidenBotActivityPhase.APP) app?.takeIf { it.isNotBlank() } else null)
}

@Composable
fun AidenBotActivityDisplay.word(): String =
    if (app != null) stringResource(R.string.bot_activity_app_named, app) else stringResource(phase.word)

const val AIDEN_BOT_ELAPSED_AFTER_MS = 20_000L

/** "18s", "1m 12s", "2m", "1h 2m": the Mac's wording (a JVM-tested presentation helper, like `AidenTurnElapsed`). */
fun aidenBotDurationLabel(ms: Long): String {
    val seconds = maxOf(1L, ms / 1_000)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    val rest = seconds % 60
    if (minutes < 60) return if (rest > 0) "${minutes}m ${rest}s" else "${minutes}m"
    val hours = minutes / 60
    val remainder = minutes % 60
    return if (remainder > 0) "${hours}h ${remainder}m" else "${hours}h"
}

/** Nil before 20 seconds, and while this phone's clock reads behind the Mac's. */
fun aidenBotElapsedLabel(startedAt: Long, nowMs: Long): String? {
    val elapsed = nowMs - startedAt
    return if (elapsed >= AIDEN_BOT_ELAPSED_AFTER_MS) aidenBotDurationLabel(elapsed) else null
}

data class AidenBotAnnouncement(val text: String, val atMs: Long)

/** [shown] is what to announce now; [retryInMs] says when to offer the newest text again. */
data class AidenBotAnnouncementStep(val shown: AidenBotAnnouncement?, val retryInMs: Long?)

/** Screen readers hear a status change at most once every [gapMs] (§14). */
fun aidenBotNextAnnouncement(current: AidenBotAnnouncement?, text: String, nowMs: Long, gapMs: Long = 2_000): AidenBotAnnouncementStep {
    if (current != null && current.text == text) return AidenBotAnnouncementStep(current, null)
    if (current == null || nowMs - current.atMs >= gapMs) return AidenBotAnnouncementStep(AidenBotAnnouncement(text, nowMs), null)
    return AidenBotAnnouncementStep(current, gapMs - (nowMs - current.atMs))
}

/** The canonical face's glance (docs/activity-marks.md `glance`): [dxFraction] of the avatar's size; [blink] scales the eyes. */
data class AidenBotFaceGlance(val dxFraction: Float, val blink: Float)

private val GLANCE = AidenActivityMarkKind.GLANCE.spec()

fun aidenBotFaceGlance(timeMs: Long): AidenBotFaceGlance {
    val dx = GLANCE.groups[0].track(AidenActivityMarkProperty.TRANSLATE_X)?.valueAt(timeMs) ?: 0f
    val blink = GLANCE.shapes[0].track(AidenActivityMarkProperty.SCALE_Y)?.valueAt(timeMs) ?: 1f
    // The mark's view box is 24 wide.
    return AidenBotFaceGlance(dx / 24f, blink)
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain --tests 'sbtbiswas.AidenOnTheGo.AidenBotActivityContractTest' --tests 'sbtbiswas.AidenOnTheGo.AidenBotContractTest' --tests 'sbtbiswas.AidenOnTheGo.AidenBotRevision25ContractTest'`
Expected: PASS. The revision-25 round trips are unchanged, because null `activity`/`queued` are omitted.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenBotSession.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenBot.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/protocol/AidenRemoteProtocol.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenInstallation.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/remote/AidenRemoteCoordinator.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotActivity.kt android/app/src/main/res/values/strings.xml android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenBotActivityContractTest.kt
git commit -m "Android Bots: revision 30 activity wire, bot:activity opt-in, shared status words"
```

---

### Task 9: Android session controller: status line, Reconnecting, Queued and Steer/Queue

**Files:**
- Modify: `android/.../features/bots/AidenBotSessionController.kt`
- Test: `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionControllerTest.kt`

**Interfaces:**
- Consumes: Task 8's models, `aidenBotActivityDisplay` and `aidenBotElapsedLabel`.
- Produces:
  - `AidenBotSessionTransport.send(botId, text, key, whenBusy: AidenStreamInputMode? = null)`.
  - `AidenBotSessionUiState.activitySupported`, `wording` and `streamDown`, plus `val offersBusyModes`.
  - `data class AidenBotStatusLineState(display: AidenBotActivityDisplay, elapsed: String?)` and `fun aidenBotStatusLine(ui, nowMs): AidenBotStatusLineState?`.
  - `AidenBotSessionController(…, activitySupported: Boolean = false, …)`, with `setActivitySupported(Boolean)`, `setWording(AidenBotChatActivityWording)` and `suspend fun send(text, whenBusy = null)`.

- [ ] **Step 1: Write the failing tests**

In `AidenBotSessionControllerTest.kt`:

1. Change `FakeTransport`:
   - Replace `override fun events(botId: String): Flow<AidenBotSessionEvent> = emptyFlow()` with:
     ```kotlin
             /** Feeds the next `events` calls return, in order; then a feed that ends at once. */
             val feeds = ArrayDeque<Flow<AidenBotSessionEvent>>()
             override fun events(botId: String): Flow<AidenBotSessionEvent> = feeds.removeFirstOrNull() ?: emptyFlow()
     ```
   - Replace the `send` override with:
     ```kotlin
             val sendModes = mutableListOf<AidenStreamInputMode?>()
             override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?): AidenBotSessionSendResponse {
                 sends += text to key
                 sendModes += whenBusy
                 sendFailures.removeFirstOrNull()?.let { throw it }
                 return AidenBotSessionSendResponse("1", false, AidenBotSessionState.RUNNING, false)
             }
     ```
2. Add the imports `sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind` and `org.junit.Assert.assertNull`.
3. Append:

```kotlin
    // --- Revision 30: the status line, Reconnecting, Queued and Steer/Queue ---

    private val activitySession by lazy {
        json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botActivity").jsonObject.getValue("session"))
    }
    private val started = 1_760_450_000_000L

    private fun ui(
        session: AidenBotSession,
        supported: Boolean = true,
        wording: AidenBotChatActivityWording = AidenBotChatActivityWording.FOLLOWS
    ) = AidenBotSessionUiState(session = session, isLoading = false, activitySupported = supported, wording = wording)

    // Test 1
    @Test
    fun theLineShowsUntilTheReplyStreamsAndFollowsTheChosenWording() {
        val line = aidenBotStatusLine(ui(activitySession), started + 1_000)!!
        assertEquals(AidenBotActivityPhase.APP, line.display.phase)
        assertEquals("Notion", line.display.app)
        val thinking = AidenBotChatActivityWording.THINKING
        assertEquals(AidenBotActivityPhase.THINKING, aidenBotStatusLine(ui(activitySession, wording = thinking), started)!!.display.phase)
        val waiting = activitySession.copy(activity = AidenBotSessionActivity("waiting", null, started))
        assertEquals(AidenBotActivityPhase.WAITING, aidenBotStatusLine(ui(waiting, wording = thinking), started)!!.display.phase)
        assertNull("the reply's words are the signal", aidenBotStatusLine(ui(activitySession.copy(partial = "Here is")), started))
        assertNull(aidenBotStatusLine(ui(activitySession.copy(state = AidenBotSessionState.IDLE)), started))
    }

    // Test 2 (Review Focus 3)
    @Test
    fun anUnknownPhaseReadsAsWorkingAndElapsedShowsAfterTwentySeconds() {
        val browsing = activitySession.copy(activity = AidenBotSessionActivity("browsing", null, started))
        val early = aidenBotStatusLine(ui(browsing), started + 19_000)!!
        assertEquals(AidenBotActivityPhase.WORKING, early.display.phase)
        assertEquals(AidenActivityMarkKind.QUAD_SHUFFLE, early.display.mark)
        assertNull(early.elapsed)
        assertEquals("1m 12s", aidenBotStatusLine(ui(browsing), started + 72_000)!!.elapsed)
    }

    // Test 3
    @Test
    fun beforeTheFirstActivityFrameItSaysGettingReadyAndOlderMacsShowNothing() {
        assertEquals(
            AidenBotActivityPhase.PREPARING,
            aidenBotStatusLine(ui(activitySession.copy(activity = null)), started)!!.display.phase
        )
        assertNull(aidenBotStatusLine(ui(activitySession, supported = false), started))
        assertFalse(ui(activitySession, supported = false).offersBusyModes)
    }

    // Test 4 (Review Focus 2)
    @Test
    fun aDroppedFeedReadsReconnectingUntilTheNextFrame() = runTest {
        val transport = FakeTransport(activitySession)
        transport.feeds += flow { throw IOException("Wi-Fi dropped") }
        val reopened = activitySession.copy(
            epoch = "epoch_fixture_03",
            seq = 1,
            activity = AidenBotSessionActivity("searching", null, started)
        )
        transport.feeds += flow {
            emit(AidenBotSessionEvent(reopened.botId, reopened.epoch, reopened.seq, AidenBotSessionEventPayload.Snapshot(reopened)))
            awaitCancellation()
        }
        val controller = AidenBotSessionController(
            activitySession.botId, transport, backgroundScope, activitySupported = true, reconnectDelayMillis = 1_000
        )
        controller.start()
        runCurrent()
        assertTrue(controller.state.value.streamDown)
        assertEquals(AidenBotActivityPhase.RECONNECTING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)

        advanceTimeBy(1_001)
        runCurrent()
        assertFalse(controller.state.value.streamDown)
        assertEquals(AidenBotActivityPhase.SEARCHING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        controller.stopFollowing()
    }

    // Test 5
    @Test
    fun steerAndQueueGoOutOnlyWhileTheBotWorksOnAMacThatOffersThem() = runTest {
        val transport = FakeTransport(activitySession)
        val supported = AidenBotSessionController(activitySession.botId, transport, backgroundScope, activitySupported = true)
        supported.refetch()
        assertTrue(supported.state.value.offersBusyModes)
        assertTrue(supported.send("Keep it vegetarian.", AidenStreamInputMode.STEER))
        val older = AidenBotSessionController(activitySession.botId, transport, backgroundScope)
        older.refetch()
        assertTrue(older.send("Also a list.", AidenStreamInputMode.QUEUE))
        assertEquals("an older Mac would refuse whenBusy", listOf(AidenStreamInputMode.STEER, null), transport.sendModes)
    }

    // Test 6
    @Test
    fun queuedAndActivityFramesFoldIntoTheSessionInSeqOrder() {
        val waiting = listOf(AidenBotQueuedMessage("18", AidenStreamInputMode.QUEUE, "Also add a shopping list."))
        fun at(seq: Long, payload: AidenBotSessionEventPayload) =
            AidenBotSessionEvent(activitySession.botId, activitySession.epoch, seq, payload)
        val queued = aidenApplyBotSessionEvent(activitySession, at(activitySession.seq + 1, AidenBotSessionEventPayload.Queued(waiting)))
        val afterQueued = (queued as AidenBotSessionEventOutcome.Applied).session
        assertEquals(waiting, afterQueued.queued)
        val cleared = aidenApplyBotSessionEvent(afterQueued, at(afterQueued.seq + 1, AidenBotSessionEventPayload.Activity(null)))
        assertNull((cleared as AidenBotSessionEventOutcome.Applied).session.activity)
        val gap = aidenApplyBotSessionEvent(afterQueued, at(afterQueued.seq + 2, AidenBotSessionEventPayload.Activity(null)))
        assertEquals(AidenBotSessionEventOutcome.Refetch, gap)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain --tests 'sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionControllerTest'`
Expected: compilation FAILS. `aidenBotStatusLine`, `activitySupported` and the four-argument `send` are undefined.

- [ ] **Step 3: Implement**

In `AidenBotSessionController.kt`:

1. `AidenBotSessionTransport`: change `send` to `suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode? = null): AidenBotSessionSendResponse`. Change `AidenRemoteBotSessionTransport`'s override to `override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?) = client.sendBotMessage(botId, text, key, whenBusy)`.
2. In `aidenApplyBotSessionEvent`'s `when`, before `AidenBotSessionEventPayload.Closed ->`:
   ```kotlin
           is AidenBotSessionEventPayload.Activity ->
               AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, activity = payload.activity))
           is AidenBotSessionEventPayload.Queued ->
               AidenBotSessionEventOutcome.Applied(current.copy(seq = event.seq, queued = payload.queued))
   ```
3. `AidenBotSessionUiState`: add the fields
   ```kotlin
       /** Revision 30: the Mac announces `bot-activity-v1` and this phone holds `bot:activity`. */
       val activitySupported: Boolean = false,
       /** The Bot's Chat activity wording, from its detail. */
       val wording: AidenBotChatActivityWording = AidenBotChatActivityWording.FOLLOWS,
       /** The session feed dropped and is reconnecting. */
       val streamDown: Boolean = false
   ```
   and the property `/** Steer and Queue while the Bot works need `bot-activity-v1`. */ val offersBusyModes: Boolean get() = activitySupported && isRunning`.
4. Below `AidenBotSessionUiState`, add:

```kotlin
/** What the Bot chat's status line shows (spec §12). */
data class AidenBotStatusLineState(val display: AidenBotActivityDisplay, val elapsed: String?)

/** The status line now, or null when it is hidden. */
fun aidenBotStatusLine(ui: AidenBotSessionUiState, nowMs: Long): AidenBotStatusLineState? {
    if (!ui.activitySupported || !ui.isRunning) return null
    val session = ui.session ?: return null
    val activity = session.activity
    val elapsed = activity?.let { aidenBotElapsedLabel(it.startedAt, nowMs) }
    if (ui.streamDown) return AidenBotStatusLineState(aidenBotActivityDisplay("reconnecting", ui.wording, null), elapsed)
    // While the reply's words stream, the words are the signal (§5.2).
    if (!session.partial.isNullOrEmpty()) return null
    // Sent, and the first activity frame is on its way.
    if (activity == null) return AidenBotStatusLineState(aidenBotActivityDisplay("preparing", ui.wording, null), null)
    return AidenBotStatusLineState(aidenBotActivityDisplay(activity.phase, ui.wording, activity.app), elapsed)
}
```

5. `AidenBotSessionController`:
   - Add the constructor parameter `activitySupported: Boolean = false` after `knownState`.
   - Initialise the state with `AidenBotSessionUiState(knownState = knownState, activitySupported = activitySupported)`.
   - Add:
   ```kotlin
       fun setActivitySupported(supported: Boolean) {
           _state.update { it.copy(activitySupported = supported) }
       }

       fun setWording(wording: AidenBotChatActivityWording) {
           _state.update { it.copy(wording = wording) }
       }
   ```
6. In `follow()`:
   - Inside `collect { event -> … }`, add as the first line `if (_state.value.streamDown) _state.update { it.copy(streamDown = false) }`.
   - Directly before `delay(reconnectDelayMillis)`, add:
   ```kotlin
               // Closed or dropped: while a turn runs the line says "Reconnecting to your Mac".
               _state.update { it.copy(streamDown = true) }
   ```
7. In `send`:
   - Replace `private var pendingSendText: String? = null` with `private var pendingSend: Pair<String, AidenStreamInputMode?>? = null`.
   - Replace `send` with:

```kotlin
    /**
     * Sends [text]. Nothing is sent while the Bot needs an AI model or another send is in
     * flight. A failed send keeps its key, so retrying the same text cannot post twice. While
     * the Bot works on a Mac offering `bot-activity-v1`, [whenBusy] says Steer or Queue.
     */
    suspend fun send(text: String, whenBusy: AidenStreamInputMode? = null): Boolean {
        val trimmed = text.trim()
        val current = _state.value
        if (trimmed.isEmpty() || !current.canSend) return false
        val mode = if (current.offersBusyModes) whenBusy else null
        val pending = trimmed to mode
        if (pendingSend != pending) {
            keys.complete(SEND)
            pendingSend = pending
        }
        val key = keys.key(SEND)
        _state.update { it.copy(isSending = true, actionError = null) }
        return try {
            val receipt = transport.send(botId, trimmed, key, mode)
            keys.complete(SEND)
            pendingSend = null
            applyStateView(receipt.stateView)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(SEND, error)
            if (aidenBotMacAnswered(error)) pendingSend = null
            _state.update { it.copy(actionError = "Aiden couldn’t send that. Try again.") }
            false
        } finally {
            _state.update { it.copy(isSending = false) }
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command again.
Expected: PASS. That is the 6 new tests plus the existing 32.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionController.kt android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionControllerTest.kt
git commit -m "Android Bots: status line state, Reconnecting, queued messages and Steer/Queue in the session controller"
```

---

### Task 10: Android chat: the status line, the Steer/Queue split button, Queued bubbles and glancing faces

**Files:**
- Modify: `android/.../features/bots/AidenBotActivity.kt` (status line composable), `AidenBotSessionScreen.kt`, `AidenBotSemanticAvatarView.kt`, `AidenBotCanonicalAvatarView.kt`, `AidenBotsHomeScreen.kt`, `android/.../features/chat/AidenComposerView.kt`
- Test: none new. Task 8's glance test and Task 9's state tests cover the logic. The JVM suite has no Compose UI tests, so this task ends with an emulator capture.

**Interfaces:**
- Consumes: `aidenBotStatusLine`, `AidenBotStatusLineState`, `AidenBotActivityDisplay.word()`, `aidenBotNextAnnouncement` and `aidenBotFaceGlance` (Tasks 8–9). `AidenActivityMark`. `AidenRunInputSplitButton` (made `internal`).
- Produces:
  - `@Composable fun AidenBotStatusLine(ui: AidenBotSessionUiState)` and `@Composable fun AidenBotQueuedBubble(message)`.
  - The new parameters `AidenBotSemanticAvatarView(…, working: Boolean = false)` and `AidenBotCanonicalAvatarView(…, working: Boolean = false)`.

- [ ] **Step 1: Share the split button**

In `android/.../features/chat/AidenComposerView.kt`, change `private fun AidenRunInputSplitButton(` to `internal fun AidenRunInputSplitButton(`. Its option table stays private. No behaviour changes.

- [ ] **Step 2: The status line and the Queued bubble**

Append to `AidenBotActivity.kt`, with imports for `androidx.compose.animation.*`, `androidx.compose.foundation.layout.*`, `androidx.compose.material3.*`, `androidx.compose.runtime.*`, `androidx.compose.ui.Alignment`, `androidx.compose.ui.Modifier`, `androidx.compose.ui.semantics.*`, `androidx.compose.ui.unit.dp`, `kotlinx.coroutines.delay`, `sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMark`, `sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion`, `sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme`, `sbtbiswas.AidenOnTheGo.models.AidenBotQueuedMessage` and `sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode`:

```kotlin
/**
 * The status line while a Bot works (spec §12): a native activity mark and the shared word,
 * plus the elapsed time after 20 seconds. No steps and no Stop (Stop stays in the top bar).
 * The live region announces the word at most once every 2 seconds.
 */
@Composable
fun AidenBotStatusLine(ui: AidenBotSessionUiState) {
    val palette = AidenTheme.palette
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ui.isRunning) {
        while (ui.isRunning) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val line = aidenBotStatusLine(ui, now)
    var last by remember { mutableStateOf<AidenBotStatusLineState?>(null) }
    if (line != null) last = line
    AnimatedVisibility(
        visible = line != null,
        enter = fadeIn(AidenMotion.short()),
        exit = fadeOut(AidenMotion.short())
    ) {
        val shown = line ?: last ?: return@AnimatedVisibility
        val word = shown.display.word()
        var announced by remember { mutableStateOf<AidenBotAnnouncement?>(null) }
        LaunchedEffect(word) {
            val step = aidenBotNextAnnouncement(announced, word, System.currentTimeMillis())
            announced = step.shown
            step.retryInMs?.let {
                delay(it)
                announced = aidenBotNextAnnouncement(announced, word, System.currentTimeMillis()).shown
            }
        }
        val spoken = announced?.text ?: word
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp)
                .semantics {
                    liveRegion = LiveRegionMode.Polite
                    contentDescription = spoken
                }
        ) {
            AidenActivityMark(mark = shown.display.mark, size = 18.dp, color = palette.secondary)
            Text(
                text = shown.elapsed?.let { stringResource(R.string.bot_activity_status_elapsed, word, it) } ?: word,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary
            )
        }
    }
}

/** The person's waiting message: faded with "Queued", or a steer shown as a normal bubble. */
@Composable
fun AidenBotQueuedBubble(message: AidenBotQueuedMessage) {
    val palette = AidenTheme.palette
    val queued = message.mode == AidenStreamInputMode.QUEUE
    val hint = stringResource(R.string.bot_session_queued_hint)
    Column(
        horizontalAlignment = Alignment.End,
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { if (queued) stateDescription = hint }
    ) {
        Surface(
            color = palette.accent.copy(alpha = if (queued) 0.45f else 1f),
            shape = RoundedCornerShape(20.dp, 20.dp, 4.dp, 20.dp),
            modifier = Modifier.widthIn(max = 320.dp)
        ) {
            Text(
                message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)
            )
        }
        if (queued) {
            Text(
                stringResource(R.string.bot_session_queued),
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary,
                modifier = Modifier.padding(top = 2.dp, end = 4.dp)
            )
        }
    }
}
```

Also import `androidx.compose.foundation.shape.RoundedCornerShape` and `androidx.compose.ui.res.stringResource`.

- [ ] **Step 3: Wire the session screen**

In `AidenBotSessionScreen.kt`:

1. Build the controller with `AidenBotSessionController(botId, AidenRemoteBotSessionTransport(cl), scope, knownState, activitySupported = serverInfo?.supportsBotActivity == true)`.
2. After `val ui by controller.state.collectAsStateWithLifecycle()`, add:

```kotlin
    val activitySupported = serverInfo?.supportsBotActivity == true
    LaunchedEffect(controller, activitySupported) { controller.setActivitySupported(activitySupported) }
    // The wording comes from the Bot's detail: cached first, then the Mac's.
    LaunchedEffect(controller) {
        coordinator.botCache.getBotDetail(botId)?.let {
            controller.setWording(it.chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS)
        }
        try {
            val detail = cl.bot(botId)
            coordinator.botCache.putBotDetail(detail)
            controller.setWording(detail.chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the cached or default wording; the line still works.
        }
    }
    var busyMode by remember(botId) { mutableStateOf(AidenStreamInputMode.QUEUE) }
    LaunchedEffect(ui.isRunning) { if (!ui.isRunning) busyMode = AidenStreamInputMode.QUEUE }
```

3. In the `LazyColumn`, after the `partial` item, add:

```kotlin
                ui.session?.queued.orEmpty().forEach { message ->
                    item(key = "queued-${message.submissionId}") { AidenBotQueuedBubble(message) }
                }
                item(key = "status") { AidenBotStatusLine(ui) }
```

   Change the auto-scroll effect's keys to `LaunchedEffect(entries.size, partial, ui.isInterrupted, ui.needsModel, ui.session?.queued?.size, ui.session?.activity?.phase)`.
4. In `advancedBot?.let { bot -> AidenBotAdvancedSheet(…) }`, pass the two new Task 11 parameters: `chatActivityAvailable = activitySupported` and `onChatActivitySaved = { saved -> coordinator.botCache.putBotDetail(saved); controller.setWording(saved.chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS) }`. Add this line in Task 11, once the parameters exist.
5. Replace the `AidenBotSessionComposer(…)` call and the composable:

```kotlin
            AidenBotSessionComposer(
                draft = draft,
                onDraftChange = { draft = it.take(AidenBotSessionWire.MAX_MESSAGE_LENGTH) },
                placeholder = aidenBotChatPlaceholder(identity.name),
                enabled = ui.canSend,
                busy = ui.offersBusyModes,
                busyMode = busyMode,
                onPickBusyMode = { busyMode = it },
                onSend = {
                    val text = draft
                    val mode = if (ui.offersBusyModes) busyMode else null
                    scope.launch {
                        if (controller.send(text, mode)) draft = ""
                    }
                }
            )
```

```kotlin
@Composable
private fun AidenBotSessionComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    busy: Boolean,
    busyMode: AidenStreamInputMode,
    onPickBusyMode: (AidenStreamInputMode) -> Unit,
    onSend: () -> Unit
) {
    val palette = AidenTheme.palette
    Row(
        verticalAlignment = Alignment.Bottom,
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag(AidenBotSessionTags.COMPOSER)
    ) {
        TextField(
            value = draft,
            onValueChange = onDraftChange,
            enabled = enabled,
            placeholder = { Text(placeholder) },
            colors = aidenTextFieldColors(),
            shape = RoundedCornerShape(AidenUi.ComposerRadius),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            maxLines = 6,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(8.dp))
        if (busy) {
            // While the Bot works: Steer joins the reply, Queue sends after it (desktop and iOS parity).
            AidenRunInputSplitButton(
                mode = busyMode,
                canSubmit = enabled && draft.isNotBlank(),
                canChooseMode = enabled,
                onSubmit = onSend,
                onPickMode = onPickBusyMode
            )
        } else {
            FilledIconButton(
                onClick = onSend,
                enabled = enabled && draft.isNotBlank(),
                shape = AidenShape.Button,
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = palette.accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                modifier = Modifier.size(AidenUi.MinimumTouchTarget)
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.bot_session_send))
            }
        }
    }
}
```

Add the import `sbtbiswas.AidenOnTheGo.features.chat.AidenRunInputSplitButton`.

- [ ] **Step 4: Glancing faces**

1. `AidenBotSemanticAvatarView.kt`:
   - Add the parameter `working: Boolean = false` after `size`.
   - Add the imports `androidx.compose.runtime.LaunchedEffect`, `mutableLongStateOf`, `remember`, `withFrameMillis` and `sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion`.
   - Before the `Box`, add:
   ```kotlin
       // While its Bot works the canonical face glances; Reduce Motion holds the still pose.
       val glancing = working && !aidenReduceMotion()
       val clockMs = remember { mutableLongStateOf(0L) }
       LaunchedEffect(glancing) {
           if (!glancing) {
               clockMs.longValue = 0L
               return@LaunchedEffect
           }
           var startMs = Long.MIN_VALUE
           while (true) {
               withFrameMillis { frameMs ->
                   if (startMs == Long.MIN_VALUE) startMs = frameMs
                   clockMs.longValue = frameMs - startMs
               }
           }
       }
   ```
   - Replace the eye-drawing block inside `Canvas` with the following. The clock is read only in the draw phase, as in `AidenActivityMark`.
   ```kotlin
               // The one fixed eye mark: two slanted pills in the shared face colour.
               val glance = if (glancing) aidenBotFaceGlance(clockMs.longValue) else AidenBotFaceGlance(0f, 1f)
               val eyeWidth = w * 0.11f
               val eyeHeight = h * 0.24f
               val eyeTop = h * 0.42f
               val shownHeight = eyeHeight * glance.blink
               listOf(w * 0.40f, w * 0.58f).forEach { base ->
                   val left = base + glance.dxFraction * w
                   rotate(degrees = 12f, pivot = Offset(left + eyeWidth / 2f, eyeTop + eyeHeight / 2f)) {
                       drawRoundRect(
                           color = AidenBotAvatarColors.face,
                           topLeft = Offset(left, eyeTop + (eyeHeight - shownHeight) / 2f),
                           size = Size(eyeWidth, shownHeight),
                           cornerRadius = CornerRadius(eyeWidth / 2f, minOf(eyeWidth, shownHeight) / 2f)
                       )
                   }
               }
   ```
2. `AidenBotCanonicalAvatarView.kt`:
   - Add `working: Boolean = false` to `AidenBotCanonicalAvatarView` and to `AidenBotAvatarLayer`, and pass it through both call sites.
   - In `AidenBotAvatarLayer`'s `else` branch, pass `working = working` to `AidenBotSemanticAvatarView`.
   - In its `if (bitmap != null)` branch, wrap the `Image` in a `Box(Modifier.size(size))` and add after it:
   ```kotlin
               // A photo can't glance; a small glance mark says the Bot is working.
               if (working) {
                   Box(
                       Modifier
                           .align(Alignment.BottomEnd)
                           .size(size * 0.38f)
                           .clip(CircleShape)
                           .background(AidenTheme.palette.canvas),
                       contentAlignment = Alignment.Center
                   ) {
                       AidenActivityMark(mark = AidenActivityMarkKind.GLANCE, size = size * 0.3f, color = AidenTheme.palette.foreground)
                   }
               }
   ```
3. `AidenBotsHomeScreen.kt`:
   - Pass `working = row.isWorking` to `AidenBotCanonicalAvatarView`.
   - Delete the `if (row.isWorking) { Box(… palette.success …) }` green dot.
   - Move its `.semantics { contentDescription = workingLabel }` onto the avatar `Box`, as `Modifier.semantics { if (row.isWorking) stateDescription = workingLabel }`.

- [ ] **Step 5: Build, test and look at it**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain`
Expected: PASS (the full JVM suite).

Install the debug build on a headless AVD (not the owner's phone), paired with a Mac on this branch. Check:
1. The status line walks through the phases.
2. While the Bot works, the composer shows the Queue/Steer split button. A queued message shows faded with "Queued".
3. In Bots home, a working Bot's face glances.
4. With *Remove animations* on, the face and mark hold still.

Capture light and dark screenshots.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotActivity.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionScreen.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSemanticAvatarView.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotCanonicalAvatarView.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotsHomeScreen.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/chat/AidenComposerView.kt
git commit -m "Android Bots: status line, Steer/Queue split button, Queued bubbles and glancing faces"
```

---

### Task 11: Android Advanced → Chat activity

**Files:**
- Create: `android/.../features/bots/AidenBotChatActivityScreen.kt`
- Modify: `android/.../features/bots/AidenBotAdvancedScreen.kt`, `AidenBotSessionScreen.kt`, `AidenBotProfileScreen.kt`, `android/app/src/main/res/values/strings.xml`
- Test: create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotChatActivityTest.kt`

**Interfaces:**
- Consumes: `AidenBotChatActivity*`, `AidenBotIdentityPatch(chatActivity =)` and `AidenRemoteClient.updateBotIdentity` (Task 8). `aidenBotActivityDisplay` (Task 8).
- Produces:
  - `object AidenBotChatActivityPreview { FRAME_MILLIS; STILL_FRAME; frameIndex(elapsedMs); frame(index, level) }` and `data class AidenBotChatActivityPreviewFrame`.
  - `data class AidenBotChatActivityUiState` and `class AidenBotChatActivityController(bot, save, onSaved) { state; suspend fun pick(next); fun dismissError() }`.
  - The `@StringRes` extensions `label` and `detail` on the level and wording enums.
  - `@Composable fun AidenBotChatActivityDialog(bot, client, onDismiss, onSaved)`.
  - `AidenBotAdvancedSheet(…, chatActivityAvailable: Boolean = false, onChatActivitySaved: (AidenBotDetail) -> Unit = {})`.

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotChatActivityTest.kt`:

```kotlin
package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.*
import java.io.IOException

class AidenBotChatActivityTest {
    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val bot by lazy { json.decodeFromJsonElement(AidenBotDetail.serializer(), fixture.getValue("botDetail")) }
    private val summaryFollows = AidenBotChatActivity(AidenBotChatActivityLevel.SUMMARY, AidenBotChatActivityWording.FOLLOWS)
    private val summaryThinking = AidenBotChatActivity(AidenBotChatActivityLevel.SUMMARY, AidenBotChatActivityWording.THINKING)

    // Test 1
    @Test
    fun aPickSavesAtOnceWithTheBotsRevisionAndTheNextPickUsesTheNewOne() = runTest {
        val revisions = mutableListOf<String>()
        val saved = mutableListOf<String>()
        val controller = AidenBotChatActivityController(
            bot.copy(revision = "rev_1"),
            save = { next, revision ->
                revisions += revision
                bot.copy(revision = if (revision == "rev_1") "rev_2" else "rev_3", chatActivity = next)
            },
            onSaved = { saved += it.revision }
        )
        assertEquals(AidenBotChatActivity.DEFAULT, controller.state.value.value)
        controller.pick(summaryFollows)
        controller.pick(summaryThinking)
        assertEquals(listOf("rev_1", "rev_2"), revisions)
        assertEquals(summaryThinking, controller.state.value.value)
        assertEquals(listOf("rev_2", "rev_3"), saved)
        controller.pick(summaryThinking)
        assertEquals("the current choice sends nothing", 2, revisions.size)
    }

    // Test 2 (Review Focus 5)
    @Test
    fun aFailedSaveReturnsToTheSavedChoiceAndSaysSo() = runTest {
        val revisions = mutableListOf<String>()
        var fail = true
        val controller = AidenBotChatActivityController(
            bot.copy(revision = "rev_1", chatActivity = AidenBotChatActivity.DEFAULT),
            save = { next, revision ->
                revisions += revision
                if (fail) throw IOException("offline")
                bot.copy(revision = "rev_2", chatActivity = next)
            }
        )
        val detailed = AidenBotChatActivity(AidenBotChatActivityLevel.DETAILED, AidenBotChatActivityWording.FOLLOWS)
        controller.pick(detailed)
        assertEquals(AidenBotChatActivity.DEFAULT, controller.state.value.value)
        assertTrue(controller.state.value.saveFailed)
        assertFalse(controller.state.value.isSaving)

        fail = false
        controller.pick(detailed)
        assertEquals("a failed save leaves the revision where it was", listOf("rev_1", "rev_1"), revisions)
        assertEquals(detailed, controller.state.value.value)
        assertFalse(controller.state.value.saveFailed)
    }

    // Test 3
    @Test
    fun previewsShowWhatEachLevelLooksLikeOnTheMac() {
        val reply = AidenBotChatActivityPreview.FRAME_MILLIS.size - 1
        assertEquals("reading", AidenBotChatActivityPreview.frame(1, AidenBotChatActivityLevel.QUIET).phase)
        assertEquals(emptyList<Int>(), AidenBotChatActivityPreview.frame(1, AidenBotChatActivityLevel.QUIET).steps)
        assertEquals(
            listOf(R.string.bot_chat_activity_preview_step_read, R.string.bot_chat_activity_preview_step_search),
            AidenBotChatActivityPreview.frame(2, AidenBotChatActivityLevel.DETAILED).steps
        )
        assertFalse(AidenBotChatActivityPreview.frame(reply, AidenBotChatActivityLevel.QUIET).recapShown)
        val summary = AidenBotChatActivityPreview.frame(reply, AidenBotChatActivityLevel.SUMMARY)
        assertTrue(summary.recapShown)
        assertFalse(summary.recapOpen)
        val detailed = AidenBotChatActivityPreview.frame(reply, AidenBotChatActivityLevel.DETAILED)
        assertTrue(detailed.recapOpen)
        assertEquals(3, detailed.steps.size)
        assertNull("the reply has landed", detailed.phase)

        assertEquals(0, AidenBotChatActivityPreview.frameIndex(0))
        assertEquals(1, AidenBotChatActivityPreview.frameIndex(1_500))
        assertEquals(reply, AidenBotChatActivityPreview.frameIndex(6_500))
        assertEquals("the turn loops", 0, AidenBotChatActivityPreview.frameIndex(8_800))
        assertTrue(
            "Reduce Motion's still frame shows the line mid-turn",
            AidenBotChatActivityPreview.frame(AidenBotChatActivityPreview.STILL_FRAME, AidenBotChatActivityLevel.QUIET).phase != null
        )
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain --tests 'sbtbiswas.AidenOnTheGo.features.bots.AidenBotChatActivityTest'`
Expected: compilation FAILS. `AidenBotChatActivityController` and `AidenBotChatActivityPreview` are undefined.

- [ ] **Step 3: Strings**

Add to `strings.xml`, below the Task 8 activity strings:

```xml
    <!-- Advanced → Chat activity (spec §7). -->
    <string name="bot_chat_activity_title">Chat activity</string>
    <string name="bot_chat_activity_description">What you see in %1$s’s chat on your Mac while it works. Changes save as you pick them.</string>
    <string name="bot_chat_activity_level_title">How much to show</string>
    <string name="bot_chat_activity_wording_title">What the status line says</string>
    <string name="bot_chat_activity_phones_title">On iPhone and Android</string>
    <string name="bot_chat_activity_phones_description">Always just the line, with the same words.</string>
    <string name="bot_chat_activity_recommended">Recommended</string>
    <string name="bot_chat_activity_level_quiet">Quiet</string>
    <string name="bot_chat_activity_level_quiet_detail">One line that says what it’s doing.</string>
    <string name="bot_chat_activity_level_summary">Summary</string>
    <string name="bot_chat_activity_level_summary_detail">Adds a short recap above each reply.</string>
    <string name="bot_chat_activity_level_detailed">Detailed</string>
    <string name="bot_chat_activity_level_detailed_detail">Also shows its last few steps while it works.</string>
    <string name="bot_chat_activity_wording_follows">Follows the work</string>
    <string name="bot_chat_activity_wording_follows_detail">Says what it’s doing, like Reading or Searching the web.</string>
    <string name="bot_chat_activity_wording_thinking">Always “Thinking”</string>
    <string name="bot_chat_activity_wording_thinking_detail">One calm word, whatever it’s doing.</string>
    <string name="bot_chat_activity_value">%1$s · %2$s</string>
    <string name="bot_chat_activity_save_failed">Aiden couldn’t save that choice.</string>
    <string name="bot_chat_activity_preview">Preview</string>
    <string name="bot_chat_activity_preview_prompt">Plan dinners for this week</string>
    <string name="bot_chat_activity_preview_reply">Here’s a plan for the week.</string>
    <string name="bot_chat_activity_preview_recap">Worked for 18s · read 1 file, searched the web, edited 1 file</string>
    <string name="bot_chat_activity_preview_step_read">Read 1 file</string>
    <string name="bot_chat_activity_preview_step_search">Searched the web</string>
    <string name="bot_chat_activity_preview_step_edit">Edited 1 file</string>
```

- [ ] **Step 4: The controller, previews and page**

Create `android/.../features/bots/AidenBotChatActivityScreen.kt`:

```kotlin
package sbtbiswas.AidenOnTheGo.features.bots

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMark
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

@get:StringRes
val AidenBotChatActivityLevel.label: Int
    get() = when (this) {
        AidenBotChatActivityLevel.QUIET -> R.string.bot_chat_activity_level_quiet
        AidenBotChatActivityLevel.SUMMARY -> R.string.bot_chat_activity_level_summary
        AidenBotChatActivityLevel.DETAILED -> R.string.bot_chat_activity_level_detailed
    }

@get:StringRes
val AidenBotChatActivityLevel.detail: Int
    get() = when (this) {
        AidenBotChatActivityLevel.QUIET -> R.string.bot_chat_activity_level_quiet_detail
        AidenBotChatActivityLevel.SUMMARY -> R.string.bot_chat_activity_level_summary_detail
        AidenBotChatActivityLevel.DETAILED -> R.string.bot_chat_activity_level_detailed_detail
    }

@get:StringRes
val AidenBotChatActivityWording.label: Int
    get() = when (this) {
        AidenBotChatActivityWording.FOLLOWS -> R.string.bot_chat_activity_wording_follows
        AidenBotChatActivityWording.THINKING -> R.string.bot_chat_activity_wording_thinking
    }

@get:StringRes
val AidenBotChatActivityWording.detail: Int
    get() = when (this) {
        AidenBotChatActivityWording.FOLLOWS -> R.string.bot_chat_activity_wording_follows_detail
        AidenBotChatActivityWording.THINKING -> R.string.bot_chat_activity_wording_thinking_detail
    }

/** Advanced's trailing value: "Quiet · Follows the work". */
@Composable
fun aidenBotChatActivitySummary(value: AidenBotChatActivity?): String {
    val resolved = value ?: AidenBotChatActivity.DEFAULT
    return stringResource(R.string.bot_chat_activity_value, stringResource(resolved.level.label), stringResource(resolved.wording.label))
}

/** One frame of the scripted turn, as a level shows it on the Mac. */
data class AidenBotChatActivityPreviewFrame(
    /** The line's phase, or null on the reply frame. */
    val phase: String?,
    @StringRes val steps: List<Int>,
    val recapShown: Boolean,
    val recapOpen: Boolean
)

/** Think, read, search, edit, reply: the desktop page's script. */
object AidenBotChatActivityPreview {
    val FRAME_MILLIS = longArrayOf(1_400, 1_600, 1_600, 1_400, 2_800)
    /** Reduce Motion's still frame: mid-turn, with the line showing. */
    const val STILL_FRAME = 2
    private val PHASES = listOf("thinking", "reading", "searching", "editing", null)
    private val STEPS = listOf(
        R.string.bot_chat_activity_preview_step_read,
        R.string.bot_chat_activity_preview_step_search,
        R.string.bot_chat_activity_preview_step_edit
    )

    fun frameIndex(elapsedMs: Long): Int {
        val total = FRAME_MILLIS.sum()
        var time = ((elapsedMs % total) + total) % total
        FRAME_MILLIS.forEachIndexed { index, duration ->
            if (time < duration) return index
            time -= duration
        }
        return FRAME_MILLIS.size - 1
    }

    fun frame(index: Int, level: AidenBotChatActivityLevel): AidenBotChatActivityPreviewFrame {
        val clamped = index.coerceIn(0, PHASES.size - 1)
        val phase = PHASES[clamped]
        if (phase != null) {
            return AidenBotChatActivityPreviewFrame(
                phase,
                if (level == AidenBotChatActivityLevel.DETAILED) STEPS.take(clamped) else emptyList(),
                recapShown = false,
                recapOpen = false
            )
        }
        return when (level) {
            AidenBotChatActivityLevel.QUIET -> AidenBotChatActivityPreviewFrame(null, emptyList(), recapShown = false, recapOpen = false)
            AidenBotChatActivityLevel.SUMMARY -> AidenBotChatActivityPreviewFrame(null, emptyList(), recapShown = true, recapOpen = false)
            AidenBotChatActivityLevel.DETAILED -> AidenBotChatActivityPreviewFrame(null, STEPS, recapShown = true, recapOpen = true)
        }
    }
}

data class AidenBotChatActivityUiState(
    val value: AidenBotChatActivity,
    val revision: String,
    val isSaving: Boolean = false,
    val saveFailed: Boolean = false
)

/** Saves each pick at once (no Save button). A failed save returns to the saved choice. */
class AidenBotChatActivityController(
    bot: AidenBotDetail,
    private val save: suspend (AidenBotChatActivity, String) -> AidenBotDetail,
    private val onSaved: (AidenBotDetail) -> Unit = {}
) {
    private val _state = MutableStateFlow(AidenBotChatActivityUiState(bot.chatActivity ?: AidenBotChatActivity.DEFAULT, bot.revision))
    val state: StateFlow<AidenBotChatActivityUiState> = _state.asStateFlow()

    suspend fun pick(next: AidenBotChatActivity) {
        val current = _state.value
        if (next == current.value || current.isSaving) return
        _state.value = current.copy(value = next, isSaving = true, saveFailed = false)
        try {
            val saved = save(next, current.revision)
            _state.value = AidenBotChatActivityUiState(saved.chatActivity ?: next, saved.revision)
            onSaved(saved)
        } catch (error: CancellationException) {
            _state.value = current
            throw error
        } catch (_: Exception) {
            _state.value = current.copy(saveFailed = true)
        }
    }

    fun dismissError() {
        _state.update { it.copy(saveFailed = false) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotChatActivityDialog(
    bot: AidenBotDetail,
    client: AidenRemoteClient?,
    onDismiss: () -> Unit,
    onSaved: (AidenBotDetail) -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val controller = remember(bot.id, client) {
        AidenBotChatActivityController(
            bot,
            save = { next, revision ->
                val cl = client ?: throw IllegalStateException("Not connected")
                cl.updateBotIdentity(bot.id, revision, AidenBotIdentityPatch(chatActivity = next))
            },
            onSaved = onSaved
        )
    }
    val state by controller.state.collectAsState()

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            containerColor = palette.canvas,
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.bot_chat_activity_title), fontWeight = FontWeight.SemiBold) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .aidenReadableWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AidenUi.SectionGap)
            ) {
                Text(stringResource(R.string.bot_chat_activity_description, bot.name), color = palette.secondary, style = MaterialTheme.typography.bodyMedium)
                AidenBotChatActivityGroup(stringResource(R.string.bot_chat_activity_level_title)) {
                    val levels = AidenBotChatActivityLevel.entries
                    levels.forEachIndexed { index, level ->
                        AidenBotChatActivityChoice(
                            index = index,
                            count = levels.size,
                            title = stringResource(level.label),
                            detail = stringResource(level.detail),
                            recommended = level == AidenBotChatActivityLevel.QUIET,
                            selected = state.value.level == level,
                            enabled = !state.isSaving,
                            onPick = { scope.launch { controller.pick(state.value.copy(level = level)) } }
                        ) { AidenBotChatActivityPreviewCard(level = level, wording = state.value.wording) }
                    }
                }
                AidenBotChatActivityGroup(stringResource(R.string.bot_chat_activity_wording_title)) {
                    val wordings = AidenBotChatActivityWording.entries
                    wordings.forEachIndexed { index, wording ->
                        AidenBotChatActivityChoice(
                            index = index,
                            count = wordings.size,
                            title = stringResource(wording.label),
                            detail = stringResource(wording.detail),
                            recommended = false,
                            selected = state.value.wording == wording,
                            enabled = !state.isSaving,
                            onPick = { scope.launch { controller.pick(state.value.copy(wording = wording)) } }
                        ) { AidenBotChatActivityPreviewCard(level = AidenBotChatActivityLevel.QUIET, wording = wording) }
                    }
                }
                AidenBotChatActivityGroup(stringResource(R.string.bot_chat_activity_phones_title)) {
                    Text(stringResource(R.string.bot_chat_activity_phones_description), color = palette.secondary, style = MaterialTheme.typography.bodySmall)
                    AidenBotChatActivityPreviewCard(level = AidenBotChatActivityLevel.QUIET, wording = state.value.wording)
                }
                if (state.saveFailed) {
                    Text(stringResource(R.string.bot_chat_activity_save_failed), color = palette.danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun AidenBotChatActivityGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        AidenConnectedColumn(content = content)
    }
}

/** A radio row: the radio and the tonal fill show the choice; there is no border. */
@Composable
private fun AidenBotChatActivityChoice(
    index: Int,
    count: Int,
    title: String,
    detail: String,
    recommended: Boolean,
    selected: Boolean,
    enabled: Boolean,
    onPick: () -> Unit,
    preview: @Composable () -> Unit
) {
    val palette = AidenTheme.palette
    AidenGroupCard(
        index = index,
        count = count,
        selected = selected,
        role = Role.RadioButton,
        enabled = enabled,
        onClick = onPick,
        verticalAlignment = Alignment.Top
    ) {
        RadioButton(selected = selected, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = palette.accent))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, color = palette.foreground, style = MaterialTheme.typography.bodyLarge)
                if (recommended) {
                    Text(stringResource(R.string.bot_chat_activity_recommended), color = palette.secondary, style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(detail, color = palette.secondary, style = MaterialTheme.typography.bodySmall)
            preview()
        }
    }
}

/** A small chat replaying one scripted turn; it holds its still frame under Reduce Motion. */
@Composable
fun AidenBotChatActivityPreviewCard(level: AidenBotChatActivityLevel, wording: AidenBotChatActivityWording) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    var index by remember { mutableIntStateOf(AidenBotChatActivityPreview.STILL_FRAME) }
    LaunchedEffect(reduceMotion) {
        if (reduceMotion) {
            index = AidenBotChatActivityPreview.STILL_FRAME
            return@LaunchedEffect
        }
        val start = System.currentTimeMillis()
        while (true) {
            index = AidenBotChatActivityPreview.frameIndex(System.currentTimeMillis() - start)
            delay(200)
        }
    }
    val frame = AidenBotChatActivityPreview.frame(index, level)
    val previewLabel = stringResource(R.string.bot_chat_activity_preview)
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(10.dp)
            .clearAndSetSemantics { contentDescription = previewLabel }
    ) {
        Text(
            stringResource(R.string.bot_chat_activity_preview_prompt),
            style = MaterialTheme.typography.labelMedium,
            color = palette.foreground,
            modifier = Modifier
                .align(Alignment.End)
                .clip(MaterialTheme.shapes.small)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(horizontal = 10.dp, vertical = 6.dp)
        )
        if (frame.recapShown) {
            Text(
                (if (frame.recapOpen) "▾ " else "▸ ") + stringResource(R.string.bot_chat_activity_preview_recap),
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary
            )
        }
        frame.steps.forEach { step ->
            Text(stringResource(step), style = MaterialTheme.typography.labelSmall, color = palette.secondary, modifier = Modifier.padding(start = 14.dp))
        }
        val phase = frame.phase
        if (phase != null) {
            val shown = aidenBotActivityDisplay(phase, wording, null)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AidenActivityMark(mark = shown.mark, size = 14.dp, active = !reduceMotion, color = palette.secondary)
                Text(shown.word(), style = MaterialTheme.typography.labelMedium, color = palette.secondary)
            }
        } else {
            Text(stringResource(R.string.bot_chat_activity_preview_reply), style = MaterialTheme.typography.labelMedium, color = palette.foreground)
        }
    }
}
```

- [ ] **Step 5: The Advanced row and its callers**

In `AidenBotAdvancedScreen.kt`'s `AidenBotAdvancedSheet`:
1. Add the parameters `chatActivityAvailable: Boolean = false` and `onChatActivitySaved: (AidenBotDetail) -> Unit = {}` after `onSaved`.
2. Add the state:
   ```kotlin
       // A Chat activity save moves the Bot's revision; Advanced's own Save uses the newest.
       var latestBot by remember(bot.id) { mutableStateOf(bot) }
       var showingChatActivity by remember { mutableStateOf(false) }
   ```
   Change the Save action's call to `aidenBotSaveAdvanced(cl, latestBot, current, cat)`.
3. After the Access `AidenBotAdvancedSection { … }`, inside the `else ->` branch, add:
   ```kotlin
                           if (chatActivityAvailable) {
                               AidenBotAdvancedSection(title = stringResource(R.string.bot_chat_activity_title)) {
                                   AidenConnectedColumn {
                                       AidenGroupCard(index = 0, count = 1, onClick = { showingChatActivity = true }) {
                                           Text(stringResource(R.string.bot_chat_activity_title), color = palette.foreground, modifier = Modifier.weight(1f))
                                           Text(aidenBotChatActivitySummary(latestBot.chatActivity), color = palette.secondary, style = MaterialTheme.typography.bodyMedium)
                                       }
                                   }
                               }
                           }
   ```
4. After the `Dialog { … }` block, still inside `AidenBotAdvancedSheet`, add:
   ```kotlin
       if (showingChatActivity) {
           AidenBotChatActivityDialog(
               bot = latestBot,
               client = client,
               onDismiss = { showingChatActivity = false },
               onSaved = { saved ->
                   latestBot = saved
                   onChatActivitySaved(saved)
               }
           )
       }
   ```
5. `AidenBotSessionScreen.kt`: pass `chatActivityAvailable = activitySupported` and `onChatActivitySaved = { saved -> coordinator.botCache.putBotDetail(saved); controller.setWording(saved.chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS) }` (the line Task 10 Step 3.4 deferred).
6. `AidenBotProfileScreen.kt`: pass `chatActivityAvailable = serverInfo?.supportsBotActivity == true` and `onChatActivitySaved = { saved -> accept(saved) }`.

- [ ] **Step 6: Run the tests and look at it**

Run: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain`
Expected: PASS (the full suite, including the 3 new tests).

On the headless AVD, check:
1. Advanced shows "Chat activity  Quiet · Follows the work".
2. Picking Summary saves at once, and the Mac's next reply shows the recap.
3. Previews loop, and hold their still frame with *Remove animations* on.
4. Against a revision-29 Mac the row is absent.

Capture light and dark screenshots.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotChatActivityScreen.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotAdvancedScreen.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotSessionScreen.kt android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotProfileScreen.kt android/app/src/main/res/values/strings.xml android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotChatActivityTest.kt
git commit -m "Android Bots: Advanced → Chat activity with looping previews, saved on pick"
```

---

### Task 12: Docs, memory and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` (§11, §12, §17), `docs/plans/README.md`, `.memory/bot-chat-activity.md` (created by slice B), `.memory/bots-rework-ui.md`

- [ ] **Step 1: Record the rulings in the spec**

In §11, after the "Saving the setting" bullet, add:

```markdown
- **Device opt-in (plan ruling).** Older phones' decoders refuse unknown session keys and event types, so the token alone can't gate what the host sends. A device negotiates `bot:activity` (no authority, any device type, offered only while `bot-activity-v1` is announced), like revision 27's `bot:cards`. Holders receive `activity` and `queued` (snapshot keys and frames) and Bot detail `chatActivity`. Other devices get a no-op `state` frame at those seqs.
- **Queued (plan ruling).** A `queued` frame and snapshot list carry the person's own waiting messages `{ submissionId, mode: "steer" | "queue", text }` (at most 20). Routine and hidden inputs never appear. Phones have no Remove (follow-up).
```

In §12, after "Faces", add:

```markdown
- **Plan rulings.**
  - The line shows from the send (`preparing` until the first frame).
  - Elapsed time compares the Mac's `startedAt` with the phone's clock, and is hidden when negative.
  - Phones don't show the 2-minute note.
  - The Steer/Queue pill defaults to Queue, and Stop stays where it is.
  - Previews illustrate the Mac's levels, and hold a still frame under Reduce Motion.
  - A photo avatar gets a glance badge.
```

In §17, add `- Pi Durable withdraw on phones: no Remote withdraw route in D; the Queued bubble has no Remove on phones (follow-up).`

- [ ] **Step 2: Plans index**

In `docs/plans/README.md`'s "Bot chat activity…" row, change `D phones (Remote revision 30, \`bot-activity-v1\`)` to `D phones ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-d-phones.md): Remote revision 30 provisional, \`bot-activity-v1\` + negotiable \`bot:activity\`)`.

- [ ] **Step 3: Project memory**

Append a "## Slice D (phones)" section to `.memory/bot-chat-activity.md`. It must say:
- What crosses the wire: the shapes, the bounds and `bot:activity`.
- That the Remote projector reuses B's `liveBotActivity`/`liveQueuedMessages` and stays silent without `turnIntents`.
- That `botTurnIntents` (`main/services/bot-runtime/bot-turn-intents-main.ts`) is the one Stop/Resume source for the desktop projection and Remote.
- Where each platform's phase table lives, and the fixture that pins them (`botActivity.phases`).
- The iOS rule that there are no new Swift files.
- The Android strings and the elapsed-English exception.
- The test files.

Add to `.memory/bots-rework-ui.md`'s "Feature tokens and revision" list:

```markdown
- Revision **30** (2026-10-14, Bot chat activity on phones, provisional, re-claim at merge; `main` was 29): token `bot-activity-v1`, negotiable `bot:activity` gating the `activity` and `queued` session frames and snapshot keys plus Bot detail `chatActivity`; `PATCH /bots/{id}` accepts `chatActivity` and `POST /bots/{id}/messages` accepts `whenBusy: steer|queue` only while the token is announced. Details: `.memory/bot-chat-activity.md`.
```

- [ ] **Step 4: Full verification**

Run each of these. All must PASS.

```bash
npm run type-check
npm run test:aiden-remote
npm run test:bot-runtime
npm run test:bots
npm run test:ci-policy
xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -derivedDataPath /private/tmp/claude-501/aiden-ios-dd -parallel-testing-enabled NO -only-testing:AidenOnTheGoTests
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain
```

Then a real end-to-end pass:
1. Pair a phone with a Mac running this branch. Send to a Bot that reads a file and runs a command.
2. On the phone: "Getting ready" → "Reading" → "Running a command" → the reply.
3. Press Stop on the Mac: the phone reads "Stopping".
4. Toggle Wi-Fi: the phone reads "Reconnecting to your Mac", then recovers.
5. Queue a message: it shows faded with "Queued" until its turn.
6. Change Chat activity on the phone: the Mac's next reply follows it.
7. Pair the same phone with a revision-29 Mac (`main`): chats behave as today, and Advanced has no Chat activity row.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md docs/plans/README.md .memory/bot-chat-activity.md .memory/bots-rework-ui.md
git commit -m "Docs: Bot chat activity slice D rulings, plan index and memory"
```

At merge: if `main` has moved past revision 29, change every `30` this plan introduced to the next free revision. Those places are `AIDEN_REMOTE_CONTRACT_REVISION`, the fixture's two `contractRevision` lines, the four test assertions from Task 1, the fixture parser's `< 30` check, and the docs. Update iOS, Android and the fixture together (AGENTS.md).

---

## Self-review

- **Spec coverage:**
  - §2 decisions 3, 4 and 11: Tasks 4–11.
  - §4 D row: Tasks 1–3.
  - §5 words, marks and ids: Task 1 fixture, Task 4 (iOS) and Task 8 (Android) tables.
  - §5.2: unknown phase → working; elapsed after 20 s; no Stop on the phone line. Phones skip the 2-minute note (Ruling 4).
  - §7 on phones: Tasks 7 and 11.
  - §11: revision, token, `activity` frame and snapshot (Task 2), one-seq rule (Task 2 test 2), `app` ≤ 40 (Task 1), allow-list and privacy fixture (Tasks 1, 4 and 8), detail `chatActivity` and `PATCH` (Task 3), `whenBusy` (Tasks 1–2), older Macs (Tasks 3, 7 and 11).
  - §12: status line, wording, elapsed and Reconnecting (Tasks 5 and 9), Steer/Queue and Queued (Tasks 5, 6, 9 and 10), faces (Tasks 6 and 10), Chat activity page (Tasks 7 and 11), Android strings (Tasks 8, 10 and 11).
  - §14: announcement throttle (Tasks 5 and 8), Reduce Motion (Tasks 6, 7, 10 and 11).
  - §16 iOS/Android rows: decoder tests (Tasks 4 and 8), model/controller tests (Tasks 5 and 9), Chat activity save (Tasks 7 and 11). The New Bot model row was slice A.
- **Placeholders:** none. Every code step shows the code, and every test step shows the test.
- **Type consistency:**
  - TS `whenBusy` is `"steer" | "queue"` on the wire, and `"steer" | "followUp"` at the runtime.
  - Swift `AidenStreamInputMode` and Kotlin `AidenStreamInputMode` reuse the chat enums (`steer`/`queue`).
  - `AidenBotChatActivity.standard` (Swift) and `.DEFAULT` (Kotlin) are both Quiet/Follows.
  - Phase ids are strings everywhere. Swift `Display.phase` is a `String`; Kotlin `AidenBotActivityDisplay.phase` is the enum (`.id` is the string).
- **Review Focus:** all five lines have pinned tests (Tasks 2, 3, 4, 5, 7, 8, 9 and 11, as listed).
