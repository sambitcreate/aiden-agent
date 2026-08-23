# Aiden On The Go — App Store metadata draft

Status: Release draft. Public identity, category, age-rating answers, privacy-label answers, and screenshot specifications are resolved from the shipping app and current Apple definitions. App Store Connect publication and release-specific owner decisions remain open.

The executable canonical ASC localization draft lives in `app-store/metadata/`. The first internal TestFlight train is `0.1.0`; build `1` was rejected during upload for an alpha-bearing App Store icon, builds `2`–`14` progressively corrected the icon and expanded the native companion, and build `15` is the current processed internal candidate. The version directory and Xcode targets match that decision. Offline validation is safe, but no metadata may be applied until the public mobile privacy/support copy and owner decisions below are complete.

## Resolved public identity

- Developer/team name: `Sambit Biswas`
- Apple team: `5WP229CBB8`
- Bundle ID: `sbtbiswas.AidenOnTheGo`
- App Store SKU: `aiden-on-the-go-ios`
- Marketing URL: `https://chatwithaiden.com/`
- Support URL: `https://chatwithaiden.com/`
- Privacy-policy URL: `https://chatwithaiden.com/privacy`
- Feedback/review email: `hey@sambitbiswas.com`
- Copyright: `2026 Sambit Biswas`

The team/developer identity and feedback email come from the owner's shipped Contact Sheet project and installed Apple profile. Aiden URLs come from the live Aiden website; Contact Sheet's product-specific domain is not reused. The Contact Sheet listing uses its product site for both marketing and support, so Aiden follows the same pattern. Before submission, make the resolved feedback address or another working support contact visible on the Aiden site. The published policy is a valid public URL, but its copy currently describes the macOS app only. `app-store/MOBILE_PRIVACY_SUPPORT_COPY.md` contains ready-to-review replacement/addition copy covering Aiden On The Go's device-local cache, pairing credential, Local Network/Tailscale transport, attachments/providers, permissions, dictation, App Intents, external media, and Live Activity behavior. It is not considered published until the live site is updated and rechecked.

## Product copy

- Name: `Aiden On The Go`
- Subtitle: `Your Aiden Agent, anywhere`
- Primary category: Developer Tools
- Secondary category: Productivity
- Keywords draft: `AI assistant,agent,developer,Git,workspace,chat,automation,remote,Tailscale,Swift`

Developer Tools is the closest current Apple category: Apple describes it as apps for app development, management, coding, workflow management, and code editing. Productivity is the complementary secondary category. Category selection remains an App Store Connect property for this iOS/iPadOS app; do not add the macOS-only Xcode category key just to duplicate it.

Description draft:

> Aiden On The Go is the native iPhone and iPad companion for Aiden Agent on your Mac. Pair directly with a Mac you control over your local network or Tailscale, then continue Aiden chats and manage workspaces from your mobile device.
>
> Review conversations, stream responses, handle approval requests, inspect workspace files, work with supported Git flows, and manage scheduled tasks. App Intents provide quick navigation, Live Activities show bounded run status, and optional voice dictation and read-aloud stay on device.
>
> Your Mac remains the execution authority. Remote Access is off by default, each mobile device uses a revocable credential, and provider credentials remain on the Mac.

Review-notes draft:

> Aiden On The Go requires the companion Aiden Agent desktop app. In Aiden Agent, open Settings → Remote Access, enable the listener, and open a short-lived pairing session. On the iPhone or iPad, scan the pairing QR code or use the approved manual connection flow. The reviewer must be supplied with a reachable review Mac and any required setup instructions; no production credential is embedded in the app.

## Age-rating questionnaire draft

Use the current questionnaire for OS version 26 and later:

| Questionnaire item | Draft answer | Shipping-app basis |
| --- | --- | --- |
| Parental controls | No | Aiden has no parental-control surface. |
| Age assurance | No | Aiden does not request or infer age. |
| Unrestricted web access | No | The app has no embedded browser or free webpage navigation. Opening a link in the system browser is not in-app unrestricted browsing. |
| User-generated content | No | Chats and files stay private to the paired installation; the app does not broadly distribute user-created content. |
| Social media / disabled under 13 | No / No | There is no feed, discovery, sharing, liking, reposting, or public amplification. |
| Messaging and chat | No | Apple's capability is user-to-user communication. Aiden is private user-to-agent interaction and has no direct/group user messaging or public posting. |
| Advertising | No | No ads or paid promotional placements ship. |
| Mature themes, medical/wellness, sexuality/nudity, violence, and chance-based activities | None for every frequency item; Gambling and Loot Boxes: No | None is authored or promoted as app content. Connected AI output is open-ended and remains subject to provider behavior and user prompts. |
| Made for Kids | Not applicable | The product and public policy are not directed to children. |
| Override | 13+ | The public privacy policy says Aiden is not directed to children under 13. A conservative 13+ override aligns the listing with that product policy even if the questionnaire calculates a lower rating. |
| Age-suitability URL | Leave blank | No dedicated age-suitability page currently exists. |

Before publishing, compare these answers with the exact final questionnaire wording and distribution candidate. If the release adds an embedded browser, user-to-user communication, public sharing, a hosted social surface, or intentionally supplied mature content, update the answers rather than relying on this draft.

Current Apple references:

- `https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/`
- `https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/`

## App Privacy questionnaire draft

