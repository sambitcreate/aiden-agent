import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "../shared/path-containment.js";

/** The distro package formats Aiden publishes and can update in place. */
export type LinuxPackageKind = "deb" | "rpm";

/** The package name in both the DEB and RPM metadata. */
export const LINUX_PACKAGE_NAME = "aiden-agent";

/**
 * Fixed absolute tool paths. Nothing is looked up on PATH, and nothing runs
 * through a shell: pkexec receives the package manager and its arguments as
 * separate argv entries.
 */
export interface LinuxPackageTools {
  pkexec: string;
  aptGet: string;
  dpkgDeb: string;
  dpkgQuery: string;
  dnf: string;
  rpm: string;
}

export const LINUX_PACKAGE_TOOLS: LinuxPackageTools = Object.freeze({
  pkexec: "/usr/bin/pkexec",
  aptGet: "/usr/bin/apt-get",
  dpkgDeb: "/usr/bin/dpkg-deb",
  dpkgQuery: "/usr/bin/dpkg-query",
  dnf: "/usr/bin/dnf",
  rpm: "/usr/bin/rpm",
});

export interface LinuxPackageUpdateRuntime {
  resourcesPath: string;
  executablePath: string;
  appImage?: string;
  uid?: number;
  tools?: LinuxPackageTools;
  /** Where dpkg records which files each package owns. */
  dpkgInfoDir?: string;
  /** The owner a package-manager install gives the app's files (root). */
  systemUid?: number;
}

