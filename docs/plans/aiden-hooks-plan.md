# Aiden hooks: user and agent-configurable lifecycle hooks

Status: **In review** (2026-10-31) on `feature/aiden-hooks`. Phases 0–3 are implemented; Phase 4 (import) was dropped and Phase 5 (a phone hook step kind) is a follow-up. The user guide is [docs/hooks.md](../hooks.md). The research and decisions below are the original proposal; owner decisions are listed at the end.

Research baseline: `main` at `8c5903a09` (Pi 1.4.0, Remote revision 47). Ten parallel research passes covered Aiden's runtime, the CLI, Bots, opencode (`~/projects/opencode`), t3code (`~/projects/opp/t3code`), the Claude Code and Codex hook specifications, and the Pi extension ecosystem.

## 1. Does Aiden have hooks today?

No, not for users or the agent. Aiden has internal extension points, but a person can't attach a script to "before a tool runs" or "when the turn ends", and the agent can't propose one.

| Surface | What exists | Who can use it |
| --- | --- | --- |
| Desktop workspace chats | `PiAgentRuntimeExtension` (`main/services/pi-agent-runtime-harness.ts:97-143`), composed for `finishTurn`, `transformContext`, `beforeToolCall` and `afterToolCall`. The global registry (`:3153-3205`, "trusted-extension reload") is snapshotted into non-Bot chats at `llm-client.ts:3103` but has no production entries. | Aiden source only |
| Host approval point | `beforeToolCall` in `llm-client.ts:3780-4250`: Computer Use, Form Fill, workspace approval (`APPROVAL_TOOL_NAMES`), disclosure and memory gates, remembered scopes, then `approvals.request`. | Aiden source only |
| Bots | pi-durable `hook()` in `bot-runtime/bot-extension.ts:472-600`: `beforeRequest`, `afterResponse`, `onYield`, `beforeCompact`, `beforeTool`. Bots are excluded from the extension registry. | Aiden source only |
| CLI (`packages/cli`) | pi-coding-agent `pi.on()` (41 events) but `noExtensions: true` in `daemon-chats.ts:195`, `scheduled-inference.ts` and `subagent-worker.ts`; the daemon uses `before_agent_start`, `tool_call` and `session_shutdown` internally. | Aiden source only |
| Claude Code plugins | `claude-plugin-skill-roots.ts` (PR #571) imports **skills only**. `docs/skills.md` states it does not load plugin hooks, commands, MCP servers or code. | n/a |

So the plumbing to intercept tools and turns already exists in three places (desktop harness, Bot durable hooks, CLI `pi.on`). What's missing is a user-owned configuration, a safe process runner, a trust model and an agent-facing way to manage it.

## 2. What the reference projects do

### opencode

- In-process JS/TS plugins loaded from `.opencode/plugin/`, global config and npm (auto-installed with `ignoreScripts`). Each plugin returns a `Hooks` object of `(input, output) => Promise<void>` handlers that mutate `output` in place.
- Hook points: `tool.execute.before` / `after`, `chat.params`, `chat.headers`, `chat.system` and `chat.messages` transforms, `shell.env`, `session.compacting`, a catch-all `event` bus, and custom `tool` registration.
- Weaknesses to avoid:
  - no timeouts;
  - a thrown error both vetoes and can crash the session;
  - no trust prompt, and repo config can set permissions to `allow`;
  - `permission.ask` is declared but never called;
  - the shell-command `experimental.hook` (`file_edited`, `session_completed`) was abandoned because it was fire-and-forget with no way to feed results back.
- v2 direction: a `plugins` removal syntax, managed policy that is deny-first, and only `tool.before` allowed to fail the call.

### t3code

- No general hook bus. Instead:
  - `t3.json` project scripts with `runOnWorktreeCreate` and `runOnSettle`, async or blocking, run in a visible PTY with a random completion sentinel;
  - project scripts are imported but never auto-run, and threads opened from links are fenced;
  - git-hook observation via trace2;
  - webhook routines that wrap payloads as untrusted data.
- Patterns worth copying:
  - one choke point (`canUseTool`);
  - a pure policy function `(policy, {kind, locations}) -> allow | ask | deny`;
  - pending requests held in a Deferred map;
  - event-sourced reactors with deterministic effect IDs (safe on replay);
  - agents may answer questions but never approvals;
  - `disableAllHooks: true` for probes and title generation, and isolated provider homes.
- Anti-pattern: dormant `hook.*` event types that nothing emits.

### Claude Code and Codex (the de facto format)

- Claude Code: about 33 events.
  - Configuration is `event → [{ matcher, hooks: [handler] }]`.
  - Matcher: an exact list when the value is only `[A-Za-z0-9_\- ,|]`, otherwise a regex. An `if` field filters by permission rule.
  - Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Protocol:
  - JSON on stdin.
  - Exit 0 is success; exit 2 blocks, with stderr as the reason; other non-zero exits fail open.
  - Structured output: `hookSpecificOutput.permissionDecision` (`allow | deny | ask | defer`), `updatedInput`, `additionalContext` (capped at 10k characters).
  - Stop `decision: "block"` means "keep going", guarded by `stop_hook_active` and an 8-continuation cap.
  - Default timeout 600 s.
- Codex: 12 events, about 90% the same schema, with **per-hook hash trust** and a hard failure on unsupported fields.
- Cursor and Gemini CLI are close variants. Gemini and hermes-agent also use per-hook digest trust.

### Pi ecosystem

- No published Pi extension runs Claude Code shell hooks today.
- The best reference implementation is deepseek-harness `packages/experimental/hook-protocol/src/{runner,codec,matcher,merge}.ts`, with thin `hooks-claude-code` / `hooks-codex` bridges and 15 snapshot scenarios.
- context-mode has a `PI_TOOL_MAP` (Pi to Claude names, `path` to `file_path`).
- hermes-agent:
  - a per-(event, command) consent allowlist;
  - a `hooks list | test | revoke | doctor` CLI;
  - `fail_closed` for pre-tool hooks.
- oh-my-pi discovers `.claude/hooks` JavaScript only.

### Hooks already on this Mac

Three kinds of hooks are installed here, and Aiden runs none of them:
- the superpowers plugin's SessionStart (injects context);
- the Codex plugin's SessionStart/SessionEnd and Stop (blocks to keep a turn going);
- the user's own SessionStart trackers (herdr, rex).

## 3. What Aiden gains

1. **Deterministic guardrails the model can't talk its way past.** Examples: block `rm -rf` outside the workspace, block pushes to `main`, keep secrets and generated files read-only. Today the only guard is the model plus the approval card.
2. **Automatic follow-through.** Formatting or linting after every edit, and running tests before a turn may end, without spending tokens on reminders. This generalizes `/until`.
3. **Context on arrival.** Git status, open PRs, today's calendar or a project brief, injected at session start or on each prompt.
4. **Audit and notifications.** A JSONL log of every tool call; a sound, Stream Deck, menu-bar or phone signal when a turn needs input or finishes.
5. **Bot and routine policy.**
   - Hooks can:
     - stop a Bot sending through an MCP connector outside work hours;
     - write routine results to a vault;
     - recover from routine failures.
   - These are all owner-defined, without new built-in settings.
6. **Ecosystem reuse.** A Claude-compatible format means existing hook scripts and plugin hooks (superpowers, Codex) work in Aiden with an opt-in import.
7. **An agent that improves its own harness.**
   - The agent can propose a hook ("I'll add a hook that runs `npm run lint` after edits to `renderer/`"). The owner approves it once, and from then on it runs deterministically.
   - This matches how Aiden already treats agent-proposed skills, routines and wake-ups.

Use-case catalogue for the first release, in priority order:
1. format or lint after edit;
2. block dangerous commands;
3. tests before Stop;
4. protected paths;
5. SessionStart git context;
6. turn-finished notifications;
7. audit log;
8. Bot MCP send policy;
9. routine results to a vault;
10. changelog after commit;
11. pre-compact memory proposals;
12. routine-failure recovery;
13. prompt secret scanning;
14. Stream Deck or menu-bar mirroring;
15. budget guard.

## 4. Design principles

- **Hooks can only tighten.**
  - A hook may block, ask or add context. It never grants permission beyond what a remembered approval scope could already grant.
  - When several hooks answer, the strictest wins: `deny > ask > allow`.
  - This is the same lattice as Bot tool rules.
  - A hook's `allow` only skips Aiden's approval card where the chat's tier already permits remembering that scope.
- **One decision point.**
  - PreToolUse hooks run inside the host `beforeToolCall`, after the Computer Use and Form Fill access checks and before `workspaceApproval`.
  - An `ask` result reuses the existing approval card and `ToolApprovalCoordinator`, so it reaches phones with no protocol change.
- **No silent code execution.**
  - Every hook is digest-trusted (Codex/Gemini/hermes model), not folder-trusted. The digest covers the event, matcher, command, cwd, environment allowlist and timeout.
  - Hooks are re-checked on every fire; any drift disables the hook until re-approved.
  - Repo-supplied hooks are listed but never run until approved on the desktop.
- **No new network.**
  - v1 has `command` handlers only. No `http`, `prompt` or `agent` handlers, and no npm install.
  - This follows the AGENTS.md manual-only network posture.
- **Bounded and observable.**
  - Every run:
    - has a timeout (default 30 s, maximum 120 s);
    - caps stdout and stderr;
    - has its output wrapped with `fenceAsData` before the model sees it.
  - After N consecutive failures the hook disables itself and raises an issue.
- **Fail closed only where it is safe.**
  - A PreToolUse hook that crashes or times out blocks the tool when the hook is marked `failClosed`; otherwise it fails open with a visible notice.
  - Every other event fails open.

## 5. Configuration format

Aiden reads a Claude-compatible schema natively:

```jsonc
// <userData>/hooks.json (global), <workspace>/.aiden/hooks.json (workspace), Bot record (per Bot)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command|Bash",
        "hooks": [
          { "type": "command", "command": "~/.aiden/hooks/guard-shell.sh", "timeout": 10, "failClosed": true }
        ]
      }
    ],
    "PostToolUse": [
      { "matcher": "edit_file|write_file", "hooks": [{ "type": "command", "command": "npx prettier --write \"$AIDEN_HOOK_FILE\"" }] }
    ]
  }
}
```

- **Tool-name aliases.** Matchers accept Aiden names and Claude names:
  - `Bash` → `run_command`
  - `Write` → `write_file`
  - `Edit` → `edit_file`
  - `Read` → `read_file`
  - `Glob` → `glob`
  - `Grep` → `grep`
  - `LS` → `list_dir`
  - `WebFetch`/`WebSearch` → `web_fetch`/`web_search`
  - `Task`/`Agent` → `subagent`
  - `TodoWrite` → `todo`
  - `AskUserQuestion` → `ask_user_question`
  - `Skill` → `skill`
  - `mcp__srv__tool` → the connector's `<prefix>__<tool>`
  - `computer` → `computer_use`

  Payloads sent on stdin include both `tool_name` (Claude spelling) and `aiden_tool_name`. Input keys get Claude aliases (`path` also appears as `file_path`).
- **Environment.**
  - Each run gets a minimal allowlist: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, plus `AIDEN_PROJECT_DIR`, `AIDEN_HOOK_EVENT`, `AIDEN_SESSION_ID` and the aliases `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT`.
  - The model of `subagent-shell-runner-io.ts:208-224` is the one to follow. Do **not** copy `schedule-script.ts`, which passes the full `process.env`; `GH_TOKEN` and other secrets stay out.
  - A hook may name extra variables in `envAllow`, and those are part of its digest.
- **Unsupported fields** (`http` handlers, `async`, unknown events) make that hook show as "Not supported in Aiden" rather than being silently dropped.

## 6. Events

| Event | Phase | Can | Emit point |
| --- | --- | --- | --- |
| `PreToolUse` | 1 | deny, ask, allow (within scope), `updatedInput` (non-shell tools only), context | host `beforeToolCall`, `llm-client.ts` before `workspaceApproval` |
| `PostToolUse` | 1 | add context, or flag the result to the model | harness `afterToolCall` |
| `UserPromptSubmit` | 1 | block with reason, add context | prompt intake, `llm-client.ts` ~:2304 |
| `SessionStart` | 1 | add context | `prepareNextTurnWithContext` on a chat's first turn and after resume or compaction |
| `Stop` | 1 observe, 3 continue | observe in Phase 1; `decision: block` continues the turn in Phase 3 (needs a continuation path; `finishTurn` can only end a turn today) | `finishTurn` |
| `Notification` | 1 | observe | approval requested, question asked, turn waiting |
| `PreCompact` | 3 | add context and memory proposals | harness compaction, Bot `beforeCompact` |
| `SubagentStop` | 3 | observe | `background-lifecycle-v2.ts` `transition()` |
| `RoutineRun` / `RoutineFailed` | 3 | observe | `scheduled-bot-routines.ts` `recordRun` |
| `WorktreeSetup` (Claude's `WorktreeCreate` is listed as unsupported) | 3 | run setup (fills the planned, never-executed worktree setup-script slot) | `first-message-worktree.ts`, `managed-worktree-provisioner.ts` |
| `SessionEnd` | 3 | observe | chat close and Bot pause |

Bash `updatedInput` is never honoured, matching Claude Code: a hook may not rewrite a shell command into something the approval card didn't show.

## 7. Architecture

New module `main/services/hooks/`:

- `hook-config.ts`: parse and validate the schema, alias names, compute digests. Pure and fixture-tested.
- `hook-trust-store.ts`: approved digests per scope, in the profile, never in a repo.
- `hook-matcher.ts`: Claude matcher semantics (exact list or regex; anchored; the `if` filter).
- `hook-runner.ts`:
  - built on `runBoundedShellCommand` (`bounded-shell-command.ts`);
  - JSON in on stdin and out on stdout;
  - exit-code mapping;
  - timeout, output caps and process-group reaping, following the background-jobs reap markers.
- `hook-merge.ts`: combines results with the strictest-wins rule and concatenates context with per-hook attribution.
- `hook-dispatcher.ts`:
  - `dispatch(event, payload, scope) → HookOutcome`;
  - per-call idempotency key (event, chat, tool-call id), so durable Bot replays don't re-run side effects;
  - a re-entrancy guard, so a hook's own tool calls never trigger hooks.
- `hook-health.ts`:
  - failure counters and auto-disable;
  - raises an Aiden issue;
  - records each run in a bounded per-scope run log.

Wiring:

- **Desktop chats.** Call the dispatcher from the host `beforeToolCall` (PreToolUse), from a new `PiAgentRuntimeExtension` registered in the existing registry (PostToolUse, Stop and SessionStart via `transformContext`), and from prompt intake.
  - As built (`main/services/workspace-chat-hooks.ts`, wired in `llm-client.ts`): ordinary desktop chats whose usage source is `chat`. Scopes are global, then workspace when the chat has a folder, then chat; hooks run in the chat's folder, and a folderless chat's hooks run in the home folder. `session_id` is the chat id.
  - PreToolUse runs after the Computer Use and Form Fill access checks and before the approval decision. Deny blocks with `Blocked by hook <names>: <reason>`. Ask forces a card (even under Full access or a remembered scope), adds the hook's reason, and offers no remember option. Allow skips the card only where a remembered scope could apply.
  - The `aiden.hooks` extension appends PostToolUse feedback and context to the tool result, and places SessionStart and UserPromptSubmit context after the current prompt for that turn only; it is never saved as the person's words. A blocked prompt fails the turn before any model call, with the hook's reason as the error.
  - SessionStart sources are tracked per app process: `startup` for a new chat, `resume` for a chat's first turn after a restart, `compact` for the first turn after compaction.
  - Stop continues through the harness `onStop` path (`stop_hook_active` on continued turns, at most 8 per person turn), never after an abort, an error, a cut-off or a spending block. Notification fires when an approval card or a question waits. SessionEnd fires, without waiting, when a chat whose hooks ran in this process is deleted.
  - Not wired, each on purpose: Bot chats, Design Studio, the attended Assistant, routines, Telegram, side questions, ACP harness providers, subagents, title generation, probes and catalog work.
- **Bots** (Phase 3). The Bot extension's `beforeTool` (`{ block }` only) and `afterResponse` call the same dispatcher with `scope: bot:<id>`.
  - As built (`main/services/agent-surface-hooks.ts`, wired in `bot-runtime/bot-extension.ts`, on the desktop and the CLI): scopes are global, then `bot:<id>`; hooks run in the Bot's folder and `session_id` is the Bot id. PreToolUse runs after the Bot's own tool policy and only blocks: an ask is refused with "No one is here to approve it on this turn." PostToolUse appends feedback to the result, Stop continues the run (at most 8 times), and SessionStart and PreCompact add context. `updatedInput` is never applied. Durable Bots pass an idempotency key per tool call, so a replayed call doesn't run its hooks twice.
- **Routines** (Phase 3, as built). `scheduled-bot-routines.ts` fires RoutineRun after a successful run and RoutineFailed after a failed one, observe-only, with the Bot's scopes.
- **Subagents** (Phase 3, as built). `subagent-supervisor-core.ts` fires SubagentStop when a Bot's subagent finishes (desktop `bot-tool-sources-main.ts`, CLI `bot-subagents.ts`). Subagents don't run PreToolUse. Desktop chat subagents are not wired yet; they need `stopHooks: chatSurfaceHooks(...)` passed from `llm-client.ts`.
- **Managed worktrees** (Phase 3, as built). Creating a managed worktree runs WorktreeSetup (renamed from WorktreeCreate in review, because Claude Code's WorktreeCreate replaces worktree creation, which Aiden doesn't support) in the new checkout with the source workspace's hooks and waits for them, on the desktop and the CLI (`remote-worktrees.ts`). A failing hook is logged and never undoes the worktree; restored or resumed worktrees don't fire it.
- **CLI** (Phase 3). The daemon's existing `tool_call` gate and `before_agent_start` call the dispatcher. It is the same module, because the CLI bundles `main/services` directly. Advertise the capability through `host-platform-capabilities.ts`.
  - As built (`packages/cli/src/hooks.ts`, `daemon-chats.ts`): the daemon owns one hook service over `<agentDir>/hooks/`, separate from the desktop's store, on macOS and Linux (the `hooks` capability). Workspace chats run PreToolUse after Aiden's own access rules, PostToolUse, UserPromptSubmit, SessionStart, Stop (at most 8 continuations, kept in the session journal), PreCompact, and SessionEnd when the chat is deleted. Unlike the desktop, Telegram and scheduled chats run hooks too, with asks refused because no one is there. pi tool names (`bash`, `write`, …) are mapped to Aiden's so Claude matchers such as `Bash` and `Write` apply. Notification is not wired, and legacy Bot daemon chats run tool hooks only.
  - `aiden hooks list | approve <id> <digest> | disable <id> | enable <id> | pause | resume | test <id> <digest>` manage the store through the daemon socket, or open it directly under the serve lease when no daemon runs.
- **Excluded by design:**
  - title generation, probes and model-catalog actions (t3code's `disableAllHooks`);
  - Design Studio runs, which already reject foreign extensions;
  - ACP/Antigravity turns, whose tools run inside the agent process.

  Each exclusion is documented rather than silent.

## 8. Trust and security model

1. **Scopes:**
   - global, Settings only;
   - workspace (`.aiden/hooks.json`, or Aiden's profile copy for a workspace);
   - chat;
   - `bot:<id>`.
2. **Approval.**
   - A new or changed hook needs a host-only approval card showing the event, matcher, exact command, cwd, environment allowlist and timeout. Phones see it but get `canAllow: false`, following `approvalIsHostOnly`.
   - Approval is needed even under Full access, and it is never "remembered". Precedents: `schedule-tool.ts` one-shot confirmation, `workspace-artifacts/store.ts` command digests, and `bot-skills/propose-tool.ts` fingerprints.
3. **Repo hooks.**
   - `.aiden/hooks.json` in a cloned repo shows as "N hooks waiting for approval" in the workspace. It never auto-runs.
   - `.claude/settings.json` hooks are never read automatically. Phase 4 adds an explicit "Import hooks from Claude Code / Codex" action that converts the hooks and still requires approval for each one.
4. **Protect the config.**
   - Add the hooks files (`.aiden/hooks.json`, the profile store) to the paths `write_file`, `edit_file` and the Bot file router refuse.
   - Fix the existing gap where parent `write_file`/`edit_file` (and so Bots) had no protected-path check, which let the agent write `.claude/settings.json` in a Full-access workspace. (`SAFE_HIDDEN_DIRECTORY_NAMES` in `coding-tools.ts` only governs what subagents may read.)
   - Done in Phase 0: `main/services/protected-agent-config-paths.ts` refuses writes to `.aiden/hooks.json`, `.aiden/hooks/`, `.claude/settings{,.local}.json`, `.claude/hooks/`, `.claude/plugins/`, `.codex/config.toml`, `.codex/hooks.json` and `.codex/hooks/` at any depth, case-insensitively, on both the given and the symlink-resolved path. It applies to parent and Bot file tools, the subagent write broker and ACP client writes. Reads are unchanged. The hook stores themselves (the desktop's `<userData>/hooks/` and the CLI's `<agentDir>/hooks/`) are refused too, through `setProtectedAgentConfigRoots`, which the hook service sets as it starts.
   - `run_command` writes to these files are caught by the digest check, because a changed file disables the hook rather than running it.
5. **Unattended turns.**
   - Hooks that already exist run on routines, wake-ups and subagents.
   - The `hooks` management tool is withheld there (`bot-tool-policy.ts` `UNATTENDED_WITHHELD`).
6. **Output is data.**
   - `additionalContext`, stderr reasons and stdout are fenced with `fenceAsData`, capped (10k characters per hook, 20k per event) and attributed to the hook by name.
   - A hook can't impersonate the user or the system prompt.
7. **Kill switches:**
   - Settings → Hooks → "Pause all hooks";
   - `AIDEN_HOOKS=0`;
   - per-hook disable.

## 9. Agent access: the `hooks` tool

A deferred tool (listed in `load_tools`, so it costs no tokens until it's used) available in attended desktop workspace chats and, as `propose_hook`, in attended Bot chats:

| Action | Card | Notes |
| --- | --- | --- |
| `list` | none | Shows the scope, event, matcher, command, status and last result. No secrets: `envAllow` lists names only. |
| `propose` | host-only digest approval | Create, edit or delete. Takes event, matcher, command, timeout (≤ 30 s from the agent), `failClosed`, `envAllow` and scope (`chat`, `workspace` or `bot:<id>`; never `global`). The card shows a diff for an edit. |
| `disable` | none | Can only make things safer. Re-enabling goes through `propose`. |
| `test` | Allow once | Runs the hook against a synthetic fixture payload for its event and returns the exit code, the decision and a short excerpt of its output. |
| `logs` | none | Shows the last runs of one hook, fenced as data. |

- **Built-in skill.** A bundled skill (alongside the Aiden knowledge skill) teaches the agent the event list, the payload shape, when a hook beats a reminder, and to suggest hooks after it sees the owner repeat a correction such as "run prettier", "don't touch dist" or "tell me when you're done".
- **Learning loop (Bots).** This plugs into Plan C (self-improving): a correction can become a hook proposal that carries a behavior fingerprint and a learning-history entry, with Undo.

## 10. UI

- **Settings → Hooks.** Follows `docs/settings-design-system.md`:
  - a grouped card per scope;
  - rows show event, matcher and command, with a trailing switch;
  - status labels: *Waiting for approval*, *Changed — re-approve*, *Disabled after failures*, *Not supported in Aiden*;
  - a "What hooks can see" sheet;
  - Import from Claude Code, in Phase 4.
  - Status (2026-10-31): built on `feature/aiden-hooks` with an Add hook sheet, a detail sheet with run log, Test and Delete, digest-bound Approve for repo hooks, agent proposals with a before-and-after diff, and Pause all hooks; see the Hooks section of `docs/settings-design-system.md`. Import from Claude Code was dropped by owner decision 5.
- **In chat.** A hook block or ask shows inside the existing tool row ("Blocked by hook *guard-shell*: pushes to main are not allowed"). Context from hooks appears in the Quick View Context breakdown as a new "Hooks" category.
- **Phones.** Hook runs appear as `tool` steps in Phase 1, with no protocol change. iOS `AidenAgentStep.Kind` is a closed enum, so adding a `hook` kind needs a capability-gated Remote revision across iOS, Android and the fixtures (Phase 5).
- **Onboarding.** Hooks are a power-user feature, so they get no onboarding step and no gallery tile in v1. Revisit once Bots can propose hooks.

## 11. Phased rollout

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 0 | Close the `.claude` hidden-directory write gap and protect the hooks paths. Do this first even if hooks slip. | Behavioral tests: `write_file` and `edit_file` refuse `.claude/settings.json` and `.aiden/hooks.json` in Full access |
| 1 | `main/services/hooks/` core plus desktop workspace chats: PreToolUse (block, ask, scoped allow), PostToolUse context, UserPromptSubmit, SessionStart context, Stop/Notification observe-only. Global and workspace scopes, edited in Settings. | Fixture suite for parser, matcher, merge and runner (adapting deepseek-harness's 15 scenarios); register-and-invoke tests; one Playwright flow (a hook blocks `run_command`, the reason shows in the tool row) |
| 2 | Agent `hooks` tool and skill, the digest approval card, Settings → Hooks page, run log, auto-disable and issues. | Approval-card Playwright flow with screenshots for owner review; tests that phone approval of a hook is refused |
| 3 | Bots (`propose_hook`, `beforeTool` and `afterResponse`), routines, subagents, worktree setup, PreCompact, Stop-continue (8-turn cap, `stop_hook_active`), CLI parity with a capability flag. | Durable-replay idempotency test; CLI test that the daemon honours a block |
| 4 | Opt-in import from `.claude/settings.json`, Claude plugin `hooks/hooks.json` and Codex config, converted with per-hook approval. | Import fixtures for the superpowers and Codex plugin hooks on this Mac |
| 5 | Remote revision for a native `hook` step kind and hook status on iOS and Android (read-only). | iOS, Android and fixture contract tests together |

## 12. Docs and test obligations

- New guide `docs/hooks.md`, covering the format, events, payloads, aliases, trust model and examples.
- Update:
  - `docs/skills.md` (the plugin-hooks sentence);
  - `README.md` and `PRODUCT.md` feature lists;
  - `packages/cli/README.md` in Phase 3;
  - this index.
- Analytics are optional. If added, the only events are `hook_approved`, `hook_blocked_tool` and `hook_auto_disabled`, with event and scope enums only, never commands. Each is registered in `analytics-events.ts` and `docs/analytics.md`.
- Register every new test file in the `package.json` test chain and `scripts/ci-test-registry.json`.

## 13. Owner decisions

Answered 2026-10-31: 1 A (Claude-compatible schema), 2 A (repo `.aiden/hooks.json` waits for approval), 3 A (the agent may propose workspace and chat hooks), 4 yes (Stop hooks may continue a turn, capped), 5 no (no import of Claude Code or Codex hooks; Phase 4 is dropped). The first implementation covers Phases 0 to 3; Phase 5 stays a follow-up.

The original questions:

1. **Format.**
   - Option A (recommended): adopt the Claude-compatible schema natively, with the alias layer.
   - Option B: an Aiden-specific schema plus a converter.
2. **Repo hooks.**
   - Option A (recommended): read `.aiden/hooks.json` from repos as "waiting for approval".
   - Option B: hooks live only in Aiden's profile.
3. **Agent tool reach.**
   - Option A (recommended): the agent may propose workspace and chat hooks in v1.
   - Option B: only list and test.
4. **Stop-continue.** Continue a turn from a Stop hook (needs a new continuation path in the harness) in Phase 3, or never.
5. **Claude Code plugin hooks.** Whether Phase 4 import is wanted at all, given the plugin skill import was intentionally skills-only.
