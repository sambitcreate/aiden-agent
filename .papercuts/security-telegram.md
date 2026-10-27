# Telegram security remediation

- Fresh managed checkout started detached at foundation 44264173d; created the authorized feature/security-telegram-pairing branch before editing.
- Fresh checkout has no node_modules; using an independent npm ci --ignore-scripts install.
- Telegram outbox tests initially failed because npm ci --ignore-scripts leaves build/native/aiden-lease-flock absent. Build the repository's lease helper before running suites that create real Bot runtimes.
- No Access rejection initially followed the generic update-retry lane, which blocked later recovery commands in the batch. It now uses a typed terminal admission error and acknowledges rejection without replaying the denied prompt.
- New synthetic Telegram callback/Bot ingress fixtures initially used fields outside Aiden's narrowed DTOs; type checking caught them and the fixtures now follow the actual contracts.
- Final compatibility trace found ordinary No Access topic filtering could delete an existing Bot-bound topic during reconciliation. Topic planning now keeps existing configured-folder targets while creating only accessible ordinary targets, with behavioral coverage.
