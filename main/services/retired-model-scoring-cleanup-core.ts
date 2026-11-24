// Delete-only cleanup of what the retired model scoring left on disk: the
// OpenRouter benchmark and Artificial Analysis keys and caches, and the
// measured-pace file. Nothing reads these any more. The cleanup makes no
// network request, never recreates anything, can run any number of times, and
// never throws: one failed deletion is reported and the rest still run.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** What the desktop app stored: files in its userData directory, keys in its Pi credential store. */
export const RETIRED_DESKTOP_MODEL_SCORING = {
  files: ["openrouter-benchmark-cache.json", "artificial-analysis-model-cache.json", "model-pace.json"],
  credentialIds: ["aiden-internal:model-pad-openrouter-benchmarks-v1", "artificial-analysis"],
} as const;

/** What `aiden insights` stored: files in the agent directory, keys in `credentials/insights.json`. */
export const RETIRED_SERVER_MODEL_SCORING = {
  files: ["aa-insights.json", "openrouter-insights.json"],
  credentialIds: ["aa", "openrouter"],
} as const;

export interface RetiredModelScoringCleanupDependencies {
  /** The directory the retired files lived in. */
  directory: string;
  files: readonly string[];
  credentialIds: readonly string[];
  credentials: {
    /** Whether the credential is stored, so a missing one costs no credential-store write. */
    has(id: string): Promise<boolean>;
    delete(id: string): Promise<void>;
  };
  /** Defaults to a forced `rm`, which treats a missing file as already removed. */
  removeFile?(filePath: string): Promise<void>;
  /** Called once per item that could not be removed; the item is a file name or credential id. */
  onFailure?(item: string, error: unknown): void;
}

export interface RetiredModelScoringCleanupResult {
  /** File names and credential ids that could not be removed this time. */
  failed: string[];
}

const removeFileForcefully = (filePath: string) => fs.rm(filePath, { force: true });

/** Remove every retired file and credential; resolves with what failed, never rejects. */
export async function removeRetiredModelScoringData(
  dependencies: RetiredModelScoringCleanupDependencies,
): Promise<RetiredModelScoringCleanupResult> {
  const removeFile = dependencies.removeFile ?? removeFileForcefully;
  const failed: string[] = [];
  const attempt = async (item: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failed.push(item);
      try {
        dependencies.onFailure?.(item, error);
      } catch {
        // Diagnostics cannot turn a quiet cleanup into a failure.
      }
    }
  };
  await Promise.all([
    ...dependencies.files.map((file) =>
      attempt(file, () => removeFile(path.join(dependencies.directory, path.basename(file)))),
    ),
    ...dependencies.credentialIds.map((id) =>
      attempt(id, async () => {
        if (await dependencies.credentials.has(id)) await dependencies.credentials.delete(id);
      }),
    ),
  ]);
  return { failed };
}
