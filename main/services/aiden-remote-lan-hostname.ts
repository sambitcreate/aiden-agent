import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MDNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

export interface AidenRemoteLanHostnames {
  /** The name phones are told to connect to on the local network. */
  endpoint: string;
  /** Every name the server certificate must cover, endpoint first. */
  certificate: string[];
}

export interface AidenRemoteLanHostnameOptions {
  platform?: NodeJS.Platform;
  osHostname?: () => string;
  /** Reads the macOS Bonjour name (`scutil --get LocalHostName`). */
  readLocalHostName?: () => Promise<string>;
}

async function readMacLocalHostName(): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/sbin/scutil",
    ["--get", "LocalHostName"],
    { timeout: 1_000, maxBuffer: 4_096, encoding: "utf8" },
  );
  return stdout;
}

/**
 * The local-network name for Aiden Remote. On macOS, `os.hostname()` is the
 * Unix host name, which can be a bare "Mac" or a router-assigned "x.lan" that
 * does not resolve on the LAN. Bonjour answers only for the LocalHostName, so
 * phones must be given `<LocalHostName>.local`. The Unix name stays on the
 * certificate so devices paired under it keep matching.
 */
export async function aidenRemoteLanHostnames(
  options: AidenRemoteLanHostnameOptions = {},
): Promise<AidenRemoteLanHostnames> {
  const platform = options.platform ?? process.platform;
  const unixName = (options.osHostname ?? os.hostname)();
  if (platform === "darwin") {
    let localHostName = "";
    try {
      localHostName = (await (options.readLocalHostName ?? readMacLocalHostName)()).trim();
    } catch {
      // Fall back to the Unix host name below.
    }
    if (MDNS_LABEL.test(localHostName)) {
      const endpoint = `${localHostName.toLowerCase()}.local`;
      return {
        endpoint,
        certificate: [...new Set([endpoint, ...(unixName ? [unixName] : [])])],
      };
    }
  }
  return { endpoint: unixName, certificate: unixName ? [unixName] : [] };
}
