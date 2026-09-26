# MCP connection closure recovery — 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

Aiden's cached MCP client survived SDK transport closure. Subsequent discovery reused the closed client until an explicit disconnect. `McpManager.ensureConnected` now installs `Client.onclose` before initialization. The generation-bound cache expires that connection's lease and removes only matching pending/connected records. Transport loss does not increment the configuration generation; explicit disconnect still does. A late old callback cannot invalidate a replacement. Failed/in-flight tool calls are never replayed; the next discovery reconnects.

Source lessons (read-only, MIT, original implementation):
- `/Users/sambitbiswas/projects/opp/aiden-plugins/pi-mcp-adapter/server-manager.ts` at `1dbdef96f674410ac37067de70f10a3de3d48d98`, lines 437–444: SDK close state must be scoped to its owning connection.
- `/Users/sambitbiswas/projects/opp/opencode-v2-aiden-study/packages/opencode/src/mcp/index.ts` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, `connectTransport`; `packages/opencode/test/mcp/lifecycle.test.ts`: explicit lifecycle ownership and failure cleanup.

Validation: a real SDK in-memory server regression fails against baseline because discovery reuses the dead client, then passes with this fix. Closure during initialization, replacement deduplication, stale close callbacks, lease expiry, explicit generation revocation, and setup cleanup are covered. `npm run test:mcp`: 66 passed; `npm run type-check` and `npm run lint`: passed. The cache suite is now registered in `test:mcp` as well as its existing general test entry.

No UI, onboarding, shared remote DTO, transcript, or native client changes. No packaged/live remote-server validation performed. Hosted CI and central Luna/Pullfrog review remain separate delivery gates. No merge/release authorized.

## Remote transport review correction

Pullfrog identified that SDK 1.30.0 remote failures use `onerror` instead of `onclose`. Inspected the installed SDK and its pinned EventSource 3.0.7 implementation. SSE's typed errors with numeric HTTP codes stop reconnecting (including 204 and invalid 200 content types); EOF/network errors have no code and reconnect. Streamable HTTP 404 with an established session indicates session loss, while generic errors and optional GET-stream retry failures do not establish whole-client failure.

`createMcpRemoteTransport` now reports only those terminal cases to the owning cache immediately, then closes after SDK reconnect callbacks settle so pending retry timers are cancelled. All other errors retain the SDK's recovery behavior. New tests use real pinned HTTP/SSE transports with controlled fetch/response streams: ended sessions, stateless 404 preservation, transient POST failures, SSE EOF recovery, terminal 204/invalid-MIME responses, HTTP GET retries and terminal retry cleanup, and no replay of failed tool calls. HTTP session and SSE terminal tests failed against the prior PR head. The expanded `npm run test:mcp` passes 73 tests; type-check and lint pass. No dependency changes.

## Optional HTTP GET retry exhaustion evidence

A Luna follow-up questioned retaining an HTTP session after optional GET-stream retry exhaustion. The pinned SDK's `_startOrAuthSse` treats GET as optional (including accepting 405); `_scheduleReconnection` exhaustion emits an error and returns without closing the session. `send` independently POSTs using the existing session ID. The new regression starts a real HTTP transport, ends its GET stream, returns 503 for both reconnect attempts, waits for the SDK's exact exhaustion error, and then successfully performs `tools/list` POST on the same cached client and session ID, without another initialization. Production behavior is unchanged; GET exhaustion alone does not establish an unusable session. The expanded MCP suite passes 74 tests.

## Authenticated legacy SSE recovery

Pullfrog's OAuth follow-up was reproduced for SSE only. After GET 401, real SDK refresh-token exchange and redirect rejection leave the mandatory receive stream CLOSED; later tools/list POST can refresh credentials but times out because no receive stream delivers its response. HTTP controls prove subsequent POST refresh/discovery still succeeds after all optional GET-stream auth retries fail, so HTTP auth eviction is intentionally unchanged.

Added `mcp-sse-auth-lifecycle.ts` as an isolated compatibility adapter for pinned SDK 1.30 / EventSource 3.0.7. There is no public settled-reauth hook; it preserves the receiver of `_authThenStart`, then retires only failed reauth whose `_eventSource` is CLOSED (or an unsupported state). OPEN/CONNECTING retain their SDK recovery. Missing method shape fails closed with an explicit compatibility error. This private seam must be rechecked on dependency upgrades; installed-SDK regression controls exercise failed auth, successful refresh, and a transient fetch failure after refresh for both transports. Additional tests cover shape drift, receiver preservation, and late failures after cache replacement. No failed tool replay is introduced.

OAuth correction validation: `npm run test:mcp` 82/82 passed; full type-check, lint, and diff-check passed. Independent Luna and hosted checks on the new head remain delivery gates.
