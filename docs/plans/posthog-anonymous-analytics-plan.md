# PostHog Anonymous Analytics Integration

Status: Proposal — pending decisions (consent model, hosting region, event list)
Date: 2026-09-21
Scope: Electron desktop (main + renderer), iOS (`AidenOnTheGo`), Android (`AidenOnTheGo`)

## Why this needs care

`logging-and-diagnostics-upgrade-plan.md` established a hard privacy boundary:

- "no analytics SDK, hosted relay, remote crash reporter, or background upload"
- product analytics / engagement tracking listed as an explicit **non-goal**
- diagnostics leave the device only after an explicit user export action

Adding PostHog deliberately amends that position. The plan therefore treats
**consent and anonymity guarantees as the feature**, not an afterthought, and
updates the affected docs so the repo no longer contains contradictory policy.

## Target architecture

One PostHog project ("Aiden"), three SDKs, one shared anonymous event contract:

| Surface | SDK | Install ID | Consent store |
| --- | --- | --- | --- |
| Desktop renderer (React) | `posthog-js` | random UUID in main-owned config | same flag, shared via IPC |
| Desktop main process | `posthog-node` | same UUID | `main/services/analytics.ts` reads config |
| iOS | `posthog-ios` (SPM) | UUID in `UserDefaults` | `UserDefaults` / `@AppStorage` |
| Android | `posthog-android` | UUID in `SharedPreferences` | `SharedPreferences` (non-secure prefs; `AidenSecureStore` is for credentials) |

- Each install gets a random UUID `distinct_id` generated on first launch —
  no hardware ID, IDFA/IDFV, pairing identity, email, or account.
- `person_profiles: "identified_only"` everywhere; we never call `identify()`.
  Events stay anonymous; PostHog creates no person profiles.
- All SDK events flow through a per-platform `Analytics` facade exposing only
  `capture(name: ClosedEventName, props?: ClosedPropSet)`. Free-form event
  capture is impossible by construction — same allowlist discipline the
  diagnostics journal already uses.
- Platform is a property (`app_platform: desktop-macos | ios | android`), not
  separate projects, so cross-surface funnels work out of the box.

## PostHog project configuration

- **Cloud (recommended)** vs self-hosted. If cloud: pick EU or US region once —
  it cannot be changed later. EU is the better fit for the privacy posture.
- Project settings to set at creation:
  - GeoIP enrichment **disabled** (or send `$geoip_disable: true` per event).
  - Session replay, heatmaps, autocapture, surveys, toolbar: **off**.
  - Data retention: set explicitly (suggest 12 months).
  - Optionally create a second project/environment for dev builds so test
    traffic never pollutes production dashboards.
- The PostHog **project API key is public/write-only** by design — safe to
  ship in the binary. Deliver it per platform:
  - Desktop: build-time constant (vite define / `main` config), or Info.plist
    key read like `AppConfig.botFirstMobileEnabled` on iOS.
  - iOS: `AidenPostHogKey` + `AidenPostHogHost` keys in Info.plist, read via
    `AppConfig` (existing pattern).
  - Android: `BuildConfig` fields populated from `gradle.properties` / CI env.

## Anonymity & consent design

- **Consent model (decision needed):**
  - **Recommended: opt-in** — a card in onboarding / first-run plus a
    Settings toggle, default OFF. Consistent with the published privacy
    posture; nothing transmits until the user says yes.
  - Alternative: opt-out with a first-run notice. More coverage, weaker fit
    with PRODUCT.md's "privacy model" claim. If chosen, still gate the first
    flush until the notice has been displayed once.
- Consent flag is checked **before SDK init**. While undecided/consent=off,
  `capture()` is a no-op (no queueing — anonymous analytics isn't worth a
  persistent pre-consent buffer).
- Opt-out path: `posthog.opt_out_capturing()` + `posthog.reset()` + rotate
  the install UUID so nothing links pre- and post-opt-out data.
- Never captured: prompts, chat text, tool args/results, file/workspace paths,
  URLs, repo names, provider endpoints/keys, emails, device serials, IPs
  beyond transient ingestion, pairing device IDs.
- Allowed common props: `app_version`, `app_platform`, `os_version_major`,
  `os_locale_coarse`, `appearance_theme`, build channel (dev/release).

## Event taxonomy v1 (allowlist)

Shared contract files: `renderer/shared/analytics-events.ts` (desktop),
`AnalyticsEvent.swift` (iOS), `AnalyticsEvent.kt` (Android) — each defines the
closed set of names and per-event allowed property keys.

Suggested starting set (kept deliberately small):

