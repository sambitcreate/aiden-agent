# Apple API review — native chat actions and optional browser

Verified 2026-09-09 against installed Xcode 27.0 beta (27A5194q), local skills, and Apple documentation. This is API/source evidence, not physical iPhone Duo acceptance.

## Recommendation

Use an iOS 18-compatible native `Menu` for chat actions, a sheet containing a segmented Modified / All Files picker, and native Rename / Archive actions. Do not add Pin. Toolbar placement called `topBarPinnedTrailing` does not imply a user-facing chat Pin feature. Keep the browser hidden until explicitly invoked. On sufficiently wide available windows, offer chat left and browser right with equal usable widths; on narrow windows use the existing single-surface presentation. Keep chat/composer state and retained page instances above the changing layout boundary. Window geometry, content minimum widths and accessibility text size should decide layout, not a device-model name.

Retain `WKWebView` through `UIViewRepresentable`. The requested browser loads actual HTTP(S) pages on the device. Replacing it with streamed Mac pixels or an independent Mac control session would change the request. Preserve the same page object across presentation changes; presentation must not trigger a new load. Keep browser data and authorization separate from the paired Remote API client. These are implementation recommendations based on the current product requirements.

## Installed SDK evidence

The selected default developer directory remains `/Applications/Xcode.app/Contents/Developer`; explicitly choose `/Applications/Xcode-beta.app/Contents/Developer` for beta verification. The latter reports Xcode 27.0, build 27A5194q. Its iPhoneOS27.0 SDK exports:

| API | Installed declaration | Adoption |
| --- | --- | --- |
| `ToolbarOverflowMenu`, `toolbarOverflowMenu` | SwiftUI interface lines 31284–31316, iOS 27.0 | Optional modern toolbar branch; ordinary Menu remains the iOS 18 fallback. |
| `topBarPinnedTrailing` | SwiftUI interface line 7851, iOS 27.0 | Optional placement, unrelated to archiving or pinning chats. |
| `WebPage` | WebKit interface lines 474–478, iOS 26.0 | Not necessary for an iOS 18 application retaining WKWebView. |
| `ArrangementView`, `reservedRegions` | No matching declarations in installed SwiftUI, SwiftUICore or UIKit Swift interfaces/headers | Cannot currently compile a Duo-specific implementation with this SDK. |

Interface paths are under `/Applications/Xcode-beta.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.0.sdk/System/Library/Frameworks/`, followed by `SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftinterface` or the corresponding WebKit path. Declaration locations can change in subsequent betas.

`if #available(iOS 27.1, *)` only handles runtime availability. It cannot make a symbol missing from the compiler SDK available. Do not introduce guessed declarations or claim complete Duo API adherence from a width-based split. Recheck the installed 27.1 SDK before adopting those APIs.

## Official Apple evidence

Apple's [Duo adaptive-layout talk](https://developer.apple.com/videos/play/tech-talks/111463/) demonstrates `ArrangementView`, horizontal split arrangements, and querying division/occlusion reserved regions. System menus and alerts participate in reserved-region adaptation. This establishes genuine platform APIs, while their absence from this installed SDK remains a local build constraint. After obtaining the required SDK, evaluate arrangement-based presentation around the chat and browser surfaces and test hinge/occlusion behavior. Avoid equating a numerical midpoint with a hardware-safe division.

Apple's [iPhone Duo developer page](https://developer.apple.com/iphone-duo/) advertises Xcode 27.1 beta in search results; direct page retrieval was unavailable during this pass. The [official announcement](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/) identifies iOS 27.1 for the device. Those sources do not establish that this machine has that SDK installed.

[WKWebView documentation](https://developer.apple.com/documentation/webkit/wkwebview/) continues to describe the native web-content view. [WebKit's Safari 26 release article](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) introduces SwiftUI WebView and WebPage integration; their existence does not require replacing the older supported embedding API.

## Local skills and acceptance boundary

Read `/Users/sambitbiswas/projects/opp/xcode27-skills/swiftui-whats-new-27/SKILL.md` and its toolbar/item-binding references, plus `device-interaction/SKILL.md`. The local toolbar availability claims agree with the inspected SDK. Repository claims of Apple authorship are not independent proof of provenance; official documentation and actual SDK declarations are the evidence used here.

Required acceptance remains: narrow/wide transitions preserve draft, selection and page DOM; files sheet dismissal protects dirty edits; browser close returns focus sensibly; keyboard and VoiceOver navigation remain usable; unavailable archive hosts do not expose a nonfunctional action. Duo hinge/posture and physical-device keyboard behavior need actual supported runtime/device testing before asserting full compatibility.
