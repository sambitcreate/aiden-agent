# Codemode in the CLI and in Bots — 2026-10-27

Branch `claude/project-thread-97a8nm`. After a Pi feature audit the owner chose: codemode on by default in the CLI, codemode for Bots too, and CLI MCP tools hidden behind codemode like the desktop. Cache warming stays a user setting; virtual models are not wanted.

## CLI default (`packages/cli/src/codemode-default.ts`)
- `cli-runtime.ts` appends `--tools +codemode` unless the command line has a tool flag (`--tools/-t`, `--no-tools/-nt`, `--no-builtin-tools/-nbt`, `--no-extensions/-ne`) or a settings file's `defaultTools` names codemode (`+codemode`, `-codemode`) or replaces the defaults with plain names. Turning it off: `"defaultTools": ["-codemode"]`.
- Pure module so Node's strip-types harness can import the runtime (`tests/runtime.test.mjs` spawns it like the fullscreen default).

## CLI MCP behind codemode (`packages/cli/src/mcp.ts`)
- `createMcpExtension(agentDir, { deferToCodemode: true })` only in the interactive list (`extensions/index.ts`). Daemon chats (`daemon-chats.ts`) do not load codemode, so they keep declaring MCP tools directly.
- Only `auto`-exposure servers move; `direct` servers stay declared. Registration uses Pi's `exposure: "codemode"` with a `namespace` (the server's tool prefix alias, its description and instructions).
- `session_start`: if codemode is not active (user turned it off), the deferred tools are re-registered as direct tools so they still work.
- `before_agent_start`: writes the `mcp_servers` prompt section from `renderMcpServersSectionBody` (Pi adds the tags; the desktop's `renderMcpServersSection` wraps the same body), or deletes it without codemode.
- Trap: `session.dispose()` does not emit `session_shutdown`, so an SDK test that starts MCP stdio children must emit it in teardown or the process hangs.

## Bots (`main/services/bot-runtime/bot-extension.ts`, shared by desktop and CLI durable Bots)
- `refresh()` adds a `codemode` tool when any offered tool is scriptable: MCP/connection tools, `isPiCodemodeCallable` file and shell tools, and `web_search`/`bot_recall`. Tools stay declared directly too, so approval-gated tools are never hidden.
- Every script call goes through the same gates as a direct call: `turnAllows` (routine/request scope), `checkPolicy`, approval (call id `<parent>/<n>`, memo namespaced per call) and the bound per-call tool.
- A rule hand-off inside a script is refused with `scriptHandoffBlock` so the Bot calls the tool directly and the person gets the card.
- Script calls are serialized so approval cards never stack. Arguments are capped at 32 KiB and validated with Pi's `validateToolArguments`.
- The `codemode` call itself skips `checkPolicy` (its nested calls are checked); `turnAllows` still applies.
- Activity: the step reads "Ran a script" (`renderer/shared/bot-activity.ts`), phase `working`; computed in main, so phones need no change.
