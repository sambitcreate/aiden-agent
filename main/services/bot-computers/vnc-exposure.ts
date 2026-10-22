import { connect } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * Whether a VNC port on this Mac answers on any non-loopback address.
 *
 * Lume reports `vnc://…@127.0.0.1:<port>` whatever the listener binds to, so
 * the reported host alone (G22) can't prove the screen is private. This tries
 * the port on every external interface address; any answer means another
 * machine on the network could reach the Bot's screen, and Aiden stops the VM.
 */
export async function vncReachableBeyondLoopback(
  port: number,
  options: { interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return false;
  const interfaces = options.interfaces ?? networkInterfaces();
  const timeoutMs = options.timeoutMs ?? 400;
  const addresses: { host: string; family: 4 | 6 }[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4") addresses.push({ host: entry.address, family: 4 });
      else if (entry.family === "IPv6" && !entry.address.toLowerCase().startsWith("fe80:")) {
        addresses.push({ host: entry.address, family: 6 });
      }
    }
  }
  const attempts = addresses.map(
    ({ host, family }) =>
      new Promise<boolean>((resolve) => {
        const socket = connect({ host, port, family });
        let settled = false;
        const done = (reachable: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(reachable);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.once("connect", () => done(true));
        socket.on("error", () => done(false));
      }),
  );
  return (await Promise.all(attempts)).some(Boolean);
}
