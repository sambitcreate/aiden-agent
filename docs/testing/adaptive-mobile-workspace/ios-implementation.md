# iOS adaptive workspace implementation — native Browser revision

Source independently reviewed. Latest signed physical iPad test run: 23/23 passed on iPadOS 27 with Xcode 27.0 beta; the updated app was launched successfully. No commits. Earlier browser implementation evidence follows; see the current verification at the end.

- Retained per-chat transcript/composer/file/Git/Subagents/Browser state; measured 760pt two-pane threshold, compact/accessibility single-pane fallback. Existing Files/Changes reused; file recovery scoped per chat/host with bounded JSON recovery error handling. Draft/upload/voice preparation survive layout remount; transcript presentation refresh remains distinct from resize.
- Subagents summary-only resource with strict scoped DTO, bounded runs, duplicate-key/revision-regression rejection and no hidden polling; permission guidance and auth-context clearing.
- Browser now loads actual HTTP/S development pages in retained WKWebView tabs (maximum8) with per-chat ephemeral website data. Native URL/back/forward/reload/stop/new/close controls. No screen streaming, Aiden browser-session endpoint, command/frame DTOs, injected bearer, JSbridge, certificate override, or API URLSession reuse.
- Optional server.developmentHost validated as bare Tailscale100.64/10 IPv4 or *.ts.net; missing/invalid compatible, paired endpoint validhost fallback. Explicit portOpen defaults3000; hints never load. Pasted localhost/127/0.0.0.0 URL rewrites on explicitOpen to validated Mac hint with destination shown; absenthint returns guidance.
- ATS web-content-only HTTP exception leaves general/API TLS, local-network and media exemptions disabled. Auth/host context teardown stops/releases pages and rotates ephemeral datastore; same-context resize preserves pages/history/forms/HMR. Onboarding reflects native devserver setup.

Validation:
- `xcodebuild -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'generic/platform=iOS' -derivedDataPath /tmp/aiden-adaptive-ios-build CODE_SIGNING_ALLOWED=NO build-for-testing`
- Final log `/tmp/aiden-ios-native-browser-build.log`: TEST BUILD SUCCEEDED.
- `npm run test:ios-release`:31/31 pass; `/tmp/aiden-adaptive-ios-policy.log`.
- `git diff --check -- ios`: passed.
- 14 newly added XCTest methods compiled, NOT EXECUTED (including5native Browser/hint tests). Existing ATS tests updated to assert onlyweb-content exception.

Limits: Xcode26.6/SDK26.5, iOS18+ shipping APIs; no unavailable iOS27.1 symbols or iPhone Duo-only claims. No simulator used; physical device unavailable, so real rotation/windowresize/IME/voice/WebKit/HMR/Tailscale/accessibility runtime acceptance remains pending. Devserver must bind0.0.0.0 and publish reachable HMRhost. WKWebView default permissions and normal certificate trust remain; HTTP secure-context APIs may requireHTTPS. No full Safari parity claim: custom JavaScript alert/confirm/prompt UI and native upload delegate handling are not added.

## HTTP Serve link followup

A scoped chat OpenURLAction routes explicit user taps on canonical Tailscale HTTP links into the retained WKWebView Browser. Other links preserve system handling; tool output never auto-loads. Generic physical build-for-testing and all 31 policy checks passed. The routing XCTest compiled; physical link activation and live tailnet acceptance remain pending. Independent source review accepted the change.

## Chat menus and physical iPad verification — September 10

Native ellipsis actions provide Rename, Archive, Changes, Files and Open Browser; no Pin action. Files/Changes use a retained searchable folder tree and a Modified / All Files sheet with read-only Git comparison/diffs. Browser is explicitly opened and offers an equal right-hand split at sufficient allocated width; chat and WKWebView instances stay retained. Hidden file editors release keyboard focus, and explicit browser close restores prior composer focus.

Archive is revision-checked, feature-gated and recoverable through Archived Chats; rename/metadata reconciliation preserves drafts and in-flight messages. Independent review accepted the source after fixes. The physical iPad test suite passed 23 tests, including archive/cache decoding, rename validation, read-only behavior, pane layout, file-tree behavior, retained WKWebView identity and routing. Result `/tmp/aiden-ipad-menu-signed/Logs/Test/Test-AidenOnTheGo-2026.09.09_23-59-46--0400.xcresult`; log `/tmp/aiden-ipad-menu-tests-final.log`. All 31 iOS shipping-policy tests passed.

The [Apple API review](apple-api-review.md) supersedes the earlier toolchain note: Xcode 27.0 beta is installed and tested, but it lacks the documented Duo arrangement/reserved-region declarations. Full 27.1/Duo, manual accessibility and live tailnet interaction remain open. This delta is not in the earlier TestFlight build 28.
