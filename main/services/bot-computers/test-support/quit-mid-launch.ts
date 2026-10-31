// Aiden's main process quitting while a Bot computer is still launching, for host.test.ts.
// It makes a host over storage a test already set up, starts one Bot's computer, waits until
// Lume's `run` has begun, then shuts the host down within the given budget and exits at once,
// as main does when its shutdown budget is over (app.quit()).
//
// Arguments: <root> <fake lume> <fake config> <bots dir> <bot id> <budget ms>
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createBotComputerHost } from "../host.js";

const [root, fake, configFile, botsDir, botId, budget] = process.argv.slice(2);
if (!root || !fake || !configFile || !botsDir || !botId || !budget) throw new Error("quit-mid-launch needs six arguments");

const logFile = (JSON.parse(readFileSync(configFile, "utf8")) as { log: string }).log;
const runs = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.includes('"kind":"cli"') && line.includes('"op":"run"')).length
    : 0;

const host = createBotComputerHost({
  root,
  lume: async () => ({ command: process.execPath, prefixArgs: [fake, "--fake-config", configFile] }),
  support: () => ({ ok: true }),
  botComputerDir: async (id) => path.join(botsDir, id, "Computer"),
  secrets: { get: async () => null, set: async () => undefined, deleteFamily: async () => undefined },
  resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => 64 * 1024 ** 3 },
  vncExposed: async () => false,
  pollIntervalMs: 20,
});

const before = runs();
let ended: string | undefined;
void host.ensureRunning(botId, { reason: "tool" }).then(
  () => {
    ended = "the start finished";
  },
  (error: unknown) => {
    ended = error instanceof Error ? error.message : String(error);
  },
);
// A start that ends, or never reaches Lume's `run`, fails the test rather than hanging it.
const deadline = Date.now() + 30_000;
while (runs() === before) {
  if (ended !== undefined || Date.now() > deadline) {
    process.stderr.write(`quit-mid-launch: Lume's run never began (${ended ?? "timed out"})\n`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await host.shutdown(Number(budget));
process.stdout.write("quit\n");
process.exit(0);
