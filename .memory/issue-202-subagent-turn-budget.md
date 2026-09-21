# Issue 202: bounded read-only subagent turns

2026-09-21. Read-only foreground tasks can explicitly request 1–128 turns;
omission retains 24. The authority and child runner both enforce the selected
ceiling, with parent authority, tool, event, output, protocol, and deadline
limits unchanged. Write, shell, delegation, and mutating MCP tasks cannot
request the wider turn budget.

On a turn-limit stop, bounded assistant-authored text from settled messages is
credential-filtered and returned as explicitly incomplete findings. Source paths
remain useful to the parent; the persisted renderer snapshot gets its stricter
path and environment redaction. Tool outputs, thinking, and aborted assistant
messages are never used as a report. Model-facing partials filter raw and
obfuscated/encoded credentials, including keys split across lines or settled
messages, while retaining unaffected source paths.
Mixed V2 batches add accepted child ceilings to a generation-wide turn ledger,
bounded at 512 turns, so a default sibling cannot truncate an extended scout.
Other limits and cancellations remain
fail-closed. OpenCode v2's task/session design (MIT, studied conceptually)
retains child sessions for continuation and defaults to no step cap; Aiden
retains explicit resource ceilings and does not copy its implementation.

Validation: 68 focused TypeScript tests, type-check, lint, and diff whitespace
passed. Full `test:subagents` is blocked before tests by the local CLT SDK
linker mismatch documented in `.papercuts/troubleshooting.md`. OpenCode Go
`deepseek-v4.1-flash` reviewed the patch twice; remaining launch-parser
hardening is test-only with no production caller.
