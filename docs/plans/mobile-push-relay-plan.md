# Mobile Push and Live Activities over Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get approvals, questions, results, Bot asks and scheduled runs to an iPhone or Android phone while it is locked, and keep the Live Activity current while the app is suspended.

**Architecture:**

1. **Registration.** A paired phone that turns push on gives its APNs/FCM token and a preview key it generated itself to that Mac, over the existing Aiden Remote API (revision 66, capability `push:alerts`).
2. **Sending.** The Mac or `aiden serve` watches its own event sources and seals the visible text with the phone's key. It posts `{token, kind, pairing, sealed}` to a stateless Cloudflare Worker, which holds Aiden's APNs and FCM keys and forwards a payload built from fixed templates.
3. **Delivery.**
   - iOS: a Notification Service Extension opens the sealed text.
   - Android: an FCM service opens it and posts the notification.
   - Live Activity tokens follow the same path in Task 7.

**Tech Stack:**

- Mac/server: TypeScript (Node 22, `node:crypto`), Electron main process and `packages/cli`.
- Relay: Cloudflare Workers, using WebCrypto for the ES256/RS256 JWTs.
- Phones: Swift 6/CryptoKit/UserNotifications/ActivityKit, and Kotlin/Firebase Messaging.
- Tests: `tsx --test`/`node --test`, XCTest and JUnit.

**Spec:**

- [`ios-alerts-live-activities-proposal.html`](ios-alerts-live-activities-proposal.html): sections 04 and 05, and phases 2–3 in section 06. Published at https://claude.ai/artifact/J9i8yfi8YcTWsgGCdpfaZj.
- Owner decisions of 2026-11-22: owner-run Worker, stateless, opt-in per Mac, Android in the same revision.
- The app-only work it builds on is in [`ios-alerts-app-only-plan.md`](ios-alerts-app-only-plan.md). Tasks 5–7 here depend on its Tasks 3–5: the action broker, the alert categories and `AidenNotificationPreferences`.

## Global Constraints

- **Owner prerequisites.** Only the owner can do these, and the plan does not:
  - An APNs auth key (.p8, key ID, team ID).
  - The Push Notifications capability and `aps-environment` on app ID `sbtbiswas.AidenOnTheGo`, plus its NSE.
  - A Cloudflare account and the relay host.
  - A Firebase project with an Android app and a service-account JSON.
  - The App Store privacy label (Device ID, for app functionality, not linked to the person).

  Tasks build and test without these. Only the device acceptance steps need them.

- **Relay origin.** There is one constant, `AIDEN_PUSH_RELAY_ORIGIN`, in `main/services/push/push-relay-origin.ts`. The owner sets its value to the deployed host. Tests always inject an origin.
- **The relay is stateless.**
  - No KV, D1, Durable Objects or R2 bindings.
  - Workers logs and observability are off, and it never calls `console.log` with request data.
  - It builds the visible alert from fixed per-kind templates. Only `sealed` carries real words.
- **Event kinds.** This allow-list is exact: `approval`, `question`, `completed`, `failed`, `bot_needs_you`, `bot_handoff`, `scheduled_run`, `test`, `live_activity`.
- **Seal format.** One spec for all three implementations:
  - AES-256-GCM with a 32-byte key generated on the phone and a fresh 12-byte nonce.
  - Wire format: `base64(nonce ‖ ciphertext ‖ tag)`.
  - AAD: the UTF-8 string `"aiden-push-v1|" + kind + "|" + pairingTag`.
  - `pairingTag` is the lowercase hex of the first 8 bytes of SHA-256(key).
  - Plaintext is JSON of at most 2048 bytes.
- **Size and timing.**
  - APNs payload at most 4096 bytes; relay request body at most 6144 bytes.
  - The Mac's relay call times out after 5 s and is never retried. A push never delays or fails a run.
- **Network policy.** Same shape as analytics in AGENTS.md.
  - Fixed origin and `redirect: "error"`.
  - `AIDEN_PUSH=0` disables sending.
  - Sends only for a device that turned push on and still holds the needed grants.
  - Tests and E2E inject a fake sender, so they never construct the real client.
- **Contract.**
  - Revision 66 is provisional; re-claim the next revision after main's at merge.
  - New negotiable capability `push:alerts`.
  - Update OpenAPI, `protocol/aiden-remote/v1/fixtures/contract.json`, the desktop parser and tests, and the Swift and Kotlin parsers and tests together, as `ios/DEVELOPMENT.md` requires.
  - Pinned revision tests: `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:174,2020`, `AidenRemoteClientTest.kt:1621`, `AidenBackgroundJobsTest.kt:159`, `main/services/aiden-remote-protocol.test.ts:158`.
- **Fixed copy.** Bot handoff alerts keep fixed copy, even sealed: "A Bot needs you".
- **Tests (AGENTS.md).** Behavioral tests only, with no source-grep. Register each new test file in the root `package.json` test chain, appending to it.
  - Add `test:push` for `main/services/push/*.test.ts` and `services/push-relay/src/*.test.ts`.
  - Extend `test:aiden-remote` for the router and state tests.
- **Commands.**
  - Desktop tests: `npx tsx --test <file>`.
  - iOS: the unit test command from the app-only plan.
  - Android: `cd android && ./gradlew --offline :app:testDebugUnitTest --tests '<class>'`.
