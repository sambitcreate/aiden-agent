import { connect } from "node:net";
import { get as httpsGet } from "node:https";
import { userInfo } from "node:os";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
  type AidenTailscaleCommandRunner,
} from "../../../main/services/aiden-remote-tailscale.js";
import { remoteDaemonCommand } from "./daemon-control.ts";
import { tailscaleSetupMessage, type RemoteNetwork } from "./remote.ts";

/** What this machine's Tailscale can do for the Aiden server, read without changing anything. */
export interface TailscaleFacts {
  installed: boolean;
  signedIn: boolean;
  dnsName?: string;
  httpsCertificates: boolean;
  funnelOn443: boolean;
  /** Linux only: Serve changes need root or the Tailscale operator. Absent when Tailscale's settings could not be read. */
  operatorNeeded?: boolean;
  /** An exit node is on without local network access, which can cut off phones on the same Wi-Fi. */
  exitNodeWithoutLan?: boolean;
}

export interface TailscaleHost { platform: NodeJS.Platform; uid: number; user: string }

const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

function systemTailscaleHost(): TailscaleHost {
  const info = userInfo();
  return { platform: process.platform, uid: info.uid, user: info.username };
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Reads Tailscale's status, Serve config and settings. Every read is optional: an unreadable fact is left out. */
export async function readTailscaleFacts(runner: AidenTailscaleCommandRunner | null, host: TailscaleHost = systemTailscaleHost()): Promise<TailscaleFacts> {
  const status = await new AidenRemoteTailscaleController(runner).status();
  if (!status.installed || !runner) return { installed: false, signedIn: false, httpsCertificates: false, funnelOn443: false };
  const signedIn = status.dnsName !== undefined && status.errorCode !== "not_connected" && status.errorCode !== "status_unavailable";
  const funnelOn443 = Object.entries(status.serveStatus?.AllowFunnel ?? {}).some(([authority, allowed]) => allowed === true && authority.endsWith(":443"));
  const facts: TailscaleFacts = {
    installed: true,
    signedIn,
    ...(status.dnsName ? { dnsName: status.dnsName } : {}),
    httpsCertificates: status.httpsAvailable === true,
    funnelOn443,
  };
  const prefs = await runner.run(["debug", "prefs"]).then(jsonRecord, () => undefined);
  if (!prefs) return facts;
  if (host.platform === "linux") facts.operatorNeeded = host.uid !== 0 && prefs.OperatorUser !== host.user;
  const exitNode = (typeof prefs.ExitNodeID === "string" && prefs.ExitNodeID !== "") || (typeof prefs.ExitNodeIP === "string" && prefs.ExitNodeIP !== "");
  facts.exitNodeWithoutLan = exitNode && prefs.ExitNodeAllowLANAccess !== true;
  return facts;
}

/** Tailscale can carry the Aiden route right now, with nothing for the person to fix first. */
export function tailscaleReady(facts: TailscaleFacts): boolean {
  return facts.installed && facts.signedIn && facts.httpsCertificates && !facts.funnelOn443 && facts.operatorNeeded !== true;
}

/**
 * Cloud providers (AWS, GCP, Azure, DigitalOcean, Hetzner, Linode, Vultr,
 * Oracle) answer at this link-local metadata address; home and office
 * networks do not. A plain TCP connect skips HTTP proxies that would answer
 * for any address.
 */
export function looksLikeCloudServer(timeoutMs = 300, open: typeof connect = connect): Promise<boolean> {
  return new Promise((resolveCloud) => {
    const socket = open({ host: "169.254.169.254", port: 80, timeout: timeoutMs });
    const settle = (found: boolean) => { socket.destroy(); resolveCloud(found); };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** The network to suggest: Tailscale on a cloud server, both when Tailscale is ready, else the local network. */
export function recommendNetwork(facts: TailscaleFacts, cloud: boolean): RemoteNetwork {
  if (cloud) return "tailscale";
  return tailscaleReady(facts) ? "both" : "local";
}

function signInFix(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Open the Tailscale app and sign in." : "Run `sudo tailscale up` and sign in.";
}

/** One line on what Tailscale needs before Aiden can use it, or that it is ready. */
export function tailscaleSummary(facts: TailscaleFacts, platform: NodeJS.Platform): string {
  if (!facts.installed) return "Tailscale: not installed on this server (https://tailscale.com/download).";
  if (!facts.signedIn) return `Tailscale: installed but not signed in. ${signInFix(platform)}`;
  if (!facts.httpsCertificates) return `Tailscale: signed in as ${facts.dnsName}, but HTTPS certificates are off. Turn them on at ${ADMIN_DNS_URL}.`;
  if (facts.operatorNeeded) return `Tailscale: signed in as ${facts.dnsName}. Run \`sudo tailscale set --operator=$USER\` once so Aiden can add its route.`;
  if (facts.funnelOn443) return `Tailscale: signed in as ${facts.dnsName}, but public Funnel is on for HTTPS port 443. Turn it off first.`;
  return `Tailscale: ready as ${facts.dnsName}.`;
}

/** The install question, with what is ready on this machine and the suggested answer as the default. */
export function networkQuestion(facts: TailscaleFacts, cloud: boolean, platform: NodeJS.Platform): { text: string; recommended: RemoteNetwork } {
  const recommended = recommendNetwork(facts, cloud);
  const lines = [
    "Who should be able to reach this server?",
    "  1) Local network only: phones on the same Wi-Fi or LAN",
    "  2) Tailscale only: your devices from anywhere",
    "  3) Both",
    "",
    tailscaleSummary(facts, platform),
  ];
  if (cloud) lines.push("This looks like a cloud server, so phones cannot reach it over a local network. Tailscale is the way in.");
  lines.push("");
  return { text: lines.join("\n"), recommended };
}

export type CheckState = "ok" | "fail" | "warn" | "off";
export interface CheckItem { state: CheckState; text: string }

/** Every Tailscale step in order. Steps that depend on an earlier failed one are left out. */
export function tailscaleChecklist(facts: TailscaleFacts, platform: NodeJS.Platform): CheckItem[] {
  if (!facts.installed) return [{ state: "fail", text: "Tailscale is not installed. Install it from https://tailscale.com/download." }];
  const items: CheckItem[] = [{ state: "ok", text: "Tailscale is installed" }];
  if (!facts.signedIn) return [...items, { state: "fail", text: `Tailscale is not signed in or not running. ${signInFix(platform)}` }];
  items.push({ state: "ok", text: `Signed in as ${facts.dnsName}` });
  items.push(facts.httpsCertificates
    ? { state: "ok", text: "HTTPS certificates are on" }
    : { state: "fail", text: `HTTPS certificates are off for this tailnet. Turn them on at ${ADMIN_DNS_URL} (HTTPS Certificates).` });
  if (facts.operatorNeeded !== undefined) {
    items.push(facts.operatorNeeded
      ? { state: "fail", text: "This user may not change Tailscale Serve settings. Run `sudo tailscale set --operator=$USER` once." }
      : { state: "ok", text: "This user may change Tailscale Serve settings" });
  }
  items.push(facts.funnelOn443
    ? { state: "fail", text: "Public Funnel is on for HTTPS port 443, and Aiden will not put its private route behind it. Turn that Funnel off." }
    : { state: "ok", text: "No public Funnel on HTTPS port 443" });
  if (facts.exitNodeWithoutLan) {
    items.push({ state: "warn", text: "An exit node is on without local network access, so phones on the same Wi-Fi may not reach this server. Run `sudo tailscale set --exit-node-allow-lan-access=true` if you use the local network." });
  }
  return items;
}

/** The parts of `remote status` the check reads. */
export interface ServerReachability {
  connectionMode?: string;
  running?: boolean;
  lanEndpoint?: string;
  tailscaleEndpoint?: string;
  tailscaleConnected?: boolean;
  tailscaleErrorCode?: string;
}

/** `remote status` from the running server, or undefined when none answers within `timeoutMs`. */
export async function remoteServerStatus(agentDir: string, timeoutMs = 5_000): Promise<ServerReachability | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolveLate) => { timer = setTimeout(() => resolveLate(undefined), timeoutMs); });
  try {
    return await Promise.race([remoteDaemonCommand(agentDir, "remote", ["status"]).then((value) => value as ServerReachability, () => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How the running server can be reached. `answered` is the live Tailscale check, when one ran. */
export function serverChecklist(server: ServerReachability | undefined, facts: TailscaleFacts, cloud: boolean, answered?: boolean): CheckItem[] {
  if (!server) return [{ state: "fail", text: "The Aiden server is not running. Start it with `aiden service install` or `aiden serve`." }];
  if (server.running === false) return [{ state: "fail", text: "Remote access is off. Start the server without `--no-remote`." }];
  const mode = server.connectionMode;
  const items: CheckItem[] = [];
  if (mode === "lan" || mode === "both") {
    items.push(server.lanEndpoint ? { state: "ok", text: `Local network: on at ${server.lanEndpoint}` } : { state: "fail", text: "Local network: on, but not listening. See the server log." });
    if (cloud) items.push({ state: "warn", text: "This looks like a cloud server, so phones cannot reach it over a local network. Use Tailscale: `aiden remote network tailscale`." });
  } else {
    items.push({ state: "off", text: "Local network: off (Tailscale only). `aiden remote network both` turns it on." });
  }
  if (mode !== "tailscale" && mode !== "both") {
    items.push(tailscaleReady(facts)
      ? { state: "off", text: "Tailscale: off, though it is ready. `aiden remote network both` turns it on." }
      : { state: "off", text: "Tailscale: off" });
    return items;
  }
  if (!server.tailscaleConnected) {
    const reason = server.tailscaleErrorCode ? tailscaleSetupMessage(`tailscale_${server.tailscaleErrorCode}`) : undefined;
    items.push({ state: "fail", text: reason ?? `Tailscale: Aiden's route is not connected. Run \`aiden remote network ${mode}\` to connect it.` });
    return items;
  }
  items.push({ state: "ok", text: "Tailscale: Aiden's route is connected" });
  if (answered === true) items.push({ state: "ok", text: `${server.tailscaleEndpoint} answers` });
  if (answered === false) items.push({ state: "fail", text: `${server.tailscaleEndpoint} did not answer. The first connection can take up to a minute while Tailscale gets the HTTPS certificate; run \`aiden remote check\` again shortly.` });
  return items;
}

const MARK: Record<CheckState, string> = { ok: "✓", fail: "✗", warn: "!", off: "–" };

export function formatChecklist(title: string, items: CheckItem[]): string {
  return [title, ...items.map((item) => `  ${MARK[item.state]} ${item.text}`)].join("\n");
}

/** GET `<endpoint>/health` and accept only Aiden's own answer. Never rejects. */
export function probeAidenHealth(endpoint: string, timeoutMs: number, options: { ca?: string | Buffer } = {}): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (healthy: boolean) => { if (!settled) { settled = true; clearTimeout(deadline); request.destroy(); resolveProbe(healthy); } };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    const request = httpsGet(`${endpoint.replace(/\/+$/u, "")}/health`, { headers: { accept: "application/json" }, ...(options.ca ? { ca: options.ca } : {}) }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > 4096) finish(false); });
      response.on("end", () => finish(response.statusCode === 200 && jsonRecord(body)?.ok === true));
      response.on("error", () => finish(false));
    });
    request.on("error", () => finish(false));
  });
}

