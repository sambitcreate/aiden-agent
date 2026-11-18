# Inline HTML, SVG and Visual Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use what Hermex learned shipping HTML reports in chat (Hermex PRs #1645, #1651, #1654, #1703, #1714) to remove Aiden iOS's dead ends around agent-made visuals and HTML. Fewer "Can't view" cards, SVG code blocks you can look at, and HTML files the agent wrote opening rendered.

**Architecture:** Aiden keeps the inline PNG snapshots the Mac renders, and keeps its rule that no page loads anything from the network. Hermex instead keeps web views live in the chat and lets pages load remote resources; we are not copying either. On iOS we add one shared, locked-down preview web view: no network (a native content rule list), wiped storage, no message handlers, no navigation, and links opened only after the person confirms. SVG code blocks, the theme variables and `.html` workspace files build on it. Desktop gets the same SVG code-block preview, rendered as an `<img>`.

**Tech Stack:** SwiftUI + WebKit (`WKWebView`, `WKContentRuleListStore`), XCTest; Kotlin/Compose for Android parity; React + `tsx --test` on desktop.

**Spec:** this plan, which comes from the Hermex comparison of 2026-11-16. Hermex reference code lives in `/Users/sambitbiswas/projects/opp/hermex` (`HermesMobile/Features/Chat/HTMLReport.swift`, `HTMLReportWebView.swift`, `TranscriptHTMLReportView.swift`).

## Global Constraints

- No new third-party dependencies on any platform (`ios/AGENTS.md` Delivery rules). Mermaid is deferred for this reason; see the end of this plan.
- No Remote protocol change, new endpoint or new JSON shape. Every task uses routes that already exist: the visual document route and the workspace file routes.
- Preview pages never touch the network:
  - http(s) and ws(s) loads are blocked by a `WKContentRuleList`, which is awaited and installed before the first load;
  - WebRTC is outside what rule lists can filter, so `RTCPeerConnection` and `webkitRTCPeerConnection` are deleted by a page-world `.atDocumentStart` script in every frame;
  - storage is `.nonPersistent()`, pages load with `loadHTMLString(_, baseURL: nil)`, and there are no script message handlers;
  - never add an App Transport Security exception to the app's `Info.plist` for tests or anything else.
- A preview page never navigates its top frame. A tapped `https` link without credentials (`AidenVisualViewerMessage.externalURL`) opens only after an "Open link?" confirmation, the one the visual viewer already uses.
- Every new Swift file is added to `ios/AidenOnTheGo.xcodeproj/project.pbxproj` (file reference, group, build file, Sources phase) in the app or test target. The project does not use synchronized folders.
- Tests are behavioral. No `readFileSync` or source-grep checks, and no exact class-string checks (root `AGENTS.md` § Tests).
- Before adding UI, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Use palette and semantic tokens, keep visible `focus-visible` rings on desktop buttons, and respect Reduce Motion.
- The one fixed color allowed is the white drawing surface behind SVGs (`#fff`), in both light and dark mode. It is content paper, because agent SVGs usually draw black on a transparent background. Call it out in the PR.
- Docs change in the same PR as behavior: `ios/README.md`, `android/README.md`, `docs/pi-gui-artifacts.md` and `docs/aiden-remote-api-v1.md` where they describe what phones show (Task 2), `README.md` / `PRODUCT.md` feature lines if affected, and this plan's row in `docs/plans/README.md`.
- Android parity: only Task 2 changes Android. Android also has code blocks, a workspace file viewer (`features/workspaces/AidenWorkspaceEnvironmentScreen.kt`) and the produced-file label (`AidenChatDetailScreen.kt:2384`). Tasks 3–8 on Android are an explicit follow-up, out of scope here.
- iOS test command, from the repository root, with an explicitly chosen simulator and a fresh result path for each run:
  `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath /tmp/aiden-html-previews-derived -resultBundlePath "/tmp/aiden-html-previews-$(date +%s).xcresult" -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile -collect-test-diagnostics never -only-testing:AidenOnTheGoTests/<Suite>`
- Android command: `cd android && ./gradlew --offline :app:testDebugUnitTest --tests 'sbtbiswas.AidenOnTheGo.AidenChatTest'`.

## Review Focus

1. **A huge SVG fence** (megabytes of path data) must not freeze scrolling or the sheet. Source over 1 MiB (UTF-8) gets no View button (Tasks 4 and 5), and the simulator check opens a source just under the cap.
2. **An SVG or HTML that names remote resources** (`<image href="https://…">`, `<link rel=stylesheet>`, `fetch`, `WebSocket`, `RTCPeerConnection`) must make zero network connections (Task 3 listener test and WebRTC test).
3. **A redirect the page triggers itself** (`<meta http-equiv="refresh" content="0;url=https://…">`, `location = …`, `window.open`) must not navigate or open a window (Task 3 decision tests).
4. **An HTML file over the workspace size cap** (`truncated == true`) must not show a half page as if it were whole. It opens on Source with a note (Task 7).
5. **The web content process crashing again and again** must stop retrying and show Retry, in the viewer and in previews (Tasks 1 and 3 share `AidenWebContentRecovery`).

