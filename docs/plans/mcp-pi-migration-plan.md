# MCP audit and move to Pi's MCP client

Status: **In progress** (2026-10-20). Phase 0 committed; Phase 1 implemented (see `.memory/mcp-pi-migration.md`). Audit run against `main` at `fc9cb56bc` (Pi 1.3.0 pins, `@modelcontextprotocol/sdk` 1.30.0).

## Why

The owner could not sign in to the built-in Figma connector and suspected the MCP code had been copied from Codex. The audit confirmed both, and found more. Pi already ships its own MCP client, `@earendil-works/pi-mcp`, which the CLI declares but never uses, plus a built-in MCP extension in `pi-coding-agent`. The earlier [MCP and Plugins remediation](completed/mcp-plugins-remediation-plan.md) stayed on the official SDK and deferred a `pi-mcp` migration spike. This plan does that migration and fixes everything the audit found along the way.

## Audit findings

### Why Figma sign-in fails (confirmed live, 2026-10-20)

1. **Aiden throws away the client secret the server issues.** `publicMcpClientInformation` (`main/services/mcp-oauth-session.ts:101`) strips `client_secret` from the registration response on save and on read (`main/services/mcp-oauth.ts:171,181`). Figma's registration endpoint returns a `client_secret` even when asked for a public client, and its authorization server lists only `client_secret_basic` and `client_secret_post` (no `none`). So after the browser sign-in, the code exchange goes out without a secret. A token request without one returns `{"error":"Client ID and client secret are required"}`. The stored `preset-figma` session in the user's profile holds a client registration and no tokens, which matches a failed exchange.
2. **Two more presets are affected the same way.** A metadata probe of all 19 OAuth presets found that **Vercel** and **Supabase** also accept only confidential clients. Today these three can never finish sign-in. The other 16 accept `none` and are unaffected by this bug.
3. **Figma registers as "Codex".** Figma's registration endpoint only accepts listed `client_name` values: "Aiden Agent" gets `403 Forbidden` and "Codex" gets `200`. The preset sets `auth: { kind: "oauth", clientName: "Codex" }` (`renderer/shared/plugin-catalog.ts:217-220`). That gets past registration, but Figma's login page then says "Figma MCP in Codex". Aiden is impersonating another vendor's client, which carries terms-of-service and trust risk.
4. **The CLI ignores the Figma override.** It uses `server.oauthClientName || "Aiden CLI"` (`packages/cli/src/mcp.ts:111`) and never calls `mcpOAuthClientNameForServer`, so CLI Figma sign-in gets the 403.

Probe results (authorization-server metadata):

| Preset | Accepts public client (`none`) | Supports CIMD |
|---|---|---|
| Figma, Vercel, Supabase | **No** (secret required) | No |
| Stripe, Datadog, ClickUp | Yes, only `none` | No |
| Consensus, Dropbox | Yes | No |
| Linear, Atlassian, Canva, Notion, Cloudflare, Sentry, Granola, monday.com, Airtable, PostHog, Higgsfield | Yes | Yes |

### OAuth runtime (`main/services/mcp-oauth*.ts`)

| Severity | Finding | Where |
|---|---|---|
| High | A stale client registration is never replaced. Authorize reuses the stored `client_id`. A server that dropped it shows an error page and never calls back, so Settings waits on "Waiting for browser…" for 5 minutes. The CLI already drops the client on interactive sign-in. | `mcp-oauth-session.ts:112-122`, `mcp-oauth.ts:491` |
| High | Sign out is hidden unless the server is authorized or flagged, and that flag lives only in memory. After a restart, the only way out of a broken registration is to delete the server. | `renderer/components/settings/mcp-sign-in-controls.tsx:49` |
| Medium | Metadata redirects are refused with `redirect: "error"`. Node raises a `TypeError`, which the SDK treats as CORS and silently skips, so discovery falls back to the wrong auth server. Network outages get the same treatment. | `mcp-fetch-policy.ts:332` |
| Medium | Every callback `error=` becomes "Authorization was denied by the provider." `error_description` is dropped, and the browser page says "Connected" before the exchange runs, even on `access_denied`. | `mcp-oauth-session.ts:365`, `mcp-oauth-loopback.ts:80-83` |
| Medium | "Authorized" can be committed with no tokens when a server allows anonymous `initialize`. | `mcp-oauth.ts:532-547` |
| Medium | A temporary refresh failure (5xx or timeout) is reported as "sign-in expired or was revoked". | `mcp-oauth.ts:251-256` |
| Medium | The issuer check is stricter than the SDK's. A risk, not a confirmed failure: check it per preset in live acceptance. | `mcp-oauth-session.ts:317` |
| Low | Verification can open a second consent tab, and a 5xx during verify throws away a good sign-in. | `mcp-oauth.ts:567-581` |
| Low | Startup prewarm and status checks run discovery and registration for OAuth servers that were never signed in. | `mcp.ts:829-840`, `mcp-status-events.ts:141` |
| Low | Preset `clientName` is not part of the session binding, so changing it keeps the old `client_id`. | `mcp-oauth.ts:330,473` |
| Low | The desktop and CLI keep two OAuth providers with different behavior (fixed vs random port, reuse vs re-register, secret dropped vs kept). The CLI also loads Pi's own MCP extension, which stores credentials in plaintext `mcp-auth.json`. | `packages/cli/src/mcp.ts` |

