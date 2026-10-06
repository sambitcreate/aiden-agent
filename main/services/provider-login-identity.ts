import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Lazy, installation-local identity used only when a provider's explicit login requests it. */
export function createProviderLoginDeviceId(filePath: () => string): () => string {
  let cached: string | undefined;
  return () => {
    if (cached) return cached;
    const destination = filePath();
    const read = (): string => {
      const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 128) throw new Error("Invalid provider login identity file.");
        const id = readFileSync(fd, "utf8").trim();
        if (!UUID.test(id)) throw new Error("Invalid provider login identity file.");
        return id;
      } finally {
        closeSync(fd);
      }
    };
    try {
      cached = read();
      return cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, `${randomUUID()}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Publish a complete file without replacing a concurrent process's identity.
      try {
        linkSync(temporary, destination);
        if (process.platform !== "win32") {
          const directory = openSync(dirname(destination), constants.O_RDONLY);
          try { fsyncSync(directory); } finally { closeSync(directory); }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      cached = read();
      return cached;
    } finally {
      unlinkSync(temporary);
    }
  };
}
