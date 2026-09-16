import * as path from "node:path";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { DataStore } from "./data-store.js";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

export type AidenLiveThreadOutcome = "active" | "stopped" | "failed" | "disconnected";

export interface AidenLiveThreadRecord {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  endedAt?: string;
  outcome: AidenLiveThreadOutcome;
  model: string;
  computerUseEnabled: boolean;
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/u.test(id);
}

/**
 * Metadata-only journal for Aiden Live sessions. Each start gets an isolated
 * directory; audio, captions, screenshots, prompts, and tool payloads are
 * deliberately absent from this contract.
 */
export class AidenLiveThreadStore {
  private readonly stores = new Map<string, DataStore<AidenLiveThreadRecord>>();
  private readonly begun = new Set<string>();

  constructor(
    private readonly root: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(input: { id: string; model: string; computerUseEnabled: boolean }): Promise<void> {
    const store = this.store(input.id);
    await store.save({
      schemaVersion: 1,
      id: input.id,
      startedAt: this.now().toISOString(),
      outcome: "active",
      model: input.model,
      computerUseEnabled: input.computerUseEnabled,
    });
    this.begun.add(input.id);
  }

  async finish(id: string, outcome: Exclude<AidenLiveThreadOutcome, "active">): Promise<void> {
    if (!validId(id)) throw new Error("Invalid Aiden Live thread id.");
    if (!this.begun.has(id) && !(await this.hasPersistedActiveRecord(id))) return;
    const store = this.store(id);
    await store.update((record) => {
      if (record.id !== id || record.outcome !== "active") return;
      record.outcome = outcome;
      record.endedAt = this.now().toISOString();
    });
    this.begun.delete(id);
    this.stores.delete(id);
  }

  /** Close metadata records left active by a crash without restoring any media or captions. */
  async reconcileActive(): Promise<number> {
    const threadsRoot = path.join(this.root(), "threads");
    let entries: Dirent<string>[];
    try {
      entries = await readdir(threadsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let reconciled = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      try {
        const bytes = await readRegularFile(
          path.join(threadsRoot, entry.name, "thread.json"),
          8 * 1_024,
        );
        const record = JSON.parse(decodeUtf8(bytes)) as Partial<AidenLiveThreadRecord>;
        if (record.id !== entry.name || record.schemaVersion !== 1 || record.outcome !== "active") {
          continue;
        }
        this.begun.add(entry.name);
        await this.finish(entry.name, "disconnected");
        reconciled += 1;
      } catch {
        // A corrupt or unsafe record is never overwritten during recovery.
      }
    }
    return reconciled;
  }

  private async hasPersistedActiveRecord(id: string): Promise<boolean> {
    try {
      const bytes = await readRegularFile(
        path.join(this.root(), "threads", id, "thread.json"),
        8 * 1_024,
      );
      const record = JSON.parse(decodeUtf8(bytes)) as Partial<AidenLiveThreadRecord>;
      if (record.schemaVersion !== 1 || record.id !== id || record.outcome !== "active") {
        return false;
      }
      this.begun.add(id);
      return true;
    } catch {
      return false;
    }
  }

  private store(id: string): DataStore<AidenLiveThreadRecord> {
    if (!validId(id)) throw new Error("Invalid Aiden Live thread id.");
    const existing = this.stores.get(id);
    if (existing) return existing;
    const created = new DataStore<AidenLiveThreadRecord>(
      "thread.json",
      {
        schemaVersion: 1,
        id,
        startedAt: "1970-01-01T00:00:00.000Z",
        outcome: "active",
        model: "unknown",
        computerUseEnabled: false,
      },
      () => path.join(this.root(), "threads", id),
      { maxBytes: 8 * 1_024, fileMode: 0o600 },
    );
    this.stores.set(id, created);
    return created;
  }
}
