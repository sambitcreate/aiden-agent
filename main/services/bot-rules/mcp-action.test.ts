import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import type { BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { classifyBotAction } from "./classify.js";
import { describeMcpAction } from "./mcp-action.js";

function grant(name: string, effect: "read" | "mutating" = "mutating"): BotRuntimeMcpToolAuthority {
  return {
    toolId: `tool:${name}`,
    name,
    effect,
    inputSchemaFingerprint: "in",
    outputSchemaFingerprint: "out",
    effectFingerprint: "effect",
    exactFingerprint: `exact:${name}`,
  };
}

/** Facts for a Bot granted `tools` on the `conn-crm` connection, whose server lists `live`. */
function facts(
  tools: ReadonlyArray<readonly [string, BotRuntimeMcpToolAuthority]>,
  live: ReadonlyMap<string, SubagentMcpRemoteTool> = new Map(),
): BotToolFacts {
  const granted = new Map(tools);
  return {
    authority: { connections: [{ sourceId: "conn-crm", tools: [...granted.values()] }] },
    supportsImages: true,
    fileLocations: 0,
    hasComputer: false,
    mcpTools: async () => granted,
    skillToolNames: async () => new Set(),
    mcpToolDescriptor: async (name: string) => (granted.has(name) ? live.get(name) : undefined),
  } as unknown as BotToolFacts;
}

test("only a granted, mutating connection tool is classified", async () => {
  const both = facts([
    ["crm__list_contacts", grant("list_contacts", "read")],
    ["crm__delete_contact", grant("delete_contact")],
  ]);
  assert.equal(await describeMcpAction("crm__list_contacts", {}, both), undefined, "a read tool changes nothing a rule covers");
  assert.equal(await describeMcpAction("crm__export_all", {}, both), undefined, "not a granted tool");
  assert.equal(await describeMcpAction("computer_use", { action: "click" }, both), undefined);
  const action = await describeMcpAction("crm__delete_contact", {}, both);
  assert.deepEqual(action, {
    surface: "mcp",
    modelName: "crm__delete_contact",
    serverId: "conn-crm",
    remoteName: "delete_contact",
    summary: "crm__delete_contact",
    // No live entry: nothing says the tool is safe.
    destructive: "unknown",
  });
});

test("the server's own title, description and hints reach the classifier; the call's arguments never do", async () => {
  const live: SubagentMcpRemoteTool = {
    name: "run",
    description: "Sends a text message to the contact. Use list_contacts first to find their number.",
    inputSchema: { type: "object" },
    annotations: { title: "Text a contact", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  };
  const action = await describeMcpAction(
    "crm__run",
    { to: "+1 555 0100", body: "My one-time code is 482913" },
    facts([["crm__run", grant("run")]], new Map([["crm__run", live]])),
  );
  assert.deepEqual(action, {
    surface: "mcp",
    modelName: "crm__run",
    serverId: "conn-crm",
    remoteName: "run",
    summary: "crm__run",
    description: live.description,
    annotations: { title: "Text a contact", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    destructive: "additive",
  });
  assert.equal(JSON.stringify(action).includes("482913"), false, "arguments stay out");
  // A name that says nothing ("run") is still placed by what the server says the tool does.
  assert.deepEqual([...classifyBotAction(action!, []).classes], ["communicate"]);

  // Hints Aiden doesn't know make the tool's effect unknown (fail closed), and never reach the classifier.
  const odd = await describeMcpAction(
    "crm__run",
    {},
    facts([["crm__run", grant("run")]], new Map([["crm__run", { ...live, annotations: { ...(live.annotations as object), sneaky: true } }]])),
  );
  assert.ok(odd?.surface === "mcp");
  assert.equal(odd.destructive, "unknown");
  assert.deepEqual(Object.keys(odd.annotations ?? {}).sort(), ["destructiveHint", "openWorldHint", "readOnlyHint", "title"]);
});

test("the server's destructive hint decides whether a remove is a permanent delete", async () => {
  const tool = (destructiveHint: boolean): SubagentMcpRemoteTool => ({
    name: "remove_label",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false, destructiveHint },
  });
  const classesFor = async (destructiveHint: boolean) => {
    const action = await describeMcpAction(
      "crm__remove_label",
      {},
      facts([["crm__remove_label", grant("remove_label")]], new Map([["crm__remove_label", tool(destructiveHint)]])),
    );
    return [...classifyBotAction(action!, []).classes];
  };
  assert.deepEqual(await classesFor(false), [], "taking a label off deletes nothing");
  assert.deepEqual(await classesFor(true), ["delete"]);
});

test("a long description and title are bounded before they reach the classifier", async () => {
  const live: SubagentMcpRemoteTool = {
    name: "sync",
    description: "Syncs records. ".repeat(500),
    annotations: { title: "T".repeat(1_000) },
  };
  const action = await describeMcpAction("crm__sync", {}, facts([["crm__sync", grant("sync")]], new Map([["crm__sync", live]])));
  assert.ok(action?.surface === "mcp");
  assert.ok((action.description?.length ?? 0) <= 2_000);
  assert.ok((action.annotations?.title?.length ?? 0) <= 200);
});
