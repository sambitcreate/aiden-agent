# Telegram Workspace Authority Design

## Decision

Telegram remote control has two explicit operation modes:

- **Assistant mode:** no workspace selected. Turns retain the existing `assistant-unattended` behavior and cannot access a local project.
- **Project automation mode:** the paired Telegram owner explicitly selects one configured workspace in Settings or with `/workspace`. Turns execute with `assistant-automation`, `permission: "full"`, and that exact workspace ID.

The selection is never inferred from recently opened activity. `/workspace` can select only a configured folder workspace and changes the persisted Telegram scope; it never accepts a filesystem path.

## Configuration

`AppSettings` gains `telegramWorkspaceId?: string`. The Telegram status IPC response includes it, and a dedicated `telegram:setWorkspace` handler persists a selected configured workspace ID or clears the selection.

The Settings → Telegram page shows a Workspace selector near Provider and Model. The paired owner can also run `/workspace` in the private bot chat to list configured folders, select one by number, ID, or an exact name, or run `/workspace off` for assistant-only mode. The list identifies the active selection. Changing scope clears queued prompts; each accepted prompt also records its workspace ID before joining the queue, so a concurrent Settings change cannot retarget it. An already-active turn remains bound to the scope it began with.

## Turn routing

Every Telegram turn resolves the workspace ID captured when its prompt was accepted in the main process.

- With no selection, it retains the pre-existing `telegram-<ownerId>` backing chat and `assistant-unattended` mode.
- With a valid selection, it uses `assistant-automation`, passes `workspaceId`, and derives a distinct backing-chat ID from the Telegram owner and workspace ID.
- If the saved workspace no longer exists, the turn fails with a concrete explanation. It never silently falls back to another workspace or to assistant mode.

Provider resolution remains independent and retains the provider fingerprint supplied to `llmClient.start`.

## Authority boundary

Project-mode Telegram turns use `permission: "full"` only for the selected workspace’s coding-tool allowlist. They keep `allowComputerUse: false`, `allowSubagents: false`, and `allowMcpTools: false`. The single paired Telegram owner, Settings enablement, and the configured-folder-only `/workspace` command remain the trust boundary.

## Verification

Tests cover workspace chat identity, selected-workspace generation mode and ID, missing workspace rejection, persisted IPC settings, settings selector states, and owner-authorized `/workspace` list/select/clear flows. A real paired-bot smoke verifies a configured workspace runs an explicit safe request.

## Onboarding

The final feature-tour bento gallery gets a Telegram Remote Control tile plus its optimized 1024 × 1024 transparent PNG, covered by the existing onboarding asset contract.
