# Upgrade 12 — command palette selection identity

2026-09-19. Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

The command palette passed chat title/localized timestamp and model/provider display strings as cmdk `value`. Distinct rows with identical display metadata both reported `aria-selected=true`, leaving keyboard activation ambiguous. Two Electron regressions reproduced this on the baseline.

Dynamic rows now use namespaced chat/model/provider identities. Their existing searchable text moves to `keywords`; the palette invokes cmdk's default scoring over that metadata so opaque selection IDs do not create new search matches. Static commands retain their existing value-based scoring. Model selection still follows canonical provider revalidation and persisted selection.

Reference study (no source copied): Waku `src/app/command_palette.rs` at `6d433e875d57091906ec0770d8bb9ffc9aa29b83` separates action identity from search text (GPL-3.0 reference). OpenCode `packages/app/src/components/dialog-select-model.tsx` at required `7a6ce05d0939826aa6c8e1c481489a713b2d633f` separates provider/model keys from display filter fields (MIT reference). cmdk's installed README also requires unique item values.

Behavioral regression coverage extends the existing registered chat-shell Electron suite; existing command-palette and model-selection unit suites also pass. It covers duplicate titles/timestamps, same-named models/providers, metadata searches, absent opaque-ID matches, exactly one selected row, active descendant, keyboard navigation, and actual chat/model destination.

No shared server/transcript contracts or native client behavior changed. This repairs an existing command surface, so onboarding inventory and plan status do not change. No visual styling changed. VoiceOver hardware testing is not performed.

Validation: 42 focused renderer unit tests, both type-checks, lint, normal build, and two focused Electron regressions passed. `test:command-system` is 63/64 because baseline `main/services/renderer-readiness-core.test.ts` expects an outdated crash-handler source shape; coordinator owns that separate correction. Hosted checks and central Luna/Pullfrog review remain required after publication.
