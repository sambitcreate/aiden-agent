// A bulk action over selected rows: the same per-row call, one row at a time,
// stopping at the first failure so the rows left untouched stay selected.

export interface BulkResult {
  /** The ids the call succeeded for, in order. */
  done: string[];
  /** The failure that stopped the run, or null when every id went through. */
  error: unknown;
}

export async function runInOrder(ids: readonly string[], act: (id: string) => Promise<void>): Promise<BulkResult> {
  const done: string[] = [];
  for (const id of ids) {
    try {
      await act(id);
    } catch (error) {
      return { done, error };
    }
    done.push(id);
  }
  return { done, error: null };
}

/** "Deleted 2 of 5; <reason>", for a run that stopped part way. */
export function bulkFailureMessage(verb: string, result: BulkResult, total: number, reason: string): string {
  return `${verb} ${result.done.length} of ${total}; ${reason}`;
}
