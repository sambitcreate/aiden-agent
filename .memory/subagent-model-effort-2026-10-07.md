# Per-subagent model and effort selection

Started 2026-10-07 on `cursor/subagent-model-effort-3f30` (PR #379) from main
`bd232b85` (0.54.0). The design adapts openai/codex patterns (#14160, #32749,
#33631, #51463); no code was copied.

- **Policy:** the pure policy lives in `main/services/subagents/subagent-model-selection.ts`.
  Its host binding to Pi runtimes is `subagent-model-runtime.ts`.
- **Precedence:**
  1. Explicit spawn `model`/`effort`.
  2. `settings.subagentModels` role entry, then its `defaultModel`/`defaultEffort`.
  3. The parent's settings.

  A `locked` role applies last and adds a visible warning. A model other than the parent's starts at its own default effort: the user's saved per-model level, otherwise Pi's normalized default. It never inherits the parent's effort.
- **Explicit picks** are strict. An unknown model or an unsupported effort fails the whole batch before anything is prepared or projected. The error lists the allowed values.
- **Configured values** clamp and add warnings. Every warning reaches the parent as a `Model note:` line in the tool result. There is no silent fallback.
- **Guards:**
  - An `allowedModels` allowlist; otherwise models are picked round-robin by provider, parent first, and the list is capped at 6.
  - A `maxEffort` ceiling.
  - Requested hosted models may not cost more than the parent. Local models are exempt, as is the `allowCostlierModels` setting.
- **Schema:** `model` and `effort` appear in the `subagent` tool schema only when at least two models are requestable. The description tells the agent to omit them unless the user asks.
- **Bot and Assistant:** `overridesAllowed=false`. Children always run on the parent model, and an explicit model or effort is refused.
- **Per-child runtime:** the supervisor resolves every child before `prepareRun`. Each child gets its own runtime, effort, scheduler deployment class, and context clone.
  - Depth-2 children inherit their depth-1 parent's choice.
  - The sibling check no longer requires one provider/model fingerprint.
- **Run grant:** the authority binds the child's provider/model fingerprints, `thinkingLevel`, token budget, and `maxActive`. Capabilities, approvals, permission, workspace, and the root/parent ceilings are computed exactly as before. The Full/Ask invariance test lives in `subagent-foreground-persistence-v2.test.ts`.
- **Persistence:** run snapshots carry optional `providerId`, `thinkingLevel`, and `modelSelection`. Older records still parse.
  - An older app build will refuse a store containing the new keys, because its strict parsers don't know them. The store is preserved, not deleted.
  - Children have no on-disk Pi journal; the snapshot plus `authority.thinkingLevel` is the record. The V2 manifest is unchanged.
- **Remote and phones:** `aiden-remote-chat-progress.ts` maps fields explicitly, so phones see only `modelId`, which now reflects the child's real model. No new remote fields; native display is P1.
- **Desktop UI:**
  - Chips get a hover card and announce the model to assistive technology.
  - The detail line adds effort and how the model was chosen.
  - The roster adds a model line only for non-inherited choices.
  - Effort appears only when it was recorded.
- **P1 follow-ups:**
  - A Settings UI for `subagentModels`.
  - Remote/iOS/Android model and effort display behind a capability flag. `ChatAgent` is `additionalProperties:false`, and Android asserts exact keys.
  - Per-child usage attribution to the child's model.
  - An onboarding mention once settings exist.
- **Local verification:** npm is unreachable in cloud VMs, and only github.com resolves. A tsx-like loader stubs npm packages, so only the pure suites run locally. The bundled VS Code TypeScript 6 typecheck was used with a before/after diff.
