# App Store Connect CLI runbook

`asc` is the owner operations and read-only monitoring client for Aiden On The Go. The Hermex-derived GitHub upload workflows remain self-contained and do not install a mutable third-party CLI during an archive. Use `asc` after upload for App Store Connect inspection, deterministic metadata plans, validation, TestFlight operations, and Codex monitoring automations.

## Local tool and safety policy

- Audited local binary: Rork `asc` `3.4.0`, installed from the Homebrew stable formula on 2026-08-19.
- Use the stable command contract shown by `asc <command> --help`; do not script experimental screenshot capture/framing commands.
- `asc` command telemetry is enabled by default on this Mac. Aiden operations must set `ASC_TELEMETRY_DISABLED=1` per invocation. The user's global CLI preference was not changed.
- Use `--strict-auth` for API commands so a profile cannot silently mix with partial environment credentials.
- The owner authorizes the existing `Parsely ASC` Keychain profile for Aiden operations within the resources it can actually access. Name it explicitly with `--profile "Parsely ASC"`; never rely on ambient/default credential selection or treat its zero-app result as authority to duplicate the existing public Aiden beta.
- Prefer JSON output for automation and exact App Store Connect IDs after resolving them read-only.
- Credentials belong in macOS Keychain or protected CI secrets. Never create or commit `.asc/config.json`, cached web sessions, `.p8` files, JWTs, passwords, or two-factor codes.
- Run read-only discovery first. App creation, bundle registration, capability edits, profile/certificate creation, metadata application, screenshot upload, tester changes, review submission, pricing, and availability changes require explicit owner authorization and an exact reviewed target.

## Read-only audit — 2026-08-19

The installed CLI has one default System Keychain profile named `Parsely ASC`. The owner authorizes using it for Aiden resources within its visible scope. A cached Apple web session is not authenticated.

With telemetry disabled and strict authentication:

- `asc apps list --bundle-id sbtbiswas.AidenOnTheGo` returns zero accessible App Store Connect app records.
- Aiden's live website links to the active public TestFlight invitation `https://testflight.apple.com/join/s3T4T8y3`. On 2026-08-19, Apple's invitation page identified that beta as **Aiden - Quick AI**, available on iOS, with test instructions for the existing macOS product. The page does not expose the app's bundle ID or App Store Connect numeric ID.
- The Developer Portal contains the universal bundle ID `sbtbiswas.AidenOnTheGo` under team `5WP229CBB8`, with App Groups enabled.
- The Developer Portal result does not contain `sbtbiswas.AidenOnTheGo.LiveActivityWidget`.
- No provisioning profile is linked to the Aiden app identifier through this API profile. The accessible team has one iOS Distribution certificate and three unrelated iOS App Store profiles; none is named for Aiden.
- The local keychain still has no Apple Distribution private-key identity, matching the earlier Xcode signing audit.

These findings prove only what the active API key can access. The public Aiden beta is positive evidence that an Aiden App Store Connect record exists outside this profile's visible scope, although it does not prove whether that record owns `sbtbiswas.AidenOnTheGo`. Before mutation, switch to a dedicated Aiden/release profile and resolve that existing record's numeric ID, platforms, and bundle ID. Zero accessible app records must not be treated as permission to auto-create one.

Reproduce the non-mutating checks without printing unrelated account data and always select the owner-authorized profile explicitly:

```sh
ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" apps list \
  --bundle-id sbtbiswas.AidenOnTheGo \
  --output json --pretty
ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" bundle-ids list \
  --paginate --output json
ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" certificates list \
  --certificate-type IOS_DISTRIBUTION,DISTRIBUTION \
  --paginate --output json
ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" profiles list \
  --profile-type IOS_APP_STORE \
  --paginate --output json
```

Filter the bundle/profile responses locally before saving evidence so unrelated apps, identifiers, and signing metadata are not copied into this repository.

## Resolved internal-TestFlight state — 2026-08-19

The earlier zero-record audit is retained above as historical evidence. The owner subsequently created and authorized the distinct **Aiden On The Go** record and provisioned distribution signing:

