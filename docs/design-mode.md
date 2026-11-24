# Design mode

Design mode puts an infinite canvas beside a chat. Aiden designs screens as HTML pages under `design/`, places them on the canvas, and checks each one as it writes it. The canvas belongs to the workspace, and each chat has its own page on it. Turn it on with the Design button, ⇧⌘L or `/design`, or let Aiden ask when a request is visual.

Design mode v2 (the live app canvas) is being built behind experimental flags. Its spec is [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](superpowers/specs/2026-11-23-design-mode-live-app-design.md).

## DESIGN.md (experimental)

Aiden can treat an app's `DESIGN.md` as its design system's source of truth. `DESIGN.md` is Google Labs' open format: Markdown with YAML design tokens (colours, typography, spacing, corner radii, components) and prose sections.

**Turning it on.** Start Aiden with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`. Design mode must also be on (it is by default). With the flag off, nothing here runs.

**Where Aiden looks.** For each app in the workspace, Aiden looks for a file named exactly `DESIGN.md`:
- first in the app's folder, then in each folder above it, up to the workspace root;
- or at the file that `.aiden/canvas.json` names for that app, for example `{"version": 1, "apps": [{"root": "apps/web", "designMd": "design/system.md"}]}`. If that file is missing, Aiden says so instead of looking elsewhere.

Files outside the workspace, including symlinks that point out of it, are refused.

**What Aiden does with it.**
- The canvas note tells Aiden which `DESIGN.md` each app uses and how many errors and warnings it has. `canvas_read` includes the same line.
- Aiden's `design_system` tool reads the tokens and sections, lists the findings, exports Tailwind, DTCG or CSS-variable output, or drafts a starter file from the app's own styles.
- When an app has no `DESIGN.md`, Aiden asks once (per workspace and app) whether to draft one, and writes the draft only after you say yes, with its ordinary file approvals.
- When a design change adds or alters a token, Aiden updates `DESIGN.md` in the same turn, through the same approvals, and checks it again.

**What the checks cover.** Aiden bundles `@google/design.md` 0.4.0 and runs its linter offline, in a separate worker, with a 2-second limit per check. Files over 64 KiB aren't checked. Version 0.4.0 doesn't know a `motion` token group or the Motion and Voice & Content Strategy sections, and doesn't resolve `@file#fragment` references. Aiden adds two warnings of its own: a section that appears twice, and a token reference to a group that doesn't resolve.

**Privacy.** The file, its tokens and its findings stay on your device. Nothing is sent anywhere. Usage data records only that a check ran (with bucketed error and warning counts) and that a draft was written, never the file or its contents. See [analytics](analytics.md).
