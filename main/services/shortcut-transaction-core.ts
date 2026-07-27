/**
 * Serialize runtime-backed settings transactions from their first read through
 * persistence and any rollback. Keeping the rollback inside the same queue is
 * what prevents a failed older write from overwriting a newer runtime state.
 */
export class ShortcutPersistenceRollbackError extends Error {
  constructor(
    readonly persistenceError: unknown,
    readonly rollbackError: unknown,
  ) {
    const persistenceMessage =
      persistenceError instanceof Error
        ? persistenceError.message
        : String(persistenceError);
    const rollbackMessage =
      rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    super(
      `Settings could not be saved (${persistenceMessage}), and the previous shortcuts could not be restored (${rollbackMessage}). Restart Aiden before changing shortcuts again.`,
    );
    this.name = "ShortcutPersistenceRollbackError";
  }
}

export function createShortcutTransactionQueue<State, Applied>() {
  let tail = Promise.resolve();

  const run = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const transact = <Value>({
    read,
    prepare,
    apply,
  }: {
    read: () => Promise<State>;
    prepare: (
      previous: State,
    ) => Promise<{
      next: State;
      persist: () => Promise<void>;
      value: Value;
    }> | {
      next: State;
      persist: () => Promise<void>;
      value: Value;
    };
    apply: (state: State) => Promise<Applied>;
  }): Promise<{ applied: Applied; value: Value }> =>
    run(async () => {
      const previous = await read();
      const prepared = await prepare(previous);
      const applied = await apply(prepared.next);
      try {
        await prepared.persist();
      } catch (error) {
        try {
          await apply(previous);
        } catch (rollbackError) {
          throw new ShortcutPersistenceRollbackError(error, rollbackError);
        }
        throw error;
      }
      return { applied, value: prepared.value };
    });

  return { run, transact };
}
