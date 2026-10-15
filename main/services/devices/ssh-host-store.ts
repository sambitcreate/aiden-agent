/**
 * SSH device hosts persist beside the simulator consent, in
 * `userData/devices/ssh-hosts.json`, because what they authorize (installs on
 * the user's own machines) is device-local like the local installs.
 *
 * Each host also records which helper installs the user approved on it.
 * Approving the hub install is the consent that later lets an explicit user
 * action update it when Aiden pins a new version; nothing is installed on a
 * host the user never approved.
 */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parseSshDeviceHostConfigs,
  type SshDeviceHostConfig,
} from "../../../renderer/shared/device-ssh-hosts.js";
import { writeJsonAtomic } from "../durable-fs.js";

export interface SshHostToolConsent {
  hub: boolean;
  agent: boolean;
}

export interface StoredSshHosts {
  hosts: SshDeviceHostConfig[];
  toolConsent: Record<string, SshHostToolConsent>;
}

export const EMPTY_SSH_HOSTS: StoredSshHosts = { hosts: [], toolConsent: {} };

export function sshHostsPath(baseDir: string): string {
  return path.join(baseDir, "ssh-hosts.json");
}

/** Fails closed: an unreadable or invalid file is treated as no hosts, never as partial ones. */
export function parseStoredSshHosts(text: string): StoredSshHosts {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { hosts: [], toolConsent: {} };
  }
  if (typeof value !== "object" || value === null) return { hosts: [], toolConsent: {} };
  const record = value as { version?: unknown; hosts?: unknown; toolConsent?: unknown };
  if (record.version !== 1) return { hosts: [], toolConsent: {} };
  const hosts = parseSshDeviceHostConfigs(record.hosts);
  if (!hosts) return { hosts: [], toolConsent: {} };
  const toolConsent: Record<string, SshHostToolConsent> = {};
  const consent = typeof record.toolConsent === "object" && record.toolConsent !== null ? record.toolConsent : {};
  for (const host of hosts) {
    const entry = (consent as Record<string, unknown>)[host.id];
    if (typeof entry !== "object" || entry === null) continue;
    const hub = (entry as { hub?: unknown }).hub === true;
    // Agent tools build on the hub, so agent consent never survives without it.
    toolConsent[host.id] = { hub, agent: hub && (entry as { agent?: unknown }).agent === true };
  }
  return { hosts, toolConsent };
}

export async function readSshHosts(baseDir: string): Promise<StoredSshHosts> {
  return parseStoredSshHosts(await readFile(sshHostsPath(baseDir), "utf8").catch(() => ""));
}

export async function writeSshHosts(baseDir: string, stored: StoredSshHosts): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const ids = new Set(stored.hosts.map((host) => host.id));
  const toolConsent = Object.fromEntries(Object.entries(stored.toolConsent).filter(([id]) => ids.has(id)));
  await writeJsonAtomic(
    sshHostsPath(baseDir),
    { version: 1, hosts: stored.hosts, toolConsent },
    { space: 2, trailingNewline: true },
  );
}
