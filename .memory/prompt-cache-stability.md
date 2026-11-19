# Prompt cache stability (feat/prompt-cache-stability)

Plan: `docs/plans/prompt-cache-hit-rate.md` (one PR, phases 0-8).

## Phase 0 (2026-11-18)

- `main/services/pi-cache-telemetry.ts` ports Pi 1.5.2's unexported `detectCacheMiss` rules and attributes each miss to the first changed section of the normalized transcript: `model`, `retention`, `tools`, `system:<label>` (`base` = head prompt), `messages`, `ttl` or `unknown`. Only hashes and labels are kept.
- Desktop: `llm-client.ts` wraps the stream function with `withPromptCacheTelemetry` (before cache warming). It logs at debug level and adds `lastCacheMiss` to the context pressure feed. Compaction resets the chat's state. The panel shows 0% from cache and "Cache missed: ...".
- `aiden serve`: `daemon-chats.ts` uses the same code, writing to stderr only with `AIDEN_PROMPT_CACHE_DEBUG=1`. `lastCacheMiss` is not in the Remote pressure contract.
- `main/services/prompt-prefix-harness.ts` drives `PiAgentRuntimeHarness` with the real head, AGENTS and MCP refreshers, generation-context transform and Anthropic or OpenAI Responses adapters, offline. `prompt-prefix-stability.test.ts` holds the baseline as `todo` cases. Each later phase turns on its cases.
- Gotcha: the Anthropic adapter merges system patches, so a moved MCP patch looks like `messages` in the transcript fingerprint while the wire bytes are unchanged.
