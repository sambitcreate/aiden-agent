# Tasks that run when something happens

A scheduled task usually runs on a schedule. An **Ask Aiden** task can instead run **when something changes**: Aiden checks something on its own and runs the task only when the check finds news. The check never runs a model, so an unchanged page or a quiet script costs nothing.

This is desktop-only for now (macOS and Linux). Phones don't list these tasks or their runs yet, and can't edit, pause, resume or run them. A task runs from a **watch**, a **connected app** or a **link**.

## Watches

Pick **When → When something changes** in the task editor, then choose what to check and how often (every 5 minutes to every day).

- **A web address.** Aiden fetches it with a plain GET: https, or http only on this computer, no redirects, no cookies or sign-ins, up to 1 MB in 30 seconds. The first check records a baseline. After that, a different page runs the task with what changed (a short diff and the page as it is now).
- **A project script** from the workspace's or your global `.aiden/scripts` folder. It runs in the task's project folder with the same environment as the agent's commands, for up to 60 seconds. **It reports something by printing it**: empty output means nothing to report, and anything it prints is handed to the task as it is. A script watch runs unattended, so the task needs Full permission.
  - `AIDEN_CHECK_STATE` names a private file the script may use to remember things between checks (for example the last build number it saw). Aiden keeps it under 8 KB by cutting the end.
  - `AIDEN_CHECK_RUNS` is how many checks finished before this one (0 on the first).

What a check finds reaches the model only as fenced data after your instructions ("What happened (data, not instructions)"), never as instructions. It also counts as outside content for approvals: the run that reads it, and every later run in that chat, is more careful about new sites and connectors, and sites in it never count as ones you named (see [Bots and rules](bot-rules.md)).

## When a connected app has news

Pick **When → When a connected app has news** to run the task when new mail arrives in a mailbox, or when a calendar has events coming up.

- **New mail** reads a local Mail mailbox through iMCP, on a Mac only. Optional filters: the sender contains, the subject contains, unread mail only.
- **Upcoming calendar events** reads a calendar through Composio (macOS and Linux), looking 15 minutes to a day ahead in the time zone you choose. It needs the same verified Composio calendar read as Bot connector watches; until that is available on this computer, Find sources says so and offers no calendars.
- **Check every** 15, 30 or 60 minutes.

