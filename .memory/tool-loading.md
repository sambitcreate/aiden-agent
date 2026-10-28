# Built-in tools load on demand — 2026-10-28

Branch `claude/project-thread-89sg0j`. Owner chose options A and B after the token research (Built-in tools was 16.2K on their Mac). Guide: `docs/tool-loading.md`.

## A: one `skill` tool (`main/services/skill-tools.ts`)
- `SKILL_TOOL_NAME = "skill"` lives in `skill-registry-core.ts` (avoids an import cycle). Args `{ name }`; `findSkillByName` matches the toolKey or the canonical name (NFKC, case-insensitive).
- `formatAvailableSkills(snapshot, allowedToolNames, allowWorkspaceSkills)` needs `skill` in the allowed names; `chat-system-prompt.ts` passes `permission !== "none"` so No access hides workspace skills in both the prompt and the tool.
- Bots: `botToolVerdict(name, facts, turn, args)` allows `skill` at offer time when any skill is granted, and at call time only if `facts.skillToolKeyFor(args.name)` maps to a granted key. `bot-tool-assembly.ts` `checkPolicy` passes `call.args`.
- CLI is unchanged (Pi's own skills + `skill_aiden_app`; CLI Bots build their own `skill_<hmac>` tools in `packages/cli/src/bots.ts`).

## B: `load_tools` (`main/services/on-demand-tools.ts`)
- `ON_DEMAND_TOOL_NAMES` is the held-back list; `createOnDemandTools(tools)` returns `{ loader, onDemand, initialTools(messages), prepare(context) }`. Stickiness comes from the transcript: any `load_tools` names or direct call to a held-back name.
- Desktop (`llm-client.ts`): only when `codemode` is declared and not a prepared Bot context. Initial tools are recomputed after `promptJournal.buildContext()`; `prepareCustomModelToolContext` chains browser discovery then `onDemandTools.prepare`. Held-back callable tools are added to the harness `deferredTools` so codemode can still call them.
- `generation-context.ts` skips deferred tools without `discovery` so held-back tools don't show as a deferred connection.
- Bots (`bot-extension.ts`): the loader is installed with the Bot's tools; `beforeRequest` strips held-back declarations with `withoutTools(messages, withheldUntilLoaded(...))`. The loader skips `checkPolicy` in `beforeTool` (CLI Bots' policy refuses unknown names). `computer`/`computer_shell` are not held back.
- e2e fixture (`tests/e2e/fixtures.ts`): a scripted call to a held-back tool first sends a `load_tools` call (`<id>-load-<n>`).
- Measured (e2e fixture, fresh workspace chat): 45 → 22 tools, Built-in tools 9.7K → 3.6K. Bot held-back set (subagent 987, routines 815, share_image 204, inspect_image 131, computer_use 1808) → load_tools ~211.
- Not done: option C (trim long descriptions: subagent, workspace_artifact, schedule_task are the largest).
