# Coding follow-through

Aiden can keep working after an answer ends. Three features keep a coding chat moving without the person checking back:

- **Background jobs**: the agent starts a long command (a dev server, a watcher, a long test run), keeps working, and hears when the command ends.
- **Following a pull request**: Aiden watches a pull request and tells the chat about failed checks, merge conflicts and reviewers' comments until the pull request is merged or closed.
- **Keep going until a check passes**: the person names a check with `/until npm test`, and Aiden runs it after each answer. While it fails, the agent gets the end of its output and keeps fixing, up to five checks.

All three run on the macOS and Linux desktop, in workspace chats whose folder access is **Full access** or **Ask first**. They are not available in Bot chats, the Assistant, Telegram chats, a chat hosted on a paired Mac, or the CLI. Phones show the chat's follow-up messages but cannot start them.

## Follow-up messages

News reaches the chat as a follow-up message. The transcript shows it as a small card with a heading and one line, such as "A check failed · #42 in acme/app · unit". **Details** opens exactly what Aiden told the agent, including the end of any output.

- If the agent is still answering, the message joins that answer as the next thing it reads.
- If the chat is idle and the news needs work (a failure, a conflict, a comment), Aiden starts a follow-up answer on its own. A chat can start at most six such answers an hour; after that the message is only saved, and the agent reads it with the person's next message.
- News that needs nothing (checks passed, a merge) is only saved.

A follow-up answer runs with nobody watching. It cannot ask questions or wait for approvals: in an **Ask first** workspace, anything that would need approval is refused for that answer. It also does not use subagents, Computer Use or Connectors.

Command output, CI logs and comment text are untrusted. Aiden fences them as data in the message, and the agent is told to weigh comments as requests rather than instructions.

Phones and other clients that do not draw the card show the one-line heading instead of the full message.

## Background jobs

The agent uses its `background_job` tool to start, read, list and stop jobs. Each job:

- runs with the workspace folder as its working directory, in its own process group, with `AIDEN_BACKGROUND_JOB` set to its id;
- writes its output to a log in Aiden's data folder; the agent reads the newest 20,000 characters, and a job whose output passes 50 MB is stopped;
- is reported to the chat with its last 3,000 characters when it ends on its own. A job the agent or the person stops is not reported.

In an **Ask first** workspace, starting a job asks for approval like `run_command`. Reading, listing and stopping never ask.

A chat can run 10 jobs at once and Aiden 20 in all. Jobs stop when Aiden quits, when the chat is deleted, and when the workspace's folder access changes or the workspace is removed. Stopping asks the whole process group to end and forces it after four seconds. When a job's shell exits, anything it started in the background is ended the same way, so nothing outlives its job. If Aiden crashes, the next launch stops any job it left running (matching both the process id and its start time). If that job's shell had already exited, it stops only the processes left in its group that carry the job's own marker in their environment, so a reused process id is never signalled. It looks for marked processes again before each forced stop, so something started while the job was ending is stopped too, and a job whose marked processes still run stays on the record for the launch after. Then it deletes the old logs. On macOS, the operating system hides the environment of some Apple system processes. If the original shell is already gone and a descendant's marker cannot be read, Aiden leaves that descendant alone because ownership cannot be verified.

A command the agent runs with `run_command` sometimes leaves something running on purpose, such as `npm run dev &` or `nohup ./server &`. When the command returns and processes it started are still alive, Aiden keeps them as a background job of the chat instead of leaving them untracked. The agent is told the job's id, and the job can be read, listed and stopped like any other. Aiden adopts only processes that carry that command's own marker in their environment, so nothing the command did not start is ever taken over. Such a job has no exit code: its list says **Ended** when its processes are gone, and it is not reported to the chat. Aiden waits half a second first, so a process that was already exiting is not listed. The job limits above apply: when the chat or Aiden is already at its limit, nothing is taken over. The same happens when Aiden cannot confirm the marker (for example an Apple system process on macOS whose environment is hidden, or a `ps` lookup that fails). Either way the processes keep running untracked, and the agent is told so with the exact `kill` command that stops their process group (unless all that is left are ended processes nobody has reaped yet). Stop on such a job signals only the marked processes; if Aiden cannot check whether they have ended (for example `ps` times out), the job stays listed as running and Stop can be pressed again. If those processes keep the command's output open, the command returns after a second and a half and the rest of their output goes to the job's log, with nothing lost in between.

