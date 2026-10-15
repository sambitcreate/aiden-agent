import assert from "node:assert/strict";
import test from "node:test";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import {
  assertUniqueMcpAgentToolNames,
  markMcpAgentTool,
  mcpAgentToolIdentity,
  mcpAgentToolName,
  mcpAgentToolNames,
  mcpScopedAgentToolName,
} from "./mcp-tool-identity.js";

const github = { id: "srv-github", name: "GitHub" };
const linear = { id: "srv-linear", name: "Linear" };

test("plain names are <server>__<tool> and already valid codemode identifiers", () => {
  const names = mcpAgentToolNames(github, [github, linear], ["create_issue", "list-repos", "search.code"]);
  assert.equal(names.get("create_issue"), "github__create_issue");
  assert.equal(names.get("list-repos"), "github__list_repos");
  assert.equal(names.get("search.code"), "github__search_code");
  for (const name of names.values()) assert.equal(toCodemodeIdentifier(name), name);
  // A server name starting with a digit still yields a script identifier.
  const digits = mcpAgentToolName({ id: "x", name: "1Password" }, "get item", { configured: [], inventory: ["get item"] });
  assert.equal(digits, "mcp_1password__get_item");
  assert.equal(toCodemodeIdentifier(digits), digits);
});

test("tools that sanitize to one name all get stable suffixes, whatever the inventory order", () => {
  const forward = mcpAgentToolNames(github, [github], ["a-b", "a_b", "a.b", "other"]);
  const reverse = mcpAgentToolNames(github, [github], ["other", "a.b", "a_b", "a-b"]);
  assert.deepEqual([...forward].sort(), [...reverse].sort());
  const collided = ["a-b", "a_b", "a.b"].map((tool) => forward.get(tool)!);
  assert.equal(new Set(collided).size, 3);
  for (const name of collided) assert.match(name, /^github__a_b_[0-9a-f]{8}$/u);
  assert.equal(forward.get("other"), "github__other");
});

test("an unrelated tool joining the inventory never renames existing tools", () => {
  const before = mcpAgentToolNames(github, [github], ["create_issue", "a-b"]);
  const after = mcpAgentToolNames(github, [github], ["create_issue", "a-b", "late_tool"]);
  assert.equal(after.get("create_issue"), before.get("create_issue"));
  assert.equal(after.get("a-b"), before.get("a-b"));
});

test("long names are cut to 64 characters with a suffix bound to the exact raw tool", () => {
  const first = "y".repeat(100);
  const second = `${"y".repeat(99)}z`;
  const names = mcpAgentToolNames({ id: "long", name: "x".repeat(200) }, [], [first, second]);
  for (const name of names.values()) {
    assert.ok(name.length <= 64);
    assert.equal(toCodemodeIdentifier(name), name);
  }
  assert.notEqual(names.get(first), names.get(second));
  assert.equal(mcpAgentToolNames({ id: "long", name: "x".repeat(200) }, [], [first]).get(first), names.get(first));
});

test("servers whose prefixes collide are each disambiguated by their own id", () => {
  const work = { id: "github-work", name: "GitHub" };
  const personal = { id: "github-personal", name: "github" };
  const configured = [work, personal, linear];
  const workName = mcpAgentToolName(work, "create_issue", { configured, inventory: ["create_issue"] });
  const personalName = mcpAgentToolName(personal, "create_issue", { configured, inventory: ["create_issue"] });
  assert.notEqual(workName, personalName);
  assert.match(workName, /^github_[0-9a-f]{6}__create_issue$/u);
  assert.equal(
    mcpAgentToolName(work, "create_issue", { configured: [linear, personal, work], inventory: ["create_issue"] }),
    workName,
  );
  assert.equal(mcpAgentToolName(linear, "x", { configured, inventory: ["x"] }), "linear__x");
});

test("a separator inside a server name cannot alias another server's tool", () => {
  const nested = { id: "one", name: "a__b" };
  const plain = { id: "two", name: "a" };
  const configured = [nested, plain];
  assert.notEqual(
    mcpAgentToolName(nested, "c", { configured, inventory: ["c"] }),
    mcpAgentToolName(plain, "b__c", { configured, inventory: ["b__c"] }),
  );
});

test("scoped (subagent) names need no inventory and never collide across approved subsets", () => {
  const server = { id: "docs", name: "docs" };
  assert.equal(mcpScopedAgentToolName(server, "publish"), "docs__publish");
  const hyphen = mcpScopedAgentToolName(server, "a-b");
  const underscore = mcpScopedAgentToolName(server, "a_b");
  assert.equal(underscore, "docs__a_b");
  assert.match(hyphen, /^docs__a_b_[0-9a-f]{8}$/u);
  assertUniqueMcpAgentToolNames([{ name: hyphen }, { name: underscore }]);
});

test("built tools carry their real MCP identity through object copies", () => {
  const tool = markMcpAgentTool({ name: "github__create_issue" }, { serverId: github.id, toolName: "create_issue" });
  assert.deepEqual(mcpAgentToolIdentity({ ...tool }), { serverId: github.id, toolName: "create_issue" });
  assert.equal(mcpAgentToolIdentity({ name: "a__b" }), undefined);
  assert.throws(() => assertUniqueMcpAgentToolNames([tool, { ...tool }]), /identity collision/iu);
});
