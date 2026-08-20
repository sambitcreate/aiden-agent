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

On 2026-08-20, version `0.1.0` build `9` was distribution-signed, exported with the internal-only policy, uploaded through the explicitly selected owner-authorized ASC profile, processed as `VALID`, and assigned to the internal group. Exact App Store Connect build `7ed5d771-0ebe-4e38-b9e9-fab9c564794f` reports `internalBuildState=IN_BETA_TESTING` and `externalBuildState=NOT_APPLICABLE`. Build `7` added Thinking Orbs and the refreshed composer/model controls; build `8` added Mac-owned model visibility, sanitized custom provider artwork sync, corrected iOS thinking-model rows, waveform-only listening status, and the home action overlay; build `9` adds first-class Concentrate, the refined Your Activity/Total Tokens view, and bounded Mac-generated title reconciliation on iOS. Build `1` was rejected before processing because its App Store icon contained alpha; builds `2`–`9` use the exact opaque RayChat Icon Composer artwork.

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

1. The owner selected version `0.1.0` for the first internal TestFlight train. Build `1` was rejected during upload because the App Store icon contained alpha; builds `2`–`8` incrementally repaired the icon, compact navigation, native shell, cold-connect loading, scratch/activity branding, interaction/model UI, model visibility, and custom provider identity sync. Build `9` is the current internal candidate with first-class Concentrate, the refined activity summary, and generated-title reconciliation. Increment the build number for later uploads; selecting the first public version remains a later product decision.
2. Configure iOS App Store distribution signing/profiles for the app, Live Activity widget, and App Group under team `5WP229CBB8`, then verify the exported app and extension have `get-task-allow=false` and the exact approved identifiers.
3. With the correct Aiden credential, inspect the existing **Aiden - Quick AI** TestFlight record and confirm whether Aiden On The Go reuses it or requires a distinct App Store Connect record and SKU.
4. Publish the mobile-specific privacy-policy additions, make a working support contact visible at the resolved support URL, then supply the age-rating answers and required iPhone/iPad screenshots. The public URLs, owner name, feedback email, and copyright are resolved in `APP_STORE_METADATA.md`.
5. Provide App Review with a reachable companion Aiden Agent and explicit pairing/review instructions. Do not submit placeholder credentials or a setup that only works on the developer's private LAN.
6. Complete the physical-iPad, real-Tailscale, background/reconnect, Siri, microphone/dictation, and Live Activity acceptance gates recorded in the implementation plan.
7. Re-run the full release checklist against the exact distribution-signed archive and exported IPA before upload.

Draft product copy and the unresolved App Store fields live in `APP_STORE_METADATA.md`.

Never upload an archive built with a personal/imported compatibility identifier, an Apple Development identity, or `get-task-allow=true`.
