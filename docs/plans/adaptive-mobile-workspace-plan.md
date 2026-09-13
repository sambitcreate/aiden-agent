# Adaptive mobile workspace

Status: **Active — native chat actions, Files/Changes review sheet and optional browser split implemented; 23 focused physical iPad tests passed; Duo/tailnet acceptance remains open.** September 10, 2026. Implementation branch: `feature/adaptive-mobile-workspace`.

## Product contract

Keep chat, approvals, attachments, transcript and the complete composer together. Chat’s ellipsis menu offers Rename, Archive, Changes, Files and Open Browser, with no Pin/Unpin. Files and Changes open a shared native sheet with Modified / All Files tabs, searchable expandable folders and read-only Git review. Browser opens only on explicit invocation and offers an equal chat-left/browser-right split when the allocated window has enough useful space. Subagents retains its supporting pane. A compact window shows one destination and a clear return to Chat. Preserve state through resizing, keyboard changes and pane transitions. The supplied image is a layout reference, not evidence of hardware APIs or an instruction to copy its branding.

The user clarified that **Browser means a webpage rendered on the mobile device**. A development server running on the Mac at port 3000 and listening on `0.0.0.0` is opened at `http://<Mac Tailscale IP>:3000` in WKWebView on iOS or WebView on Android. HTML, JavaScript, CSS, assets and WebSockets go directly over Tailscale. The previous shared-Mac-tab JPEG transport was the wrong interpretation and has been removed, including its routes, grants and frame/control machinery. There is no application-imposed 8–10 fps cap.

## Architecture

- Native chat sessions own existing draft, upload, voice and stream state independently of pane presentation. Layout choices use window-local space and accessibility sizing rather than device names.
- Files and Changes reuse the existing Mac-authoritative APIs, original-version checks, mutation IDs and conflict handling. Bounded recoverable file text is installation/workspace/chat/file scoped.
- Subagents uses an explicit Mac per-device grant and a separate bounded parent-scoped summary resource. Child instructions, reasoning, raw history and controls remain outside that resource. Existing parent projections are unchanged.
- Browser uses retained native web views and tabs. The local native webpage session is distinct from the desktop browser session. No video transport, Mac browser owner or observe/control grant is needed.
- `/server.developmentHost` optionally suggests the paired Mac's own running Tailscale IPv4 or `.ts.net` host. It is a bare address hint, independent of HTTPS/Serve. The user explicitly opens a port or URL; missing hints fall back to manual entry. Discovery is cached for 30 seconds and sends no page credentials.
- WebKit's HTTP web-content exception and Android's HTTP WebView configuration enable development pages. Aiden API HTTPS/pinning stays unchanged. Page navigation has no injected Aiden credential, privileged bridge or certificate bypass.
- Direct Browser navigation does not change server startup, bindings, firewall rules, ACLs, or Serve. The optional `tailscale_serve` agent tool exposes an already-running localhost HTTP server through a workspace-owned private HTTP Serve forward. It supports open/list/stop, normal Ask/Full permissions, durable ownership, and exact route checks. Tapping the returned Markdown link opens the retained native Browser.

## Native adaptation

Apple's published Duo guidance recommends window-local geometry, safe areas and useful pane fit. The installed Xcode 27.0 beta compiles the current implementation; its SDK does not declare the documented Duo-specific ArrangementView/reservedRegions APIs. Full Duo adoption requires the 27.1 SDK and physical acceptance. Keep the compiled iOS 18-compatible fit-based implementation. Evaluate future `ArrangementView` and documented occlusion/reserved-region APIs only with the actual SDK and physical acceptance. [Apple readiness](https://developer.apple.com/iphone-duo/), [Apple preparation talk](https://developer.apple.com/videos/play/tech-talks/111461/).

Android uses stable Material adaptive 1.3.0 and Navigation 3 1.1.7 with typed saved navigation and retained session state. Full dependency validation required compile SDK 37, AGP 9.1 and Gradle 9.3.1; target SDK 36 and minimum 26 remain. Test actual window fit and posture rather than assuming every tablet or regular window has room for two panes. [Android adaptive skill](https://github.com/android/skills/tree/main/jetpack-compose/adaptive).

## Phases and acceptance

| Phase | Implemented scope | Remaining acceptance |
| --- | --- | --- |
| 1: continuity | Stable chat/composer/file/Git ownership across presentations | Physical resize, attachment/voice and reconnect matrix |
| 2: split workspace | Native Files/Changes sheet, explicit browser split, compact fallback | Physical keyboard, large text, RTL and focus |
| 3: Subagents | Explicit grant, allowlisted summaries, native list/detail | Real paired-device lifecycle |
| 4: native Browser | Direct HTTP native web views, tabs, port/URL entry, host hint | Actual tailnet/Next.js HMR and physical native checks |
| 5: platform completion | Existing SDK compilation and Android emulator checks | iOS 27.1/Duo SDK, physical foldable and accessibility acceptance |

Use separate source review for each phase and fix findings before acceptance. Native authors and the network/platform reviewer are working in parallel; the parent reviews shared contracts and integration. The available three child slots are reused for independent specialist passes.

## Verification and delivery

See [implementation verification](../testing/adaptive-mobile-workspace/implementation-verification.md) for exact outcomes and limitations, and [direct browser networking](../testing/adaptive-mobile-workspace/direct-browser-networking.md) for authoritative sources.

Test localhost-to-Mac address handling, invalid ports/schemes, no credential injection, preserved web view identity and form state across resize/tab changes, real HTTP HTML/JS fetch and WebSocket behavior, API HTTPS regression coverage, old-Mac hint absence, and authentication/revocation while discovering the hint. Do not claim real Next.js HMR or physical tailnet acceptance from a source-only check.

The iOS agreement prohibits simulator use. Verification now uses the connected physical iPad Pro on iPadOS 27 and the installed Xcode 27 beta. Keep this plan active until Duo SDK, physical accessibility and real tailnet acceptance gates are satisfied. The current chat-menu changes have not been committed or published; the earlier uploaded TestFlight build 28 predates them.

See [Apple API review](../testing/adaptive-mobile-workspace/apple-api-review.md) and [archive contract](../testing/adaptive-mobile-workspace/chat-archive-contract.md). Archive is reversible, revision-checked and gated by the host feature flag. Native Archived Chats and the Mac Restore action recover the original record; archiving does not cancel an already-running reply.
