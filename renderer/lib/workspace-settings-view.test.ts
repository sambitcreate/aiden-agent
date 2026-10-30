import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorRowView,
  groupWorkspaceSkills,
  skillRowNote,
  withOffListEntry,
  workspaceHasOwnSettings,
} from "./workspace-settings-view";
import type { McpServer } from "./types";
import type { WorkspaceSkillChoice } from "../../main/services/skill-registry";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return { id: "notion", name: "Notion", transport: "http", url: "https://example.test", enabled: true, ...overrides };
}

function skill(overrides: Partial<WorkspaceSkillChoice> = {}): WorkspaceSkillChoice {
  return {
    key: "review",
    name: "Review",
    description: "Review a change.",
    source: "global",
    available: true,
    offHere: false,
    userOnly: false,
    ...overrides,
  };
}

test("only a workspace with a folder has its own settings; chats without one follow Settings", () => {
  assert.equal(workspaceHasOwnSettings({ folderPath: "/projects/site" }), true);
  assert.equal(workspaceHasOwnSettings({}), false);
  assert.equal(workspaceHasOwnSettings(undefined), false);
});

test("switching an entry off and on again leaves the stored list as it was", () => {
  const off = withOffListEntry(["gmail"], "notion", true);
  assert.deepEqual(off, ["gmail", "notion"]);
  assert.deepEqual(withOffListEntry(off, "notion", true), off, "switching off twice stores it once");
  assert.deepEqual(withOffListEntry(off, "notion", false), ["gmail"]);
  assert.deepEqual(withOffListEntry(undefined, "linear", false), []);
});

test("Settings wins over the workspace switch for a connector that is off there", () => {
  assert.deepEqual(
    [connectorRowView(server({ enabled: false }), false), connectorRowView(server({ exposure: "hidden" }), false)].map(
      ({ on, lockedBySettings, note }) => [on, lockedBySettings, note],
    ),
    [
      [false, true, "Off in Settings"],
      [false, true, "Off for the model in Settings → Connectors"],
    ],
  );
  assert.equal(connectorRowView(server(), true).on, false);
  assert.equal(connectorRowView(server(), true).lockedBySettings, false);
  assert.equal(connectorRowView(server(), false).on, true);
});

test("skills group as yours, this folder's, then built-in and global, and search narrows every group", () => {
  const skills = [
    skill({ key: "deploy", name: "Deploy", source: "workspace" }),
    skill({ key: "aiden", name: "Aiden help", source: "builtin" }),
    skill({ key: "notes", name: "Notes", source: "configured", description: "Draft release notes." }),
    skill({ key: "review", name: "Review", source: "global" }),
  ];
  assert.deepEqual(
    groupWorkspaceSkills(skills).map(({ title, skills: inGroup }) => [title, inGroup.map(({ name }) => name)]),
    [
      ["Your skills", ["Notes"]],
      ["From this folder", ["Deploy"]],
      ["Built-in and global", ["Aiden help", "Review"]],
    ],
  );
  assert.deepEqual(
    groupWorkspaceSkills(skills, "release").map(({ skills: inGroup }) => inGroup.map(({ name }) => name)),
    [["Notes"]],
  );
  assert.deepEqual(groupWorkspaceSkills(skills, "nothing like this"), []);
});

test("a skill's line says why it is off or can't be switched", () => {
  assert.equal(skillRowNote(skill({ offHere: true })), "Still runs if you type $Review");
  assert.equal(skillRowNote(skill({ userOnly: true })), "Runs only when you ask for it by name");
  assert.equal(
    skillRowNote(skill({ available: false, unavailableReason: "Workspace skills require workspace access." })),
    "Workspace skills require workspace access.",
  );
});
