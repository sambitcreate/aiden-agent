import { execFile } from "node:child_process";
import { connect } from "node:net";
import { get as httpsGet } from "node:https";
import { userInfo } from "node:os";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
  type AidenTailscaleCommandRunner,
} from "../../../main/services/aiden-remote-tailscale.js";
import { aidenTailscaleFunnelOn443 } from "../../../main/services/aiden-remote-tailscale-route.js";
import { remoteDaemonCommand } from "./daemon-control.ts";
import type { RemoteNetwork } from "./remote.ts";
import { tailscaleSetupMessage } from "./tailscale-setup-message.ts";

/** What this machine's Tailscale can do for the Aiden server, read without changing anything. */
export interface TailscaleFacts {
  installed: boolean;
  signedIn: boolean;
  dnsName?: string;
  httpsCertificates: boolean;
  funnelOn443: boolean;
  /** Linux only: Serve changes need root or the Tailscale operator. Absent off Linux, or when Tailscale's settings could not be read. */
  operatorNeeded?: boolean;
  /** Linux, not root, and Tailscale's settings could not be read, so whether this user may change Serve is unknown. */
  operatorUnverified?: boolean;
  /** An exit node is on without local network access, which can cut off phones on the same Wi-Fi. */
  exitNodeWithoutLan?: boolean;
  /** Tailscale did not answer in time (for example a wedged tailscaled), so nothing else is known. */
  unresponsive?: boolean;
}

/** How long `remote check` and the install question wait for Tailscale before treating it as not answering. */
export const TAILSCALE_FACTS_TIMEOUT_MS = 10_000;

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

/**
 * Reads Tailscale's status, Serve config and settings. Every read is optional:
 * an unreadable fact is left out. A Tailscale that has not answered within
 * `timeoutMs` is reported as unresponsive rather than holding up the caller.
 */