- App Store Connect App ID: `6803233275`; bundle ID: `sbtbiswas.AidenOnTheGo`; marketing version: `0.1.0`.
- Live Activity widget bundle ID: `sbtbiswas.AidenOnTheGo.LiveActivityWidget`.
- Internal group: `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`).
- Build `1` upload was rejected with `ITMS-90717` because its App Store icon had transparency.
- Build `2` uses the exact opaque RayChat `.icon` package, is Apple Distribution-signed with `get-task-allow=false`, processed as `VALID`, and is `IN_BETA_TESTING` for the internal group.
- Build `3` fixes compact iPhone workspace navigation and preserves the same internal-only distribution contract.
- Build `4` carries the Aiden-native shell refresh but was superseded after a cold-connect home-load edge was found locally.
- Build `5` retries home loading on the connected-state transition; build `6` adds the final scratch/navigation/Live Activity branding repairs.
- Build `7` adds Thinking Orbs, the existing/new/scratch New Agent choices, hopeful server-confirmed mutations, relative-time and landing cleanup, the theme-continuous Liquid Glass composer, explicit keyboard dismissal, and nested per-model thinking-level menus. It is the current `VALID` / `IN_BETA_TESTING` candidate and remains internal-only.
- Build `8` adds Mac-owned model visibility, sanitized custom provider artwork sync, corrected iOS thinking-model rows, waveform-only dictation status, and a true floating New Agent home action. It is `VALID`, `IN_BETA_TESTING` for `Internal Testers`, and externally `NOT_APPLICABLE`.
- Build `9` adds first-class Concentrate, the refined “Your Activity” and full-width Total Tokens view, and bounded synchronization of Apple Foundation Models-generated chat titles into iOS. It is `VALID`, `IN_BETA_TESTING` for `Internal Testers`, and externally `NOT_APPLICABLE`.
- Build `10` adds authenticated pairing completion plus accepted multi-device, multi-Mac, listener-allocation, Tailscale-ownership, revocation, and iOS cache-isolation hardening. It is `VALID`, `IN_BETA_TESTING` for `Internal Testers`, and externally `NOT_APPLICABLE`.
- Current exact build resource ID: `426041ab-8638-4b6a-9d10-59ab2ee5b79b` (build `9`: `7ed5d771-0ebe-4e38-b9e9-fab9c564794f`; build `8`: `b0d3c1c0-ab61-469f-9e4f-9dd250e1ff1a`; build `7`: `717b6381-4dec-4cce-85d1-72b503c28590`; build `6`: `aa994233-1bf3-4482-86f5-b8b0356eee25`; build `5`: `6173d5e2-0e58-4d0a-92fa-fc804fc82c37`; build `4`: `ee5b7c23-14d6-44e7-a4ba-6a5003018758`; build `3`: `e5f0ae7e-35aa-451e-be87-bc039885b2de`; build `2`: `721aeb9d-2b33-4729-8d10-5bc1783abbef`).

The account holder is assigned to the internal group. The terminal valid state does not need a processing automation; future uploads may use the checked-in read-only monitor with the exact new build ID.

## Owner-authorized reconciliation and bootstrap

The remaining bootstrap has two distinct authorities:

1. An App Store Connect API key with access to team `5WP229CBB8` can register the missing widget identifier and manage public-API signing/capability resources.
2. The correct Aiden App Store Connect profile or authenticated Apple web session is required to inspect the existing **Aiden - Quick AI** record and decide whether Aiden On The Go belongs in that record or a distinct one.

First resolve the existing record read-only. Do not join the public beta as an operational shortcut, and do not create a second record merely because the current Parsely-named API key returns zero apps.

Only after that reconciliation, execute the missing-widget mutation if the owner authorizes it:

```sh
ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" bundle-ids create \
  --identifier sbtbiswas.AidenOnTheGo.LiveActivityWidget \
  --name "Aiden On The Go Live Activity Widget" \
  --platform IOS
```

If the owner confirms that Aiden On The Go requires a distinct record, initial app-record creation is a web-session workflow in `asc 3.4.0`; `asc apps create` was removed. It requires an authenticated Apple web session and may require an interactive password and two-factor approval. Do not run this shape until the owner also confirms the first marketing version and authorizes the irreversible record:

```sh
ASC_TELEMETRY_DISABLED=1 asc web apps create \
  --name "Aiden On The Go" \
  --bundle-id sbtbiswas.AidenOnTheGo \
  --sku aiden-on-the-go-ios \
  --platform IOS \
  --primary-locale en-US \
  --version "<OWNER-CONFIRMED-VERSION>"
```

After creation, record the numeric App ID and App Info ID in protected owner configuration, not source defaults that could target the wrong app.

## Metadata and validation flow

Use dry-run/read-only commands before every apply:

