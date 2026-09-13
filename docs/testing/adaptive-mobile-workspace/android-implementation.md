# Android native development Browser handoff

This supersedes the earlier streamed Browser report. Browser now renders HTTP/HTTPS directly in android.webkit.WebView on the mobile device. No Mac JPEG/video/frame/lease/control/semantics transport remains in Android. Files, Changes, Subagents and adaptive chat remain intact.

Browser: retained live per-chat/workspace/installation WebView tabs (maximum8, with visible limit guidance), URL entry, Back/Forward/Reload/Stop/New/Close tab controls; no automatic page load. Optional validated `/server.developmentHost` supplies Mac Tailscale IPv4 or .ts.net host and default port3000. Older servers support manual fullURL and paired-endpoint host fallback. Pasted localhost/127.0.0.1/0.0.0.0 URLs resolve to the Mac host with destination displayed before Go; no host hint means these URLs are rejected with guidance. Dev server must listen on0.0.0.0; nativeHTTP and ws:// support the browser's own rendering/HMR.

Isolation: no JavaScript/native bridge, no Aiden token/header/cookie injection, no Aiden TLS client reuse or certificate overrides. Only HTTP(S) top-level navigation; local filesystem/content access disabled. Data/blob web subresources allowed. Dynamic Tailscale IP hosts require base cleartextTrafficPermitted=true because network-security-config cannot express dynamic CIDRs; Aiden API canonicalHTTPS and pinned trust logic remain untouched. Live page views/input state survive pane/width/tab changes and are cleared on installation removal/host switch. WebView website cookies/storage use normal app WebView storage independently of Aiden credentials; there is no private browsing/profile segregation claim.

Validation: `/tmp/aiden-android-native-final.log` full combined build successful:160 unit tests, zero failures/errors/skips;10/10 connected tests Pixel10 Android16 AVD; lintDebug and assembleDebug pass. Additional DOM-preservation instrumentation assertion and lint rerun: `/tmp/aiden-android-native-dom.log` BUILD SUCCESSFUL32s, lint and10/10 connected tests pass. Native tests fetch actual localHTTP HTML without Authorization headers, reject javascript URL loading, verify the same retained WebView on detach/tab reselect, purge views on removal, and receive a real ws:// message changing DOM title. Existing adaptive scene resize/restoration tests also pass. Canonical revision11 fixture is byte-identical including optional developmentHost; oldstreamfixtures removed. git diff --check passes.

APK: `/Users/sambitbiswas/.codex/worktrees/7e79/aiden-macos/android/app/build/outputs/apk/debug/app-debug.apk`.

Toolchain retained from adaptive implementation: compileSDK37, AGP9.1.0, adaptive1.3.0, Nav3 1.1.7, Gradle9.3.1; targetSDK36/minSDK26. Use Android Studio bundled JBR and SDK at `/Users/sambitbiswas/Library/Android/sdk`.

