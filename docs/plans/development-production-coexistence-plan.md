# Development and Production Coexistence

Status: In progress

## Problem

The installed production app and the local Electron runtime used nearly the
same visible and runtime identity. The development wrapper already had a
`.dev` bundle identifier, but it still presented as `Aiden Agent`, defaulted to
production-style local and portable storage, competed for global shortcuts,
and did not establish its profile until after main-process imports. That made
side-by-side testing confusing and risked one build observing another build's
state.

## Delivery scope

1. Establish one production/development runtime profile before the main module
   imports and before Electron requests its single-instance lock.
2. Keep production at `Aiden Agent`, its existing Application Support root, and
   `~/.aiden`; put development under `Aiden Agent Dev` and `~/.aiden-dev`.
3. Give the dev wrapper, executable, Electron helpers, window, menu, page title,
   About information, and Dock badge an obvious development identity.
4. Keep Chromium session data, crash data, logs, machine-local settings,
   secrets, chats, schedules, and portable config within the active profile.
   Never seed or copy production data into development.
5. Disable global shortcuts and production update checks in development by
   default. `AIDEN_DEV_GLOBAL_SHORTCUTS=1` is the explicit shortcut opt-in.
6. Preserve an absolute `AIDEN_CONFIG_DIR` override for intentionally isolated
   test runs and reject relative overrides.
7. Cover profile resolution, bootstrap ordering, update/shortcut gates, visible
   bundle branding, and distinct roots with focused tests, then run the regular
   build and repository gates.

## Deliberate boundary

This plan separates the Electron application identities and all Aiden-owned
state. The standalone Apple Foundation Models and Computer Use helpers retain
their existing native bundle identities so their signed production contracts
and macOS permission grants do not silently migrate. A future helper-identity
migration should be its own signed-artifact plan; development does not copy any
helper data from production.

## Acceptance

- `npm run dev` launches `Aiden Agent Dev.app` and can coexist with the
  installed `Aiden Agent.app`.
- The two profiles resolve to distinct Application Support, session, log,
  crash, and portable-config paths before lock acquisition.
- Dev cannot register Aiden's global shortcuts or enable the production updater
  unless an explicit supported opt-in applies.
- Production renderer builds retain the `Aiden Agent` title; the Vite dev
  server advertises `Aiden Agent Dev`.
- Focused branding/config/command tests, type-check, lint, build, and the
  repository test gate pass.
- Two fresh independent reviews report no actionable findings on the frozen
  uncommitted target.
