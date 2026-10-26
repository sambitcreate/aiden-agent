# iMCP Mac app connector — 2026-10-26

Base origin/main `d6feb7b9` (v0.61.0). Branch `claude/project-thread-6xmghf`. The owner asked for iMCP (https://github.com/mattt/iMCP, MIT, macOS 15.3+) as a built-in, Mac-only connector.

How it works: the catalog gains a second entry shape, a Mac app connector (`macApp` in `renderer/shared/connector-catalog.ts`), alongside the HTTP presets. Main turns it into a stdio preset whose only allowed command is `<Applications>/iMCP.app/Contents/MacOS/imcp-server` in `/Applications` or `~/Applications`, with no arguments or env (`assertMacAppPresetServer` in `main/services/mcp-presets.ts`). `main/services/mcp-mac-apps.ts` finds the installed copy (server executable plus `CFBundleIdentifier` `co.dododo.iMCP`, read with `/usr/bin/plutil`), checks it is running (`/usr/bin/pgrep -x iMCP`) and opens it (`/usr/bin/open`) only when the person presses Open. Probes are injected, so tests run on Linux.

Decisions:
- Aiden never bundles, installs, updates, auto-opens or quits iMCP. It is a separate signed app with its own privacy permissions and Sparkle updates; quitting it is the person's off switch.
- iMCP approves clients by MCP `clientInfo.name`, so every desktop MCP client now uses `AIDEN_MCP_CLIENT_NAME` ("aiden-agent") and iMCP asks once.
- A closed iMCP fails fast in `resolveMcpConnectionCredentials` (after launch approval) instead of waiting out the connect deadline, because `imcp-server` keeps waiting for the app over Bonjour.
- Saving from the setup dialog approves exactly the shown command (`approveLaunch: true`).
- Mac only: `macAppConnectors` host capability (darwin); hidden on Linux, excluded from Bot connection suggestions (Bots can run off the Mac, phones have no card for it) and from the CLI preset list.
- No code-signature check of the bundle yet (possible hardening).

Not verified on a real Mac from the cloud container: the owner needs to install iMCP, set it up in Settings → Connectors and accept iMCP's "Allow aiden-agent" prompt and the Local Network prompt for imcp-server.

Review round 1 (Pullfrog, 2026-10-26): Manage → Save and the dialog's switch dropped the saved `exposure`/`hiddenTools` (main's parser stores absent fields as cleared). Fixed in the iMCP dialog. The HTTP preset dialog (`mcp-preset-setup.tsx` `build()`) has the same pre-existing gap; offered to the owner as a follow-up, not fixed in #590.