## Suggested PRs

- **PR A, viewer fixes:** Tasks 1–2 (iOS + Android).
- **PR B, iOS previews:** Tasks 3, 4, 6, 7, 8.
- **PR C, desktop:** Task 5.

PR C is independent. PR B builds on PR A, because Task 3 uses `AidenWebContentRecovery` from Task 1: merge A first, or stack B on A. PR B's tasks run in order.

---

### Task 1: Limit the visual viewer's crash reloads (iOS)

Today [AidenVisualViewer.swift:350](../../ios/AidenOnTheGo/Features/Remote/AidenVisualViewer.swift) reloads every time the web content process dies, which loops forever on a page that keeps killing it. Android already stops and shows a message ([AidenVisualViewerScreen.kt:231](../../android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/chat/AidenVisualViewerScreen.kt)). Match Android: reload once, then show the viewer's existing failure state with Retry.

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Remote/AidenVisualDocument.swift` (add the value type next to `AidenVisualNavigationPolicy`)
- Modify: `ios/AidenOnTheGo/Features/Remote/AidenVisualViewer.swift:240-355`
- Test: `ios/AidenOnTheGoTests/AidenVisualViewerTests.swift`

**Interfaces:**
- Produces: `struct AidenWebContentRecovery: Equatable, Sendable { enum Action: Equatable { case reload, fail }; mutating func processDidTerminate() -> Action; mutating func documentDidLoad() }`. `documentDidLoad()` resets the budget after a successful new `load`, not after a crash reload.

- [ ] **Step 1: Write the failing test** `testWebContentReloadsOnceThenFailsUntilANewDocumentLoads`. Create a fresh recovery. The first `processDidTerminate()` returns `.reload` and the second `.fail`. After `documentDidLoad()`, the next call returns `.reload` again.
- [ ] **Step 2: Run** `-only-testing:AidenOnTheGoTests/AidenVisualViewerTests`. Expected: FAIL, `AidenWebContentRecovery` is not in scope.
- [ ] **Step 3: Implement** `AidenWebContentRecovery`. In `AidenVisualWebViewCoordinator`, keep one instance: call `documentDidLoad()` inside `load(_:documentID:in:)` when `documentID` changes, and on `webViewWebContentProcessDidTerminate` reload on `.reload` and call a new `onProcessFailure: () -> Void` on `.fail`. `AidenVisualWebView` gains `let onProcessFailure: () -> Void`. `AidenVisualViewer` passes `{ phase = .failed(String(localized: "This visual stopped responding.")) }`. Retry (`attempt += 1`) already reloads the document from the Mac.
- [ ] **Step 4: Run the suite again.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(ios): stop reloading a visual whose page keeps crashing`.

### Task 2: Offer "Open interactive" for HTML visuals without a snapshot (iOS + Android)

When the Mac's snapshot is missing (snapshot render failed or is still pending), both phones show "Can't view on this device. View in Aiden Agent." That happens even when the Mac announces `chat-visual-viewer-v1`, and the document route serves any visual the projection lists (`docs/aiden-remote-api-v1.md` § Phone visual viewer, revision 35). With the viewer available, the visual should get its row (title card plus **Open interactive**) and the card should go away.

