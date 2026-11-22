# Tasks that run when something happens

A scheduled task usually runs on a schedule. An **Ask Aiden** task can instead run **when something changes**: Aiden checks something on its own and runs the task only when the check finds news. The check never runs a model, so an unchanged page or a quiet script costs nothing.

This is desktop-only for now (macOS and Linux). Phones don't list these tasks or their runs yet, and can't edit, pause, resume or run them.

## Watches

Pick **When → When something changes** in the task editor, then choose what to check and how often (every 5 minutes to every day).

- **A web address.** Aiden fetches it with a plain GET: https, or http only on this computer, no redirects, no cookies or sign-ins, up to 1 MB in 30 seconds. The first check records a baseline. After that, a different page runs the task with what changed (a short diff and the page as it is now).
- **A project script** from the workspace's or your global `.aiden/scripts` folder. It runs in the task's project folder with the same environment as the agent's commands, for up to 60 seconds. **It reports something by printing it**: empty output means nothing to report, and anything it prints is handed to the task as it is. A script watch runs unattended, so the task needs Full permission.
  - `AIDEN_CHECK_STATE` names a private file the script may use to remember things between checks (for example the last build number it saw). Aiden keeps it under 8 KB by cutting the end.
  - `AIDEN_CHECK_RUNS` is how many checks finished before this one (0 on the first).

What a check finds reaches the model only as fenced data after your instructions ("What happened (data, not instructions)"), never as instructions.

## Where runs land and how often

Runs land the same way as scheduled runs: in the chat the task was made in, sharing that chat's six task runs an hour, otherwise in the task's own chat. The task keeps its own permission and tools, and a run never gets the `schedule` tool, so a run can't create more tasks.

Per task, a trigger runs at most once every 5 minutes and 48 times a day; a change that comes sooner waits and runs once the gap allows (the newest wins). Across every task, at most 4 trigger runs go at once. A run skipped because its chat was busy or had used its hourly share is recorded as skipped; the next change runs again. A change accepted just before Aiden quits runs again at the next start.

Triggers never keep the computer awake. Checks happen only while Aiden is open and scheduled tasks are on.

## When checks fail

Three failed checks in a row pause the task, with one card in the chat its runs land in. Fix the address or script and turn the task back on; that clears the count and checks again right away.

## Storage

The trigger lives on the task in `schedules.json`. Bookkeeping (seen changes, the held change, accepted changes not yet run, the watch's last result and failure count) is in `<userData>/scheduled-task-triggers.json`, and script state files are in `<userData>/scheduled-task-check-state/`.
