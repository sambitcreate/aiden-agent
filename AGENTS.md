# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## Plans

The current plan inventory and status live in [`docs/plans/README.md`](docs/plans/README.md). Update that index when a plan's status changes, and move completed plans into its `completed/` archive.

## UI design references

Before adding or materially restyling any UI element or component, always review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly, and use the semantic design tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` instead of introducing one-off colors.

## Release model metadata

`npm run models:refresh` is the explicit development refresh, and `npm run dist` invokes the same release step before packaging. Those are the only paths that may contact models.dev. Never add a models.dev call to normal development, unpacked builds, or ordinary live-app reads. Artificial Analysis data and credentials must never be bundled: the live Electron app may contact its fixed Free endpoint only after the user explicitly chooses Connect & fetch or Fetch latest with their own key, then reads the normalized device-local cache offline.

## Papercuts

For complex workflows, record concise implementation friction in `.papercuts/troubleshooting.md` as it occurs.

## Tests

When adding a feature or changing behavior, layout, configuration, or contracts, always check whether existing tests need updating and add or extend tests when coverage is missing. Run the relevant suites before finishing (`npm run test`, or the narrower scripts in `package.json` when the change is scoped). If a new test file is added, register it in the appropriate `package.json` test script so CI picks it up.
