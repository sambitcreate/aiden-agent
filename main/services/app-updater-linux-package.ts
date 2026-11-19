import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "../shared/path-containment.js";

/** The distro package formats Aiden publishes and can update in place. */
export type LinuxPackageKind = "deb" | "rpm";

/** The root-run installer, relative to the install folder (see scripts/aiden-package-install.sh). */
export const LINUX_PACKAGE_HELPER = path.join("Helpers", "aiden-package-install");

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
    // Installed by the package manager: system-owned and not writable by the
    // person, including the helper that root runs to install the update.
    const helper = path.join(installDir, LINUX_PACKAGE_HELPER);
    for (const file of [executable, installDir, resources, path.dirname(helper), helper]) {
      const info = lstatSync(file);
      if (info.uid !== systemUid || (info.mode & 0o022) !== 0) return null;
    }
    if (!isExecutableFile(helper)) return null;
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
  /** The root-owned installer helper shipped in the package. */
  helper: string;
  /** The package electron-updater downloaded and checked against the feed. */
  installer: string;
  /** Base64 SHA-512 from the release feed. */
  sha512: string;
  /** The version the feed announced. */
  version: string;
  uid?: number;
  run?: CommandRunner;
  tools?: LinuxPackageTools;
  log?: (message: string) => void;
}

function installedVersion(kind: LinuxPackageKind, tools: LinuxPackageTools): [string, string[]] {
  return kind === "deb"
    ? [tools.dpkgQuery, ["--showformat=${Version}", "--show", LINUX_PACKAGE_NAME]]
    : [tools.rpm, ["-q", "--queryformat", "%{VERSION}", LINUX_PACKAGE_NAME]];
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-6).join(" | ").slice(0, 800);
}

/**
 * Install a downloaded Aiden DEB or RPM with the system package manager, after
 * the person approves it in the desktop's password prompt (pkexec).
 *
 * The download sits in the person's own cache, so every check that matters
 * happens as root inside the shipped helper (scripts/aiden-package-install.sh):
 * it copies the file into a root-only folder and verifies that copy's digest,
 * package name and version before apt-get or dnf sees it. The installed
 * version is read back before this reports success.
 */
export async function installLinuxPackageUpdate(options: LinuxPackageInstallOptions): Promise<LinuxPackageInstallOutcome> {
  const tools = options.tools ?? LINUX_PACKAGE_TOOLS;
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(options.sha512) || !/^\d+\.\d+\.\d+$/u.test(options.version) || !path.isAbsolute(options.installer)) {
    return "failed";
  }
  const sha512Hex = Buffer.from(options.sha512, "base64").toString("hex");
  const command = [options.helper, options.kind, options.installer, sha512Hex, options.version];
  const elevated = options.uid === 0;
  const result = elevated ? await run(command[0]!, command.slice(1)) : await run(tools.pkexec, command);
  // pkexec exits 126 when the person closes the password prompt.
  if (!elevated && result.code === 126) return "cancelled";
  if (result.code === 3) {
    log(`The downloaded package is not the verified ${LINUX_PACKAGE_NAME} ${options.version}.`);
    return "failed";
  }
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
}
