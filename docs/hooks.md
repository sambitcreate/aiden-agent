# Hooks

A hook is a shell command Aiden runs at a fixed point in a chat: before or after a tool, when you send a message, when a chat starts, when a reply finishes, and a few more. A hook can block a tool, ask you first, flag a result, add context for the model or keep the agent working. It can never let a chat do more than its access already allows. Hooks run on macOS and Linux only (`hooks` in `main/services/host-platform-capabilities.ts`).

The format is Claude Code's, so most Claude Code command hooks work unchanged. Aiden runs only what you approve. See the [plan](plans/aiden-hooks-plan.md) for the design record.

## Where hooks live

| Where | What it holds | Who edits it |
| --- | --- | --- |
| Settings → Hooks | Hooks for **Every chat** (global) or one workspace, plus hooks you approved from the agent. Stored in `<userData>/hooks/hooks.json`, with approvals and the paused state in `<userData>/hooks/hooks-trust.json`. | You, in Settings. A hook you save there is approved when you save it. |
| `<workspace>/.aiden/hooks.json` | A repo's own hooks, in the Claude format below. At most 256 KiB, and `.aiden` must be a real folder, not a symlink. | Whoever commits it. Every hook in it waits for your approval. Aiden never writes this file. |
| Agent proposals | Workspace or chat hooks the agent suggests through its `hooks` tool. An approved one is stored in `<userData>/hooks/hooks.json`, keyed by the workspace, never written into the repo. | The agent proposes; you approve on the host. |

Scopes run in order: global, then the workspace (when the chat has a folder), then the chat. A file holds at most 200 hooks.

## Format

```json
{
  "hooks": {
    "<Event>": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "./script.sh", "timeout": 30, "failClosed": false, "envAllow": ["GH_TOKEN"] }
        ]
      }
    ]
  }
}
```

- Top-level `$schema` is allowed. Other top-level keys are ignored with a warning.
- A group holds only `matcher` and `hooks`.
- `type` must be `"command"`. `command` is at most 4,096 characters.
- `timeout` is a whole number of seconds: 30 by default, 120 at most, or 600 at most for an `async` hook (a larger value is lowered, with a warning).
- `failClosed` (PreToolUse only) denies the tool when the hook fails, instead of continuing without it. A `failClosed` hook is never turned off after failures (see [Trust](#trust)).
- `async: true` runs the hook in the background: Aiden doesn't wait for it, so it can't block, ask or change anything, and its context is dropped. Its `systemMessage`, or its error, is shown to you when it finishes. At most 4 background hooks run at once and 32 wait; a hook that finds the queue full is skipped with a notice. Pausing hooks, `AIDEN_HOOKS=0` and quitting Aiden (or stopping `aiden serve`) stop them; a turn ending doesn't. It can't be combined with `failClosed`.
- `envAllow` names up to 32 extra environment variables the hook may see. It can't name a variable Aiden already sets (see [Environment](#environment)).
- `statusMessage` is accepted.

### Examples

These go in `.aiden/hooks.json`. Scripts in `.aiden/hooks/` are a good home: agents' file tools can't write there, and a workspace hook's approval covers the script files it runs from the workspace, so a script edited by any means (including `run_command`) stops the hook until you approve it again.

Block `rm -rf` before a command runs (exit 2 blocks; stderr is the reason):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "\"$AIDEN_PROJECT_DIR\"/.aiden/hooks/no-rm-rf.sh", "failClosed": true }] }
    ]
  }
}
```

```sh
#!/bin/sh
# .aiden/hooks/no-rm-rf.sh
if jq -r '.tool_input.command // ""' | grep -Eq 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f'; then
  echo "rm -rf is blocked in this repo. Delete specific files instead." >&2
  exit 2
fi
```

Format a file after the agent edits or writes it (`AIDEN_HOOK_FILE` is the absolute path the tool touched):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx --no-install prettier --write \"$AIDEN_HOOK_FILE\"" }] }
    ]
  }
}
```

Give each new or resumed chat some context (plain stdout from SessionStart becomes context):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "git status --short --branch && git log --oneline -5" }] }
    ]
  }
}
```

Ask the agent to run tests before it finishes:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"$AIDEN_PROJECT_DIR\"/.aiden/hooks/tests-first.sh" }] }
    ]
  }
}
```

```sh
#!/bin/sh
# .aiden/hooks/tests-first.sh: ask once per turn, then let the reply end.
jq -e '.stop_hook_active' >/dev/null && exit 0
echo '{"decision":"block","reason":"Run the test suite and report the result before you finish."}'
```

