# Antigravity runtime pin: how to bump it (2026-10-27)

The Google Antigravity ACP server is pinned in `main/services/antigravity/release.ts`: version, one URL, SHA-256, archive size and the exact byte size of each archive member for darwin-arm64, darwin-x64, linux-x64 and linux-arm64. It moved from 1.3.0 to 1.4.3 on 2026-10-27. Google shipped roughly weekly in October 2026 (1.4.0 Oct 12, 1.4.1 Oct 16, 1.4.2 and 1.4.3 Oct 23).

## How a new pin reaches people
- The app never fetches release metadata (AGENTS.md). A bump ships only with an Aiden release.
- On a computer that already has an older runtime, the installer reports `update_available` and Settings → Providers → Google Antigravity shows **Update Google Antigravity**. Nothing updates by itself.
- `validateInitialize` (`definition.ts`) requires the runtime's `agentInfo.version` to equal the pin (an `agy_acp_server_` prefix is stripped), so a stale install refuses to chat until the person updates.

## Bump recipe
1. Read `antigravity-acp/agent.json` in `agentclientprotocol/registry` (raw.githubusercontent.com) for the version, URLs and SHA-256s. The registry also lists Windows, which Aiden does not support.
2. Download all four archives from `dl.google.com` into an empty folder, check `sha256sum` against the registry, and read the member sizes with `unzip -l`. The registry has no member sizes, so the download is required.
3. Start the linux-x64 server with an isolated `GEMINI_HOME`/`TMPDIR` and send one `initialize`. Check the name `antigravity-acp`, the version, `protocolVersion: 1`, resume or loadSession, and the `oauth-personal` auth method. The cloud container has no IPv6, so add `--enforce_kernel_ipv6_support=false` there; it aborts otherwise.
4. Update `release.ts`, add a dated section to `docs/plans/antigravity-acp-spike.md`, and update the status row in `docs/plans/README.md`. Set the recorded `initialize` fixture in `definition.test.ts` to the new version, because it mirrors what the real server reports. The other `"1.3.0"` strings in the tests are fake-agent fixtures, not the pin.
5. Run `npm run test:acp`.

## Not checked by the recipe
A signed-in chat (models list, file routing, resume) needs a real account on the owner's Mac.
