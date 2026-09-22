# Aiden On The Go — Phase 10 evidence

Date: 2026-08-19
Status: Complete on the available desktop and physical-iPhone gates.

The Electron main process and authenticated Aiden Remote API now use one shared scheduled-task application service. Mobile supports list, search/filter, detail, create, edit, remove, pause, resume, run now, preview, run history, and revision-checked global settings. Task definitions bind only to validated Aiden workspaces, configured providers/models, enabled MCP IDs, and current server-inventoried scripts.

Remote DTOs omit provider fingerprints, resolved MCP bindings, chat IDs, credentials, raw script paths, and execution internals. Script selections are short-lived opaque claims bound to the paired device and selected workspace. The MCP inventory contains display names and IDs only. Stored run output is bounded and redacts local paths and token-like values before projection.

Create/edit uses a final foreground review. Lifecycle edits carry revisions into per-task serialization, settings have a serialized revision gate, and concurrent desktop/mobile edits admit only one revision. Run-now is device-scoped and idempotent: one server-minted `runId` is carried into the scheduler's stored run, duplicate retries replay it, and scheduler-owned execution continues after the caller disconnects.

The Swift app uses native `List`, `Form`, `Picker`, `Toggle`, `TextEditor`, sheets, alerts, and confirmation dialogs. Definitions, settings, and bounded run history have an installation-scoped, file-protected offline cache; offline mutations remain disabled.

Verification:

- TypeScript type-check and `git diff --check` pass.
- Scheduler tests pass 84/84.
- Shared application-service boundary tests pass 18/18.
- Aiden Remote tests pass 112/112 plus 4/4 LAN transport proofs.
- The complete workspace/subagent regression command passes 650/650 plus all native helper tests.
- The complete signed physical iPhone 13 Pro XCTest suite passes 50 tests with four expected environment-gated transport/Keychain skips. Its three Phase 10 tests cover canonical routes and preconditions, strict DTO rejection, stable run idempotency, safe inventory, and installation-scoped bounded offline cache.
- The signed app builds, installs, and launches successfully on the iPhone 13 Pro.
- No simulator was used and the iPhone 16 Pro Max was untouched.

Physical-iPad and real-Tailscale acceptance were not claimed by this phase. Phase 12 later closes real-Tailscale pairing and authenticated workspace transport on the physical iPhone; physical-iPad acceptance remains open.
