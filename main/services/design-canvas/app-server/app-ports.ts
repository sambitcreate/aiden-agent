/**
 * Picks the loopback port a design app's dev server runs on (plan 2b D8):
 * the sticky port recorded for its app root, else the framework's default,
 * else one the OS hands out. Keeping the port keeps the app's storage and
 * cookies across restarts.
 */
import { connect, createServer } from "node:net";

const CONNECT_WAIT_MS = 250;

/** Whether a connect to `host:port` finds a listener; a refusal or an unreachable address means none. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    // No refusal in time is not proof the port is free.
    const timer = setTimeout(() => done(true), CONNECT_WAIT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => done(!["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH", "EAFNOSUPPORT"].includes(error.code ?? "")));
  });
}

function listenOnce(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(null));
    server.listen({ host, port, exclusive: true }, () => {
      const bound = (server.address() as { port: number } | null)?.port ?? null;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Free means nothing answers a connect to `127.0.0.1:<p>` or `[::1]:<p>`
 * within 250 ms (which catches a server on the wildcard address, which macOS
 * lets a more specific listen sit beside) and a test listen on
 * `127.0.0.1:<p>` succeeds.
 */
export async function defaultPortProbe(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) return false;
  const [v4, v6] = await Promise.all([answers("127.0.0.1", port), answers("::1", port)]);
  if (v4 || v6) return false;
  return (await listenOnce("127.0.0.1", port)) === port;
}

/** A port the OS hands out for `127.0.0.1:0`. */
export async function defaultOsPort(): Promise<number> {
  const port = await listenOnce("127.0.0.1", 0);
  if (!port) throw new Error("No free loopback port was found.");
  return port;
}

export async function chooseAppPort(input: {
  sticky?: number;
  fallback: number;
  probe?: (port: number) => Promise<boolean>;
  osPort?: () => Promise<number>;
}): Promise<number> {
  const probe = input.probe ?? defaultPortProbe;
  for (const candidate of [input.sticky, input.fallback]) {
    if (candidate !== undefined && (await probe(candidate))) return candidate;
  }
  const osPort = input.osPort ?? defaultOsPort;
  // An OS port is free by construction, but another process may still hold it on [::1].
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await osPort();
    if (await probe(port)) return port;
  }
  return osPort();
}
