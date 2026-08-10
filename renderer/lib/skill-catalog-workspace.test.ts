import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkillCatalogWorkspaceId } from "./skill-catalog-workspace.js";

const workspaces = [{ id: "first" }, { id: "second" }];

test("skill catalog workspace follows a valid stored workspace", () => {
  assert.equal(resolveSkillCatalogWorkspaceId(workspaces, "second"), "second");
});

test("skill catalog workspace falls back after first run or a stale/deleted id", () => {
  assert.equal(resolveSkillCatalogWorkspaceId(workspaces, null), "first");
  assert.equal(resolveSkillCatalogWorkspaceId(workspaces, "deleted"), "first");
  assert.equal(resolveSkillCatalogWorkspaceId([], "deleted"), undefined);
});
