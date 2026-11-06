import { ensurePrivateDirectory } from "../../../main/services/private-storage.ts";
import { createServer } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLease } from "./state.ts";
import { DETACHED_SERVE_ENV, recordServeMcpGroups, recoverStaleServeLease } from "./serve-lifecycle.ts";
import { createCliScheduler, daemonSocket } from "./schedules.ts";
import { createDaemonChats } from "./daemon-chats.ts";
import { createCliTelegram } from "./telegram.ts";
import { workspaceCommand } from "./workspaces.ts";
import { createCliWorkspaceApplication } from "./workspace-application.ts";
import { createCliBots } from "./bots.ts";
import { createCliRemote } from "./remote.ts";
import { ServeLifetime } from "./serve-lifetime.ts";

type CliRemote = Awaited<ReturnType<typeof createCliRemote>>;

/** What `aiden serve status` reports about Remote: whether it is on, and where clients reach it. */
async function serveStatus(remote: CliRemote | undefined, args: string[]) {
  if (args.length !== 1 || args[0] !== "status") throw new Error("Usage: serve status");
  if (!remote) return { remote: { on: false } };
  const status = await remote.service.status();
  return { remote: { on: status.running, connectionMode: status.connectionMode, lanPort: status.lanPort,
    ...(status.lanEndpoint ? { lanEndpoint: status.lanEndpoint } : {}),
    ...(status.tailscaleEndpoint ? { tailscaleEndpoint: status.tailscaleEndpoint } : {}),
    tailscaleConnected: status.tailscaleConnected, pairedDeviceCount: status.pairedDeviceCount,
    ...(status.error ? { error: status.error } : {}) } };
}