export async function readTailscaleFacts(runner: AidenTailscaleCommandRunner | null, host: TailscaleHost = systemTailscaleHost(), timeoutMs = TAILSCALE_FACTS_TIMEOUT_MS, cancel?: AbortController): Promise<TailscaleFacts> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<TailscaleFacts>((resolveLate) => {
    timer = setTimeout(() => {
      // Stop the Tailscale command still running, so a CLI that exits next leaves nothing behind.
      cancel?.abort();
      resolveLate({ installed: true, signedIn: false, httpsCertificates: false, funnelOn443: false, unresponsive: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([readTailscaleFactsNow(runner, host), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads this machine's Tailscale through its own CLI, with every command
 * tied to the deadline: a command still running when it passes is killed.
 */
export async function readSystemTailscaleFacts(host: TailscaleHost = systemTailscaleHost(), timeoutMs = TAILSCALE_FACTS_TIMEOUT_MS, resolveBinary?: () => Promise<string | null>): Promise<TailscaleFacts> {
  const cancel = new AbortController();
  const runner = await createSystemTailscaleCommandRunner({
    ...(resolveBinary ? { resolveBinary } : {}),
    execute: (command, args, options) => new Promise((resolveRun, rejectRun) => {
      execFile(command, [...args], { ...options, signal: cancel.signal }, (error, stdout) => error ? rejectRun(error) : resolveRun({ stdout: String(stdout) }));
    }),
  });
  return readTailscaleFacts(runner, host, timeoutMs, cancel);
}

async function readTailscaleFactsNow(runner: AidenTailscaleCommandRunner | null, host: TailscaleHost): Promise<TailscaleFacts> {
  const status = await new AidenRemoteTailscaleController(runner).status();
  if (!status.installed || !runner) return { installed: false, signedIn: false, httpsCertificates: false, funnelOn443: false };
  const signedIn = status.dnsName !== undefined && status.errorCode !== "not_connected" && status.errorCode !== "status_unavailable";
  const funnelOn443 = status.serveStatus ? aidenTailscaleFunnelOn443(status.serveStatus) : false;
  const facts: TailscaleFacts = {
    installed: true,
    signedIn,
    ...(status.dnsName ? { dnsName: status.dnsName } : {}),
    httpsCertificates: status.httpsAvailable === true,
    funnelOn443,
  };
  const prefs = await runner.run(["debug", "prefs"]).then(jsonRecord, () => undefined);
  if (host.platform === "linux") {
    if (host.uid === 0) facts.operatorNeeded = false;
    else if (prefs) facts.operatorNeeded = prefs.OperatorUser !== host.user;
    else facts.operatorUnverified = true;
  }
  if (!prefs) return facts;
  const exitNode = (typeof prefs.ExitNodeID === "string" && prefs.ExitNodeID !== "") || (typeof prefs.ExitNodeIP === "string" && prefs.ExitNodeIP !== "");
  facts.exitNodeWithoutLan = exitNode && prefs.ExitNodeAllowLANAccess !== true;
  return facts;
}

/** Tailscale can carry the Aiden route right now, with nothing for the person to fix first. */
export function tailscaleReady(facts: TailscaleFacts): boolean {
  return facts.installed && facts.signedIn && facts.httpsCertificates && !facts.funnelOn443 && facts.operatorNeeded !== true && facts.operatorUnverified !== true;
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
  if (facts.unresponsive) return `Tailscale: did not answer within ${TAILSCALE_FACTS_TIMEOUT_MS / 1000}s. Check that \`tailscale status\` works.`;
  if (!facts.installed) return "Tailscale: not installed on this server (https://tailscale.com/download).";
  if (!facts.signedIn) return `Tailscale: installed but not signed in. ${signInFix(platform)}`;
  if (!facts.httpsCertificates) return `Tailscale: signed in as ${facts.dnsName}, but HTTPS certificates are off. Turn them on at ${ADMIN_DNS_URL}.`;
  if (facts.operatorNeeded) return `Tailscale: signed in as ${facts.dnsName}. Run \`sudo tailscale set --operator=$USER\` once so Aiden can add its route.`;
  if (facts.funnelOn443) return `Tailscale: signed in as ${facts.dnsName}, but public Funnel is on for HTTPS port 443. Turn it off first.`;
  if (facts.operatorUnverified) return `Tailscale: signed in as ${facts.dnsName}, but Aiden could not check whether this user may change Tailscale Serve settings. If Tailscale setup fails, run \`sudo tailscale set --operator=$USER\` once.`;
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
  if (facts.unresponsive) return [{ state: "fail", text: `Tailscale did not answer within ${TAILSCALE_FACTS_TIMEOUT_MS / 1000}s. Check that it is running (\`tailscale status\`), then run \`aiden remote check\` again.` }];
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
  } else if (facts.operatorUnverified) {
    items.push({ state: "warn", text: "Could not read Tailscale's settings to check whether this user may change Serve. If Tailscale setup fails, run `sudo tailscale set --operator=$USER` once." });
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
  /** What holds Aiden's Serve path (`AidenTailscaleRouteState`), when the server inspected it. */
  tailscaleRouteState?: string;
  /** The server is running with Remote off (`--no-remote`). */
  remoteOff?: boolean;
  /** A server holds the control socket but did not answer in time (busy or stuck). */
  unanswered?: boolean;
}

/**
 * `remote status` from the running server: `{ remoteOff: true }` when it runs
 * without Remote, `{ unanswered: true }` when something holds the control
 * socket but does not answer within `timeoutMs`, and undefined only when no
 * server is listening at all.
 */
export async function remoteServerStatus(agentDir: string, timeoutMs = 5_000): Promise<ServerReachability | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ServerReachability>((resolveLate) => { timer = setTimeout(() => resolveLate({ unanswered: true }), timeoutMs); });
  try {
    const asked = remoteDaemonCommand(agentDir, "remote", ["status"]).then(
      (value) => value as ServerReachability,
      (error: unknown): ServerReachability | undefined => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
        return /^Remote is off/u.test(error instanceof Error ? error.message : String(error)) ? { remoteOff: true } : { unanswered: true };
      },
    );
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fix for a Serve path Aiden cannot simply connect: an unfinished change,
 * a route another install or another program holds, or a public Funnel.
 * Reconnecting through `remote network` would only fail with the same message.
 */
function routeStateMessage(state: string | undefined): string | undefined {
  switch (state) {
    case "reconciliation_required": return tailscaleSetupMessage("tailscale_reconciliation_required");
    case "other_aiden_live": return tailscaleSetupMessage("tailscale_route_live");
    case "other_aiden_stale":
    case "unrelated_conflict": return tailscaleSetupMessage("tailscale_route_conflict");
    case "funnel_conflict": return tailscaleSetupMessage("tailscale_funnel_conflict");
    default: return undefined;
  }
}

/** How the running server can be reached. `answered` is the live Tailscale check, when one ran. */
export function serverChecklist(server: ServerReachability | undefined, facts: TailscaleFacts, cloud: boolean, answered?: boolean): CheckItem[] {
  if (!server) return [{ state: "fail", text: "The Aiden server is not running. Start it with `aiden service install` or `aiden serve`." }];
  if (server.unanswered) return [{ state: "fail", text: "The Aiden server did not answer. It may be busy or stuck; see its log (`aiden service status` says where it is), or restart it." }];
  if (server.remoteOff) return [{ state: "fail", text: "The server is running with Remote off. Restart it without `--no-remote`, or run it as a service with `aiden service install`." }];
  if (server.running === false) return [{ state: "fail", text: "Remote is on but not listening. See the server log (`aiden service status` says where it is)." }];
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
    const reason = (server.tailscaleErrorCode ? tailscaleSetupMessage(`tailscale_${server.tailscaleErrorCode}`) : undefined)
      ?? routeStateMessage(server.tailscaleRouteState);
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

/** GET `<endpoint>/health` and accept only Aiden's own answer. Never rejects; an abort ends it at once. */
export function probeAidenHealth(endpoint: string, timeoutMs: number, options: { ca?: string | Buffer; signal?: AbortSignal } = {}): Promise<boolean> {
  return new Promise((resolveProbe) => {
    if (options.signal?.aborted) { resolveProbe(false); return; }
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", aborted);
      request.destroy();
      resolveProbe(healthy);
    };
    const aborted = () => finish(false);
    const deadline = setTimeout(aborted, timeoutMs);
    const request = httpsGet(`${endpoint.replace(/\/+$/u, "")}/health`, { headers: { accept: "application/json" }, ...(options.ca ? { ca: options.ca } : {}) }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > 4096) finish(false); });
      response.on("end", () => finish(response.statusCode === 200 && jsonRecord(body)?.ok === true));
      response.on("error", () => finish(false));
    });
    request.on("error", () => finish(false));
    options.signal?.addEventListener("abort", aborted, { once: true });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePause) => {
    if (signal.aborted) { resolvePause(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolvePause(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait until the Tailscale address answers, retrying for up to `budgetMs`.
 * The first HTTPS request to a new Serve name makes Tailscale fetch its
 * certificate, which can take a while; doing it here keeps the phone's first
 * connection from stalling. An abort stops the request in flight and the pause.
 */
export async function waitForTailscaleAddress(endpoint: string, signal: AbortSignal, budgetMs = 45_000, probe: typeof probeAidenHealth = probeAidenHealth): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!signal.aborted) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    if (await probe(endpoint, Math.min(15_000, left), { signal })) return !signal.aborted;
    await pause(Math.min(1_000, Math.max(0, deadline - Date.now())), signal);
  }
  return false;
}

/** Confirm the Tailscale address answers, and say so when it does not. */
export async function checkTailscaleAddress(agentDir: string, signal: AbortSignal, out: NodeJS.WritableStream, err: NodeJS.WritableStream, wait: typeof waitForTailscaleAddress = waitForTailscaleAddress, known?: ServerReachability): Promise<void> {
  // Reuse the status the prepare step just returned; otherwise ask with the same budget as `remote check`,
  // since the server's status inspects Tailscale and a short timeout would skip the warm-up.
  const status = known?.tailscaleConnected && known.tailscaleEndpoint ? known : await remoteServerStatus(agentDir, 20_000);
  const endpoint = status?.tailscaleConnected ? status.tailscaleEndpoint : undefined;
  if (!endpoint || signal.aborted) return;
  out.write(`Checking that ${endpoint} answers. The first time can take up to a minute while Tailscale gets its HTTPS certificate.\n`);
  if (await wait(endpoint, signal)) return;
  if (!signal.aborted) err.write(`aiden: ${endpoint} did not answer yet. The code below still works once it does; \`aiden remote check\` shows what is missing.\n`);
}

/**
 * Before a Tailscale pairing window: connect the route, then warm its HTTPS
 * certificate. Pairing reads the address's certificate with a short timeout,
 * so it must not be the first request to a new Serve name. Setup problems
 * throw with the same fix pairing would name.
 */
export async function prepareTailscalePairing(agentDir: string, signal: AbortSignal, out: NodeJS.WritableStream, err: NodeJS.WritableStream, wait: typeof waitForTailscaleAddress = waitForTailscaleAddress): Promise<void> {
  let prepared: ServerReachability | undefined;
  try {
    prepared = await remoteDaemonCommand(agentDir, "remote", ["tailscale-prepare"]) as ServerReachability | undefined;
  } catch (error) {
    // A server started from an older build has no prepare step; pairing connects the route itself.
    if (!/^Usage: remote /u.test(error instanceof Error ? error.message : String(error))) throw error;
    return;
  }
  if (!signal.aborted) await checkTailscaleAddress(agentDir, signal, out, err, wait, prepared);
}

export interface RemoteCheckDependencies {
  runner?: AidenTailscaleCommandRunner | null;
  host?: TailscaleHost;
  cloud?: () => Promise<boolean>;
  probe?: (endpoint: string) => Promise<boolean>;
  out?: NodeJS.WritableStream;
  /** How long to wait for the server's `remote status`, which inspects Tailscale and can take a while. */
  statusTimeoutMs?: number;
}

/** `aiden remote check`: every step between a phone and this server, with the fix for each one that fails. */
export async function remoteCheckCommand(agentDir: string, dependencies: RemoteCheckDependencies = {}): Promise<boolean> {
  const host = dependencies.host ?? systemTailscaleHost();
  const [facts, cloud, server] = await Promise.all([
    dependencies.runner === undefined ? readSystemTailscaleFacts(host) : readTailscaleFacts(dependencies.runner, host),
    (dependencies.cloud ?? (() => looksLikeCloudServer()))(),
    remoteServerStatus(agentDir, dependencies.statusTimeoutMs ?? 20_000),
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
