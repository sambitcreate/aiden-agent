# UI SDK lessons for the renderer

Written 2026-11-19 after a six-agent read of the Vercel Labs UI SDK (`@ui-sdk/core`, beta). The decision is to copy its behavior patterns into Aiden's renderer and keep Radix, cmdk and sonner. Moving to the SDK itself would be a large, high-risk change to a pre-stable dependency.

All work lands in one PR, one commit per unit. An Opus review agent checks each unit for correctness, leanness, efficiency and blast radius before it is committed.

## Units

| # | Unit | Lessons | Status |
| - | ---- | ------- | ------ |
| 1 | Shared layer stack and IME-safe Escape | One stack for Escape and outside-press, replacing the DOM sniffs for open dialogs; one dismiss-key helper that ignores composing and already-handled events | Built, in review: `layer-stack.ts` and `dismiss-key.ts` replace every open-dialog DOM sniff and the ad hoc Escape listeners; outside-press planning is left for a concrete bug |
| 2 | Focus return and tooltip warm window | Focus return tries candidates and skips hidden or inert targets; one root tooltip provider with a skip-delay window | Built, in review: `focus-return.ts` backs Dialog, AlertDialog, the compact sidebar, the terminal, the approval card and the subagent pill, with the message box as fallback; the root tooltip provider sets 300 ms plus a 400 ms warm window, and restored focus no longer opens a tooltip |
| 3 | Picker matching | Accent-folded, word-start-ranked matching with highlighted segments in the command palette, model picker and slash palette; chat dates leave the search keywords | Built, in review: `text-match.ts` ranks and marks matches in the palette and model picker (cmdk no longer filters) and marks slash titles, which now scroll only their list and ignore composing keys |
| 4 | Long pickers | Filtering outside cmdk with a capped or windowed result list for the model picker and the palette's chats | Planned |
| 5 | Motion tokens and presence | Literal curves and durations become motion tokens; reduced motion follows the in-app setting everywhere; exit animations finish before unmount instead of fixed timers | Planned |
| 6 | Shared resize handle | One hook for the workbench, design chat and terminal dividers: modifier guard, Enter collapse, RTL, a 3px drag threshold | Planned |
| 7 | Keyboard reordering | A grab, move, drop and cancel draft model with announcements for quick-view cards and design layers | Built, in review: `reorder-draft.ts` gives Quick View cards and Layers rows a Space-to-pick-up grip with arrow, Home and End moves, one commit per drop, Escape or blur to restore and assertive announcements; Layers drag is pointer-based with a 3px threshold, edge auto-scroll and Escape, and `⌥↑`/`⌥↓` stay as an alias |
| 8 | Chat list as a collection | One tab stop, arrow keys and typeahead, range selection with a bulk bar, focus recovery when a focused row is removed | Planned |
| 9 | Accessibility gate | axe and ARIA snapshot Playwright checks for Settings, the composer, dialogs and the palette | Built, in review: `tests/e2e/accessibility.spec.ts` runs WCAG A/AA axe and a small ARIA snapshot on the chat window, model picker, command palette, a confirm dialog and Settings (Providers, Appearance), with a shrinking exclusion list in `tests/e2e/axe-gate.ts` that starts at two entries |
| 10 | Design-rule lint | A whole-repo check for the AGENTS.md and GUI.md rules, plus a shrinking allowlist for the remaining source-grep tests | Built, in review: `scripts/check-aiden-rules.mjs` checks six rules over the whole repo in about 2 s against a ratcheting allowlist that seeds 97 source-grep tests. |
| 11 | Component sink | A development-only page that renders every shared primitive in every state across presets and both schemes | Built, in review: `component-sink.html` (served only by the dev server, `npm run dev:sink`, never a build input) shows every component exported by the shared UI modules with a preset and Light/Dark toolbar, and a test fails when a new export has no case |
| 12 | Mentions in the composer | `@` opens a picker; picks become atomic chips | Planned |
