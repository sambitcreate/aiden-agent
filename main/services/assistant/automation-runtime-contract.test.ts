import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("approved automations receive only folder-scoped coding tools and exact MCP scope", () => {
  const tools = between(
    source("../tools.ts"),
    'if (ctx.mode === "assistant-automation")',
    "const tools: AgentTool[] = [];",
  );
  assert.match(tools, /buildCodingTools\(ctx\.workspaceRoot\)/u);
  assert.match(tools, /ctx\.allowMcpTools === true/u);
  assert.match(tools, /configuredMcpTools\(ctx\)/u);
  assert.doesNotMatch(tools, /buildSchedulingTools|makeExaTool|skillToolKey/u);

  const execution = source("../schedule-execution.ts");
  assert.match(execution, /const allowMcpTools =/u);
  assert.match(execution, /mcpServerIds,/u);
  assert.match(execution, /allowComputerUse: false/u);
  assert.match(execution, /allowSubagents: false/u);
});

test("attended Assistant sees MCP identities but never ambient connector tools", () => {
  const tools = between(
    source("../tools.ts"),
    'if (ctx.mode === "assistant")',
    "// An approved project automation",
  );
  assert.match(tools, /createAssistantMcpServerTool/u);
  assert.match(tools, /ctx\.allowMcpTools === true/u);
  assert.match(tools, /configuredMcpTools\(ctx\)/u);
  assert.match(tools, /ctx\.allowScheduling === false/u);

  const client = source("../llm-client.ts");
  assert.match(client, /assistantMcpServerInventory/u);
  assert.match(client, /mcpServers: assistantMcpServers/u);
});

test("the internal project automation mode cannot be requested by the renderer", () => {
  const parser = source("../../handlers/chat-params.ts");
  assert.match(parser, /p\.mode !== undefined && p\.mode !== "assistant"/u);

  const client = source("../llm-client.ts");
  assert.match(client, /params\.mode === "assistant-automation"/u);
  assert.match(client, /withUnattendedAssistantContract/u);
  assert.match(client, /resolveAssistantScheduleProject\(proposal\)/u);
});

test("declining an attended proposal tells the model to continue the conversation", () => {
  const client = source("../llm-client.ts");
  assert.match(client, /The user declined this automation\. Do not retry it\./u);
  assert.match(client, /Okay—what else should we do\?/u);
});

test("repeated attended tool errors are bounded before they can loop indefinitely", () => {
  const client = source("../llm-client.ts");
  assert.match(client, /prepareNextTurnWithContext/u);
  assert.match(client, /advanceAttendedToolErrorState/u);
  assert.match(client, /recoverAttendedToolErrorContext\(context, hasEnabledMcpServers\)/u);
  assert.doesNotMatch(client, /candidate\?\.abort\(\)/u);

  const guard = source("./tool-loop-guard.ts");
  assert.match(guard, /MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS = 2/u);
  assert.match(guard, /result\.isError === true/u);
  assert.match(guard, /tools: \[\]/u);
});
