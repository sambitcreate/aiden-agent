import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import {
  planAidenTailscaleConnect,
  planAidenTailscaleDisconnect,
  type AidenTailscaleOwnership,
  type AidenTailscaleStatus,
} from "./aiden-remote-tailscale-route.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
] as const;
const MAX_STATUS_BYTES = 256 * 1_024;

export interface AidenTailscaleCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

export interface AidenTailscaleConnectionStatus {
  installed: boolean;
  dnsName?: string;
  httpsAvailable?: boolean;
  serveStatus?: AidenTailscaleStatus;
  errorCode?: "not_installed" | "not_connected" | "https_unavailable" | "status_unavailable";
}

interface AidenTailscaleNodeStatus {
  dnsName?: string;
  httpsAvailable: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBoundedJson(serialized: string, label: string): unknown {
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATUS_BYTES) {
    throw new Error(`${label}_too_large`);
  }
  return parseAidenRemoteJson(serialized, label);
}

function normalizeDnsName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const dnsName = value.trim().replace(/\.$/u, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(dnsName)
    ? dnsName
    : undefined;
}

function parseNodeStatus(serialized: string): AidenTailscaleNodeStatus {
  const root = record(parseBoundedJson(serialized, "Tailscale status"));
  const self = record(root?.Self);
  const dnsName = normalizeDnsName(self?.DNSName);
  const certDomains = Array.isArray(root?.CertDomains)
    ? root.CertDomains.map(normalizeDnsName).filter((value): value is string => value !== undefined)
    : [];
  return {
    ...(dnsName ? { dnsName } : {}),
    // An exact certificate-domain match proves that the tailnet owner has
    // already enabled HTTPS. Aiden never follows or accepts Tailscale's
    // interactive authorization flow on the owner's behalf.
    httpsAvailable: dnsName !== undefined && certDomains.includes(dnsName),
  };
}

function parseServeStatus(serialized: string): AidenTailscaleStatus {
  const value = parseBoundedJson(serialized, "Tailscale Serve status");
  if (!record(value)) throw new Error("tailscale_status_invalid");
  return value as AidenTailscaleStatus;
}

export async function resolveTailscaleBinary(): Promise<string | null> {
  for (const candidate of TAILSCALE_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through fixed, trusted installation locations.
    }
  }
  return null;
}

export async function createSystemTailscaleCommandRunner(): Promise<AidenTailscaleCommandRunner | null> {
  const binary = await resolveTailscaleBinary();
  if (!binary) return null;
  return {
    run: async (args) => {
      const { stdout } = await execFileAsync(binary, [...args], {
        encoding: "utf8",
        maxBuffer: MAX_STATUS_BYTES,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout;
    },
  };
}

export class AidenRemoteTailscaleController {
  constructor(private readonly runner: AidenTailscaleCommandRunner | null) {}

  private async serveStatus(): Promise<AidenTailscaleStatus> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    return parseServeStatus(await this.runner.run(["serve", "status", "--json"]));
  }

  private async nodeStatus(): Promise<AidenTailscaleNodeStatus> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    return parseNodeStatus(await this.runner.run(["status", "--json"]));
  }

  async status(): Promise<AidenTailscaleConnectionStatus> {
    if (!this.runner) return { installed: false, errorCode: "not_installed" };
    try {
      const [nodeStatus, serveStatus] = await Promise.all([
        this.nodeStatus(),
        this.serveStatus(),
      ]);
      const errorCode = !nodeStatus.dnsName
        ? "not_connected" as const
        : !nodeStatus.httpsAvailable
          ? "https_unavailable" as const
          : undefined;
      return {
        installed: true,
        ...(nodeStatus.dnsName ? { dnsName: nodeStatus.dnsName } : {}),
        httpsAvailable: nodeStatus.httpsAvailable,
        ...(errorCode ? { errorCode } : {}),
        serveStatus,
      };
    } catch {
      return { installed: true, errorCode: "status_unavailable" };
    }
  }

  async connect(
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<AidenTailscaleOwnership> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    const [nodeStatus, serveStatus] = await Promise.all([
      this.nodeStatus(),
      this.serveStatus(),
    ]);
    if (!nodeStatus.dnsName) throw new Error("tailscale_not_connected");
    const plan = planAidenTailscaleConnect(
      serveStatus,
      target,
      ownership,
      nodeStatus.httpsAvailable,
    );
    if (plan.action === "set") {
      const [command, ...args] = plan.args!;
      await this.runner.run([command!, "--yes", "--bg", ...args]);
    }
    const verified = planAidenTailscaleConnect(
      await this.serveStatus(),
      target,
      plan.ownership,
    );
    if (verified.action !== "noop") throw new Error("tailscale_route_verification_failed");
    return plan.ownership;
  }

  async disconnect(
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<void> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    const plan = planAidenTailscaleDisconnect(await this.serveStatus(), target, ownership);
    if (plan.action === "clear") await this.runner.run(plan.args!);
    const verified = planAidenTailscaleDisconnect(
      await this.serveStatus(),
      target,
      ownership,
    );
    if (verified.action !== "noop") throw new Error("tailscale_route_verification_failed");
  }
}
