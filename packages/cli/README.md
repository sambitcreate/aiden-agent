# Aiden CLI

A headless Aiden Agent: the full pi coding agent TUI, rebranded and themed as Aiden, deployable on macOS and Linux with Node.js ≥ 22.19, including servers with no display. Keep Node.js on the newest release of its line: the CLI's network calls run on the installed Node, and the October 21, 2026 Node.js security release (22.23.4, 24.22.1, 26.12.1) fixed a Brotli decoder flaw and HTTPS hostname-check bypasses that any older Node still has.

Built on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, MIT, pinned `1.3.0` — the same line the Aiden desktop app uses). Until the next Pi release, both builds also apply a backport of Pi's [#11142](https://github.com/earendil-works/pi/pull/11142) to pi-ai 1.3.0 (`patches/pi-ai-1.3.0-responses-tool-cache.patch`, applied by `scripts/patch-pi-ai-tool-cache.mjs`), so OpenAI Responses, Codex and Azure models keep their prompt cache when the tool set changes. The desktop's `renderer/shared/appearance.ts` is the single source of truth for the terminal palettes.

## Build and run

```bash
npm run cli:install   # from the repo root; installs this package's own lockfile
npm run cli:build     # generates themes + bundles dist/app/
./packages/cli/dist/app/cli.js          # the `aiden` TUI
```

Or from this directory: `npm install && npm run build`. During development, `npm test` builds nothing — run `npm run build` first (tests exercise the built bundle).

## Modes

