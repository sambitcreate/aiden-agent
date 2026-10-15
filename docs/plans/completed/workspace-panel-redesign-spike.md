# Workspace panel redesign spike

Status: Complete locally — 2026-10-07; PR [#381](https://github.com/sambitcreate/aiden-agent/pull/381) on `feature/workspace-panel-redesign`, stacked on [#380](https://github.com/sambitcreate/aiden-agent/pull/380). Verification caveats below.
Date: 2026-10-07. Baseline: `0c708ad94`.

## Direction

The user accepted adding the Context inspector and expanded the request into a
redesign of the right-hand workspace panel. Opening it without a destination
should show a tool launcher like the supplied Codex screenshot. Users open tools
as needed and can move Terminal into this panel.

The original spike examined Aiden's source and lifecycle constraints. The user
subsequently approved implementation; the delivery and runtime evidence are
recorded below. The screenshot is visual reference, not a requirement
to invent unsupported tools. The left chat/project sidebar is outside this scope.

## Proposed interaction contract

- **Generic open:** the panel button and existing `environment.toggle` command
  open a selected **New tab** launcher. If already open, the toggle hides the
  panel. Reopening generically selects the launcher but retains existing tabs.
  This deliberately replaces the current “open last tool” behavior.
- **Targeted open:** Files, Changes, Context, browser links and other deep links
  open/select the requested tool directly. Reuse an existing singleton instead
  of adding duplicate Changes, Files, or Context tabs.
- **New tab / +:** focus or create one blank launcher. Choosing a tool replaces
  that launcher with the tool tab, or selects an already-open singleton. An
  explicit URL submission creates a browser page; merely opening the launcher
  performs no network request or shell creation.
- **Tool tabs:** show icon, title, active state, close action and an overflow
  menu when space runs out. Keyboard users can select, close and reopen them.
  Closing the last tool returns to the launcher. Hiding the panel preserves
  its tabs and their state within the current owner scope.
- **Launcher:** use the following inventory. Show unavailable actions with a
  concrete prerequisite where useful; omit capabilities disabled by feature
  policy. Reuse command-system shortcut labels instead of screenshot shortcuts.
- **Layout:** retain the existing resizable side-by-side and non-modal floating
  modes, responsive chat-width budget, Quick View independence, and focus
  restoration. Do not introduce a backdrop or trap chat interaction.

| Launcher action | Result | Scope / prerequisite |
| --- | --- | --- |
| Changes | Existing Review surface; user-facing label becomes Changes | Active authorized workspace; Git state controls actions |
| Files | Existing file browser/editor | Folder workspace and existing file access |
| Terminal | Show existing terminal group in the side panel, or create one on explicit selection | Local folder workspace and existing terminal admission |
| Context | Inspector from the accepted context plan | Saved local chat; drafts show an honest empty state |
| Browser / Open URL | New browser page using existing browser service | Existing workspace/browser admission |
| More tools → Subagents | Existing subagent roster/detail | Enabled capability and applicable chat |
| More tools → Simulator | Existing Devices surface | Enabled capability and supported device environment |
| Quick View | Existing independent workspace summary | Existing workspace availability |

“New page” and “Side chat” in the screenshot are not yet mapped to equivalent
tools for this panel. Do not silently turn them into new document or chat
features. Suggested-site tiles are optional later work; the initial launcher
needs no browsing-history collection, favicon fetching, or recommendations.

## Terminal placement

- Add **Move to side panel** to the bottom terminal menu and **Move to bottom**
  to the side terminal menu. Move the existing terminal group, including its
  sessions and split layout. Keep the bottom placement as the migration default.
- The terminal launcher explicitly selects side placement. The existing terminal
  shortcut opens/hides Terminal at the user's chosen placement; it must reveal
  the terminal if another panel tab is selected rather than hiding the panel.
- Persist placement preference, not live PTY identifiers. Only one visible
  terminal surface owns keyboard input/resize for a session at a time.
- Moving, switching tabs, or closing the top-level Terminal tool tab hides the
  group without terminating its processes. Session close actions remain explicit
  termination actions, using the existing service behavior. Label these actions
  distinctly; reopening Terminal reattaches to the existing group.
- Preserve the existing policy that switching workspaces closes the old
  workspace's sessions. Do not promise live processes survive app restart.

## Source findings and implications

| Source | Observed behavior | Consequence |
| --- | --- | --- |
| `renderer/lib/environment-panel-state.ts` | Fixed destination union and one `toolsTab`; no open-tab list or launcher | Introduce a versioned tab model instead of growing conditional tab buttons |
| `renderer/components/environment-panel.tsx` | Tool bodies remain mounted; active flags gate work; owns dirty-file state, Git busy guards, scope, focus and Quick View coexistence | Retain these owners while replacing panel navigation; closing tabs cannot bypass guards |
| `renderer/main/chat-pane.tsx` | Environment toolbar currently requires an effective workspace | Make generic launcher/Context reachable without a folder while individually gating workspace tools |
| `renderer/main/root-view.tsx` | Terminal provider wraps Environment provider | Existing terminal session owner can serve either placement without a second provider |
| `renderer/components/terminal-drawer.tsx` | Provider owns PTYs; viewport unmount disposes the renderer surface only; snapshot plus sequenced events restores output | Extract reusable terminal group presentation; prove move/reattach under live output before shipping |
| `renderer/components/terminal-drawer.tsx` | Session close and workspace switch explicitly call terminal close; drawer hide preserves sessions | Tool-tab dismissal must use hide, not session close |
| `renderer/components/browser-panel.tsx` | Browser has its own tab strip and authoritative service IDs; `present` controls native-view bounds/visibility, with menu/overlay occlusion | Avoid two conflicting tab owners; integrate service tab IDs through an adapter and retain presentation fencing |
| `renderer/main/chat-layout.tsx` | Remote chats and Studio suppress Environment and Terminal | Keep these boundaries explicit; never run a local terminal as if it belongs to a remote host |
| `.memory/lane40-environment-focus.md` | Menu teardown once stole focus back from Files and made tools inert | Launcher/menu activation must retain deferred focus handoff and existing regressions |
| `.memory/perf-browser-throttling.md` | Browser hidden-state scheduling has explicit operation ownership | Generic tool tabs must not disable throttling or alter browser activity leases |

## Recommended architecture

Add a small typed tool registry with label/icon, availability, owner scope,
instance identity, activation, visibility and close policy. Keep main-process
file, Git, browser and terminal services authoritative; the registry is renderer
navigation, not a new permissions layer.

Represent the panel as `open`, `activeTabId`, and an ordered list of typed tab
descriptors: launcher, Changes, Files, Context, terminal group, browser page,
Subagents and Simulator. Browser descriptors reference existing service tab
IDs; a browser event reconciles the strip rather than duplicating service state.
Use one browser presenter for the selected page and remove the redundant inner
browser strip only after its actions have equivalents in the shared strip.

Preserve the current Files editor in its tool tab in the first delivery; opening
multiple individual file documents is a later editor feature. Keep terminal
session/split controls within one Terminal tool tab initially. No drag-and-drop
docking is required: explicit placement menu actions are the first delivery.

Scope Context and Subagents to the active chat; scope Changes, Files, Browser and
Terminal to their workspace/host. Resolve scope before applying async results.
Switching owner must never paint old context, output, diffs or browser content.
Persist bounded, versioned presentation state; validate stale/unknown entries.
Do not resurrect shell processes or navigate browser URLs just by restoring the
launcher. Existing browser restoration policy remains its service's concern.

Migrate legacy `toolsTab`/width/open preferences to compatible descriptors;
generic open still selects the launcher. Preserve Quick View's separate state.
Dirty file content stays with the existing editor owner: hiding/switching keeps
it, while destructive tab disposal requires the current save/discard decision.
Active Git operations retain their existing navigation/dismissal restrictions.

## Delivery and proof points

1. **Panel foundation and launcher.** Typed registry, open-tab state, generic vs
   targeted activation, tab close/overflow/focus, legacy migration and layout.
   Adapt existing Changes/Files/Subagents/Simulator bodies without rewriting
   their services. Update command labels, design references and UI specimen.
2. **Context integration.** Implement the accepted inspector and independent
   composer preference from `chat-context-inspector-plan.md` in this shared shell.
   Retain its accounting completeness and storage boundaries.
3. **Terminal docking proof, then integration.** Extract presentation from the
   drawer; switch placement during continuous output, alternate-screen apps and
   split sessions. Assert stable PTY IDs, no duplicate input or missing sequenced
   output, correct resize/focus, and owner-change cleanup. Determine whether
   viewport remount preserves required screen/scrollback state; if not, retain a
   stable surface host across placement changes. Do not settle for respawning.
4. **Browser tab integration proof, then integration.** Adapt create/select/close
   and service-initiated tabs into the shared strip. Verify native-view bounds,
   menus, hidden tabs, floating browser, annotation, recording and crash states.
   Showing the launcher must conceal every embedded native browser view.
5. **Acceptance and documentation.** Run focused state/terminal/browser/settings
   suites and Electron interactions, type checks and build. Register new tests
   in the appropriate package/CI discovery. Review onboarding: update the shipped
   workspace-tool discovery copy/gallery as appropriate; any new advertised tile
   needs its own optimized 1024 × 1024 transparent PNG and asset coverage.

Required UI acceptance includes narrow/wide windows, light/dark themes, keyboard
tab navigation and close, focus restoration, reduced motion, dirty files, busy
Git operations, empty chats, capability loss, workspace/host switching and restart.
Use the repository's `testing-aiden-agent-e2e` skill for the implementation's
Electron tests. Inspect native clients if shared data/contracts change; the shell
alone is desktop-local, while the Context data work retains its mobile obligations.

## Spike result

The redesign is feasible using existing service ownership. The largest risk is
terminal/native-browser presentation lifecycle, not the launcher layout. Proceed
with the tab foundation first, then prove placement and native-view behavior in
isolated slices. The original spike was source-only. The subsequent approved implementation
retains one stable terminal surface host and integrates authoritative browser
page IDs into the panel strip.


## Delivered implementation

- Launcher, bounded persisted singleton tool tabs, browser page tabs, overflow,
  keyboard navigation and Context entry points are implemented.
- Terminal placement moves one portal host, preserving the existing Ghostty
  canvas and PTYs. Electron verifies shell variables, prior output and split
  panes survive side/bottom moves and closing/reopening the tool tab.
- Context reuses saved `AssistantTurnStatsV1` totals (including tool-loop calls)
  rather than adding storage. It labels recorded-turn coverage; session reasoning
  and cost are unavailable because renderer-safe complete totals are not retained.
- Appearance persists the independent, default-on composer-meter preference.
- Existing onboarding Files/Terminal tiles explain discovery and placement, using
  their existing dedicated illustrations. No new capability tile is advertised.
- No shared Remote or native transcript/activity contract changed. iOS and Android
  retain their own appearance/navigation; this renderer-only inspector does not
  add remote inspection or terminal authority.
- Focused unit suites, terminal docking, browser integration and narrow-window
  titlebar acceptance pass. Final verification details are recorded below.

## Verification record

- Root and E2E TypeScript checks, production build, scoped ESLint and diff
  whitespace checks pass. React Doctor reports no errors (four advisory warnings).
- Focused acceptance: 151 renderer/command/onboarding/context cases, 155 browser
  cases and 58 settings-design cases pass. Earlier focused terminal/browser
  cases also pass. New Electron tests are registered as `test:e2e:workspace-panel`
  and included by normal CI discovery.
- Electron covers launcher activation/deduplication/last-tab closure, responsive
  layout without covering the composer, keyboard navigation, terminal canvas and
  shell continuity across placements/splits, hidden-meter inspection and restart,
  and actual native browser visibility. Existing browser automation, profiles,
  recording, focus, Git-busy guards, terminal and capability-gating cases pass.
- The broader 39-case run had 36 passes, one platform skip and two shutdown
  failures after assertions completed in `chat-shell-interactions.spec.ts`:
  “chat shell keeps local interactions isolated and keyboard-accessible” and
  “workspace access arrows move focus and explicit keys commit”. Both passed
  their single isolated rerun, but the intermittent shutdown problem remains
  open. See `/tmp/aiden-panel-e2e3.log` and `/tmp/aiden-panel-e2e-final.log`.
- The later Context restart case also encountered the existing 35-second
  shutdown bound during `aiden.relaunch()`. Its UI behavior and restart succeeded
  in earlier runs. No timeout/retry relaxation or shutdown implementation change
  was made; causality is unproven. Its single isolated rerun passed, alongside
  the final launcher/composer-layout check (2/2, `/tmp/aiden-panel-e2e-confirm.log`).
  Record these flakes if opening a PR.

The feature is desktop-local: no server, Remote protocol, storage DTO or native
transcript/activity changes were needed. Mobile runtime suites were therefore
not applicable. Raw-message export, separate file-document tabs, drag docking,
new-page/side-chat tools and suggested sites remain outside this delivery.
