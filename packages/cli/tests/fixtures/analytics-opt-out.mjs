// A real `aiden telemetry off` in its own process, for racing a server's start.
// Usage: analytics-opt-out.mjs <agentDir> <appDir> <file to create just before it runs>
import { writeFileSync } from "node:fs";

const [agentDir, appDir, starting] = process.argv.slice(2);
const api = await import("../../dist/parity-test-api.js");

writeFileSync(starting, "");
await api.telemetryCommand(agentDir, ["off"], {
  agentDir,
  appDir,
  env: {},
  stderr: process.stderr,
  createTransport: async () => ({
    capture() {},
    revokeQueue() {},
    captureOptOut: async (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); },
    flush: async () => {},
    shutdown: async () => {},
    discard: async () => {},
  }),
});
