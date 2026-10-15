import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const heldPaths = new Set<string>();

export function desktopLeaseHelperPath(runtime: {
  defaultApp: boolean;
  resourcesPath?: string;
  cwd: string;
} = {
  defaultApp: process.defaultApp === true,
  resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
  cwd: process.cwd(),
}): string {
  return runtime.defaultApp !== true && runtime.resourcesPath
    ? resolve(runtime.resourcesPath, "..", "Helpers", "aiden-lease-flock")
    : resolve(runtime.cwd, "build", "native", "aiden-lease-flock");
}

/**
 * `flock` belongs to an open file description on macOS and Linux. The short
 * helper locks a duplicate of our fd 3, then exits; this process retains the
 * same description until release or death. An unrelated read/open/close of the
 * guard cannot cancel this lock, unlike a POSIX SQLite transaction lock.
 */
export function tryAcquireProcessLifetimeLock(file: string, helper: string): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  if (heldPaths.has(canonical)) return null;
  heldPaths.add(canonical);
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error(`Unsafe lease guard at ${canonical}`);
    }
    const result = spawnSync(helper, [], {
      stdio: ["ignore", "pipe", "pipe", fd],
      timeout: 5_000,
      encoding: "utf8",
    });
    if (result.error || result.signal || (result.status !== 0 && result.status !== 10)) {
      throw new Error(`Cannot lock ${canonical}: ${result.error?.message ?? result.signal ?? result.stderr?.trim() ?? `helper exit ${result.status}`}`);
    }
    if (result.status === 10) {
      closeSync(fd);
      heldPaths.delete(canonical);
      return null;
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    heldPaths.delete(canonical);
    throw error;
  }
  const heldFd = fd;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(heldFd);
    heldPaths.delete(canonical);
  };
}
