import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertRegularFile(file, { executable = false, describe } = {}) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file) {
    throw new Error(
      describe
        ? `${describe} must be a regular, non-symlinked file: ${file}`
        : `Expected a regular non-symlinked package file: ${file}`,
    );
  }
  if (executable && (info.mode & 0o111) === 0) {
    throw new Error(`Expected an executable package file: ${file}`);
  }
  return info;
}
