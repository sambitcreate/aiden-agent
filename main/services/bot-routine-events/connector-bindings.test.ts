import assert from "node:assert/strict";
import test from "node:test";
import { imcpMailToolSchemaEligible } from "./connector-bindings.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";

const search: SubagentMcpRemoteTool = { name: "mail_messages_search", annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: {
  type: "object", additionalProperties: false, properties: { sender: { type: "string" }, subject: { type: "string" }, mailbox: { type: "string" }, start: { type: "string" }, end: { type: "string" }, isRead: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } },
} };
test("Mail eligibility requires the understood fixed read schema and affirmative trusted metadata", () => {
  assert.equal(imcpMailToolSchemaEligible(search), true);
  assert.equal(imcpMailToolSchemaEligible({ name: "mail_mailboxes_list", annotations: search.annotations, inputSchema: { type: "object", additionalProperties: false, properties: {} } }), true);
  for (const bad of [
    { ...search, name: "MULTI_EXECUTE" }, { ...search, annotations: { readOnlyHint: false, openWorldHint: false } },
    { ...search, annotations: { readOnlyHint: true, openWorldHint: true } }, { ...search, outputSchema: { type: "object" } },
    { ...search, execution: { taskSupport: "required" } }, { ...search, inputSchema: { ...(search.inputSchema as object), required: "mailbox" } },
    { ...search, inputSchema: { ...(search.inputSchema as object), additionalProperties: true } },
    { ...search, inputSchema: { type: "object", additionalProperties: false, properties: { arbitrary_url: { type: "string" } } } },
  ]) assert.equal(imcpMailToolSchemaEligible(bad), false);
});
