// Keep metadata work small enough for the default filesystem thread pool.
export const WORKSPACE_METADATA_CONCURRENCY = 4;

/** Ordered metadata batches; drain outstanding work before cancellation/error. */
export async function mapWorkspaceMetadata<T, R>(
  items: readonly T[],
  inspect: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("The workspace operation was cancelled.");
  };
  for (let offset = 0; offset < items.length; offset += WORKSPACE_METADATA_CONCURRENCY) {
    checkCancelled();
    const settled = await Promise.allSettled(
      items.slice(offset, offset + WORKSPACE_METADATA_CONCURRENCY).map(inspect),
    );
    checkCancelled();
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}
