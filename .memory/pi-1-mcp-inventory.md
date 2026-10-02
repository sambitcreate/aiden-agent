# Pi 1.0 complete MCP inventory — 2026-10-02

Branch codex/pi-1-mcp-inventory, based on integrations53161ba13, reuses CLI worktree. Desktop foreground, child, Bot metadata and Settings status previously issued only one SDK listTools request. Shared listMcpToolInventory now follows opaque cursors with 64-page,512-tool,30-second total limits; duplicate names/cursor cycles/malformed pages/overflow fail closed. Each page checks current configuration/cancellation, with child credential revision checks before accepting it. No partial inventory escapes on later failure.

SDK listTools clears its internal output/task cache per page. createMcpToolCallGuard compiles full-inventory output schemas via the public SDK Ajv provider and rejects unsupported required tasks before request dispatch. Foreground plus child regular/raw call wrappers keep these independent contracts; private SDK state is untouched.

Provider-auth lane is parallel: its operation-scoped inspect(client,signal) must call the helper using combined operation/lease signal and owner/config freshness. Preserve scoped clients rather than restoring the old shared client during merge.

Validation Node22.22.3: MCP140, focused inventory/status/child28, CI policy/registry25, root types and touched ESLint. New helper tests registered in test:mcp and core-git CI lane. Existing child suite covers both dispatch paths. Desktop-only inventory/Settings metadata, no shared native protocol/transcript or new onboarding capability.

Restacked307 onto305 normally; b8d4d2e6 matched aggregate1fa603db5 exactly before follow-up. Resource reads now retain raster image parts through shared MCP tool-result validation (4 images,2MiB each, existing MIME/signature/dimension rules), while keeping requested/derived URI metadata and avoiding base64 in text summaries. Arbitrary binary remains an explicit omission; resource-read authority does not authorize file creation, and no files are written. Existing generation/server handle admission, read lease/cancellation and32KiB metadata budget unchanged. Read-resource images use the existing tool-result image contract, not a new gallery/artifact wire format.

Exposure audit: desktop server selection/enabled and excludeToolNames enforce hidden/omission authority. Default admitted MCP is codemode-discoverable; without codemode it is directly declared. Desktop does not expose Pi's persisted per-server/per-tool direct/deferred/hidden overrides or search-activated direct declarations. Those controls remain in native CLI. Resource text-encoded blobs and automatic nonimage binary temp files also remain CLI-only conversion behavior.

## PR307 platform gallery review follow-up

Centralized Model Freedom copy so Linux and unknown platforms omit Apple models while macOS retains them. Every platform keeps local llama.cpp More options setup, explicit send approval, and possible provider charges. Production gallery data and platform filtering share the same description function. Replaced the classifier source-text assertion with real Electron gallery coverage under Linux/macOS capability IPC; each case uses its own first-run fixture.

Validation on Node22: onboarding67, root/E2E types, production build, targeted lint, diff check, and two actual Electron platform gallery cases (7.5s) pass. Initial draft of the new E2E reused saved onboarding progress between platforms; separated fixtures fixed that deterministic test setup error, without retries or timeout changes. No hosted green claim; final restack/CI remains pending.

## PR307 structured tool-error review follow-up

`createMcpToolCallGuard` now exempts only `isError === true` from successful-output schema validation. Diagnostic JSON can differ from the success schema, matching the installed SDK server's `validateToolOutput` behavior. Missing or malformed successful output still rejects, including forged truthy nonboolean error flags. Tests route a diagnostic error through the real guard and `executeMcpAgentTool`, and exercise regular/raw isolated child wrappers with credential redaction intact. Node22: focused35, full MCP157, root typecheck and changed-file lint pass.

The installed SDK's `Client.callTool` still validates structured error results against cached output schemas ([upstream issue1943](https://github.com/modelcontextprotocol/typescript-sdk/issues/1943)). That also affected cached ordinary foreground and child clients' last-page schemas before Aiden's guard could run. Foreground cached/scoped and child factory call adapters now use public `Client.request` with `CallToolResultSchema`, leaving successful-output and required-task checks to Aiden's complete-inventory guard. Original request options flow through unchanged; credential/configuration checks and synchronous raw dispatch fences stay in place. No SDK private state or dependency patches.

Real SDK Client/Server pairs over in-memory transports prove first/last-page diagnostic errors survive, malformed successful outputs reject, invalid result envelopes reject, required tasks never dispatch, and progress, cancellation notifications and timeouts work. Both isolated child call paths retain error diagnostics and credential redaction with a populated last-page SDK cache. Final Node22 validation: focused37, full MCP158, root typecheck, touched ESLint and diff checks pass. Independent adapter review found no semantic blocker.
