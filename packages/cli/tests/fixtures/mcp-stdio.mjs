import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
// Modes: "" (paginated, no list_changed), "listChanged", "many" (300 tools), "hang" (never initializes).
const [revisionFile, pidFile, mode = ""] = process.argv.slice(2);
appendFileSync(pidFile, `${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const inputSchema = { type: "object", properties: { value: { type: "string" }, count: { type: ["integer", "null"], format: "uint32", minimum: 0.0 } }, required: ["value"] };
const outputSchema = { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false };
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined || mode === "hang") return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: mode === "listChanged" ? { listChanged: true } : {} }, serverInfo: { name: "cli-test", version: "1" } };
  else if (request.method === "tools/list") {
    appendFileSync(`${pidFile}.lists`, "list\n");
    const description = existsSync(revisionFile) ? "Changed schema" : "Original schema";
    if (mode === "many") result = { tools: Array.from({ length: 300 }, (_, index) => ({ name: `tool${index}`, description, inputSchema })) };
    else {
      const second = request.params?.cursor === "second";
      result = { tools: [{ name: second ? "second" : "first", description, inputSchema, ...(second ? { outputSchema } : {}) }], ...(second ? {} : { nextCursor: "second" }) };
    }
  } else if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    if (args.value === "notify") {
      writeFileSync(revisionFile, "changed");
      send({ method: "notifications/tools/list_changed" });
    }
    // A tool failure may carry diagnostic JSON that does not match the success schema.
    if (args.value === "fail") result = { isError: true, content: [{ type: "text", text: "Diagnostic failure" }], structuredContent: { diagnostic: "bad input" } };
    else result = { content: [{ type: "text", text: `Echo ${args.value}` }], ...(name === "second" ? { structuredContent: { echo: args.value } } : {}) };
  } else result = {};
  send({ id: request.id, result });
});
