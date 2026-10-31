# Aiden CLI becomes a serve-only headless server

Status: **In review** (2026-10-30).

Supersedes the interactive parts of [the Aiden CLI plan](aiden-cli-plan.md) and its [parity checklist](aiden-cli-parity-checklist.md), which stay as history. User guide: [`packages/cli/README.md`](../../packages/cli/README.md).

## Why

The owner does not want to maintain a full interactive CLI that people use as a terminal app. The `aiden` package exists so Aiden can run on a headless box (a home server, a spare Mac, a cloud VM reached over SSH) and serve client devices: the iPhone, iPad and Android apps and paired Macs. Those clients are the interface; the server only needs to run, pair and be administered.

The model is a serve-only server command, like T3 Code's `t3 serve`: no terminal UI, a pairing QR or code printed at startup, and short admin commands (`pair`, `project add`, `auth`).

Keeping Pi's terminal app also carried cost the server doesn't need: generated terminal themes and their fidelity test, a separate appearance playground package and CI job, interactive-only extensions (wordmark, slash commands, widgets, dictation in the terminal) and the flags and settings around them.

## What was removed

- Pi's interactive TUI, `aiden -p` print mode, `--mode json|rpc` and `--list-models` (all reached through Pi's `main()` fallthrough in `src/cli-runtime.ts`), plus the fullscreen and codemode default helpers.
- Interactive-only extensions: the wordmark and startup animation, ask-user-question UI, display-image, `/btw`, the usage widget and `/usage`, `/voice` and `/dictate`, the slash-argument editor, session-parity slash commands, `/help-aiden`, `/aiden-app` and `/aiden-settings`, the first-run onboarding and feature tour, workflow commands, `/subagents`, the interactive schedule-tool consent, the todo widget, and the `/models` and `/mcp` slash commands.
- `selfcheck`.
- Terminal theming: `theme.ts`, `aiden theme import|export`, `aiden reset`, the `appearance` topic of `aiden app`, `scripts/generate-themes.ts` and the generated `packages/cli/themes/` (and the AGENTS.md rule about them).
- The interactive-header part of `scripts/patch-branding.mjs`. The system-prompt identity patch stays, because server chats use Pi's prompt.
- `packages/cli-playground` (the CLI appearance studio), its `cli:playground*` and `test:cli-playground` scripts, ESLint ignores and the `cli-playground` CI job.

Bare `aiden` prints the command list (with `serve` first). The old flags (`-p`, `--mode`, `--tui-mode`, `--theme`, `--list-models`) and unknown flags exit non-zero with one line saying the interactive CLI was removed and pointing to `aiden serve` and `aiden help`.

## What stays

- `aiden serve` and everything it runs: server chats through Pi's SDK (`createAgentSession`), Bots and durable Bots, the scheduler, Remote HTTPS/SSE and pairing, Telegram (unchanged), MCP, memory, web search, advisor, artifact export and subagents.
- Admin commands: `auth`, `workspace`, `mcp`, `provider`, `schedule`, `bots`, `remote`, `telegram`, `speech`, `catalog`, `web-search`, `insights`, `search`, `import`, `export`, `files`, `git`, `worktree`, `app` (help; status and get for Memory, Web Search and Skills; set for Memory and Web Search, since Skills are read-only on the server), `serve stop|status`, `help` and `--version`.
- `extensions/aiden-settings.ts`, which is a settings reader used by app controls, web search and memory scope, not a UI.
- `@earendil-works/pi-coding-agent` as a dependency at the exact desktop pin (1.4.0); the server uses its SDK.
- The bundle layout and rebrand contract (`dist/app/cli.js` plus the generated `dist/app/package.json`), the no-telemetry enforcement, and the manual-only network posture for models.dev, Artificial Analysis and OpenRouter benchmark data.

## New serve behavior

- **Remote on by default.** `aiden serve` starts the Remote API. `--no-remote` turns it off; `--remote` is still accepted.
- **Pairing at startup.** In a foreground interactive terminal, `aiden serve` prints a pairing QR code and manual code once the server is ready. It pairs over the local network by default, or over Tailscale when the server serves only over Tailscale; `--pair tailscale` pairs over Tailscale and `--no-pair` skips it. Tailscale pairing sets up the transport on first use: it adds Tailscale to the connection mode and connects the server's own Serve route through the existing ownership-safe operations. It never replaces a route it doesn't own, and each setup failure names the exact command to run. LAN pairing needs `<hostname>.local` to resolve on the phone's network. A missing or exiting `avahi-publish-service` logs a warning that says so, and Remote keeps running.
- **No secret in logs.** No pairing code is printed under `--daemon` or when output is not a terminal. `aiden remote pair lan|tailscale` still opens a new pairing window against a running server.
- `serve --daemon`, `serve status` and `serve stop` keep their behavior.

## Deferred

- **Service install.** An `aiden service install` (or similar) that writes a launchd or systemd unit so the server starts at boot. Until then, people run their own unit with `aiden serve --no-pair`, or `aiden serve --daemon`.
- **Setup from a client.** Signing in to providers, adding workspaces and connectors from the phone or Mac app after pairing, instead of typed commands over SSH.
- **Distribution.** An installer or an npm publish. The server is built from a clone (`npm ci --ignore-scripts`, `npm run cli:install`, `npm run cli:build`, `npm link`).

## Testing

- Behavioral CLI tests: bare `aiden` and `aiden help` print the command list; the removed flags exit non-zero with the retirement message; `serve` flag parsing (`--no-remote`, `--pair`, `--no-pair`) and the startup pairing rule (foreground TTY only).
- Existing bundle, runtime and parity suites keep covering the rebrand, no-telemetry, daemon chats, Bots, Remote and scheduling.
- CI drops the playground job; `cli-linux` stays required.

## Docs

Updated with this change: `packages/cli/README.md` (now a server guide), `README.md`, `AGENTS.md`, `docs/linux.md`, the plan index, dated notes in `aiden-cli-plan.md`, `aiden-cli-parity-checklist.md` and `completed/cli-appearance-playground.md`, and `.memory/aiden-cli-standalone.md`. Plans that describe a CLI TUI surface (app knowledge actions, chat controls research, Pi 1 parity) are history for the CLI part; the server has no TUI to target.
