# Compact chat top bar — 2026-10-08

Claude-desktop-style top bar (owner request). Keeps Aiden's radii (16px squircle `--radius-button`) and the 52px header height (traffic lights stay centred at `trafficLightPosition` y 20).

## Shape
- `Button variant="bar"` (ui.tsx): transparent at rest, `list-hover` on hover, `list-selection` while `aria-pressed`/`aria-expanded`. Used at `size="small"` (28px) for every window-header action: chat, Remote chat, Bot chat header, Environment/Quick View toggles, Open-in-editor picker. `variant="toolbar"` (glass) remains only for floating actions (bot message actions).
- Leading cluster: `SplitView.SidebarToggle` now portals the toggle plus its `children` into the anchor at `left-[90px]`; chat and Settings sidebars pass `<HistoryNavButtons/>` (Go back / Go forward over the router's memory history; availability from `location.state.__TSR_index` vs `history.length`). The toggle keeps `aria-pressed` but suppresses the pressed fill. Collapsed headers pad by `SPLIT_VIEW_COLLAPSED_HEADER_INSET` (190), shared by `ScrollArea` and `StudioSurface`. No keyboard shortcuts for back/forward yet (Cmd+[ conflicts with editor outdent; would need registry commands).
- `ScrollArea` gained `titleAccessory` (rendered after the `h1`, outside it).
- `renderer/components/chat-top-bar.tsx`: `ChatTitleMenu` (Rename…, Duplicate chat → `copyChat()`, Copy title; drafts show plain text), `WorkspaceChip` (name + menu: path, branch or "Not a Git repository"/"No folder", Show in Finder, Open in terminal, Open on GitHub, copy path/branch), `WorkspaceToolButtons` (Terminal, Changes, Browser, Device, Files | Quick View, Environment, editor | ⋯ with Context/Subagents).
- Non-Git safety: Changes hidden unless `git.isRepo`; Files hidden without a folder and disabled when permission is `none`; branch/GitHub items only for repos. GitHub link only for `github.com/owner/name` canonical keys (`renderer/lib/workspace-chip.ts`); repository identity is read lazily when the chip menu opens. Opening the chip menu invalidates `queryKeys.git(id)` so a fresh `git init`/branch switch shows without the 60s poll.
- Tool buttons fold into ⋯ below a 600px toolbar (ResizeObserver on `[data-toolbar]`); chip hides below 560px (container query) and never shrinks below its content (`shrink-0 max-w-44`).
- Floating Environment panel now always starts at `top-14` (was `top-3` when there was room) so it never covers the top bar, matching Quick View.

## Tests
- `tests/e2e/chat-top-bar.spec.ts`: plain folder, Git repo with GitHub remote, folder-less workspace, rename via title menu, back/forward, collapsed-header clearance (replaced the `142` source grep in `chat-sidebar.test.tsx`).
- `renderer/lib/workspace-chip.test.ts` (test:serial + ci-test-registry).
