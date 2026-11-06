// A real process that crashes while analytics is running and its network hangs.
// Usage: analytics-crash.mjs <agentDir> <appDir> <exception|rejection> <analytics|plain>
const [agentDir, appDir, kind, mode] = process.argv.slice(2);
const api = await import("../../dist/parity-test-api.js");

if (mode === "analytics") {
  api.startServerAnalytics("foreground", {
    agentDir,
    appDir,
    env: {},
    stderr: process.stderr,
    createTransport: async () => ({
      capture: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
      revokeQueue() {},
      captureOptOut: async () => {},
      flush: () => new Promise(() => {}),
      shutdown: async () => {},
      discard: async () => {},
    }),
  });
}

// Work that would otherwise keep the process alive, as a server's sockets do.
setInterval(() => {}, 1_000);
setTimeout(() => {
  process.stdout.write(`crashing ${Date.now()}\n`);
  const failure = new Error("boom in /Users/jane/project/secret.ts");
  if (kind === "rejection") void Promise.reject(failure);
  else throw failure;
}, 50);