### Diagnostics

- `mcp-degraded` events record only `code: "unknown"` and an error fingerprint, with no host, HTTP status or cause. They repeat several times per second. The user's log for 2026-10-18 and 2026-10-19 holds dozens of identical lines that say nothing about what failed.
- `explainMcpOAuthFailure` only recognizes Figma's 403. Its advice, "Check Settings → Plugins for this connector's documented setup", sends users to the page they are already on, which documents no such setup.

### The catalog is a copy of Codex's plugin directory

`renderer/shared/plugin-catalog.ts` mirrors `github.com/openai/plugins`. It has 66 entries, of which **only 21 can be set up** (20 from upstream plus Composio):

| Kind | Count | What Aiden can do |
|---|---|---|
| `skills` (Codex skill bundles) | 24 | Nothing. |
| `chatgpt-app` | 7 | Nothing. |
| `mcp-auth-unsupported` | 6 | Nothing (Google, Slack, Zoom, Shopify). |
| `local-stdio` | 5 | Nothing. |
| `git-marketplace` | 3 | Nothing. |

Codex and OpenAI wording users can see:

- **Directory blurb:** "Official Codex plugins … ChatGPT-only apps … do not install Codex skill files" (`renderer/components/settings/mcp-settings.tsx:470-472`).
- **Details dialog:** labels entries "Codex official" (`mcp-settings.tsx:595`) and repeats "Codex skill files" (`:606`).
- **Listed-only notes:** all four start from Codex ("This Codex plugin…", "Codex maps this as a ChatGPT app…").
- **Codex/OpenAI products listed as entries:** Codex Security, OpenAI Developers, OpenAI Ads Conversions, Public Equity Investing, and Plugin Eval ("Evaluate Codex skills and plugins").
- **Badges:** "ChatGPT app" and "Git marketplace" badges on cards.
- **Docs links:** 14 point at `https://openai.com/`. Six connectable presets link to a vendor homepage instead of MCP docs: Atlassian, Granola, Dropbox, ClickUp, Consensus, Higgsfield.
- **Code and tests:** file headers say the catalog mirrors Codex, a test pins `PLUGIN_CATALOG_SOURCE_URL` to `github.com/openai/plugins`, and `npm run plugins:refresh` diffs against it.

### Settings UI

- **The default view is mostly dead cards.** The filter defaults to "All", so 45 of 66 cards cannot be used. Details on those cards dead-ends with only a Close button.
- **The feature has five names:** Plugins (settings, `/plugins`), MCP Connectors (onboarding), connections (Bots), MCP servers (schedules), and Configured MCP servers / Add custom MCP.
- **Bots and Settings disagree.** Bots offer Gmail, Calendar, Slack, Teams and Outlook through Composio, while Settings shows the same apps as unusable "ChatGPT app" or "MCP (auth)" cards with no hint about Composio.
- **A card can say "Configured" in green while the connection is failing.** The badge comes from saved state, not live status (`renderer/lib/mcp-preset-state.ts:31`).
- **Design-system drift:** three explanatory paragraphs where `docs/settings-design-system.md` puts explanations behind `InfoHint`, and group titles that don't use the `FieldSet` group title. There is also a raw "http"/"stdio" transport badge.
- **Wrong wording on Linux:** "Values are encrypted in this Mac's keychain".

Things that do not belong in Plugins settings:

- **The "OAuth client name" field** on custom servers. It exists to spoof allowlisted names, and normal users have no reason to set it. Remove it.
- **Provider-credential sharing** in the custom-server editor. It can forward any built-in provider's bearer token to an arbitrary server, and I found no rule excluding the ChatGPT/Codex subscription token. This is a Providers-level trust decision. Move it there and exclude subscription tokens.
- **The 45 listed-only Codex entries.** Remove them.
- **"Reset connections" as the page's primary header action.** It is a recovery tool. Move it into an overflow menu.

## What Pi gives us

`@earendil-works/pi-mcp` 1.3.0 is a standalone MCP client that does not depend on the official SDK. It covers:

