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

`CuaDriverHost` owns each session's bridge, broker launcher and lease directory. A runtime is reclaimed only when both children were seen to exit. If one was not, the host keeps the runtime and its directory and `shutdown()` rejects with `cleanup_unconfirmed`, which the controller already reports as a failed teardown.

Everything else stayed as it was. `CuaDriverHost.shutdown()`, `CuaDriverSession` and `ComputerUseController` already had one close promise, exactly-once close notification and a poisoned state (`backend:M116`, `M117`, `M118`). The native broker, guard, supervisor and JSON-RPC filter (`cli-native:N01` to `N04`) were not changed; their frames and process-group identity checks are out of bounds here.
