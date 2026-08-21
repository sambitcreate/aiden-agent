import type { CreateImagesWorkflowMutationResult } from "../shared/create-images/ipc";
import type { WorkflowDocumentV1 } from "../shared/create-images/schema";

export type CreateImagesAutosaveStatus =
  | { state: "saved"; workflow: WorkflowDocumentV1 }
  | { state: "dirty"; workflow: WorkflowDocumentV1 }
  | { state: "saving"; workflow: WorkflowDocumentV1 }
  | {
      state: "conflict";
      workflow: WorkflowDocumentV1;
      current: WorkflowDocumentV1;
      expectedRevision: number;
      currentRevision: number;
    }
  | { state: "error"; workflow: WorkflowDocumentV1; message: string };

interface WorkflowAutosaveOptions {
  delayMs?: number;
  autosaveEnabled?: boolean;
  now?: () => string;
  save(request: {
    expectedRevision: number;
    workflow: WorkflowDocumentV1;
  }): Promise<CreateImagesWorkflowMutationResult>;
}

function contentFingerprint(workflow: WorkflowDocumentV1): string {
  const { revision: _revision, updatedAt: _updatedAt, ...content } = workflow;
  return JSON.stringify(content);
}

export class WorkflowAutosaveController {
  private persisted: WorkflowDocumentV1;
  private draft: WorkflowDocumentV1;
  private persistedFingerprint: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<CreateImagesAutosaveStatus> | undefined;
  private blocked = false;
  private disposed = false;
  private readonly listeners = new Set<
    (status: CreateImagesAutosaveStatus) => void
  >();
  private statusValue: CreateImagesAutosaveStatus;
  private readonly delayMs: number;
  private readonly now: () => string;
  private autosaveEnabled: boolean;

  constructor(
    initial: WorkflowDocumentV1,
    private readonly options: WorkflowAutosaveOptions,
  ) {
    this.persisted = structuredClone(initial);
    this.draft = structuredClone(initial);
    this.persistedFingerprint = contentFingerprint(initial);
    this.statusValue = { state: "saved", workflow: structuredClone(initial) };
    this.delayMs = options.delayMs ?? 900;
    this.autosaveEnabled = options.autosaveEnabled ?? true;
    this.now = options.now ?? (() => new Date().toISOString());
    if (
      !Number.isFinite(this.delayMs) ||
      this.delayMs < 0 ||
      this.delayMs > 60_000
    ) {
      throw new Error("Invalid Create Images autosave delay.");
    }
  }

  status(): CreateImagesAutosaveStatus {
    return this.statusValue;
  }

