import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatMcpServersSection,
  journaledMcpServersSection,
  MCP_SERVERS_SECTION_ENTRY,
} from "./chat-prompt-sections.js";
import { MCP_SERVERS_SECTION_LIMITS } from "./mcp-server-instructions.js";
import { markMcpAgentTool } from "./mcp-tool-identity.js";
import { createPiSessionPort } from "./pi-session-port.js";
import { InMemorySessionRepo } from "./pi-session-repository-port.js";
import type { PiDiscoverableTool } from "./pi-tool-discovery.js";

async function journal() {
  return createPiSessionPort(await new InMemorySessionRepo().create({ id: `sections-${Math.random()}` }));
}

function serverTool(serverId: string, label: string, description: string): PiDiscoverableTool {
  return markMcpAgentTool({
    name: `${serverId}_search`,
    description: `Search ${label}.`,
    discovery: { namespace: `mcp:${serverId}`, label, alias: serverId, description },
  } as PiDiscoverableTool, { serverId, toolName: "search" });
}

const declared = new Set(["codemode"]);

/** One generation the way llm-client runs it: read the journal, apply once, record. */
async function generation(
  port: Awaited<ReturnType<typeof journal>>,
  inventory: readonly PiDiscoverableTool[],
  connectorsWithheld = false,
) {
  let reads = 0;
  const section = createChatMcpServersSection({
    inventory: () => { reads += 1; return inventory; },
    declared,
    journaled: journaledMcpServersSection(await port.getBranch()),
    connectorsWithheld,
  });
  const prepared = section.apply({ messages: [] });
  await section.record(port);
  // The section text the generation's system carries ("" for none).
  const shown = prepared.messages
    .map((message) => (message as { sections?: Record<string, string> }).sections?.["mcp-servers"] ?? "")
    .join("");
  return { shown, turnNote: section.turnNote, reads };
}

const linear = serverTool("linear", "Linear", "Issue tracker tools.");
const docs = serverTool("docs", "Docs", "Team wiki pages.");

test("a follow-up that withholds connectors shows the section the chat last showed, without reading its servers", async () => {
  const port = await journal();
  const attended = await generation(port, [linear]);
  assert.match(attended.shown, /Issue tracker tools\./u);
  assert.equal(attended.turnNote, "");

  const followUp = await generation(port, [], true);
  assert.equal(followUp.shown, attended.shown, "the section is the same bytes");
  assert.equal(followUp.reads, 0, "no connector inventory is consulted");
  assert.match(followUp.turnNote, /not connected for this follow-up/u);
});

test("a section is journaled only when it changes, and the latest one wins", async () => {
  const port = await journal();
  const count = async () => (await port.getBranch()).filter((entry) => entry.type === "custom" && entry.customType === MCP_SERVERS_SECTION_ENTRY).length;
  await generation(port, [linear]);
  await generation(port, [linear]);
  assert.equal(await count(), 1, "an unchanged section is not journaled again");
  await generation(port, [linear], true);
  assert.equal(await count(), 1, "a withheld turn journals nothing");
  await generation(port, [linear, docs]);
  assert.equal(await count(), 2);
  assert.match(journaledMcpServersSection(await port.getBranch()) ?? "", /Team wiki pages\./u);

  // The person disconnected every server: the next follow-up lists none and says nothing.
  await generation(port, []);
  assert.equal(journaledMcpServersSection(await port.getBranch()), "");
  const followUp = await generation(port, [], true);
  assert.equal(followUp.shown, "");
  assert.equal(followUp.turnNote, "");
});

test("a chat with nothing journaled withholds an empty section and no note", async () => {
  const followUp = await generation(await journal(), [linear], true);
  assert.equal(followUp.shown, "");
  assert.equal(followUp.turnNote, "");
  assert.equal(followUp.reads, 0);
});

test("a compaction keeps the journaled section; malformed or oversized entries are ignored", async () => {
  const port = await journal();
  const attended = await generation(port, [linear]);
  await port.appendCompaction({ id: "cut", summary: "earlier", retainedTail: [], tokensBefore: 10 });
  await port.appendCustomEntry(MCP_SERVERS_SECTION_ENTRY, { text: 42 });
  await port.appendCustomEntry(MCP_SERVERS_SECTION_ENTRY, {
    text: "x".repeat(MCP_SERVERS_SECTION_LIMITS.totalBytes + MCP_SERVERS_SECTION_LIMITS.guidanceBytes + 1),
  });
  const followUp = await generation(port, [], true);
  assert.equal(followUp.shown, attended.shown);
});
