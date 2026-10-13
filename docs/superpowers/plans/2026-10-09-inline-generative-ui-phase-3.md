# Inline Generative UI Phase 3: Snapshots and the Remote Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every visual, native (`render_ui`) or HTML (`render_artifact`), reaches the iOS and Android apps inline at its tool row, as a snapshot image with its takeaway text. Older phones keep working.

**Architecture:**
- After an assistant message commits, a main-process snapshot service renders each visual in one hidden, sandboxed `BrowserWindow`:
  - HTML visuals go through an opaque-origin iframe of their `aiden-genui://preview/` URL.
  - Native visuals go through a new `visual-snapshot` renderer entry that draws `AidenUiBlock` statically.
- The service captures a PNG and writes it as an ordinary image attachment with a reserved id prefix, plus a `visualSnapshots` map on the message.
- Aiden Remote revision 27 adds a slim `visuals` projection (no tree), and both phones render `visuals` after the matching tool row.

**Tech Stack:** Electron `BrowserWindow`/`capturePage`/`nativeImage`; the existing attachment store and Remote attachment route; Swift/SwiftUI (iOS 26, Xcode 26.6), Kotlin/Compose with kotlinx.serialization; contract fixtures in `protocol/aiden-remote/v1/fixtures/contract.json`.

**Spec:** `docs/superpowers/specs/2026-10-08-inline-generative-ui-design.md` (§8 Snapshots and Aiden Remote, §9 Mobile, §12 Phase 3). Phase 2 plan: `docs/superpowers/plans/2026-10-09-inline-generative-ui-phase-2.md`.

## Global Constraints

- Mobile constraints (spec §8):
  - Never add a timeline step kind.
  - An invalid visual drops to its `fallbackText`; the chat is never rejected.
  - Include visuals in the `chatRevision` hash.
  - Keep each visual far under the 1 MiB window budget.
  - Add `contract.json` fixtures (a chat with both kinds plus a windowed page) and decode tests on desktop, iOS and Android in the same PR.
  - `htmlArtifacts` stays projected for older clients.
- Claim the contract revision `main` + 1 at merge time (27 today). Update the iOS, Android and fixture contracts together (AGENTS.md). Feature token: `chat-visuals-v1` in `/server.features`.
- **No tree on the wire in Phase 3.** Each projected visual is `{id, kind:"ui"|"html", title, toolCallId?, fallbackText?, snapshotAttachmentId?, layout?}`.
  - Every key must pass the shipped iOS and Android private-key validators.
  - Tree projection and client opt-in plumbing are Phase 4.
- Snapshot attachments:
  - `kind:"image"`, PNG (JPEG at quality 88 when the PNG exceeds 2 MiB), id `visual-snapshot_<sha256 hex of chatId\0messageId\0visualId>`, name `<title>.png`.
  - Width: CSS 720 px for column visuals and 1024 px for wide ones, at 2× scale. Height ≤ 1,600 CSS px.
  - The light theme on the opaque canvas color. Dark parity is Phase 4 with native renderers.
- Snapshot attachments are **not** model images. Exclude them from `createPiModelImageReferences`, the vision tool, `displayedAssistantImageUsage` caps, desktop `MessageAttachments`, and memory artifact docs.
- The hidden window:
  - Uses the default session (the `aiden-genui` protocol is registered only there), `show:false`, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, no preload for HTML, and no network beyond `aiden-genui:` (inherited from the guest CSP).
  - Denies `setWindowOpenHandler` and `will-navigate`.
  - Is excluded from `BrowserWindow.getAllWindows()` consumers (Remote `focusApp`, IPC broadcast, `bot-connection-setup`, `window-all-closed`).
  - Is destroyed when the queue drains.
- Snapshots are best-effort and non-blocking. They never delay `chat:done`, and failures leave the visual without a snapshot (the phones show `fallbackText`).

## Review Focus

1. **The user quits or deletes the chat while a snapshot is in flight.** No crash, no orphan window, and no write to a deleted chat. Test: Task 2, cancel on `chatDeleted` and `before-quit`.
2. **A visual whose HTML never reports a size, or loops forever** (`while(true)` in a guest). A capture timeout of 6 s, then skip. The renderer process must not hang the app. Test: Task 2 timeout path with a stub.
3. **An old phone (revision 26) receives a chat with snapshots.** It must decode the chat, show snapshots as ordinary images, and still show the "Can't view" card for HTML. Test: Tasks 4 and 5 fixture decode on iOS and Android, asserting snapshot attachments decode as ordinary images for the old rendering path.
4. **A projected visual references a tool call missing from the timeline** (an interrupted run). The visual renders after the text as a trailing row, not dropped. Test: Tasks 4 and 5 chronological projection tests.
5. **A chat copied or forked after snapshots exist.** Attachment ids and `visualSnapshots` must still line up (HTML mediaIds are remapped on copy). Test: Task 3 copy test.

