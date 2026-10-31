import type { AidenRemoteDesktopPairing, AidenRemotePairingWindowStatus } from "../../../main/services/aiden-remote-pairing.js";
import { remoteDaemonCommand } from "./daemon-control.ts";

export const SERVE_USAGE = "Usage: aiden serve [--no-remote] [--pair lan|tailscale | --no-pair] [--daemon] | serve stop | serve status";

type PairTransport = "lan" | "tailscale";

export interface ServeFlags {
  remote: boolean;
  daemon: boolean;
  /** Startup pairing window, or "off". */
  pair: PairTransport | "off";
  /** The person asked for a startup pairing window by name. */
  pairRequested: boolean;
}

/**
 * Remote is on unless `--no-remote`; `--remote` is still accepted. A
 * foreground terminal gets a LAN pairing window unless `--no-pair`.
 */
export function parseServeFlags(args: readonly string[]): ServeFlags {
  let remote: boolean | undefined;
  let daemon = false;
  let pair: PairTransport | "off" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--remote" || arg === "--no-remote") {
      const value = arg === "--remote";
      if (remote !== undefined && remote !== value) throw new Error("Choose one of --remote and --no-remote.");
      remote = value;
    } else if (arg === "--daemon") {
      daemon = true;
    } else if (arg === "--no-pair" || arg === "--pair" || arg.startsWith("--pair=")) {
      const value = arg === "--no-pair" ? "off" : arg === "--pair" ? args[(index += 1)] : arg.slice("--pair=".length);
      if (value !== "off" && value !== "lan" && value !== "tailscale") throw new Error("Usage: aiden serve --pair lan|tailscale");
      if (pair !== undefined && pair !== value) throw new Error("Choose one of --pair lan, --pair tailscale and --no-pair.");
      pair = value;
    } else {
      throw new Error(SERVE_USAGE);
    }
  }
  const pairRequested = pair === "lan" || pair === "tailscale";
  if (remote === false && pairRequested) throw new Error("--pair needs Remote. Drop --no-remote.");
  if (daemon && pairRequested) throw new Error("--pair shows a code in the foreground. After `aiden serve --daemon`, run `aiden remote pair lan|tailscale`.");
  return { remote: remote !== false, daemon, pair: pair ?? "lan", pairRequested };
}

/** The running daemon's Remote summary, `{ on: false }` when Remote is off, or `{ on: "unknown" }` when the daemon does not answer. */
const STATUS_TIMEOUT_MS = 5_000;

export async function daemonRemoteSummary(agentDir: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | undefined;
  // A wedged daemon must not hold `serve status` for the control socket's long command timeout.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The server did not answer within ${timeoutMs / 1000}s.`)), timeoutMs);
  });
  try {
    const reply = await Promise.race([remoteDaemonCommand(agentDir, "serve", ["status"]), timedOut]) as { remote?: Record<string, unknown> };
    return reply.remote ?? { on: false };
  } catch (error) {
    return { on: "unknown", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const POLL_MS = 2_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Open one pairing window through the daemon's own `remote pair` path, show
 * its QR and manual code, then say how to get a new one once it expires.
 */
export async function showStartupPairing(agentDir: string, transport: PairTransport, signal: AbortSignal, out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr): Promise<void> {
  let pairing: AidenRemoteDesktopPairing;
  try {
    pairing = await remoteDaemonCommand(agentDir, "remote", ["pair", transport]) as AidenRemoteDesktopPairing;
  } catch (error) {
    // Tailscale failures already name the setup step and the command to retry with.
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.*$/u, ".");
    if (!signal.aborted) err.write(`aiden: Could not open a ${transport === "lan" ? "LAN" : "Tailscale"} pairing window. ${message}${transport === "lan" ? " Run `aiden remote pair lan` to try again." : ""}\n`);
    return;
  }
  if (signal.aborted) return;
  const { renderPairingTerminal } = await import("./pairing-display.ts");
  const rendered = await renderPairingTerminal(pairing).catch(() => undefined);
  if (!rendered || signal.aborted) return;
  out.write(rendered + "\n");
  const expiresAt = Date.parse(pairing.bootstrap.expiresAt);
  if (!Number.isFinite(expiresAt)) return;
  while (!signal.aborted) {
    await wait(Math.min(POLL_MS, Math.max(0, expiresAt - Date.now())), signal);
    if (signal.aborted) return;
    let status: AidenRemotePairingWindowStatus | { state: "none" };
    try { status = await remoteDaemonCommand(agentDir, "remote", ["pair-status"]) as typeof status; } catch { return; }
    if (signal.aborted) return;
    // Someone opened or closed a window from another shell: that one is theirs to report.
    if (!("sessionId" in status) || status.sessionId !== pairing.sessionId) return;
    if (status.state === "finishing" && status.deviceId) { out.write("A device paired. Run `aiden remote pair lan` (or `aiden remote pair tailscale`) to add another.\n"); return; }
    if (status.state === "expired" || Date.now() >= expiresAt) { out.write("The pairing code expired. Run `aiden remote pair lan` (or `aiden remote pair tailscale`) for a new code.\n"); return; }
  }
}

/** `aiden serve ...`. Prints its own output and returns when serving stops. */
export async function serveCommand(agentDir: string, args: string[]): Promise<void> {
  const { daemonStatus, startDaemon, stopDaemon } = await import("./serve-lifecycle.ts");
  if (args[0] === "stop" || args[0] === "status") {
    if (args.length !== 1) throw new Error(`Usage: aiden serve ${args[0]}`);
    let result: unknown;
    if (args[0] === "stop") result = await stopDaemon(agentDir);
    else {
      const status = daemonStatus(agentDir);
      result = { ...status, remote: status.running ? await daemonRemoteSummary(agentDir) : { on: false } };
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const flags = parseServeFlags(args);
  if (flags.daemon) {
    const started = await startDaemon(agentDir, { remote: flags.remote });
    process.stdout.write(JSON.stringify({ ...started, remote: await daemonRemoteSummary(agentDir) }, null, 2) + "\n");
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let pairing: Promise<void> | undefined;
  const onReady = () => {
    if (!flags.remote || flags.pair === "off") return;
    // The QR and manual code carry a single-use secret: show them only to a
    // person at a terminal, never to a log (Docker, systemd, redirected output).
    if (!process.stdout.isTTY) {
      if (flags.pairRequested) process.stderr.write(`aiden: Not showing a pairing code because output is not a terminal. Run \`aiden remote pair ${flags.pair}\` from an interactive shell.\n`);
      return;
    }
    pairing = showStartupPairing(agentDir, flags.pair, controller.signal).catch(() => undefined);
  };
  try {
    await (await import("./serve.ts")).serve(agentDir, controller.signal, { remote: flags.remote, onReady });
  } finally {
    controller.abort();
    await pairing;
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
