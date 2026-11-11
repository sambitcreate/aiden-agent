# MCP OAuth early refresh and refresh lock (2026-11-11)

W2 of `docs/plans/upstream-week-2026-11-11-plan.md`, stacked on the Pi 1.5.2 bump (PR #799). It follows the ideas in OpenCode #63028 (refresh before expiry) and #62827 (one refresh per credential), adapted to Aiden's store.

## What changed

- **Expiry.** `McpOAuthSession.expiresAt` (ms since the epoch) is set from `expires_in` when tokens are saved (`sessionWithSavedMcpTokens`). Token invalidation drops it. A malformed value is dropped when the session is parsed.
  - Records saved before this change have no `expiresAt` and keep the old behavior: refresh after the server's 401.
- **When a refresh is due.** `mcpTokenRefreshDueAt(session)` returns `expiresAt - min(30 s, lifetime / 2)`.
  - There is no early refresh without a refresh token or an expiry.
  - Deviation from the plan's flat 30 s: half the lifetime caps the skew, so a token that lives under a minute isn't refreshed on every request.
- **Lock.** `McpOAuthRuntime.withRefreshLock?(serverId, op)` covers everything from re-reading the session to saving the refreshed one.
  - **Desktop:** the default is `withInProcessMcpRefreshLock`, a keyed promise-chain mutex in `mcp-oauth-provider-core.ts`.
  - **CLI:** `packages/cli/src/mcp.ts` uses `withCredentialWriterLease(<agentDir>/credentials/<id>-refresh, op, 30 s)`, a per-server flock lease separate from the shared writer lease. Take the refresh lease first, then the writer lease, and keep that order.
  - If the lease is busy past 30 s, the call raises `McpOAuthRefreshUnavailableError`, which is transient and keeps the sign-in.
- **Transport.** `adaptRemoteOAuthProvider` in `mcp-remote-transport.ts` sets up the following:
  - Refreshes are single-flight per transport.
  - Inside the lock, the transport re-reads the tokens. If the stored access token differs from the rejected or expiring one, it uses the stored token and doesn't refresh. Otherwise `authorizeMcp` refreshes and the save goes through the existing compare-and-swap.
  - `token()` refreshes early once the token is due. On a transient failure (network, 5xx, busy lease) it sends the current token and remembers it (`earlyRefreshFailedFor`), so it doesn't retry the early refresh on every request; a later 401 handles it.
  - `invalid_grant`, `invalid_client` and `unauthorized_client` sign the server out, as before.
  - `insufficient_scope` 401s still go to Pi's adapted handler.

## Decisions

- **Only background providers get early refresh and the lock.** Interactive and verify providers have no `withRefreshLock`. This avoids a deadlock: a sign-in's 401 must never wait on a background refresh of the old grant, which is what happened in tests before the fix.
- **Pi 1.5.2's `createMcpAuthProvider` isn't adopted.** Its store saves unconditionally. Aiden's store needs:
  - compare-and-swap saves and compare-and-delete invalidation
  - the generation gate and the status sink
  - `observeTokens`, binding matching and the `rejectedRefresh` marker
  - the background rules (never register, never redirect)

  Aiden mirrors the provider's design instead: the 30 s skew and re-reading under the lock.
- **Where the one-refresh guarantee comes from.** In one process, `coalesceRefresh` in `mcp-fetch-policy.ts` already collapsed identical refresh POSTs. The CLI lease is what limits two processes to one refresh. A mutation check confirmed this: removing the lease fails the cross-process test.
- **No new network calls.** A refresh contacts only the server's own token endpoint.

## Tests

- `main/services/mcp-oauth-session.test.ts`: expiry is recorded, a refresh replaces it, invalidation drops it, the half-life cap, old records.
- `main/services/mcp-oauth-flow.test.ts`:
  - two clients holding one expired token cause one refresh
  - a token within 30 s of expiry is refreshed with no 401
  - a 503 keeps the sign-in and makes one attempt
  - `invalid_grant` signs out
  - an old record still refreshes on 401
- `packages/cli/tests/parity.test.mjs`: "two aiden processes holding the same expired MCP token renew it once and both connect", which uses real child processes.
- `mcp-remote-transport.test.ts`: a cancellation sent while a 401 refresh is pending now waits for the refresh and goes out once, with the new token. It used to go out twice.
- The test server records `seen.unauthorized`, the token presented with each MCP 401.
