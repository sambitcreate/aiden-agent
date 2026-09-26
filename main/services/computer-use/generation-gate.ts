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

export function activatedComputerUseStreamIds(
  entries: Iterable<[string, { computerUse?: unknown }]>,
): string[] {
  return [...entries]
    .filter(([, entry]) => entry.computerUse !== undefined)
    .map(([streamId]) => streamId);
}

export class ChatComputerUseMutationGate {
  private readonly changing = new Set<string>();

  tryBegin(chatId: string, busy: boolean): (() => void) | null {
    if (busy || this.changing.has(chatId)) return null;
    this.changing.add(chatId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.changing.delete(chatId);
    };
  }

  isChanging(chatId: string): boolean {
    return this.changing.has(chatId);
  }
}

interface ComputerUseSettlementEntry {
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
    .filter(([, entry]) => entry.computerUse !== undefined);
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