---

### Task 1: Snapshot storage on the message

**Files:**
- Modify:
  - `main/services/types.ts` and `renderer/lib/types.ts`: `visualSnapshots?: { visualId: string; attachmentId: string }[]`.
  - `main/services/chat-store-core.ts`: parse on read (lenient), `appendMessage` passthrough. New method `addVisualSnapshots(chatId, messageId, snapshots: { visualId: string; attachment: Attachment }[]): Promise<boolean>` that runs under the chat lock, validates with `parseAttachment`/`imageBytesMatchMime`, replaces existing snapshots for the same visualId, and respects the 20-attachments and 16 MiB per-message limits by skipping extras. `copyVisibleHistory` remaps HTML `visualId`s through `remappedHtmlArtifactMediaId`.
  - `renderer/shared/visual-snapshots.ts` (new): `VISUAL_SNAPSHOT_ID_PREFIX = "visual-snapshot_"`, `isVisualSnapshotAttachmentId(id)`, `parseVisualSnapshots(value)`.
  - Exclusions:
    - `main/services/llm-client.ts:833-845` (model image refs) and the vision tool at :1535
    - `main/services/display-image-extension.ts:80-110` caps
    - `renderer/components/message-attachments.tsx:135` partition (hide)
    - `main/services/memory-context.ts:75-85`
- Test: extend `main/services/chat-store-core.test.ts` and `chat-session-copy.test.ts`; add `renderer/shared/visual-snapshots.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `addVisualSnapshots` adds the attachment plus the map entry and bumps the chat revision. A second call for the same visual replaces it. A user message or missing chat → `false`.
  - A 21st attachment is skipped.
  - After a copy, `visualSnapshots[].visualId` matches the copied HTML `mediaId`.
  - The desktop partition hides `visual-snapshot_` attachments (render `MessageAttachments` and assert no `img`).
  - The display-image usage counter ignores them.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Register `visual-snapshots.test.ts`.
- [ ] **Step 5: Commit** `feat(visuals): store visual snapshots as reserved message attachments`.

### Task 2: Offscreen snapshot service

**Files:**
- Create:
  - `main/services/visual-snapshot-core.ts` (Electron-free queue, timeouts and size policy, so it is testable)
  - `main/services/visual-snapshot-main.ts` (BrowserWindow driver)
  - `main/services/visual-snapshot-core.test.ts`
  - `renderer/visual-snapshot.html`, `renderer/visual-snapshot.tsx` (Vite entry: renders `AidenUiBlock` with `draft` and no actions, reads its input from `window.__aidenSnapshot(visualJson, themeVars)`, and resolves a promise once fonts and layout settle)
- Modify:
  - `vite.config.ts:31-33`: add the entry.
  - `main/windows/window-paths.ts`: `getWindowUrl("visual-snapshot")`.
  - `main/services/llm-client.ts`: after `generativeUiArtifactStore.commit` in `persistAssistant` (~:2399), `void visualSnapshots.enqueue({chatId, messageId, html: displayedHtmlArtifacts.map(...), ui: displayedUiVisuals, layoutFor})`.
  - `main/index.ts`: create the service, and cancel it on `before-quit`.
  - Exclude the hidden window: a `isAuxiliaryWindow(win)` registry in `main/windows/auxiliary-windows.ts` (new), filtered at `aiden-remote-service-main.ts:452`, `platform.ts:81`, `bot-connection-setup.ts:33` and `main/index.ts:1708`.
  - `main/services/chat-store-core.ts`: deletion hook → `visualSnapshots.cancelChat(chatId)`.

**Interfaces:**
- `createVisualSnapshotQueue({ capture(job): Promise<Buffer | null>, store(chatId, messageId, snapshots), timeoutMs = 6000, now })`:
  - `enqueue(job)`, `cancelChat(chatId)`, `dispose()`.
  - Jobs run serially. Each visual's capture races the timeout.
  - `store` is called once per message with the successful captures.
- HTML capture:
  1. Register the stored HTML via `wrapGenerativeUiHtml(html, title, lightTheme, { inline: false })` and `registerGenerativeUiPreviewDocument`.
  2. Load a `data:text/html` host page whose `<iframe sandbox="allow-scripts">` loads that URL at the target width. The host page listens for the bridge's resize message and records the height.
  3. Wait for `ready`, the first resize, and 2 animation frames; or time out.
  4. Size the window to the content and call `capturePage({x:0,y:0,width,height}, { stayHidden: true })`, retrying up to 3 times when `image.isEmpty()`.
  5. Encode with `nativeImage` `toPNG`, or `toJPEG(88)` when over 2 MiB.
- UI capture: load the `visual-snapshot` entry once, call `executeJavaScript("window.__aidenSnapshot(...)")` with the JSON-stringified visual, await the height it returns, then capture as above.

- [ ] **Step 1: Write failing core tests:**
  - Jobs run one at a time in order.
  - A capture that never resolves is skipped after the timeout, and the next job runs.
  - `cancelChat` drops queued jobs for that chat and suppresses `store` for an in-flight one.
  - `dispose` rejects new jobs.
  - `store` receives only successful captures.
  - The attachment id is deterministic per (chat, message, visual).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the core, then the Electron driver.**
- [ ] **Step 4: Verify the driver for real.** Add `tests/e2e/visual-snapshots.spec.ts`:
  - Seed a chat (through the existing e2e fixture helpers) whose assistant message has one HTML artifact in the store and one `uiVisuals` entry.
  - Trigger `visualSnapshots.enqueue` through a test-only IPC that exists only when `AIDEN_E2E=1`, following the existing e2e hooks pattern.
  - Assert that the message gains two `visual-snapshot_` PNG attachments with plausible dimensions (decode the IHDR), and that `BrowserWindow.getAllWindows()` exposed to the app is unchanged.

  Run `npm run build && npx playwright test tests/e2e/visual-snapshots.spec.ts --retries=0`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(visuals): capture offscreen snapshots of every visual after a reply commits`.

