// A newline-framed stdio MCP server for the Connectors E2E: it answers
// initialize and lists two tools. Nothing else is implemented or contacted.
import process from "node:process";

let buffer = "";
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "aiden-e2e-tools", version: "1" },
      });
    } else if (message.method === "tools/list") {
      reply(message.id, {
        tools: ["echo", "count"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
      });
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } })}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
