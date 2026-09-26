# PR #187 composer context meter (0.50.0 update, 2026-09-26)

- PR #187 originally shipped ordered thinking traces + the context meter. PR #224 (4f91b799, 05f01dc2) landed chronological thinking on main with `reasoningStartOffset`/`reasoningEndOffset`, reasoning rows, and iOS/Android parity. The merge took main's side for all trace files (timeline, activity feed, message list, presentation rows, protocol/openapi/fixtures, native models/tests) and deleted `thought-disclosure.tsx`.
- Kept: `ChatContextPressureV1` DTO (`renderer/shared/context-pressure.ts`), `projectChatContextPressure` in `generation-context.ts`, `main/services/context-pressure.ts` (ambient profile + journal snapshot caches), `chats:contextPressure` invoke + `chat:context-pressure` push, harness `onContextProjection`, `ContextMeter` in the composer beside the thinking control.
- `buildSystemPrompt` now lives in `main/services/chat-system-prompt.ts` and carries main's device guidance suffix. llm-client imports it.
- llm-client remembers the harness's live projection options on each `onContextProjection`, because the harness mutates its own options object with host-disclosed tools and prompts. llm-client's `generationContextOptions` object is not the same object.
- Ambient estimates skip MCP tools, MCP server instructions and generation-scoped tools, so they read as "estimated" until the chat generates again.
- Ambient estimates do include global + workspace AGENTS.md (Pullfrog on b98bf202): `withAgentsInstructionsEstimate` reuses the runtime refresher, and `agentsInstructionFingerprint` is part of the ambient cache key so edits refresh the estimate. Files the runtime would refuse fall back to the host prompt.
- Plan: `docs/plans/composer-context-meter-plan.md`.
