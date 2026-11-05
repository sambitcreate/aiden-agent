# Physical teardown

A process is stopped when something observed it gone. Asking it to stop, a timeout, and a sent signal are not that proof.

## Process groups

`createProcessGroupTerminator` in `main/shared/process-group.ts` owns a group's stop. `finished()` answers with what was seen:

| Settlement | Meaning |
|---|---|
| `not_requested` | Nobody asked this group to stop. |
| `exit_confirmed` | The group is gone, or only zombies remain. |
| `cleanup_unconfirmed` | Something in the group still ran after SIGKILL and the wait that follows it. |

SIGTERM comes first, then SIGKILL after the grace period, then up to two seconds of confirmation. Every probe stays inside those two seconds, and a group of only zombies confirms straight away, since a non-reaping init may never clear it. `runBoundedShellCommand` and `runScheduledScript` report `backgroundStopped` only when the stop was confirmed. Their timeout and abort stop watching before that wait, so cleanup cannot rewrite how the command ended.

`recordCheckGroup` in `follow-through/background-jobs.ts` already kept its durable record until exit was observable, and stays as it is. `git-clone-runner.ts` waits for `finished()` before removing its private staging folder but does not read the answer.

## Subagent shell

`createSubagentShellBrokerV2` in `subagents/subagent-shell.ts` owns one approved command from prepare to terminal record. `shutdown()` ends every prepare and dispatch through one stop signal and returns only when they settled, and every caller shares that one result, so the child runner's bounded drain reports a helper that did not stop.

The order per call stays: prepared, authorized, dispatch started, then a terminal record. After dispatch started, an unconfirmed outcome is recorded as `unknown` and never retried. Before it, the call is cancelled and its workspace admission released.

Descendant cleanup is proved in `native/subagent-shell-runner/main.c`, which reports `cleanup_unconfirmed` itself. The native protocol is unchanged.