**Files:**
- Modify: `ios/AidenOnTheGo/Models/AidenChat.swift:300-316` (`rowVisuals`, `unviewableHtmlArtifacts`)
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatRows.swift:365,428,485`, in `AidenMessageView` (`:172`), which has no `visualViewerAvailable`. Pass `loadVisualDocument != nil` (`:197`); its `==` already compares whether it is nil (`:218`). `messageChronologicalRows` needs the same flag.
- Modify: `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/chat/AidenChatDetailScreen.kt:1715-1736` (`aidenUnsupportedHtmlArtifacts`, `aidenVisualHasRow`, `aidenVisualsWithRows`) and their callers (`:1471`, the notice list).
- Modify: the Android `AidenVisualRow` no-snapshot branch (`AidenChatDetailScreen.kt:1772-1781`). Today it draws only a title surface and never uses `onOpenInteractive`. Add an **Open interactive** button below the title or fallback when `onOpenInteractive != null`, using the existing string `chat_visual_open_interactive` and an `AidenVisualViewerRequest` with `snapshot = null`. iOS already has this button (`AidenChronologicalTranscript.swift:654`).
- Test: `ios/AidenOnTheGoTests/AidenChatTests.swift` (next to `testHtmlArtifactCardIsReplacedOnlyByAVisualWithASnapshot`, `:6993`), `android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenChatTest.kt` (next to `:2254`).

**Interfaces:**
- Produces (iOS): `static func rowVisuals(in message: AidenChatMessage, viewerAvailable: Bool) -> [AidenChatVisual]` and `static func unviewableHtmlArtifacts(in message: AidenChatMessage, viewerAvailable: Bool) -> [AidenHtmlArtifact]`. Remove the one-argument forms, since pre-1.0 means no compatibility shims.
- Produces (Android): `aidenVisualHasRow(visual, attachments, viewerAvailable: Boolean)`, `aidenVisualsWithRows(message, viewerAvailable: Boolean)`, `aidenUnsupportedHtmlArtifacts(message, viewerAvailable: Boolean)`.

- [ ] **Step 1: Write the failing iOS test** `testWithTheViewerAnHtmlVisualWithoutASnapshotGetsARowInsteadOfTheCard`. Use the existing `visualFixtureMessage` with `snapshotAttachmentId` removed. With `viewerAvailable: true`, `rowVisuals` ids include `"artifact_fixture_01"` and `unviewableHtmlArtifacts` is `[]`. With `viewerAvailable: false`, today's result holds: the card is kept and there is no row. The legacy message without `visuals` keeps its card either way, because it has no visual id to open.
- [ ] **Step 2: Write the failing Android test** `htmlVisualWithoutSnapshotGetsRowWhenViewerAvailable`, with the same assertions in Kotlin.
- [ ] **Step 3: Run both.** Expected: compile failures (unknown `viewerAvailable` argument).
- [ ] **Step 4: Implement.** An html visual has a row if it has a snapshot, or if `viewerAvailable` is true. An artifact is unviewable only if no visual with its id has a row. Update callers: iOS passes `visualViewerAvailable` (already a row property, `AidenChatRows.swift:59`), and Android passes `canOpenInteractiveVisuals` (`AidenChatDetailScreen.kt:963`). Update every existing test that calls the old forms to pass `viewerAvailable: false`, which keeps their current assertions: `AidenChatTests.swift:6995-7022`, `:7080`, `:7089`, `:7099`, `:7101`, `:7106`, `:7112`; `AidenChatTest.kt:2254-2267`, `:2312-2321`; and `AidenChatVisualsContractTest.kt:68`. Without the last one the Android test source set won't compile. Re-grep both test trees for the function names before running. Update the doc comments above both functions, because the existing comment says an html visual without a snapshot "gets none".
- [ ] **Step 5: Run both again.** Expected: PASS. Also run the full `AidenChatTests` and `AidenVisualViewerTests` suites, since rows changed.
- [ ] **Step 6: Emulator check (Android).** With a Mac that offers the viewer, a snapshot-less html visual shows its title and Open interactive, and the viewer opens. Record the emulator in the PR.
- [ ] **Step 7: Docs.** Neither README describes visuals today. Update `docs/pi-gui-artifacts.md` item 56 ("a client without the snapshot still shows…"), `docs/aiden-remote-api-v1.md:677-681` and `:806-813` to say: "A phone without the snapshot shows the title with Open interactive when the Mac offers the viewer, and the 'Can't view on this device' card only when it doesn't." Add one sentence saying the same to `ios/README.md` and `android/README.md`.
- [ ] **Step 8: Commit** `fix(mobile): open HTML visuals that have no snapshot instead of saying they can't be viewed`.

### Task 3: Shared locked-down preview web view (iOS)

This is the foundation for Tasks 4 and 7. It is one `WKWebView` wrapper that loads a string and can't reach the network, storage, the app or another page.

**Files:**
- Create: `ios/AidenOnTheGo/Features/Remote/AidenSandboxedHTMLView.swift`
- Test: `ios/AidenOnTheGoTests/AidenSandboxedHTMLTests.swift` (new; register in pbxproj)

**Interfaces:**
- Consumes: `AidenWebContentRecovery` (Task 1), `AidenVisualViewerMessage.externalURL(_:)`.
- Produces:
  - `enum AidenPreviewNavigation { enum Decision: Equatable { case allow, cancel, offerLink(URL), anchor(String) }; static func decision(url: URL?, isMainFrame: Bool?, isLinkTap: Bool, hasLoaded: Bool) -> Decision }`. `isMainFrame == nil` means a new window.
  - `enum AidenPreviewNetworkBlock { static let identifier = "aiden-preview-no-network"; static let rulesJSON: String; @MainActor static func ruleList() async throws -> WKContentRuleList }`. The rule list is compiled once and cached in a static.
  - `struct AidenSandboxedHTMLView: UIViewRepresentable { let html: String; let allowsScripts: Bool; let themeCSS: String?; let scrolls: Bool; let onLinkOffer: (URL) -> Void; let onFailure: () -> Void }`. The view stays transparent (`alpha = 0`) until `didFinish`, so a dark preview never flashes white.
  - The view loads once per instance. To reload, callers change its SwiftUI identity with `.id(…)`: Task 6's CSS string, Task 7's retry counter.

