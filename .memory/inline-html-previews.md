# Inline HTML, SVG and visual previews — 2026-11-18

Plan: `docs/plans/inline-html-previews-plan.md`, written 2026-11-16. It ships in one PR covering all eight tasks: the viewer crash reload and "Open interactive" (Tasks 1–2), the iOS preview stack (Tasks 3, 4, 6, 7, 8) and the desktop SVG Preview (Task 5).

## iOS no-network preview stack
- `ios/AidenOnTheGo/Features/Remote/AidenSandboxedHTMLView.swift` is the one web view for agent HTML on the phone. It takes `html`, `allowsScripts`, `themeCSS`, `scrolls`, `onLinkOffer` and `onFailure`.
  - **Network:** the `WKContentRuleList` "aiden-preview-no-network" blocks `^https?://` and `^wss?://`. It is compiled and added before `loadHTMLString(baseURL: nil)`, and the load fails closed if it can't compile. ATS blocks IP hosts, so the live listener tests use `localhost`, never `127.0.0.1`.
  - **Blocked APIs:** WebRTC and WebTransport constructors are deleted in the page world, in every frame, at document start.
  - **Page isolation:** there are no message handlers, `createWebViewWith` returns nil, the main frame stays on `about:blank`, subframes may only be `about:blank` or `about:srcdoc`, and media and motion permissions are denied.
  - **Loads once:** `updateUIView` never reloads. Callers reload by changing SwiftUI `.id(...)`; Task 7 keys it on the theme CSS, a hash of the draft and a retry counter.
  - **Link offers:** https links are offered only through `AidenLinkOfferGate`: one offer per real tap, within 1.0 s of the touch ending, and only if the finger moved less than 10 pt, so scrolls don't count.
    - The touch recorder is a never-recognizing `UIGestureRecognizer` on the `WKWebView`; a UI test proves a real tap gets through.
    - Without a touch, VoiceOver, Switch Control or a hardware keyboard (`GCKeyboard`) get at most 3 offers per document, 2 s apart.
    - Voice Control has no public signal, so its activations are dropped. This is documented.
    - DEBUG builds set `touchlessActivationOverride` because the simulator passes the Mac keyboard through as a `GCKeyboard`.
- `AidenWebContentRecovery` (`AidenVisualDocument.swift`) is shared by the visual viewer and the sandboxed view. It reloads once after a WebContent crash, and fails only on a crash loop; see the final-review fix.
- `AidenHTMLPreviewTheme.css` puts every rule under `:where()`, so any style of the page's own wins. Its variables are named after desktop's `GENERATIVE_UI_THEME_VARIABLES`, so one agent instruction works on both.
- SVG (`Features/Chat/AidenSVGPreview.swift`):
  - The drawing is a base64 `data:image/svg+xml` `<img>` on a white card.
  - XMLParser validates the root, and `xmlns` is added when the root has none. A root with `xmlns=""` or another namespace returns nil.
  - The cap is 1 MiB, but in practice replies over 80,000 characters or 2,000 lines render as plain text first.
- DEBUG launch-argument fixtures live in `Features/Remote/Demo/AidenPreviewFixtureView.swift`, the whole file under `#if DEBUG`: `-AidenPreviewFixture`, `-AidenSVGFixture`, the workspace HTML fixture and `-AidenWorkspaceHTMLFixtureFromActivity`. The UI tests that use them are `AidenSandboxedHTMLUITests` and `AidenWorkspaceHTMLUITests`.
- New iOS source and test files must also be listed in `scripts/check-ios-shipping-target.test.mjs`. Task 3 forgot this at first.

## Desktop
- `renderer/lib/svg-fence-preview.ts` and the `CodeBlock` `previewable` prop give an `<img>` data URL. Restricted (render_ui) Markdown overrides `code` with `previewable=false`. The e2e spec is `tests/e2e/svg-code-preview.spec.ts`.

## Deferred
- Android for Tasks 3–8, including the "File written" tap; Android's line is still plain text at `AidenChatDetailScreen.kt:~2425`.
- Mermaid, which waits for owner approval of a bundled engine.
- A loading indicator once the page starts loading.
- Serving relative resources through a `WKURLSchemeHandler`.
