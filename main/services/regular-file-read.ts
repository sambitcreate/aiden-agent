import * as fs from "fs/promises";
import { constants } from "node:fs";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";

/**
 * Read through an already-open descriptor so a pathname swap cannot turn a
 * validated config/credential file into a blocking FIFO or followed symlink.
 */
export async function readRegularFile(filePath: string): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error(`Refusing to read a non-regular file at ${filePath}.`);
      Object.assign(error, { code: "EFTYPE" });
      throw error;
    }
    const bytes = await handle.readFile();
    recordDiagnosticCounter("filesystem:read", { bytesOut: bytes.byteLength });
    return bytes;
  } finally {
    await handle.close();
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  // Buffer.toString("utf-8") replaces malformed byte sequences with U+FFFD.
  // Config and credential files must instead fail closed so a later write can
  // never turn invalid source bytes into a different, apparently valid file.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function readRegularUtf8File(filePath: string): Promise<string> {
  return decodeUtf8(await readRegularFile(filePath));
}