- [ ] **Step 1: Write the failing decision tests** `testPreviewNavigationAllowsOnlyItsOwnDocumentAndOffersTappedHttpsLinks`:
  - before load, `about:blank` main frame gives `.allow`;
  - after load, a main-frame `https://example.com` that is not a tap (meta refresh, `location =`) gives `.cancel`;
  - a tapped `https://example.com/a` gives `.offerLink(URL)`;
  - a tapped `https://u:p@example.com` gives `.cancel`, and so do tapped `javascript:alert(1)`, `file:///etc/hosts` and `http://example.com`;
  - `isMainFrame: nil` (new window) gives `.cancel`, except a tapped https link, which gives `.offerLink`;
  - after load, a tapped `about:blank%23notes` and a tapped `about:blank#notes` both give `.anchor("notes")`;
  - subframes: `about:srcdoc` and `about:blank` give `.allow`, `https://…` gives `.cancel`.
- [ ] **Step 2: Write the failing rules test** `testPreviewRulesBlockEveryNetworkScheme`. Decode `rulesJSON`. It holds exactly two rules, `url-filter` `^https?://` and `^wss?://`. They have to be separate rules because WebKit's `url-filter` has no `|`. Both have `action.type == "block"`, and their filters, run as `NSRegularExpression`, match `http://a`, `https://a`, `ws://a` and `wss://a` but not `about:blank`, `about:srcdoc` or `data:image/svg+xml,`.
- [ ] **Step 3: Write the failing integration test** `testAPreviewPageMakesNoNetworkConnections`:
  - start an `NWListener` (TCP) on an ephemeral port and count accepted connections;
  - use the host `localhost`, not `127.0.0.1`. From iOS 17, App Transport Security refuses IP-address hosts by default, so with an IP the control below would also connect zero times and prove nothing. Don't add an ATS exception;
  - the page, loaded with `allowsScripts: true`, holds `<img src="http://localhost:PORT/i.png">`, `<link rel=stylesheet href="http://localhost:PORT/s.css">`, `<script>fetch('http://localhost:PORT/f');new WebSocket('ws://localhost:PORT/w')</script>`, and a `<meta http-equiv="refresh" content="0;url=http://localhost:PORT/r">`;
  - **control first:** the same page in a plain `WKWebView` without the rule list fulfils an `XCTestExpectation` on its first accepted connection (timeout 10 s). If the control can't connect, the test fails, rather than passing with nothing proven;
  - **sandboxed:** wait for `didFinish`, then wait at least as long as the control took to connect plus 2 s, and assert 0 connections.
- [ ] **Step 3b: Write the failing test** `testPreviewPagesCannotOpenWebRTCConnections`. Load a page with an `about:srcdoc` iframe into `AidenSandboxedHTMLView` with `allowsScripts: true`. With `callAsyncJavaScript(… in: .page)`, `typeof RTCPeerConnection` and `typeof webkitRTCPeerConnection` evaluate to `"undefined"` in the main frame and in the iframe (reached through `WKFrameInfo` from `didFinish`, or `frames[0]`).
- [ ] **Step 4: Run** `-only-testing:AidenOnTheGoTests/AidenSandboxedHTMLTests`. Expected: FAIL (types missing).
- [ ] **Step 5: Implement** `AidenSandboxedHTMLView`. Its configuration matches `AidenVisualWebView` (`.nonPersistent()`, no automatic windows, media needs a tap, no AirPlay or PiP, `dataDetectorTypes = []`, no link preview, no back/forward gestures, clear background), with these differences:
  - `allowsContentJavaScript = allowsScripts`;
  - `makeUIView` is synchronous but the rule list compiles asynchronously. The coordinator starts a task that awaits `AidenPreviewNetworkBlock.ruleList()`, adds it to `webView.configuration.userContentController`, and only then calls `loadHTMLString`. If the list can't compile, the page fails closed with `onFailure()` and nothing loads;
  - there is no `WKScriptMessageHandler`;
  - `themeCSS` is inserted as `<style id="aiden-preview-theme">`, the first child of `document.documentElement`, by a `.atDocumentStart` `WKUserScript` in `.defaultClient`, main frame only. It runs even with page scripts off (`WKWebpagePreferences.h`). Nothing is parsed at document start, so the same script waits for `DOMContentLoaded` before adding `<meta name=viewport content="width=device-width, initial-scale=1">` to `<head>`, and only when the page has no viewport meta;
  - when `allowsScripts` is true, a second `.atDocumentStart` script in the `.page` world, for all frames (`forMainFrameOnly: false`), deletes `RTCPeerConnection`, `webkitRTCPeerConnection` and `RTCDataChannel` from `window`;
  - `.anchor` scrolls with `callAsyncJavaScript(… scrollIntoView() …, in: .defaultClient)`;
  - process crashes go through `AidenWebContentRecovery`, with `.fail` calling `onFailure`;
  - `createWebViewWith` always returns nil, after offering a tapped https link;
  - camera, microphone and motion permission requests are denied.
