# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## Plans

The current plan inventory and status live in [`docs/plans/README.md`](docs/plans/README.md). Update that index when a plan's status changes, and move completed plans into its `completed/` archive.

## Keeping docs current

Every change that alters behavior, platform support, commands, settings, versions, contracts, or release/distribution facts must update the affected docs in the same PR. Before finishing, search the docs for claims your change makes stale and fix them; do not leave doc updates for a follow-up.

- Check at least: `README.md`, `PRODUCT.md`, the relevant `docs/*.md` guide (for example `docs/linux.md`, `docs/devices.md`, `docs/aiden-on-the-go-remote-access.md`, `docs/aiden-remote-api-v1.md`), `docs/plans/README.md` status rows, `packages/cli/README.md` for CLI changes, and `ios/` or Android docs and App Store metadata for mobile changes.
- Platform claims (Mac-only, Linux, CLI, iOS, Android) must match `main/services/host-platform-capabilities.ts` and the feature flags; version and pin claims must match `package.json` and `packages/cli/package.json`.
- Dated records (changelogs, TestFlight logs, completed plans) are history: add new entries instead of rewriting old ones.
- If you notice a stale claim outside your change's scope, fix it when it is a small factual correction, or note it in the PR description.

## UI design references

For UI work, follow `GUI.md` and use the `graphical-ui`, `graphical-convert`, or `graphical-audit` skill in `.agents/skills/` as appropriate. Aiden adopts the Untitled theme's structure (motion, borderless surfaces, filled inputs, button padding, type-step ratios) but keeps its own corner radii and preset palettes; the definitions in `renderer/styles.css` and `renderer/shared/appearance.ts` take precedence over the snapshot values in `gui/themes/`. Timeless Grotesk is not used.

Follow `docs/design-guide.md` for reusable action shapes, semantic tokens, and accessibility. Reuse the shared squircle button treatment for new and existing actions rather than introducing per-screen button geometry.

Before adding or materially restyling any UI element or component, always review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly, and use the semantic design tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` instead of introducing one-off colors.

Do not put decorative borders or outlines around radio-button choice cards. Communicate selection with the radio control and existing background-state tokens instead. Always preserve visible keyboard `focus-visible` rings or outlines for accessibility.

Keep status colors in soft semantic fills, labels, and icons. Do not add decorative colored borders or outlines to badges, alerts, selection cards, or controls. Non-text keyboard focus uses the neutral focus-ring token.

Text-entry controls must not add an accent border, outline, or ring when focused. Keep their resting border unchanged and communicate focus with the existing input-background and caret states. This rule applies to inputs, textareas, and search-field wrappers, not to non-text keyboard controls that still require a visible `focus-visible` treatment.

Settings must follow [`docs/settings-design-system.md`](docs/settings-design-system.md): use the shared page headings, grouped card surfaces, inset separators, and trailing controls derived from Appearance. Use the SD-card `MemoryCardIcon` for Memory. Never introduce brain icons or brain illustrations anywhere in the app.

## Release model metadata

models.dev may be contacted only by `npm run models:refresh`, the release refresh invoked by `npm run dist` (and the release workflow), the user-initiated foreground **Update model catalogs** action in Settings → Providers, or its CLI counterpart: the explicit, user-initiated foreground `aiden catalog models-dev fetch` command, which follows the same rules. The live action and the CLI command may request only the fixed `https://models.dev/api.json` endpoint without credentials, cookies, prompts, chats, selections, custom endpoints, or a device identifier; each validated device-local cache is display-only and must never change runtime limits, routing, or selectable inventory. Never add a models.dev call to startup, normal development, unpacked builds, ordinary live-app reads, onboarding navigation, or background polling. Artificial Analysis data and credentials must never be bundled: the live Electron app may contact its fixed Free endpoint only after the user explicitly chooses Connect & fetch or Fetch latest with their own key, then reads the normalized device-local cache offline.

OpenRouter benchmark insights are also manual-only. The live app may contact only the fixed `/api/v1/benchmarks?source=artificial-analysis&max_results=500` endpoint after the user explicitly chooses Connect & fetch or Fetch latest, using the dedicated encrypted Model Pad credential rather than any inference-provider credential. Never send prompts or model traffic during that action, never import OpenRouter's model catalog, never bundle the returned data, and serve ordinary model-info reads only from the normalized device-local cache.

Image-generation catalogs are also manual-only. The OpenRouter models API (`https://openrouter.ai/api/v1/models?output_modalities=image`, no credentials), the fal models API (`https://api.fal.ai/v1/models`, text-to-image and image-to-image categories) and the Replicate collections API (`https://api.replicate.com/v1/collections/text-to-image`) may be contacted only when the user presses **Fetch latest models** for that provider in Settings → Image Generation, with those fixed endpoints, no redirects and bounded pages and bytes. Never fetch them on startup, in the background, or during onboarding; the curated Replicate and fal lists and Pi's OpenRouter image models are bundled, and fetched lists live only in the device-local `image-generation-settings.json`. Image keys live only in the `aiden-internal:image-gen:*` credential namespace (or the dedicated `AIDEN_IMAGE_*` env vars) and never authorize chat, and chat or workspace keys never authorize image generation.

