# Coding follow-through plan

Status: implemented, in review (2026-10-26). Feature guide: [coding follow-through](../coding-follow-through.md).

## Goal

A coding chat should not stall the moment an answer ends. Research into how other coding agents keep work moving pointed to three gaps in Aiden:

1. The agent cannot leave a long command running (a dev server, a watcher, a long test run) and keep working. `run_command` blocks for up to two minutes and then gives up.
2. After the agent opens or pushes to a pull request, nobody tells it that CI failed, that the branch conflicts, or that a reviewer asked for a change. The person has to notice and come back.
3. There is no way to say "keep going until the tests pass" without the person rerunning the tests and pasting the output after each answer.

The owner asked for all three, desktop first, with these rules: background jobs report when they end and run on macOS and Linux; following a pull request builds on Aiden's existing GitHub client, counts only comments from people with write access, and treats logs as data; the check loop stops after five tries.

## What ships

### Follow-up notices (shared by all three)

- A notice is a user-role transcript message whose content is the model-facing text and whose `notice` field (`AgentNoticeV1`: source, tone, title, one-line summary) makes clients draw a compact card. The chat store keeps the field only on user messages and only in its exact shape.
- Delivery (`main/services/follow-through/notice-delivery.ts`) queues into a running turn through the existing run-input admission, otherwise starts an unattended follow-up turn when the news needs work, otherwise only saves the message. Notices for one chat are delivered in order, and a chat may start six unattended turns an hour.
- An unattended turn has a headless owner: approvals and questions settle at once as unavailable, and subagents, Computer Use and Connectors are off for that turn.
- Untrusted text (command output, CI logs, comment bodies) is fenced as data with a fence longer than any backtick run inside it.
- Phones and paired Macs receive the one-line heading as the message text through the Remote projection. No protocol revision: the wire shape is unchanged.

### Background jobs

- `background_job` tool with `start`, `read`, `list` and `stop`. Jobs run with the workspace folder as the working directory in their own process group, log to Aiden's data folder, and keep a 20,000-character tail in memory.
- Ask-mode approval covers `start` only.
- Limits: 10 running per chat, 20 in all, 50 MB of output per job. Stop sends SIGTERM to the group and SIGKILL four seconds later.
- A job that ends on its own posts a notice with its last 3,000 characters. When `start` sees the job end during its 1.5-second wait, the tool result reports it and no notice follows.
- Jobs stop on quit, chat deletion, and folder-access change or workspace removal. When a job's shell exits, the rest of its process group is ended too. A durable record of running jobs lets the next launch stop jobs a crash left behind, matching pid and process start time so a reused pid is never signalled; when the shell had already exited, only group members carrying the job's `AIDEN_BACKGROUND_JOB` marker are stopped.

### Following a pull request

- `/follow` (the chat's pull request) and the `follow_pull_request` tool (`follow`, `stop`, `list`, by URL or the chat's pull request).
- One GraphQL read per poll through `GitHubApi` (pull request fragment, last 30 comments, last 30 reviews with their inline comments, viewer and repository owner). Failed GitHub Actions jobs' logs come from the REST job-logs endpoint as text, cleaned of colour codes and timestamps.
- Trust: the repository owner, the signed-in account, and MEMBER or COLLABORATOR authors whom the collaborator-permission endpoint reports as admin, maintain or write (cached for an hour). Everyone else is counted but never quoted.
- The agent's own comments are recognised as comments by the signed-in account made while that chat was answering, and are not echoed back.
- Decisions (`pull-request-follow.ts`, pure): failures once per head commit, held while other checks run until 15 minutes old; conflicts once per commit; passing checks and merge/close never wake the agent. A follow ends on merge or close, after 10 updates, after an hour of unchanged failures the agent already heard about, after two quiet weeks, when GitHub cannot find the pull request, or when stopped.
- Polling: every 2 minutes while checks run, 5 minutes otherwise, backing off to 30 minutes after failed reads; reads run one at a time. Limits: 3 follows per chat, 20 in all. State is saved in `follow-through/state.json` and survives restarts.

### Keep going until a check passes

- `/until <command>` sets one check per chat. It runs after each answer in that chat ends (and at once when the chat is idle), in the workspace folder, with a 10-minute limit.
- A failure posts the exit code and the last 3,000 characters of output and wakes the agent; a pass, or the fifth failure, ends the loop without waking it.
- A check cut off by quitting returns to waiting and is not counted; nothing reruns on launch. Clearing or replacing a running check aborts it and drops its result; a replacement asked to run now starts once the old run has stopped.

### Desktop UI

- Notice cards in the transcript, with a **Details** disclosure showing exactly what the agent was told.
- Composer chips: **N in background**, **Following #N** and **Until … passes**, each with a popover to read output, open the pull request, or stop. The composer bar stays visible while any of them is active.
- Slash commands `/until` (alias `/done-when`) and `/follow` (alias `/watch`).

## Platform and scope

macOS and Linux desktop (`hostPlatformCapabilities().backgroundJobs`), workspace chats with **Full access** or **Ask first**. Not in Bot chats, the Assistant, Telegram, chats hosted on a paired Mac, or the CLI. Phones show notices as one line and cannot start any of the three.

## Network

Only following a pull request contacts a network service: the GitHub API host of that pull request, for that pull request, until the follow ends. Nothing polls when no pull request is followed.

## Tests

Registered as `npm run test:follow-through` and in the `core-git` and `renderer-other` CI lanes:

- real processes for jobs (exit, group stop, forced stop, settle, output limit, crash reaping with pid reuse);
- the job tool's results and fencing;
- `evaluateFollow` fixtures for every notice and end reason;
- the GitHub reader's trust rules, comment parsing and log tails with a fake API;
- the follows loop (in-flight stop, read failures, restore);
- the check state machine;
- notice delivery ordering and the wake budget;
- the chat store round trip, the Remote projection's one-line text, slash availability, and rendered chips and cards.

## Not done yet

- iOS and Android draw notices as plain user messages with the one-line text; native cards are a follow-up.
- The CLI has none of the three.
- An unattended follow-up answer in an **Ask first** workspace cannot run anything that needs approval; a later change could hold such work until the person returns.
- Hand check on a real Mac: a dev server job, a followed pull request with a failing check and a reviewer comment, and an `/until npm test` loop.
