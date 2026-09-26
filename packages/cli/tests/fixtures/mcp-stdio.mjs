import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const [revisionFile, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cli-test", version: "1" } };
  else if (request.method === "tools/list") {
    const second = request.params?.cursor === "second";
    result = { tools: [{ name: second ? "second" : "first", description: existsSync(revisionFile) ? "Changed schema" : "Original schema", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }], ...(second ? {} : { nextCursor: "second" }) };
  } else if (request.method === "tools/call") result = { content: [{ type: "text", text: `Echo ${request.params.arguments.value}` }] };
  else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