- [ ] **Step 6: Run the suite again.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(ios): add a no-network sandboxed HTML preview view`.

### Task 4: View button on SVG code blocks (iOS)

**Files:**
- Create: `ios/AidenOnTheGo/Features/Chat/AidenSVGPreview.swift`
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatMarkdown.swift:180-184` (open fence passes `isOpen: true`), `:220-224` (closed fence), `:335-418` (`AidenCodeBlockView` header and sheet)
- Test: `ios/AidenOnTheGoTests/AidenChatMarkdownTests.swift`

**Interfaces:**
- Consumes: `AidenSandboxedHTMLView` (Task 3).
- Produces:
  - `enum AidenSVGPreview { static let maximumSourceBytes = 1_048_576; static func offersView(language: String?, source: String, isOpen: Bool) -> Bool; static func document(for source: String) -> String? }`.
  - `AidenCodeBlockView.init(source:language:isOpen: Bool = false, copyController:)`.

**Decisions:**
- `offersView` is true only for a closed fence, a language that normalizes to `svg` (case-insensitive), source that isn't empty, and source of at most 1 MiB. A closed fence inside a reply that is still streaming counts, because its source is final.
- `document(for:)` trims the source and parses it with `XMLParser` (`shouldProcessNamespaces = true`); the root element's local name must be `svg`, otherwise `nil`. A standalone `image/svg+xml` image draws blank without the SVG namespace, and agent SVG often leaves it out. When the root has no namespace, insert ` xmlns="http://www.w3.org/2000/svg"` right after the opening `<svg`; when it has another namespace, return `nil`. Then base64-encode the result, and wraps it as `<img src="data:image/svg+xml;base64,…" alt="">` on a white card (`#fff`, `border-radius:12px`, `padding:12px`, `img{display:block;max-width:100%;height:auto;margin:0 auto}`). An SVG used as an `<img>` runs no script and fetches nothing. The preview uses `allowsScripts: false` and the network block as belts and braces. Pinch-zoom stays on.
- Header: a `View` button with the `eye` symbol, placed before Copy, at least 44×44. Its accessibility label is "View drawing", and it matches Copy's style.
- It opens a `.sheet` with a `NavigationStack` titled "Drawing", a Done button, and `AidenSandboxedHTMLView(html:, allowsScripts: false, themeCSS: nil, scrolls: true, …)`. `XMLParser` runs in a detached task, with a `ProgressView` until it finishes. If `document(for:)` returns nil or `onFailure` fires, the sheet shows "Couldn't draw this SVG." (with a warning symbol, palette tokens) and the code block stays unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `testOnlyAClosedSmallSvgFenceOffersView`: `("svg", "<svg/>", false)` → true; `("SVG", …)` → true; `isOpen: true` → false; `("xml", …)` → false; `nil` language → false; a whitespace-only source → false; 1 MiB + 1 byte → false.
  - `testAnSvgDocumentDrawsAsAnImageAndMalformedSourceDoesNot`: `document(for: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>")` contains `data:image/svg+xml;base64,` and the base64 of the trimmed source; `document(for: "<svg><rect></svg>")` → nil; `document(for: "<html></html>")` → nil.
  - `testAnSvgWithoutItsNamespaceGetsOne`: `document(for: "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>")` decodes (base64) to a string that starts with `<svg xmlns="http://www.w3.org/2000/svg"`; a root in another namespace (`<x:svg xmlns:x="urn:other"/>`) → nil.
- [ ] **Step 2: Run** `-only-testing:AidenOnTheGoTests/AidenChatMarkdownTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `AidenSVGPreview` and the header button and sheet, as decided above.
- [ ] **Step 4: Run the suite again.** Expected: PASS. Then run `AidenStreamingPerformanceTests` to confirm that open fences keep their identity.
- [ ] **Step 5: Simulator check.** Send a reply containing an `svg` fence, confirm View works in light and dark, and save a screenshot for the PR. Also open an SVG just under 1 MiB and confirm the transcript keeps scrolling and the sheet shows a spinner, not a hang.
- [ ] **Step 6: Docs.** Start a "Previews" section in `ios/README.md`: finished `svg` code blocks have View, which shows the drawing on a white card with no scripts and no network. Tasks 6–8 add to this section.
- [ ] **Step 7: Commit** `feat(ios): view SVG code blocks as drawings`.

### Task 5: Preview toggle on SVG code blocks (desktop)

**Files:**
- Create: `renderer/lib/svg-fence-preview.ts`, `renderer/lib/svg-fence-preview.test.ts`
- Modify: `renderer/components/code-block.tsx` (header toggle and a new `previewable` prop), `renderer/components/markdown.tsx:172-178` (passes `previewable` for chat fences; it already passes `plain` for open ones). `CodeBlock` is also used by `render_ui` (`renderer/components/aiden-ui/components.tsx:227`), which reaches native visuals and the phone viewer bundle. Leave that call site alone so the toggle never appears there.
- Test: `renderer/components/code-block.test.tsx` (new)
- Modify: `package.json`, appending both test files to `test:transcript-images`

**Interfaces:**
- Produces: `export const SVG_PREVIEW_MAX_BYTES = 1_048_576; export function svgPreviewSource(code: string, lang: string | undefined): string | null`. It returns a `data:image/svg+xml;charset=utf-8,…` URL (`encodeURIComponent`) or `null`.

**Decisions:**
- `svgPreviewSource` returns a URL only when `lang` lowercases to `svg`, the trimmed source (after an optional `<?xml …?>` prolog and comments) starts with `<svg` and ends with `</svg>`, and its UTF-8 length is at most `SVG_PREVIEW_MAX_BYTES`. The real check is decoding. `<img onError>` switches to the note "Couldn't draw this SVG.".
- `CodeBlock` gains `previewable?: boolean` (default `false`). It shows the toggle button only when `previewable && !plain` and `svgPreviewSource` isn't null. The button's accessible name is always "Preview", and `aria-pressed` carries the state (it shows the code icon while pressed). It's styled like `CopyButton`, with the same visibility on hover and focus-visible. It starts unpressed, showing the code. Preview replaces the `<pre>` with `<img alt="SVG preview">` on a white card (`#fff`, `rounded-card`, `p-3`, `max-h-[32rem]`, `object-contain`). The main window's CSP already allows `img-src data:`.

