# Aiden server (`aiden`)

A headless Aiden server for macOS and Linux. Run `aiden serve` on a box you reach over SSH (a home server, a spare Mac, a cloud VM) and use it from the Aiden On The Go apps on iPhone, iPad and Android, or from a paired Mac. The server runs chats, Bots, scheduled tasks and Telegram; your devices are the interface.

There is no interactive terminal app. Since 2026-10-30, `aiden` has only `serve` and short admin commands for setting the server up (see [the serve-only plan](../../docs/plans/aiden-serve-only-cli.md)). Pi's terminal UI, `aiden -p` print mode, `--mode json|rpc`, `--list-models`, slash commands, themes and the first-run tour are gone. Bare `aiden` prints the command list; the old flags (`-p`, `--mode`, `--tui-mode`, `--theme`, `--list-models`) exit with an error that points to `aiden serve` and `aiden help`.

Built on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, MIT, pinned `1.4.0`, the same line the Aiden desktop app uses). The server uses Pi's SDK for its chat sessions and bundles the desktop's own `main/services` cores for Bots, scheduling, Remote, MCP, memory and web search.

## Requirements

- macOS or Linux (x64 or arm64).
- Node.js 22.19 or newer. Keep Node on the newest release of its line: the server's network calls run on the installed Node, and the October 21, 2026 Node.js security release (22.23.4, 24.22.1, 26.12.1) fixed a Brotli decoder flaw and HTTPS hostname-check bypasses that any older Node still has.
- `openssl` on the `PATH`: the first `aiden serve` uses it to create the server's TLS identity for paired devices.
- `git`, and for Tailscale pairing the Tailscale CLI on the host.

## Install from a clone

The server is not published to npm or attached to desktop releases; build it from a clone of this repository.

```bash
git clone https://github.com/sambitcreate/aiden-agent.git
cd aiden-agent
npm ci --ignore-scripts   # root install; the bundle compiles shared code from main/ and renderer/
npm run cli:install       # installs packages/cli's own lockfile
npm run cli:build         # bundles packages/cli/dist/app/
cd packages/cli && npm link
aiden --version           # 0.1.0
```

The root install is required: without it the build fails with `Could not resolve "@earendil-works/pi-ai"` and similar errors. In a clone you also use for desktop development, run the usual `npm ci` (with install scripts) instead: `--ignore-scripts` reinstalls the root `node_modules` without the desktop's postinstall patches and Electron download.

`npm link` puts `aiden` on your `PATH` and points it at this checkout, so `git pull` plus `npm run cli:build` (from the repository root) updates it. Remove the link with `npm uninstall -g aiden-cli`. If npm's global folder is not writable (Node from the nodejs.org installer uses `/usr/local`), both `npm link` and the uninstall need `sudo`, or install Node with Homebrew. Without the link, run `./packages/cli/dist/app/cli.js` instead of `aiden`.

`aiden --version` prints the server package version (`0.1.0`), which is separate from the desktop app's version.

## First-time setup

Every setup step is a short command you run once over SSH.

1. **Sign in to a model provider.** `aiden auth login <provider>` prints a browser URL or device code to open on any device, or asks for an API key and validates it. `aiden auth list` shows what is configured; standard provider environment variables also work. `aiden auth login openai` supports Sign in with ChatGPT; Anthropic supports its browser and copy-code flows.
2. **Add a workspace.** `aiden workspace add /absolute/project`, then `aiden workspace access <id> full|ask|none`. Ask mode needs one approval per tool call from a paired device; unattended Telegram and scheduled runs need Full access.
3. **Optionally, connectors and providers.** `aiden mcp presets` and `aiden mcp preset <id>` add MCP connectors from the desktop's catalog, `aiden mcp login <id>` signs in, and `aiden provider import <models.json>` adds custom OpenAI-compatible, Ollama or LM Studio providers.

## Running the server

```bash
aiden serve
```

`aiden serve` starts the server in the foreground: the scheduler, configured Telegram polling, Bots and Remote, the authenticated HTTPS/SSE API that phones and Macs use (port 49320 by default). Remote is on by default; `aiden serve --no-remote` runs without it (`--remote` is still accepted).

