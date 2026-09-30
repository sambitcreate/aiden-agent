# MCP numeric schema formats — 2026-09-27

Source: pi-mcp-adapter #651. Rust MCP servers built with `schemars` annotate numeric fields with non-standard formats (`uint`, `uint8`..`uint128`, `int`, `int8`..`int128`, `float`, `double`), and some providers reject tool definitions that carry them.

`main/services/mcp-tool-schema.ts` exports the pure `normalizeMcpToolInputSchema`. It walks every subschema keyword (`properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas`, `items` object or tuple, `prefixItems`, `allOf`/`anyOf`/`oneOf`, `additionalProperties`, `not`, `if`/`then`/`else`, and so on), drops those formats, and, when the schema allows numbers, tightens `minimum`/`maximum` to the width range. Bounds are only added where the value is an exact JSON number (8/16/32-bit). 64/128-bit and pointer widths get only `minimum: 0` for unsigned types. Existing tighter server bounds win. Standard formats (`date-time`, `uri`, ...) are untouched, and the input is never mutated.

Applied only where the schema is handed to the model:
- desktop `McpManager.agentContextFor` (`main/services/mcp.ts`), which covers chats, Bots and scheduled tasks
- CLI `createCliMcpPool().agentTools` (`packages/cli/src/mcp.ts`)

Identity checks keep using the raw server schema: the CLI's per-call drift fence compares against the raw inventory, and subagent schema hashes and grants are unchanged. The subagent read/mutation paths (`subagent-mcp-read.ts` `projectStructuralSchema`) already strip `format` and `$defs` through their structural allowlist, so they were left alone. `peer-response.ts` validates the Aiden Remote protocol, not tool schemas, so it was out of scope.

Tests: `main/services/mcp-tool-schema.test.ts` (in `test:mcp`) uses realistic schemars 0.8 (draft-07) and 1.x (2020-12) fixtures. A strict Ajv rejects the raw schemas ("unknown format") and compiles the normalized ones, and the range oracle accepts or rejects boundary values. The CLI parity MCP test extends its stdio fixture with a `uint32` field and checks both the model-facing schema and the raw inventory.

## Review follow-up

Draft-07 schema-valued dependencies now normalize too; property-name dependency lists remain unchanged. Added strict-Ajv regression and registered the suite in the core-git CI lane. Focused schema tests (7) and CI policy tests (46) pass.

Independent review identified a silent 64-level cutoff that could leave numeric formats unnormalized. Traversal now uses an iterative worklist and weak object-copy map, preserving raw identity and schema-keyword boundaries while normalizing deep schemas fully; a 2,000-level regression covers this case.
