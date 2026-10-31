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
- `timeout` is in seconds: 30 by default, 120 at most (a larger value is lowered, with a warning).
- `failClosed` (PreToolUse only) denies the tool when the hook fails, instead of continuing without it.
- `envAllow` names up to 32 extra environment variables the hook may see. It can't name a variable Aiden already sets (see [Environment](#environment)).
- `statusMessage` is accepted.

### Examples

These go in `.aiden/hooks.json`. Scripts in `.aiden/hooks/` are a good home, because agents can't write there.

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
| PreToolUse | Before a tool runs, after Computer Use and Form Fill access checks and before the approval decision. | Tool name | Deny, ask you first, or allow; change the tool's input. |
| PostToolUse | After a tool returns. | Tool name | Flag the result and add context to it. |
| UserPromptSubmit | When you send a message, before any model call. | Ignored | Refuse the message; add context for this turn. |
| SessionStart | On a chat's first turn in this run of Aiden. | `startup` (new chat), `resume` (first turn after a restart), `compact` (first turn after compaction) | Add context for this turn. |
| SessionEnd | When a chat whose hooks ran in this run of Aiden is deleted. Not awaited. | Ignored | Nothing; observe only. |
| Stop | When a reply finishes normally. Never after Stop, an error, a cut-off or a spending block. | Ignored | Keep the agent working, up to 8 times per message you send. |
| SubagentStop | When a subagent finishes. <!-- TODO(hooks-wave3): confirm Bots/CLI --> | Ignored | Observe only. |
| Notification | When an approval card (`permission_prompt`) or a question (`elicitation_dialog`) waits for you. Not awaited. | `notification_type` | Nothing; observe only. |
| PreCompact | Before a long chat is compacted, in Bot chats and on the CLI server; desktop workspace chats don't fire it yet. <!-- TODO(hooks-wave3): confirm Bots/CLI --> | `manual` or `auto` | Observe only. |
| WorktreeCreate | After Aiden creates a managed worktree. The source workspace's hooks run, in the new worktree. Awaited, but a failure never undoes the worktree. <!-- TODO(hooks-wave3): confirm Bots/CLI --> | Ignored | Messages shown to you. |
| RoutineRun | After a Bot routine run finishes, in the Bot's folder. Skipped or blocked runs fire nothing. <!-- TODO(hooks-wave3): confirm Bots/CLI --> | Ignored | Observe only. |
| RoutineFailed | When a Bot routine run fails, with `error`, `failure_kind` and `will_retry`. | Ignored | Observe only. |

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

Every hook gets JSON on stdin: `hook_event_name`, `session_id` (the chat id) and `cwd`, plus the fields its event has: `tool_name`, `aiden_tool_name`, `tool_input`, `tool_response` (`{content, is_error}`), `prompt`, `source`, `stop_hook_active`, `message`, `notification_type`, `trigger`. SubagentStop adds `agent_id`, `agent_type`, `aiden_label`, `aiden_status` and `last_assistant_message`; WorktreeCreate adds `worktree_path` and `branch`; routine events add `bot_id`, `routine_id`, `routine_name`, `run_id`, `result` and `trigger`.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success. Stdout that starts with `{` is read as JSON. Other stdout becomes context for SessionStart and UserPromptSubmit and is ignored elsewhere. |
| 2 | Block, with stderr as the reason. PreToolUse denies the tool; PostToolUse flags the result; UserPromptSubmit refuses the message; Stop and SubagentStop keep the agent working. For other events, stderr is shown to you only. |
| Anything else | An error. So is a command that can't start, a timeout, or output over 64 KiB. Aiden shows a notice and continues without the hook, unless it is a `failClosed` PreToolUse hook, which blocks the tool. |

### JSON fields

| Field | Events | Effect |
| --- | --- | --- |
| `hookSpecificOutput.permissionDecision`: `allow`, `deny`, `ask` | PreToolUse | Allow, block or ask. `decision: "approve"` and `"block"` also work. |
| `hookSpecificOutput.permissionDecisionReason` or `reason` | PreToolUse | Why. |
| `hookSpecificOutput.updatedInput` | PreToolUse | Replaces the tool's input. Applied only with `allow`, never to `run_command`, and checked against the tool's schema; invalid input blocks the tool. |
| `hookSpecificOutput.additionalContext` | All that add context | Text for the model. |
| `decision: "block"` and `reason` | PostToolUse, UserPromptSubmit, Stop, SubagentStop | As exit 2. |
| `systemMessage` | All | Shown to you, never to the model. |
| `continue: false` and `stopReason` | All | Ends the turn. It wins over a Stop hook that asks to continue. |

When several hooks match, they run four at a time and the strictest answer wins: deny, then ask, then allow. Each reason is credited to its hook's name.

### What the model sees

- Hook text reaches the model as data, never as instructions, labelled with the hook's name: "Context from hook "name"". Context is capped at 10,000 characters per hook and 20,000 per event; reasons at 2,000 and messages at 1,000.
- A deny reads "Blocked by hook name: reason".
- An ask always shows an approval card, even under Full access or a remembered scope. The card adds the hook's reason and offers no "remember" option. An allow skips the card only where a remembered scope could already have skipped it.
- SessionStart and UserPromptSubmit context follows your message for that turn only, introduced as "[Aiden hook] Context from the person's hooks for this turn". It is never saved as your words.
- A Stop continuation reads "[Aiden hook] Stop hook name asked you to keep going before you finish: …". `stop_hook_active` is true on continued turns, so a hook can let the reply end.

