# MCP numeric schema formats

Status: Complete — merged in [PR #264](https://github.com/sambitcreate/aiden-agent/pull/264) on 2026-09-30; on main after 0.51.0, not yet released.

## Problem

Rust MCP servers built with `schemars` emit numeric JSON Schema formats such as `uint32`, `int8`, `uint`, and `double`. JSON Schema does not define these formats, and some model providers reject tool definitions that include them (pi-mcp-adapter #651).

## Approach

- Add a pure normalizer, `normalizeMcpToolInputSchema` in `main/services/mcp-tool-schema.ts`. It removes the schemars numeric formats at every subschema position and turns the integer width into `minimum`/`maximum` where the bound is an exact JSON number.
- Apply the normalizer only to the schema the model sees: desktop `McpManager.agentContextFor` and CLI `createCliMcpPool().agentTools`. Raw schemas stay the identity for drift checks, fingerprints and grants.
- Subagent MCP paths already project schemas through a structural allowlist that excludes `format`, so they need no change.

## Follow-ups

- The subagent structural projection also drops `$defs`/`$ref`, so a schemars schema that uses references loses its nested shape for subagents. Widening that allowlist changes schema hashes and needs a grant migration, so it is not part of this change.