- **Protocol:** `2025-11-25`, plus the older revisions the SDK negotiates. Streamable HTTP with session resumption. stdio with process-group shutdown. Paginated tools, resources, resource templates and `resources/read`. Server `instructions`. Progress and cancellation.
- **OAuth** (`pi-mcp/oauth`): discovery, PKCE, dynamic registration that **keeps `client_secret`** and picks the right token auth method, CIMD (`clientMetadataDocument`), and pre-registered `clientId`/`clientSecret`. It also does one shared refresh for concurrent 401s, step-up for `insufficient_scope`, re-registration after `invalid_client`/`unauthorized_client`, and an injectable `McpOAuthStateStore`. The pieces Aiden is missing (or got wrong) come for free.
- **Not covered:** legacy HTTP+SSE, sampling and MCP servers. Aiden's ACP bridge and computer-use module host MCP *servers*, so they keep `@modelcontextprotocol/sdk`. Legacy SSE goes away (pre-1.0, no migration).

Pi's `coding-agent` MCP extension (`extensions/mcp/oauth.ts`) is a reference for per-server `clientId`/`clientSecret`/`callbackPort`/`clientName`/`clientRegistration: "dcr" | "cimd"` settings. Aiden adopts the same knobs, but stores credentials in its encrypted store rather than plaintext `mcp-auth.json`.

## Decisions for the owner

1. **Figma identity.** Recommended: stop registering as "Codex", ask Figma to allowlist "Aiden Agent", and in the meantime add a **Figma Desktop** preset for Figma's local MCP server (`http://127.0.0.1:3845/mcp`), which needs no OAuth. The alternative is to keep the "Codex" name knowingly, as a documented exception.
2. **CIMD.** 11 of the 19 OAuth presets support Client ID Metadata Documents. CIMD needs a stable Aiden-owned HTTPS URL that serves the client metadata (for example a GitHub Pages file on `sambitcreate`). Recommended: yes, with DCR as the fallback.
3. **Catalog scope.** Recommended: ship only connectable presets, under an Aiden-owned catalog. Drop the Codex mirror, `PLUGIN_CATALOG_SOURCE_URL`, `PLUGIN_CATALOG_VERIFIED_ON` and `plugins:refresh`.
4. **One name.** Recommended: "Connectors" everywhere users see it, including Settings, onboarding, Bots, schedules and slash commands, keeping `/mcp` as an alias.
5. **Pi's native MCP extension in the CLI.** Recommended: turn it off so the CLI has one MCP stack and no plaintext credential file.

## Phases

Each phase is one PR, stacked in order, with green CI on its exact head before merge. Run the narrow suites locally first.

### Phase 0 — Hotfix on the current SDK (optional, small)

Unblocks Figma, Vercel and Supabase sign-in before the migration lands.

- Keep `client_secret` and `client_secret_expires_at` in the encrypted session. Delete `publicMcpClientInformation`.
- Drop the stored client registration on an explicit Authorize.
- Test: a fake authorization server that issues a secret and rejects token requests without it. Sign-in completes, and refresh keeps working after a restart. This reproduces the Figma failure.

### Phase 1 — Desktop client core on `pi-mcp`

- Add `@earendil-works/pi-mcp` at exactly `1.3.0` to the root, in lockstep with the other Pi pins.
- Replace the SDK `Client`, `StreamableHTTPClientTransport` and `StdioClientTransport` in `main/services/mcp.ts`, `mcp-remote-transport.ts`, `mcp-stdio-transport.ts`, `mcp-tool-discovery-core.ts`, `mcp-tool-inventory.ts`, `mcp-resources.ts` and `mcp-status.ts` with `McpClient`, `StreamableHttpTransport` and `StdioTransport`.
- Inject Aiden's fetch policy as the transport `fetch`.
- Keep Aiden's own layers unchanged: admission queue, config lease, exposure, tool identity and schema shaping, server instructions, scoped resources and stdio approvals.
- Delete legacy SSE: `SSEClientTransport`, `mcp-sse-auth-lifecycle.ts`, the `"sse"` transport value and its UI.
- Keep `@modelcontextprotocol/sdk` only for the server side (ACP bridge, computer use). Add a lint or build check so no client-side SDK import comes back.
- Tests: extend the existing transport, discovery and inventory suites against `pi-mcp/testing`'s in-memory pair. Add a Playwright pass for adding, connecting and calling a stdio server and an HTTP server.

### Phase 2 — OAuth on `pi-mcp/oauth`

- **Provider and storage:** build the provider on `McpOAuthProvider` with an Aiden `McpOAuthStateStore` backed by the encrypted `mcp-oauth.json`. Client secrets are stored encrypted, never in plaintext.
- **Per-server settings, internal only:**
  - `clientRegistration: "cimd" | "dcr"`, with CIMD preferred when the server advertises it.
  - Pre-registered `clientId`/`clientSecret` for custom servers.
  - The fixed loopback port 41390.
