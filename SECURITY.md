# Security Policy

## Reporting a vulnerability

Report security vulnerabilities exclusively through GitHub Security Advisories:

- [**Report a Vulnerability**](https://github.com/sambitcreate/aiden-agent/security/advisories/new)

Please do **not** open public GitHub issues or pull requests with unpatched vulnerability details or exploit PoCs.

### AI-assisted reports

If you use an AI model or agent to assist with finding, verifying, or writing up a security report, **explicitly state which model you used**.

Every report must describe a concrete security boundary crossing against `main` with reproducible steps or a minimal PoC. Unverified, automated AI-generated checklists or theoretical reports without a reproduction will be closed.

## Trust boundaries and threat model

Aiden Agent runs AI models, workspace tools, Bots, local/remote MCP connectors, an optional authenticated remote API for paired devices, and (on macOS) opt-in Computer Use and Bot VMs.

See [Privacy and trust](docs/privacy.md) and [Aiden Remote Access Threat Model](docs/security/aiden-remote-threat-model.md) for detailed architecture and enforcement notes. Key boundaries include:

| Surface | Boundary |
| --- | --- |
| **Desktop renderer** | Sandboxed with no direct Node.js access; communicates with Electron main only via an allowlisted preload bridge. Untrusted HTML renders, previews, and SVG previews must never execute scripts in the app origin or reach IPC/Node. |
| **Workspace & Bot permissions** | On desktop, workspace access (`full`/`ask`/`none`), approval modes (`Ask`, `Auto`, `Never ask`), workspace-scoped roots, and Bot rules/grants are enforced in the Electron main process, not solely in the UI. On the headless server (`aiden serve`), workspaces enforce `full`/`ask`/`none` and Bots run in `Ask` mode (it does not read desktop `Auto`/`Never ask` or `approval-rules.json`). |
| **Credentials & config** | Desktop stores provider keys, MCP OAuth tokens, and custom MCP env/header secrets in OS encrypted storage (macOS Keychain; Linux Secret Service/KWallet, refusing `basic_text`; Bot authority on Linux specifically requires an unlocked Secret Service provider), with `0700`/`0600` ownership checks on `~/.aiden`. The headless CLI encrypts `auth.json` and insight credentials with AES-256-GCM using a `0600` local wrapping key; Antigravity ACP tokens and Bot VM guest SSH keys (`0600`) live in private profile directories. |
| **Aiden On The Go / Remote Access** | Off by default on desktop (on by default in `aiden serve` unless `--no-remote`). Uses per-device random credentials (salted scrypt/lookup digests stored), pinned P-256 TLS on LAN, and bearer auth on all authenticated API/SSE routes—even over Tailscale. Public/pairing bootstrap endpoints (`GET /health`, `POST /pairing/manual-bootstrap`, and host-window-gated `POST /pairing/requests`) take no bearer token; `POST /pairing/exchange` and `POST /hooks/bot-routines/:token` authenticate with single-use pairing or webhook tokens. |
| **Apps using Aiden (MCP server)** | Off by default. Loopback-only (`127.0.0.1`), issues per-app tokens (shown once, revocable anytime), and cannot answer approvals or questions. |
| **Hooks** | Commands in `.aiden/hooks.json`, Settings, or proposals execute only after explicit host approval and re-approval on any change; a hook's `allow` can stand in only for a rememberable workspace file/command approval (`write_file`, `edit_file`, `run_command`) and cannot bypass `Chat only`/`None`, deny/block rules, `explicitOnly` tools, `computer_use`/`form_fill`/`background_job`, Bots, or `aiden serve`. |
| **Computer Use & Bot computers (macOS)** | Opt-in only; Computer Use is verified via the signed Rust broker (`cua-driver` pinned by hash/Team ID) and gated by explicit chat/global approval. Bot computers run in isolated per-Bot macOS VMs on Apple silicon (macOS 26+) via vendored `lume`. |

## Out of scope / intended behavior

The following are intentional design choices rather than security vulnerabilities (unless a separate bug allows bypassing the stated boundary):

- **Full access workspace / Full access Bot**: When the user grants `Full access` (or `Never ask` mode), the agent or Bot is intentionally permitted to run shell commands and read/write files as the user's OS account. Prompt injection that stays within the granted mode is an inherent model risk unless it bypasses a mode ceiling, rule block, or approval gate.
- **No OS sandbox on `run_command`**: Workspace `cwd` and path checks scope built-in file tools and help keep work inside the chosen folder, but an approved shell command runs as the local OS user rather than inside a container/VM (use a Bot computer VM or container if you need OS-level isolation).
- **External providers & remote MCP servers**: Data sent to user-configured LLM providers, cloud transcription, search providers, or remote MCP servers is governed by those services.
- **User-approved hooks or local MCP commands**: Running a shell hook or local MCP command after the user explicitly reviewed and approved its exact command line is expected behavior.
- **Packaged Electron fuses & development profiles**: Packaged release builds enable Electron fuses disabling `runAsNode`, `NODE_OPTIONS`, and `--inspect*` debugging flags, while `npm run dev` isolates state under `~/.aiden-dev` by default.
- **Already-compromised local OS user**: Local attackers already executing code as the same OS user.
