# Workspace settings: per-workspace skills and connectors

Status: v1 in review (2026-10-30). Requested by the owner on 2026-10-30.

## Goal

Each folder workspace can switch off specific skills and connectors (MCP servers) for its own chats, configured in a pop-up rather than a full-screen page.

## Owner decisions (2026-10-30)

1. Everything on in Settings starts on in every workspace; a workspace keeps a list of what it switched off, so a skill or connector added later starts on there too.
2. Bots keep their own access and ignore workspace choices (as with workspace memory).
3. A change applies from the next message; a reply already running keeps its tools.
4. Phones get no new screens; chats started from a phone obey the desktop's choices with no Remote protocol change.
5. The CLI should become a CLI-only version of the desktop app, so it gets the same settings in a follow-up.
6. Built-in tools (web search, browser, image generation, computer use) are not part of v1.
7. Chats without a workspace use Settings. No workspace chats (#667) run in a hidden managed folder but still have no Workspace settings, and the config store never keeps an off-list on them.
8. A skill switched off for a workspace is hidden from the model, but typing `$` and its name still runs it.
9. `⇧⌘,` opens Workspace settings; it was checked against the command catalog, reserved keys and the native menus.

## v1 (desktop)

- `Workspace.disabledSkills` (canonical skill names) and `Workspace.disabledMcpServerIds` live in the device-local config. Damaged values are cleaned on load instead of dropping the workspace. New managed worktrees copy their project's lists.
- Enforcement in the main process: the skill registry hides switched-off skills from the prompt, the skill tools and Pi resources; the connector collector, the subagent connector inventory, `list_mcp_servers` and the context meter skip switched-off connectors. Bot and approved-automation runs keep their exact grants.
- The pop-up (`renderer/components/workspace-settings-dialog.tsx`): General (name, folder, access, memory), Skills, Connectors. Entry points: the sidebar ⋯ menu, the top-bar workspace chip menu, the command palette and `⇧⌘,`. Design notes: [settings design system](../settings-design-system.md#workspace-settings).
- Tests: `skill-registry.test.ts`, `assistant/mcp-tool.test.ts`, `config-store-core.test.ts`, `workspace-application-service.test.ts`, `renderer/lib/workspace-settings-view.test.ts` and the Electron spec `tests/e2e/workspace-settings.spec.ts`, which checks the next model request no longer offers a switched-off skill.

## Later

- CLI parity (owner decision 5).
- A "new ones start off here" switch per workspace; per-tool switches inside a connector; a Built-in tools tab.
- Showing or editing these choices on phones (needs a Remote revision).
- An opt-in project file that can only switch things off, with a trust prompt.