- `app_launched` (version, platform, cold|warm)
- `onboarding_completed`, `onboarding_skipped`
- `chat_sent` (provider_class: local|hosted, has_attachments — no text)
- `feature_used` with `feature` ∈ {voice_dictation, scheduled_task,
  bot_created, remote_paired, mcp_server_added, worktree_created}
- `settings_changed` (`setting_key` only, never values)
- `app_update_installed` (from_version → to_version)
- Screen views on mobile: off by default; enable per-screen later if needed.

Desktop split: renderer captures UI-origin events (`chat_sent`,
`settings_changed`, navigation); main captures lifecycle events
(`app_launched`, `app_update_installed`, remote pairing outcomes, crash-loop
recovery — reusing the typed categories from the diagnostics work).

## Implementation phases

**Phase 0 — Decisions & setup (no code)**
- Create PostHog project(s), choose region, set retention, disable
  GeoIP/replay/autocapture.
- Decide opt-in vs opt-out; approve the v1 event list.
- Add `POSTHOG_PROJECT_KEY`/`POSTHOG_HOST` to CI/release secrets for mobile
  BuildConfig/Info.plist injection.

**Phase 1 — Desktop core**
- Add `posthog-js` + `posthog-node` deps (pin versions ≥7 days old).
- `main/services/analytics.ts`: consent flag in app config (alongside
  `aiden-config-dir` state), install UUID, `posthog-node` client, typed
  capture, flush on quit (SDK handles offline queueing — important for
  local-model users who may be offline).
- IPC: `analytics:getConsent` / `analytics:setConsent` /
  `analytics:capture` channel added to `preload-channels.ts` so the renderer
  routes UI events through main's allowlist (keeps one authority; avoids the
  renderer needing the key at all — alternative: renderer uses `posthog-js`
  directly; routing via main is cleaner for consent + allowlist enforcement
  but adds IPC hops. Recommend: renderer captures via main IPC).
- Settings: new "Privacy" entry in `SETTINGS_DESTINATIONS` +
  `settings-view.tsx` nav (App group), hosting the analytics toggle next to
  the existing Diagnostics controls in `about`/`diagnostics` — or a dedicated
  `PrivacySettings` section grouping both.
- Check renderer CSP `connect-src` allows the PostHog host if we let the
  renderer call it directly (not needed if all capture flows through main).

**Phase 2 — iOS**
- Add `posthog-ios` SPM dependency to `AidenOnTheGo.xcodeproj`.
- `ios/AidenOnTheGo/Analytics/AidenAnalytics.swift`: init-gated-on-consent,
  anonymous UUID in UserDefaults, closed event enum, `setPersonProfiles` off.
- Consent toggle in the app's settings surface; first-run card if opt-in.
- `AppConfig` keys for PostHog host/key via Info.plist.

**Phase 3 — Android**
- Add `posthog-android` to `gradle/libs.versions.toml` + `app/build.gradle.kts`.
- `analytics/AidenAnalytics.kt` mirroring the iOS facade; UUID + consent in
  default SharedPreferences.
- Toggle row in `features/settings/`; init in `AidenOnTheGoApp.kt`.

**Phase 4 — Compliance & docs**
- Amend `logging-and-diagnostics-upgrade-plan.md` policy bullets and
  PRODUCT.md privacy wording to state the new position: "anonymous,
  consent-gated product analytics; diagnostics remain local-only."
- Update privacy policy at chatwithaiden.com/privacy.
- App Store privacy nutrition label: "Usage Data — not linked to identity —
  analytics" (only if opt-in collection actually ships).
- Google Play Data safety form: same declaration.
- README public boundary note (`docs/public-readiness.md`).

**Phase 5 — Verify & roll out**
- PostHog "Live events" against the dev project for each platform.
- Consent tests: zero network calls to PostHog before consent / after opt-out
  (desktop: assert no egress; mobile: proxy or SDK mock), opt-out rotates
  install UUID, allowlist rejects unknown events/props at compile time.
- Desktop unit tests beside `main/services/analytics.test.ts`; register in
  package.json scripts per repo convention.
- iOS/Android: contract tests mirroring the diagnostics categorical tests.

## Open questions for you

1. Consent model: **opt-in (recommended)** or opt-out with notice?
2. Hosting: PostHog **Cloud EU / US**, or self-hosted?
3. Should desktop main + renderer + iOS + Android share **one project**
   (recommended) with a platform property, or separate projects?
4. Is the v1 event list above the right scope — anything you specifically
   want measured (e.g. remote-pairing funnel, local-vs-hosted model mix)?
5. Who owns the PostHog org/account and where should the project API key +
   host live for CI injection (GitHub Actions secrets)?

## Rough effort

Phases 1–3 are each ~half a session; phases 0/4/5 are mostly decisions,
docs, and verification — about 2 sessions total once decisions are made.
