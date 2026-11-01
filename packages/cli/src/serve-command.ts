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
 * foreground terminal gets a pairing window unless `--no-pair`: LAN, or
 * Tailscale on a server that serves only over Tailscale.
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
 * With no transport named, a server that serves only over Tailscale pairs
 * over Tailscale and every other server pairs over LAN. Resolves the opened
 * window's session id, so a caller whose server keeps running can close it.
 */
export async function showStartupPairing(agentDir: string, requested: PairTransport | undefined, signal: AbortSignal, out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr, waitForAddress?: typeof import("./reachability.ts").waitForTailscaleAddress): Promise<string | undefined> {
  const mode = requested ? undefined : (await daemonRemoteSummary(agentDir)).connectionMode;
  // An unanswered status leaves the mode unknown; LAN is then a guess, and a failure names both commands.
  const guessed = !requested && mode === undefined;
  const transport = requested ?? (mode === "tailscale" ? "tailscale" : "lan");
  if (signal.aborted) return;
  let pairing: AidenRemoteDesktopPairing;
  try {
    if (transport === "tailscale") {
      const { prepareTailscalePairing, waitForTailscaleAddress } = await import("./reachability.ts");
      await prepareTailscalePairing(agentDir, signal, out, err, waitForAddress ?? waitForTailscaleAddress);
      if (signal.aborted) return;
    }
    pairing = await remoteDaemonCommand(agentDir, "remote", ["pair", transport]) as AidenRemoteDesktopPairing;
  } catch (error) {
    // Tailscale failures already name the setup step and the command to retry with.
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.*$/u, ".");
    const retry = guessed ? " Run `aiden remote pair lan` or `aiden remote pair tailscale` to try again." : transport === "lan" ? " Run `aiden remote pair lan` to try again." : "";
    if (!signal.aborted) err.write(`aiden: Could not open a ${transport === "lan" ? "LAN" : "Tailscale"} pairing window. ${message}${retry}\n`);
    return;
  }
  if (signal.aborted) return pairing.sessionId;
  const { renderPairingTerminal } = await import("./pairing-display.ts");
  const rendered = await renderPairingTerminal(pairing).catch(() => undefined);
  if (!rendered || signal.aborted) return pairing.sessionId;
  out.write(rendered + "\n");
  const expiresAt = Date.parse(pairing.bootstrap.expiresAt);
  if (!Number.isFinite(expiresAt)) return pairing.sessionId;
  while (!signal.aborted) {
    await wait(Math.min(POLL_MS, Math.max(0, expiresAt - Date.now())), signal);
    if (signal.aborted) return pairing.sessionId;
    let status: AidenRemotePairingWindowStatus | { state: "none" };
    try { status = await remoteDaemonCommand(agentDir, "remote", ["pair-status"]) as typeof status; } catch { return pairing.sessionId; }
    if (signal.aborted) return pairing.sessionId;
    // Someone opened or closed a window from another shell: that one is theirs to report.
    if (!("sessionId" in status) || status.sessionId !== pairing.sessionId) return pairing.sessionId;
    if (status.state === "failed") { err.write(`aiden: Pairing failed. Run \`aiden remote pair ${transport}\` to try again.\n`); return pairing.sessionId; }
    if (status.state === "finishing" && status.deviceId) { out.write("A device paired. Run `aiden remote pair lan` (or `aiden remote pair tailscale`) to add another.\n"); return pairing.sessionId; }
    if (status.state === "expired" || Date.now() >= expiresAt) { out.write("The pairing code expired. Run `aiden remote pair lan` (or `aiden remote pair tailscale`) for a new code.\n"); return pairing.sessionId; }
  }
  return pairing.sessionId;
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
  // SIGHUP (terminal or ssh pane closed) drains like SIGINT/SIGTERM instead of killing live turns.
  // A stray rejection in one turn is logged rather than crashing every other turn the daemon serves.
  const rejected = (reason: unknown) => { process.stderr.write(`aiden: Unhandled daemon rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const name of signals) process.once(name, stop);
  process.on("unhandledRejection", rejected);
  let pairing: Promise<unknown> | undefined;
  const onReady = () => {
    if (!flags.remote || flags.pair === "off") return;
    // The QR and manual code carry a single-use secret: show them only to a
    // person at a terminal, never to a log (Docker, systemd, redirected output).
    if (!process.stdout.isTTY) {
      if (flags.pairRequested) process.stderr.write(`aiden: Not showing a pairing code because output is not a terminal. Run \`aiden remote pair ${flags.pair}\` from an interactive shell.\n`);
      return;
    }
    pairing = showStartupPairing(agentDir, flags.pairRequested ? flags.pair : undefined, controller.signal).catch(() => undefined);
  };
  try {
    await (await import("./serve.ts")).serve(agentDir, controller.signal, { remote: flags.remote, onReady });
  } finally {
    controller.abort();
    await pairing;
    for (const name of signals) process.removeListener(name, stop);
    process.removeListener("unhandledRejection", rejected);
  }
}
