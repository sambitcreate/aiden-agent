import type { SubagentFileMutatorClient } from "./subagent-file-mutator-io.js";

/**
 * How one approved file mutation ended, after its one-shot approval was spent.
 * The commit's namespace publication is the point of no return: from there the
 * new content stands, so a later failure is never reported as a failed write.
 *
 *   not_committed   Nothing was published; the old file is intact.
 *   unknown         The helper cannot say whether it published.
 *   committed       Published, and any recovery file is gone.
 *   recovery_kept   Published; cleanup failed but the recovery file was kept.
 *   cleanup_unknown Published; what happened to the recovery file is unknown.
 */
export type SubagentFileMutationOutcome =
  | { kind: "committed" }
  | { kind: "recovery_kept" }
  | { kind: "cleanup_unknown" }
  | { kind: "not_committed" | "unknown"; error: unknown };

type TransactionClient = Pick<SubagentFileMutatorClient, "commit" | "finalize" | "preserve" | "currentState">;

async function preserveRecovery(client: TransactionClient, effectId: string): Promise<boolean> {
  if (client.currentState !== "committed" && client.currentState !== "indeterminate") return false;
  try {
    await client.preserve(effectId);
    return true;
  } catch {
    // Failing to preserve cannot upgrade an unknown outcome to success.
    return false;
  }
}

/** Commits a prepared mutation, then finalizes it, keeping recovery evidence on any failure. */
export async function commitSubagentFileMutation(
  client: TransactionClient,
  effectId: string,
  signal: AbortSignal,
): Promise<SubagentFileMutationOutcome> {
  let recoveryName: string | undefined;
  try {
    ({ recoveryName } = await client.commit(effectId, signal));
  } catch (error) {
    const unknown = client.currentState === "committed" || client.currentState === "indeterminate";
    await preserveRecovery(client, effectId);
    return { kind: unknown ? "unknown" : "not_committed", error };
  }
  if (!recoveryName) return { kind: "committed" };
  try {
    await client.finalize(effectId);
    return { kind: "committed" };
  } catch {
    return { kind: (await preserveRecovery(client, effectId)) ? "recovery_kept" : "cleanup_unknown" };
  }
}
