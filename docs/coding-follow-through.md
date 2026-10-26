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

A chat can run 10 jobs at once and Aiden 20 in all. Jobs stop when Aiden quits, when the chat is deleted, and when the workspace's folder access changes or the workspace is removed. Stopping asks the whole process group to end and forces it after four seconds. If Aiden crashes, the next launch stops any job it left running (matching both the process id and its start time) and deletes the old logs.

The composer shows a **N in background** chip while jobs run. Its list shows each job's state and output, and **Stop** ends one.

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

A chat has one check at a time; `/until` with a new command replaces it. The composer shows an **Until npm test passes** chip, and **Stop checking** clears it. Changing the workspace's folder access or deleting the chat clears it too. A check that was running when Aiden quit is not rerun on launch; it waits for the next answer.

## Network

Background jobs and checks run on this computer and contact nothing themselves beyond what the command does. Following a pull request reads the GitHub API (`api.github.com`, or the GitHub Enterprise host of that pull request) for that pull request only, until the follow ends. Nothing is polled for chats that follow no pull request.
