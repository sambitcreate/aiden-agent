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
