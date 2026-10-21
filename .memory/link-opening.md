# Link opening

- One router: `renderer/lib/browser-link-routing.ts` (`resolveLinkOpen`), driven by `LinkOpenerProvider` (`renderer/lib/link-opener.tsx`) mounted in `EnvironmentPanelProvider`.
- Preference `BrowserDefaults.linkOpening` = ask | browser | external (default ask), stored in the browser service JSON; legacy `linkTarget: "external"` migrates to external, anything else to ask.
- Loopback always opens in Aiden; Cmd/Ctrl flips; no visible panel (Settings, Bots, Studio, remote, onboarding) → system browser; `data-link-target="external"` forces external; aiden-ui and restricted Markdown always prompt without remember (system browser only when no panel).
- Panel availability = `useBrowserSurface(!suppressed)` in `EnvironmentWorkbench`.
- IPC: `browser:link-preference`, `browser:set-link-preference`, `browser:open-external` (validated by `externalUrl` in `main/services/browser/core.ts`, shared with the main-window guard).
- `open_link` reuses a same-URL tab and emits `show`; in-app failures fall back to the system browser with a toast.
- Inside the Aiden browser, target=_blank opens a new tab with the opener's profile (same-tab at the 24-tab limit; external when the preference is external).
- Spec/plan: docs/superpowers/specs|plans/2026-10-15-link-opening*.
- Local file links (2026-10-21, thread "Chat file links in Aiden Browser"): the router returns `{ kind: "file", path, preview, workspacePath }` for relative/absolute paths, `file://` URLs and `name.ext:12`; line suffixes are dropped. HTML/PDF go to `open_file` in the Aiden browser; other files/folders go to `onOpenWorkspaceFile` (EnvironmentPanel `openFile`), and FilesPanel expands a requested folder instead of reading it. Paths outside the workspace toast. `markdown.tsx` passes a `urlTransform` that keeps `file:` and `name.ext:12` hrefs (react-markdown's default blanked them, which made agent file links dead). `/settings`-style absolute paths with no extension outside the workspace are still left to the app.
