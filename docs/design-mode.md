# Design mode

Design mode puts an infinite canvas beside a chat. Aiden designs screens as HTML pages under `design/`, places them on the canvas, and checks each one as it writes it. The canvas belongs to the workspace, and each chat has its own page on it. Turn it on with the Design button, ⇧⌘L or `/design`, or let Aiden ask when a request is visual.

Design mode v2 (the live app canvas) is being built behind experimental flags. Its spec is [`docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md`](superpowers/specs/2026-11-23-design-mode-live-app-design.md).

## DESIGN.md (experimental)

Aiden can treat an app's `DESIGN.md` as its design system's source of truth. `DESIGN.md` is Google Labs' open format: Markdown with YAML design tokens (colours, typography, spacing, corner radii, components) and prose sections.

**Turning it on.** Start Aiden with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`. Design mode must also be on (it is by default). With the flag off, nothing here runs.

**Where Aiden looks.** For each app in the workspace, Aiden looks for a file named exactly `DESIGN.md`:
- first in the app's folder, then in each folder above it, up to the workspace root;
- or at the file that `.aiden/canvas.json` names for that app, for example `{"version": 1, "apps": [{"root": "apps/web", "designMd": "design/system.md"}]}`. If that file is missing, Aiden says so instead of looking elsewhere.

Files outside the workspace, including symlinks that point out of it, are refused, and so is a `DESIGN.md` that is, or links to, a file Aiden keeps from the model, such as `.env`, `.npmrc` or a key.

**What Aiden does with it.**
- The canvas note tells Aiden which `DESIGN.md` each app uses and how many errors and warnings it has. `canvas_read` includes the same line.
- Aiden's `design_system` tool reads the tokens and sections, lists the findings, exports Tailwind, DTCG or CSS-variable output, or drafts a starter file from the app's own styles.
- When an app has no `DESIGN.md`, Aiden asks once (per workspace and app) whether to draft one, and writes the draft only after you say yes, with its ordinary file approvals. If the first such app was offered before, the next one without a `DESIGN.md` is.
- When a design change adds or alters a token, Aiden updates `DESIGN.md` in the same turn, through the same approvals, and checks it again.

**What the checks cover.** Aiden bundles `@google/design.md` 0.4.0 and runs its linter offline, in a separate worker, with a 2-second limit per check. A check that runs out of time is tried again after five minutes; if the linter can't load within 10 seconds, Aiden stops trying until it restarts. The canvas note waits at most 3 seconds for these checks and otherwise goes without the `DESIGN.md` line. Files over 64 KiB aren't checked, and an export over 64 KiB isn't shown. Version 0.4.0 doesn't know a `motion` token group or the Motion and Voice & Content Strategy sections, and doesn't resolve `@file#fragment` references. Aiden adds two warnings of its own: a section that appears twice, and a token reference to a group that doesn't resolve.

**Privacy.** The file, its tokens and its findings stay on your device. Nothing is sent anywhere. Usage data records only that a check ran (with bucketed error and warning counts) and that a draft was written, never the file or its contents. See [analytics](analytics.md).

## Live apps (experimental)

With live apps, design mode runs your workspace's own web app so the canvas can show it. This first part (Phase 2b) runs the dev server; showing the app on the canvas comes with the next phases.

**Turning it on.** Start Aiden with `AIDEN_EXPERIMENTAL_DESIGN_LIVE=1`. Live apps run on macOS and Linux only. With the flag off, nothing here runs.

**Starting the app.** When you turn design mode on in a chat, Aiden finds the workspace's web app (Next.js, React Router, Remix, TanStack Start, Nuxt, Angular, Astro, Gatsby, Create React App, TanStack Router or Vite) and shows a **Run app?** card above the composer. The card shows the exact command, the install command when one will run, the text of every script that runs, and the names of the config, rc and workspace files the start reads. Every line break in a script is marked with ↵, and a run of blank lines or spaces shows as its count, so no line hides below another. When the details are long they scroll inside the card, and **Allow** and **Not now** stay on screen. When several apps ask at once, each gets its own card. Nothing runs until you choose **Allow**. **Not now** starts nothing. Aiden can also start, stop, restart or read the app's output with its `design_app` tool, which asks on the same card. It runs only the app's own dev script, and at most four starts per reply. A chat without write access to the workspace can't start it. When design mode turns on with several chosen apps, they start together.

**When the card comes back.** Aiden remembers what you approved. The card comes back, as **Run app again?**, when a script, an install lifecycle script, the package manager, a lockfile, an rc or workspace file, or a framework config changes, and before an install that wasn't approved yet.

**Installs.** When the app has no `node_modules`, or Aiden's own last install didn't finish or is out of date, Aiden installs the dependencies first with the app's package manager (npm, pnpm, Yarn or Bun) from your package registry. Installing runs your dependencies' install scripts, which the card says. Aiden never installs over dependencies you installed yourself, and never installs in a parent folder: when the lockfile is outside the workspace, install there yourself, then start the app again. When the app has no lockfile, the install writes one. That lockfile is the only change, so the card doesn't come back for it.

**Only on this computer.** The app runs at `http://127.0.0.1:<port>`. Aiden checks every socket the server's processes open, and stops a server that listens beyond this computer. To fix that, remove `--host` from the dev script. Remix 3's starter ignores the host and port Aiden passes: make its `server.ts` listen on `process.env.PORT` at `process.env.HOST`.

**Environment.** The server runs with your shell's environment, minus your AI provider keys, Aiden's own `AIDEN_*` variables, npm's `npm_*` and `npm_config_*` variables, `NODE_ENV`, `ELECTRON_*` and `INIT_CWD`. An app that needs a key reads it from its own `.env`. Aiden also turns off framework telemetry (`NEXT_TELEMETRY_DISABLED`, `ASTRO_TELEMETRY_DISABLED`, `NUXT_TELEMETRY_DISABLED`, `GATSBY_TELEMETRY_DISABLED`, `NG_CLI_ANALYTICS=false` and `DO_NOT_TRACK`) unless you set those yourself.

**When it stops.** The server stops 60 seconds after no canvas for its workspace is on screen: you left design mode, the stacked layout shows the Chat pane, or the window is minimized or hidden. A window behind other windows still counts as on screen. It also stops when the workspace's folder or access changes, when it doesn't start listening within two minutes of quiet (ten minutes at most), and when it listens beyond this computer. Aiden never restarts it on its own; a crash shows a short notice and the server's own output stays in its log. When the server stops or crashes, Aiden also stops the processes it started, including ones that left its process group. After Aiden quits unexpectedly, the next launch stops what the last run left behind, found by a marker in each process's environment. On macOS, `ps` can't read that marker for Apple's own programs (such as `sleep`), so one of those left behind by a crash keeps running.

**Monorepos.** In a workspace with several web apps, you (or Aiden, through the same card) choose which app runs. The choice is saved as `script` in `.aiden/canvas.json`'s `apps`, for example `{"version": 1, "apps": [{"root": "apps/web", "script": "dev"}]}`, so you choose once. If Aiden can't save the choice (the file is a link, unreadable, or written by a newer Aiden), the app doesn't start. Choosing an app that is already running restarts it through the choose card.

**Privacy.** The app's folder, scripts, port and output stay on your device. Usage data records only which framework and package manager an app used and whether it ran. See [analytics](analytics.md).