```sh
ASC_TELEMETRY_DISABLED=1 asc metadata validate \
  --dir ios/app-store/metadata \
  --output table

ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" app-setup categories set \
  --app "$ASC_APP_ID" \
  --primary DEVELOPER_TOOLS \
  --secondary PRODUCTIVITY

ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" age-rating view \
  --app "$ASC_APP_ID" --output json --pretty

ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" metadata apply \
  --app "$ASC_APP_ID" \
  --version "$AIDEN_IOS_VERSION" \
  --platform IOS \
  --dir ios/app-store/metadata \
  --dry-run

ASC_TELEMETRY_DISABLED=1 asc --strict-auth --profile "Parsely ASC" validate \
  --app "$ASC_APP_ID" \
  --version "$AIDEN_IOS_VERSION" \
  --platform IOS \
  --output markdown
```

The checked-in canonical localization files contain only fields resolved in `APP_STORE_METADATA.md`; optional `promotionalText`, `whatsNew`, `privacyChoicesUrl`, and `privacyPolicyText` keys are intentionally omitted rather than set to empty strings. The version path matches the owner-approved first internal TestFlight train, `0.1.0`; build `1` was rejected for an alpha-bearing App Store icon, build `2` corrected the icon, and build `3` is the current compact-navigation candidate. The category command mutates immediately, so run it only after the resolved IDs and category decision in `APP_STORE_METADATA.md` are approved. Age-rating edits use `--all-none --age-rating-override-v2 THIRTEEN_PLUS` plus the exact reviewed flags. App Privacy is an Apple web-session surface in this CLI: use `asc web privacy pull` and `plan` first; `apply` and `publish` remain separate owner-confirmed mutations.

`asc screenshots capture` is not an approved iOS path for this project because its local iOS capture workflow targets a simulator. Capture on physical devices with `xcrun devicectl device capture screenshot`, remove alpha by exporting an opaque JPEG when necessary, then use `asc screenshots validate` before any upload. A provisional physical iPhone 13 Pro capture at `1170 × 2532` converted to opaque JPEG and passed `asc screenshots validate --device-type APP_IPHONE_58`; it is evidence of the pipeline, not a final release asset.

## Codex automation policy

Create automations only after `ASC_APP_ID` resolves to the reviewed Aiden record and at least one build exists. Every automation must be read-only, set `ASC_TELEMETRY_DISABLED=1`, use `--strict-auth`, include the exact App ID/platform, and report state changes rather than mutating App Store Connect.

The registered `npm run ios:asc-monitor` wrapper enforces those rules. It requires an explicit named Keychain profile and therefore cannot silently fall back to ambient credentials. The owner-authorized `Parsely ASC` profile may be supplied once the exact Aiden App ID/build are known. App IDs must be numeric App Store Connect IDs; processing and TestFlight modes additionally require the exact build resource ID. Processing executes `builds info --build-id` instead of selecting the latest build. TestFlight output contains only counts, newest timestamps, and deterministic fingerprints—never tester identity, feedback text, screenshot URLs, or crash content.

After the correct IDs and profile exist, use these command shapes in Codex automations:

```sh
npm run ios:asc-monitor -- \
  --mode processing \
  --profile "<AIDEN-KEYCHAIN-PROFILE>" \
  --app-id "<NUMERIC-APP-ID>" \
  --build-id "<EXACT-BUILD-ID>"

npm run ios:asc-monitor -- \
  --mode review \
  --profile "<AIDEN-KEYCHAIN-PROFILE>" \
  --app-id "<NUMERIC-APP-ID>" \
  --version "<OWNER-CONFIRMED-VERSION>"

npm run ios:asc-monitor -- \
  --mode testflight \
  --profile "<AIDEN-KEYCHAIN-PROFILE>" \
  --app-id "<NUMERIC-APP-ID>" \
  --build-id "<EXACT-BUILD-ID>"
```

Useful lifecycle cadences:

- Every 15 minutes after an upload: processing mode until the exact build reaches `VALID`, `FAILED`, or `INVALID`.
- Hourly while a submission is active: review mode, notifying only on state changes or blockers.
- Daily during internal/external testing: TestFlight mode for the exact app/build, notifying when counts, newest timestamps, or fingerprints change; inspect sensitive content only interactively in App Store Connect.

Do not create a placeholder automation for build `2`: it is already terminal `VALID` and `IN_BETA_TESTING`. For a future upload, create a processing monitor only after that upload has an exact build resource ID, then stop/archive it when the watched state is terminal.