- [ ] **Step 1: Write the failing unit tests** in `svg-fence-preview.test.ts`:
  - a valid svg gives a URL starting with `data:image/svg+xml;charset=utf-8,`, and decoding it returns the trimmed source;
  - `"SVG"` language is accepted; `"xml"`, `undefined` and `"html"` give null;
  - a prolog with a comment is accepted; `<svg>` without `</svg>` gives null;
  - a source over the cap gives null.
- [ ] **Step 2: Write the failing render test** in `code-block.test.tsx` with `renderToStaticMarkup`. `<CodeBlock code={svg} lang="svg" previewable />` has a button named "Preview" with `aria-pressed="false"`. Without `previewable` (the `render_ui` case), with `plain`, and with `lang="ts"`, no such button renders.
- [ ] **Step 3: Run** `npx tsx --test renderer/lib/svg-fence-preview.test.ts renderer/components/code-block.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement**, as decided above.
- [ ] **Step 5: Run the tests again,** then `npm run test:transcript-images`, `npm run type-check` and `npm run lint`. Expected: PASS.
- [ ] **Step 6: Check in the running app.** A chat with an `svg` fence, toggled in light and dark mode and with keyboard focus visible. An `svg` fence missing `xmlns` must show either the drawing or "Couldn't draw this SVG.", never a blank card. Screenshot for the PR.
- [ ] **Step 7: Docs.** Find where `README.md` or `PRODUCT.md` describe chat code blocks (copy, highlighting) and add "SVG code blocks can be previewed as drawings." If neither describes them, add the line to the chat section of `PRODUCT.md`.
- [ ] **Step 8: Commit** `feat(chat): preview SVG code blocks`.

### Task 6: Theme variables for HTML previews (iOS)

Unstyled agent HTML should look like Aiden, and any style of the page's own should win. The variables are named after desktop's `GENERATIVE_UI_THEME_VARIABLES` (`renderer/shared/generative-ui-theme.ts`), so one agent instruction works on both.

**Files:**
- Create: `ios/AidenOnTheGo/Features/Remote/AidenHTMLPreviewTheme.swift`
- Test: `ios/AidenOnTheGoTests/AidenSandboxedHTMLTests.swift`

**Interfaces:**
- Produces: `enum AidenHTMLPreviewTheme { static func css(palette: AidenPalette, colorScheme: ColorScheme, uiFont: AidenUIFontID, codeFont: AidenCodeFontID, bodySize: CGFloat) -> String }`. Callers pass `AidenMarkdownMetrics.bodySize(for: dynamicTypeSize)` as `bodySize`.

**Decisions:**
- All rules sit under `:where()`, which has zero specificity: `:where(:root){<vars>;color-scheme:<light|dark>;background:var(--surface-background);color:var(--text-primary);font-family:var(--font-ui-family);font-size:<bodySize>px;-webkit-text-size-adjust:100%}`, `:where(body){margin:0;padding:16px}`, `:where(a){color:var(--accent)}`, `:where(code,kbd,pre,samp){font-family:var(--font-code-family)}`.
- Variables:

  | Variable | Source |
  | --- | --- |
  | `--surface-background` | `canvasHex` |
  | `--surface-popover` | `raisedHex` |
  | `--text-primary` | `foregroundHex` |
  | `--text-secondary` | `secondaryHex` |
  | `--border-separator` | `foregroundHex` at alpha 0.087, as `rgb(r g b / 0.087)` |
  | `--accent` | `accentHex` |
  | `--fill-accent` | `accentSolidFill.fillHex` |
  | `--fill-accent-foreground` | `accentSolidFill.contentHex` |
  | `--font-ui-family` | `system` → `-apple-system,system-ui,sans-serif`; `rounded` → `ui-rounded,-apple-system,system-ui,sans-serif`; `humanist` → `"Avenir Next",-apple-system,sans-serif` |
  | `--font-code-family` | `sfMono` → `ui-monospace,"SF Mono",Menlo,monospace`; `menlo` → `Menlo,ui-monospace,monospace`; `monaco` → `Monaco,ui-monospace,monospace` |
  | `--ui-font-size` | `<bodySize>px` |

- A theme change reloads the preview, with the view keyed on the CSS string. Hermex restyles a live page in place. That isn't worth it for a sheet.

- [ ] **Step 1: Write the failing tests:**
  - `testPreviewThemeCarriesTheAidenPaletteAsLowPriorityVariables`: for a known preset (`AidenThemeCatalog` default light), the CSS contains `--surface-background:#<canvas>` and `--accent:#<accent>`, `color-scheme:light`, and `font-size:16.0px` for `bodySize` 16. Every selector is wrapped in `:where(`; check this by parsing the selectors before each `{`.
  - `testDarkSchemeAndFontsChangeTheTheme`: dark gives `color-scheme:dark` and the dark canvas; `.rounded` gives `ui-rounded`; `.menlo` gives `--font-code-family:Menlo`.
