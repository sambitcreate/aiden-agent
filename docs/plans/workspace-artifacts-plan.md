# Workspace Artifacts Plan

Status: Proposed (2026-10-19). Desktop only (macOS and Linux) for v1.
Owner decisions (2026-10-19): Artifacts is a Tools-panel tab that exists only once the workspace has an artifact; the workspace owns artifacts, and the person deletes them from the tab or by asking Aiden; data sources follow the chat's own permissions; phones and CLI are out of scope for v1.

## Outcome

A person asks "make me an artifact that shows the open PRs for this repo", and Aiden builds a small interactive Aiden-styled page that lives in the **Artifacts** tab of the Tools panel, not in the transcript. It keeps working after the chat ends: it re-reads its data on open or on refresh, its buttons can ask Aiden for help, fill the composer or run an approved action, and every chat in that workspace sees the same artifacts until someone deletes them.

How this differs from what ships today:

| | Inline visuals (`render_ui`, `render_artifact`) | Workspace artifacts (this plan) |
| --- | --- | --- |
| Where | In the reply, in the transcript | Tools panel → Artifacts tab |
| Owner | One chat response | The workspace |
| Data | Frozen at render time | Re-read from declared sources |
| Lifetime | Scrolls away with the chat | Until deleted |
| Actions | send, set, open, copy | Those, plus compose and run |

## Building blocks already on main

- **Aiden UI Markup and catalog.** `main/services/aiden-ui-tool.ts` compiles model-written markup into a validated tree (`renderer/shared/aiden-ui/`), with `<Data>` bindings, local state, expressions and the `send`/`set`/`open`/`copy` actions. `renderer/components/aiden-ui/` draws it with Aiden's own components, so artifacts get the theme, presets, focus and reduced-motion behavior for free. There is no script execution, which keeps artifacts in the content trust class.
- **Tools panel.** `renderer/lib/environment-panel-state.ts` already hides tabs by capability (`subagents`, `devices`); Artifacts uses the same mechanism with "workspace has at least one artifact" as its condition.
- **Chat PR tracking.** `main/services/chat-pull-request-service.ts` already reads GitHub PR state through `gh`, which the skill can point at for the PR example.
- **Workspace permission.** `WorkspacePermission` (`full` / `ask` / `none`) and the existing tool-approval cards decide what a chat may run. Sources reuse them unchanged.
- **Bundled skills.** `resources/aiden-help/skills/aiden-app/SKILL.md` is the pattern for an owned skill shipped with the app.

## Naming

The name "artifact" is already used by `render_artifact` (inline HTML visuals) and in `docs/pi-gui-artifacts.md`. The user-facing name stays **Artifacts** because the inline visuals are called visuals in the UI. In code and tool names these are **workspace artifacts** (`workspace_artifact`, `WorkspaceArtifactV1`) so they never collide with `render_artifact`.

## Contract

```ts
interface WorkspaceArtifactV1 {
  id: string;                 // stable, host-generated
  workspaceId: string;
  title: string;              // ≤ 80 chars, unique per workspace
  description?: string;       // one line, shown in the switcher
  tree: AidenUiNodeV1;        // compiled render_ui tree, same limits as ChatUiVisualV1
  sources: ArtifactSourceV1[];   // ≤ 8
  actions: ArtifactActionV1[];   // ≤ 16 named run actions
  refresh: { onOpen: boolean; intervalSeconds?: number }; // interval ≥ 60, only while visible
  state?: Record<string, unknown>;  // persisted local state, ≤ 4 KiB
  createdByChatId?: string;  // provenance only; the chat may be deleted
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type ArtifactSourceV1 = {
  name: string;               // bound in markup as $name
  parse: "json" | "lines" | "text";
} & (
  | { kind: "shell"; command: string }          // runs in the workspace folder
  | { kind: "file"; path: string }              // workspace-relative
  | { kind: "tool"; tool: string; input: unknown } // any tool the chat could call, e.g. an MCP tool
);

interface ArtifactActionV1 {
  name: string;               // referenced as run("name", {…})
  label: string;              // shown in the approval card
  kind: "shell" | "tool";
  template: string | unknown; // `{{param}}` placeholders, filled only from declared params
  params: { name: string; type: "string" | "number" }[];
}
```

Snapshots of the last successful read of each source are stored with the artifact (bounded by `AIDEN_UI_LIMITS.dataBytes` per source) so the tab paints instantly and keeps the last good data when a refresh fails.

Storage: one JSON file per artifact under `<userData>/workspaces/<workspaceId>/artifacts/`, written through the same atomic-write helper as `data-store.ts`. Not in the user's repository and not synced.

## Permissions ("follow chat behavior")

Sources and run actions are executed by main, outside any model turn, but under exactly the rules a chat in the same workspace would face:

- Workspace access **Full**: sources run without asking; run actions still show the normal approval card when the equivalent chat tool call would.
- Workspace access **Ask**: the first refresh of each source shows the chat approval card ("Allow / Allow always for this artifact / Deny"). "Allow always" is keyed to the artifact id and a hash of the source definition, so an edit by Aiden re-asks.
- Workspace access **Off**: shell and file sources do not run; the tab shows a callout with the last snapshot. Tool sources follow the tool's own gating.
- MCP tools keep their own approvals (`mcp-stdio-approvals.ts`).
- Timeouts (30 s per source), output caps (256 KiB raw, `dataBytes` after parsing), one refresh in flight per artifact, cancelled when the tab closes or the app quits.
- No model call happens during a refresh. Artifacts never gain Bot, subagent or Remote authority.