- **Docs in the same task.**
  - `docs/aiden-remote-api-v1.md`, `docs/aiden-on-the-go-remote-access.md`.
  - A new `docs/push.md` (what the relay sees, kinds, opt-in, turning it off).
  - `AGENTS.md`: a new "Mobile push" section next to "Product analytics".
  - `PRODUCT.md`, `ios/APP_STORE_METADATA.md`, `ios/CHANGELOG.md`, `android/CHANGELOG.md`, `packages/cli/README.md`.

## Review Focus

1. **APNs answers 410 or `BadDeviceToken`, or FCM answers `UNREGISTERED`.** The Mac deletes that device's push record and sends nothing more to it. Covered by Task 4's `forgets a token the relay reports as gone`.
2. **The relay is down or slow.** The run is unaffected, the send is dropped after 5 s, and there's no retry loop. Covered by Task 4's `a slow relay never blocks and is not retried`.
3. **The phone is revoked on the Mac.** Its push record and Live Activity tokens are removed in the same mutation, and no later event sends. Covered by Task 3's `revoking a device removes its push registration`.
4. **A push sealed with an older preview key arrives** (the phone re-registered or turned push off and on). The NSE or FCM service shows the fixed copy and never crashes. Covered by Task 5's `testOpenFailsClosedToFixedCopy` and Task 6's `wrongKeyFallsBackToFixedCopy`.
5. **`HostRunRegistry.onChange` fires again for an unchanged state** (replays and repeated commits). There's one push per prompt id and one per terminal state of a run. Covered by Task 4's `sends one push per prompt and per terminal state`.

---

### Task 1: One seal format in TypeScript, Swift and Kotlin

**Files:**

- Create: `main/services/push/push-relay-contract.ts`. It holds `PushKind` now; Task 2 adds `RelaySendRequest`. The relay imports this file by relative path, so the Mac and the relay share one wire type.
- Create: `main/services/push/push-seal.ts`, `main/services/push/push-seal.test.ts`.
- Create: `protocol/aiden-remote/v1/fixtures/push-seal.json`. It holds one fixed vector: key, nonce, kind, plaintext and expected wire. It's generated once by the TS test helper and then committed.
- Create: `ios/AidenOnTheGo/Push/AidenPushSeal.swift` (app **and** the NSE target from Task 5; until then, app only), and test file `ios/AidenOnTheGoTests/AidenPushSealTests.swift`. Copy the fixture into the test bundle the same way `contract.json` is.
- Create: `android/app/src/main/java/sbtbiswas/AidenOnTheGo/push/AidenPushSeal.kt`, and test file `android/app/src/test/java/sbtbiswas/AidenOnTheGo/push/AidenPushSealTest.kt`. Read the fixture through the existing `build.gradle.kts` fixture source set.
- Modify: `package.json`. Add `test:push` and append it to `test`.

**Interfaces:**

- Produces:

```ts
export interface PushPreview {
  title: string;
  body: string;
  deepLink: string;
  category?: string;
  userInfo?: Record<string, string>;
}
export function pushPairingTag(key: Uint8Array): string;
export function sealPushPreview(
  key: Uint8Array,
  kind: PushKind,
  preview: PushPreview,
  nonce?: Uint8Array,
): string; // throws if plaintext > 2048 bytes
export function openPushPreview(
  key: Uint8Array,
  kind: PushKind,
  sealed: string,
): PushPreview | null; // null on any failure
// push-relay-contract.ts
export type PushKind =
  | "approval"
  | "question"
  | "completed"
  | "failed"
  | "bot_needs_you"
  | "bot_handoff"
  | "scheduled_run"
  | "test"
  | "live_activity";
```

```swift
enum AidenPushSeal {
    static func pairingTag(key: SymmetricKey) -> String
    static func open(key: SymmetricKey, kind: String, sealed: String) -> AidenPushPreview?   // nil on any failure
}
struct AidenPushPreview: Codable, Equatable { let title: String; let body: String; let deepLink: String; let category: String?; let userInfo: [String: String]? }
```

```kotlin
object AidenPushSeal { fun pairingTag(key: ByteArray): String; fun open(key: ByteArray, kind: String, sealed: String): AidenPushPreview? }
```

- [ ] **Step 1: Write the failing tests**
  - **TS:**
    - `seals the committed vector byte for byte`: seal with the fixture's nonce and compare to `expectedSealed`.
    - `round-trips`.
    - `returns null for a different kind, key or tampered byte`.
    - `refuses plaintext over 2048 bytes`.
    - `pairing tag is 16 lowercase hex chars`.
  - **Swift:** `testOpensTheCommittedVector`, `testWrongKindOrKeyReturnsNil`.
  - **Kotlin:** `opensTheCommittedVector`, `wrongKindOrKeyReturnsNull`.
- [ ] **Step 2: Run each and see it fail** (missing modules).
- [ ] **Step 3: Implement.**
  - TS uses `crypto.createCipheriv("aes-256-gcm")` with `setAAD`.
  - Swift uses `AES.GCM.SealedBox(combined:)` and `AES.GCM.open(_:using:authenticating:)`.
  - Kotlin uses `Cipher.getInstance("AES/GCM/NoPadding")` with `GCMParameterSpec(128, nonce)` and `updateAAD`.