When `aiden serve` runs in the foreground in an interactive terminal, it prints a pairing QR code and manual code at startup, so you can scan it from the phone app right away. It pairs over the local network by default (over Tailscale when the server is set to Tailscale only, `remote mode tailscale`); `--pair tailscale` pairs over Tailscale instead, and `--no-pair` skips the code. No code is printed under `--daemon` or when output is not a terminal (a log, a pipe, a service manager), because the code is a single-use secret.

| Command | What it does |
| --- | --- |
| `aiden serve` | Run in the foreground; Ctrl-C stops it after active work settles |
| `aiden serve --daemon` | Run in the background, logging to `<agentDir>/serve.log` |
| `aiden serve status` | Report the running server's PID and control socket |
| `aiden serve stop` | Stop the running server |
| `aiden remote pair lan\|tailscale` | Open a new ~5-minute pairing window and print its QR and manual code |
| `aiden remote pair-status`, `remote pair-cancel <session-id>` | Inspect or cancel the pairing window |
| `aiden remote devices`, `remote revoke <id>` | List or revoke paired devices |
| `aiden remote roots`, `remote approve-root <path>` | Folders that paired devices may open |

`remote` and `bots` commands talk to the running server over its control socket and fail if it is not running. `schedule` and `workspace` commands also work without the server, through a one-shot lease. `telegram status` works anytime; `telegram connect|configure|disable|disconnect` take the server's lease, so stop `aiden serve` before changing Telegram configuration.

**Pairing over the local network.** The pairing code carries the endpoint `https://<hostname>.local:<port>/api/aiden/v1`, and the phone apps connect only to that exact endpoint. LAN pairing therefore works only when `<hostname>.local` resolves on the phone's network, which needs an mDNS responder on the server: on Linux, `sudo apt install avahi-daemon avahi-utils` and `sudo systemctl enable --now avahi-daemon` (macOS has one built in). The server also uses `avahi-publish-service` to advertise itself so phones can find it. If that tool is missing, the server warns at startup but keeps running, and pairing still works when another responder answers for the name. If the tool exits (usually because avahi-daemon is not running, as when a service starts before it at boot), the server warns once that the name may not resolve and tries again every 30 seconds, so discovery comes up once avahi-daemon does. In either case, pair over Tailscale when the name can't be made to resolve.

**Pairing over Tailscale.** `aiden serve --pair tailscale` and `aiden remote pair tailscale` set Tailscale up on first use: they check that Tailscale is installed, signed in and has HTTPS certificates, add Tailscale next to LAN (`remote mode both`), connect the server's own Tailscale Serve route at `/api/aiden/v1`, and wait (for up to 45 seconds) until the server's Tailscale address answers before opening the pairing window. That first request makes Tailscale fetch the HTTPS certificate for a new name, which both the pairing step and the phone's first connection need, so neither stalls on it; if the address doesn't answer in time, the window still opens with a pointer to `aiden remote check`. Stopping the server ends the wait at once. They never replace a Serve route they don't own. When the server can't finish the setup, the error names the next step: install Tailscale, run `sudo tailscale up`, turn on HTTPS certificates for the tailnet, run `sudo tailscale set --operator=$USER`, turn off a Funnel on port 443, review and take over a stale route left by another Aiden install (`aiden remote mode both`, then `aiden remote tailscale-review`, then `aiden remote tailscale-takeover <token>`), or check an unfinished route change (`aiden remote tailscale-reconcile`). If the route can't be connected, the server switches back to LAN-only mode.

**Checking reachability.** `aiden remote check` lists every step between a phone and this server, with ✓, ✗, ! or – and the fix for each one that fails. It covers whether Tailscale is installed and signed in, whether HTTPS certificates are on, whether this Linux user may change Serve settings (`sudo tailscale set --operator=$USER`), whether a public Funnel is on port 443, and whether an exit node without local network access could cut off phones on the same Wi-Fi. It then shows the running server's local network address, whether Aiden's Tailscale route is connected, and whether its Tailscale address really answers. On a cloud server (one that answers at the cloud metadata address 169.254.169.254) it warns that phones can't reach it over a local network. It exits non-zero when a step the server uses fails; a server on the local network only is not failed for a missing Tailscale.

Each lease holds an OS lock on a permanent `*.lease.lock` guard. Process death releases the lock; owner JSON is diagnostic and stale metadata is cleaned only under the guard. Never delete or replace guard files. Stop old `aiden` processes and daemons before upgrading a shared agent directory, because old binaries do not use this guard. Each server needs its own agent directory.

## Running the server as a service

