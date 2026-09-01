import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryFact, MemoryScope } from "./memory-store.js";

export const AIDEN_MEMORY_EXPORT_VERSION = 1 as const;

export interface AidenMemoryExportV1 {
  schema: "aiden.memory.export";
  version: typeof AIDEN_MEMORY_EXPORT_VERSION;
  exportedAt: string;
  scope: MemoryScope;
  facts: MemoryFact[];
}

export function projectAidenMemoryExport(
  scope: MemoryScope,
  facts: readonly MemoryFact[],
  exportedAt = new Date().toISOString(),
): AidenMemoryExportV1 {
  return {
    schema: "aiden.memory.export",
    version: AIDEN_MEMORY_EXPORT_VERSION,
    exportedAt,
    scope: { ...scope },
    facts: facts.map((fact) => ({
      ...fact,
      scope: { ...fact.scope },
      provenance: { ...fact.provenance },
    })),
  };
}

export async function writeAidenMemoryExport(
  target: string,
  scope: MemoryScope,
  facts: readonly MemoryFact[],
): Promise<void> {
  const serialized = `${JSON.stringify(projectAidenMemoryExport(scope, facts), null, 2)}\n`;
  const directory = path.dirname(target);
  const staging = path.join(directory, `.aiden-memory-export.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(staging, "wx", 0o600);
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staging, target);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function safeMemoryExportFileName(scope: MemoryScope): string {
  const safeId = scope.id.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80) || "memory";
  return `${scope.kind}-${safeId}.aiden-memory.json`;
}