## Events

| Event | When it fires | Matcher | What its output can do |
| --- | --- | --- | --- |
| PreToolUse | Before a tool runs, after Computer Use and Form Fill access checks and before the approval decision. | Tool name | Deny, ask you first, or allow; change the tool's input; add context to the tool's result. |
| PostToolUse | After a tool returns. | Tool name | Flag the result and add context to it. |
| UserPromptSubmit | When you send a message, before any model call, including guidance you steer into a running reply or queue behind it. | Ignored | Refuse the message; add context for this turn (for steered or queued guidance, for that message). |
| SessionStart | On a chat's first turn in this run of Aiden. | `startup` (new chat), `resume` (first turn after a restart), `compact` (first turn after compaction) | Add context for this turn. |
| SessionEnd | When a chat whose hooks ran in this run of Aiden is deleted. Not awaited. | Ignored | Nothing; observe only. |
| Stop | When a reply finishes normally. Never after Stop, an error, a cut-off or a spending block. | Ignored | Keep the agent working, up to 8 times per message you send. |
| SubagentStop | When a subagent run ends (completed, failed, timed out or stopped), once per run, for subagents of desktop chats and of Bots on the desktop and `aiden serve`. Not awaited. | Ignored | Nothing; observe only. |
| Notification | When an approval card (`permission_prompt`) or a question (`elicitation_dialog`) waits for you. Not awaited. | `notification_type` | Nothing; observe only. |
| PreCompact | Before a long chat is compacted: `manual` when you choose Compact, `auto` when Aiden compacts during a turn or to recover. Desktop chats, Bot chats and `aiden serve` chats fire it. | `manual` or `auto` | In a desktop chat, `additionalContext` tells the summary what to keep; the compaction waits at most the hook's timeout and goes ahead if the hook fails. Bots and `aiden serve` only observe. |
| WorktreeSetup | After Aiden creates a managed worktree, on the desktop and on `aiden serve`. Global and the source workspace's hooks run, in the new worktree. Awaited, but a failure never undoes the worktree; mark a slow setup step (such as `npm install`) `async: true` and the agent starts while it runs. | Ignored | `systemMessage` and notices go to Aiden's log (stderr on `aiden serve`). |
| RoutineRun | After a Bot routine run succeeds (including a silent run), in the Bot's folder, on the desktop and on `aiden serve`. Skipped or blocked runs fire nothing. | Ignored | Nothing; observe only. |
| RoutineFailed | When a Bot routine run fails, with `error`, `failure_kind` and `will_retry`. Each failed attempt fires, including one that will be retried. | Ignored | Nothing; observe only. |

Some events can't run in every scope, and a hook saved where its event never fires is refused (or, in `.aiden/hooks.json`, listed as **Not supported in Aiden**): RoutineRun and RoutineFailed are global or Bot only; WorktreeSetup is global or workspace only; UserPromptSubmit, SessionEnd and Notification are global, workspace or chat, never Bot.

A matcher that is empty or `*` matches everything. One made only of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names (`Edit|Write`). Anything else is a regular expression matched against the whole name, at most 512 characters.

## Tool names

Tool matchers match Aiden's name or its Claude Code name. The payload's `tool_name` uses the Claude spelling and `aiden_tool_name` the Aiden one. When `tool_input` has `path`, Aiden also adds `file_path`.

| Aiden | Claude Code |
| --- | --- |
| `run_command` | `Bash` |
| `write_file` | `Write` |
| `edit_file` | `Edit`, `MultiEdit` |
| `read_file` | `Read` |
| `glob` | `Glob` |
| `grep` | `Grep` |
| `list_dir` | `LS` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `subagent` | `Task`, `Agent` |
| `todo` | `TodoWrite` |
| `ask_user_question` | `AskUserQuestion` |
| `skill` | `Skill` |
| `computer_use` | `computer` |
| `<server>__<tool>` (MCP) | `mcp__<server>__<tool>` |

## Input and output

