import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { atomicJson } from "./state.ts";

const LEGACY = "azure-openai-responses";
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function renameProvider(entries: Record<string, unknown>): void {
  if (!Object.hasOwn(entries, LEGACY)) return;
  if (Object.hasOwn(entries, "azure") && !isDeepStrictEqual(entries.azure, entries[LEGACY])) {
    throw new Error("Both Azure provider identities contain different configuration. Reconcile azure and azure-openai-responses before continuing; neither endpoint was overwritten.");
  }
  entries.azure = entries[LEGACY];
  delete entries[LEGACY];
}
function modelKey(key: string): string {
  return key.startsWith(`${LEGACY}/`) ? `azure/${key.slice(LEGACY.length + 1)}` : key;
}
function renameModelKeys(value: unknown): void {
  const entries = record(value);
  if (!entries) return;
  for (const key of Object.keys(entries)) {
    const next = modelKey(key);
    if (next === key) continue;
    if (!Object.hasOwn(entries, next)) entries[next] = entries[key];
    delete entries[key];
  }
}

/** Runs before Pi reads settings, including AIDEN_CODING_AGENT_DIR overrides.
 * Credentials use the separate encrypted CredentialStore migration. Match Pi's
 * file lock protocol, and publish each file atomically; every step is repeatable.
 */
export function migrateCliAzureConfig(agentDir: string, cwd = process.cwd()): void {
  const files: Array<[string, "settings" | "models" | "cache"]> = [
    [join(agentDir, "models.json"), "models"],
    [join(agentDir, "models-store.json"), "cache"],
    [join(agentDir, "settings.json"), "settings"],
    [join(cwd, ".aiden", "settings.json"), "settings"],
  ];
  for (const [file, kind] of files) {
    if (!existsSync(file) || !readFileSync(file, "utf8").includes(LEGACY)) continue;
    const release = lockfile.lockSync(file, { realpath: false });
    try {
      const source = readFileSync(file, "utf8");
      const data = record(JSON.parse(source.replace(/^\uFEFF/u, "")));
      if (!data) throw new Error(`Expected a JSON object in ${file}.`);
      const before = JSON.stringify(data);
      if (kind === "models") {
        const providers = record(data.providers);
        if (providers) renameProvider(providers);
      } else if (kind === "cache") {
        // Prefer a current cache, without merging endpoints or deployments.
        if (Object.hasOwn(data, LEGACY)) {
          if (!Object.hasOwn(data, "azure")) {
            const entry = record(data[LEGACY]);
            data.azure = entry && Array.isArray(entry.models)
              ? { ...entry, models: entry.models.map((model) => ({ ...record(model), provider: "azure" })) }
              : data[LEGACY];
          }
          delete data[LEGACY];
        }
      } else {
        if (data.defaultProvider === LEGACY) data.defaultProvider = "azure";
        renameModelKeys(data.modelThinkingLevels);
        renameModelKeys(record(data.compaction)?.modelOverrides);
        if (Array.isArray(data.enabledModels)) data.enabledModels = [...new Set(data.enabledModels.map((value: unknown) => typeof value === "string" ? modelKey(value) : value))];
      }
      if (JSON.stringify(data) !== before) atomicJson(file, data);
    } finally { release(); }
  }
}