/** Local control socket is private to the agent directory's owner. */
export async function serve(agentDir: string, signal: AbortSignal, options: { remote?: boolean; onReady?: () => void } = {}) {
  ensurePrivateDirectory(agentDir, "reject");
  recoverStaleServeLease(agentDir);
  // startDaemon marks the background daemon so `serve stop` may force-kill its
  // whole process group; a foreground serve shares its group with the shell job.
  const detached = process.env[DETACHED_SERVE_ENV] === "1";
  delete process.env[DETACHED_SERVE_ENV];
  const release = acquireLease(join(agentDir, "serve"), detached ? { detached: true } : undefined);
  const stopRecording = recordServeMcpGroups(agentDir);
  try { await serveOwned(agentDir, signal, options); } finally { stopRecording(); release(); }
}
async function serveOwned(agentDir: string, signal: AbortSignal, options: { remote?: boolean; onReady?: () => void }) {
  const runtime = createCliScheduler(agentDir);
  const chats = createDaemonChats(agentDir);
  chats.assertChatDeletionsReadable();
  // Every server finishes these, Remote or not. A failure keeps only those chats closed.
  await chats.recoverChatDeletions().catch((error: unknown) => { process.stderr.write(`aiden: Could not finish a chat deletion: ${error instanceof Error ? error.message : String(error)}\n`); });
  const workspaceRuntime = createCliWorkspaceApplication(agentDir, {
    cancelGeneration: async (id) => { for (const chat of await chats.chatStore.list(id)) { await chats.llmClient.cancelChat(chat.id); await chats.llmClient.waitForChatIdle(chat.id); } },
    cancelSchedules: (id) => runtime.service.cancelWorkspace(id), resumeSchedules: (id) => runtime.service.resumeWorkspace(id),
  });
  const telegram = createCliTelegram(agentDir, chats);
  const bots = await createCliBots(agentDir, chats); chats.setBots(bots); bots.setScheduler(runtime);
  let remote: CliRemote | undefined;
  const path = daemonSocket(agentDir);
  const clients = new Set<import("node:net").Socket>();
  const lifetime = new ServeLifetime();
  // A stop during startup closes the socket to new commands at once, not when startup ends.
  if (signal.aborted) lifetime.beginDrain();
  else signal.addEventListener("abort", () => lifetime.beginDrain(), { once: true });
  const server = createServer((socket) => {
    if (!lifetime.acceptsCommands || clients.size >= 64) { socket.destroy(); return; }
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    let buffer = "", handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("data", (data) => {
      if (handled) return;
      buffer += data;
      const end = buffer.indexOf("\n");
      // The ceiling is on the frame: bytes after its newline are ignored, not counted.
      if (Buffer.byteLength(end < 0 ? buffer : buffer.slice(0, end)) > 65536) { socket.destroy(); return; }
      if (end < 0) return;
      handled = true;
      socket.setTimeout(610_000, () => socket.destroy());
      // A reply is not delivered until it has flushed or its client has gone.
      const reply = (body: unknown) => new Promise<void>((resolve) => {
        if (socket.destroyed) { resolve(); return; }
        socket.once("close", () => resolve());
        socket.end(JSON.stringify(body) + "\n", () => resolve());
      });
      lifetime.track((async () => {
        try {
          if (!lifetime.acceptsCommands) throw new Error("The Aiden daemon is shutting down.");
          const request = JSON.parse(buffer.slice(0, end));
          if (!["schedule", "remote", "bots", "workspace", "serve"].includes(request.command) || !Array.isArray(request.args) || request.args.some((arg: unknown) => typeof arg !== "string")) throw new Error("Invalid daemon command.");
          if (request.command === "remote" && !remote) throw new Error("Remote is off for this server. Restart it with `aiden serve` (without --no-remote) to use Remote controls.");
          const result = request.command === "serve" ? await serveStatus(remote, request.args) : request.command === "workspace" ? await workspaceCommand(agentDir, request.args, (remote?.workspaces ?? workspaceRuntime).application) : request.command === "bots" ? await bots.command(request.args) : request.command === "remote" ? await remote!.command(request.args) : await runtime.command(request.args);
          await reply({ result });
        } catch (error) { await reply({ error: error instanceof Error ? error.message : String(error) }); }
      })());
    });
  });
  try {
    if (signal.aborted) return;
    if (options.remote) {
      try { remote = await createCliRemote(agentDir, chats, runtime, { bots }); await remote.start(); }
      catch (error) { throw new Error(`Remote could not start: ${(error instanceof Error ? error.message : String(error)).replace(/\.*$/u, ".")} Run \`aiden serve --no-remote\` to serve without Remote.`, { cause: error }); }
    }
    if (signal.aborted) return;
    ensurePrivateDirectory(agentDir, "reject");
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.removeListener("error", reject); resolve(); }); });
    chmodSync(path, 0o600);
    if (signal.aborted) return;
    await runtime.service.start();
    if (signal.aborted) return;
    await telegram.start();
    if (signal.aborted) return;
    process.stderr.write(`Aiden scheduler listening at ${path}\n`);
    if (remote) {
      const status = await remote.service.status().catch(() => undefined);
      process.stderr.write(`Aiden Remote listening${status ? ` on port ${status.lanPort}${status.lanEndpoint ? ` (${status.lanEndpoint})` : ""}` : ""}. Pair a device with \`aiden remote pair lan|tailscale\`.\n`);
    } else process.stderr.write("Aiden Remote is off.\n");
    if (signal.aborted) return;
    lifetime.markServing();
    options.onReady?.();
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    // Refuse new control requests and stop accepting connections before draining.
    lifetime.beginDrain();
    const closed = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    // chats.stop() runs first and synchronously closes turn admission, so no ingress stopped
    // alongside it can begin a turn that exit would cut short.
    const settled = await Promise.allSettled([chats.stop(), bots.stop(), telegram.stopAndSettle(), remote?.stop(), runtime.service.stopAndSettle()]);
    // An accepted command may still be changing state, and its client is owed the outcome.
    await lifetime.settleCommands();
    for (const client of clients) client.destroy();
    await closed;
    rmSync(path, { force: true });
    for (const result of settled) if (result.status === "rejected") process.stderr.write(`aiden: Daemon shutdown cleanup failed: ${String(result.reason)}\n`);
  }
}