```bash
aiden service install
```

`aiden service install` keeps the server running after you close the SSH session and starts it again after a reboot. It looks at this machine first, shows whether Tailscale is ready (or the one step it still needs), and asks who should be able to reach the server:

1. **Local network only:** phones on the same Wi-Fi or LAN. Pairing needs `<hostname>.local` to resolve, as described under Pairing over the local network.
2. **Tailscale only:** your devices from anywhere on your tailnet. The install sets Tailscale up the same way `aiden remote pair tailscale` does, and the local network listener stops answering.
3. **Both.**

The suggested answer is Tailscale only on a cloud server (where phones can't reach a local network), Both when Tailscale is ready, and Local network only otherwise. Pass `--network local|tailscale|both` to skip the question; without a terminal the install uses the suggested answer when Tailscale is ready, and `local` otherwise. A reinstall without `--network` keeps a server that already uses Tailscale on its current network instead of asking. If Tailscale can't be set up, the install says what to do next and keeps the server on the network it had. Once the server is running, the install shows a pairing code in the terminal; `--no-pair` skips it, and Ctrl-C closes the code and stops waiting without stopping the server.

- **Linux** gets a systemd user unit, `~/.config/systemd/user/aiden.service`, that runs `aiden serve --no-pair`. It turns on lingering (`loginctl enable-linger`) so the server starts at boot without a login; when that needs root, it tells you to run `sudo loginctl enable-linger $USER` once. Run the install as the server's user over SSH (not through `su` or `sudo`), because systemd user services need that user's session. Logs: `journalctl --user -u aiden`.
- **macOS** gets a LaunchAgent, `~/Library/LaunchAgents/com.sambitcreate.aiden-agent.serve.plist`, that runs while you are logged in. On a Mac without a screen, turn on automatic login. Logs go to `<agentDir>/serve.log`.

The service runs the built `dist/app/cli.js` of this checkout with the current Node, `PATH` and agent directory, so run `aiden service install` again after moving the checkout or changing Node. A server already started with `aiden serve` or `--daemon` is stopped first, so the service can take it over. If the install fails, a service that was already installed is put back, a first install whose server never starts is removed, and a server it stopped is named with the command to start it again. When the chosen network can't be set up, the install says which network really reaches the server (Tailscale counts only while its route is connected), or that none does yet.

| Command | What it does |
| --- | --- |
| `aiden service install [--network local\|tailscale\|both] [--no-pair]` | Install (or reinstall) and start the service |
| `aiden service status` | Whether the service is installed and running, and where its logs are |
| `aiden service uninstall` | Stop the service and remove it, first taking down Aiden's Tailscale Serve route (through the server, or through Tailscale directly when the server is already stopped; a route that is no longer Aiden's is left alone with the command to remove it by hand) |
| `aiden remote network local\|tailscale\|both` | Change who can reach a running server; Tailscale is set up for you |

`aiden serve stop` stops the server without removing the service; it starts again at the next boot or login.

## What paired devices get

Phones and Macs paired with the server see its workspaces, chats, Bots, scheduled tasks and files. Chats run on the server through Pi's SDK with a headless tool set: workspace tools under the workspace's access tier, memory, todo, MCP, web search, advisor, and artifact export (HTML visuals are written to `<agentDir>/artifacts` and the path is returned). Image display in the terminal and `ask_user_question` are not available on the server. Server sessions don't load codemode and declare MCP tools directly.

- **Forks.** Paired phones fork server chats with the Remote `chat-fork-v1` feature; the fork's journal is seeded from the copied visible messages, so tool results before the cut are not carried. The server does not offer Fork with summary (`chat-fork-summary-v1`).
- **Desktop limits.** The server does not serve the host feed or live runs, so paired desktops cannot list its chats.
- **Scheduled-run notifications.** Run completions show up through `aiden schedule runs <id>`, `aiden schedule notifications` and, for tasks with `notify`, local notifications on paired phones via the Remote `scheduled-tasks/notifications` feed.

## Bots

`aiden serve` hosts Bots with managed homes, exact Custom grants, MCP, skills, web search, companion vision and uploaded photos. Bot subagents perform read-only investigations within the admitted file scopes. Bot fires are saved before schedule advancement and reconciled by Pi request ID after a restart; failed Bot runs record a failure kind.

