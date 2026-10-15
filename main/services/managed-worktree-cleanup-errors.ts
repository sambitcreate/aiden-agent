/** A retryable refusal before any managed checkout or Git metadata is removed. */
export class ManagedWorktreeProcessActiveError extends Error {
  readonly reason = "terminal_process_active";

  constructor(message = "A terminal process is still exiting. Wait for it to stop, then retry worktree removal.") {
    super(message);
    this.name = "ManagedWorktreeProcessActiveError";
  }
}
