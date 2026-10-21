/* global process */

// A stand-in for the guest side of the driver bridge (`ssh … -- cua-driver mcp
// --embedded --socket …`): MCP JSON-RPC on stdio over the shared fake 0.36.0
// driver. Unlike Aiden's native bridge on the Mac, the guest's MCP proxy
// forwards every upstream tool, so this lists them all, including the ones
// Aiden's allowlist must drop.
//
// Options:
//   --log <file>                  append one JSON line per request
//   --permissions-file <file>     JSON {accessibility, screen_recording}, read on every check
//   --grant-on-prompt             a prompting check_permissions grants both (the person allowed them)
//   --schema-version <v>          tools/list schema_version (default "1")
//   --driver-version <v>          health_report driver_version (default "0.36.0")
//   --exit <code>                 exit at once with this code (the daemon never came up)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import { FakeCuaDriver, TOOL_DEFINITIONS, toolListResult } from "../../computer-use/fixtures/cua-driver-catalog.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const logPath = option("--log");
const permissionsFile = option("--permissions-file");
const schemaVersion = option("--schema-version") ?? "1";
const driverVersion = option("--driver-version") ?? "0.36.0";
const grantOnPrompt = argv.includes("--grant-on-prompt");
const exitCode = option("--exit");

const log = (event) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
};

if (exitCode !== undefined) {
  process.stderr.write("cua-driver: no Cua Driver daemon listening.\n");
  process.exit(Number(exitCode));
}

const readPermissions = () => {
  if (!permissionsFile || !existsSync(permissionsFile)) return { accessibility: true, screen_recording: true };
  return JSON.parse(readFileSync(permissionsFile, "utf8"));
};

const driver = new FakeCuaDriver({ permissions: readPermissions() });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const listing = { ...toolListResult(Object.keys(TOOL_DEFINITIONS)), schema_version: schemaVersion };

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-guest-cua-driver", version: driverVersion },
      },
    });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: listing });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    log({ event: "tool-call", name, args });
    if (name === "check_permissions" && args.prompt === true && grantOnPrompt && permissionsFile) {
      writeFileSync(permissionsFile, JSON.stringify({ accessibility: true, screen_recording: true }));
    }
    driver.permissions = readPermissions();
    let result = driver.call(name, args);
    if (name === "health_report") {
      result = {
        ...result,
        structuredContent: { ...result.structuredContent, driver_version: driverVersion },
      };
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
lines.on("close", () => process.exit(0));
