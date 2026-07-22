/* global process, setTimeout */

import { spawn } from "node:child_process";

const specification = JSON.parse(process.argv[2] ?? "null");
if (
  !specification ||
  typeof specification.command !== "string" ||
  !Array.isArray(specification.args) ||
  !specification.args.every((argument) => typeof argument === "string")
) {
  process.exit(64);
}

let terminating = false;
let commandError = null;

// This detached wrapper is the occupied lease for its own process group. It
// ignores TERM until it sends the mandatory group KILL itself.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

function terminateGroup(graceMs) {
  if (terminating) return;
  terminating = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    // The wrapper is an occupied member, so failure is unexpected; the parent
    // still has an exact direct-child fallback.
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } finally {
      process.exit(70);
    }
  }, Math.max(0, graceMs));
}

process.on("message", (message) => {
  if (message?.type === "terminate") {
    terminateGroup(Number(message.graceMs) || 0);
  } else if (message?.type === "release" && !terminating) {
    // A successful direct child may still have left ignored-stdio descendants
    // in this occupied group. Apply the same bounded cleanup before releasing
    // the group lease so no background process survives a successful command.
    terminateGroup(Number(message.graceMs) || 0);
  }
});
process.once("disconnect", () => terminateGroup(0));

const command = spawn(specification.command, specification.args, {
  detached: false,
  env: process.env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
command.stdout.pipe(process.stdout, { end: false });
command.stderr.pipe(process.stderr, { end: false });
command.once("error", (error) => {
  commandError = error.message;
});
command.once("close", (code, signal) => {
  process.send?.({ type: "result", code, signal, error: commandError });
});
