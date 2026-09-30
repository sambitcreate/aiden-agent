# Tool approval scopes — 2026-09-27

- Branch `feature/approval-scopes`, based on `origin/main` at `a9baa4aa3`. Plan: `docs/plans/tool-approval-scopes-plan.md`.
- Shared types and helpers live in `renderer/shared/tool-approval-scope.ts`. The rule book and its persistence are in `main/services/tool-approval-rules.ts` (a DataStore `tool-approval-rules.json`), and the singleton is in `tool-approval-rules-main.ts`.
- `llm-client.ts` computes `toolApprovalRuleTarget(...)` for non-Bot `APPROVAL_TOOL_NAMES` calls in Ask workspaces.
  - A remembered match (chat or always) skips the prompt.
  - Otherwise it offers `SCOPED_APPROVAL_OFFER` and, after an allow, grants the scope read from `approvals.takeDecisionPayload`.
- The coordinator (`tool-approval.ts`) only stores a scope that is offered, non-once and allowed.
- IPC:
  - `chat:approve` options carry `scope`.
  - `chat:listApprovalRules`, `chat:revokeApprovalRule` and `chat:revokeAllApprovalRules` back the Settings section `approvals`.
  - `remote:respondApprovalFromHost` takes an optional 5th `scope`.
- Remote contract revision 17:
  - `PendingApproval.scopes` is present only when `canAllow`.
  - The respond body has an optional `scope` that must be allowed and offered, otherwise 400 `invalid_request`. The response echoes it.
  - The OpenAPI request schema encodes "scope requires allow" with if/then.
- iOS `AidenApprovalScope` and Android `AidenApprovalScope` decode raw strings tolerantly and set scopes only for allowable action approvals. Android sends `AidenApprovalRequest.of(decision, scope)`.
- Tests:
  - `tool-approval-rules.test.ts` (new)
  - `tool-approval.test.ts`
  - `aiden-remote-streams.test.ts`
  - `aiden-remote-router.test.ts`
  - `aiden-remote-protocol.test.ts` (Ajv)
  - `remote-approval.test.ts`
  - `tool-approval-settings.test.tsx` (new, render)
  - iOS `AidenChatTests` and `AidenRemoteClientTests`
  - Android `AidenChatTest`

## Review follow-up

Remembered file targets preserve leading/trailing whitespace, so distinct filesystem names cannot share approval authority. Regression covers persisted matching; all 7 rule-book tests pass.

- Follow-up review: reject raw parent-path segments before normalization; command rules permit tab/newline/carriage-return whitespace but reject other ASCII controls before trimming. Regression covers leading and embedded control characters and parent segments.

Independent review also identified Windows backslash parent segments; raw parent validation now covers both separator forms and mixed separators, with regression coverage.
