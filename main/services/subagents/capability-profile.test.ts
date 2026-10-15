import assert from "node:assert/strict";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { assembleAgentTools, type AgentToolSources } from "../agent-tool-assembly.js";
import { buildSubagentCapabilityTools } from "./capability-tools.js";
import {
  inheritedSubagentReadToolCeiling,
  parseSubagentCapabilityRequest,
  resolveCapabilityProfile,
  SUBAGENT_READ_TOOL_NAMES,
  SUBAGENT_ROLES,
} from "./capability-profile.js";

test("every V1 role resolves through the same positive read/search ceiling", () => {
  for (const role of SUBAGENT_ROLES) {
    const profile = resolveCapabilityProfile(
      { kind: "subagent", role },
      "full",
    );
    assert.deepEqual(profile.tools, SUBAGENT_READ_TOOL_NAMES);
  }
});

test("capabilities are the parent, role, feature, and inherited intersection", () => {
  assert.deepEqual(
    resolveCapabilityProfile(
      {
        kind: "subagent",
        role: "reviewer",
        featurePolicy: ["read_file", "grep", "run_command"],
        inheritedCeiling: ["grep", "glob", "write_file"],
      },
      "ask",
    ).tools,
    ["grep"],
  );
  assert.deepEqual(
    resolveCapabilityProfile({ kind: "subagent", role: "scout" }, "none").tools,
    [],
  );
});

test("parent tool exclusions become a positive child read-tool ceiling", () => {
  assert.deepEqual(
    inheritedSubagentReadToolCeiling(
      new Set(["read_file", "grep", "run_command"]),
    ),
    ["list_dir", "glob"],
  );
  assert.deepEqual(
    inheritedSubagentReadToolCeiling(undefined),
    SUBAGENT_READ_TOOL_NAMES,
  );
});

test("unknown roles fail closed before workspace tool construction", () => {
  assert.throws(
    () =>
      resolveCapabilityProfile({ kind: "subagent", role: "worker" }, "full"),
    /Unknown subagent role/,
  );
  assert.throws(
    () =>
      buildSubagentCapabilityTools({
        workspaceRoot: path.join(os.tmpdir(), "does-not-need-to-exist"),
        permission: "none",
        capabilityProfile: { kind: "subagent", role: "stale-role" },
      }),
    /Unknown subagent role/,
  );
});

test("an empty capability intersection performs no workspace construction", () => {
  const resolved = buildSubagentCapabilityTools({
    workspaceRoot: path.join(os.tmpdir(), "deleted-or-unavailable-workspace"),
    permission: "none",
    capabilityProfile: { kind: "subagent", role: "scout" },
  });
  assert.deepEqual(resolved.profile.tools, []);
  assert.deepEqual(resolved.tools, []);
});

test("malformed capability profiles and permissions fail closed", () => {
  for (const input of [
    null,
    {},
    { kind: "workspace", role: "scout" },
    { kind: "subagent", role: "scout", unexpected: true },
    { kind: "subagent", role: "scout", featurePolicy: "read_file" },
  ]) {
    assert.throws(
      () => parseSubagentCapabilityRequest(input),
      /Invalid subagent capability/,
    );
  }
  assert.throws(
    () =>
      resolveCapabilityProfile(
        { kind: "subagent", role: "scout" },
        "owner" as never,
      ),
    /Invalid parent workspace permission/,
  );
});

test("the child builder constructs only the four permitted tool objects", () => {
  const root = os.tmpdir();
  const resolved = buildSubagentCapabilityTools({
    workspaceRoot: root,
    permission: "full",
    capabilityProfile: { kind: "subagent", role: "planner" },
  });

  assert.deepEqual(
    resolved.tools.map((tool) => tool.name),
    ["read_file", "list_dir", "glob", "grep"],
  );
  assert.equal(
    resolved.tools.some((tool) =>
      [
        "edit_file",
        "write_file",
        "run_command",
        "computer_use",
        "schedule_task",
        "subagent",
        "web_search",
      ].includes(tool.name),
    ),
    false,
  );
});

test("production assembly resolves capability tools before ambient services or factories", async () => {
  const ambientReads: string[] = [];
  const sources: AgentToolSources = {
    configuredMcpTools: async () => {
      ambientReads.push("mcp");
      return [];
    },
    webSearchToolForGeneration: async () => {
      ambientReads.push("web_search");
      return undefined;
    },
    skillsEnabled: async () => {
      ambientReads.push("skills");
      return true;
    },
    skillSnapshot: async () => {
      ambientReads.push("skill_snapshot");
      return undefined;
    },
  };
  const factory = () => assert.fail("a child never constructs the subagent tool");

  const child = await assembleAgentTools(
    {
      mode: "subagent",
      workspaceRoot: os.tmpdir(),
      workspaceId: "workspace-1",
      permission: "full",
      allowMcpTools: true,
      allowSubagents: true,
      createSubagentTool: factory,
      capabilityProfile: { kind: "subagent", role: "planner" },
    },
    sources,
  );
  assert.deepEqual(
    child.map((tool) => tool.name),
    ["read_file", "list_dir", "glob", "grep"],
  );
  assert.deepEqual(ambientReads, [], "no ambient service is read for a child");

  // A capability profile, even an explicitly undefined one, is honored only
  // in the explicit subagent mode.
  for (const capabilityProfile of [{ kind: "subagent", role: "planner" }, undefined]) {
    await assert.rejects(
      assembleAgentTools(
        { workspaceRoot: os.tmpdir(), permission: "full", createSubagentTool: factory, capabilityProfile },
        sources,
      ),
      /Subagent capabilities require the explicit subagent tool mode/,
    );
  }
  assert.deepEqual(ambientReads, []);
});
