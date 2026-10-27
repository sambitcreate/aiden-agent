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
- `refresh()` installs Pi Durable's codemode extension (`@earendil-works/pi-durable/codemode`, `models: false`, inline budget 1,000 tokens) when any offered tool is scriptable: MCP/connection tools, `isPiCodemodeCallable` file and shell tools, and `web_search`/`bot_recall`. Other tools get `callers: ["model"]`, so scripts can't reach cards, the Bot's computer or browser, routines or subagents. Tools stay declared directly too.
- Each script call is a durable nested tool task, so the Bot's own `beforeTool` runs for it: `turnAllows`, `checkPolicy`, approval (memo per nested task, id `<parent>/c<n>`). A pending approval survives SIGKILL/Resume under the same wait id and the script replays from its journal (test d2).
- No wall-clock deadline unless the script sets `timeout_ms` (the first, hand-rolled version used `createPiCodemodeTool`'s 120 s deadline, which withdrew unanswered cards; review on #616 caught it, plus the lost approval on Resume).
- A rule hand-off for a nested call (`call.parent` set) is blocked with `scriptHandoffBlock`: hand-off rows belong to transcript calls.
- `codemode` itself skips `checkPolicy`; `turnAllows` still applies.
- Sandbox: `deps.codemodeSandbox`. Desktop default is `new CodemodeSandbox`. The CLI passes the bundled `chunks/codemode-worker.js` as a data: URL plus the quickjs-wasi wasm, since pi-codemode's own worker isn't on disk in the bundle (covered by the parity "durable CLI Bot migration" test's script turn).
- Activity: the step reads "Ran a script" (`renderer/shared/bot-activity.ts`), phase `working`; computed in main, so phones need no change.