While a job runs, Aiden checks which TCP ports its processes listen on: every 3 seconds for its first minute, then every 30 seconds. One look covers every running job: on Linux it reads `/proc`; on macOS it asks `lsof` once about exactly those processes. A port Aiden itself listens on is never shown, and neither are the Node inspector (9229) and Vite's hot-reload socket (24678). Up to five ports are shown.

The composer shows a **N in background** chip while jobs run. Its list shows each job's state and output, a button for each address a running job serves (for example **localhost:5173**, which opens in the browser), and **Stop** ends one.

On Aiden On The Go for iPhone and Android, a workspace chat shows the same **N in background** chip when the phone is paired with a Mac that runs background jobs. Its list shows each job's state and its addresses as text ("localhost:5173 on your Mac", since they are addresses on the Mac), and **Stop** ends one. See "Background jobs on phones, revision 48" in the [Aiden Remote API](aiden-remote-api-v1.md).

## Following a pull request

Type `/follow` in a chat whose pull request chip shows a pull request, or ask the agent: its `follow_pull_request` tool follows the chat's pull request or one it names by URL.

Aiden reads the pull request through the same GitHub sign-in the pull request chip uses (the `gh` command-line tool's credentials). It reads every two minutes while checks run and every five minutes otherwise, and waits longer after a failed read. The chat hears about:

- **Failed checks**, once per commit, with the end of the log (last 3,000 characters) for up to three failed GitHub Actions jobs. A failure is held while other checks still run, until it is 15 minutes old.
- **A merge conflict**, once per commit. The agent is told to merge the base branch in, never to rebase or force-push.
- **New comments, reviews and review comments** from people who can write to the repository: the repository owner, people GitHub reports as having admin, maintain or write permission, and the signed-in account. Comments from anyone else never reach the agent; the message only says how many were left out. Comments from before the follow began are ignored, and so are comments the agent wrote itself during its answer.
- **Checks passing** and the pull request **merging** or **closing**. These need nothing, so they never start an answer.

A follow ends when the pull request is merged or closed, after 10 updates, when checks keep failing for an hour after the agent heard (with no new commit), after two weeks with nothing new, when GitHub can no longer find it, or when the person or the agent stops it. A chat can follow three pull requests at once and Aiden 20 in all. Follows survive a restart.

The composer shows a **Following #N** chip. Its list shows where each pull request stands, opens it on GitHub, and **Stop** ends the follow.

## Keep going until a check passes

Type `/until` followed by the check, for example `/until npm test`. The check is one line and runs in the workspace folder with a 10-minute limit.

- If the chat is idle, the check runs right away; otherwise it runs when the current answer ends.
- When it fails, the agent gets the exit code and the last 3,000 characters of its output and keeps working. The check runs again when that answer ends.
- When it passes, Aiden stops running it and tells the chat.
- After five checks that still fail, Aiden stops and tells the chat, without starting another answer.

A chat has one check at a time; `/until` with a new command replaces it. A replaced check that was running is stopped first, and the new one runs once it has. The composer shows an **Until npm test passes** chip, and **Stop checking** clears it. Changing the workspace's folder access or deleting the chat clears it too. A check that was running when Aiden quit is not rerun on launch; it waits for the next answer.

## Network

Background jobs and checks run on this computer and contact nothing themselves beyond what the command does. Following a pull request reads the GitHub API (`api.github.com`, or the GitHub Enterprise host of that pull request) for that pull request only, until the follow ends. Nothing is polled for chats that follow no pull request.