- [ ] **Step 2: Run** `-only-testing:AidenOnTheGoTests/AidenSandboxedHTMLTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `AidenHTMLPreviewTheme.css`.
- [ ] **Step 4: Run the suite again.** Expected: PASS.
- [ ] **Step 5: Docs.** Add an "HTML previews" section to `ios/README.md` with the variable table and this prompt users can give their agent: "When you make an HTML page for me, send it as one `.html` file. Style it with `--surface-background`, `--text-primary`, `--text-secondary`, `--border-separator`, `--accent`, `--font-ui-family` and `--font-code-family` instead of fixed colors and fonts. Inline images, styles and scripts; nothing loads from the network."
- [ ] **Step 6: Commit** `feat(ios): theme HTML previews with Aiden's palette`.

### Task 7: Preview / Source for `.html` workspace files (iOS)

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Remote/AidenWorkspaceEnvironmentView.swift:488-565` (`AidenWorkspaceFileEditorView`)
- Modify: `ios/AidenOnTheGo/Models/AidenWorkspaceEnvironment.swift` (pure helper beside `AidenWorkspaceSourcePreview`)
- Test: `ios/AidenOnTheGoTests/AidenSandboxedHTMLTests.swift`

**Interfaces:**
- Consumes: `AidenSandboxedHTMLView` (Task 3), `AidenHTMLPreviewTheme.css` (Task 6).
- Produces: `enum AidenWorkspaceHTMLPreview { enum Mode: Equatable { case preview, source }; static func isHTML(_ displayPath: String) -> Bool; static func initialMode(for document: AidenWorkspaceFileDocument) -> Mode; static func canPreview(_ document: AidenWorkspaceFileDocument) -> Bool }`.

**Decisions:**
- `isHTML` is true when the path extension, lowercased, is `html` or `htm`.
- `canPreview` is `isHTML && !document.truncated`. `initialMode` is `.preview` when `canPreview`, otherwise `.source`.
- For an HTML file, a segmented `Picker` ("Preview" / "Source") goes in the principal toolbar slot. It is disabled when `!canPreview`, and then a footnote reads "This file is too large to preview."
- Preview renders `model.draft`, so unsaved edits show, with `allowsScripts: true`, the Task 6 theme, and `scrolls: true`. Edit switches to Source. Leaving Edit keeps Source.
- A link offer shows the same "Open link?" alert as the visual viewer, with the host as the message. `onFailure` shows "Couldn't display this page." with a Retry button that bumps a reload key.
- The offline cached document previews too, because nothing needs the Mac.
- Relative resources (`style.css`, `img/a.png`) don't load, since there's no base URL. Document this. Serving sibling files through a `WKURLSchemeHandler` is a possible follow-up and is not part of this plan.

- [ ] **Step 1: Write the failing test** `testHtmlWorkspaceFilesOpenOnPreviewUnlessTruncated`:
  - `report.html` (truncated false) → `.preview`;
  - `Report.HTM` → `.preview`;
  - `notes.md` → `.source` with `canPreview` false;
  - `big.html` with `truncated: true` → `.source` with `canPreview` false;
  - `html` (no extension) → `.source`.
- [ ] **Step 2: Run** `-only-testing:AidenOnTheGoTests/AidenSandboxedHTMLTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper and the editor view changes, as decided above.
- [ ] **Step 4: Run the suite again,** plus `AidenWorkspaceEnvironmentTests`. Expected: PASS.
- [ ] **Step 5: Simulator check** against a paired Mac. An HTML file with inline CSS and JS, and an HTML file naming a remote image (the image must not load) both render. Switch between Preview and Source, open a link through the confirmation, and try dark mode. Record the destination in the PR.
- [ ] **Step 6: Commit** `feat(ios): preview HTML workspace files`.

