import { join } from "node:path";
import { createConnection } from "node:net";
export const daemonSocket = (agentDir: string) => join(agentDir, "serve.sock");
export async function remoteDaemonCommand(agentDir: string, command: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(daemonSocket(agentDir));
    let buffer = "";
    socket.setTimeout(610_000, () => socket.destroy(new Error("Daemon response timed out.")));
    socket.on("connect", () => socket.write(JSON.stringify({ command, args }) + "\n"));
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        const friendly = new Error("The Aiden daemon is not running. Start it with `aiden serve` (or `aiden serve --daemon` to run it in the background).");
        Object.assign(friendly, { code });
        reject(friendly);
        return;
      }
      reject(error);
    });
    socket.on("data", (data) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) socket.destroy(new Error("Daemon response is too large."));
      if (!buffer.includes("\n")) return;
      socket.end();
      try { const response = JSON.parse(buffer); if (response.error) reject(new Error(response.error)); else resolve(response.result); }
      catch (error) { reject(error); }
    });
    socket.on("end", () => { if (!buffer.includes("\n")) reject(new Error("Daemon closed without a response.")); });
  });
}
