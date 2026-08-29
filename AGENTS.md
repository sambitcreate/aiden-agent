# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## Plans

The current plan inventory and status live in [`docs/plans/README.md`](docs/plans/README.md). Update that index when a plan's status changes, and move completed plans into its `completed/` archive.

## UI design references

Before adding or materially restyling any UI element or component, always review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly, and use the semantic design tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` instead of introducing one-off colors.

Do not put decorative borders or outlines around radio-button choice cards. Communicate selection with the radio control and existing background-state tokens instead. Always preserve visible keyboard `focus-visible` rings or outlines for accessibility.

## Release model metadata

`npm run models:refresh` is the explicit development refresh, and `npm run dist` invokes the same release step before packaging. Those are the only paths that may contact models.dev. Never add a models.dev call to normal development, unpacked builds, or ordinary live-app reads. Artificial Analysis data and credentials must never be bundled: the live Electron app may contact its fixed Free endpoint only after the user explicitly chooses Connect & fetch or Fetch latest with their own key, then reads the normalized device-local cache offline.

OpenRouter benchmark insights are also manual-only. The live app may contact only the fixed `/api/v1/benchmarks?source=artificial-analysis&max_results=100` endpoint after the user explicitly chooses Connect & fetch or Fetch latest, using the dedicated encrypted Model Pad credential rather than any inference-provider credential. Never send prompts or model traffic during that action, never import OpenRouter's model catalog, never bundle the returned data, and serve ordinary model-info reads only from the normalized device-local cache.

## Papercuts

For complex workflows, record concise implementation friction in `.papercuts/troubleshooting.md` as it occurs.

## Tests

When adding a feature or changing behavior, layout, configuration, or contracts, always check whether existing tests need updating and add or extend tests when coverage is missing. Run the relevant suites before finishing (`npm run test`, or the narrower scripts in `package.json` when the change is scoped). If a new test file is added, register it in the appropriate `package.json` test script so CI picks it up.

Changes to shared server contracts or transcript/activity UI must also be checked against both native clients. Inspect iOS and Android consumers, update their implementations and focused tests when behavior is shared, and run the applicable mobile suites even when the originating change is on desktop or server.

## Onboarding

Aiden's onboarding flow is the first-run place to introduce setup-critical features. When adding a user-facing feature that changes first-run setup, provider/model configuration, profile data, permissions, privacy expectations, or core workspace capabilities, update the onboarding flow so new users learn or configure it at the right moment. Keep onboarding concise, use Aiden theme primitives, preserve macOS-style motion and focus behavior, and do not add network calls beyond the explicit provider/auth actions the user chooses.

Review and update the final feature-tour bento gallery whenever a durable core capability is added or materially changed. Keep the gallery data-driven, show only shipped features that help a new user understand Aiden's first-session value, and preserve hover, keyboard-focus, responsive, and reduced-motion behavior when adding tiles. Every advertised feature must have its own optimized 1024 × 1024 transparent PNG in `renderer/assets/onboarding/`; keep those illustrations cohesive with Aiden's visual language and cover the asset contract in the onboarding test.
