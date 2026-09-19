# Provider stream hook cancellation — 2026-09-19

- Baseline: Aiden `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`, Pi package 0.84.4.
- Finding: Codex header transforms and Pi payload/response hooks were awaited without racing request cancellation or the credential generation. Existing account-switch tests released their hook before checking settlement, hiding indefinitely stalled hooks.
- Change: reuse Aiden's `waitForAbort` for those three hook boundaries. Header setup retains bounded credential-supersession retry; payload/response use the prepared combined request/generation signal. Late rejections remain observed, and late values cannot resume dispatch. Callback code itself is not forcibly terminated.
- Tests: Codex suite 37 tests plus 18 model-runtime/provider-contract/failure tests; type-check and lint pass. Existing root test scripts already include the edited test file. No live credentialed provider or packaged Electron check performed.
- Scope: Aiden-owned Codex adapter only; no shared IPC/server/transcript changes, no native implementation change, no new onboarding capability, no plan status change.
- Source lesson: Pi `packages/ai/src/api/lazy.ts` and `packages/ai/src/utils/event-stream.ts` at `2a9b4ebc680053c64e31f635b0b22d5e22564001` settle only when setup/forwarding returns; OMP `packages/ai/src/utils/abort.ts` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6` separates caller cancellation from provider work and cleans up cancellation listeners. Both references are MIT; implementation is original and reuses the existing Aiden helper.