- Privacy Policy URL: `https://chatwithaiden.com/privacy`
- User Privacy Choices URL: leave blank; Aiden has no developer-held account or cloud data for a user to manage.
- Tracking: No.
- “Do you or your third-party partners collect data from this app?”: **No, we do not collect data from this app.**

Evidence for that answer in the current distribution candidate:

- The app contains no analytics, advertising, crash-reporting, account, or Aiden-hosted relay SDK.
- Pairing credentials and custom headers stay in Keychain. Cached chats/settings stay on the user's device; authoritative chats/files remain on the Mac the user pairs.
- QR camera frames are processed for pairing and are not uploaded to Aiden's developer.
- Dictation and read-aloud use Apple system frameworks locally; Aiden does not operate a speech collection endpoint.
- Photos/files selected by the user are sent directly to their paired Mac and may then be sent to model providers the user configured on that Mac. Aiden's developer cannot access them. Provider processing remains governed by each selected provider and should be described in the public policy.
- Optional Bot image generation uses Apple's system Image Playground on supported devices and may use Private Cloud Compute. Aiden disables person/Photos personalization and supplies only the visible Bot name and purpose as starting concepts. Aiden's developer runs no image-generation or proxy service and cannot access those concepts, rejected candidates, or results. When the person chooses **Use this image**, the app sends only that normalized image directly to the paired Mac, which stores the canonical Bot photo.
- Local Network or Tailscale traffic goes directly to the paired installation. Aiden does not run a central account, synchronization service, analytics endpoint, or proxy.
- Live Activity state is device-local and response excerpts are off by default.
- External transcript media can contact the media host without forwarding Aiden credentials; the public policy should disclose that a remote host can observe an ordinary network request when its media is displayed.
- `PrivacyInfo.xcprivacy` declares no tracking, no collected data types, and only the `UserDefaults` required-reason API (`CA92.1`).

Apple defines collection for the privacy label as off-device transmission that lets the developer or a third-party partner access the data for longer than needed to service the request in real time. Reconfirm the **No** answer before publishing: it stops being accurate if the release adds developer-accessible telemetry, crash reports, accounts, hosted relay/proxy storage, or another partner that retains app data. The owner must also confirm that the final public policy accurately covers mobile behavior and the configured AI-provider path.

Current Apple references:

- `https://developer.apple.com/app-store/app-privacy-details/`
- `https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/`

## Screenshot delivery specification

The final distribution candidate needs one to ten opaque `.png`, `.jpg`, or `.jpeg` screenshots for each required family. Use real-device captures and do not use a simulator for this project.

- iPhone: capture the connected iPhone 13 Pro at `1170 × 2532` portrait or `2532 × 1170` landscape. App Store Connect accepts that 6.1-inch size, but a final 6.9-inch capture is preferred when the owner's iPhone 16 Pro Max is available because Apple can scale the highest-resolution set down.
- iPad: a physical iPad capture is mandatory because the app supports iPad. Current 13-inch accepted portrait sizes are `2064 × 2752` or `2048 × 2732`; landscape reverses those dimensions.
- Do not include alpha/transparency. Capture at least pairing/installation selection, workspace/chat navigation, an active transcript with tool status, files/Git, and Scheduled Tasks while excluding real secrets, private paths, personal chats, and live pairing credentials.

Current Apple reference: `https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/`.

## Owner decisions still required

- Internal TestFlight starts at marketing version `0.1.0`; build `1` was rejected before processing and build `15` is the current processed internal candidate. Advance the build number for later uploads in the same train and reserve `1.0.0` for the first public release decision.
- Enter Developer Tools / Productivity in App Store Connect, or deliberately override this documented recommendation.
- Verify and publish the drafted 13+ age-rating answers in the exact current questionnaire.
- Verify and publish the drafted “No data collected” App Privacy answer against the final distributed build and operational services.
- Owner/legal-review and publish `app-store/MOBILE_PRIVACY_SUPPORT_COPY.md` at the resolved privacy URL.
- Make the prepared working support contact visible at the resolved support URL.
- Required physical-iPhone and physical-iPad screenshots captured from the final distribution candidate at accepted dimensions.
- App Review phone number, notes, and a reachable companion-Mac review environment. The name/email are resolved above.
- Availability, price, territories, and release mode.

Do not replace unresolved values with placeholders in App Store Connect.

## App Review Bot-flow notes draft

Provide these notes only with a reachable, reviewer-safe paired Aiden Agent environment and the final approved contact details:

1. Pair the iPhone or iPad with the supplied Aiden Agent Mac, then tap the Aiden logo and choose **Bots**.
2. Accept the one-time Full Access notice or choose **Customize first**. Full Access uses only capabilities already enabled on the paired Mac; Custom can reduce Files, commands, Connections, and Skills.
3. Create a Bot with the built-in semantic avatar, save it, and start a chat. Apple Intelligence is not required for this complete path.
4. On eligible Apple Intelligence hardware with iOS/iPadOS 18.4 or later, **Create with Apple Intelligence** opens Apple's system Image Playground. Apple controls generation and may use Private Cloud Compute. Aiden disables person/Photos personalization and sends the paired Mac only the image explicitly accepted and saved.
5. On unsupported hardware, including iPhone 13 Pro, the editor honestly keeps the semantic avatar available and has no dead Image Playground action.

Do not claim successful Image Playground generation in review notes until it has passed on supported physical hardware. Do not include pairing credentials, private prompts, paths, or provider secrets in metadata or notes.
