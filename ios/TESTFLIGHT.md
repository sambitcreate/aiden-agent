# TestFlight readiness

The approved production identity is:

- App: `sbtbiswas.AidenOnTheGo`
- Live Activity widget: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`
- App Group: `group.sbtbiswas.AidenOnTheGo`
- URL scheme: `aiden-otg`
- SKU: `aiden-on-the-go-ios`

## Verified archive command

Run from the repository root. This targets generic iOS hardware and does not use a simulator:

```sh
xcodebuild archive \
  -project ios/AidenOnTheGo.xcodeproj \
  -scheme AidenOnTheGo \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/AidenOnTheGo.xcarchive \
  DEVELOPMENT_TEAM=5WP229CBB8 \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates
```

The Phase 12 audit produced a valid Release archive with the approved bundle IDs, team, App Group, Live Activity widget, App Intents metadata, privacy manifest, and third-party notices. The locally available signing identity produced an Apple Development archive with `get-task-allow=true`. That archive is useful for readiness validation but must not be exported or uploaded to TestFlight.

Distribution signing is now provisioned. The local Apple Distribution identity belongs to team `5WP229CBB8`, and App Store profiles exist for both `sbtbiswas.AidenOnTheGo` and `sbtbiswas.AidenOnTheGo.LiveActivityWidget`. The exported internal IPA must still be checked for `get-task-allow=false`, exact bundle/App Group identifiers, and Apple Distribution signing before every upload.

## Export configurations

The checked-in export options under `ci/` are adapted from the Hermex release foundation:

- `ci/TestFlightExportOptions.plist` is internal-TestFlight-only.
- `ci/ExternalTestFlightExportOptions.plist` can produce an external-capable App Store Connect upload after owner approval.

Both pin team `5WP229CBB8`, use automatic signing, preserve the selected project version/build number, and upload symbols. The external configuration deliberately omits `testFlightInternalTestingOnly`; exporting a build does not invite testers or submit it for review.

## Manual GitHub upload workflows

The owner-gated upload workflows are adapted from Hermex's proven release structure:

- `.github/workflows/aiden-on-the-go-internal-testflight.yml` requires a manual run from `main`, the exact confirmation `INTERNAL`, and the protected GitHub environment `aiden-on-the-go-internal-testflight`. It uses the internal-only export policy.
- `.github/workflows/aiden-on-the-go-external-testflight.yml` requires a manual run from `main`, the exact confirmation `EXTERNAL_REVIEW`, and the separate protected environment `aiden-on-the-go-external-testflight`. It uses the external-capable policy and refuses a marketing version whose App Store version train is already closed.

Configure these three secrets independently in each protected environment before use:

- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_PRIVATE_KEY` containing the `.p8` key text

Both workflows query App Store Connect for the latest build in the current marketing version and select the next valid `CFBundleVersion`; the optional input can override it only with a greater one-to-three-component numeric version. Both archive generic iOS hardware and upload only. The external workflow does not assign a tester group, invite testers, or submit Beta App Review; those remain explicit App Store Connect actions.

The workflows intentionally fail closed until the protected environments, App Store Connect app record, API-key access, and valid iOS distribution signing are owned and configured. Do not weaken the gates to make an unprovisioned run pass. Their deterministic policy and selector tests run with `npm run test:ios-release` and are registered in the repository's normal test command.

Use the read-only and owner-operations guidance in `ASC_CLI.md` to inspect App Store Connect after upload, validate the exact version, and drive Codex status automations. The upload workflow deliberately does not depend on installing `asc` on a hosted runner. The distinct **Aiden On The Go** record is App ID `6803233275`; the legacy **Aiden - Quick AI** record is not reused.

