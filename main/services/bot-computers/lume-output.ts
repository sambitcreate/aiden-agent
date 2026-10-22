import { isIP } from "node:net";

/**
 * What Aiden reads from `lume get --format json` and `lume ls --format json`.
 * Lume 0.6.1 prints a pretty JSON array of `VMDetails` (src/VM/VMDetails.swift)
 * and its logger may print `[timestamp] LEVEL: …` lines to stdout first.
 */
export interface LumeVmInfo {
  name: string;
  state: "stopped" | "running" | "provisioning" | "unknown";
  ip?: string;
  vnc?: { host: string; port: number };
  /** `provisioning (stale)`: creation was interrupted and won't finish. */
  stale?: boolean;
  /** Lume found the guest's SSH port open. */
  sshAvailable?: boolean;
  /** Bytes the sparse disk really uses. */
  diskAllocatedBytes?: number;
}

const LOG_LINE = /^\[\d{4}-\d{2}-\d{2}T[^\]]*\] (?:DEBUG|INFO|WARN|WARNING|ERROR): /u;

function jsonPayload(stdout: string): unknown {
  const body = stdout
    .split(/\r?\n/u)
    .filter((line) => !LOG_LINE.test(line))
    .join("\n")
    .trim();
  if (!body) throw new Error("Lume printed no VM details.");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Lume printed VM details Aiden can't read.");
  }
}

function parseVnc(value: unknown): LumeVmInfo["vnc"] {
  if (typeof value !== "string" || !value.startsWith("vnc://")) return undefined;
  try {
    // vnc://:<password>@127.0.0.1:<port>. The password is Aiden's own and is
    // deliberately not kept from here.
    const url = new URL(`http://${value.slice("vnc://".length)}`);
    const port = Number(url.port);
    const host = url.hostname.replace(/^\[(.*)\]$/u, "$1");
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

function parseEntry(value: unknown): LumeVmInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Lume VM details were not an object.");
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error("Lume VM details had no name.");
  const status = typeof entry.status === "string" ? entry.status : "";
  let state: LumeVmInfo["state"] = "unknown";
  let stale = false;
  if (status === "running" || status === "stopped") state = status;
  else if (status === "provisioning") state = "provisioning";
  else if (status === "provisioning (stale)") {
    state = "provisioning";
    stale = true;
  }
  const info: LumeVmInfo = { name: entry.name, state };
  if (stale) info.stale = true;
  if (typeof entry.ipAddress === "string" && isIP(entry.ipAddress)) info.ip = entry.ipAddress;
  if (typeof entry.sshAvailable === "boolean") info.sshAvailable = entry.sshAvailable;
  const vnc = parseVnc(entry.vncUrl);
  if (vnc) info.vnc = vnc;
  const disk = entry.diskSize as { allocated?: unknown } | undefined;
  if (disk && typeof disk.allocated === "number" && Number.isSafeInteger(disk.allocated) && disk.allocated >= 0) {
    info.diskAllocatedBytes = disk.allocated;
  }
  return info;
}

export function parseLumeVmList(stdout: string): LumeVmInfo[] {
  if (/^No virtual machines found/mu.test(stdout) && !stdout.includes("[")) return [];
  const payload = jsonPayload(stdout);
  if (!Array.isArray(payload)) throw new Error("Lume's VM list was not an array.");
  return payload.map(parseEntry);
}

/** `lume get` prints a one-element array. */
export function parseLumeVmInfo(stdout: string): LumeVmInfo {
  const payload = jsonPayload(stdout);
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length !== 1) throw new Error("Lume returned details for more than one VM.");
  return parseEntry(entries[0]);
}

export type LumeErrorKind = "vm_limit" | "not_found" | "stale" | "not_running" | "other";

/**
 * Map Lume's diagnostics to what Aiden does next. The VM-limit text comes from
 * Virtualization.framework (VZErrorDomain code 6, `virtualMachineLimitExceeded`)
 * and is assumed until recorded on the owner Mac.
 */
export function classifyLumeError(stderr: string, exitCode: number | null): LumeErrorKind {
  if (exitCode === 0) return "other";
  const text = stderr.slice(-16_384);
  if (
    /VZErrorDomain\W+Code=6\b/u.test(text) ||
    /virtual machines? exceeds? the limit/iu.test(text) ||
    /maximum supported number of active virtual machines/iu.test(text) ||
    /virtualMachineLimitExceeded/u.test(text)
  ) {
    return "vm_limit";
  }
  if (/Virtual machine not found\b/u.test(text) || /\bVM '[^'\n]*' not found\b/u.test(text)) return "not_found";
  if (/still being provisioned/iu.test(text) || /provisioning \(stale\)/u.test(text)) return "stale";
  if (/Virtual machine not running\b/u.test(text) || /\bis not running\b/iu.test(text)) return "not_running";
  return "other";
}

/** Whether a VNC endpoint is a loopback address (G22). */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  return bare === "127.0.0.1" || bare === "::1" || bare === "localhost";
}
