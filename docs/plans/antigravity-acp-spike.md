# Antigravity ACP Phase 0 spike

Date: 2026-10-06. Host: Apple Silicon macOS, unauthenticated probe. Feeds [antigravity-acp-provider-plan.md](antigravity-acp-provider-plan.md).

## Runtime 1.4.3 (2026-10-27)

Aiden's pin moved from 1.3.0 to **1.4.3**, the registry's current version. Google published 1.4.0 (Oct 12), 1.4.1 (Oct 16), 1.4.2 and 1.4.3 (both Oct 23) in between.

- **Hashes.** All four archives were downloaded from `dl.google.com`, and each SHA-256 matches `antigravity-acp/agent.json` in the ACP registry. Member sizes were read from the archives.
- **Layout.** Unchanged: `agy_acp_server.par` plus `localharness_external`, the same executable, and `--uid=` on Linux.
- **Identity.** The linux-x64 server, started with an isolated `GEMINI_HOME` and `TMPDIR`, returned `protocolVersion: 1` and `agentInfo: { name: "antigravity-acp", version: "1.4.3" }`. It also reported `loadSession`, `sessionCapabilities.resume`/`list`, `auth.logout`, the same four auth methods (including `oauth-personal`), and new `_meta.antigravity` flags (`tier`, `systemPrompt.append`) that Aiden ignores.
  - The probe container has no IPv6, so it ran with `--enforce_kernel_ipv6_support=false`; normal hosts do not need that flag.
- **Still open.** A signed-in chat on 1.4.3 (models list, file routing, resume) has not been checked yet.

| Platform | Archive | Server | Harness |
| --- | ---: | ---: | ---: |
| darwin-arm64 | 114.1 MB | 282.4 MB | 123.0 MB |
| darwin-x86_64 | 119.8 MB | 286.7 MB | 127.6 MB |
| linux-x86_64 | 336.8 MB | 927.7 MB | 133.9 MB |
| linux-aarch64 | 322.9 MB | 932.7 MB | 127.5 MB |

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
