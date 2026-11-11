import * as fs from "node:fs/promises";
import path from "node:path";
import { botDirectoryName } from "../bot-runtime/harness-host.js";
import { writeFileAtomic } from "../durable-fs.js";
import { publicComposioWatchProbeResult, type ComposioWatchProbeResult } from "./connector-watch-composio-probe.js";

export const COMPOSIO_INSPECTION_FILE = "connector-watch-composio-inspection.json";
const MAX_RECORD_BYTES = 32 * 1024;

function validDiagnostic(record: ComposioWatchProbeResult): boolean {
  const view = publicComposioWatchProbeResult(record);
  return record.checkedAt === view.checkedAt && record.status === view.status && record.code === view.code;
}

/** Structural evidence produced by the probe, kept beside the Bot's private session. */
export async function saveComposioWatchInspection(
  profileDir: string,
  botId: string,
  result: ComposioWatchProbeResult,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  await assertCurrent();
  if (!validDiagnostic(result)) throw new Error("The inspection diagnostic is invalid.");
  const profile = await fs.realpath(profileDir);
  const directory = path.join(profile, "bots", botDirectoryName(botId));
  const original = await fs.lstat(directory);
  if (!original.isDirectory() || original.isSymbolicLink() || await fs.realpath(directory) !== directory) {
    throw new Error("The Bot's private directory is unavailable.");
  }
  const file = path.join(directory, COMPOSIO_INSPECTION_FILE);
  // Only the probe's closed, host-private structural view is retained. No raw response is accepted here.
  const data = JSON.stringify({ version: 1, checkedAt: result.checkedAt, status: result.status, code: result.code,
    ...(result.privateProof ? { privateProof: result.privateProof } : {}) });
  if (Buffer.byteLength(data) + 1 > MAX_RECORD_BYTES) throw new Error("The inspection record is too large.");
  const check = async () => {
    await assertCurrent();
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
      || await fs.realpath(directory) !== directory) throw new Error("The Bot's private directory changed.");
    try {
      const target = await fs.lstat(file);
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error("The inspection record is unsafe.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await assertCurrent();
  };
  await check();
  try {
    const existingInfo = await fs.lstat(file);
    if (existingInfo.size > MAX_RECORD_BYTES) throw new Error("The saved inspection diagnostic is invalid.");
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as ComposioWatchProbeResult & { version?: unknown };
    if (!existing || typeof existing !== "object" || Array.isArray(existing) || existing.version !== 1
      || Object.keys(existing).some((key) => !["version", "checkedAt", "status", "code", "privateProof"].includes(key))
      || !validDiagnostic(existing) || existing.privateProof !== undefined && (!existing.privateProof || typeof existing.privateProof !== "object" || Array.isArray(existing.privateProof))) {
      throw new Error("The saved inspection diagnostic is invalid or from a newer version.");
    }
    // The caller holds the Bot's mutation lock. A slower old inspection must
    // not replace evidence from a request that began more recently.
    if (existing.checkedAt >= result.checkedAt) { await check(); return; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // No mkdir: a removed Bot must never be recreated by an inspection finishing late.
  await writeFileAtomic(file, `${data}\n`, { mode: 0o600, beforePublish: check });
}