## Agent tool and skill

One chat-scoped tool, `workspace_artifact`, registered for desktop workspace chats (not Bots, not the CLI, not Remote runs in v1):

- `create { title, markup, sources, actions, refresh }`: compiles markup with the `render_ui` compiler, validates sources, saves, runs the first refresh, and opens the Artifacts tab.
- `update { id, …partial }`: bumps `revision`; re-asks approval for any changed source.
- `list`: titles, ids and source names for this workspace, so the model edits instead of duplicating.
- `delete { id }`: only when the person asked; shows a confirm card the same way other destructive tools do.

The tool result returns compile diagnostics like `render_ui`, plus the first refresh's per-source status so the model can repair a bad command in the same turn. The transcript shows a compact card: "Created artifact · Open PRs · Open".

A bundled skill, `resources/aiden-help/skills/aiden-artifacts/SKILL.md`, teaches:

- when to build an artifact (ongoing, project- or workspace-level status the person will come back to) versus an inline `render_ui` visual (a one-off answer);
- to `list` first and update an existing artifact rather than create a near-duplicate;
- source recipes with examples: open PRs and CI (`gh pr list --json …`), TODO/FIXME board (`rg --json`), release checklist (file source), dependency drift, last test run;
- to keep commands read-only in sources and put anything that changes state in a named run action.

## UI

- **Tab visibility.** `EnvironmentPanelTab` gains `"artifacts"`. It is offered in the new-tab picker and restorable from storage only when the current workspace has at least one artifact; deleting the last one closes the tab. Creating an artifact opens the Tools panel on it.
- **Layout.** A compact switcher at the top (title, last refreshed, status dot for a failing source), then the artifact body, scrollable. Header actions: Refresh, and a ••• menu with Rename, Ask Aiden to change this, and Delete (confirm dialog naming the artifact).
- **States.** Last snapshot paints first; a quiet spinner on Refresh during a read; a failing source shows a soft callout with Retry and the error line; an error boundary replaces only the artifact body if rendering throws.
- **Actions.**
  - `send` posts into the workspace's current chat, or starts a new chat in the workspace when none is open.
  - New `compose`: adds text to the current composer without sending.
  - New `run("name", params)`: executes the named action through the approval flow above, then refreshes.
- Follows `GUI.md`, `docs/design-guide.md` and `docs/settings-design-system.md`; no decorative borders, neutral focus ring, squircle buttons.

## Platforms

| Surface | v1 |
| --- | --- |
| macOS desktop | Yes |
| Linux desktop | Yes |
| CLI | No. `workspace_artifact` is not registered; the skill is not bundled in the CLI. |
| iOS, Android | No. The transcript card's fallback text ("Created artifact: Open PRs, open it in Aiden on your Mac") is all phones see. No Remote protocol revision. |

`host-platform-capabilities.ts` gains a `workspaceArtifacts` capability so the claim stays checkable.

## Phases

1. **Store and tool.** `WorkspaceArtifactV1` types and parser, file store, IPC (`artifacts:list/get/delete/rename`), `workspace_artifact` tool with create/update/list/delete, transcript card. No sources yet (static `<Data>` only).
2. **Artifacts tab.** Tab visibility rule, switcher, renderer with error boundary, Rename and Delete, open-on-create.
3. **Sources and refresh.** Source runner in main with the permission gate, snapshots, on-open, manual and interval refresh, failure callouts.
4. **Actions and skill.** `compose` and `run` actions, the bundled `aiden-artifacts` skill, examples verified end to end.
5. **Docs and onboarding.** README and PRODUCT.md, a short `docs/workspace-artifacts.md` guide, the onboarding feature-tour tile with its own code-drawn illustration, the feature board, and this plan's status row.

## Tests

- Parser and store: round-trip, limits, revision bumps, atomic write, corrupt-file recovery (extend `data-store.resilience.test.ts` patterns).
- Source runner: each permission mode with fixtures, timeout and output caps, approval keyed to the source hash, cancellation.
- Tool: register-and-invoke for create/update/list/delete, diagnostics returned to the model.
- Renderer: tab hidden with zero artifacts and shown with one, delete of the last artifact closes the tab, failing source keeps the last snapshot, crashed body leaves the panel usable.
- Playwright: ask for an artifact with a stubbed model, see the tab appear, refresh, run an action through approval, delete it.

## Risks and open questions

- **Long-lived shell commands.** "Follow chat behavior" means a workspace on Full access refreshes shell sources without asking. Interval refresh is opt-in per artifact and only runs while the tab is visible, to keep that bounded.
- **Send target.** v1 sends to the current chat in the workspace; a per-artifact "always start a new chat" option can follow if that feels wrong in use.
- **Bots.** Bot managed workspaces are excluded from v1; revisit after the Bot side panel settles.
- **Phones later.** If phones want artifacts, the tree already crosses the Remote wire for `render_ui`; a read-only view would need a protocol revision and host-side refresh only.
