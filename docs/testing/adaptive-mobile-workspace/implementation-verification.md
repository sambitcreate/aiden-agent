# Adaptive mobile workspace: implementation and verification

Updated September 10, 2026. Branch `feature/adaptive-mobile-workspace`, based on `e42b1479`. Browser, Files, Subagents and Changes are implemented on both native clients. Physical iPad/Duo/foldable and future Apple SDK acceptance remain open; the plan is Active.

## Current Browser architecture

The user clarified that Browser must render the development webpage **on the client device**. The earlier shared-desktop JPEG implementation was removed, including frame/session/control endpoints, screencast hooks, separate Browser grants and their obsolete tests. The desktop Browser service is unchanged from the base branch.

The mobile pane now embeds WKWebView on iOS and Android WebView. A server listening on the Mac's Tailscale interface or `0.0.0.0:3000` is reached as `http://<Mac Tailscale IP>:3000`. Native rendering, JavaScript, forms, scrolling and WebSockets run on the device. There is no application video frame-rate cap, no remote desktop browser ownership, and no copied desktop browser cookies.

Users explicitly open a port or HTTP(S) address. An authenticated optional `/server.developmentHost` suggests the current Mac's running Tailscale self IPv4 (100.64/10), falling back to its validated `.ts.net` name. The hint is bare, bounded and cached for 30 seconds; it is independent of certificate/Serve availability and reauthorized before emission. Older Macs work through manual address entry. Localhost development links resolve to the Mac hint rather than silently addressing the phone. Opening a Browser URL changes no server, firewall, ACL or Serve configuration. The separately invoked `tailscale_serve` tool provides optional private HTTP forwarding for localhost-only servers.

The web views retain tabs and address drafts across adaptive pane remounts. Native HTTP configuration permits development pages; Aiden API HTTPS, credential storage and certificate validation/pinning remain unchanged. Pages receive no Aiden authentication headers or privileged JavaScript bridge. Invalid certificate acceptance and arbitrary native schemes are not enabled. The native browser's own page accessibility replaces the superseded image/semantic-proxy approach.

See [networking and official references](direct-browser-networking.md) for binding, Next.js, WebSocket and tailnet behavior. Browser secure-context-only features may still require HTTPS even though ordinary page HTTP works over Tailscale.

## Other panes and continuity

Chat, transcript, approvals, attachments, voice and composer stay together in the leading pane, with Environment alongside when useful window space permits. Compact windows retain the same destination and a return to Chat. iOS uses its supported iOS 18-compatible fit-based layout; Android uses Material adaptive supporting panes and typed Navigation 3 state.

Files and Changes reuse existing Mac-authoritative reads/mutations, original versions and conflict handling. Recovery text is bounded and installation/workspace/chat/file scoped. Resize and activity recreation retain normal pending work. Android cannot recover attachment payloads after process death and explains the loss; no new automatic mutation replay was added.

Subagents is a separate grant-controlled parent-scoped summary resource: names, roles, status, revisions and timestamps with opaque per-grant IDs. Child instructions, reasoning, private history, outputs and management controls are excluded. Existing parent projections are unchanged. Subagent grants remain explicit and expire with the Mac session; the Browser has no such grant because it connects to an ordinary tailnet web service.

Native onboarding and the desktop tour setup note now explain direct device rendering and the separate Subagent grant. Existing gallery assets remain; there is no new unverified tile or onboarding network action.

## Independent review

Three specialist agents worked in parallel with the parent and performed separate source reviews. Fixed findings include stale reconnect responses, hidden native navigation preferences, per-chat recovery collisions, pending composer ownership, selected-tool state loss, decreasing summary revisions, and grant races.

For the corrected native Browser, independent review checked actual web-view identity when switching tabs, address draft retention, localhost resolution, canonical Tailscale IPv4 parsing, host/installation cleanup, HTTP admission, and separation from API authentication. The network reviewer checked the Self-only host hint, bounded cache and reauthorization. Superseded streaming tests are not counted as evidence for the native Browser.

## Build requirements

Android uses adaptive 1.3.0, Navigation 3 1.1.7, compile SDK 37, AGP 9.1 and Gradle 9.3.1. Target SDK 36/minimum SDK 26 remain. Xcode 27.0 beta (27A5194q) is now used explicitly for signed physical iPad verification. No unavailable 27.1 symbols or third-party iOS dependencies were added. See the [SDK/API audit](apple-api-review.md) for declarations checked against the installed toolchain.

## Verification

Earlier direct-browser outcomes are recorded in [iOS implementation](ios-implementation.md), [Android implementation](android-implementation.md), and the networking review. Shared checks for this architecture: Remote API regression suite passed (367passes, one host-port skip), seven LAN transport tests passed, Tailscale 34/34, onboarding 50/50 and Settings design 58/58. Production build, application/E2E TypeScript and scoped lint passed. The production Remote Access lifecycle E2E passed. Android finished with 160 unit tests, 10 emulator tests, lint and debug APK assembly passing. iOS build-for-testing and all 31 policy checks passed; 14 added XCTest methods compiled but were not executed.

