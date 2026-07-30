type SnapshotListener = () => Promise<void>;

let listener: SnapshotListener | null = null;
let mutationTail: Promise<void> = Promise.resolve();

export function setPortableCredentialSnapshotListener(next: SnapshotListener): void {
  listener = next;
}

export async function syncPortableCredentialSnapshot(): Promise<void> {
  await listener?.();
}

/**
 * Complete the config mutation's own credential queue before reconciling the
 * shared portable snapshot. The listener may enter both provider and MCP
 * queues, so invoking it from inside either queue would self-deadlock.
 */
export function mutatePortableConfigAndSync<R>(mutation: () => Promise<R>): Promise<R> {
  const result = mutationTail.then(async () => {
    // Establish the last-safe baseline before the mutation can reload and
    // absorb an unrelated external edit. The post-mutation sync can then
    // reconcile that exact transition instead of seeding too late.
    await listener?.();
    const value = await mutation();
    await listener?.();
    return value;
  });
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
