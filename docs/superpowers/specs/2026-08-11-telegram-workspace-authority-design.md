# Telegram Workspace Authority Design

## Decision

Telegram remote control has two explicit operation modes:

- **Assistant mode:** no workspace selected. Turns retain the existing `assistant-unattended` behavior and cannot access a local project.
- **Project automation mode:** a user explicitly selects one configured workspace in Settings → Telegram. Turns execute with `assistant-automation`, `permission: "full"`, and that exact workspace ID.

The selection is never inferred from the most recently opened workspace. A phone-originated command therefore cannot mutate an unintended project.

## Configuration

`AppSettings` gains `telegramWorkspaceId?: string`. The Telegram status IPC response includes it, and a dedicated `telegram:setWorkspace` handler persists a selected configured workspace ID or clears the selection.

The Settings → Telegram page shows a Workspace selector near Provider and Model. Each option identifies the configured workspace by name and path. The current no-workspace option is labelled as an assistant-only mode. The selector has explicit empty and unavailable states.

## Turn routing

Every Telegram turn resolves the selected workspace in the main process.

- With no selection, it retains the pre-existing `telegram-<ownerId>` backing chat and `assistant-unattended` mode.
- With a valid selection, it uses `assistant-automation`, passes `workspaceId`, and derives a distinct backing-chat ID from the Telegram owner and workspace ID.
- If the saved workspace no longer exists, the turn fails with a concrete explanation. It never silently falls back to another workspace or to assistant mode.

Provider resolution remains independent and retains the provider fingerprint supplied to `llmClient.start`.

## Authority boundary

Project-mode Telegram turns use `permission: "full"` only for the selected workspace’s coding-tool allowlist. They keep `allowComputerUse: false`, `allowSubagents: false`, and `allowMcpTools: false`. The single paired Telegram owner and explicit Settings opt-in remain the trust boundary.

## Verification

Tests cover workspace chat identity, selected-workspace generation mode and ID, missing workspace rejection, persisted IPC settings, and settings selector states. A real paired-bot smoke verifies a configured workspace runs an explicit safe request.

## Onboarding

The final feature-tour bento gallery gets a Telegram Remote Control tile plus its optimized 1024 × 1024 transparent PNG, covered by the existing onboarding asset contract.