Independent review: apple_platform reviewed native replacement; keyed tab view, retained address editor, safe web subresources and canonical host parser fixes applied. No commits created. Final cap8 validation log: `/tmp/aiden-android-native-capped.log`, BUILD SUCCESSFUL45s:160 unit tests,10 connected tests, lint and debugAPK all pass. Source frozen. Source ownership android/** only.

Remaining gates: real physical tablet/fold/window resizing, real Tailscale Mac dev server/HMR, IME/TalkBack and measured performance/battery. Tests use local emulator HTTP/WS rather than a paired remote host. Live pages are retained in memory; process death does not persist DOM/forms or tabs. Activity-backed JS dialogs, upload chooser/download UI and full browser-profile parity remain follow-up, not claimed. Existing chat attachment process-loss disclosure and no automatic Git mutation replay remain unchanged.

Official sources consulted: https://developer.android.com/develop/ui/views/layout/webapps/webview and https://developer.android.com/privacy-and-security/security-config . Friction: `/tmp/aiden-android-friction.md`.

## Explicit preview-link follow-up

Tapped transcript links now open the current chat Browser only for HTTP URLs with an explicit port and a canonical Tailscale100.64/10 IPv4 or validated*.ts.net hostname. Ordinary HTTPS/public links retain external handling. Tailscale DNS aliases are accepted independently of the server hint because Serve may return SelfDNS while the hint prefers IP. Existing matching tabs are selected without reload; otherwise the user tap opens a tab within the8-tab cap. No generation/tool-result observer loads pages. Markdown-link and JSONquoted-URL formatting now yield exact URLs. Activity-only timeline cards still do not display raw tool results; the agent should include its preview URL in visible assistant text.

Validation log: `/tmp/aiden-android-preview-link-final.log`;161 unit tests passed. Final11/11 connected tests, lintDebug and debugAPK all pass; BUILD SUCCESSFUL48s.

Final Tailscale SelfDNS alias routing: `/tmp/aiden-android-preview-alias.log` BUILD SUCCESSFUL35s,161 unit tests, lintDebug/debugAPK pass. The11 connected tests passed immediately before this pure routing-policy change. Source frozen.

## Chat menu and combined Files/Changes follow-up

One in-chat ellipsis menu contains Rename, Archive (or Restore for an archived chat), Changes, Files, and Open Browser. No pin/unpin. Archive is negotiated behind `chat-archive-v1`, uses host PATCH with If-Match, and is disabled while generation is active. Rename preserves live message/composer state. Successful metadata writes notify the retained home model to refresh its otherwise cached list. Home's organization menu offers Archived chats; the sheet reads includeArchived=true and restores using a freshly fetched detail revision. Archives are host-backed, not device-local hides.

Changes and Files open the same modal sheet with Modified / All Files tabs. Both reuse existing activity-owned file/Git models, drafts, version guards and scroll state. Open Browser starts full-pane. On an adaptive wide window, Split right switches the existing Nav3 scene to two partitions and Full pane reverses it; no new WebView or window is created. Native preview link opening uses the same full-pane invocation.

Focused verification: `AidenChatActionsTest` covers separate conditional rename/archive/restore request bodies, archive-list query, optional ISO archive timestamp and summary projection, and shared file mode persistence. The new Nav3 instrumentation test verifies full→split→full→split keeps the composer draft.

Final clean run `/tmp/aiden-android-chatmenus-accepted.log`: BUILD SUCCESSFUL1m22s,164 unit tests zero failures/errors/skips, lintDebug and debugAPK pass. `/tmp/aiden-android-chatmenus.log` connected tests12/12 passed; that earlier combined run's lint failed from source-offset mismatch while files were being edited, superseded by the clean successful lint. Canonical archive fixture byte-identical; git diff --check clean. Physical fold/tablet/IME checks remain outstanding.

## Final parity acceptance (supersedes earlier test counts)

Files now offers expandable directory rows with retained expanded paths and search. Synthetic directory rows remain UI-only; actual file reads keep the original opaque file IDs. The shared Modified pane sets readOnlyReview: no commit, branch mutation, push, worktree mutation, or mutation Retry controls/dialogs; comparison and diff reads remain. Diff additions/deletions have soft semantic fills and retain +/− prefix text; +++/--- headers are classified separately. Modified/All Files changes clear focus and hide the keyboard to prevent a hidden editor retaining focus.

Independent Apple specialist review accepted tree identity, read-only Git guards, native Browser full/split retention, archive/restore, and metadata lifecycle. Review corrections applied: rename Save/VM validation uses the server's200 Unicode scalar limit with readable validation; archived chats disable Send and the ViewModel rejects before consuming the draft/attachments or creating optimistic messages, with visible Restore guidance.

Final source frozen. `/tmp/aiden-android-archiveguard-regression.log`: BUILD SUCCESSFUL6s,169 unit tests zero failures/errors/skips and lintDebug pass, including the real ViewModel regression for archived draft preservation. `/tmp/aiden-android-archiveguard-final.log`: final main-source debugAPK+lint+168 unit suite BUILD SUCCESSFUL35s (the subsequent change added only the extra regression test). `/tmp/aiden-android-parity-final.log`: preceding full parity run12/12 connected Pixel10 Android16 tests,167 unit tests, lint/APK pass1m7s. The2 later tests cover rename scalar bounds and archived send; final UI changes were visible rename validation and Restore guidance. Exact fixture parity and git diff --check pass. APK path unchanged. No Android physical tablet/fold/IME acceptance claimed; no commits created.
