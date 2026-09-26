# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## Plans

The current plan inventory and status live in [`docs/plans/README.md`](docs/plans/README.md). Update that index when a plan's status changes, and move completed plans into its `completed/` archive.

## UI design references

Follow `docs/design-guide.md` for reusable action shapes, semantic tokens, and accessibility. Reuse the shared squircle button treatment for new and existing actions rather than introducing per-screen button geometry.

Before adding or materially restyling any UI element or component, always review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly, and use the semantic design tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` instead of introducing one-off colors.

Do not put decorative borders or outlines around radio-button choice cards. Communicate selection with the radio control and existing background-state tokens instead. Always preserve visible keyboard `focus-visible` rings or outlines for accessibility.

Keep status colors in soft semantic fills, labels, and icons. Do not add decorative colored borders or outlines to badges, alerts, selection cards, or controls. Non-text keyboard focus uses the neutral focus-ring token.

Text-entry controls must not add an accent border, outline, or ring when focused. Keep their resting border unchanged and communicate focus with the existing input-background and caret states. This rule applies to inputs, textareas, and search-field wrappers, not to non-text keyboard controls that still require a visible `focus-visible` treatment.

Settings must follow [`docs/settings-design-system.md`](docs/settings-design-system.md): use the shared page headings, grouped card surfaces, inset separators, and trailing controls derived from Appearance. Use the SD-card `MemoryCardIcon` for Memory. Never introduce brain icons or brain illustrations anywhere in the app.

## Release model metadata

models.dev may be contacted only by `npm run models:refresh`, the release refresh invoked by `npm run dist`, the scoped post-merge catalog workflow, the user-initiated foreground **Update model catalogs** action in Settings → Providers, or its CLI counterpart: the explicit, user-initiated foreground `aiden catalog models-dev fetch` command, which follows the same rules. The live action and the CLI command may request only the fixed `https://models.dev/api.json` endpoint without credentials, cookies, prompts, chats, selections, custom endpoints, or a device identifier; each validated device-local cache is display-only and must never change runtime limits, routing, or selectable inventory. Never add a models.dev call to startup, normal development, unpacked builds, ordinary live-app reads, onboarding navigation, or background polling. Artificial Analysis data and credentials must never be bundled: the live Electron app may contact its fixed Free endpoint only after the user explicitly chooses Connect & fetch or Fetch latest with their own key, then reads the normalized device-local cache offline.

OpenRouter benchmark insights are also manual-only. The live app may contact only the fixed `/api/v1/benchmarks?source=artificial-analysis&max_results=100` endpoint after the user explicitly chooses Connect & fetch or Fetch latest, using the dedicated encrypted Model Pad credential rather than any inference-provider credential. Never send prompts or model traffic during that action, never import OpenRouter's model catalog, never bundle the returned data, and serve ordinary model-info reads only from the normalized device-local cache.

## Aiden CLI (`packages/cli`)

The headless Aiden Agent lives in `packages/cli` as a self-contained npm package with its own lockfile — it is deliberately not an npm workspace of the Electron root. See `packages/cli/README.md` and `docs/plans/aiden-cli-plan.md` for architecture and phasing.

- Never hand-edit `packages/cli/themes/*.json`: they are generated from `renderer/shared/appearance.ts` by `npm run themes` (in `packages/cli`), and the fidelity test fails on drift. Change palettes in `appearance.ts`, then regenerate.
- The rebrand depends on the bundle layout: `dist/app/cli.js` plus the generated `dist/app/package.json` (`piConfig`) must stay the nearest package.json to the bundled code. Restructure `dist/app/` only with that contract and `tests/bundle.test.mjs` in mind.
- Pin pi packages exactly (matching the desktop pin line) and upgrade them through a replay evaluation rather than casually.
- The CLI keeps the same manual-only network posture as the desktop for models.dev, Artificial Analysis, and OpenRouter benchmark data.

## Papercuts

For complex workflows, record concise implementation friction in `.papercuts/troubleshooting.md` as it occurs.

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

Review and update the final feature-tour bento gallery whenever a durable core capability is added or materially changed. Keep the gallery data-driven, show only shipped features that help a new user understand Aiden's first-session value, and preserve hover, keyboard-focus, responsive, and reduced-motion behavior when adding tiles. Every advertised feature must have its own optimized 1024 × 1024 transparent PNG in `renderer/assets/onboarding/`; keep those illustrations cohesive with Aiden's visual language and cover the asset contract in the onboarding test.