Every hook gets JSON on stdin: `hook_event_name`, `session_id` and `cwd`, plus the fields its event has: `tool_name`, `aiden_tool_name`, `tool_input`, `tool_use_id`, `tool_response` (`{content, is_error}`), `prompt`, `source`, `stop_hook_active`, `message`, `notification_type`, `trigger`. `session_id` is the chat id; for a Bot, its subagents and its routines it is the Bot's id, and for WorktreeSetup the new worktree's workspace id. PreToolUse and PostToolUse for the same call share one `tool_use_id`. PreCompact adds `aiden_reason`; SessionEnd sends `reason: "other"` with `aiden_reason: "chat_deleted"`; SubagentStop adds `agent_id`, `agent_type`, `aiden_label`, `aiden_status` and `last_assistant_message`; WorktreeSetup adds `worktree_path`, `branch` and `source_root` (the source checkout's top level); routine events add `bot_id`, `routine_id`, `routine_name`, `run_id`, `result` and `trigger`.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success. Stdout that starts with `{` is read as JSON. Other stdout becomes context for SessionStart and UserPromptSubmit and is ignored elsewhere. |
| 2 | Block, with stderr as the reason. PreToolUse denies the tool; PostToolUse flags the result; UserPromptSubmit refuses the message; Stop keeps the agent working. For other events, stderr is shown to you only. |
| Anything else | An error. So is a command that can't start, a timeout, or output over 64 KiB. Aiden shows a notice and continues without the hook, unless it is a `failClosed` PreToolUse hook, which blocks the tool. |

If Aiden can't load your hooks at all, it blocks every tool call with "Aiden could not load your hooks, so it blocked this tool call", and other events continue with a notice. That covers a hook store in `<userData>/hooks/` that can't be read or isn't valid JSON, and a workspace's `.aiden/hooks.json` that can't be read or parsed once you've approved one of its hooks (deleting the file just removes its hooks). Aiden leaves a damaged store where it is and won't save Settings changes over it; it tries loading again on every event, so fixing or removing the file takes effect without a restart.

### JSON fields

| Field | Events | Effect |
| --- | --- | --- |
| `hookSpecificOutput.permissionDecision`: `allow`, `deny`, `ask` | PreToolUse | Allow, block or ask. `decision: "approve"` and `"block"` also work. |
| `hookSpecificOutput.permissionDecisionReason` or `reason` | PreToolUse | Why. |
| `hookSpecificOutput.updatedInput` | PreToolUse | Replaces the tool's input. Applied only with `allow`, never to `run_command`, and checked against the tool's schema; invalid input blocks the tool. Bots and `aiden serve` chats never apply it, and there an `allow` changes nothing: Aiden's own rules already decided the call. |
| `hookSpecificOutput.additionalContext` | All that add context | Text for the model. PreToolUse context joins the tool's result, ahead of any PostToolUse context. |
| `decision: "block"` and `reason` | PostToolUse, UserPromptSubmit, Stop | As exit 2. |
| `systemMessage` | All | Shown to you, never to the model. |
| `continue: false` and `stopReason` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop | Ends the turn. On SessionStart it ends the turn before the model runs, and SessionStart runs again with your next message. On UserPromptSubmit it refuses the message. On PreToolUse and PostToolUse the tool's result is kept, the turn ends once that tool batch finishes, and you see "Stopped by hook name: reason". It wins over a Stop hook that asks to continue. Events that only observe (SessionEnd, SubagentStop, PreCompact, Notification, WorktreeSetup, RoutineRun, RoutineFailed) ignore it, and Bots don't end the run this way yet. |

When several hooks match, they run four at a time and the strictest answer wins: deny, then ask, then allow. Each reason is credited to its hook's name.

### What the model sees

- Hook text reaches the model as data, never as instructions, labelled with the hook's name: "Context from hook "name"". Context is capped at 10,000 characters per hook and 20,000 per event; reasons at 2,000 and messages at 1,000.
- A deny reads "Blocked by hook name: reason".
- An ask always shows an approval card, even under Full access or a remembered scope. The card adds the hook's reason and offers no "remember" option. An allow skips the card only where a remembered scope could already have skipped it.
- SessionStart and UserPromptSubmit context follows your message for that turn only, introduced as "[Aiden hook] Context from the person's hooks for this turn". It is never saved as your words.
- A Stop continuation reads "[Aiden hook] Stop hook name asked you to keep going before you finish: …". `stop_hook_active` is true on continued turns, so a hook can let the reply end.
- Guidance you steer into a running reply, or queue as a follow-up, is checked by UserPromptSubmit before it's saved, from the desktop or a paired phone. Its context rides that message only, introduced as "for this message". A refused steer or follow-up is saved marked as blocked and never queued; you see the hook's reason. Aiden's own follow-up notices aren't checked.
- A message a UserPromptSubmit hook refused stays in the chat so you can see what you typed, marked as blocked. It never reaches the model: not on that turn, later turns, compaction, forks, side questions or title generation. Sending it again after the hook lets it through clears the mark.
- `systemMessage` text and Aiden's notices about a hook (a failure, a timeout) never reach the model. A desktop chat shows the messages that arrive together as one notice while the reply runs (the first message, up to three more, then a count of the rest), and `aiden serve` sends them as `chat:status` events with `phase: "hook_messages"`. A chat subagent's SubagentStop messages show in its chat while that reply runs. Anything with no reply to show it in (a deleted chat's SessionEnd, a SubagentStop after the reply ended, a Bot's hooks including its routines, subagents and PreCompact) goes to Aiden's log, or stderr on `aiden serve`. Phones and paired Macs don't show them yet.

## Environment

A hook runs in the workspace folder (your home folder for a chat without one). It sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER` and `SHELL` from your computer, plus:

- `AIDEN_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`: the working directory.
- `AIDEN_HOOK_EVENT`, `AIDEN_SESSION_ID`.
- `AIDEN_HOOK_FILE`: the absolute path of the file a tool touches, when there is one.
- The names listed in `envAllow`. Tokens such as `GH_TOKEN` reach a hook only this way, and the list is part of what you approve.

Nothing a hook runs triggers hooks, and a replayed event never runs a hook twice while your hooks stay as they are: approving, switching on or off, pausing or deleting a hook starts afresh. The same handler (event, matcher, command, timeout, `failClosed`, `async` and `envAllow`) saved in more than one scope runs once per event. A run ends when the hook's shell exits; anything it started in the background that still holds its output is stopped a moment later. To leave something running, redirect its output (`nohup server >server.log 2>&1 &`), or make the hook `async`. `run_command` works the same way and tells the agent when it stopped a process. Aiden keeps the last 20 runs of each hook in memory.

## Trust

- Aiden approves each hook by a digest of its event, matcher, command, timeout, `failClosed`, `async`, `envAllow` and where it runs. Change any of them and the hook shows **Changed — re-approve** and stops running until you approve it again.
- For workspace hooks the digest also covers the script files inside the workspace that the command names, such as `./check.sh` or `"$AIDEN_PROJECT_DIR"/.aiden/hooks/check.sh`: their contents, a symlink's target, and a named script that doesn't exist yet. Editing, adding or removing one shows **Changed — re-approve**. In another checkout of the workspace, such as a new worktree, the scripts are read from that checkout, so the hook runs there only when they are identical. Paths built at run time (other variables, globs, `~`) aren't followed. The hook's detail sheet in Settings → Hooks, and the agent's proposal card, list the script files its approval covers and warn when the command also runs something Aiden can't follow to a file, such as a script started through `cd`, `source`, `npx` or `npm run`, or a path built at run time like `./scripts/*.sh`. Aiden checks the scripts again just before each run and skips the hook if one changed. A command it can't fully check (more than 16 script files, more than 128 words, or a script over 256 MiB) is listed as **Not supported in Aiden** and never runs; move the commands into one script.
- Global, chat and Bot hooks have no fixed folder, so their digest covers the command text only. A script one of them runs isn't covered: point it at a file outside any repo the agent can edit.
- Repo hooks wait for approval. Approved ones are re-read from `.aiden/hooks.json` each time they fire, so an edit takes effect only after re-approval. **Approve** sends the digest you saw, so a file that changed meanwhile is refused.
- Removing a repo hook removes its approval. The file stays as it is.
- After 3 failures in a row a hook shows **Disabled after failures**. Turning it back on, or approving it again, resets the count. A `failClosed` hook is the exception: turning it off would let the tools it guards through, so it stays on and keeps blocking, and its notice counts the failures until you fix it or turn it off.
- Off and failure counts belong to a hook's scope and digest, not its place in the file, so inserting a hook above another in `.aiden/hooks.json` doesn't move them onto a different command.
- **Pause all hooks** in Settings → Hooks stops every hook. `AIDEN_HOOKS=0` in Aiden's environment turns hooks off entirely, and Settings says so.
- Statuses: Active, Waiting for approval, Changed — re-approve, Off, Disabled after failures, Not supported in Aiden.

Each hook's detail sheet shows its last ten runs. **Test** runs it once against a sample payload, asks first if the hook isn't approved, and doesn't count toward its run log or failures. It sends the digest the sheet shows, and is refused if the hook changed since.

## The agent's `hooks` tool

Desktop chats that run hooks can load a `hooks` tool ([tool loading](tool-loading.md)), with a built-in `aiden-hooks` skill that explains it. Subagents, unattended turns and chats that don't run hooks never get it, and the skill is withheld wherever the tool is.

- `list`: hooks and pending proposals.
- `propose`: create, change or delete a workspace or chat hook (a chat without a folder can have chat hooks only). Never a global hook, and never a hook in `.aiden/hooks.json`. Timeouts are capped at 30 seconds, `async` ones included. A hook whose event never fires in the chosen scope is refused before any card shows. Command or matcher text with control or bidirectional characters is refused. The approval card shows the whole command, the script files the approval covers, and whether the hook runs in the background.
- `disable`: switch off a workspace or chat hook the agent added through `propose`. Only you can turn it back on, and only you can switch off a hook you saved in Settings or approved from a repo.
- `test`: never runs the command. It asks the agent to have you press **Test** in Settings and shows the last run.
- `logs`: the last 10 runs, newest first.

A proposal shows on the host as a card with the command, or a before-and-after of the changed fields. Only the person at the computer running the chat can approve it: phones and paired Macs see a summary they can't approve, Full access doesn't approve it, and no remembered scope or hook answers it. Proposals expire after an hour, at most 50 wait at once, and an approved hook starts with the next matching event.

## Files agents can't write

File tools in chats, Bots, subagents and agent harnesses refuse writes to `.aiden/hooks.json`, `.aiden/hooks/`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `.claude/plugins/`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/` and Aiden's `<userData>/hooks/` store, at any depth, through symlinks and regardless of case. They can still read them, and `.claude/skills`, `.claude/agents`, `.claude/commands` and `CLAUDE.md` stay writable. `run_command` isn't blocked; a workspace hook whose file or script changes stops running until you approve it again.

## Which chats run hooks

| Surface | Hooks |
| --- | --- |
| Desktop chats, with or without a workspace | Global, workspace (when there's a folder) and chat hooks for PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification and PreCompact. The chat's subagents fire SubagentStop with the same hooks. |
| Bots and their routines | Global hooks and that Bot's own, in the Bot's folder: PreToolUse (after the Bot's own rules allow the call), PostToolUse, Stop, SessionStart and PreCompact. SessionStart fires on a Bot's first request after Aiden starts, and again after each compaction. Bot subagents fire SubagentStop, and routines fire RoutineRun and RoutineFailed. A hook's ask joins the Bot's approval card on an attended turn and blocks the call on an unattended one. |
| `aiden serve` | Hooks from the server's own `<agentDir>/hooks/` store and each registered workspace's `.aiden/hooks.json`. Workspace chats, including Telegram and scheduled turns, run PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, PreCompact and SessionEnd; on a Telegram or scheduled turn an ask blocks the tool. Bots work as on the desktop. `aiden hooks list`, `approve`, `enable`, `disable`, `pause`, `resume` and `test` manage them. `approve <id> <digest>` and `test <id> <digest>` take the digest `aiden hooks list` printed, and `approve` and `enable` refuse unless stdin and stdout are both a terminal, so an agent's command can't turn a hook on. See the [CLI guide](../packages/cli/README.md). |
| Not run on the desktop | Telegram, Design Studio, the Assistant, agent harness providers (such as Antigravity), side questions, title generation and other background model calls. |

Phones and paired Macs don't configure hooks; hooks run on the host that runs the chat. A phone routine step for hooks is a planned follow-up.

## Differences from Claude Code

- Only `command` hooks run, including `async` ones. `http`, `prompt` and `agent` hooks, unknown fields and unknown events are listed as **Not supported in Aiden** with the reason, and never run.
- Events Claude Code doesn't have: WorktreeSetup, RoutineRun, RoutineFailed. Claude Code events Aiden doesn't fire are listed as not supported.
- Claude Code's `WorktreeCreate` replaces how a worktree is created, which Aiden doesn't support, so it is listed as **Not supported in Aiden**. Aiden's WorktreeSetup runs after Aiden creates one.
- Hooks get a minimal environment, and every hook needs approval. `CLAUDE_PLUGIN_ROOT` isn't set.
- `updatedInput` never applies to shell commands.
- Aiden doesn't import hooks from Claude Code or Codex settings, and Claude Code plugin hooks don't run. Copy the hooks you want into `.aiden/hooks.json` or Settings.
