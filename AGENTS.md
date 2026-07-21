# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## UI design references

Before adding any new UI element or component, review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly.

## Release model metadata

`npm run models:refresh` is the explicit development refresh, and `npm run dist` invokes the same release step before packaging. Those are the only paths that may contact models.dev or Artificial Analysis. Never add a public-catalog call to normal development, unpacked builds, or the live Electron app. Artificial Analysis refreshes require both an API key and explicit confirmation that redistribution rights are in place.

## Papercuts

For complex workflows, record concise implementation friction in `.papercuts/troubleshooting.md` as it occurs.