- [ ] **Step 4: Run all three and see them pass:**

```bash
npx tsx --test main/services/push/push-seal.test.ts
```

Then the iOS `-only-testing:AidenOnTheGoTests/AidenPushSealTests`, and Gradle `--tests '*AidenPushSealTest'`.

- [ ] **Step 5: Commit** with the message "Add the shared push seal format".

### Task 2: The stateless relay Worker

**Files:**

- Create the project in `services/push-relay/`:
  - `package.json`: private, with `wrangler` as its only devDependency and its own lockfile, so it isn't part of the root install.
  - `wrangler.toml`:
    - no storage bindings;
    - `[observability] enabled = false`;
    - two `[[unsafe.bindings]]` rate limiters: `PER_TOKEN` at 30/60 s and `PER_IP` at 300/60 s;
    - secrets `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `FCM_SERVICE_ACCOUNT_JSON`;
    - var `APNS_TOPIC = "sbtbiswas.AidenOnTheGo"`.
  - `README.md`: deploy steps for the owner.
- Create:
  - `services/push-relay/src/worker.ts` (fetch handler, wiring only)
  - `src/request.ts` (validation)
  - `src/templates.ts` (fixed alert copy per kind)
  - `src/apns.ts` (JWT and payload)
  - `src/fcm.ts` (OAuth and message)
  - `src/*.test.ts` for each of these. They're pure; tests inject `fetch` and a clock.
- Modify: `package.json` `test:push`. Add `services/push-relay/src/*.test.ts`.

**Interfaces:**

- Consumes: `PushKind` from `main/services/push/push-relay-contract.ts` (Task 1).
- Produces the wire contract the Mac's client (Task 4) uses. `RelaySendRequest` lives in `main/services/push/push-relay-contract.ts`. The functions live in the relay's `src/` files and import the type relatively. They must not import anything else from `main/`.

```ts
// POST /v1/send   (Content-Type: application/json, body ≤ 6144 bytes)
export type RelaySendRequest =
  | {
      platform: "ios";
      environment: "production" | "development";
      token: string;
      kind: Exclude<PushKind, "live_activity">;
      thread: string;
      pairing: string;
      sealed: string;
      category?: string;
      timeSensitive?: boolean;
    }
  | {
      platform: "ios";
      environment: "production" | "development";
      token: string;
      kind: "live_activity";
      event: "update" | "end";
      contentState: Record<string, unknown>;
      staleDate?: number;
      dismissalDate?: number;
      alertKind?: "completed" | "failed";
      priority: 5 | 10;
    }
  | {
      platform: "android";
      token: string;
      kind: Exclude<PushKind, "live_activity">;
      thread: string;
      pairing: string;
      sealed: string;
      highPriority: boolean;
    };
// 200 {"status":"sent"} · 410 {"status":"gone"} · 400 {"status":"invalid"} · 429 {"status":"slow_down"} · 502 {"status":"upstream"}
export function parseRelaySendRequest(body: unknown): RelaySendRequest | null;
export const ALERT_TEMPLATES: Record<
  Exclude<PushKind, "live_activity">,
  { title: string; body: string }
>;
export function buildApnsAlertPayload(
  req: Extract<RelaySendRequest, { platform: "ios"; sealed: string }>,
): object;
export function buildApnsLiveActivityPayload(
  req: Extract<RelaySendRequest, { kind: "live_activity" }>,
  now: number,
): object;
export function buildFcmMessage(req: Extract<RelaySendRequest, { platform: "android" }>): object;
export function createApnsJwtCache(
  keyP8: string,
  keyId: string,
  teamId: string,
  now: () => number,
): () => Promise<string>; // reuses a token for 50 min
```

- **Templates** (exact copy, title "Aiden" for all):

  | Kind                           | Body                      |
  | ------------------------------ | ------------------------- |
  | `approval`                     | "Needs your approval"     |
  | `question`                     | "Has a question for you"  |
  | `completed`                    | "Response complete"       |
  | `failed`                       | "Response failed"         |
  | `bot_needs_you`, `bot_handoff` | "A Bot needs you"         |
  | `scheduled_run`                | "Scheduled task finished" |
  | `test`                         | "Test notification"       |

- **APNs alert payload:**
  - `aps.alert` from the template;
  - `mutable-content: 1`;
  - `thread-id: thread`;
  - `category` when given;
  - `interruption-level: "time-sensitive"` when `timeSensitive`;
  - top-level `kind`, `pairing` and `sealed`.

  Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-topic: APNS_TOPIC`.

- **APNs Live Activity payload:**
  - `aps.event`;
  - `aps.timestamp` (now, in seconds);
  - `aps.content-state`;
  - `stale-date` and `dismissal-date` when given;
  - `aps.alert` from the template only when `alertKind` is set.

  Headers: `apns-push-type: liveactivity`, `apns-topic: APNS_TOPIC + ".push-type.liveactivity"`, `apns-priority: priority`.

- **Hosts:** `api.push.apple.com` for production, `api.sandbox.push.apple.com` for development.
- **FCM message:** `message.data = {kind, thread, pairing, sealed}`, `android.priority = highPriority ? "HIGH" : "NORMAL"`, and no `notification` block, so the app always decrypts.

- [ ] **Step 1: Write the failing tests**
  - `request.test.ts`:
    - rejects unknown kinds, unknown keys, oversize sealed (> 4096 chars), bad environment, and a token with non-hex (iOS) or over 4096 chars;
    - accepts each valid shape.
  - `templates.test.ts`: `every non-live kind has a template whose body is fixed copy`. Assert the table above exactly.
  - `apns.test.ts`:
    - `alert payload carries only template text plus sealed fields`: deep-equal to the expected object, and its JSON is ≤ 4096 bytes for a max-size request;
    - `live activity payload sets topic suffix and alert only for alertKind`;
    - `JWT is reused within 50 minutes and refreshed after`, using a fake clock and checking the header kid.
  - `fcm.test.ts`: `data-only high-priority message`.
  - `worker.test.ts`, with injected upstream `fetch`:
    - `maps APNs 410 and 400 BadDeviceToken to 410 gone`;
    - `maps FCM 404 UNREGISTERED to 410 gone`;
    - `returns 429 when a limiter says no`;
    - `never echoes request data in error bodies`.
- [ ] **Step 2: Run and see them fail.**

```bash
npx tsx --test services/push-relay/src/*.test.ts
```

- [ ] **Step 3: Implement the modules.**
  - The ES256 JWT uses `crypto.subtle.importKey("pkcs8", …, {name:"ECDSA", namedCurve:"P-256"})`.
  - The FCM OAuth token is an RS256 JWT exchanged at `https://oauth2.googleapis.com/token`, cached for 50 minutes.
  - The handler accepts only `POST /v1/send`. Every other path or method gets 404.
- [ ] **Step 4: Run and see them pass.** Also run `cd services/push-relay && npx wrangler deploy --dry-run` and expect it to bundle with no errors.
- [ ] **Step 5: Commit** with the message "Add the stateless push relay Worker", including `services/push-relay` and `package.json`.

### Task 3: Revision 66: devices register for push

**Files:**

- Modify: `main/services/aiden-remote-protocol.ts`:
  - `AIDEN_REMOTE_PUSH_CONTRACT_REVISION = 66`, and point `AIDEN_REMOTE_CONTRACT_REVISION` at it.
  - Capability `push:alerts`, added to `AIDEN_REMOTE_NEGOTIABLE_CAPABILITIES`.
  - Parsers `parseAidenRemotePushRegistration` and `parseAidenRemoteLiveActivityToken`.
- Modify: `main/services/aiden-remote-state.ts`. `StoredAidenRemoteDevice.push?: StoredAidenRemotePush`. Update `parseDevice`'s exact-key list and `projectDevice`, and add `setDevicePush`, `clearDevicePush`. `revokeDevice` also clears `push`.
- Modify: `main/services/aiden-remote-router.ts`:
  - Route labels and templates for `PUT /device/push`, `DELETE /device/push`, `POST /device/push/test`, `PUT /device/push/live-activities/{runId}` and `DELETE /device/push/live-activities/{runId}`.
  - The last two are accepted now and used in Task 7.
  - Every route uses `authenticate(..., "push:alerts")`, and every mutation requires `Idempotency-Key`.
- Modify: `protocol/aiden-remote/v1/openapi.json`, `protocol/aiden-remote/v1/fixtures/contract.json` (`contractRevision: 66` plus push examples), `docs/aiden-remote-api-v1.md`.
- Tests: `main/services/aiden-remote-protocol.test.ts`, `aiden-remote-state.test.ts`, `aiden-remote-router.test.ts`, `aiden-remote-revocation.test.ts`. Also bump the pinned revision in the iOS and Android tests listed in Global Constraints.

**Interfaces:**

- Produces:

```ts
export interface AidenRemotePushPreferences { needsAnswer: boolean; responseReady: boolean; runFailed: boolean; botNeedsMe: boolean; scheduledTasks: boolean; showMessageText: boolean }
export interface StoredAidenRemotePush {
  platform: "ios" | "android"; token: string; environment?: "production" | "development";
  previewKey: string;            // base64 of 32 bytes; state file stays 0o600
  preferences: AidenRemotePushPreferences; updatedAt: string;
}
// PUT /device/push body = Omit<StoredAidenRemotePush, "updatedAt">  → 200 { enabled: true, pairing: string /* pushPairingTag */, updatedAt }
// DELETE /device/push → 200 { enabled: false }
// POST /device/push/test → 202 { queued: true }   (sends kind "test"; 409 push_not_enabled when no registration)
// PUT /device/push/live-activities/{runId} body { token: string } → 204 ; DELETE → 204
registry.setDevicePush(deviceId: string, push: Omit<StoredAidenRemotePush, "updatedAt">): Promise<StoredAidenRemotePush>
registry.clearDevicePush(deviceId: string): Promise<void>
registry.listPushDevices(): Array<{ deviceId: string; capabilities: readonly string[]; push: StoredAidenRemotePush }>  // excludes revoked
```

- [ ] **Step 1: Write the failing tests**
  - Protocol:
    - `contract revision is 66`;
    - `push:alerts is negotiable`;
    - parser accepts a valid registration;
    - parser rejects a previewKey that isn't 32 bytes, an unknown platform, an iOS registration without `environment`, extra keys, and a token over 4096 chars.
  - State:
    - `setDevicePush persists and survives a reload`;
    - `a state document without push still parses`;
    - `revoking a device removes its push registration`;
    - `listPushDevices skips revoked devices`.
  - Router:
    - `PUT /device/push needs push:alerts`: 403 without it, 200 after `POST /device/capabilities` adds it;
    - `requires Idempotency-Key`;
    - `DELETE clears it`;
    - `test returns 409 push_not_enabled without a registration`.
  - Phones:
    - iOS `AidenRemotePhase0Tests`: the fixture revision is 66.
    - Android `AidenRemoteClientTest`, `AidenBackgroundJobsTest`: 66.
- [ ] **Step 2: Run and see them fail.**

```bash
npx tsx --test main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-state.test.ts main/services/aiden-remote-router.test.ts main/services/aiden-remote-revocation.test.ts
```

- [ ] **Step 3: Implement the protocol constants and parsers, the state mutations (copy the `upgradeDeviceCapabilities` `mutate` pattern), and the routes.** `/server.serverCapabilities` advertises `push:alerts` always, since the Mac needs no key to send.
- [ ] **Step 4: Run them to see them pass, then `npm run test:aiden-remote` and the phone revision tests.**
- [ ] **Step 5: Commit** with the message "Add push registration to the Aiden Remote contract (revision 66)".

### Task 4: The Mac and `aiden serve` send pushes

**Files:**

- Create:
  - `main/services/push/push-relay-origin.ts`
  - `main/services/push/push-client.ts`: fixed-origin sender, 5 s timeout, `redirect: "error"`, abort on shutdown.
  - `main/services/push/push-events.ts`: pure mapping from sources to sends.
  - `main/services/push/push-service.ts`: subscriptions, dedupe, fan-out, forgetting gone tokens.
  - A `*.test.ts` for each of the last three.
- Modify: `main/services/aiden-remote-service-main.ts` (desktop). Create the service next to `hostFeed.noteRun` (~line 1233), with the remote state registry, `HostRunRegistry`, `BotHandoffs`, the Bot issue funnel and the schedule service.
- Modify: `main/services/bot-delivery/funnel-main.ts`. Add a `push:` sink so Bot issue rows of class `issue` reach `push-service`.
- Modify: `packages/cli/src/remote.ts`. Wire the same service for `aiden serve`.
- Modify: `AGENTS.md` (new "Mobile push" section), `docs/push.md` (new), `packages/cli/README.md`, `docs/aiden-on-the-go-remote-access.md`.

**Interfaces:**

- Consumes:
  - `HostRunRegistry.onChange(listener(summary, removed))`, `.pendingPrompt(id)`, and `HostRunSummary` (`state`, `pendingApprovalIds`, `pendingQuestionIds`, `origin`, `chatId`, `runId`).
  - `registry.listPushDevices()` / `clearDevicePush()` (Task 3), and `sealPushPreview` / `pushPairingTag` (Task 1).
  - `BotHandoffs.onChange`, the Bot funnel, and `AidenRemoteScheduleService`'s finished-run notifications.
- Produces:

```ts
export type PushSendOutcome = "sent" | "gone" | "dropped";
export interface PushSender {
  send(request: RelaySendRequest): Promise<PushSendOutcome>;
} // "dropped" on timeout, 4xx/5xx other than 410, or AIDEN_PUSH=0
export function createPushSender(options: {
  origin: string;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): PushSender;

export interface PushEvent {
  kind: Exclude<PushKind, "live_activity" | "test">;
  dedupeKey: string;
  chatId?: string;
  runId?: string;
  preview: PushPreview; // title = chat or Bot name; body = summary/question when showMessageText, else template body
  requiredGrants: readonly string[]; // e.g. ["chat:read"], ["bot:read","chat:read"], ["schedule:read"]
  preference: keyof AidenRemotePushPreferences;
  timeSensitive: boolean;
  category?: string; // app-only plan's AidenRunAlertCategory ids
}
export function eventsForRunChange(
  summary: HostRunSummary,
  previous: HostRunSummary | undefined,
  lookup: {
    chatTitle(chatId: string): string;
    prompt(id: string): HostRunPendingPrompt | undefined;
  },
): PushEvent[];
export type PushRegistry = Pick<AidenRemoteStateRegistry, "listPushDevices" | "clearDevicePush">;
export function createPushService(deps: {
  registry: PushRegistry;
  sender: PushSender;
  now: () => number;
}): {
  notify(event: PushEvent): Promise<void>;
  dispose(): void;
};
```

- **Mapping rules** for `eventsForRunChange`:
  - **A new id in `pendingApprovalIds`** gives `approval`.
    - `userInfo` carries `{chatID, approvalID, runID?}`, where `runID` is set only when `origin !== "remote"`, plus `canAllow` from the prompt payload.
    - Category `aiden.run.approval` or `aiden.run.approval.deny`. Time Sensitive.
  - **A new id in `pendingQuestionIds`** gives `question`.
    - Category `aiden.run.question.reply` when the prompt has exactly 1 question, otherwise `aiden.run.question`. Time Sensitive.
  - **Moving into `done`** gives `completed`. **Moving into `failed`** gives `failed`. Neither is Time Sensitive.
  - **Moving into `cancelled`** sends nothing.
  - **Dedupe keys:** `approval:<id>`, `question:<id>`, `terminal:<runId>`. Keep the last 1000 keys in memory.
- **Other sources.** Each has its own pure mapper in `push-events.ts`:
  - `eventForBotHandoff(handoff)`:
    - Kind `bot_handoff`. Fixed copy "A Bot needs you" in the sealed body too.
    - Title: the Bot's name. Deep link: `aiden-otg://bot/{botId}/chat`.
    - Grants `bot:read`, `chat:read` and `bot:handoffs`. Preference `botNeedsMe`. Time Sensitive.
    - Dedupe `handoff:<waitId>`.
  - `eventForBotIssue(row)`:
    - Only for rows of class `issue` that ask something. Heads-up cards don't push, matching today's rule.
    - Kind `bot_needs_you`. Body: the issue's plain words when `showMessageText`.
    - Grants `bot:read` and `chat:read`. Preference `botNeedsMe`. Time Sensitive.
    - Dedupe `issue:<id>`. The 4-hour "Reminder: …" keeps its own key, `issue-reminder:<id>`.
  - `eventForScheduledRun(item)`:
    - Only for tasks that opted into `notify`. Kind `scheduled_run`. Body: the task's name.
    - Grant `schedule:read`. Preference `scheduledTasks`. Not Time Sensitive.
    - Dedupe `schedule:<runId>`.
- [ ] **Step 1: Write the failing tests**
  - `push-events.test.ts`:
    - `sends one push per prompt and per terminal state`: feed the same summary 3 times, then a new approval id, then `done` twice. Expect exactly 3 events.
    - `deep link targets the chat on this Mac`: `aiden-otg://` chat URL built with this installation's id.
    - `body is the approval summary only when showMessageText`.
    - `bot handoff always uses fixed copy`.
    - `only asking bot issues push, and a reminder pushes once more`.
    - `scheduled runs push only for tasks that opted into notify`.
    - `run approvals carry runID only for non-remote origins`.
  - `push-client.test.ts`:
    - `refuses any origin but the configured one`;
    - `a slow relay never blocks and is not retried`: a fake fetch that never resolves gives "dropped" after the 5 s fake timer, with 1 fetch call;
    - `AIDEN_PUSH=0 sends nothing`;
    - `410 → gone`.
  - `push-service.test.ts`:
    - `seals per device with its own key and pairing tag`: two devices, two distinct `sealed` values, and each opens only with its own key via `openPushPreview`;
    - `skips devices without the grants or with the preference off`;
    - `forgets a token the relay reports as gone`: `clearDevicePush` called once and the next event isn't sent to that device.
- [ ] **Step 2: Run and see them fail.**

```bash
npx tsx --test main/services/push/*.test.ts
```

- [ ] **Step 3: Implement the client, the events and the service.**
  - Sends run without blocking: `void` the promise, catch everything, log only the fixed phase text.
  - A send to an iOS device uses `environment` from its registration.
- [ ] **Step 4: Wire desktop and CLI.**
  - The test route from Task 3 calls `notify` with kind `test` for that device only.
  - Add the AGENTS.md "Mobile push" section:
    - fixed origin; opt-in per paired phone; fields sent (token, kind, thread, pairing tag, sealed); the relay stores nothing;
    - `AIDEN_PUSH=0`;
    - tests inject a fake sender;
    - no sends from startup alone, only from the listed events.
- [ ] **Step 5: Run `npm run test:push`, `npm run test:aiden-remote`, `npm run test:cli` and `npm run type-check`.** Expected: all pass.
- [ ] **Step 6: Commit** with the message "Send mobile push from the Mac and aiden serve".

### Task 5: iPhone receives push

**Files:**

- Create the Notification Service Extension target `AidenNotificationService` in `ios/AidenOnTheGo.xcodeproj` (bundle `sbtbiswas.AidenOnTheGo.NotificationService`, iOS 26):
  - `ios/AidenNotificationService/NotificationService.swift`
  - `Resources/Info.plist`
  - `AidenNotificationService.entitlements`, with the app group and `keychain-access-groups` `$(AppIdentifierPrefix)sbtbiswas.AidenOnTheGo.push`
  - Add `ios/AidenOnTheGo/Push/AidenPushSeal.swift` to this target.
- Create: `ios/AidenOnTheGo/Push/AidenPushKeyStore.swift` (app and NSE): a Keychain item per installation ID in that access group.
- Create: `ios/AidenOnTheGo/Push/AidenPushRegistrar.swift` (app): APNs token in; `PUT/DELETE /device/push` and the test send out.
- Modify: `ios/AidenOnTheGo/Resources/AidenOnTheGo.entitlements`. Add `aps-environment` = `$(APS_ENVIRONMENT)` and the same keychain group, and set `APS_ENVIRONMENT` per configuration in `ios/Config`.
- Modify: `ios/AidenOnTheGo/AidenOnTheGoApp.swift`. Add a `UIApplicationDelegateAdaptor` for `didRegisterForRemoteNotificationsWithDeviceToken` and `didFail…`.
- Modify: `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift`. Add `registerPush`, `unregisterPush`, `sendTestPush`, and the capability `push:alerts` in `AidenRemoteCapability`.
- Modify: `ios/AidenOnTheGo/Features/Workspace/AidenNotificationSettingsView.swift` (from the app-only plan):
  - A "Push from <Mac name>" row per paired Mac: Off, Connected or "Update Aiden on this Mac", with a Test button.
  - Change the Privacy footer to "Message text is sealed on your Mac. The relay only sees that something happened."
- Modify: the offer after pairing or the first finished run: "Get alerts when your phone is locked?" with **Turn on** / **Not now**.
- **Preference sync.** `AidenPushRegistrar` builds `preferences` from `AidenNotificationPreferences` (`needsAnswer`, `responseReady`, `runFailed`, `botNeedsMe`, `showMessageText`) plus `scheduledTasks: true`, since each task already has its own opt-in. It sends `PUT /device/push` again to every enabled Mac whenever those preferences change.
- Tests: `ios/AidenOnTheGoTests/AidenPushTests.swift` (new), plus `AidenRemoteClientTests.swift`.

**Interfaces:**

- Consumes: `AidenPushSeal` (Task 1), the Task 3 routes, and the app-only plan's `AidenRunAlertCategory`, `AidenAlertAction` and `AidenNotificationPreferences`.
- Produces:

```swift
enum AidenPushContent {
    /// Pure core of the NSE: returns the content to deliver. Never throws; falls back to the fixed copy already in `content`.
    static func open(_ content: UNNotificationContent, keyFor: (String /* pairing tag */) -> SymmetricKey?) -> UNNotificationContent
}
@MainActor final class AidenPushRegistrar {
    func enable(instanceID: String) async -> AidenPushEnableOutcome   // .enabled, .permissionDenied, .hostTooOld, .failed
    func disable(instanceID: String) async
    func deviceTokenReceived(_ token: Data)
    func sendTest(instanceID: String) async -> Bool
}
enum AidenPushEnableOutcome: Equatable { case enabled, permissionDenied, hostTooOld, failed }
```

- [ ] **Step 1: Write the failing tests**
  - `testOpenReplacesTitleBodyCategoryAndUserInfo`: seal with Task 1's TS fixture vector; the opened content has the plaintext's title, body, category and userInfo.
  - `testOpenFailsClosedToFixedCopy`: wrong key, unknown pairing, or garbage `sealed` returns the original "Aiden / Needs your approval".
  - `testEnableUpgradesCapabilityThenRegistersWithAFreshKey`:
    - A mock client sees `POST /device/capabilities` with `push:alerts`, then `PUT /device/push`.
    - The body has a 32-byte key, which matches the Keychain item, and `environment` from the build.
  - `testEnableReportsHostTooOldWhenPushAlertsIsNotAdvertised`.
  - `testDisableDeletesTheKeyAndUnregisters`.
  - `testChangingAPreferenceReRegistersEveryEnabledMac`: turn `responseReady` off with two enabled Macs; expect two `PUT /device/push` calls carrying `responseReady: false`.
  - `testForgettingAMacDisablesItsPush`: `removeInstallationOutcome` calls `disable`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
  - `NotificationService.didReceive` calls `AidenPushContent.open`, then delivers exactly once under a lock. `serviceExtensionTimeWillExpire` delivers the fixed copy.
  - Tapping and actions go through the existing presentation delegate and the app-only plan's broker. The deep link and userInfo keys match the app-only plan's `AidenRunAlertContent`.
- [ ] **Step 4: Run them to see them pass, then the full unit suite and a device build.**

```bash
xcodebuild build -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'generic/platform=iOS' -quiet
```

- [ ] **Step 5: Device acceptance (needs the owner prerequisites).**
  - Pair, turn push on, and use Settings → Notifications → Test. Expect an "Aiden / Test notification" banner.
  - Then lock the phone and trigger an approval from the Mac.
  - Expected: within seconds, a Time Sensitive banner shows the real summary, long-press offers Approve (needs Face ID) and Deny, and Deny reaches the Mac.
- [ ] **Step 6: Commit** with the message "Receive encrypted push on iPhone", plus the docs, `ios/CHANGELOG.md` and `ios/APP_STORE_METADATA.md` (privacy label).

### Task 6: Android receives push (FCM)

**Files:**

- Modify:
  - `android/build.gradle.kts`, `android/app/build.gradle.kts`: Google services plugin and `com.google.firebase:firebase-messaging`, exact versions pinned. `google-services.json` is supplied by the owner and gitignored.
  - `android/app/src/main/AndroidManifest.xml`: the service.
  - `.../networking/AidenRemoteClient.kt`: `registerPush`, `unregisterPush`, `sendTestPush`, capability `push:alerts`.
- Create:
  - `.../push/AidenFirebaseMessagingService.kt`: `onNewToken` re-registers with each enabled Mac; `onMessageReceived` opens the seal and posts.
  - `.../push/AidenPushContent.kt`: pure decrypt-or-fallback to a notification model.
  - `.../push/AidenPushKeyStore.kt`: keys wrapped by Android Keystore, per installation.
  - `.../push/AidenPushRegistrar.kt`.
- Modify:
  - `.../notifications/` channels: "Agent alerts" (high importance) for asks, "Results" (default) for the rest.
  - Actions: Approve (biometric-confirm activity), Deny, Reply (`RemoteInput`). They call the existing `respondToApproval` / `respondToRunApproval` / question routes.
  - Android Settings → Notifications gets the same rows as iOS.
- Tests: `android/app/src/test/java/sbtbiswas/AidenOnTheGo/push/AidenPushContentTest.kt`, `AidenPushRegistrarTest.kt`.

**Interfaces:**

- Produces:

```kotlin
data class AidenPushNotification(val title: String, val body: String, val deepLink: String?, val channel: String,
                                 val actions: List<AidenPushAction>, val threadKey: String)
object AidenPushContent { fun from(data: Map<String, String>, keyFor: (String) -> ByteArray?): AidenPushNotification }  // never throws
```

- [ ] **Step 1: Write the failing tests**
  - `opensTheVectorIntoTitleBodyAndActions`.
  - `wrongKeyFallsBackToFixedCopy`.
  - `approvalWithoutCanAllowHasNoApproveAction`.
  - `newTokenReRegistersEveryEnabledMac`.
  - `forgettingAMacUnregistersAndDeletesItsKey`.
- [ ] **Step 2: Run and see them fail.**

```bash
cd android && ./gradlew --offline :app:testDebugUnitTest --tests '*AidenPush*'
```

- [ ] **Step 3: Implement.** Then run `./gradlew --offline :app:lintDebug :app:compileDebugAndroidTestKotlin`.
- [ ] **Step 4: Device acceptance on a phone with Google Play services (needs the owner's Firebase project).** Use the same steps as Task 5, Step 5.
- [ ] **Step 5: Commit** with the message "Receive encrypted push on Android", plus `android/CHANGELOG.md` and `android/README.md` (Firebase setup).

### Task 7: The Live Activity updates over push

**Files:**

- Modify: `ios/AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift`:
  - `ContentState` also decodes the compact push shape `{v, status, approval_id?, run_id?, started_at, updated_at, final?}`. Wire status values are `working`, `needs_approval`, `needs_input`, `done`, `failed`, `cancelled`, and map to `.thinking`, `.waitingForApproval`, `.waitingForAnswer`, `.complete`, `.failed` and `.cancelled`.
  - An unknown `v` or status decodes as `.thinking`.
  - `sessionTitle` and `currentActivity` decode as `""` when absent.
- Modify: `AgentRunTextPresentation.make`. Add `attributesTitle:`, which is used when `state.sessionTitle` is empty.
- Modify: `ios/AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`. Pass `context.attributes.sessionTitle`.
- Modify: `ios/AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift`:
  - `Activity.request(..., pushType: pushEnabled(instanceID) ? .token : nil)`.
  - Observe `pushTokenUpdates` and call `PUT /device/push/live-activities/{streamID}`.
  - Use a stale date of +900 s when push-driven (otherwise the current 300 s).
- Modify: `main/services/push/push-service.ts`, `main/services/push/push-events.ts`:
  - Keep an in-memory map `runId → [{deviceId, token}]`, filled by the Task 3 routes and cleared on run removal or device revoke.
  - On a `HostRunRegistry` state change, send `kind: "live_activity"`:
    - `event: "update"` at priority 10 for `needs_approval`, `needs_input` and `working`-after-a-wait;
    - `event: "end"` for terminal states, with `dismissalDate` now+300 for `done` and now+30 otherwise.
  - On `end`, set `alertKind` for `done`/`failed`, and **skip** the separate `completed`/`failed` alert to any device that holds an activity token for that run.
- Tests: `main/services/push/push-service.test.ts`, `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.

**Interfaces:**

- Consumes: Task 3 routes, Task 4 `PushSender`/`eventsForRunChange`, app-only plan Task 1 `AgentRunTextPresentation`.
- Produces: `export function liveActivityPushFor(summary: HostRunSummary, previous: HostRunSummary | undefined, now: number): Extract<RelaySendRequest, { kind: "live_activity" }>["contentState"] & { event: "update" | "end" } | null`.

- [ ] **Step 1: Write the failing tests**
  - TS:
    - `pushes an update when a run starts waiting and an end with alert when it finishes`;
    - `skips the separate completion alert for a device with a live activity token`;
    - `drops activity tokens when the run is removed or the device revoked`;
    - `no live activity push for progress inside the working state`.
  - Swift:
    - `testCompactPushStateDecodesAndKeepsTheAttributesTitle`: `{"v":1,"status":"needs_approval","approval_id":"ap","started_at":1795327740,"updated_at":1795327931}` gives status "Needs your approval", the title from the attributes, and `approval == .init(approvalID: "ap", runID: nil)`;
    - `testUnknownPushStatusDecodesAsWorking`.
- [ ] **Step 2: Run and see them fail. Step 3: Implement. Step 4: Run them to see them pass, then `npm run test:push` and the iOS unit suite.**
- [ ] **Step 5: Device acceptance.**
  - Start a run from the phone and lock it within 5 s, then trigger an approval on the Mac.
  - Expected: the Lock Screen card changes to "Needs your approval" with Review/Deny within seconds, even though the app is suspended.
  - When the run finishes, the card says "Done" with a single "Response complete" alert and no duplicate banner.
- [ ] **Step 6: Commit** with the message "Drive the Live Activity over push". Update the status rows of this plan and the app-only plan in `docs/plans/README.md` to "Implemented, in review".