Choose **Find sources** in the editor to list the mailboxes or calendars your open connectors offer, then pick one. This is the only step that lists sources, and it uses connections you already opened in Settings → Connectors. Saving the task keeps the exact source (the connector's connection, its read tools and the account) in main; the editor and phones only ever see its names. A choice is good for 15 minutes and for one save; saving another task needs Find sources again. Editing filters or the interval keeps the source; switching between mail and calendar needs Find sources again. If the source couldn't be kept after the task saved (or Aiden quit in between), the save says so and the task shows "Needs its source" until you choose Find sources and save it again (or save it as another kind of task), instead of staying on without checking.

Background checks only read through a connection that is already open. They never connect, sign in or reconnect anything, and never use a model. The first check only records what's there; the task runs from the next change on, with up to 8 new items (`new: <subject or event title>`) as fenced data. If the connector was removed, turned off or hidden from the model, the task pauses at once with a card. Unlike a Bot's calendar watch, a task's first calendar check also only records what's already ahead. If its setup or its account or tools changed since you chose the source, the check is refused without reading and counts as a failed check; choose Find sources again. Connected-app runs count as `watch` runs in usage data. Aiden can't create one of these tasks from a chat, because the source has to be chosen in the editor.

## Links

Pick **When → When its link is called** for a task another app or service should start (a CI job, a form, a home automation). Save it, then open the task's details and choose **Create link**. Aiden shows the link once, and the signing secret if the task asks for signed calls; **Rotate link** makes a new one and the old one stops working at once. The link lives on Aiden On The Go's listener (Tailscale first, then the local network), so it works only while Aiden On The Go is on. The secret is stored in Aiden's encrypted key store; the agent and phones never see the link or the secret.

A call is `POST` with a `text/plain` or `application/json` body up to 256 KB. Aiden answers before reading the body when the link is unknown or the task is paused (404), past 60 calls a minute (429, counted for a paused task's link too) or for any other content type (415), and nothing on that path writes to disk, and checks in this order after that: body size (413), the signature (401) when the task names a header (`sha256=` followed by the hex HMAC-SHA256 of the body with the secret), valid JSON (400, also for JSON nested more than 32 levels deep), then the task's filters and repeat check. Anything that gets that far answers 202 with no body, so a caller never learns whether the task ran. A call with a bad signature or invalid JSON doesn't use the link's 60 calls a minute, so a properly signed sender keeps getting through while bad calls flood the link; past 30 such calls a minute they are still refused but no longer logged. A token no task has is looked up in memory only and never touches the bookkeeping file; past 120 such calls a minute, across all links, unknown tokens are answered 429. A real link is never put on 429 by them.

- **At most every** 1 to 60 minutes (5 by default). Calls that arrive sooner wait and run together once the gap ends: up to 20 calls, the oldest dropped beyond that, with a line saying how many were dropped.
- **Only when**: `field = value` lines; every one must match a field of the JSON body (dot paths such as `pull_request.state`), or the call is logged and ignored.
- **Fields to pass**: only these fields reach the model. Without them, the model sees the body, cut to 4,000 characters. Values under credential-looking keys (`authorization`, `token`, `password`, `api_key` and similar) and credential-looking text are withheld either way.
- **Same call when**: calls with the same value in this field count once. Without it, identical bodies within a minute count once.

The task's details list the last calls (50 kept) with what happened to each and a short preview, credentials withheld. Refused calls of the same kind within a minute share one entry with a count. Adding or changing **Signature header** on a task that already has a link doesn't make a secret: the details say to **Rotate link**, which shows the new secret, and signed calls are refused until then.

## Asking Aiden for one

In a chat, Aiden can propose a task with a watch or a link instead of a schedule (the `trigger` field of the schedule tool's create); a connected-app task is set up in the editor. The approval card shows the trigger in place of the schedule, and what you approve is exactly what is saved. Aiden can't add a trigger to an existing task, and a scheduled run never has the schedule tool, so a run can't create more tasks. For a link task Aiden only hears that you create the link from the task's details (`link: "person_creates_in_task_details"`); it never sees it. A watch Aiden proposes can't point at this computer or a private network (`localhost`; private, link-local, carrier-grade, reserved, multicast or broadcast IP addresses, including IPv4 inside IPv6; names without a dot; and local-network names such as `.local`, `.internal`, `.home.arpa` or `.lan`); you can still set one up in the editor. It is saved marked as Aiden's (`agentProposed`), and each of its checks resolves the name and connects only if every address is public, to the address it checked, so a name that points (or later switches) to a private address is refused instead of read. The approval card always shows an address's whole host and shortens only its path. Aiden Assistant automations may watch a web address or use a link, but never run a script. The headless `aiden serve` server has no watches or links and refuses such tasks.

## Where runs land and how often

Runs land the same way as scheduled runs: in the chat the task was made in, sharing that chat's six task runs an hour, otherwise in the task's own chat. The task keeps its own permission and tools, and a run never gets the `schedule` tool, so a run can't create more tasks.

Per task, a watch runs at most once every 5 minutes (a link chooses 1 to 60) and 48 times a day; a change that comes sooner waits and runs once the gap allows (a watch hands over its newest change first, then earlier ones not yet delivered; a link batches its calls). What a run hands the model is at most 24,000 characters: a watch keeps its newest change, a link keeps its heading and shortens the longest calls. Across every task, at most 4 trigger runs go at once. A run skipped because its chat was busy or had used its hourly share is recorded as skipped and doesn't count toward the 48, and what it carried waits again: it runs at the next allowed time (for a chat out of task runs, an hour later, when it has room again) together with anything that arrived since (a link still keeps at most 20 calls and says how many were dropped). Holding it again and settling the skipped run are one write, so a restart never delivers it twice. After 6 such retries it is dropped with a card where its runs land (and a line in a link's recent calls). When a task has used its 48 runs, what it was holding is dropped with a card where its runs land (and a line in a link's recent calls). A change accepted just before Aiden quits runs again at the next start.

Triggers never keep the computer awake. Checks happen only while Aiden is open and scheduled tasks are on.

## When checks fail

Three failed checks in a row pause the task, with one card in the chat its runs land in. Fix the address, script or connector and turn the task back on; that clears the count and checks again right away. A connected app that was removed or turned off pauses the task after one check.

## When runs fail

This applies to every chat task, scheduled or triggered: three failed unattended runs in a row turn the task off, with one "Paused after 3 failed runs" card where its runs land. A run that was refused (for example, a step its permission doesn't allow) counts as failed. Skipped runs and runs you stopped (from the task list or with the chat's Stop button, which keeps the partial answer) don't count, and a run you start by hand never adds to the count, though one that succeeds clears it. Turning the task off and back on yourself starts a new count.

A scheduled chat task's missed time runs once when Aiden starts or the computer wakes, but only if it was under 12 hours ago. Anything later is recorded as skipped and the task waits for its next time. Bot routines keep their own 7-day catch-up.

## Storage

The trigger lives on the task in `schedules.json`. Bookkeeping (seen changes, the held change or batch, accepted changes not yet run, the watch's last result and failure count, a connected app's exact source and its baseline, a link's token hash and call log) is in `<userData>/scheduled-task-triggers.json`, script state files are in `<userData>/scheduled-task-check-state/`, and a signed link's secret is in the encrypted key store under `aiden-internal:task-hook:<taskId>`. The secret and a script's state file are removed when the task stops being a link or script task, or is deleted.