### Task 8: Tap "File written" to open the file (iOS)

Today the activity line's "File written · name" ([AidenActivityFeed.swift:146](../../ios/AidenOnTheGo/Features/Chat/AidenActivityFeed.swift)) is plain text. It should open the file through the chat's existing `./relative` link routing, which leads to `AidenWorkspaceFilesView`, and with Task 7 an HTML file opens rendered.

**Files:**
- Modify: `ios/AidenOnTheGo/Models/AidenChat.swift:384-397` (`AidenProducedFile`)
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenActivityFeed.swift:141-158`
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatDetailView.swift:240-249` (sets the environment flag from the same condition the link handler uses)
- Modify: `ios/AidenOnTheGo/Config/AidenAppearance.swift:698+` or a nearby environment file (new key)
- Test: `ios/AidenOnTheGoTests/AidenChatTests.swift`

**Interfaces:**
- Produces: `extension AidenProducedFile { var workspaceLink: URL? }` and `EnvironmentValues.aidenOpensWorkspaceFileLinks: Bool` (default `false`). `workspaceLink` returns `./` plus the percent-encoded `relativePath`, or `nil` whenever `AidenWorkspaceFileLink.path` would refuse that link. The router refuses `:`, `?`, `#`, `\`, control characters, more than 21 segments and over 4,096 bytes (`AidenWorkspaceEnvironment.swift:341-349`), and the Mac accepts POSIX colon filenames, so this happens. A nil link leaves the label as plain text.

**Decisions:**
- `AidenChatDetailView` sets `aidenOpensWorkspaceFileLinks = model.chat.botId == nil && workspace?.hasFolder == true`.
- Where that flag is true and `workspaceLink` isn't nil, the whole activity line becomes a plain `Button` that calls `openURL(link)`. A caption2 label alone is far below 44 pt; the line is wide and gets `.frame(minHeight: 44, alignment: .leading)` with `.contentShape(Rectangle())`. The text keeps its style and the file name gains an underline on press. Its accessibility hint is "Opens the file", and an accessibility action named "Open file" is added, because the row combines its children.
- Edited files get the same treatment.

- [ ] **Step 0: Verify the root.** `relativePath` is relative to the run's active workspace root (`main/services/coding-tools.ts:950-953`), and the link resolves against `GET /workspaces/{id}/files` for the chat's workspace. Confirm the two are the same folder, including for a chat in a managed worktree (`main/services/aiden-remote-workspaces.ts`, where a managed worktree appears to be its own workspace record). If they can differ, set `aidenOpensWorkspaceFileLinks` to false for that case and say so in the PR.
- [ ] **Step 1: Write the failing test** `testProducedFileLinksRoundTripThroughWorkspaceLinkRouting`:
  - for `relativePath` values `reports/q3 summary.html`, `naïve/ä.html` and `a/b/c.txt`, `AidenWorkspaceFileLink.path(file.workspaceLink!.relativeString)` equals `relativePath`, which proves the tap lands on the same file through the real router;
  - `notes:v2.html`, `a?b.html`, `a#b.html` and a 22-segment path give a nil `workspaceLink`.
- [ ] **Step 2: Run** `-only-testing:AidenOnTheGoTests/AidenChatTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `workspaceLink`, the environment key and the button.
- [ ] **Step 4: Run the suite again.** Expected: PASS.
- [ ] **Step 5: Simulator check.** Ask the agent to write `report.html` in a workspace chat, tap "File written · report.html", and confirm it opens on Preview. In a Bot chat the label stays plain text.
- [ ] **Step 6: Docs.** Add one line to `ios/README.md` under HTML previews.
- [ ] **Step 7: Commit** `feat(ios): open files the agent wrote from the activity line`.

---

## Deferred: Mermaid diagrams

This is not in scope until the owner approves a dependency. Hermex bundles Pele 1.13.0 (MIT, 733,670 bytes, `pele.global.js`), which draws Mermaid as SVG in a fresh `JSContext` with no DOM or network, off the main actor, only on tap. Its output then goes through the SVG preview (Task 4). To do this in Aiden:

- owner approval for a new bundled library on iOS (`ios/AGENTS.md`) and for desktop parity;
- a license and provenance check;
- a `THIRD_PARTY_NOTICES.md` entry;
- a desktop renderer path, since `markdown.tsx` has no Mermaid support today.

It would reuse `AidenSVGPreview.document(for:)` and `svgPreviewSource` unchanged, with `mermaid` added as a second language that goes through a `renderMermaid(source) -> svg?` step.

## Not adopted from Hermex

- **Live web views inline in the transcript** (measure-once height lock, a 3-screen cap, snapshot when off screen). Aiden's Mac-rendered PNG snapshots are cheaper and safer inline. Revisit only if we want interactive pages in the scroll itself.
- **Pages that load from the network.** This conflicts with Aiden's no-network rule for agent content.
- **Live restyle through `callAsyncJavaScript`.** A reload is enough for a sheet.