On 2026-08-22, version `0.1.0` build `14` was archived from commit `d23f80ccbf6cdef510624ff13572cba09c26d059`, exported with the internal-only policy, uploaded through the explicitly selected owner-authorized ASC profile, processed as `VALID`, and assigned to the `Internal Testers` group (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`). Exact App Store Connect build `e0a7152d-3ab7-41a3-89c0-e037fa9d8244` reports `internalBuildState=IN_BETA_TESTING` and `externalBuildState=NOT_APPLICABLE`. Build `7` added Thinking Orbs and the refreshed composer/model controls; build `8` added Mac-owned model visibility, sanitized custom provider artwork sync, corrected iOS thinking-model rows, waveform-only listening status, and the home action overlay; build `9` added first-class Concentrate, the refined Your Activity/Total Tokens view, and bounded Mac-generated title reconciliation on iOS; build `10` added authenticated pairing completion and accepted multi-device, multi-Mac, listener, Tailscale-ownership, revocation, and cache-isolation hardening; build `11` added refreshed Pi-hosted models and first-class QR, local setup-code, private Tailscale setup-code, and payload pairing choices; build `14` repairs approval visibility and cancellation reconciliation across Mac and iOS while keeping privileged approval details host-only. Build `1` was rejected before processing because its App Store icon contained alpha; builds `2`–`14` use the exact opaque RayChat Icon Composer artwork.

On 2026-08-23, owner-authorized build `17` was archived from source commit `3b627fd6377886a36c1eb61945071e599c34dd1b`, exported as an internal-only IPA, and uploaded through telemetry-off strict authentication with the named `Parsely ASC` profile. The exact IPA SHA-256 is `60a985c44c3e3e2c75aa926ea3a2b6d4e99765511af899b37ffab28640de5ef6`; it reports Bots enabled, `TFInternalTestingOnly=true`, exact app/widget/App Group identities, Apple Distribution team `5WP229CBB8`, `get-task-allow=false` for both bundles, no XCTest content, and a valid strict deep signature. Exact App Store Connect build `b5bf4299-7e86-4304-97e1-77e77af9b09c` is `VALID`, assigned to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), reports `internalBuildState=IN_BETA_TESTING`, and keeps `externalBuildState=NOT_APPLICABLE`.

On 2026-08-23, owner-authorized build `18` was archived from source commit `9691c7d00`, exported and uploaded with the checked-in internal-only policy, and processed as `VALID`. Exact App Store Connect build `47ca3b75-24c4-4fa5-bb28-14767a04fbbe` is assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), reports `internalBuildState=IN_BETA_TESTING`, and keeps `externalBuildState=NOT_APPLICABLE`. It contains the exact one-persistent-chat-per-Bot contract, cache-first iOS Bot state, optimistic favorites, cold-only skeleton loading, honest access conflict recovery, and persisted Bot model authority. The Xcode managed upload did not retain a local exported IPA, so no local IPA digest is claimed for build `18`.

On 2026-08-23, owner-authorized build `19` was archived from source commit `190329463`, exported and uploaded with the checked-in internal-only policy, and processed as `VALID`. Exact App Store Connect build `e52c1988-56e6-4cea-8de3-ce27711ef970` reports minimum iOS 18.0 and `usesNonExemptEncryption=false`, `internalBuildState=READY_FOR_BETA_TESTING` for the `Internal Testers` group (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), and keeps `externalBuildState=NOT_APPLICABLE`. The iOS app binary carries the same Bot contract as build `18` at the bumped build number; the paired Mac at that source commit adds desktop capability/access IPC, the five-page Mac Bot editor wizard, and its then-current catalog re-base/inventory tolerance. Later unbuilt source hardening replaces that tolerance with bounded fresh-inventory transaction retries, atomic desktop creation, and conflict-safe Mac/iOS edit rebasing; those fixes require a later TestFlight build. The Xcode managed upload did not retain a local exported IPA, so no local IPA digest is claimed for build `19`.

On 2026-08-23, owner-authorized build `20` was archived from source commit `78e6c77f9`, exported and uploaded with the checked-in internal-only policy, and processed as `VALID`. Exact App Store Connect build `835fe999-4821-4755-8906-2d71c56a4f11` reports minimum iOS 18.0 and `usesNonExemptEncryption=false`, is assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), reports `internalBuildState=IN_BETA_TESTING`, and keeps `externalBuildState=NOT_APPLICABLE`. It includes the post-build-19 atomic creation, fresh-inventory retry, conflict-safe edit rebasing, contact-first Messages-inspired Bot flow, stable avatar cache, rounded tail-free bubbles, restored shared composer, removal of Read Aloud, and immediate exact-cache Bot chat hydration with layout-shaped cold skeletons. The Xcode managed upload did not retain a local exported IPA, so no local IPA digest is claimed for build `20`.

On 2026-08-24, owner-authorized build `21` was archived from source commit `e457df9d8`, exported and uploaded with the checked-in internal-only policy, and processed as `VALID`. Exact App Store Connect build `79c1ac3f-329e-4a4b-8585-0b156657fba1` reports minimum iOS 18.0 and `usesNonExemptEncryption=false`, is assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), reports `internalBuildState=IN_BETA_TESTING`, and keeps `externalBuildState=NOT_APPLICABLE`. Bot chats render only the terminal answer by default and keep intermediate assistant narration plus tool steps behind the expandable activity disclosure; cumulative stream replacements no longer append to stale Bot progress. The focused physical chat suite passed 63/63, the iOS release policy passed 30/30, and the complete physical iPhone 13 Pro suite executed 281 tests with six expected environment skips and zero failures. The Xcode managed upload did not retain a local exported IPA, so no local IPA digest is claimed for build `21`.

The local `npm run ios:asc-monitor` command is the only approved Codex-automation entry point. It requires the exact numeric App ID, exact build ID where applicable, and an explicit Aiden Keychain profile; enforces telemetry-off strict authentication; uses only read operations; and redacts TestFlight tester/feedback/crash content into change-detection summaries. Its focused tests are registered in `npm run test:ios-release` and the normal repository test gate.

For a deliberate local export after the owner installs valid iOS distribution signing and confirms the App Store Connect record, export the exact reviewed archive with one of these configurations:

```sh
xcodebuild -exportArchive \
  -archivePath /tmp/AidenOnTheGo.xcarchive \
  -exportPath /tmp/AidenOnTheGoExport \
  -exportOptionsPlist ios/ci/TestFlightExportOptions.plist \
  -allowProvisioningUpdates
```

Use `ios/ci/ExternalTestFlightExportOptions.plist` only when the build is intentionally eligible for external TestFlight/Beta App Review.

## Distribution gates

Before export or upload:

1. The owner selected version `0.1.0` for the first internal TestFlight train. Build `1` was rejected during upload because the App Store icon contained alpha; subsequent builds incrementally repaired the icon, compact navigation, native shell, cold-connect loading, scratch/activity branding, interaction/model UI, provider metadata, pairing, attachments, multi-device/Mac hardening, approval lifecycle reconciliation, outbound image sharing, activity presentation, and the Bots-first experience. Build `21` is the current processed internal candidate. Increment the build number for later uploads; selecting the first public version remains a later product decision.
2. Configure iOS App Store distribution signing/profiles for the app, Live Activity widget, and App Group under team `5WP229CBB8`, then verify the exported app and extension have `get-task-allow=false` and the exact approved identifiers.
3. With the correct Aiden credential, inspect the existing **Aiden - Quick AI** TestFlight record and confirm whether Aiden On The Go reuses it or requires a distinct App Store Connect record and SKU.
4. Publish the mobile-specific privacy-policy additions, make a working support contact visible at the resolved support URL, then supply the age-rating answers and required iPhone/iPad screenshots. The public URLs, owner name, feedback email, and copyright are resolved in `APP_STORE_METADATA.md`.
5. Provide App Review with a reachable companion Aiden Agent and explicit pairing/review instructions. Do not submit placeholder credentials or a setup that only works on the developer's private LAN.
6. Complete the physical-iPad, real-Tailscale, background/reconnect, Siri, microphone/dictation, and Live Activity acceptance gates recorded in the implementation plan.
7. Re-run the full release checklist against the exact distribution-signed archive and exported IPA before upload.

Draft product copy and the unresolved App Store fields live in `APP_STORE_METADATA.md`.

Never upload an archive built with a personal/imported compatibility identifier, an Apple Development identity, or `get-task-allow=true`.
