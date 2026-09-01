import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Publish an already-validated deterministic bundle through an atomic replace. */
export async function writeDesignProjectExport(target: string, bytes: Uint8Array): Promise<void> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > 82 * 1024 * 1024
  ) {
    throw new Error("The Design export bytes are invalid.");
  }
  const directory = path.dirname(target);
  const staging = path.join(directory, `.aiden-design-export.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(staging, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
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
  } catch {
    await fs.rm(staging, { force: true }).catch(() => undefined);
    throw new Error("Aiden could not write the Design source bundle.");
  }
}
