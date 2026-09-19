# Upgrade 12 — command palette selection identity

2026-09-19. Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

The command palette passed chat title/localized timestamp and model/provider display strings as cmdk `value`. Distinct rows with identical display metadata both reported `aria-selected=true`, leaving keyboard activation ambiguous. Two Electron regressions reproduced this on the baseline.

Dynamic rows now use collision-free values containing namespaced chat/model/provider identity and current search metadata. Their existing searchable text moves to `keywords`; the palette invokes cmdk's default scoring over that metadata so opaque selection IDs do not create new search matches. Static commands retain their existing value-based scoring. Model selection still follows canonical provider revalidation and persisted selection.

Reference study (no source copied): Waku `src/app/command_palette.rs` at `6d433e875d57091906ec0770d8bb9ffc9aa29b83` separates action identity from search text (GPL-3.0 reference). OpenCode `packages/app/src/components/dialog-select-model.tsx` at required `7a6ce05d0939826aa6c8e1c481489a713b2d633f` separates provider/model keys from display filter fields (MIT reference). cmdk's installed README also requires unique item values.

Behavioral regression coverage extends the existing registered chat-shell Electron suite; existing command-palette and model-selection unit suites also pass. It covers duplicate titles/timestamps, same-named models/providers, metadata searches, absent opaque-ID matches, exactly one selected row, active descendant, keyboard navigation, and actual chat/model destination.

No shared server/transcript contracts or native client behavior changed. This repairs an existing command surface, so onboarding inventory and plan status do not change. No visual styling changed. VoiceOver hardware testing is not performed.

Validation: 42 focused renderer unit tests, both type-checks, lint, normal build, and two focused Electron regressions passed. `test:command-system` is 63/64 because baseline `main/services/renderer-readiness-core.test.ts` expects an outdated crash-handler source shape; coordinator owns that separate correction. Hosted checks and central Luna/Pullfrog review remain required after publication.

Pullfrog follow-up: cmdk 1.1.1 updates its cached aliases only when `value` changes. A live `chats:metadata-updated` rename left the old title/timestamp searchable in an open palette. `PaletteResultItem` now includes both record identity and current keywords in a JSON-encoded value, while retaining the mounted option and the metadata-only filter. The Electron regression reproduces the stale result on the initial PR head and checks old-title/date exclusion, new-title/date inclusion, opaque-ID exclusion, and post-update keyboard activation.

Separate observed cmdk limitation: filtering can auto-select a row without updating `aria-activedescendant` until explicit arrow navigation. Reproduced on unchanged initial PR head before any metadata update; reported to the coordinator. Existing and post-update arrow-navigation active-descendant assertions remain covered.

Second Pullfrog follow-up: changing aliases also changed the selected cmdk value, leaving zero selected rows on a highlighted record's update. Independently reproduced selected-chat title, selected-chat timestamp, and selected-model provider-label failures on `7c18506735c59d7424b3d05eb1edc5702a454467`. Result descriptors now provide one shared source of identity/value/keywords for rendering and selection reconciliation. The controlled palette resolves an updated value through the stable record ID, retaining the mounted option and the selected record. If that record disappears or stops matching, reconciliation chooses a visible match with cmdk scoring and persists the fallback.

Latest validation: 45 focused renderer tests; four palette Electron cases (including selected updates requiring exactly one selected row, unchanged active descendant, and Enter activation of the same identity without recovery navigation); existing chat-shell keyboard interaction case; renderer build; both type checks; lint; diff check. All passed. Tests extend already registered contract and Electron suites; no new test script is needed. Fresh exact-head hosted checks and central Luna re-review remain required.

Third Pullfrog follow-up: stale static root command values survived direct entry to another mode because reconciliation only understood dynamic tuples. Every selectable row now shares a mode-specific descriptor inventory: root commands, new chat and retry actions, model and provider rows, refresh, appearance choices, and settings destinations. Reconciliation rejects values outside the current inventory, disabled rows, and filtered rows; force-mounted retries remain eligible. Electron coverage opens all four submodes directly after closing a selected root command, then activates with immediate Enter. Empty/disabled search results and Escape/back transitions are covered too.

Integration exposed an independent readiness race: provider results arriving before settings left the palette model memo empty because its dependency list omitted settings readiness when hiddenModelsByProvider remained undefined. A gated settings:get Electron regression reproduces the zero-model state after settings resolve. The memo now depends on settings.data, including both readiness and hidden-model preferences.

Follow-up validation: all 47 focused renderer tests and ten palette Electron regressions passed, with no retries. Both type checks, lint, renderer build, and diff checks passed. Fresh hosted checks and central review are still required.
The existing chat-shell keyboard interaction Electron test also passed after the final correction.