/**
 * Wait until the Tailscale address answers, retrying for up to `budgetMs`.
 * The first HTTPS request to a new Serve name makes Tailscale fetch its
 * certificate, which can take a while; doing it here keeps the phone's first
 * connection from stalling.
 */
export async function waitForTailscaleAddress(endpoint: string, signal: AbortSignal, budgetMs = 45_000, probe: typeof probeAidenHealth = probeAidenHealth): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!signal.aborted) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    if (await probe(endpoint, Math.min(15_000, left))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1_000, Math.max(0, deadline - Date.now()))));
  }
  return false;
}

/** Before a Tailscale QR: confirm the address answers, and say so when it does not. */
export async function checkTailscaleAddress(agentDir: string, signal: AbortSignal, out: NodeJS.WritableStream, err: NodeJS.WritableStream, wait: typeof waitForTailscaleAddress = waitForTailscaleAddress): Promise<void> {
  const status = await remoteServerStatus(agentDir);
  const endpoint = status?.tailscaleConnected ? status.tailscaleEndpoint : undefined;
  if (!endpoint || signal.aborted) return;
  out.write(`Checking that ${endpoint} answers. The first time can take up to a minute while Tailscale gets its HTTPS certificate.\n`);
  if (await wait(endpoint, signal)) return;
  if (!signal.aborted) err.write(`aiden: ${endpoint} did not answer yet. The code below still works once it does; \`aiden remote check\` shows what is missing.\n`);
}