Agent harness runtimes (ACP providers such as Google Antigravity) are also manual-only. The pinned release table lives in source (`main/services/antigravity/release.ts`) with exact URLs, SHA-256 hashes and member sizes; Aiden never fetches release metadata, registries or manifests at runtime. The archive is downloaded from its pinned `dl.google.com` URL only when the user chooses Install in Settings → Providers, and runtime updates arrive only with a new Aiden release. Listing the provider, startup, background catalog refreshes and onboarding navigation must not download, launch the agent, or contact the network; the agent starts only for an explicit sign-in (and the one catalog discovery that follows it), an explicit user "refresh models" action, or an attended desktop chat turn. Its credentials live in the agent's isolated profile under Aiden's userData, never in `~/.gemini`.

Bot computers (Lume and the macOS restore image) are also manual-only.

- Lume ships inside the app at an exact pin (`resources/bot-computers/lume-artifact.json` for provenance; the security values are compiled into `main/services/bot-computers/lume-binary.ts`). It is upgraded only with an Aiden release.
- Aiden runs only the vendored binary, never a `PATH` lookup, the installer, `lume serve`, `lume update` or `lume pull`. Every child process gets `LUME_TELEMETRY_ENABLED=false`, `LUME_UPDATE_CHECK=false` and an isolated `HOME`. Every command names Aiden's storage (`--storage`, or `--source-storage` plus `--dest-storage` for `clone`).
- The macOS restore image is pinned in `main/services/bot-computers/release.ts` (URL, size, SHA-256). It is downloaded from that fixed URL, with no redirects, only after the person chooses **Set up** or **Update base** in Settings → Bot computers.
- Startup, listing, onboarding and background work never download, create or start a VM.
- A Bot computer starts only for that Bot's `computer` or `computer_shell` call, a routine that uses it, the person opening its Computer tab, or the person's Open on its computer sign-in card. Set up, Update base and Set up element control in Settings start the base computer only.

## Product analytics

Anonymous usage analytics and crash reports go only to the fixed PostHog US host (`https://us.i.posthog.com`, project "aiden") from the Electron main process through `main/services/analytics/`. See [`docs/analytics.md`](docs/analytics.md).

- Only events and properties listed in `main/services/analytics/analytics-events.ts` may be sent; the core drops anything else. Never send chats, prompts, replies, file names or contents, paths, credentials, custom provider names or URLs, or free text. Every payload sets `$process_person_profile: false` and uses the random install ID, never a device or account identifier.
- Sending needs all of: a project key, the Settings → About → **Usage data** switch on (on by default), the notice or onboarding row already shown, and neither `DO_NOT_TRACK=1` nor `AIDEN_ANALYTICS=0` in the environment. Turning it off sends one `analytics_disabled`, drops the queue and forgets the install ID.
- The key exists only in distribution builds (`npm run dist`, the release workflow) from the `AIDEN_POSTHOG_PROJECT_KEY` secret, injected into a generated module and never committed. `npm run dev`, unpacked builds, tests and E2E have no key and never construct the client; `AIDEN_ANALYTICS_DEBUG=1` in an unpackaged build logs would-be events instead. A launch no person started (CI, smoke, acceptance) sets `AIDEN_ANALYTICS=0`.
- No feature flags, session replay, autocapture, heatmaps, surveys or renderer-side PostHog SDK. The renderer only reads status and changes the setting over IPC.
- Adding an event means adding it to the registry, its docs row in `docs/analytics.md`, and a test; the Settings "What's sent" sheet renders straight from the registry.

## Aiden CLI (`packages/cli`)

The headless Aiden Agent lives in `packages/cli` as a self-contained npm package with its own lockfile — it is deliberately not an npm workspace of the Electron root. See `packages/cli/README.md` and `docs/plans/aiden-cli-plan.md` for architecture and phasing.

- Never hand-edit `packages/cli/themes/*.json`: they are generated from `renderer/shared/appearance.ts` by `npm run themes` (in `packages/cli`), and the fidelity test fails on drift. Change palettes in `appearance.ts`, then regenerate.
- The rebrand depends on the bundle layout: `dist/app/cli.js` plus the generated `dist/app/package.json` (`piConfig`) must stay the nearest package.json to the bundled code. Restructure `dist/app/` only with that contract and `tests/bundle.test.mjs` in mind.
- Pin pi packages exactly (matching the desktop pin line) and upgrade them through a replay evaluation rather than casually.
- The CLI bundles `main/services` and `renderer/shared` sources directly; `aidenRelativeTsRewritePlugin` in `packages/cli/scripts/build.mjs` maps their NodeNext `.js` specifiers to `.ts`. Do not reintroduce vendored copies (the former `src/vendor/advisor/` copies and their drift test were removed); import the original instead.
- The CLI keeps the same manual-only network posture as the desktop for models.dev, Artificial Analysis, and OpenRouter benchmark data.

## Pull requests, CI, and branches

