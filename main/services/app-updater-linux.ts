import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export interface LinuxAppImageUpdateRuntime {
  appImage?: string;
  appDir?: string;
  resourcesPath: string;
  executablePath: string;
  mountInfo?: string;
  uid?: number;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** Type-2 AppImage ELF marker; arbitrary executables are never replacement inputs. */
export function isRegularAppImage(file: string, uid?: number): boolean {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file) || file.includes("\0")) return false;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1 || (uid !== undefined && metadata.uid !== uid)) return false;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(11);
    return readSync(fd, header, 0, header.length, 0) === header.length &&
      header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]));
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Only a mounted, replaceable AppImage owns its updates; distro packages stay external. */
export function canUpdateLinuxAppImage(runtime: LinuxAppImageUpdateRuntime): boolean {
  try {
    const image = runtime.appImage;
    const appDir = runtime.appDir;
    if (!image || !appDir || !path.isAbsolute(appDir) || !isRegularAppImage(image, runtime.uid)) return false;
    if (realpathSync(image) !== image || realpathSync(appDir) !== appDir || !statSync(appDir).isDirectory()) return false;
    const resources = realpathSync(runtime.resourcesPath);
    if (!inside(appDir, resources) || !inside(appDir, realpathSync(runtime.executablePath))) return false;
    const config = path.join(resources, "app-update.yml");
    const configStat = lstatSync(config);
    if (!configStat.isFile() || configStat.size === 0 || configStat.size > 65_536) return false;
    accessSync(config, constants.R_OK);
    try {
      if (readFileSync(path.join(resources, "package-type"), "utf8").trim() !== "appimage") return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    if ((lstatSync(image).mode & 0o300) !== 0o300) return false;
    accessSync(image, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(path.dirname(image), constants.W_OK | constants.X_OK);
    const mounts = runtime.mountInfo ?? readFileSync("/proc/self/mountinfo", "utf8");
    return mounts.split("\n").some((line) => {
      const [fields, filesystem] = line.split(" - ");
      const mount = fields?.split(" ")[4]?.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
      const type = filesystem?.split(" ")[0];
      return mount === appDir && (type === "fuse" || type?.startsWith("fuse.") === true || type === "squashfs");
    });
  } catch { return false; }
}

export interface AppImageIdentity { path: string; dev: number; ino: number; }
export function appImageIdentity(file: string): AppImageIdentity {
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error("The current AppImage is no longer a regular file.");
  return { path: file, dev: info.dev, ino: info.ino };
}

/** Keep the old image intact until the fully copied, digest-verified image is durable. */
export function replaceAppImageAtomically(options: {
  current: AppImageIdentity;
  installer: string;
  sha512: string;
  eligible: () => boolean;
}): string {
  const { current, installer, sha512 } = options;
  const stillCurrent = (): boolean => {
    const actual = appImageIdentity(current.path);
    return actual.dev === current.dev && actual.ino === current.ino;
  };
  if (!options.eligible() || !stillCurrent() || !isRegularAppImage(installer) ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(sha512)) throw new Error("AppImage update installation is unavailable.");
  const temporary = path.join(path.dirname(current.path), `.aiden-update-${randomUUID()}.tmp`);
  let source: number | undefined;
  let target: number | undefined;
  let directory: number | undefined;
  let temporaryExists = false;
  try {
    source = openSync(installer, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceInfo = fstatSync(source);
    if (!sourceInfo.isFile()) throw new Error("The downloaded AppImage is unavailable.");
    target = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryExists = true;
    const hash = createHash("sha512");
    const buffer = Buffer.alloc(1024 * 1024);
    let copied = 0;
    while (copied < sourceInfo.size) {
      const count = readSync(source, buffer, 0, Math.min(buffer.length, sourceInfo.size - copied), copied);
      if (count === 0) throw new Error("The downloaded AppImage was truncated.");
      hash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const bytes = writeSync(target, buffer, written, count - written);
        if (bytes === 0) throw new Error("The downloaded AppImage could not be copied.");
        written += bytes;
      }
      copied += count;
    }
    if (fstatSync(source).size !== sourceInfo.size || hash.digest("base64") !== sha512) throw new Error("The downloaded AppImage checksum changed.");
    fchmodSync(target, 0o755);
    fsyncSync(target);
    closeSync(target);
    target = undefined;
    if (!options.eligible() || !stillCurrent()) throw new Error("The current AppImage changed during installation.");
    renameSync(temporary, current.path);
    temporaryExists = false;
    directory = openSync(path.dirname(current.path), constants.O_RDONLY);
    fsyncSync(directory);
    return current.path;
  } finally {
    if (source !== undefined) closeSync(source);
    if (target !== undefined) closeSync(target);
    if (directory !== undefined) closeSync(directory);
    if (temporaryExists) unlinkSync(temporary);
  }
}
