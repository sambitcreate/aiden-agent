# Skill YAML discovery correction — 2026-09-19

Baseline: Aiden `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`; branch `feature/upgrade-06-skills`.

The old line parser published YAML `>`/`|` as descriptions and promoted nested `name`/`description` fields to top-level metadata. This could hide another authored skill through name collision and leave multiline-description-only edits invisible to registry fingerprints.

`skills-discovery.ts` now reads top-level string scalars from the YAML AST, flattens description line breaks for Aiden's existing safe-display contract, and isolates invalid metadata to its file. It never expands aliases or converts unrelated YAML to JS. Malformed YAML, duplicate keys, non-mapping frontmatter, unsupported tags, and non-string/alias metadata are skipped. Plain Markdown, directory-name fallback, BOM/CRLF, empty frontmatter, and description-only skills remain supported. YAML keys follow their standard case-sensitive spelling. The already-locked ISC `yaml@2.9.0` is now a direct runtime dependency because Electron's main build externalizes packages.

## Source evidence

- Pi `2a9b4ebc680053c64e31f635b0b22d5e22564001`: `packages/coding-agent/src/utils/frontmatter.ts` and `src/core/skills.ts` parse YAML before reading metadata (MIT).
- OMP `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`: `packages/coding-agent/src/discovery/helpers.ts` catches malformed skills individually (MIT).
- Ponytail `16f29800fd2681bdf24f3eb4ccffe38be3baec6b`: `skills/ponytail-review/SKILL.md` uses folded descriptions.
- Gotgenes `4482a5db8385d4538c206816dc5274fa4ab248b1`: `packages/pi-colgrep/skills/colgrep/SKILL.md` uses literal descriptions.
- MattDevy `2ae490f16d669ea101b0811a50cbc37a2514e9a5`: continuous-learning scaffold tests reviewed; learned-skill automation remains outside this fix.
- Narumiruna `229d528b36c4012b542caae5f4cfbe27365a2d17`: `experimental/pi-analytics/src/skills.ts` reviewed; invocation tracking remains outside this fix.

All references under `/Users/sambitbiswas/projects/opp/` were read-only. Implementation and regression fixtures are original; no upstream source or skill prose copied.

## Validation and scope

Three initial regression tests failed against the original parser. Final focused discovery, registry, tools, invocation, Bot inventory, and watcher suites: 64 passed. `npm run type-check`, full `npm run lint`, subsequent changed-file lint, and `git diff --check` passed. Existing discovery test registration covers the added cases; no test script changes required.

No renderer, shared server, transcript, native-client contract, or setup capability changed. Onboarding was reviewed for applicability and needs no change. No Electron packaging, rendered UI, full test run, or mobile suite was needed/performed. Hosted CI and central Luna/Pullfrog review remain separate gates tracked in the campaign status JSON and PR.

## Pullfrog correction — aliased mapping keys

Independently reproduced review thread `PRRT_kwDOTctvDc6j9jCO`: pinned `yaml@2.9.0` accepts `&key name: first` followed by an alias key resolving to `name` without errors/warnings, despite `uniqueKeys: true`. Aiden now requires every top-level mapping key to be a literal string scalar before metadata lookup, rejecting aliased and complex keys without resolving aliases. Valid anchored scalar keys and unrelated alias values (including cyclic metadata) remain compatible. Added four rejection cases and an anchored-key compatibility fixture to the registered discovery suite; the new rejection test failed against head `10989dd8` before the fix. All 64 focused tests, type-check, full lint, and diff checks passed after correction. Hosted validation must run on the new head.