| Command | What it does |
| --- | --- |
| `aiden` | Fullscreen alt-screen TUI (pi's TUI: editor, markdown, diffs, themes, sessions, `/` commands, autocomplete). The Aiden default — switch back per-run with `--tui-mode regular` or persistently via `/config` |
| `aiden -p "…"` | One-shot print mode; also automatic when stdin/stdout are not TTYs |
| `aiden --mode json` | Structured event stream for tooling |
| `aiden --mode rpc` | JSONL request/response + event protocol over stdio for embedding (see pi's `docs/rpc.md`, vendored into the bundle) |
| `aiden --list-models`, `aiden --help`, `aiden --version` | Metadata commands |

Credentials use `aiden auth login <provider>` (printed browser/device-code OAuth or validated API keys), the native `/login` command, or standard provider environment variables. `auth.json` is encrypted with an owner-private local wrapping key; legacy plaintext entries migrate atomically on first access. Keep the whole agent directory private: this protects against accidental disclosure of the credential file, but does not provide OS-keychain protection against someone who can read the wrapping key. MCP OAuth and benchmark keys have separate credential namespaces.

## Aiden features in the terminal

The CLI bundles Aiden's own extension cores (imported from `main/services/` — the same code the desktop runs) behind pi's extension API:

| Feature | Tool / command | Terminal surface |
| --- | --- | --- |
| Ask User Question | `ask_user_question` | Sequential selects per question; multi-select accumulates; Escape cancels (rendered by any RPC GUI client too) |
| Todo | `todo` | Durable journal-replayed task graph + live widget above the editor (statuses, blockers, progress count) |
| Memory | `recall_memory`, `remember_fact` | Per-workspace SQLite facts shared with the desktop at `~/.aiden/memory` (`ws-<folder-hash>` scopes); toggle with `memoryEnabled` in `aiden.json` |
| Web Search | `web_search` | Aiden's provider router; anonymous Exa default-on, more providers via `<PROVIDER>_API_KEY` env vars |
| Visuals | `render_artifact`, `render_ui` | HTML visuals export to a standalone file; native catalog visuals print as their plain-text rendering |
| Display Image | `display_image` | Inline images in the TUI (Kitty/iTerm2 protocols); copies archived under `<agentDir>/artifacts` |
| Advisor | `advisor` | One tool-free second opinion per response via Aiden's AdvisorRuntime (bundled from `main/services`); reviewer picked through Ask User Question when unnamed |
| btw | `/btw <question>` | Bounded read-only side question about the conversation, with ephemeral session-scoped follow-ups |
| Usage | `/usage` | Session totals plus a source-attributed durable usage ledger |
| Voice | `/voice`, `/dictate` | Transcription provider settings (`gemini`/`openai`/`off`, persisted to `aiden.json`); dictation records via `sox`/`ffmpeg` and inserts the transcript into the editor. On-device transcription models are available through `aiden speech` and Remote; desktop global-hotkey dictation remains desktop-only |

New Memory databases support bounded incremental space reclamation on open and close. Existing databases keep their format. See [SQLite storage maintenance](../../docs/sqlite-storage.md).

Settings for these live in `~/.aiden/agent/aiden.json` (device-local; shapes mirror the desktop's `AppSettings` subsets).

## Pi 1.0 capabilities

The CLI includes Pi 1.0's codemode, deferred tool search, image generation and classifier model APIs, virtual-model extensions, provider stream events, richer themes, and session/HTML export improvements. Enable codemode with `"defaultTools": ["+codemode"]` in settings, or pass `--tools read,bash,edit,write,codemode`. Its JavaScript sandbox batches calls through the same workspace approval hooks as direct tools; revoking workspace access also blocks subsequent nested calls. Image generation and classification use explicitly configured provider credentials and contribute usage to the session.

`aiden-mcp.json` and the `aiden mcp` commands (also `/mcp` inside a session) are the CLI's only MCP configuration. Pi's built-in MCP extension is turned off: `aiden` always passes Pi's `--no-mcp`, and Aiden's extension registers its own `/mcp`, so Pi's native `mcp.json` (`mcpServers` object) and its plaintext `mcp-auth.json` are never read and native servers are not started. Native entries are not migrated; add them again with `aiden mcp add`. An older Aiden array configuration in `mcp.json` still migrates to `aiden-mcp.json`, with an exact private backup in `mcp.pre-pi-1.json`. The source inode is retained under a private `.mcp-migration-*/mcp.json` recovery directory so concurrent writers cannot lose their data. A native object configuration is never migrated or overwritten, and conflicting legacy/new Aiden inventories stop with a reconciliation error.

`aiden auth login openai` and native `/login` share the installation identity in global settings for Sign in with ChatGPT. Legacy OpenAI Codex credentials continue to work. Anthropic supports its browser and copy-code login flows.

Daemon and delegated worker sessions retain Aiden's bounded extension inventories; enabling native interactive capabilities does not grant them additional tools.

## No telemetry

The CLI ships without pi telemetry, enforced three ways: the entry forces `PI_TELEMETRY=0` (which gates both the pi.dev `report-install` ping and pi's attribution headers, and overrides settings), the settings default is flipped off, and the build patches the ping's call sites and endpoint out of the bundle — asserted by `tests/bundle.test.mjs`.

## Where state lives

| Path | Contents |
| --- | --- |
| `~/.aiden/agent/` | CLI state: `settings.json`, `auth.json`, `models-store.json`, `sessions/`, `extensions/`, `skills/`, `themes/` |
| `~/.aiden/` | Shared Aiden home (desktop's portable `config.json`, `skills/`, `scripts/`; `memory/` is the shared desktop+CLI store; the CLI adds only the `agent/` subtree otherwise) |
| `<project>/.aiden/` | Project-local settings, extensions, skills, themes, prompts (gated by project trust) |

The CLI also discovers `~/.aiden/skills` and `~/.claude/skills` as user skills, plus `<session cwd>/.claude/skills` after Pi approves that project. Home skills remain user skills when launched from home. `--no-skills` (`-ns`) disables automatic discovery in every root; `--no-approve` (`-na`) refuses project skills while retaining user skills. A path supplied by the user with `--skill <path>` remains an explicit exception to both flags.
| `AIDEN_CODING_AGENT_DIR` | Env override for the agent dir (mirrors pi's `PI_CODING_AGENT_DIR`; required for tests and multi-instance setups) |

## Theming

Eight Aiden presets ship as built-ins — Aiden, Slate, Berry, Moss × light/dark — and pi's own palettes are deliberately not shipped. The Aiden dark/light palettes replace pi's stock `dark`/`light`, so terminal background auto-detection lands on Aiden by default. The native `system` theme is also available to follow the terminal palette. Switch with `--use-theme <name>`, the `/theme` command, or first-run setup.

Regenerate the theme JSONs after changing `renderer/shared/appearance.ts`:

```bash
npm run themes   # in packages/cli — a fidelity test fails if committed files drift
```

## How the rebrand works

pi reads its identity (`APP_NAME`, config dir, env var names) from the `package.json` nearest its running code. The build bundles pi's code into `dist/app/cli.js` and writes a generated `dist/app/package.json` with `piConfig: { name: "aiden", configDir: ".aiden" }` — that is the entire rebrand mechanism, and `tests/bundle.test.mjs` pins it. The bundle script is a port of pi's own `build-coding-agent-bundle.mjs` (same externals and lazy-loader emission); runtime externals (`jiti`, `photon-node`) resolve from this package's `node_modules`.

The entry (`src/cli.ts`) disables pi.dev's version feed (`PI_SKIP_VERSION_CHECK=1`, overridable) because this CLI versions independently, registers the bundled theme presets through pi's public `--theme` flag, and defaults the TUI to pi's fullscreen alt-screen renderer — an explicit `--tui-mode` flag or any `tuiMode` saved in settings (e.g. via `/config`) always wins over that default.

The native `quietStartup: "header"` setting is the default, keeping the Aiden header while hiding loaded-resource details. Set it to `false` or pass `--verbose` to show details.

Because the CLI is a rebrand, not stock pi: `scripts/patch-branding.mjs` (run inside every build) rewrites pi's installed dist so the agent identifies as Aiden — the startup header's Pi self-promotion line is removed, and the system prompt says "operating inside Aiden". The shipped bundle is asserted Pi-free by `tests/bundle.test.mjs`.

## Layout

```
packages/cli/
  src/cli.ts                # entry: env setup, theme injection, main()
  scripts/generate-themes.ts # emits pi-format themes from appearance.ts
  scripts/build.mjs          # esbuild bundle + asset vendoring + app-root package.json
  themes/                    # generated, committed (builtin/ = dark.json, light.json)
  tests/                     # bundle structure, runtime smoke, theme fidelity
  dist/app/                  # build output — self-contained app root (gitignored)
```

Aiden feature parity landed in phases (todo, btw, advisor, memory, subagents, `aiden serve`, remote access); see [`docs/plans/aiden-cli-plan.md`](../../docs/plans/aiden-cli-plan.md) for the history and [`docs/plans/aiden-cli-parity-checklist.md`](../../docs/plans/aiden-cli-parity-checklist.md) for current status.


## Workspaces, automation, and Remote

`aiden --help` lists the complete command surface. Register a directory with
`aiden workspace add /absolute/project`, then use `aiden workspace access <id> full|ask|none`.
Ask mode requires one approval per tool call; unattended Telegram and schedule execution
require explicit Full workspace access. Schedules also retain their own read-only/Full tool
selection and exact MCP connection bindings.

- `/search`, `/name`, `/attach`, `/export-aiden`, `aiden import`, and `aiden export` manage conversations. Imports copy into new journals; never point desktop and CLI at the same writable journal.
- pi's built-in `/fork` starts a new session from an earlier prompt, and `/tree` switches between branches of the current session. For daemon chats, paired phones fork with the Remote `chat-fork-v1` feature: the fork's journal is seeded from the copied visible messages, so tool results before the cut are not carried. The daemon does not offer Fork with summary (`chat-fork-summary-v1`).
- `aiden git`, `aiden files`, and `aiden worktree` use the shared workspace and Git services. Managed removal uses the bundled native helper.
- `aiden provider import <models.json>` configures custom compatible providers. `aiden catalog refresh` refreshes inference catalogs. `catalog models-dev fetch` and `insights aa|openrouter fetch` are explicit display-only network actions.
- `aiden mcp presets`, `mcp preset <id>`, `mcp add <file>`, `mcp login <id>` and `mcp logout <id>` configure MCP connectors. `mcp presets` lists the desktop's connector catalog (`renderer/shared/connector-catalog.ts`); a connector marked unavailable there (hosted Figma) is refused by `mcp preset`, and `figma-desktop` connects to the Figma desktop app's local server without a sign-in. The CLI runs the desktop's MCP client, transports and OAuth provider (`main/services`, on `@earendil-works/pi-mcp`). Tool schemas are paginated, bounded, and rechecked before execution; failed servers do not silently gain tools. `mcp login` prints the sign-in URL to stderr; sign-ins are stored in the encrypted `credentials/insights.json`. An OAuth server without a stored sign-in is never contacted (no MCP request, discovery or registration) until `mcp login`; background connections refresh stored tokens but never register or open a browser.
  - **Client identity:** dynamic registration as "Aiden Agent", registered afresh on every `mcp login`; or, for custom servers, a pre-registered client with `oauthClientId` and optional `oauthClientSecret` in the server JSON. `mcp add` moves the secret into the encrypted credential store and keeps only an opaque marker in `aiden-mcp.json`; `mcp list` never prints it, and a plaintext secret written into `aiden-mcp.json` by hand is refused until the server is added again. Client ID Metadata Documents follow the desktop (off until Aiden hosts the document).
  - **Redirect URI:** a dynamically registered client listens on a random free loopback port (`http://127.0.0.1:<port>/callback`), because each sign-in registers its own redirect URI. A pre-registered client (or a metadata document) uses the desktop's fixed `http://127.0.0.1:41390/callback`; register exactly that URI with the provider. MCP sign-ins saved by earlier CLI builds (before the shared provider) are not migrated: run `aiden mcp login <id>` again.
- `aiden schedule save <file>` validates a schedule; `schedule preview`, `status`, `runs`, `notifications`, `run`, `pause`, and `resume` inspect/control it. `schedule status` reports the next run, overdue task IDs, and pending Bot fires. `aiden serve` owns the scheduler, configured Telegram polling, and Bot runtime. `schedule` and `workspace` commands work without the daemon via a one-shot lease; `bots` and `remote` management commands require `aiden serve` already running and fail if it is not. `telegram status` works anytime; `telegram connect|configure|disable|disconnect` take the serve lease, so stop `aiden serve` before changing Telegram configuration. Run completions surface through `aiden schedule runs <id>`, `aiden schedule notifications`, and — for tasks with `notify` — local notifications on paired phones via the Remote `scheduled-tasks/notifications` feed. Bot fires are saved before schedule advancement and reconciled by Pi request ID after a daemon restart.
- `aiden serve --daemon [--remote]` runs the daemon in the background (logs to `<agentDir>/serve.log`); `aiden serve status` reports PID/socket and `aiden serve stop` shuts it down. Each lease holds an OS lock on a permanent `*.lease.lock` guard. Process death releases the lock; owner JSON is diagnostic and stale metadata is cleaned only under the guard. Never delete or replace guard files. Stop old CLI processes and daemons before upgrading a shared agent directory because old binaries do not use this guard.
- `aiden serve --remote` additionally exposes the shared authenticated HTTPS/SSE API. `aiden remote pair lan|tailscale` renders a scannable terminal QR plus the manual code; `remote pair-status`/`remote pair-cancel <session-id>` manage the ~5-minute pairing window, and `remote devices`, `remote revoke <id>`, `remote approve-root <path>` administer pairing state. Tailscale requires its CLI on the host and an explicit pairing action. The daemon does not serve the host feed or live runs, so paired desktops cannot list its chats. Until the durable switch below is enabled, paired desktops cannot list its Bots either and phones use them through the older workspace chat routes; once it is enabled, both use its durable Bot sessions (not yet accepted on physically paired devices). Sessions created through the daemon (Remote, Telegram, Bot replies) run the headless-safe extension set — memory, todo, MCP, web search, advisor, and artifact export; image display and ask-user-question remain interactive-TUI only.
- Durable Bot sessions are an explicit profile switch: run `aiden bots enable-durable`, then restart the daemon. The switch privately backs up legacy Bot chats and journals, leaves their originals intact, and starts fresh durable conversations. Send/Resume/Dismiss, memory edits, routines, presets, and approvals reuse the desktop cores. See [durable Bot ownership, migration, recovery, and feature boundaries](../../docs/cli-durable-bots.md).
- `aiden bots notice`, `acknowledge`, `catalog`, `create`, and `access` use the shared notice/revision/capability contracts. `aiden bots pause <id>` and `bots unpause <id>` pause a Bot as a whole through the running `aiden serve`: it stops the Bot's running chat turns and refuses new ones, including manual routine runs, until it is unpaused. With durable sessions, a turn the pause stopped waits for Resume or Dismiss after unpause, as on the desktop. Hand-offs, `sign_in`, Bot rules and Bot computers are desktop-only for now; Bots run by `aiden serve` don't have them yet. Bots support managed homes, exact Custom grants, MCP, skills, web search, companion vision, and uploaded photos. Bot subagents perform read-only investigations within the admitted file scopes.
- `aiden speech status` inspects local models; `download`, `select`, `delete`, and `transcribe` are explicit actions. Optional `sherpa-onnx-node` runs in a worker. Setup and ordinary status reads never download weights.

Delegation in the TUI uses private child inference processes, parent-owned tools, shared
capability gates, one-shot effect approvals, and durable native history (`/subagents`).
Standalone generative HTML bundles the vendored chart/math libraries for offline viewing.
Daemon state and the Unix control socket live in the agent directory; each daemon requires
its own directory. Shutdown cancels active generations, settles scheduled work, and closes
connector/worker resources.

## Linux container

Build from the repository root (requires Docker):

```bash
docker build -f packages/cli/Dockerfile -t aiden-cli:local .
docker volume create aiden-state
docker run --rm -it -v aiden-state:/home/node/.aiden \
  -v "$PWD:/workspace" aiden-cli:local
```

The default command is `serve`; append `--help`, a CLI command, or `--tui-mode fullscreen`
to select another mode. The image runs as the unprivileged `node` user. Mounted workspace
permissions must permit that user to read/write according to the selected access tier.
Use a dedicated volume per daemon. Configure and pair Remote explicitly before publishing
its configured port; mounting the Docker socket is unnecessary. Tailscale routing and LAN
mDNS discovery depend on host networking and are best configured on the host.

The build prefers architecture-verified prebuilt helpers from `prebuilt/native/<target>`
(darwin-universal, linux-x64, linux-arm64 — regenerate with
`node scripts/build-native-helpers.mjs`, optionally `--docker linux/amd64 linux/arm64`
for cross-targets) or a directory named by `AIDEN_NATIVE_PREBUILT_DIR`, so installing on a
supported platform needs no C toolchain; it compiles from `native/` only when no matching
prebuilt exists. macOS builds use Xcode Command Line Tools; Linux source builds use a C17
compiler and OpenSSL development headers. Windows native helper support is outside this
implementation. No model catalogs, credentials, speech weights, or private history are
fetched into the image.


### Product help and settings in chat

Ask what Aiden can do or how its agent works: `aiden_help` reads bundled help offline. `/help-aiden memory` works without workspace file access. `/aiden-app` loads the immutable product skill; `--no-skills` disables that command and its `skill_aiden_app` tool. The pinned Pi public main API does not inject a built-in skill resource, so this owned command is the supported entry point.

`/aiden-settings appearance|memory|web-search|skills` opens Pi's native settings selector inside the conversation. Theme changes use Pi's real theme API and verify the saved terminal default. Memory and Web Search switches persist in this CLI's actual agent directory; restart the CLI to rebuild feature tools after enablement. Desktop chat width, workspace memory and the desktop Skills gate are shown as unsupported. Nothing changes just by displaying a card, and no app operation controls an open Electron window.

For explicit headless administration, use `aiden app help [query]`, `aiden app status`, `aiden app get memory`, then `aiden app set memory.enabled false <revision> [operation-id]`. Supply the revision returned by the read; retry an uncertain request with the same operation ID. Headless agent tool calls cannot mutate app preferences. Set `appControlPolicy` in device-local `aiden.json` to `disabled`, `ask`, or `safe`; interactive enablement always requires a foreground choice.