### Task 3: Remote projection, revision 27, and desktop contract

**Files:**
- Modify:
  - `main/services/aiden-remote-chats.ts`:
    - `AidenRemoteMessageProjection` gains `visuals?`.
    - `projectMessage` builds it from `uiVisuals`, `htmlArtifacts`, `htmlArtifactPlacements` and `visualSnapshots` (≤ 40, title ≤ 120, fallbackText ≤ 4,000 chars, `snapshotAttachmentId` = projected attachment id, `toolCallId` must match `^call-\d+$`).
    - Add `visuals` to the `chatRevision` per-message object (:414-440).
  - `main/services/aiden-remote-protocol.ts`:
    - `AIDEN_REMOTE_CONTRACT_REVISION = 27`.
    - A `chat-visuals-v1` feature constant.
    - `parseChatVisualsProjection` (lenient per entry: invalid entries dropped).
    - Wire it into `parseAidenRemoteChatProjection` (~:2668) and the window parser.
    - Fixture gates for revision 27.
  - `main/services/aiden-remote-router.ts:1721-1784`: advertise `chat-visuals-v1`.
  - `protocol/aiden-remote/v1/openapi.json`: the `Message` schema gains `visuals` (additionalProperties false on items).
  - `protocol/aiden-remote/v1/fixtures/contract.json`:
    - `contractRevision` 27 (lines 2 and 1475).
    - The `chat` and `messagesWindow` fixtures gain an assistant message with a tool timeline step `call-1` (`render_ui`) and `call-2` (`render_artifact`), two `visuals` (one ui, one html), the snapshot attachments, and `htmlArtifacts` for the html one.
    - A `features` list including `chat-visuals-v1`.
  - `docs/aiden-remote-api-v1.md`: §4 message fields, §5 features, and the change log.
  - Desktop tests that pin the revision: `aiden-remote-protocol.test.ts:121`, `aiden-remote-operation-contract.test.ts:900`, `aiden-remote-router.test.ts:3958`.
- Test: extend `main/services/aiden-remote-chats.test.ts` (or the projection's existing suite):
  - Projection output for a message with both kinds.
  - An invalid ui visual is dropped while its message survives.
  - Changing a snapshot changes `chatRevision`.
  - No key in the projected chat matches the private-key set (run the projection through the same validator the router uses).

- [ ] **Step 1: Write the failing tests and update the fixtures.**
- [ ] **Step 2: Run** `npm run test:aiden-remote`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:aiden-remote`, `npx tsc --noEmit` and `npm run test:ci-policy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): project inline visuals with snapshots (contract revision 27)`.

### Task 4: iOS: decode and show visuals inline

**Files:**
- Modify:
  - `ios/AidenOnTheGo/Models/AidenChat.swift`:
    - `AidenChatVisual` (Codable, Equatable): `id`, `kind` (`ui`/`html`, where an unknown kind decodes as `.other`), `title`, `toolCallId?`, `fallbackText?`, `snapshotAttachmentId?`, `layout?`.
    - `AidenChatMessage` decodes `visuals` with a per-entry lossy decode. Invalid entries are dropped and never fail the message. Use the `forkedFrom` `try?` pattern.
    - `isWireSafe` caps at 40.
    - `AidenChronologicalProjection.rows` gains row kind `.visual(AidenChatVisual)`, emitted right after the tool row containing the visual's `toolCallId`. Unmatched visuals trail.
  - `ios/AidenOnTheGo/Features/Remote/AidenChatFeature.swift`:
    - An `AidenVisualRowView` renders the snapshot via the existing `attachmentImageData` loader and image view, with the title as its accessibility label and `fallbackText` beneath (secondary, at most 6 lines with an expand control). It shows `fallbackText` alone when there is no snapshot.
    - Filter `visual-snapshot_` attachments out of the attachment strip.
    - Suppress the "Can't view on this device" card for an html artifact whose id has a visual with a snapshot.
  - `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift`: the `chat-visuals-v1` feature constant.
  - `ios/AidenOnTheGoTests/AidenRemotePhase0Tests.swift:139`: revision 27.
- Test: `ios/AidenOnTheGoTests/AidenChatTests.swift`:
  - The fixture chat decodes with 2 visuals.
  - Rows order is text → tool(call-1) → visual → tool(call-2) → visual → text.
  - A malformed visual (missing title) is dropped and the chat still decodes.
  - Snapshot attachments are excluded from the image attachment list.
  - The html artifact card is suppressed only when a snapshot exists.

- [ ] **Step 1: Write the failing XCTest cases.**
- [ ] **Step 2: Run:**
  ```bash
  DD=$(mktemp -d); xcodebuild build-for-testing -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO && xcodebuild test-without-building -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath "$DD" -only-testing:AidenOnTheGoTests/AidenChatTests CODE_SIGNING_ALLOWED=NO
  ```
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full `AidenOnTheGoTests` target. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): show inline visuals as snapshots at their tool row`.