  subscribe(
    listener: (status: CreateImagesAutosaveStatus) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.statusValue);
    return () => this.listeners.delete(listener);
  }

  private publish(status: CreateImagesAutosaveStatus): void {
    this.statusValue = status;
    for (const listener of this.listeners) listener(status);
  }

  setAutosaveEnabled(enabled: boolean): void {
    if (this.disposed || this.autosaveEnabled === enabled) return;
    this.autosaveEnabled = enabled;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (
      enabled &&
      !this.blocked &&
      !this.flushing &&
      contentFingerprint(this.draft) !== this.persistedFingerprint
    ) {
      this.scheduleAutosave();
    }
  }

  private scheduleAutosave(): void {
    if (!this.autosaveEnabled || this.disposed || this.blocked) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  update(next: WorkflowDocumentV1): void {
    if (this.disposed || next.id !== this.persisted.id) return;
    this.draft = structuredClone(next);
    if (this.blocked) {
      if (this.statusValue.state === "conflict") {
        this.publish({
          ...this.statusValue,
          workflow: structuredClone(this.draft),
        });
      } else if (this.statusValue.state === "error") {
        this.publish({
          ...this.statusValue,
          workflow: structuredClone(this.draft),
        });
      }
      return;
    }
    if (contentFingerprint(next) === this.persistedFingerprint) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.statusValue.state !== "saved") {
        this.publish({
          state: "saved",
          workflow: structuredClone(this.persisted),
        });
      }
      return;
    }
    this.publish({ state: "dirty", workflow: structuredClone(this.draft) });
    this.scheduleAutosave();
  }

  flush(): Promise<CreateImagesAutosaveStatus> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.flushing) return this.flushing;
    if (!this.autosaveEnabled) return Promise.resolve(this.statusValue);
    return this.startFlush();
  }

  saveNow(): Promise<CreateImagesAutosaveStatus> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.flushing) return this.flushing;
    return this.startFlush();
  }

  private startFlush(): Promise<CreateImagesAutosaveStatus> {
    if (
      this.blocked ||
      contentFingerprint(this.draft) === this.persistedFingerprint
    ) {
      return Promise.resolve(this.statusValue);
    }
    this.flushing = this.flushUntilCurrent().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushUntilCurrent(): Promise<CreateImagesAutosaveStatus> {
    while (
      !this.blocked &&
      contentFingerprint(this.draft) !== this.persistedFingerprint
    ) {
      const savingDraft = structuredClone(this.draft);
      const expectedRevision = this.persisted.revision;
      const candidate: WorkflowDocumentV1 = {
        ...savingDraft,
        createdAt: this.persisted.createdAt,
        revision: expectedRevision + 1,
        updatedAt: this.now(),
      };
      this.publish({ state: "saving", workflow: structuredClone(candidate) });
      let result: CreateImagesWorkflowMutationResult;
      try {
        result = await this.options.save({
          expectedRevision,
          workflow: candidate,
        });
      } catch {
        this.blocked = true;
        this.publish({
          state: "error",
          workflow: structuredClone(this.draft),
          message: "Aiden could not reach the device-local workflow store.",
        });
        break;
      }
      if (result.status === "saved") {
        this.persisted = structuredClone(result.workflow);
        this.persistedFingerprint = contentFingerprint(result.workflow);
        if (contentFingerprint(this.draft) === this.persistedFingerprint) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          this.draft = structuredClone(result.workflow);
          this.publish({
            state: "saved",
            workflow: structuredClone(result.workflow),
          });
        }
        continue;
      }
      if (result.status === "conflict") {
        this.blocked = true;
        this.publish({
          state: "conflict",
          workflow: structuredClone(this.draft),
          current: structuredClone(result.current),
          expectedRevision: result.expectedRevision,
          currentRevision: result.currentRevision,
        });
        break;
      }
      this.blocked = true;
      this.publish({
        state: "error",
        workflow: structuredClone(this.draft),
        message:
          result.status === "not-found"
            ? "This workflow no longer exists."
            : result.status === "unavailable"
              ? result.message
              : "The workflow store returned an unexpected result.",
      });
      break;
    }
    return this.statusValue;
  }

  replacePersisted(workflow: WorkflowDocumentV1): void {
    if (workflow.id !== this.persisted.id)
      throw new Error("Cannot replace a different workflow.");
    this.blocked = false;
    this.persisted = structuredClone(workflow);
    this.draft = structuredClone(workflow);
    this.persistedFingerprint = contentFingerprint(workflow);
    this.publish({ state: "saved", workflow: structuredClone(workflow) });
  }

  retry(): Promise<CreateImagesAutosaveStatus> {
    this.blocked = false;
    this.publish({ state: "dirty", workflow: structuredClone(this.draft) });
    return this.saveNow();
  }

  async dispose(): Promise<CreateImagesAutosaveStatus> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const status = await this.flush();
    this.disposed = true;
    return status;
  }
}

/**
 * Defers permanent disposal until the next task so React development Strict
 * Mode can replay an effect's cleanup/setup pair without poisoning the
 * controller that remains mounted. The returned callback cancels that pending
 * disposal when the effect is set up again.
 */
export function deferWorkflowAutosaveControllerDisposal(
  controller: WorkflowAutosaveController,
  onDisposed?: () => void,
): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    void controller.dispose().finally(onDisposed);
  }, 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
