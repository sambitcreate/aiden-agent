import { createServer } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLease } from "./state.ts";
import { DETACHED_SERVE_ENV, recoverStaleServeLease } from "./serve-lifecycle.ts";
import { createCliScheduler, daemonSocket } from "./schedules.ts";
import { createDaemonChats } from "./daemon-chats.ts";
import { createCliTelegram } from "./telegram.ts";
import { workspaceCommand } from "./workspaces.ts";
import { createCliWorkspaceApplication } from "./workspace-application.ts";
import { createCliBots } from "./bots.ts";
import { createCliRemote } from "./remote.ts";

/** Local control socket is private to the agent directory's owner. */
export async function serve(agentDir: string, signal: AbortSignal, options: { remote?: boolean } = {}) {
  recoverStaleServeLease(agentDir);
  // startDaemon marks the background daemon so `serve stop` may force-kill its
  // whole process group; a foreground serve shares its group with the shell job.
  const detached = process.env[DETACHED_SERVE_ENV] === "1";
  delete process.env[DETACHED_SERVE_ENV];
  const release = acquireLease(join(agentDir, "serve"), detached ? { detached: true } : undefined);
  try { await serveOwned(agentDir, signal, options); } finally { release(); }
}
async function serveOwned(agentDir: string, signal: AbortSignal, options: { remote?: boolean }) {
  const runtime = createCliScheduler(agentDir);
  const chats = createDaemonChats(agentDir);
  const workspaceRuntime = createCliWorkspaceApplication(agentDir, {
    cancelGeneration: async (id) => { for (const chat of await chats.chatStore.list(id)) { await chats.llmClient.cancelChat(chat.id); await chats.llmClient.waitForChatIdle(chat.id); } },
    cancelSchedules: (id) => runtime.service.cancelWorkspace(id), resumeSchedules: (id) => runtime.service.resumeWorkspace(id),
  });
  const telegram = createCliTelegram(agentDir, chats);
  const bots = await createCliBots(agentDir, chats); chats.setBots(bots); bots.setScheduler(runtime);
  let remote: Awaited<ReturnType<typeof createCliRemote>> | undefined;
  const path = daemonSocket(agentDir);
  const clients = new Set<import("node:net").Socket>();
  let closing = false;
  const server = createServer((socket) => {
    if (closing || clients.size >= 64) { socket.destroy(); return; }
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    let buffer = "", handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("data", (data) => {
      if (handled) return;
      buffer += data;
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      handled = true;
      socket.setTimeout(610_000, () => socket.destroy());
      void (async () => {
        try {
          if (closing) throw new Error("The Aiden daemon is shutting down.");
          const request = JSON.parse(buffer);
          if (!["schedule", "remote", "bots", "workspace"].includes(request.command) || !Array.isArray(request.args) || request.args.some((arg: unknown) => typeof arg !== "string")) throw new Error("Invalid daemon command.");
          if (request.command === "remote" && !remote) throw new Error("Start aiden serve --remote to use Remote controls.");
          const result = request.command === "workspace" ? await workspaceCommand(agentDir, request.args, (remote?.workspaces ?? workspaceRuntime).application) : request.command === "bots" ? await bots.command(request.args) : request.command === "remote" ? await remote!.command(request.args) : await runtime.command(request.args);
          socket.end(JSON.stringify({ result }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
      })();
    });
  });
  try {
    if (options.remote) { remote = await createCliRemote(agentDir, chats, runtime, { bots }); await remote.start(); }
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.removeListener("error", reject); resolve(); }); });
    chmodSync(path, 0o600);
    await runtime.service.start();
    await telegram.start();
    process.stderr.write(`Aiden scheduler listening at ${path}\n`);
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    // Refuse new control requests and stop accepting connections before draining.
    closing = true;
    const closed = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    // chats.stop() runs first and synchronously closes turn admission, so no ingress stopped
    // alongside it can begin a turn that exit would cut short.
    const settled = await Promise.allSettled([chats.stop(), bots.stop(), telegram.stopAndSettle(), remote?.stop(), runtime.service.stopAndSettle()]);
    for (const client of clients) client.destroy();
    await closed;
    rmSync(path, { force: true });
    for (const result of settled) if (result.status === "rejected") process.stderr.write(`aiden: Daemon shutdown cleanup failed: ${String(result.reason)}\n`);
  }
}
