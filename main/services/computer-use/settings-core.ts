export interface ComputerUseSettingsDependencies {
  readPersisted(): Promise<boolean>;
  persist(enabled: boolean, isCurrent?: () => boolean): Promise<void>;
  setRuntimeEnabled(enabled: boolean): void;
  cancelComputerUseGenerations(): void;
}

function staleDocumentError(): Error {
  return new Error("The renderer document is no longer active.");
}

/** Serializes persisted beta-gate changes while closing the live gate eagerly. */
export class ComputerUseSettingsCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private latestRequest = 0;
  private desiredEnabled: boolean | null = null;
  private disableRequired = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: ComputerUseSettingsDependencies) {}

  /** Seal new mutations and drain every admitted persistence transaction before quit. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.tail.then(async () => {
      if (!this.disableRequired) return;
      if ((await this.dependencies.readPersisted()) !== false) {
        await this.dependencies.persist(false, () => true);
      }
      if ((await this.dependencies.readPersisted()) !== false) {
        throw new Error("Computer Use could not persist its disabled state before quit.");
      }
    });
    return this.shutdownPromise;
  }

  /** Reopen only when quit was cancelled before irreversible service shutdown. */
  resumeAfterCancelledShutdown(): void {
    this.closed = false;
    this.shutdownPromise = null;
  }

  private currentDesiredEnabled(): boolean | null {
    return this.desiredEnabled;
  }

  setEnabled(enabled: boolean, isCurrent: () => boolean): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Computer Use settings are shutting down."));
    }
    if (!isCurrent()) return Promise.reject(staleDocumentError());
    const request = ++this.latestRequest;
    this.desiredEnabled = enabled;

    // Closing is a kill switch, so it must not wait for the filesystem or an
    // older queued transition. Persistence failure never reopens this process.
    if (!enabled) {
      this.disableRequired = true;
      this.dependencies.setRuntimeEnabled(false);
      this.dependencies.cancelComputerUseGenerations();
    }

    const operation = this.tail.then(
      () => this.apply(request, enabled, isCurrent),
      () => this.apply(request, enabled, isCurrent),
    );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async apply(request: number, enabled: boolean, isCurrent: () => boolean): Promise<void> {
    if (!enabled) {
      // Disabling is a kill switch admitted while the owner was current. It
      // remains safe and must become durable even if that document then exits.
      await this.dependencies.persist(false, () => true);
      return;
    }

    if (!isCurrent()) throw staleDocumentError();

    const previous = await this.dependencies.readPersisted();
    if (!isCurrent() || request !== this.latestRequest || this.desiredEnabled !== true) {
      throw staleDocumentError();
    }

    try {
      await this.dependencies.persist(true, isCurrent);
    } catch (error) {
      this.dependencies.setRuntimeEnabled(
        this.disableRequired || this.currentDesiredEnabled() === false ? false : previous,
      );
      throw error;
    }

    const desiredAfterPersist = this.currentDesiredEnabled();
    if (!isCurrent() || request !== this.latestRequest || desiredAfterPersist !== true) {
      const rollback = this.disableRequired || desiredAfterPersist === false ? false : previous;
      try {
        await this.dependencies.persist(rollback, () => true);
      } finally {
        this.dependencies.setRuntimeEnabled(rollback);
      }
      throw staleDocumentError();
    }

    this.disableRequired = false;
    this.dependencies.setRuntimeEnabled(true);
  }
}