- `aiden bots list|get|catalog|notice|acknowledge|create|update|access` use the shared notice, revision and capability contracts.
- `aiden bots pause <id>` and `bots unpause <id>` pause a Bot as a whole: running turns stop and new ones, including manual routine runs, are refused until it is unpaused.
- **Durable Bot sessions** are an explicit profile switch: run `aiden bots enable-durable`, then restart the server. The switch privately backs up legacy Bot chats and journals, leaves their originals intact, and starts fresh durable conversations. Send/Resume/Dismiss, memory edits, routines, presets and approvals reuse the desktop cores; `bots session|send|resume|dismiss|stop|delete|approvals|approve` drive them. Until the switch is enabled, paired desktops cannot list the server's Bots and phones use them through the older workspace chat routes. See [durable Bot ownership, migration, recovery and feature boundaries](../../docs/cli-durable-bots.md).
- Not on the server yet: hand-offs, `sign_in`, Bot rules and Bot computers (desktop-only), and the desktop's routine retries, auto-pause, pre-fire checks, "Needs you" cards, quiet hours, follow-ups, event routines and learning (lessons, skill proposals, tidying). Home-folder skills of a server-hosted Bot load only when approved, which the server cannot do yet.

## Scheduled tasks

`aiden schedule save <file>` validates and saves a schedule; `schedule list`, `preview <cron> [timezone]`, `status`, `runs`, `notifications [since-ms]`, `run`, `pause`, `resume` and `remove <id>` inspect and control it. `schedule status` reports the next run, overdue task IDs and pending Bot fires. Schedules keep their own read-only/Full tool selection and exact MCP connection bindings.

Server chats have no schedule tool, so the model can't create or change schedules. Manage them with the `aiden schedule` commands or from a paired app.

## MCP connectors

`aiden-mcp.json` and the `aiden mcp` commands are the server's only MCP configuration. Pi's native `mcp.json` (`mcpServers` object) and its plaintext `mcp-auth.json` are never read and native servers are not started; native entries are not migrated, so add them again with `aiden mcp add`. An older Aiden array configuration in `mcp.json` still migrates to `aiden-mcp.json`, with an exact private backup in `mcp.pre-pi-1.json`. The source inode is retained under a private `.mcp-migration-*/mcp.json` recovery directory so concurrent writers cannot lose their data. A native object configuration is never migrated or overwritten, and conflicting legacy/new Aiden inventories stop with a reconciliation error.

`aiden mcp presets`, `mcp preset <id>`, `mcp add <file>`, `mcp login <id>`, `mcp logout <id>`, `mcp list` and `mcp remove <id>` configure connectors. `mcp presets` lists the desktop's connector catalog (`renderer/shared/connector-catalog.ts`) except connectors served by a Mac app (iMCP), which are set up in the desktop app on a Mac; a connector marked unavailable there (hosted Figma) is refused by `mcp preset`, as is `imcp`, and `figma-desktop` connects to the Figma desktop app's local server without a sign-in. The server runs the desktop's MCP client, transports and OAuth provider (`main/services`, on `@earendil-works/pi-mcp`). Tool schemas are paginated, bounded and rechecked before execution; failed servers do not silently gain tools.

`mcp login` prints the sign-in URL to stderr; sign-ins are stored in the encrypted `credentials/insights.json`. An OAuth server without a stored sign-in is never contacted (no MCP request, discovery or registration) until `mcp login`; background connections refresh stored tokens but never register or open a browser.

- **Client identity:** dynamic registration as "Aiden Agent", registered afresh on every `mcp login`; or, for custom servers, a pre-registered client with `oauthClientId` and optional `oauthClientSecret` in the server JSON. `mcp add` moves the secret into the encrypted credential store and keeps only an opaque marker in `aiden-mcp.json`; `mcp list` never prints it, and a plaintext secret written into `aiden-mcp.json` by hand is refused until the server is added again. Client ID Metadata Documents follow the desktop (off until Aiden hosts the document).
- **Redirect URI:** a dynamically registered client listens on a random free loopback port (`http://127.0.0.1:<port>/callback`), because each sign-in registers its own redirect URI. A pre-registered client (or a metadata document) uses the desktop's fixed `http://127.0.0.1:41390/callback`; register exactly that URI with the provider. On a remote box, open the sign-in URL in a browser that can reach that loopback port (for example through an SSH port forward). MCP sign-ins saved by earlier CLI builds (before the shared provider) are not migrated: run `aiden mcp login <id>` again.

