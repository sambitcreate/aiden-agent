import { createHash } from "node:crypto";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AppSettings } from "./types.js";

interface MemorySettingsStore {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

function revision(enabled: boolean): string {
  return `rev_${createHash("sha256").update(JSON.stringify({ enabled })).digest("base64url")}`;
}

function project(settings: AppSettings) {
  const enabled = settings.memoryEnabled !== false;
  return { enabled, revision: revision(enabled) };
}

export class AidenRemoteMemorySettingsService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly store: MemorySettingsStore) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get() {
    return project(await this.store.getSettings());
  }

  async update(expectedRevision: string, input: unknown) {
    return this.serialized(async () => {
      const current = project(await this.store.getSettings());
      if (expectedRevision !== current.revision) {
        throw new AidenRemoteServiceError(
          "revision_conflict",
          "Memory settings changed. Refresh them before trying again.",
          409,
          false,
          { currentRevision: current.revision },
        );
      }
      const record =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null;
      if (
        !record ||
        Object.keys(record).length !== 2 ||
        record.confirmedForeground !== true ||
        typeof record.enabled !== "boolean"
      ) {
        throw new AidenRemoteServiceError(
          "permission_confirmation_required",
          "Memory settings require an explicit foreground confirmation.",
          409,
        );
      }
      return project(await this.store.setSettings({ memoryEnabled: record.enabled }));
    });
  }
}
