# Coding follow-through

Aiden can keep working after an answer ends. Four features keep a coding chat moving without the person checking back:

- **Background jobs**: the agent starts a long command (a dev server, a watcher, a long test run), keeps working, and hears when the command ends.
- **Following a pull request**: Aiden watches a pull request and tells the chat about failed checks, merge conflicts and reviewers' comments until the pull request is merged or closed.
- **Keep going until a check passes**: the person names a check with `/until npm test`. It sets a [keep-going goal](keep-going-goals.md) that Aiden checks by running the command after each answer. While it fails, the agent gets the end of its output and keeps fixing, up to five checks.
- **Chats that check back**: the agent promises to look again later ("I'll check the deploy in 20 minutes"), and at that minute Aiden posts its note into the chat. See [Checking back later](#checking-back-later).

The first three run on the macOS and Linux desktop, in workspace chats whose folder access is **Full access** or **Ask first**; check-backs also work in **Read only** workspaces. They are not available in Bot chats, the Assistant, Telegram chats, a chat hosted on a paired Mac, or the CLI. Phones show the chat's follow-up messages but cannot start them.

## Follow-up messages

News reaches the chat as a follow-up message. The transcript shows it as a small card with a heading and one line, such as "A check failed · #42 in acme/app · unit". **Details** opens exactly what Aiden told the agent, including the end of any output.

- If the agent is still answering, the message joins that answer as the next thing it reads.
- A scheduled task's run posting into the chat never takes a follow-up message: its tools are the task's, not the chat's. The message waits up to 30 minutes for that run to end, then joins or wakes the chat's own answer as below; if the chat is still busy, the message is only saved.
- Waiting messages live in memory. If Aiden quits before one is delivered it is lost, except a started chat's ending, which is posted (without waking the chat) at the next start.
- If the chat is idle and the news needs work (a failure, a conflict, a comment), Aiden starts a follow-up answer on its own. A chat can start at most six such answers an hour; after that the message is only saved, and the agent reads it with the person's next message.
- News that needs nothing (checks passed, a merge) is only saved.
- If the chat has a working [keep-going goal](keep-going-goals.md), news that needs work starts a goal round instead. A goal round is attended: its approvals wait 30 minutes, and it doesn't count toward the six an hour.

A follow-up answer runs with nobody watching. It cannot ask questions or wait for approvals: in an **Ask first** workspace, anything that would need approval is refused for that answer. It also does not use subagents, Computer Use or Connectors. The agent still sees which connectors the chat uses, with a note that they are not connected for that answer, so it can say what it would check with them.

Command output, CI logs and comment text are untrusted. Aiden fences them as data in the message, and the agent is told to weigh comments as requests rather than instructions.

Phones and other clients that do not draw the card show the one-line heading instead of the full message.

## Background jobs

The agent uses its `background_job` tool to start, read, list and stop jobs. Each job:

- runs with the workspace folder as its working directory, in its own process group, with `AIDEN_BACKGROUND_JOB` set to its id;
- writes its output to a log in Aiden's data folder; the agent reads the newest 20,000 characters, and a job whose output passes 50 MB is stopped;
- is reported to the chat with its last 3,000 characters when it ends on its own. A job the agent or the person stops is not reported.

In an **Ask first** workspace, starting a job asks for approval like `run_command`. Reading, listing and stopping never ask.

### Stopping a job once the chat goes quiet

When the agent starts a job only to check its own work (a dev server to look at a page, a watcher for one change), it can start it with `stop_when_chat_settles`. Aiden then stops that job 20 minutes after the chat goes quiet, so a preview server does not keep running for days after the task is done. The agent decides per job, and leaves the flag off for anything the person asked to keep running; jobs without it never stop this way. `run_command` processes that Aiden takes over as a job never carry it.

- **Quiet** means no answer is running in the chat. The 20 minutes start when the last answer ends. A new answer (a message from the person, from a phone, or a follow-up Aiden starts itself) cancels the countdown, and its end starts a fresh 20 minutes.
- **Reading a job's output** in the job list starts the 20 minutes over. A job printing output does not.
- If something is still waiting to be answered when the 20 minutes run out (a follow-up queued in the main process, or a check result waiting to be posted), Aiden waits another 20 minutes instead. A message waiting in the desktop composer's own queue is not visible to the main process, so it does not hold a job; it starts an answer when it is sent, and that cancels the countdown.
- Aiden keeps a bounded list of recent answers and drops the oldest one, even a running one, when the list is full. A dropped answer never reports its end, so Aiden instead checks every minute whether the chat is still in use, and the full 20 minutes start only once it is not. Until then, pull request comments from your account still count as the agent's own, so a followed pull request does not bring them back into the chat as new work.
- The job's list then says **Stopped after the chat went quiet**, on the Mac and on phones. Like any job the agent or the person stops, it is not reported to the chat. If Aiden cannot confirm that the job stopped, it tries again after another 20 minutes.
- The countdown lives only in memory. Aiden stops every job when it quits, and the next launch reaps any job a crash left behind, so there is nothing to resume after a restart. Deleting a chat clears its countdown along with its jobs.

A chat can run 10 jobs at once and Aiden 20 in all. Jobs stop when Aiden quits, when the chat is deleted, and when the workspace's folder access changes or the workspace is removed. A permission change waits for commands that are handing a server over to the job list. Removing a managed worktree also waits for its jobs and checks before Aiden snapshots or removes the checkout. If Aiden cannot confirm that a tracked job stopped, the workspace change fails and can be retried. If a workspace change fails before altering access or the checkout, its pull request follows resume and its interrupted check waits for the next answer without consuming an attempt. Stopping asks the whole process group to end and forces it after four seconds. When a job's shell exits, anything it started in the background is ended the same way, so nothing outlives its job. If Aiden crashes, the next launch stops any job it left running (matching both the process id and its start time). If that job's shell had already exited, it stops only the processes left in its group that carry the job's own marker in their environment, so a reused process id is never signalled. It looks for marked processes again before each forced stop, so something started while the job was ending is stopped too, and a job whose marked processes still run stays on the record for the launch after. Then it deletes the old logs. On macOS, the operating system hides the environment of some Apple system processes. If the original shell is already gone and a descendant's marker cannot be read, Aiden leaves that descendant alone because ownership cannot be verified.

A command the agent runs with `run_command` sometimes leaves something running on purpose, such as `npm run dev &` or `nohup ./server &`. When the command returns and processes it started are still alive, Aiden keeps them as a background job of the chat instead of leaving them untracked. The agent is told the job's id, and the job can be read, listed and stopped like any other. Aiden adopts only processes that carry that command's own marker in their environment, so nothing the command did not start is ever taken over. Such a job has no exit code: its list says **Ended** when its processes are gone, and it is not reported to the chat. Aiden waits half a second first, so a process that was already exiting is not listed. The job limits above apply: when the chat or Aiden is already at its limit, nothing is taken over. The same happens when Aiden cannot confirm the marker (for example an Apple system process on macOS whose environment is hidden, or a `ps` lookup that fails). Either way the processes keep running untracked, and the agent is told so with the exact `kill` command that stops their process group (unless all that is left are ended processes nobody has reaped yet). Stop on such a job signals only the marked processes; if Aiden cannot check whether they have ended (for example `ps` times out), the job stays listed as running and Stop can be pressed again. If those processes keep the command's output open, the command returns after a second and a half and the rest of their output goes to the job's log, with nothing lost in between. In a chat without background jobs (the CLI, Bots, or a workspace that does not qualify), `run_command` keeps its earlier behaviour: processes that still hold the output a second after the shell exits are stopped with the command's group and the agent is told, and processes that do not hold it keep running and the agent gets the `kill` command for them.

While a job runs, Aiden checks which TCP ports its processes listen on: every 3 seconds for its first minute, then every 30 seconds. One look covers every running job: on Linux it reads `/proc`; on macOS it asks `lsof` once about exactly those processes. A port Aiden itself listens on is never shown, and neither are the Node inspector (9229) and Vite's hot-reload socket (24678). Up to five ports are shown.

The composer shows a **N in background** chip while jobs run. Its list shows each job's state and output, a button for each address a running job serves (for example **localhost:5173**, which opens in the browser), and **Stop** ends one.

On Aiden On The Go for iPhone and Android, a workspace chat shows the same **N in background** chip when the phone is paired with a Mac that runs background jobs. Its list shows each job's state and its addresses as text ("localhost:5173 on your Mac", since they are addresses on the Mac), and **Stop** ends one. A job stopped after its chat went quiet reads **Stopped after the chat went quiet** (revision 63); an older phone shows it as **Stopped**. See "Background jobs on phones, revision 49" and "Stopped after the chat went quiet, revision 63" in the [Aiden Remote API](aiden-remote-api-v1.md).

## Following a pull request

Type `/follow` in a chat whose pull request chip shows a pull request, or ask the agent: its `follow_pull_request` tool follows the chat's pull request or one it names by URL.

Aiden reads the pull request through the same GitHub sign-in the pull request chip uses (the `gh` command-line tool's credentials). It reads every two minutes while checks run and every five minutes otherwise, and waits longer after a failed read or when GitHub's rate limit says to wait.

Most reads are cheap. Before the full read, Aiden asks GitHub with `If-None-Match` whether the pull request, its head commit's check runs or its commit status changed. When all three answer `304 Not Modified`, Aiden does no further work: no full read, no logs, no message. A 304 does not count against GitHub's rate limit. A settled pull request that stays quiet is then looked at less often: after 5, then 10, 20 and at most 30 minutes, and back to every five minutes as soon as anything changes. Checks that are still running stay at two minutes. Aiden still does a full read at least every 30 minutes, in case a change does not show in those three answers, so a longer wait is cut short to land on that read, and skips the probe while a check is failing. A push or comment that lands just before a timed read still gets its own look once its few seconds have passed.

Some moments ask for a sooner look, a few seconds later rather than at the next scheduled read:

- the agent's `run_command` runs `git push` or a `gh pr`, `gh issue` or `gh api` command (this is how it comments on or reviews a pull request);
- a push from the Git panel or a paired phone to a repository with a followed pull request;
- opening the **Following #N** list;
- Aiden's window coming back into focus, the computer waking or unlocking, or the network coming back. These never read sooner than the five-minute cadence.

Several of these close together give one read. A pull request is never read more than once every 30 seconds this way, never during a rate-limit wait, and never once its follow has stopped. The chat hears about:

- **Failed checks**, once per commit, with the end of the log (last 3,000 characters) for up to three failed GitHub Actions jobs. A failure is held while other checks still run, until it is 15 minutes old.
- **A merge conflict**, once per commit. The agent is told to merge the base branch in, never to rebase or force-push.
- **New comments, reviews and review comments** from people who can write to the repository: the repository owner, people GitHub reports as having admin, maintain or write permission, and the signed-in account. Comments from anyone else never reach the agent; the message only says how many were left out. Comments from before the follow began are ignored, and so are comments the agent wrote itself during its answer.
- **Checks passing** and the pull request **merging** or **closing**. These need nothing, so they never start an answer.

A follow ends when the pull request is merged or closed, after 10 updates, when checks keep failing for an hour after the agent heard (with no new commit), after two weeks with nothing new, when GitHub can no longer find it, when folder access changes or the workspace is removed, or when the person or the agent stops it. A chat can follow three pull requests at once and Aiden 20 in all. Follows survive a restart. Stopping a follow cancels its active GitHub read. Quitting cancels that read and leaves the follow for the next launch.

The composer shows a **Following #N** chip. Its list shows where each pull request stands, opens it on GitHub, and **Stop** ends the follow.

## Keep going until a check passes

Type `/until` followed by the check, for example `/until npm test`. The check is one line and runs in the workspace folder with a 10-minute limit. `/until` sets the chat's [keep-going goal](keep-going-goals.md) with the objective "Keep going until `npm test` passes", so the goal bar above the composer shows it, with Pause and Clear.

- If the chat is idle, the check runs right away; otherwise it runs when the current answer ends. Setting the goal doesn't start an answer by itself.
- When it fails, a new round starts with a "Keep going · check 2 of 5" card, and the agent gets the exit code and the last 3,000 characters of its output, fenced as data, and keeps working. The check runs again when that round ends.
- When it passes, the goal is **Done** with "`npm test` passed".
- After five checks that still fail, the goal pauses at its limit without starting another answer. **Keep going** on the goal bar grants five more.
- If a check is stopped before it finishes (you pressed Stop, a managed worktree was removed, Aiden closed), the goal pauses and says so.

A chat has one goal; `/until` with a new command replaces the goal, and a replaced check that was running is stopped first. `/goal clear` or **Clear** on the bar removes it. Changing the workspace's folder access or deleting the chat ends it too. Pause or clear a working goal, and stop an active follow, before moving an empty chat to another workspace. Each check verifies that its chat still owns the workspace and that a managed checkout still has its original identity. When the command ends, Aiden stops any remaining processes in its group, including ones that redirected their output.

Aiden records the check's process group before running its command. If Aiden cannot save the recovery record, the command stays unstarted. Once Aiden verifies the group has exited, a failure to remove the saved entry is logged, and startup can discard the stale entry. If a stop signal fails and a descendant stays alive, Aiden retains the recovery record and blocks changes to that workspace until it can confirm the group has ended. After a crash, startup reaps recorded groups before opening desktop and remote requests, and the goal comes back paused like any goal after a restart; press **Keep going** to run the check again.

Checks saved by an earlier version of Aiden that were still waiting or running become paused `/until` goals on the first launch after the update, keeping the checks they had used; checks that had passed or given up are dropped.

## Checking back later

In a workspace chat, the agent can use its `check_back` tool to promise to look at something again later, such as a deploy, a long build or a reply it is waiting for. It sets a time with `in_minutes` (1 to 1,440) or a local 24-hour time `"HH:MM"` within the next 24 hours, and a note of up to 500 characters saying what to check.

- A chat can have up to 3 pending check-backs, and Aiden keeps up to 20 across all chats.
- The composer shows a **Checking back at 3:10 PM** chip. Its list shows each note with **Cancel**. The activity row of the call reads "Will check back at 3:10 PM".
- At that minute Aiden posts a **Checking back** card with the note. It goes through the same delivery as other follow-up messages: it joins a running answer, or wakes an idle chat within the six-an-hour limit, or is saved for the next message. The woken answer runs with nobody watching, so it has no approvals, connectors, subagents or Computer Use, and the tool tells the agent so before it promises anything.
- Only a turn the person started can set a check-back: one typed in the chat's window, sent from a paired phone or Mac, or the turn that answers a message the person queued while a run was ending. An answer Aiden started itself (a follow-up, a check-back firing, a turn owed to a follow-up notice, a goal round, a lead chat's message to a chat it started, or a scheduled task's run, including a trigger's and **Run now**) can list and cancel check-backs but not set one, so they can't chain.
- If the computer was asleep or Aiden was closed at that minute, a check-back up to 2 hours late still wakes the chat and says it is late. An older one leaves a **Missed check-back (due 3:10 PM)** card without waking the chat. A check-back that was being delivered when Aiden quit leaves a **Check-back interrupted (due 3:10 PM)** card at the next launch, also without waking the chat, so nothing fires twice.
- When the computer is plugged in, a check-back due within the hour keeps it from idle-sleeping, so it is awake when the check-back fires (Settings → Scheduled tasks → While you're away → **Keep this computer awake while Aiden works**, on by default). On battery nothing holds in advance, and a check-back more than an hour overdue stops holding. This hold stays even after 4 hours with nobody at the computer, when other work lets go.
- **Stop** leaves pending check-backs in place. Deleting the chat drops them. If the chat's folder access is off when one fires, the card is only saved.
- **Settings → Scheduled tasks → While you're away → Let chats check back later** (on by default) turns the feature off. Turning it off cancels every pending check-back, and the tool answers `off` until it is back on. Turning it back on restores nothing.

Check-backs are saved with the other follow-through state in Aiden's data folder (`follow-through/state.json`). Bots set their own wake-ups instead (see [Bot routines](bot-routines.md#wake-ups-a-bot-sets-for-itself)); the Assistant, Telegram chats, subagents and scheduled runs do not get the tool. Phones show the card as one line.

## Network

Background jobs and checks run on this computer and contact nothing themselves beyond what the command does. Check-backs contact nothing. Following a pull request reads the GitHub API (`api.github.com`, or the GitHub Enterprise host of that pull request) for that pull request only, until the follow ends. Each look first sends up to three conditional REST requests (the pull request, its head commit's check runs and its commit status) and only then the full read. Nothing is polled for chats that follow no pull request, and Aiden does not receive GitHub webhooks.