## Command reference

`aiden help` (or bare `aiden`) prints the full list; `serve` comes first.

| Command | Purpose |
| --- | --- |
| `serve [--no-remote] [--daemon] [--pair lan\|tailscale] [--no-pair]`, `serve stop\|status` | Run, background, inspect or stop the server |
| `service install [--network local\|tailscale\|both] [--no-pair]\|uninstall\|status` | Run the server at login and boot (systemd or launchd) |
| `remote status\|devices\|pair lan\|tailscale\|pair-status\|pair-cancel <id>\|revoke <id>\|roots\|approve-root <path>` | Pairing and paired-device administration (server must be running) |
| `remote network local\|tailscale\|both` | Who can reach the server; Tailscale is set up for you (server must be running) |
| `remote check` | Check each step a phone needs to reach the server, with fixes |
| `auth list\|login\|logout` | Provider credentials (OAuth or API key) |
| `workspace list\|add\|remove\|access\|scratch` | Workspace registry and tool access tiers |
| `mcp list\|presets\|add\|preset\|login\|logout\|remove` | MCP connectors and their OAuth sign-ins |
| `provider list\|import <models.json>` | Custom OpenAI-compatible, Ollama or LM Studio providers |
| `catalog refresh\|models-dev fetch\|models-dev status` | Inference catalog refresh; models.dev is an explicit display-only fetch |
| `insights aa\|openrouter show\|fetch\|disconnect` | Benchmark data, fetched only on request |
| `web-search show\|import <settings.json>` | Web Search provider routing; keys from environment variables |
| `schedule list\|save\|preview\|status\|runs\|notifications\|run\|pause\|resume\|remove` | Scheduled tasks |
| `bots …`, `bots enable-durable` | Bot administration (server must be running) |
| `telegram status\|connect\|configure <file>\|disable\|disconnect` | Telegram bridge |
| `speech status\|download\|select\|delete <id>\|transcribe <pcm16-file> <model-id>` | On-device transcription models used by Remote dictation |
| `search <query>`, `import <file>`, `export <session.jsonl> [output]` | Find, import and export conversations |
| `files list\|read`, `git status\|review\|branches\|worktrees`, `worktree list\|create\|remove` | Workspace files, Git and managed worktrees |
| `app help [query]\|status\|get <topic>\|set <control> <value> <revision> [operation-id]` | Product help; shows Memory, Web Search and Skills settings and changes Memory and Web Search (Skills are read-only on the server) |
| `help`, `--version` | Command list and version |

Notes:

- `import` copies a desktop journal or `.aiden-chat.json` export into a new journal; never point the desktop and the server at the same writable journal.
- `git`, `files` and `worktree` use the shared workspace and Git services; managed removal uses the bundled native helper.
- `speech download`, `select`, `delete` and `transcribe` are explicit actions. Optional `sherpa-onnx-node` runs in a worker. Setup and ordinary status reads never download weights.
- `app set` takes the revision returned by `app get`; retry an uncertain request with the same operation ID. Agent tool calls on the server cannot change app preferences. `appControlPolicy` in `aiden.json` (`disabled`, `ask` or `safe`) limits app controls further.

## Credentials

`auth.json` is encrypted with an owner-private local wrapping key; legacy plaintext entries migrate atomically on first access. Keep the whole agent directory private: this protects against accidental disclosure of the credential file, but does not provide OS-keychain protection against someone who can read the wrapping key. MCP OAuth and benchmark keys have separate credential namespaces.

## Where state lives