### Task 5: Android: decode and show visuals inline

**Files:**
- Modify:
  - `android/app/src/main/java/.../models/AidenChat.kt`:
    - `@Immutable @Serializable data class AidenChatVisual(id, kind: String, title, toolCallId?, fallbackText?, snapshotAttachmentId?, layout?)`.
    - `AidenChatMessage.visuals` uses a lossy list serializer that drops invalid elements.
    - `isWireSafe` caps at 40.
    - `AidenChronologicalProjection.rows` gains a visual row after the matching tool row; unmatched visuals trail.
  - `features/chat/AidenChatDetailScreen.kt`:
    - An `AidenVisualRow` composable uses `AidenChatViewModel.attachmentImageData` and the image composable from `AidenMessageImageAttachments.kt`, with `contentDescription = title` and `fallbackText` beneath.
    - Filter snapshot attachments out of `aidenEligibleImageAttachments`.
    - Suppress the `chat_artifact_unsupported` surface when a snapshot exists.
  - Also cover `ActiveStreamingCard` (no visuals while streaming, per spec §9).
  - `res/values/strings.xml`: `chat_visual_snapshot_description`.
  - The Android revision assertions (`>= 25` stay valid). Add an `AidenChatVisualsContractTest`.
- Test: `android/app/src/test/.../AidenChatTest.kt`: the same five cases as iOS. Plus a Compose UI test `AidenVisualRowUiTest` (androidTest): the snapshot node has its content description and the fallback text is displayed.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** `cd android && ./gradlew :app:testDebugUnitTest --tests '*AidenChatTest*' --tests '*AidenChatVisualsContractTest*'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:compileDebugAndroidTestKotlin`, and `:app:connectedDebugAndroidTest --tests '*AidenVisualRowUiTest*'` when an emulator is available. Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): show inline visuals as snapshots at their tool row`.

### Task 6: Turn on visuals for phone-sent turns

**Files:**
- Modify:
  - `main/services/conversation-surface-generation.ts`: `remoteGenerationSurface` drops the forced `inlineVisuals: "off"`, because phones can now see snapshots. Phone turns follow the desktop Appearance setting.
  - The spec §7 note and `docs/pi-gui-artifacts.md`.
- Test: update the existing surface-matrix test that asserted `off` so it asserts that phone turns follow the setting.

- [ ] **Step 1: Update the test.** **Step 2: Run** it. Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): phone-sent turns can draw visuals`.

### Task 7: Docs, memory, and full verification

- [ ] Update:
  - `docs/pi-gui-artifacts.md` (snapshots, Remote)
  - `.memory/inline-generative-ui.md` (decisions: no tree on the wire, reserved snapshot ids, light-only snapshots, auxiliary window filtering)
  - `docs/plans/README.md` (Phase 2 and 3 status)
  - `docs/aiden-remote-api-v1.md`
- [ ] Run everything:
  - Desktop: `npm test`, `npm run test:aiden-remote`, `npm run test:generative-ui`, `npx tsc --noEmit`, `npm run lint`, `npm run test:ci-policy`
  - E2E specs touched
  - iOS: the full `AidenOnTheGoTests`
  - Android: `:app:testDebugUnitTest :app:lintDebug :app:compileDebugAndroidTestKotlin`, plus the connected UI test if an emulator is available

  All green.
- [ ] Commit `docs(visuals): phase 3 snapshots and Remote contract`.