## Environment

A hook runs in the workspace folder (your home folder for a chat without one). It sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER` and `SHELL` from your computer, plus:

- `AIDEN_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`: the working directory.
- `AIDEN_HOOK_EVENT`, `AIDEN_SESSION_ID`.
- `AIDEN_HOOK_FILE`: the absolute path of the file a tool touches, when there is one.
- The names listed in `envAllow`. Tokens such as `GH_TOKEN` reach a hook only this way, and the list is part of what you approve.

Nothing a hook runs triggers hooks, and a replayed event never runs a hook twice. Aiden keeps the last 20 runs of each hook in memory.

## Trust

- Aiden approves each hook by a digest of its event, matcher, command, timeout, `failClosed`, `envAllow` and where it runs. Change any of them and the hook shows **Changed — re-approve** and stops running until you approve it again.
- Repo hooks wait for approval. Approved ones are re-read from `.aiden/hooks.json` each time they fire, so an edit takes effect only after re-approval. **Approve** sends the digest you saw, so a file that changed meanwhile is refused.
- Removing a repo hook removes its approval. The file stays as it is.
- After 3 failures in a row a hook shows **Disabled after failures**. Turning it back on, or approving it again, resets the count.
- **Pause all hooks** in Settings → Hooks stops every hook. `AIDEN_HOOKS=0` in Aiden's environment turns hooks off entirely, and Settings says so.
- Statuses: Active, Waiting for approval, Changed — re-approve, Off, Disabled after failures, Not supported in Aiden.

Each hook's detail sheet shows its last ten runs. **Test** runs it once against a sample payload, asks first if the hook isn't approved, and doesn't count toward its run log or failures.

## The agent's `hooks` tool

Desktop chats that run hooks can load a `hooks` tool ([tool loading](tool-loading.md)), with a built-in `aiden-hooks` skill that explains it. Subagents, unattended turns and chats that don't run hooks never get it, and the skill is withheld wherever the tool is.

- `list`: hooks and pending proposals.
- `propose`: create, change or delete a workspace or chat hook (a chat without a folder can have chat hooks only). Never a global hook, and never a hook in `.aiden/hooks.json`. Timeouts are capped at 30 seconds. Command or matcher text with control or bidirectional characters is refused.
- `disable`: switch off a workspace or chat hook. Only you can turn it back on.
- `test`: never runs the command. It asks the agent to have you press **Test** in Settings and shows the last run.
- `logs`: the last 10 runs, newest first.

A proposal shows on the host as a card with the command, or a before-and-after of the changed fields. Only the person at the computer running the chat can approve it: phones and paired Macs see a summary they can't approve, Full access doesn't approve it, and no remembered scope or hook answers it. Proposals expire after an hour, at most 50 wait at once, and an approved hook starts with the next matching event.

## Files agents can't write

File tools in chats, Bots, subagents and agent harnesses refuse writes to `.aiden/hooks.json`, `.aiden/hooks/`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `.claude/plugins/`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/` and Aiden's `<userData>/hooks/` store, at any depth, through symlinks and regardless of case. They can still read them, and `.claude/skills`, `.claude/agents`, `.claude/commands` and `CLAUDE.md` stay writable. `run_command` isn't blocked; a hook whose file changes stops running until you approve it again.

## Which chats run hooks

| Surface | Hooks |
| --- | --- |
| Desktop chats, with or without a workspace | Global, workspace (when there's a folder) and chat hooks for PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop and Notification. |
| Bots and their routines | Global hooks and that Bot's own, in the Bot's folder. A hook's ask on an unattended run blocks the call. <!-- TODO(hooks-wave3): confirm Bots/CLI --> |
| `aiden serve` | Workspace and Bot chats run hooks from `<agentDir>/hooks/`; `aiden hooks list`, `approve`, `enable`, `disable`, `pause`, `resume` and `test` manage them. See the [CLI guide](../packages/cli/README.md). <!-- TODO(hooks-wave3): confirm Bots/CLI --> |
| Not run | Telegram, Design Studio, the Assistant, agent harness providers (such as Antigravity), side questions, title generation and other background model calls. |

Phones and paired Macs don't configure hooks; hooks run on the host that runs the chat. A phone routine step for hooks is a planned follow-up.

## Differences from Claude Code

- Only `command` hooks run. `http`, `prompt`, `agent` and `async` hooks, unknown fields and unknown events are listed as **Not supported in Aiden** with the reason, and never run.
- Events Claude Code doesn't have: WorktreeCreate, RoutineRun, RoutineFailed. Claude Code events Aiden doesn't fire are listed as not supported.
- Hooks get a minimal environment, and every hook needs approval. `CLAUDE_PLUGIN_ROOT` isn't set.
- `updatedInput` never applies to shell commands.
- Aiden doesn't import hooks from Claude Code or Codex settings, and Claude Code plugin hooks don't run. Copy the hooks you want into `.aiden/hooks.json` or Settings.
