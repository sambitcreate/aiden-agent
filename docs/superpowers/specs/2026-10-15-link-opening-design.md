# Link opening: ask once, then remember

Status: approved direction (2026-10-15, Option B). Plan: [implementation plan](../plans/2026-10-15-link-opening.md).

## Problem

Clicking a link in Aiden opens it in the Aiden browser, in the system browser, or nowhere visible. Which one happens depends on the surface and route, and it isn't predictable. An audit of `main` at `f1f416c2a` found:

- One global click listener (`renderer/lib/use-browser-links.ts`) sends `http(s)` anchors to the Aiden browser by default (`BrowserDefaults.linkTarget = "browser"`). It only runs while a workspace exists. With no workspace, the same link opens externally.
- On Settings, Bots, Studio and remote-host routes the browser panel is hidden or not mounted, so a link creates a tab nobody sees.
- PR chips, "Open on GitHub" and aiden-ui visual links call `window.open`, which means always external, ignoring the setting.
- Cmd/Ctrl-click always means external; it is not a toggle. A failed in-app open (tab limit, missing owner window) shows an error toast and opens nothing.
- Every click creates a new tab, even for a URL that is already open.
- Inside the Aiden browser, `target=_blank` replaces the current page.
- Settings "Open sign-in page" links open in the Aiden browser while the automatic auth flows open externally.
- The only control for this is in the browser panel's own settings sheet; Settings has nothing.
- Terminal links use the terminal session's workspace; every other link uses the sidebar's active workspace.

Comparable apps: T3 Code has one "Open links in" setting (system by default), Cmd/Ctrl-click to force external, a right-click menu and fallback to external. OpenCode always opens chat links externally. VS Code prompts and keeps a trusted-domain list. None of them prompts on the first click with a remembered choice.

## Decision

1. **Preference.** `BrowserDefaults.linkOpening: "ask" | "browser" | "external"` replaces `linkTarget`. The default is `"ask"`.
   - Migration: a saved `linkTarget: "external"` becomes `"external"`.
   - Any other or missing value becomes `"ask"`. The old default `"browser"` was never a choice the user made, so they get the first-click prompt.
2. **One router** decides every user link click: chat Markdown, user bubbles, rich links, PR chips, "Open on GitHub", aiden-ui visuals, terminal links, and plain anchors anywhere in the app. Its rules, in order:
   1. **Href classes.**
      - `http(s)` with a hostname is a web link.
      - `mailto:` always goes to the system browser.
      - A relative `.html`/`.htm`/`.pdf` opens as a workspace file preview in the Aiden browser, but only when the panel can show. Otherwise the router ignores it (prod behavior unchanged).
      - Any other href is ignored, so the app's own navigation keeps working.
   2. **Explicitly external.** An anchor marked `data-link-target="external"` (auth/sign-in links) goes to the system browser with no prompt.
   3. **Panel can't show** (no workspace, or the route hides or doesn't mount the browser workbench: Settings, Bots, Studio, remote host, onboarding) → system browser, no prompt.
   4. **Base target.**
      - Loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`) → Aiden browser.
      - Everything else → the preference.
   5. **Cmd/Ctrl-click** flips the base target without prompting:
      - base `browser` → system;
      - base `external` → Aiden;
      - base `ask` → system.
   6. **Prompt.** A base of `ask` shows the prompt.
   7. **Always-prompt surfaces.** Model-generated visual links (aiden-ui and restricted Markdown) always show the prompt, without the remember checkbox, so they keep their "ask the owner" safety. This applies even where the panel can't show; there the prompt offers only the system browser.
3. **First-click prompt.** It's an in-app `Dialog`:
   - Title "Open this link?", the host as the description, and the full URL.
   - Buttons: **Open in Aiden browser** (confirm) and **Open in system browser** (secondary), plus a **Copy link** action.
   - A **Remember my choice** checkbox, checked by default, with the hint "You can change this in Settings → Links."
   - Escape or an outside click opens nothing.
   - Choosing while the box is checked saves the matching preference.
4. **Settings → Links.** A new App-group destination with one row, "Open links in", offering:
   - Ask each time
   - Aiden browser
   - System browser

   The row's description notes that local dev servers always open in Aiden and that ⌘-click opens the other one. The browser panel's settings sheet offers the same three options.
5. **Opening in Aiden** brings the tab forward through the existing `show` event.
   - It reuses an open tab with the same URL in that workspace instead of making a new one.
   - If the in-app open fails, it falls back to the system browser and shows a toast saying so.
6. **Inside the Aiden browser,** `target=_blank`/Cmd-click opens a new Aiden tab with the opener's profile. If the preference is `external`, it opens in the system browser. At the tab limit it loads in the same tab, as today. Feature-bearing `window.open` OAuth popups are unchanged.
7. **Right-click on a web or mailto link** in the app UI opens a menu:
   - Open in Aiden browser (web only, disabled when the panel can't show)
   - Open in system browser
   - Copy link
8. **Main-process IPC**, all under the existing `browser:` prefix:
   - `browser:link-preference` reads the preference.
   - `browser:set-link-preference` writes it.
   - `browser:open-external` validates the URL (`http`/`https`/`mailto` only, no credentials) and calls `shell.openExternal`.

   None of these needs a workspace. The `open_link` command loses `alternateTarget` and always means "open in the Aiden browser".

## Non-goals

- Per-domain trust lists.
- An onboarding step. The first-click prompt is the moment of introduction, and onboarding stays unchanged.
- Cmd-click on file links to reveal them in Finder.
- `mailto:` from pages inside the Aiden browser (still blocked).
- Changes to mobile clients. iOS and Android keep using the system browser, and the Remote protocol is unchanged.
- The CLI.
- Moving the other browser defaults into Settings.

## Acceptance

- With a fresh profile, the first chat link click shows the prompt. Choosing Aiden with Remember checked opens the panel tab. The next click opens directly with no prompt, and a second click on the same URL reuses the tab.
- A `localhost:5173` link opens in the Aiden browser with no prompt, whatever the preference.
- Links on Settings and Bots open in the system browser with no prompt and no hidden tab.
- Cmd-click flips the destination and never prompts.
- An aiden-ui visual link always prompts, with no remember checkbox.
- Settings → Links shows and changes the preference, and the change survives a relaunch.
