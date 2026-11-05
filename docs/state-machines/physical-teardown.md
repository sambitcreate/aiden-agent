# Physical teardown

A process is stopped when something observed it gone. Asking it to stop, a timeout, and a sent signal are not that proof.

## Process groups

`createProcessGroupTerminator` in `main/shared/process-group.ts` owns a group's stop. `finished()` answers with what was seen:

| Settlement | Meaning |
|---|---|
| `not_requested` | Nobody asked this group to stop. |
| `exit_confirmed` | The group is gone, or only zombies remain. |
| `cleanup_unconfirmed` | Something in the group still ran after SIGKILL and the wait that follows it. |

SIGTERM comes first, then SIGKILL after the grace period, then up to two seconds of confirmation. `runBoundedShellCommand` and `runScheduledScript` report `backgroundStopped` only when the stop was confirmed. Their timeout and abort stop watching before that wait, so cleanup cannot rewrite how the command ended.

`recordCheckGroup` in `follow-through/background-jobs.ts` already kept its durable record until exit was observable, and stays as it is. `git-clone-runner.ts` waits for `finished()` before removing its private staging folder but does not read the answer.

## Subagent shell

`createSubagentShellBrokerV2` in `subagents/subagent-shell.ts` owns one approved command from prepare to terminal record. `shutdown()` ends every prepare and dispatch through one stop signal and returns only when they settled, and every caller shares that one result, so the child runner's bounded drain reports a helper that did not stop.

The order per call stays: prepared, authorized, dispatch started, then a terminal record. After dispatch started, an unconfirmed outcome is recorded as `unknown` and never retried. Before it, the call is cancelled and its workspace admission released.

Descendant cleanup is proved in `native/subagent-shell-runner/main.c`, which reports `cleanup_unconfirmed` itself. The native protocol is unchanged.

## Computer Use host

`CuaDriverHost` owns each session's bridge, broker launcher and lease directory. A runtime is reclaimed only when both children were seen to exit. If one was not, the host keeps the runtime and its directory and rechecks them before the next session and at shutdown, so a late exit is reclaimed. If an exit is still unseen at shutdown, `shutdown()` rejects with `cleanup_unconfirmed`, which the controller already reports as a failed teardown.

Everything else stayed as it was. `CuaDriverHost.shutdown()`, `CuaDriverSession` and `ComputerUseController` already had one close promise, exactly-once close notification and a poisoned state (`backend:M116`, `M117`, `M118`). The native broker, guard, supervisor and JSON-RPC filter (`cli-native:N01` to `N04`) were not changed; their frames and process-group identity checks are out of bounds here.

## MCP stdio servers

`AidenStdioTransport` in `main/services/mcp-stdio-transport.ts` keeps protocol close and group cleanup apart. `close()` resolves only when the group is gone or the wait after SIGKILL ran out. A group leaves the published list only once nothing in it runs, so whoever force-stops this process can still find a survivor. A survivor is rechecked every second and leaves the list once gone, because a listed ID gets signalled later and could by then belong to something else. SIGKILL is sent only to a group that still exists.

## Owners kept as they are

| Inventory | Owner | Why |
|---|---|---|
| `backend:M121`, `M122` | `bot-computers/host.ts` | A failed stop counts as off only if Lume says so, an unreadable state counts as on, and the slot stays held until then. Read only; no real VM was run. |
| `backend:M089`, `M090` | `acp/` | Shutdown waits for launches and one exit rejects pending calls. On leader exit the group gets SIGKILL and its ledger entry is released without waiting, so a descendant stuck past SIGKILL would be forgotten. Not reproduced and left as is. |
| `backend:M102`, `M103` | `subagents/child-agent-runtime.ts`, `subagent-inference-process-core.ts` | Shutdown returns false and keeps its children when isolation or settlement is not clean. |

## Quit and update install

`createLifecycleCheck` in `main/application-lifecycle-core.ts` serializes close, reload, quit and onboarding reset. `shutdownAndQuit` joins a shutdown already running, and `cleanupApplication` runs once. An accepted update install waits for its quit: if that quit never begins, the install is withdrawn and the update stays ready, so a later ordinary quit cannot install it unasked.

The flags in `main/index.ts` (`backend:M001`) stay where they are. Each is written in few places and the cancel paths reset them, but they have no Electron-free harness, so moving them would trade a read-checked flow for an untested one.

## Not done in this slice

| Inventory | Owner | Why |
|---|---|---|
| `backend:M112` | `follow-through/background-jobs.ts` | Not audited beyond `recordCheckGroup`. |
| `backend:M125`, `M126`, `M130`, `M156`, `clients:C43` | Browser, device helper host, terminal, Ghostty | Not audited. |
| `cli-native:N13`, `O01` | iMCP launcher, bounded-command guard | Not audited. |
| Rank 13 capture and input owners, including `M131`, `M133`–`M138` | Recording, dictation, speech, TTS | Not audited. Permission and device behavior needs real hardware evidence, which this slice did not gather. |
| Rank 14 remainder: `M002`–`M004`, `M165`, `M192` | Startup and updater owners | `M002` already has a pure core. The others were not audited. |
| Shutdown and restart trace across P1 to P4 | All lanes | Needs the P2, P3 and P4 work on one branch, which has not merged. |