| Path | Contents |
| --- | --- |
| `~/.aiden/agent/` | Server state: `settings.json`, `auth.json`, `aiden.json` (device-local feature settings), `aiden-mcp.json`, `web-search.json`, `remote.json` (Remote identity and paired devices), `schedules.json`, `sessions/`, `bots/`, `bot-service/`, `artifacts/`, `credentials/`, `serve.log` and the private control socket |
| `~/.aiden/` | Shared Aiden home (the desktop's portable `config.json`, `skills/`, `scripts/`; `memory/` is the shared desktop and server memory store, `ws-<folder-hash>` scopes) |
| `AIDEN_CODING_AGENT_DIR` | Environment override for the agent directory (mirrors Pi's `PI_CODING_AGENT_DIR`; use it for tests and for running more than one server) |

## Privacy and network

- **No telemetry.** The server ships without Pi telemetry, enforced three ways: the entry forces `PI_TELEMETRY=0` (which gates both the pi.dev `report-install` ping and Pi's attribution headers, and overrides settings), the settings default is off, and the build patches the ping's call sites and endpoint out of the bundle, asserted by `tests/bundle.test.mjs`. The shared desktop runtime and durable Bots, which don't read that switch, set their own request identity with no attribution (`main/services/pi-client-identity.ts`). The entry also turns off pi.dev's version feed (`PI_SKIP_VERSION_CHECK=1`, overridable), because this package versions independently.
- **Manual-only catalogs.** models.dev, Artificial Analysis and OpenRouter benchmark data are fetched only by the explicit `aiden catalog models-dev fetch` and `aiden insights aa|openrouter fetch` commands, never on startup or in the background, and the fetched data is display-only. Speech models download only with `aiden speech download`.
- **Remote.** Paired devices authenticate to the server's own TLS identity. Tailscale is used only after you choose it for pairing.

## Linux container

Build from the repository root (requires Docker):

```bash
docker build -f packages/cli/Dockerfile -t aiden-cli:local .
docker volume create aiden-state
docker run --rm -it -v aiden-state:/home/node/.aiden \
  -v "$PWD:/workspace" aiden-cli:local
```

The default command is `serve`; append another command (for example `auth login <provider>` or `help`) to run it instead. The image runs as the unprivileged `node` user. Mounted workspace permissions must permit that user to read and write according to the selected access tier. Use a dedicated volume per server. Configure and pair Remote before publishing its port (49320 by default); mounting the Docker socket is unnecessary. Tailscale routing and LAN mDNS discovery depend on host networking and are best configured on the host. Inside a container the server advertises the container's own hostname, which phones usually can't resolve, so LAN pairing from Docker is untested; running `aiden serve` directly on the host is the tested path.

The build prefers architecture-verified prebuilt helpers from `prebuilt/native/<target>` (darwin-universal, linux-x64, linux-arm64; regenerate with `node scripts/build-native-helpers.mjs`, optionally `--docker linux/amd64 linux/arm64` for cross-targets) or a directory named by `AIDEN_NATIVE_PREBUILT_DIR`, so installing on a supported platform needs no C toolchain; it compiles from `native/` only when no matching prebuilt exists. macOS builds use Xcode Command Line Tools; Linux source builds use a C17 compiler and OpenSSL development headers. Windows native helper support is outside this implementation. No model catalogs, credentials, speech weights or private history are fetched into the image.

## How the rebrand works

Pi reads its identity (`APP_NAME`, config dir, env var names) from the `package.json` nearest its running code. The build bundles Pi's code into `dist/app/cli.js` and writes a generated `dist/app/package.json` with `piConfig: { name: "aiden", configDir: ".aiden" }`. That is the whole rebrand mechanism, and `tests/bundle.test.mjs` pins it. The bundle script is a port of Pi's own `build-coding-agent-bundle.mjs` (same externals and lazy-loader emission); runtime externals resolve from this package's `node_modules`.

`scripts/patch-branding.mjs` (run inside every build) rewrites Pi's installed dist so server chats use a system prompt that says "operating inside Aiden". The shipped bundle is asserted Pi-free by `tests/bundle.test.mjs`.

## Development

```
packages/cli/
  src/cli.ts            # entry: static --version/help answers, then the command runtime
  src/commands.ts       # admin command dispatch
  src/serve.ts          # the server: scheduler, Telegram, Bots, Remote, control socket
  scripts/build.mjs     # esbuild bundle + asset vendoring + app-root package.json
  tests/                # bundle structure, runtime, parity suites
  dist/app/             # build output, a self-contained app root (gitignored)
```

From this directory, after the root install: `npm install && npm run build`. `npm test` builds nothing; run `npm run build` first, because the tests exercise the built bundle. From the repository root, `npm run test:cli` installs, builds and tests in one step.

History: the CLI started as a rebranded Pi terminal app ([`docs/plans/aiden-cli-plan.md`](../../docs/plans/aiden-cli-plan.md), [parity checklist](../../docs/plans/aiden-cli-parity-checklist.md)) and became serve-only on 2026-10-30 ([`docs/plans/aiden-serve-only-cli.md`](../../docs/plans/aiden-serve-only-cli.md)).
