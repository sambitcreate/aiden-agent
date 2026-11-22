# Tasks that run when something happens

A scheduled task usually runs on a schedule. An **Ask Aiden** task can instead run **when something changes**: Aiden checks something on its own and runs the task only when the check finds news. The check never runs a model, so an unchanged page or a quiet script costs nothing.

This is desktop-only for now (macOS and Linux). Phones don't list these tasks or their runs yet, and can't edit, pause, resume or run them. A task runs from a **watch** or from a **link**.

## Watches

Pick **When → When something changes** in the task editor, then choose what to check and how often (every 5 minutes to every day).

- **A web address.** Aiden fetches it with a plain GET: https, or http only on this computer, no redirects, no cookies or sign-ins, up to 1 MB in 30 seconds. The first check records a baseline. After that, a different page runs the task with what changed (a short diff and the page as it is now).
- **A project script** from the workspace's or your global `.aiden/scripts` folder. It runs in the task's project folder with the same environment as the agent's commands, for up to 60 seconds. **It reports something by printing it**: empty output means nothing to report, and anything it prints is handed to the task as it is. A script watch runs unattended, so the task needs Full permission.
  - `AIDEN_CHECK_STATE` names a private file the script may use to remember things between checks (for example the last build number it saw). Aiden keeps it under 8 KB by cutting the end.
  - `AIDEN_CHECK_RUNS` is how many checks finished before this one (0 on the first).

What a check finds reaches the model only as fenced data after your instructions ("What happened (data, not instructions)"), never as instructions.

## Links

Pick **When → When its link is called** for a task another app or service should start (a CI job, a form, a home automation). Save it, then open the task's details and choose **Create link**. Aiden shows the link once, and the signing secret if the task asks for signed calls; **Rotate link** makes a new one and the old one stops working at once. The link lives on Aiden On The Go's listener (Tailscale first, then the local network), so it works only while Aiden On The Go is on. The secret is stored in Aiden's encrypted key store; the agent and phones never see the link or the secret.

A call is `POST` with a `text/plain` or `application/json` body up to 256 KB. Aiden answers before reading the body when the link is unknown or the task is paused (404), past 60 calls a minute (429) or for any other content type (415), and checks in this order after that: body size (413), the signature (401) when the task names a header (`sha256=` followed by the hex HMAC-SHA256 of the body with the secret), valid JSON (400), then the task's filters and repeat check. Anything that gets that far answers 202 with no body, so a caller never learns whether the task ran.

- **At most every** 1 to 60 minutes (5 by default). Calls that arrive sooner wait and run together once the gap ends: up to 20 calls, the oldest dropped beyond that, with a line saying how many were dropped.
- **Only when**: `field = value` lines; every one must match a field of the JSON body (dot paths such as `pull_request.state`), or the call is logged and ignored.
- **Fields to pass**: only these fields reach the model. Without them, the model sees the body, cut to 4,000 characters. Values under credential-looking keys (`authorization`, `token`, `password`, `api_key` and similar) and credential-looking text are withheld either way.
- **Same call when**: calls with the same value in this field count once. Without it, identical bodies within a minute count once.

The task's details list the last calls (50 kept) with what happened to each and a short preview, credentials withheld.

## Asking Aiden for one

In a chat, Aiden can propose a task with a trigger instead of a schedule (the `trigger` field of the schedule tool's create). The approval card shows the trigger in place of the schedule, and what you approve is exactly what is saved. Aiden can't add a trigger to an existing task, and a scheduled run never has the schedule tool, so a run can't create more tasks. For a link task Aiden only hears that the link is shown to you; you make it from the task's details. Aiden Assistant automations may watch a web address or use a link, but never run a script. The headless `aiden serve` server has no watches or links and refuses such tasks.

## Where runs land and how often

Runs land the same way as scheduled runs: in the chat the task was made in, sharing that chat's six task runs an hour, otherwise in the task's own chat. The task keeps its own permission and tools, and a run never gets the `schedule` tool, so a run can't create more tasks.

Per task, a watch runs at most once every 5 minutes (a link chooses 1 to 60) and 48 times a day; a change that comes sooner waits and runs once the gap allows (for a watch the newest change wins; a link batches its calls). Across every task, at most 4 trigger runs go at once. A run skipped because its chat was busy or had used its hourly share is recorded as skipped; the next change runs again. A change accepted just before Aiden quits runs again at the next start.

Triggers never keep the computer awake. Checks happen only while Aiden is open and scheduled tasks are on.

## When checks fail

Three failed checks in a row pause the task, with one card in the chat its runs land in. Fix the address or script and turn the task back on; that clears the count and checks again right away.

## When runs fail

This applies to every chat task, scheduled or triggered: three failed runs in a row turn the task off, with one "Paused after 3 failed runs" card where its runs land. Skipped and stopped runs don't count, and a run you start by hand never pauses a task. Turning it back on starts a new count.

A scheduled chat task's missed time runs once when Aiden starts or the computer wakes, but only if it was under 12 hours ago. Anything later is recorded as skipped and the task waits for its next time. Bot routines keep their own 7-day catch-up.

## Storage

The trigger lives on the task in `schedules.json`. Bookkeeping (seen changes, the held change or batch, accepted changes not yet run, the watch's last result and failure count, a link's token hash and call log) is in `<userData>/scheduled-task-triggers.json`, script state files are in `<userData>/scheduled-task-check-state/`, and a signed link's secret is in the encrypted key store under `aiden-internal:task-hook:<taskId>`.
