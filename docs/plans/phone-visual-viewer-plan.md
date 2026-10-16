# Interactive visuals on phones (tap to open)

Owner decision 2026-10-16: phones keep the inline snapshot and open a visual full screen in a locked-down web view when it is tapped. This is the "Open interactive" step that the [inline generative UI spec](../superpowers/specs/2026-10-08-inline-generative-ui-design.md) §9 left optional. Live inline web views and native catalog renderers were considered and not chosen (see the thread "Charts and visuals" in the Aiden project).

## Goal

A chart or widget in a reply on iOS or Android behaves like it does on the Mac when opened: tooltips, tabs, sliders, zoom and Plotly interactions work, in the phone's own theme and light or dark scheme. Both kinds of visual are covered:

- `render_ui` (native catalog tree, the model's default) is drawn by the same React `AidenUiBlock` the desktop uses.
- `render_artifact` (sandboxed HTML) runs in the same opaque-origin `sandbox="allow-scripts"` iframe and CSP as desktop, with the host libraries it uses inlined.

## Contract (Remote revision 34, `chat-visual-viewer-v1`)

Provisional: re-claim the next revision after `main`'s at merge.

- **Feature token** `chat-visual-viewer-v1`. Announced only when the host has chats and its viewer bundle is installed (`build/renderer/visual-viewer/`). Clients without it keep today's snapshot behaviour (tap opens the image viewer).
- **No new key on visual entries.** `visuals` entries are parsed with a closed key set on every client, so a new key would drop every visual on older phones. Any visual on a host announcing the token can be opened.
- **`GET /chats/{chatId}/visuals/{visualId}/document`**
  - Auth: `chat:read` and current read access to the chat (same as attachment content).
  - Query (both optional, nothing else allowed): `scheme=light|dark` (default `light`), `theme=<preset id>` from `protocol/aiden-appearance-v1.json` (default `aiden`; an id the host does not know falls back to `aiden`, a malformed one is `invalid_request`).
  - `visualId` is an id the chat projection lists in some message's `visuals`.
  - 200 `text/html; charset=utf-8`, a self-contained document (no subresources), with `content-security-policy` matching its meta policy, `cache-control: no-store`, a strong `etag`, and gzip when the client accepts it. A matching `If-None-Match` gets 304. Bounded at 12 MiB uncompressed.
  - 404 `not_found` for an unknown chat, visual, missing HTML or a host without the viewer bundle. 400 `invalid_request` for a bad query.
- **Document behaviour** (what native hosts must provide):
  - Load the body as an HTML string with no base URL (`loadHTMLString(_:baseURL: nil)` / `loadDataWithBaseURL(null, …)`), JavaScript on, every other navigation and every window open denied, no file or content access, non-persistent storage, no auto-playing media.
  - The page talks to native only through one message channel: iOS `window.webkit.messageHandlers.aidenVisual.postMessage(object)`, Android `window.AidenVisualBridge.postMessage(jsonString)`. Messages (closed set, unknown types ignored):
    - `{"type":"ready"}` once the visual has drawn.
    - `{"type":"prompt","text":"…"}` when the visual asks for a follow-up (`sendPrompt` in HTML, a `sendPrompt` action in `render_ui`). The page has already bounded it to 2,000 characters and one per 3 s. Native shows its own confirmation (quote the text, **Add to message** and **Dismiss**); **Add to message** closes the viewer and appends the text to the chat composer. It never sends by itself, matching desktop's confirm-only rule.
    - `{"type":"openUrl","url":"https://…"}` for a `render_ui` `openUrl` action. Native asks before opening it in the system browser; only `https:` is accepted.
- **Offline.** Phones cache the last document per host, chat, visual, scheme and theme (bounded, app caches directory) and show it when the Mac is unreachable, with a note that it may be out of date.

## Desktop

1. `renderer/visual-viewer/main.tsx`: the viewer page. Reads its payload from `<script type="application/json" id="aiden-visual-payload">`, applies the preset tokens for the scheme (pure `resolveThemeTokens`, no storage), and renders either `AidenUiBlock` or the sandboxed HTML guest with resize, theme and prompt bridging.
2. `vite.visual-viewer.config.ts`: a library build (one IIFE script plus one stylesheet, assets inlined) into `build/renderer/visual-viewer/`, run after the main renderer build, so it ships in `app.asar` with the renderer.
3. `main/services/visual-viewer-document.ts`: Electron-free builder. Escapes the payload, inlines only the host libraries an HTML visual references, and wraps everything under the viewer CSP.
4. `AidenRemoteChatService.visualDocument(chatId, visualId, options)` finds the visual on the authoritative chat, loads HTML from the artifact store or the tree and its images from the message, and builds the document.
5. Router route `chatVisualDocument`, feature token, revision 34, OpenAPI, docs and the contract fixture.

## Phones

- **iOS:** `AidenVisualViewer` (full-screen cover over a `WKWebView` with a non-persistent `WKWebsiteDataStore`, one `WKScriptMessageHandler`, navigation delegate denying everything after the initial load). The client gains `visualDocument(chatId:visualId:scheme:theme:)`. Tapping a snapshot opens the viewer when the host announces the token; the image viewer stays available from the viewer's menu.
- **Android:** `AidenVisualViewerScreen` (full-screen dialog hosting an `android.webkit.WebView` with file and content access off, `WebViewClient.shouldOverrideUrlLoading` returning true, `setSupportMultipleWindows(false)`, one `@JavascriptInterface` object). Same client call, same tap behaviour.

## Tests

- Desktop: builder units (payload escaping, CSP, library selection, size bound), chat service lookups, router register-and-invoke (auth, query validation, 404s, ETag, gzip), protocol fixture, and a Playwright test that loads the built document in Chromium, checks a `render_ui` chart and an HTML visual draw with the network blocked, and that a prompt reaches the native channel only through the bridge.
- iOS and Android: client request shape and decoding, the viewer's message parsing (unknown types and oversize prompts ignored), cache fallback, and the feature-gated tap behaviour.

## Status

- 2026-10-16: plan written; implementation in progress on `claude/project-thread-jxkc0z`.