function isExecutableFile(file: string): boolean {
  try {
    const info = statSync(file);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The package format electron-builder recorded in the app's resources. */
export function linuxPackageKind(resourcesPath: string): LinuxPackageKind | null {
  try {
    const kind = readFileSync(path.join(resourcesPath, "package-type"), "utf8").trim();
    return kind === "deb" || kind === "rpm" ? kind : null;
  } catch {
    return null;
  }
}

/**
 * A DEB or RPM install updates itself only when the system package manager
 * really owns the running copy and the tools to install a newer package exist.
 * Returns the package format, or null when updates belong to the person.
 */
export function canUpdateLinuxPackage(runtime: LinuxPackageUpdateRuntime): LinuxPackageKind | null {
  try {
    // An AppImage that happens to carry a package-type file is never a distro install.
    if (runtime.appImage) return null;
    const kind = linuxPackageKind(runtime.resourcesPath);
    if (!kind) return null;
    const tools = runtime.tools ?? LINUX_PACKAGE_TOOLS;
    const systemUid = runtime.systemUid ?? 0;
    const executable = realpathSync(runtime.executablePath);
    const installDir = path.dirname(executable);
    const resources = realpathSync(runtime.resourcesPath);
    if (!isPathInside(installDir, resources, { allowRoot: false })) return null;
    // Installed by the package manager: system-owned and not writable by the person.
    for (const file of [executable, installDir, resources]) {
      const info = lstatSync(file);
      if (info.uid !== systemUid || (info.mode & 0o022) !== 0) return null;
    }
    const config = lstatSync(path.join(resources, "app-update.yml"));
    if (!config.isFile() || config.size === 0 || config.size > 65_536) return null;
    const needed = kind === "deb"
      ? [tools.aptGet, tools.dpkgDeb, tools.dpkgQuery]
      : [tools.dnf, tools.rpm];
    // The person approves the install in the desktop's own password prompt.
    if (runtime.uid !== 0) needed.push(tools.pkexec);
    if (!needed.every(isExecutableFile)) return null;
    if (kind === "deb") {
      const owned = readFileSync(path.join(runtime.dpkgInfoDir ?? "/var/lib/dpkg/info", `${LINUX_PACKAGE_NAME}.list`), "utf8");
      if (!owned.split("\n").includes(executable)) return null;
    }
    return kind;
  } catch {
    return null;
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
      // A non-zero exit carries its numeric code; a spawn failure carries a string such as ENOENT.
      const exit = (error as { code?: unknown } | null)?.code;
      const code = error ? (typeof exit === "number" ? exit : null) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export type LinuxPackageInstallOutcome = "installed" | "cancelled" | "failed";

export interface LinuxPackageInstallOptions {
  kind: LinuxPackageKind;
  /** The package electron-updater downloaded and checked against the feed. */
  installer: string;
  /** Base64 SHA-512 from the release feed. */
  sha512: string;
  /** The version the feed announced. */
  version: string;
  uid?: number;
  run?: CommandRunner;
  tools?: LinuxPackageTools;
  tmpdir?: string;
  log?: (message: string) => void;
}

/** Copy into a private folder while hashing, so the bytes installed are the bytes checked. */
async function stageVerifiedPackage(installer: string, sha512: string, directory: string, kind: LinuxPackageKind): Promise<string> {
  const staged = path.join(directory, `${LINUX_PACKAGE_NAME}.${kind}`);
  const source = await open(installer, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size === 0) throw new Error("The downloaded package is unavailable.");
    const target = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha512");
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0;
      while (copied < info.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - copied), copied);
        if (bytesRead === 0) throw new Error("The downloaded package was truncated.");
        hash.update(buffer.subarray(0, bytesRead));
        await target.write(buffer, 0, bytesRead);
        copied += bytesRead;
      }
      if (hash.digest("base64") !== sha512) throw new Error("The downloaded package does not match the update feed.");
      await target.sync();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
  return staged;
}

function packageMetadata(kind: LinuxPackageKind, file: string, tools: LinuxPackageTools): [string, string[]] {
  return kind === "deb"
    ? [tools.dpkgDeb, ["--showformat=${Package}\\n${Version}\\n", "--show", file]]
    : [tools.rpm, ["-qp", "--nosignature", "--nodigest", "--queryformat", "%{NAME}\\n%{VERSION}\\n", file]];
}

function installedVersion(kind: LinuxPackageKind, tools: LinuxPackageTools): [string, string[]] {
  return kind === "deb"
    ? [tools.dpkgQuery, ["--showformat=${Version}", "--show", LINUX_PACKAGE_NAME]]
    : [tools.rpm, ["-q", "--queryformat", "%{VERSION}", LINUX_PACKAGE_NAME]];
}

function installCommand(kind: LinuxPackageKind, file: string, tools: LinuxPackageTools): string[] {
  return kind === "deb"
    ? [tools.aptGet, "install", "--yes", file]
    : [tools.dnf, "install", "--assumeyes", file];
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-6).join(" | ").slice(0, 800);
}

/**
 * Install a downloaded Aiden DEB or RPM with the system package manager, after
 * the person approves it in the desktop's password prompt (pkexec). The
 * package must be Aiden's own package at the announced version, and the
 * installed version is read back before this reports success.
 */
export async function installLinuxPackageUpdate(options: LinuxPackageInstallOptions): Promise<LinuxPackageInstallOutcome> {
  const tools = options.tools ?? LINUX_PACKAGE_TOOLS;
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(options.sha512) || !/^\d+\.\d+\.\d+$/u.test(options.version)) return "failed";
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(options.tmpdir ?? os.tmpdir(), "aiden-update-"));
    await chmod(directory, 0o700);
    const staged = await stageVerifiedPackage(options.installer, options.sha512, directory, options.kind);

    const [metaFile, metaArgs] = packageMetadata(options.kind, staged, tools);
    const metadata = await run(metaFile, metaArgs);
    const [name, version] = metadata.stdout.split("\n").map((line) => line.trim());
    if (metadata.code !== 0 || name !== LINUX_PACKAGE_NAME || version !== options.version) {
      log(`The downloaded package is not ${LINUX_PACKAGE_NAME} ${options.version}.`);
      return "failed";
    }

    const command = installCommand(options.kind, staged, tools);
    const elevated = options.uid === 0;
    const result = elevated ? await run(command[0]!, command.slice(1)) : await run(tools.pkexec, command);
    // pkexec exits 126 when the person closes the password prompt.
    if (!elevated && result.code === 126) return "cancelled";
    if (result.code !== 0) {
      log(`The package manager could not install the update (exit ${result.code ?? "signal"}): ${tail(result.stderr || result.stdout)}`);
      return "failed";
    }

    const [checkFile, checkArgs] = installedVersion(options.kind, tools);
    const installed = await run(checkFile, checkArgs);
    if (installed.code !== 0 || installed.stdout.trim() !== options.version) {
      log(`After installing, the system reports ${LINUX_PACKAGE_NAME} ${installed.stdout.trim() || "missing"}.`);
      return "failed";
    }
    return "installed";
  } catch (error) {
    log(`The update package could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
