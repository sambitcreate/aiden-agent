import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAppearanceConfig,
  normalizeAppearanceConfig,
  parseAppearanceConfig,
} from "../shared/appearance";
import {
  formatWorkspacePath,
  workspaceDisplayName,
  workspaceSecondaryLabel,
} from "./workspace-path-display";
import type { Workspace } from "./types";

const path = "/Users/xyz/work/long-parent/projects/aiden";
const workspace = { id: "default", name: "Aiden", folderPath: path } as Workspace;

test("duplicate workspace names get stable distinct path-free identities", () => {
  const one = { ...workspace, id: "workspace-a1234" };
  const two = { ...workspace, id: "workspace-b1234", folderPath: "/other/private/folder" };
  assert.equal(workspaceDisplayName(one, [one]), "Aiden");
  assert.equal(workspaceDisplayName(one, [one, two]), "Aiden · a1234");
  assert.equal(workspaceDisplayName(two, [two, one]), "Aiden · b1234");
  assert.notEqual(workspaceDisplayName(one, [one, two]), workspaceDisplayName(two, [one, two]));
});

test("new and legacy profiles hide workspace paths by default", () => {
  for (const preferences of [createDefaultAppearanceConfig(), normalizeAppearanceConfig({})]) {
    assert.equal(preferences.showWorkspacePaths, false);
    assert.equal(workspaceSecondaryLabel(workspace, preferences), "");
  }
  const legacy = { ...createDefaultAppearanceConfig() } as Record<string, unknown>;
  delete legacy.showWorkspacePaths;
  delete legacy.workspacePathFormat;
  assert.equal(parseAppearanceConfig(legacy).showWorkspacePaths, false);
});

test("each format retains the requested portion and respects its budget", () => {
  assert.equal(formatWorkspacePath(path, "middle", 26), "/Users/…/projects/aiden");
  assert.equal(formatWorkspacePath(path, "end", 20), "…/projects/aiden");
  assert.equal(formatWorkspacePath(path, "start", 20), "/Users/xyz/work/lon…");
  for (const format of ["middle", "end", "start"] as const) {
    for (const length of [0, 1, 2, 7, 20, 44]) {
      assert.ok(formatWorkspacePath(path, format, length).length <= length);
      assert.ok(
        formatWorkspacePath("C:\\Users\\xyz\\long-parent\\projects\\aiden", format, length)
          .length <= length,
      );
    }
    assert.equal(formatWorkspacePath(" /aiden ", format), " /aiden ");
    assert.equal(formatWorkspacePath("", format), "");
  }
});

test("formatting preserves legal whitespace and whole Unicode graphemes", () => {
  for (const format of ["middle", "start", "end"] as const) {
    assert.equal(formatWorkspacePath("/tmp/folder ", format, 99), "/tmp/folder ");
    for (const path of ["/😀😀😀/project", "/e\u0301/e\u0301/e\u0301", "/👩‍💻👩‍💻/project"]) {
      for (const length of [2, 3, 4, 8, 12]) {
        const label = formatWorkspacePath(path, format, length);
        assert.ok(label.length <= length);
        assert.doesNotMatch(
          label,
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
        );
        assert.doesNotMatch(label, /…\u0301|e…|\u200D…|…\u200D/u);
      }
    }
  }
});

test("branch and folderless identity survive hiding paths", () => {
  const preferences = createDefaultAppearanceConfig();
  const worktree = { ...workspace, managedWorktree: { branch: "feature/test" } } as Workspace;
  assert.equal(workspaceSecondaryLabel(worktree, preferences), "feature/test");
  assert.equal(
    workspaceSecondaryLabel({ ...workspace, folderPath: undefined }, preferences),
    "No folder · default",
  );
  assert.equal(
    workspaceSecondaryLabel(worktree, { ...preferences, showWorkspacePaths: true }),
    `feature/test · ${path}`,
  );
});

test("preferences persist and malformed inputs cannot enable paths", () => {
  for (const workspacePathFormat of ["middle", "end", "start"] as const) {
    const preferences = {
      ...createDefaultAppearanceConfig(),
      showWorkspacePaths: true,
      workspacePathFormat,
    };
    assert.deepEqual(parseAppearanceConfig(JSON.parse(JSON.stringify(preferences))), preferences);
  }
  assert.equal(
    normalizeAppearanceConfig({ showWorkspacePaths: "true", workspacePathFormat: "unknown" })
      .showWorkspacePaths,
    false,
  );
  assert.throws(() =>
    parseAppearanceConfig({ ...createDefaultAppearanceConfig(), showWorkspacePaths: "false" }),
  );
  assert.throws(() =>
    parseAppearanceConfig({ ...createDefaultAppearanceConfig(), workspacePathFormat: "unknown" }),
  );
});
