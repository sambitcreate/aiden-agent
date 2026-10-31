import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

/**
 * Resolve and start the Electron binary once before any spec. Resolving it
 * downloads a missing binary, and the first start of a fresh binary on macOS
 * waits for its signature check; neither belongs inside a spec's own timeout.
 */
export default async function globalSetup(): Promise<void> {
  const electron = createRequire(import.meta.url)("electron") as string;
  // Warming only: a refused start (for example as root) is left to the specs.
  await promisify(execFile)(electron, ["--version"], { timeout: 120_000 }).catch(() => undefined);
}
