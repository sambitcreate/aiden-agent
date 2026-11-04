# CLI Task 10

- The parity command must run from `packages/cli`; its relative `tests/parity.test.mjs` path fails from the repository root. Corrected working directory before feature validation.
- A root `npm run build` was unintentionally selected while working on the CLI. It completed without launching windows. Subsequent commands use `npm --prefix packages/cli` from the checkout root.
- Ping/Pong's first assertion watched raw ledger entries for a projected transcript kind. Switched to the shared transcript projection; then awaited Alpha's final response before inspecting its request tools.
- A concurrent host edit temporarily used nonexistent `configStore.saveSettings`; reported the type-check error to the host worker, which corrected it.
