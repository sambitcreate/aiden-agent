import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenApplicationArguments,
  launchApplicationBundle,
  openFolderInExternalEditor,
  resolveInstalledEditorApplications,
  type OpenFolderInEditorDependencies,
  type ResolvedExternalEditor,
} from "./external-editors.js";

const cursor: ResolvedExternalEditor = {
  id: "cursor",
  label: "Cursor",
  appPath: "/Applications/Cursor.app",
  bundleId: "com.todesktop.230313mzl4w4u92",
  iconDataUrl: "data:image/png;base64,icon",
};

function dependencies(
  overrides: Partial<OpenFolderInEditorDependencies> = {},
): OpenFolderInEditorDependencies {
  return {
    stat: async () => ({ isDirectory: () => true }),
    editors: async () => [cursor],
    openPath: async () => "",
    launchApplication: async () => {},
    ...overrides,
  };
}

test("filters unknown apps and coalesces duplicate Antigravity bundles", () => {
  const resolved = resolveInstalledEditorApplications([
    {
      appPath: "/Applications/Antigravity IDE.app",
      bundleId: "com.google.antigravity-ide",
    },
    {
      appPath: "/Applications/Antigravity.app",
      bundleId: "com.google.antigravity",
    },
    {
      appPath: "/Applications/Cursor.app",
      bundleId: "com.todesktop.230313mzl4w4u92",
    },
    { appPath: "/Applications/Devin.app", bundleId: "com.exafunction.windsurf" },
    { appPath: "/Applications/Unknown.app", bundleId: "example.unknown" },
  ]);

  assert.deepEqual(
    resolved.map(({ id, appPath }) => ({ id, appPath })),
    [
      { id: "cursor", appPath: "/Applications/Cursor.app" },
      { id: "antigravity", appPath: "/Applications/Antigravity.app" },
    ],
  );
});

test("rejects an unknown editor ID before touching the workspace path", async () => {
  let statCalled = false;
  await assert.rejects(
    openFolderInExternalEditor(
      "/tmp/workspace",
      "not-a-real-editor",
      dependencies({
        stat: async () => {
          statCalled = true;
          return { isDirectory: () => true };
        },
      }),
    ),
    /Unknown editor/,
  );
  assert.equal(statCalled, false);
});

test("rejects missing and non-directory workspace folders", async () => {
  await assert.rejects(
    openFolderInExternalEditor(
      "/missing/workspace",
      "cursor",
      dependencies({ stat: async () => Promise.reject(new Error("ENOENT")) }),
    ),
    /Workspace folder is no longer available/,
  );
  await assert.rejects(
    openFolderInExternalEditor(
      "/tmp/file.txt",
      "cursor",
      dependencies({ stat: async () => ({ isDirectory: () => false }) }),
    ),
    /Workspace path is not a folder/,
  );
});

test("launches with fixed open arguments and never interprets the folder as shell syntax", async () => {
  const folderPath = "/tmp/workspace; touch should-not-exist";
  assert.deepEqual(buildOpenApplicationArguments(cursor.bundleId, folderPath), [
    "-b",
    cursor.bundleId,
    folderPath,
  ]);

  let invocation: { file: string; args: readonly string[] } | undefined;
  await launchApplicationBundle(cursor.bundleId, folderPath, async (file, args) => {
    invocation = { file, args };
  });
  assert.deepEqual(invocation, {
    file: "/usr/bin/open",
    args: ["-b", cursor.bundleId, folderPath],
  });
});

test("refreshes availability before launching the selected editor", async () => {
  let forcedRefresh = false;
  let launched: { bundleId: string; folderPath: string } | undefined;
  await openFolderInExternalEditor(
    "/tmp/workspace",
    "cursor",
    dependencies({
      editors: async (forceRefresh) => {
        forcedRefresh = forceRefresh;
        return [cursor];
      },
      launchApplication: async (bundleId, folderPath) => {
        launched = { bundleId, folderPath };
      },
    }),
  );
  assert.equal(forcedRefresh, true);
  assert.deepEqual(launched, {
    bundleId: cursor.bundleId,
    folderPath: "/tmp/workspace",
  });
});

test("rejects an editor that disappeared after discovery", async () => {
  await assert.rejects(
    openFolderInExternalEditor(
      "/tmp/workspace",
      "cursor",
      dependencies({ editors: async () => [] }),
    ),
    /Cursor is no longer installed/,
  );
});
