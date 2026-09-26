# Aiden CLI

A headless Aiden Agent: the full pi coding agent TUI, rebranded and themed as Aiden, deployable on macOS and Linux with Node.js ≥ 22.19, including servers with no display.

Built on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, MIT, pinned `0.87.1` — the same line the Aiden desktop app uses). The desktop's `renderer/shared/appearance.ts` is the single source of truth for the terminal palettes.

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
| Display Image | `display_image` | Inline images in the TUI (Kitty/iTerm2 protocols); copies archived under `<agentDir>/artifacts` |
| Advisor | `advisor` | One tool-free second opinion per response via Aiden's AdvisorRuntime (vendored, byte-parity tested); reviewer picked through Ask User Question when unnamed |
| btw | `/btw <question>` | Bounded read-only side question about the conversation, with ephemeral session-scoped follow-ups |
| Usage | `/usage` | Session totals plus a source-attributed durable usage ledger |
| Voice | `/voice`, `/dictate` | Transcription provider settings (`gemini`/`openai`/`off`, persisted to `aiden.json`); dictation records via `sox`/`ffmpeg` and inserts the transcript into the editor. Local Parakeet transcription is available through `aiden speech` and Remote; desktop global-hotkey dictation remains desktop-only |

Settings for these live in `~/.aiden/agent/aiden.json` (device-local; shapes mirror the desktop's `AppSettings` subsets).

## No telemetry

The CLI ships without pi telemetry, enforced three ways: the entry forces `PI_TELEMETRY=0` (which gates both the pi.dev `report-install` ping and pi's attribution headers, and overrides settings), the settings default is flipped off, and the build patches the ping's call sites and endpoint out of the bundle — asserted by `tests/bundle.test.mjs`.

## Where state lives

| Path | Contents |
| --- | --- |
| `~/.aiden/agent/` | CLI state: `settings.json`, `auth.json`, `models-store.json`, `sessions/`, `extensions/`, `skills/`, `themes/` |
| `~/.aiden/` | Shared Aiden home (desktop's portable `config.json`, `skills/`, `scripts/`; `memory/` is the shared desktop+CLI store; the CLI adds only the `agent/` subtree otherwise) |
| `<project>/.aiden/` | Project-local settings, extensions, skills, themes, prompts (gated by project trust) |
| `AIDEN_CODING_AGENT_DIR` | Env override for the agent dir (mirrors pi's `PI_CODING_AGENT_DIR`; required for tests and multi-instance setups) |

## Theming

Eight Aiden presets ship as built-ins — Aiden, Slate, Berry, Moss × light/dark — and pi's own palettes are deliberately not shipped. The Aiden dark/light palettes replace pi's stock `dark`/`light`, so terminal background auto-detection lands on Aiden by default. Switch with `--use-theme <name>`, the `/theme` command, or first-run setup.

Regenerate the theme JSONs after changing `renderer/shared/appearance.ts`:

```bash
npm run themes   # in packages/cli — a fidelity test fails if committed files drift
```

## How the rebrand works

pi reads its identity (`APP_NAME`, config dir, env var names) from the `package.json` nearest its running code. The build bundles pi's code into `dist/app/cli.js` and writes a generated `dist/app/package.json` with `piConfig: { name: "aiden", configDir: ".aiden" }` — that is the entire rebrand mechanism, and `tests/bundle.test.mjs` pins it. The bundle script is a port of pi's own `build-coding-agent-bundle.mjs` (same externals and lazy-loader emission); runtime externals (`chord`, `jiti`, `photon-node`) resolve from this package's `node_modules`.

The entry (`src/cli.ts`) disables pi.dev's version feed (`PI_SKIP_VERSION_CHECK=1`, overridable) because this CLI versions independently, registers the bundled theme presets through pi's public `--theme` flag, and defaults the TUI to pi's fullscreen alt-screen renderer — an explicit `--tui-mode` flag or any `tuiMode` saved in settings (e.g. via `/config`) always wins over that default.

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

Aiden feature parity lands in phases (todo, btw, advisor, memory, subagents, `aiden serve`, remote access); see [`docs/plans/aiden-cli-plan.md`](../../docs/plans/aiden-cli-plan.md).


## Workspaces, automation, and Remote

`aiden --help` lists the complete command surface. Register a directory with
`aiden workspace add /absolute/project`, then use `aiden workspace access <id> full|ask|none`.
Ask mode requires one approval per tool call; unattended Telegram and schedule execution
require explicit Full workspace access. Schedules also retain their own read-only/Full tool
selection and exact MCP connection bindings.

- `/search`, `/name`, `/attach`, `/export-aiden`, `aiden import`, and `aiden export` manage conversations. Imports copy into new journals; never point desktop and CLI at the same writable journal.
- `aiden git`, `aiden files`, and `aiden worktree` use the shared workspace and Git services. Managed removal uses the bundled native helper.
- `aiden provider import <models.json>` configures custom compatible providers. `aiden catalog refresh` refreshes inference catalogs. `catalog models-dev fetch` and `insights aa|openrouter fetch` are explicit display-only network actions.
- `aiden mcp presets`, `mcp add <file>`, and `mcp login <id>` configure MCP. Tool schemas are paginated, bounded, and rechecked before execution; failed servers do not silently gain tools.
- `aiden schedule save <file>` validates a schedule; `schedule preview`, `runs`, `notifications`, `run`, `pause`, and `resume` inspect/control it. `aiden serve` owns the scheduler, configured Telegram polling, and Bot runtime. `schedule` and `workspace` commands work without the daemon via a one-shot lease; `bots`, `remote`, and `telegram` management commands require `aiden serve` already running and fail if it is not. Run completions surface through `aiden schedule runs <id>`, `aiden schedule notifications`, and — for tasks with `notify` — local notifications on paired phones via the Remote `scheduled-tasks/notifications` feed.
- `aiden serve --daemon [--remote]` runs the daemon in the background (logs to `<agentDir>/serve.log`); `aiden serve status` reports PID/socket and `aiden serve stop` shuts it down. Stale locks are recovered only when the recorded owner PID is dead.
- `aiden serve --remote` additionally exposes the shared authenticated HTTPS/SSE API. `aiden remote pair lan|tailscale` renders a scannable terminal QR plus the manual code; `remote pair-status`/`remote pair-cancel <session-id>` manage the ~5-minute pairing window, and `remote devices`, `remote revoke <id>`, `remote approve-root <path>` administer pairing state. Tailscale requires its CLI on the host and an explicit pairing action. Sessions created through the daemon (Remote, Telegram, Bot replies) run the headless-safe extension set — memory, todo, MCP, web search, advisor, and artifact export; image display and ask-user-question remain interactive-TUI only.
- `aiden bots notice`, `acknowledge`, `catalog`, `create`, and `access` use the shared notice/revision/capability contracts. Bots support managed homes, exact Custom grants, MCP, skills, web search, companion vision, and uploaded photos. Bot subagents perform read-only investigations within the admitted file scopes.
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