export interface RemoteCheckDependencies {
  runner?: AidenTailscaleCommandRunner | null;
  host?: TailscaleHost;
  cloud?: () => Promise<boolean>;
  probe?: (endpoint: string) => Promise<boolean>;
  out?: NodeJS.WritableStream;
}

/** `aiden remote check`: every step between a phone and this server, with the fix for each one that fails. */
export async function remoteCheckCommand(agentDir: string, dependencies: RemoteCheckDependencies = {}): Promise<boolean> {
  const host = dependencies.host ?? systemTailscaleHost();
  const runner = dependencies.runner === undefined ? await createSystemTailscaleCommandRunner() : dependencies.runner;
  const [facts, cloud, server] = await Promise.all([
    readTailscaleFacts(runner, host),
    (dependencies.cloud ?? (() => looksLikeCloudServer()))(),
    remoteServerStatus(agentDir),
  ]);
  const endpoint = server?.tailscaleConnected ? server.tailscaleEndpoint : undefined;
  const answered = endpoint ? await (dependencies.probe ?? ((value) => probeAidenHealth(value, 20_000)))(endpoint) : undefined;
  // A local-network-only server does not need Tailscale: its gaps are worth showing, not failing on.
  const tailscale = tailscaleChecklist(facts, host.platform)
    .map((item) => server?.connectionMode === "lan" && item.state === "fail" ? { ...item, state: "off" as const } : item);
  const aiden = serverChecklist(server, facts, cloud, answered);
  (dependencies.out ?? process.stdout).write(`${formatChecklist("Tailscale on this machine", tailscale)}\n\n${formatChecklist("Aiden server", aiden)}\n`);
  return ![...tailscale, ...aiden].some((item) => item.state === "fail");
}
