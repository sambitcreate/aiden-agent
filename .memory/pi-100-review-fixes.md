# Pi 1.0 review corrections

## PR301 compaction budgets

- Editing a new exact model key preserves unsaved token fields. Choosing an existing saved key still loads its budget. The real Electron save/relaunch/reset regression now types a new key after entering both budgets and proves they survive.
- Initial and subsequent AGENTS.md changes use one `updateGenerationContextOptions` helper that validates the changed static context against the captured complete options, including compactionReserveTokens, before publishing the prompt/tools. A real instruction-refresher fixture proves a large reserve rejects guidance that fits default budgets without overwriting the previously admitted prompt.
- Node22.22.3:50 focused instruction/context/settings tests pass; root and e2e typechecks pass; Electron budget regression passes (7.8s) with fail-on-flaky-tests. Root build passes.

## PR304 foreground warming and aggregate economics

- Desktop chat now shares its actual execution-options builder with the regression fixture. Warming accepts its `usageSource: chat` accounting label only with a live, nonremote renderer owner; real Remote owners (id0/kindremote), Telegram, background sources, Bots, local providers, and automation remain excluded.
- The warmer checks the exact current generation/owner before requests, before and after auth resolution, and before rearming. Renderer detach now disposes its warmer immediately, including active requests, even though normal model work may continue detached. Initialization transfers that cleanup to active generation ownership.
- Every replayed prefix gets one savings opportunity. Admission subtracts cumulative reserved refresh costs from the single avoided miss; higher provider-reported costs increase the spend. The 100k-token fixture stops after10 refreshes with at least$0.05 remaining expected savings instead of spending13 refreshes. Only a real new provider request resets the prefix budget. A separate cheap-cache fixture still proves the fixed one-hour horizon.
- Node22.22.3:248 focused instruction/context/config/usage/warming tests pass;24 final warming/chat-start tests pass; root/standalone CLI types and changed-file ESLint pass. Root build and real Electron desktop chat keyless multimodal request pass (4.6s). No live inference or hosted retries.