- **Remove the SDK workarounds Pi already handles**, keeping each one only if a test against `pi-mcp` shows it is still needed:
  - the token and registration normalizers;
  - `withoutEmptyChallengeScope`;
  - the metadata observation fetch;
  - the `prompt=consent` duplication.
- **Fix the runtime findings:**
  - Re-register on `invalid_client`.
  - Follow same-origin metadata redirects without credentials, and report the real error instead of a fake CORS failure.
  - Pass the provider's `error` and `error_description` through to the user and serve a failure page in the browser.
  - Commit "Authorized" only when tokens exist.
  - Raise "sign-in required" only after `invalid_grant`.
  - Make verification non-interactive.
  - Never register from background prewarm or status checks.
  - Add the preset client identity to the session binding.
- **Sign out:** show it whenever a session is stored, and persist the needs-sign-in state across restarts.
- **Tests:**
  - A fake OAuth server matrix: confidential-only, public-only, CIMD, a stale `client_id`, a metadata redirect, an `access_denied` callback, a 5xx on refresh, and anonymous `initialize`.
  - Register-and-invoke tests for the authorize and sign-out IPC.

### Phase 3 — One MCP stack in the CLI

- Point `packages/cli/src/mcp.ts` at the shared `main/services` OAuth and client layer, which the build already bundles through `aidenRelativeTsRewritePlugin`, and delete the second provider.
- Turn off Pi's native MCP extension and the `pi-mcp add|login` commands, or route them into Aiden's encrypted store, per decision 5.
- Update `packages/cli/README.md` and `tests/bundle.test.mjs` as needed.

### Phase 4 — Aiden-owned connector catalog

- **Replace the catalog:** swap `plugin-catalog.ts` for an Aiden catalog of connectable presets only. Remove the `source`, `compatibility` and `compatibilityNote` fields, the four Codex notes, the source URL, the verified-on date, and `scripts/plugins-refresh*`.
- **Docs links:** point every `docsUrl` at the vendor's MCP docs.
- **Figma:** apply decision 1. If the hosted preset stays without allowlisting, it shows a clear "Figma has not approved Aiden yet" state instead of Set Up.
- **CIMD:** apply decision 2. Publish the metadata document and reference it from a constant.
- **Composio:** point Gmail, Calendar, Slack, Teams and Outlook users to the Composio preset, matching what Bots already offer.
- **Tests:** replace the source-URL test with behavioral catalog tests: every preset builds a valid server, its origin is pinned, and auth kinds resolve.

### Phase 5 — Settings and naming

- **Naming:** rename the page and all user-facing copy per decision 4. Update onboarding (`renderer/components/onboarding-feature-gallery.tsx`), Bots, the schedule editor and slash commands.
- **Status:**
  - Card status follows live status, so a failing connection never shows "Configured" in green.
  - Remove the "built-in" badge and the raw transport badge.
- **Remove or move:**
  - Remove the "OAuth client name" field.
  - Move provider-credential sharing to Settings → Providers, excluding subscription tokens.
  - Move "Reset connections" into an overflow menu.
- **Design-system conformance:** follow `docs/settings-design-system.md`, with explanations behind `InfoHint` and `FieldSet` group titles. Review `docs/chatgpt-desktop-ui-inspiration.md` and the specimen first, as AGENTS.md requires.
- **Copy:** make the keychain text platform-aware for Linux, and replace `explainMcpOAuthFailure` with messages built from the real OAuth error.
- **Tests:** Playwright coverage for the connect, authorize-failure and sign-out flows.

### Phase 6 — Diagnostics

- Record the error class, HTTP status, OAuth `error` code and server host (never URLs with secrets or tokens) on `mcp-degraded` and on sign-in failures.
- Deduplicate repeats per server within a time window.
- Tests: extend the diagnostics suites with an independent oracle for the redaction and dedupe rules.

### Phase 7 — Live acceptance and docs

- Sign in to every OAuth preset with a real account where one exists, and record pass or fail, auth method (DCR, CIMD or pre-registered) and refresh-after-restart in this plan. The API-key presets (Composio, GitHub) are checked once with a real key.
- Update `README.md`, `PRODUCT.md`, the relevant `docs/*.md`, the onboarding tile and `docs/plans/README.md`, and add the `.memory/` record. Archive this plan to `completed/`.

## Notes

- The audit's probe registered one unused OAuth client named "Codex" at Figma. Nothing was signed in.
- After the Phase 1 dependency change, recheck the hotspots AGENTS.md lists, such as the root `package.json` `test` chain.