Android native instrumentation exercises actual WebView HTTP rendering, JavaScript, absence of an Aiden Authorization header, detach/reattach state, and direct WebSocket traffic using a local test server. This is native runtime evidence, not a real tailnet or Next.js deployment claim. The latest physical iPad run executes native browser model/web-view identity tests; it does not establish full page interaction or real-tailnet behavior. No simulator is used under the project policy.

## Remaining acceptance

- Broaden physical iPhone/iPad acceptance to actual page/form/keyboard/VoiceOver scenarios. The focused 23-test suite now passes on the connected iPad Pro running iPadOS 27.
- Test physical Duo and Android tablet/foldable window/posture, cutouts, freeform resizing, TalkBack, RTL, large text and external keyboards.
- Verify the user's actual Next.js project and WebSocket hot reload over the real tailnet, including its origin configuration, server binding and firewall/ACL. Tests do not establish all possible development-server configurations.
- Build with the required 27.1 SDK and verify Duo arrangement/reserved-region behavior before claiming full Duo compliance. Xcode 27.0 signed iPad testing now passes.

Changes remain uncommitted. The earlier TestFlight 0.1.0 (28) upload predates these chat-menu changes; this delta has not been published.

## Optional HTTP Serve tool followup

Implemented `tailscale_serve` (open/list/stop) with foreground Ask/Full workspace admission, normal mobile/desktop approvals, no automatic replay, exact private HTTP routes, protected Aiden listener exclusions, and durable ownership. Existing API routes and unrelated Serve configuration are checked before/after. Explicit Tailscale link taps now open the retained native Browser on both platforms. Setup onboarding mentions asking Aiden to forward localhost servers. See the networking review for persistence, CLI concurrency limits and usage.

Independent tool/service/native source reviews accepted the final implementation. A reported IP-vs-DNS alias mismatch in Android link routing was fixed. Verification: 13 focused tool/service tests (including a real localhost HEAD probe and post-journal cancellation), 40 coding/approval tests, 50 onboarding tests, Remote API regression 378 passes/one occupied-host-port skip plus seven LAN tests. The final two added service tests ran in the focused suite after the broad run. TypeScript, scoped lint and production build passed. Android followup passed 161 unit tests, 11 emulator tests, lint and debug APK; iOS build-for-testing succeeded with 31 policy checks and link-routing XCTest compilation. Physical iOS tests and a real Tailscale/Next.js client session remain unexecuted. No live tailnet routes were changed for validation.

## Chat menus, Files/Changes and optional split (September 10)

Both clients replace the in-chat file launcher with native chat actions: Rename, Archive, Changes, Files and Open Browser, with no Pin/Unpin. Files and Changes share a Modified / All Files sheet. Search and folder expansion stay in retained state; file opens use opaque server IDs. Modified review uses semantic additions/deletions fills and exposes read/compare operations while hiding Git mutations and mutation retries. Dirty file drafts remain recoverable when the sheet closes.

Browser starts only when invoked, renders locally, and offers an explicit equal-width split on a sufficiently wide allocated window. Closing the panel restores the chat; iOS also remembers composer focus before the full browser presentation. Narrow/accessibility layouts fall back to one surface without replacing retained page objects.

Rename and reversible archive use host revisions. Archive support is gated by `chat-archive-v1`, active lists exclude archived chats, and native Archived Chats can restore them. The Mac keeps archived records reachable and displays Restore with the composer disabled. Storage prevents new user sends racing with archive but allows an existing assistant reply to finish. See [archive contract](chat-archive-contract.md).

Independent source review fixed hidden editor focus, a mutation Retry leaking into read-only review, Android rename length mismatch, archive/send race handling, desktop recovery, and summary feature expectations.

Current verification:
- Physical iPad Pro (iPadOS 27): signed Xcode 27 test run passed all 23 selected chat/workspace tests. Result: `/tmp/aiden-ipad-menu-signed/Logs/Test/Test-AidenOnTheGo-2026.09.09_23-59-46--0400.xcresult`. Updated app launched successfully with `devicectl`. The first test run exposed a fixture using the default decoder; it was corrected to the production RFC3339 decoder before the successful rerun.
- Remote API suite: 384 passed, one occupied-host-port skip; all seven LAN tests passed. `/tmp/aiden-remote-current-final.log`.
- Archive backend/desktop focused checks: 174 passed; summary filtering/cursor suite: 10 passed.
- iOS shipping policy: 31 Node tests plus Ruby checks passed. TypeScript, production build and diff whitespace checks passed.
- Android: 169 unit tests passed; 12 emulator tests passed before the final archived-send guard. The final guard and ViewModel regression passed unit tests, lint and debug APK assembly. Independent source review accepted the correction. See [Android implementation](android-implementation.md).

These checks establish source/build and focused native behavior, not complete visual, accessibility, Duo hinge/posture or real Next.js/Tailscale acceptance.
