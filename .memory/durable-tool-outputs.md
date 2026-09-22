# Durable tool output / file provenance — September 22, 2026

Active implementation: `feature/durable-produced-tool-output`, baseline `c8c09e0d`.
Plan: `docs/plans/durable-tool-output-plan.md`. MCP was already bounded on current
main, despite the September 15 Notion audit. Adapt the successful-mutation principle
from verified `deepseek-ai/deepseek-harness` deliverables documentation; no code copied.

Private spill storage is separate from inbound attachments. Ordinary workspace
generations can recover bounded command/MCP text through `read_tool_output` using
opaque chat/authority-bound handles. Bot/child/Assistant allowlists do not change.
File mutation metadata is additive to timeline v3 and carries only validated relative
path, operation and byte count. All clients display successful host provenance.

Review corrections: use `chat.workspaceId` with persistedChatWorkspaceId; normalize
Windows separators; canonicalize parent directories for macOS /var symlinks; include
encrypted credential-store fingerprints in authority; prune expired storage on startup.
Validation: 125 focused tests and 10 inventory-fence tests pass; TypeScript and lint pass; Android chat/contract tests 38/38 pass; unsigned generic iOS app/test build passes; React Doctor 90/100 with no issues. Physical iPhone XCTest is queued but blocked by locked device (deviceprep Code=-3). Two independent Sol medium reviews and follow-up corrections are clear. Hosted PR state remains pending.


PR #219 at 58abfb02 passed hosted CI/Android/Electron gates. Pullfrog follow-up fixes include all three encrypted credential stores even in no-MCP workspaces, POSIX colon path parity, 240 Unicode code-point limits across clients, ASCII-only drive prefixes, and AJV-tested normative path/tool/status constraints. Follow-up validation: 128/128 focused tests, TypeScript, lint, Android chat/contract tests, and unsigned generic iOS test build pass; both independent reviewers clear. Follow-up hosted CI remains pending; physical XCTest remains blocked by device lock.
