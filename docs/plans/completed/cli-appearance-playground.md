# CLI appearance playground

Status: **Complete** (2026-09-05). This is a design exploration deliverable; applying a chosen design to the CLI is a separate, user-directed task.

- [x] Create an isolated React/Vite package with actual DialKit 1.4.3 controls.
- [x] Offer ten distinct directions: Quiet, Blueprint, Field Notes, Midnight, Focus, Workshop, Expedition, Signal, Paper and Observatory.
- [x] Reuse shared Aiden theme tokens; ship local Manrope and IBM Plex Mono fonts.
- [x] Expose layout, palette, contrast, typography, spacing, chrome, metadata, activity, diff, prompt and motion controls.
- [x] Simulate conversation, tools/diff, approval and startup scenarios, with usable demo prompts and replay/pause.
- [x] Compare baseline/current, save/restore/delete named looks locally and export a proposal brief with notes.
- [x] Preserve responsive behavior, neutral keyboard focus, input focus rules and reduced motion.
- [x] Register focused browser tests and a dedicated CI job; document setup and implementation boundaries.

Validation: production TypeScript/Vite build, focused ESLint, diff check and all four Playwright integration tests pass. Browser visual review confirmed the dark preview and dark/light comparison. React Doctor reports no bug/accessibility findings; two advisory maintainability warnings remain for the multi-layout preview and studio component size.

See [the package guide](../../../packages/cli-playground/README.md). Run `npm ci --prefix packages/cli-playground` once, then `npm run cli:playground` at the repository root. The local URL is http://127.0.0.1:4178.

The CLI parity plan remains active independently because physical-iPhone acceptance is waiting for the phone to be unlocked. No CLI appearance settings, shared remote contracts, onboarding or mobile UI were changed by this playground.
