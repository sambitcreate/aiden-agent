import { isDeepStrictEqual } from "node:util";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";

export function imcpMailToolSchemaEligible(tool: SubagentMcpRemoteTool): boolean {
  const schema = tool.inputSchema as { type?: unknown; properties?: Record<string, { type?: unknown; minimum?: unknown; maximum?: unknown }>; additionalProperties?: unknown; required?: unknown } | undefined;
  const annotations = tool.annotations as { readOnlyHint?: unknown; openWorldHint?: unknown } | undefined;
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false || !schema.properties || annotations?.readOnlyHint !== true || annotations.openWorldHint !== false || tool.execution !== undefined || tool.outputSchema !== undefined) return false;
  const keys = Object.keys(schema.properties).sort();
  if (tool.name === "mail_mailboxes_list") return keys.length === 0 && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
  if (tool.name !== "mail_messages_search" || !isDeepStrictEqual(keys, ["cursor", "end", "isRead", "limit", "mailbox", "sender", "start", "subject"])) return false;
  return keys.every((key) => schema.properties![key]?.type === (key === "limit" ? "integer" : key === "isRead" ? "boolean" : "string")) && schema.properties.limit?.minimum === 1 && schema.properties.limit?.maximum === 100 && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
}
