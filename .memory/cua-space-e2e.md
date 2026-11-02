# Local Cua Space E2E runner

PR #672 syncs uncommitted work into a Linux Space. Archive symlinks as links and exclude paths reached through a symlink ancestor, even if Git still tracks them. Stop the run when the guest cannot clear its previous checkout. Hash both extracted npm manifests before reusing dependencies, so live edits are validated by the same npm ci that CI uses. Regression tests exercise all three through the host runner.