- Update a shared PR branch by merging `origin/main` into it. Do not rebase or force-push a branch that already has a PR, reviews, or CI history.
- Before requesting bot reviews or waiting on hosted CI, run the narrow suites for the touched surfaces locally. Hosted CI and review bots should not be the first place a failure shows up.
- Treat a PR as mergeable only when CI is green on its exact head commit. After merging `main` in, wait for the new run; do not merge on an earlier head's result.
- Do not cancel CI runs on `main`. Main CI is the baseline every release is cut from.
- Flaky tests: a failure that passes on rerun is still a bug. Rerun failed jobs at most once, then record the spec, the symptom, and the run link in the PR description. Do not paper over it by raising timeouts, adding retries, or weakening `--fail-on-flaky-tests`.
- Known merge-conflict hotspots need a recheck after every `main` merge:
  - the root `package.json` `test` chain. Append new scripts and resolve conflicts by union, keeping every script from both sides.
  - the Aiden Remote protocol revision. Claim the next revision after the one on `main` when the PR merges, not when it was written, and update the iOS, Android, and fixture contracts together.
- Stacked PRs: GitHub closes any open PR whose base branch is deleted. Before deleting a branch by hand, check that no open PR uses it as `baseRefName` as well as `headRefName`. Merged branches are deleted automatically on merge, and GitHub retargets their stacked PRs.
- Never delete a branch or worktree that holds uncommitted or unpushed work. Check `git status` and that the tip is on a remote first.

## Tests

When adding a feature or changing behavior, layout, configuration, or contracts, always check whether existing tests need updating and add or extend tests when coverage is missing. Run the relevant suites before finishing (`npm run test`, or the narrower scripts in `package.json` when the change is scoped). If a new test file is added, register it in the appropriate `package.json` test script so CI picks it up.

"Contracts" means behavioral or API contracts: function outputs, IPC register-and-invoke, and rendered UI (including Playwright). It does not mean grepping production source text.

Changes to shared server contracts or transcript/activity UI must also be checked against both native clients. Inspect iOS and Android consumers, update their implementations and focused tests when behavior is shared, and run the applicable mobile suites even when the originating change is on desktop or server.

When writing or extending tests (TDD or otherwise): tautological tests are harmful. Do not assert the same expression or logic as the system under test, loop an exported constant list through a guard defined from that list and only expect true, or assert that a mock was called with exactly the object the test just constructed with no independent invariant.

Change-detector tests are harmful. Do not lock incidental implementation: exact Tailwind or `className` strings, full JSX snippets, CSS keyframe bodies, private setter call text, rename-sensitive helper spellings, or large snapshots of strings or DOM with no behavioral claim.

Do not create regression tests for bug fixes without a genuine gap in behavior testing. A test must reproduce the user-visible or API-visible failure mode, or provide an independent oracle for the fixed invariant. `doesNotThrow`, "still works", and ticket-ID-only stubs are not enough. Prefer extending an existing behavioral suite over a one-off that only locks the fix's source shape.

Do not add or extend tests that `readFileSync` production `.ts` / `.tsx` / `.css` (or handler sources) and `assert.match` / `assert.doesNotMatch` / substring counts against that source as the primary oracle. Prefer calling the real function with fixtures; rendering (`renderToStaticMarkup` / Testing Library) and asserting structure or behavior; Playwright e2e for user-visible flows; and, for IPC, register-and-invoke or AST-based channel inventory rather than grepping channel string literals out of handler files. Existing `*contract*.test.ts` files that already grep source may stay until a follow-up cleanup. Do not grow them. When you change a surface that is only covered by a source-grep contract, replace or supplement that coverage with a behavioral test in the same PR rather than adding more `assert.match` lines.

House-style examples to emulate (do not rewrite these files as part of instruction-only work): `renderer/lib/chat-message-queue.test.ts`, `main/services/portable-config-core.test.ts`, `main/services/data-store.resilience.test.ts`, and focused parse/validate handler tests that call parsers.

## Onboarding

Aiden's onboarding flow is the first-run place to introduce setup-critical features. When adding a user-facing feature that changes first-run setup, provider/model configuration, profile data, permissions, privacy expectations, or core workspace capabilities, update the onboarding flow so new users learn or configure it at the right moment. Keep onboarding concise, use Aiden theme primitives, preserve macOS-style motion and focus behavior, and do not add network calls beyond the explicit provider/auth actions the user chooses.

Review and update the final feature-tour bento gallery (`renderer/components/onboarding-feature-gallery.tsx`) whenever a durable core capability is added or materially changed. Keep the gallery data-driven, show only shipped features that help a new user understand Aiden's first-session value, and preserve hover, keyboard-focus, responsive, and reduced-motion behavior when adding tiles. Every advertised feature must have its own code-drawn illustration in `renderer/components/onboarding-art/`: a stylized, cropped slice of the real surface it introduces, built from the art kit and theme tokens with one Bot avatar tint per tile, so it follows light, dark, and every theme preset. Do not add raster images to the gallery. Draw body text as skeleton bars and keep real words to the few labels that carry meaning, animate only with the shared `oa-anim-*` classes so Reduce Motion leaves a complete still pose, and keep each new tile covered by the onboarding art test.
