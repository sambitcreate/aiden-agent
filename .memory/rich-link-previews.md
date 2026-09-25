# Rich link previews — 2026-09-25

- Baseline: `origin/main` at `7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62`; branch `feature/rich-link-previews-plan`.
- Regular Chat and Bot message bubbles opt into URL-derived rich links for GitHub, GitLab, Google Drive/Docs/Sheets/Slides, SharePoint/OneDrive, Box, Notion, Slack, Teams, and Outlook. Other Markdown surfaces keep their prior generic anchors.
- User HTTP(S) text is tokenized without changing stored or copied content; URLs inside backtick code spans and fences stay literal. Persisted and streaming assistant Markdown use the same component. Every trigger remains an anchor, so existing Aiden Browser and external-navigation handling stays authoritative.
- Hover and keyboard focus show a compact card; Escape closes it. Screen readers receive provider/resource context. The card uses semantic tokens, collision-aware placement, a narrow-window width bound, and no link-level layout box that would prevent wrapping.
- Classification is synchronous and local. Display metadata omits credentials, queries, fragments, Google/OneDrive/Box opaque identifiers, and Slack timestamps. Host matching rejects suffix attacks and nondefault ports, generated labels are bounded, and malformed links fall back safely.
- A message mounts at most 50 rich preview triggers. A shared message budget preserves that bound across the streaming reveal's multiple Markdown trees.
- No network, IPC, connector, persistence, schema, transcript, Bot runtime, main-process, iOS, or Android contract changed.
- Validation: focused rich-link/transcript suite 40/40; Bot suite 451/451; Chat/slash-command suite passed; TypeScript, ESLint, CI policy, production build, and `git diff --check` passed. Packaged-app, pointer/keyboard visual, assistive-technology, and physical-device acceptance remain separate.
