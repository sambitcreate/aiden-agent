/**
 * Adapted from t3code apps/server/src/device/localSshDeviceHost.ts @ a6ec88f7 (MIT)
 *
 * Detects an SSH target that is really this Mac, whose simulators already
 * appear under "This Mac". `ssh -G` resolves the user's ssh_config without
 * opening a connection; a name lookup follows only when the resolved hostname
 * is not already an IP address. Both run only from a user action (Test
 * connection, Connect, Refresh), never at startup.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { SshDeviceHostConfig } from "../../../renderer/shared/device-ssh-hosts.js";

export interface LocalSshTargetDeps {
  /** Runs `ssh -G …` and returns its stdout, or null when ssh failed. */
  sshConfig(args: readonly string[]): Promise<string | null>;
  lookup(hostname: string): Promise<string[]>;
  localAddresses(): ReadonlySet<string>;
}

/** The `ssh -G` arguments for one host entry. */
export function sshConfigArgs(host: Pick<SshDeviceHostConfig, "target" | "port" | "identityFile">): string[] {
  return [
    "-G",
    ...(host.port === undefined ? [] : ["-p", String(host.port)]),
    ...(host.identityFile ? ["-i", host.identityFile] : []),
    "--",
    host.target,
  ];
}

/** `ssh -G` prints one `key value` pair per line, with lower-case keys. */
export function parseSshConfigOutput(stdout: string): Map<string, string> {
  const config = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).toLowerCase();
    if (!config.has(key)) config.set(key, line.slice(separator + 1).trim());
  }
  return config;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

export async function isLocalSshTarget(
  host: Pick<SshDeviceHostConfig, "target" | "port" | "identityFile">,
  deps: LocalSshTargetDeps,
): Promise<boolean> {
  const stdout = await deps.sshConfig(sshConfigArgs(host)).catch(() => null);
  if (stdout === null) return false;
  const config = parseSshConfigOutput(stdout);
  // A forwarded port or a proxy can lead to another machine even when the name is local.
  if (config.get("port") !== "22") return false;
  for (const key of ["proxycommand", "proxyjump"]) {
    const value = config.get(key);
    if (value !== undefined && value !== "none") return false;
  }
  const hostname = config.get("hostname")?.replace(/^\[|\]$/gu, "");
  if (!hostname) return false;
  const addresses = isIP(hostname) ? [hostname] : await deps.lookup(hostname).catch(() => []);
  const local = deps.localAddresses();
  return addresses.length > 0 && addresses.every((address) => local.has(address) || isLoopback(address));
}

export function defaultLocalSshTargetDeps(
  sshConfig: LocalSshTargetDeps["sshConfig"],
): LocalSshTargetDeps {
  return {
    sshConfig,
    lookup: async (hostname) => {
      const timeout = new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Name lookup timed out.")), 2_000).unref(),
      );
      const entries = await Promise.race([lookup(hostname, { all: true }), timeout]);
      return entries.map((entry) => entry.address);
    },
    localAddresses: () =>
      new Set(
        Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? []),
      ),
  };
}
