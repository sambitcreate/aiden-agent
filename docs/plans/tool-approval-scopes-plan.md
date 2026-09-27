# Tool approval scopes: once, this chat, always

Status: Implemented for review (branch `feature/approval-scopes`).

## Goal

Stop asking again for the exact same workspace action the user already approved, without ever authorizing more than the approval card showed.

## Scopes

| Scope | Lifetime | Where it applies |
| --- | --- | --- |
| Allow once (default) | This tool call | This call only |
| Allow for this chat | In memory until the app quits | Same chat, same workspace, same tool, same exact target |
| Always allow | Persisted in `tool-approval-rules.json` until revoked | Any chat in the same workspace, same tool, same exact target |

## Rule shape and safety

- Rules exist only for the parent agent's plain workspace tools `run_command`, `write_file` and `edit_file` in a workspace whose permission is **Ask**.
- The key is `[workspaceId, toolName, pattern]`.
  - `run_command`: the exact trimmed command string. There are no prefixes, globs or argument wildcards.
  - File tools: a posix-normalized, workspace-relative path. Absolute paths, `~`, `..` segments, control characters and `.` are rejected. Such a call is offered **Allow once** only.
  - A `write_file` rule never authorizes `edit_file`, and the reverse is also true.
- Scopes are never offered for these approvals:
  - Bot turns. Telegram and Bot authority stay policy-owned, and Telegram runs with full permission and never prompts.
  - Subagent shell or run grants.
  - Privileged or structured details.
  - MCP mutations.
  - Form Fill.
  - Schedule and automation tools.
  - Browser approvals.
- The main process decides which scopes are offered (`ToolApprovalPrompt.scopes`). `ToolApprovalCoordinator.decide` drops a scope in any of these cases: it was not offered, it came with a deny, or it is unknown. The Remote stream service applies the same fence.
- Loading the persisted rules is strict. Rules that are malformed, duplicated, non-canonical (hand-widened) or over the limit are dropped. Limits:
  - 200 persisted rules. Granting beyond that fails, and the call still runs once.
  - 100 chat rules per chat, evicting the oldest.

## Surfaces

- **Desktop approval card:** transparent **Allow for this chat** and **Always allow** buttons sit between **Deny** and the accent **Allow once**.
- **Settings → Tool approvals:** listed in the Agent group. It lists persisted rules newest first, each with an exact description and a per-row **Revoke**, plus a destructive **Revoke all** row. The layout follows `docs/settings-design-system.md`.
- **Aiden Remote contract revision 16:**
  - `PendingApproval.scopes` is optional, has at least 2 entries and starts with `once`.
  - `POST /approvals/{id}/respond` accepts an optional `scope`, valid only with `allow` and only when it was offered. The response echoes it.
  - The idempotency fingerprint includes the scope.
- **iOS and Android:** the approval card gains a "More allow options" menu (an ellipsis on iOS, `MoreVert` on Android) that lists the broader scopes. The clients send `scope` only when it was offered, and never for once or deny.

## Follow-ups

- Scope UI for the Aiden Live assistant and for subagent or Bot approvals, if product wants them. This needs a separate authority review.
- Call `ToolApprovalRuleBook.forgetChat` when a chat is deleted. Chat rules are currently in memory only and bounded.
- Live-refresh Settings → Tool approvals from `ToolApprovalRuleBook.onChange`. It currently reloads on open and after each revoke.
