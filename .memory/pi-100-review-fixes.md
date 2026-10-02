# Pi 1.0 review corrections

## PR301 compaction budgets

- Editing a new exact model key preserves unsaved token fields. Choosing an existing saved key still loads its budget. The real Electron save/relaunch/reset regression now types a new key after entering both budgets and proves they survive.
- Initial and subsequent AGENTS.md changes use one `updateGenerationContextOptions` helper that validates the changed static context against the captured complete options, including compactionReserveTokens, before publishing the prompt/tools. A real instruction-refresher fixture proves a large reserve rejects guidance that fits default budgets without overwriting the previously admitted prompt.
- Node22.22.3:50 focused instruction/context/settings tests pass; root and e2e typechecks pass; Electron budget regression passes (7.8s) with fail-on-flaky-tests. Root build passes.
