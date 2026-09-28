// Shared budget for bulk workspace-index metadata and legacy file issuance.
export const WORKSPACE_METADATA_CONCURRENCY = 4;
const MAX_WAITING_BATCHES = 64;
let batchActive = false;
const waitingBatches: Array<() => void> = [];

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The workspace operation was cancelled.");
}

/** FIFO batch admission; queued cancellation must not wait for filesystem I/O. */
function acquireBatch(signal?: AbortSignal): Promise<() => void> {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", cancel);
      batchActive = true;
      resolve(() => {
        const next = waitingBatches.shift();
        if (next) next();
        else batchActive = false;
      });
    };
    const cancel = () => {
      const index = waitingBatches.indexOf(start);
      if (index !== -1) waitingBatches.splice(index, 1);
      signal?.removeEventListener("abort", cancel);
      reject(new Error("The workspace operation was cancelled."));
    };
    if (!batchActive) start();
    else if (waitingBatches.length >= MAX_WAITING_BATCHES) {
      reject(new Error("Too many workspace metadata requests. Try again in a moment."));
    } else {
      waitingBatches.push(start);
      signal?.addEventListener("abort", cancel, { once: true });
    }
  });
}

/** Ordered batches with a shared budget; drain started work before releasing it. */
export async function mapWorkspaceMetadata<T, R>(
  items: readonly T[],
  inspect: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += WORKSPACE_METADATA_CONCURRENCY) {
    const release = await acquireBatch(signal);
    try {
      checkCancelled(signal);
      const settled = await Promise.allSettled(
        items.slice(offset, offset + WORKSPACE_METADATA_CONCURRENCY).map(async item => inspect(item)),
      );
      checkCancelled(signal);
      for (const result of settled) {
        if (result.status === "rejected") throw result.reason;
        results.push(result.value);
      }
    } finally { release(); }
  }
  return results;
}
