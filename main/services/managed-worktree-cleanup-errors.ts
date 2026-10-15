/** A retryable refusal before any managed checkout or Git metadata is removed. */
export class ManagedWorktreeProcessActiveError extends Error {
  readonly reason = "terminal_process_active";

  constructor() {
    super("A terminal process is still exiting. Wait for it to stop, then retry worktree removal.");
    this.name = "ManagedWorktreeProcessActiveError";
  }
}
