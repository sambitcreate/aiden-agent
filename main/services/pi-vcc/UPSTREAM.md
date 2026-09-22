# pi-vcc compiler

Vendored from https://github.com/sting8k/pi-vcc at
`1f1575b6e0a07df51e0a9ea8413394ccac3714ae` (0.7.1).
Upstream README declares the MIT license. Copyright pi-vcc contributors.
Only the pure ranked compiler and its dependency closure are included.

Local adaptations: ESM .js imports; stable source references supplied by Aiden
instead of positional message numbers. No extension hooks, settings scaffold,
raw JSONL reader, network code, or continuation behavior is imported.

Aiden owns v4 history projection, privacy filtering, budgets, worker lifecycle,
and recall. Re-audit these adaptations and run test:vcc when refreshing.

Type-only integration adjustments: unused imports removed, Intl.Segmenter library
reference and optional isWordLike type, and an explicit legacy bashExecution type.
Aiden maps run_command to the compiler's bash vocabulary. Older/LLM checkpoint
summaries are conservatively carried forward opaquely because v4 does not certify
complete pre-import raw-history coverage. The newest replaces earlier opaque
checkpoints; raw active history is still compiled independently.

Lint-only adaptations remove a redundant regex escape and document deliberate
control-byte regexes. Full MIT terms and upstream attribution are shipped in
`THIRD_PARTY_NOTICES.md`.

The numeric-reference coalescer is omitted so each journal reference remains
individually addressable; the upstream per-turn tool-call cap remains.
