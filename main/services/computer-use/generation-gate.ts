import { waitForWorkspaceGenerationSettlement } from "../workspace-mutation-gate.js";

export class ComputerUseGenerationGate {
  private revision = 0;

  snapshot(): number {
    return this.revision;
  }

  isCurrent(snapshot: number): boolean {
    return snapshot === this.revision;
  }

  close(): void {
    this.revision += 1;
  }
}

/**
 * A generation is offered computer_use whenever the beta is on, but it counts
 * as using Computer Use only once a computer_use or fill_form call reaches the
 * access gate. Only those streams are cancelled when the beta, Form Fill or
 * its model goes away; a chat that never touched the computer keeps running.
 */
export interface ComputerUseActivationEntry {
  computerUse?: unknown;
  computerUseActivated?: boolean;
}

/**
 * Mark a stream as using Computer Use, unless the gate closed after the
 * stream's snapshot (a disable that raced the start wins). The check and the
 * mark happen synchronously, so a later close always sees the mark.
 */
export function activateComputerUseStream(
  gate: ComputerUseGenerationGate,
  snapshot: number,
  entry: ComputerUseActivationEntry | undefined,
): boolean {
  if (!entry || !gate.isCurrent(snapshot)) return false;
  entry.computerUseActivated = true;
  return true;
}

export function activatedComputerUseStreamIds(
  entries: Iterable<[string, ComputerUseActivationEntry]>,
): string[] {
  return [...entries]
    .filter(([, entry]) => entry.computerUseActivated === true)
    .map(([streamId]) => streamId);
}

interface ComputerUseSettlementEntry {
  computerUseActivated?: boolean;
  computerUse?: { closeAndSettle(): Promise<void> };
  completion?: Promise<void> | null;
}

/** Snapshot owners before cancellation can remove them; never treat abort as settlement. */
export async function cancelComputerUseAndSettle(input: {
  gate: ComputerUseGenerationGate;
  initializations: () => ReadonlyMap<string, ComputerUseSettlementEntry>;
  active: () => ReadonlyMap<string, ComputerUseSettlementEntry>;
  cancel: (streamId: string) => void;
  timeoutMs: number;
}): Promise<void> {
  input.gate.close();
  const entries = [...input.initializations(), ...input.active()]
    .filter(([, entry]) => entry.computerUseActivated === true && entry.computerUse !== undefined);
  const ids = new Set(entries.map(([id]) => id));
  for (const id of ids) input.cancel(id);
  let draining = true;
  let failed = false;
  const drain = Promise.allSettled(entries.flatMap(([, entry]) => [
    Promise.resolve().then(() => entry.computerUse!.closeAndSettle()),
    ...(entry.completion ? [entry.completion] : []),
  ])).then((results) => {
    failed = results.some((result) => result.status === "rejected");
    draining = false;
  });
  await waitForWorkspaceGenerationSettlement({
    completions: () => draining ? [drain] : [],
    isBusy: () => draining || [...ids].some((id) =>
      input.initializations().has(id) || input.active().has(id)),
    timeoutMs: input.timeoutMs,
    timeoutMessage: "Computer Use has not stopped yet. The model was not removed. Try again.",
  });
  if (failed) throw new Error("Computer Use teardown failed. The model was not removed.");
}
