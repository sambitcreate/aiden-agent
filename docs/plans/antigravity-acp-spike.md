# Antigravity ACP Phase 0 spike

Date: 2026-10-06. Host: Apple Silicon macOS, unauthenticated probe. Feeds [antigravity-acp-provider-plan.md](antigravity-acp-provider-plan.md).

## Runtime 1.3.0 supersedes the plan's sizing

The ACP registry (`agentclientprotocol/registry`, `antigravity-acp/agent.json`) now publishes **1.3.0**, and it adds **`darwin-x86_64`**, so Intel Macs are supported.

The archive is no longer a large PyInstaller one-file bundle:

| Platform | Archive | Server | Harness |
| --- | ---: | ---: | ---: |
| darwin-arm64 | 111.5 MB | 278.5 MB | 118.6 MB |
| darwin-x86_64 | 117.2 MB | 282.8 MB | 124.2 MB |
| linux-x86_64 | 333.7 MB | 926.5 MB | 130.4 MB |
| linux-aarch64 | 321.7 MB | 930.8 MB | 123.2 MB |

**Hash provenance.**
- The darwin-arm64 archive was downloaded from `dl.google.com`. Its SHA-256 (`7cd97045…5aa5b88`) and every member size match the Ed25519-signed catalog in `pi-antigravity-acp-provider`, and that catalog's signature verified with the package's embedded public key.
- The other platforms are pinned from the same verified catalog. The installer re-checks hash, sizes and live identity before activation.

## Probe results (isolated `GEMINI_HOME`, `TMPDIR`, `BROWSER` shim, ACP SDK 1.7.0)

- **Startup.** `initialize` took 2.9 s cold and 1.2–1.4 s warm.
- **Initialize response.** A proper v1 response with `protocolVersion: 1`. The v2-in-a-v1-shape quirk T3 recorded for 1.1.1 is gone.
- **Agent info.** `agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.3.0" }`.
- **Capabilities:**
  - `loadSession`
  - `sessionCapabilities.list`
  - `sessionCapabilities.resume`
  - `auth.logout`
  - `mcpCapabilities.http` and `mcpCapabilities.sse`
  - `promptCapabilities` image, audio and embeddedContext
- **Auth methods:** `oauth-personal`, `oauth-business`, `gemini-api-key` and `agent-platform`.
- **Unauthenticated `session/new`** returns `-32000`. Its data message names `<GEMINI_HOME>/antigravity-acp/settings.json`, which confirms the profile override works and the real `~/.gemini` is not used.
- **Temp space.** `TMPDIR` holds 136 KB after startup (a single CA bundle). The 1 GB-per-launch unpack seen with 1.1.1 no longer happens. Keep the per-process `TMPDIR` and the sweep as cheap insurance.
- **Sign-in URL capture.** `authenticate({ methodId: "oauth-personal" })` invokes `BROWSER` with the Google authorization URL. A `/bin/sh` script on a space-free path captures it from stderr.
  - The server also prints `Open the following link to authenticate the ACP server: <url>`, now on **stderr** (1.1.1 printed it on stdout).
  - Stdout carried no non-JSON lines. The stdout filter stays defensive.
- **Stderr** carries glog-formatted `I…` lines containing local paths. Keep a bounded tail for diagnostics only.

## Still open (requires a signed-in account)

These are recorded as acceptance gates. They are not blockers for implementation.

- File writes route through `fs/write_text_file` when the client advertises it.
- The session config options include `model` and `mode`.
- `session/resume` works across a process restart.
- HTTP MCP bridge calls work.
- Whether `_meta.quota` appears.
- Idle network traffic.
- Google's terms for third-party ACP clients.
