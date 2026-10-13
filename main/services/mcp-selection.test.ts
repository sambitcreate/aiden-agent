import assert from "node:assert/strict";
import test from "node:test";
import { selectedMcpServers } from "./mcp-selection.js";
import type { McpServer } from "./types.js";

const configured: McpServer[] = [
  { id: "gmail", name: "Gmail", transport: "http", url: "https://example.test", enabled: true },
  {
    id: "notion",
    name: "Notion",
    transport: "http",
    url: "https://example.test",
    enabled: false,
  },
];

test("exact scheduled MCP scope never inherits later enabled servers", () => {
  assert.deepEqual(
    selectedMcpServers(configured, ["gmail"]).map((server) => server.id),
    ["gmail"],
  );
  assert.deepEqual(
    selectedMcpServers(
      [...configured, { ...configured[0]!, id: "slack", name: "Slack" }],
      ["gmail"],
    ).map((server) => server.id),
    ["gmail"],
  );
  assert.deepEqual(selectedMcpServers(configured, []), []);
});

test("legacy all-server access stays enabled-only and exact access fails closed", () => {
  assert.deepEqual(
    selectedMcpServers(configured, undefined).map((server) => server.id),
    ["gmail"],
  );
  assert.throws(() => selectedMcpServers(configured, ["notion"]), /disabled/iu);
  assert.throws(() => selectedMcpServers(configured, ["missing"]), /no longer exists/iu);
});

test("an approved schedule naming a server switched off for the model fails instead of running without it", () => {
  const hidden = [...configured, { ...configured[0]!, id: "drive", name: "Drive", exposure: "hidden" as const }];
  assert.throws(() => selectedMcpServers(hidden, ["gmail", "drive"]), /"Drive" is off for the model/u);
  // A server that only hides some tools still runs.
  assert.deepEqual(selectedMcpServers([{ ...configured[0]!, hiddenTools: ["send"] }], ["gmail"]).map(({ id }) => id), ["gmail"]);
});
