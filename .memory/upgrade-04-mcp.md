# MCP connection closure recovery — 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

Aiden's cached MCP client survived SDK transport closure. Subsequent discovery reused the closed client until an explicit disconnect. `McpManager.ensureConnected` now installs `Client.onclose` before initialization. The generation-bound cache expires that connection's lease and removes only matching pending/connected records. Transport loss does not increment the configuration generation; explicit disconnect still does. A late old callback cannot invalidate a replacement. Failed/in-flight tool calls are never replayed; the next discovery reconnects.

Source lessons (read-only, MIT, original implementation):
- `/Users/sambitbiswas/projects/opp/aiden-plugins/pi-mcp-adapter/server-manager.ts` at `1dbdef96f674410ac37067de70f10a3de3d48d98`, lines 437–444: SDK close state must be scoped to its owning connection.
- `/Users/sambitbiswas/projects/opp/opencode-v2-aiden-study/packages/opencode/src/mcp/index.ts` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, `connectTransport`; `packages/opencode/test/mcp/lifecycle.test.ts`: explicit lifecycle ownership and failure cleanup.

Validation: a real SDK in-memory server regression fails against baseline because discovery reuses the dead client, then passes with this fix. Closure during initialization, replacement deduplication, stale close callbacks, lease expiry, explicit generation revocation, and setup cleanup are covered. `npm run test:mcp`: 66 passed; `npm run type-check` and `npm run lint`: passed. The cache suite is now registered in `test:mcp` as well as its existing general test entry.

No UI, onboarding, shared remote DTO, transcript, or native client changes. No packaged/live remote-server validation performed. Hosted CI and central Luna/Pullfrog review remain separate delivery gates. No merge/release authorized.
