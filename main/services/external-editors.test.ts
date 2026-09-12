import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenApplicationArguments,
  launchApplicationBundle,
  openFolderInExternalEditor,
  linuxExecutableSearchPaths,
  resolveInstalledLinuxEditors,
  resolveInstalledEditorApplications,
  type OpenFolderInEditorDependencies,
  type ResolvedExternalEditor,
} from "./external-editors.js";

const cursor: ResolvedExternalEditor = {
  id: "cursor",
  label: "Cursor",
  appPath: "/Applications/Cursor.app",
  launch: { kind: "bundle", bundleId: "com.todesktop.230313mzl4w4u92" },
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
  assert.equal(cursor.launch.kind, "bundle");
  if (cursor.launch.kind !== "bundle") throw new Error("Expected a macOS bundle fixture.");
  assert.deepEqual(buildOpenApplicationArguments(cursor.launch.bundleId, folderPath), [
    "-b",
    cursor.launch.bundleId,
    folderPath,
  ]);

  let invocation: { file: string; args: readonly string[] } | undefined;
  await launchApplicationBundle(cursor.launch.bundleId, folderPath, async (file, args) => {
    invocation = { file, args };
  });
  assert.deepEqual(invocation, {
    file: "/usr/bin/open",
    args: ["-b", cursor.launch.bundleId, folderPath],
  });
});

test("refreshes availability before launching the selected editor", async () => {
  let forcedRefresh = false;
  let launched: { editorId: string; folderPath: string } | undefined;
  await openFolderInExternalEditor(
    "/tmp/workspace",
    "cursor",
    dependencies({
      editors: async (forceRefresh) => {
        forcedRefresh = forceRefresh;
        return [cursor];
      },
      launchApplication: async (editor, folderPath) => {
        launched = { editorId: editor.id, folderPath };
      },
    }),
  );
  assert.equal(forcedRefresh, true);
  assert.deepEqual(launched, {
    editorId: cursor.id,
    folderPath: "/tmp/workspace",
  });
});

test("Linux editor lookup includes distro, Snap, user, and Toolbox command locations", () => {
  assert.deepEqual(linuxExecutableSearchPaths("/custom/bin:/usr/bin", "/home/aiden"), [
    "/custom/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/snap/bin",
    "/home/aiden/.local/bin",
    "/home/aiden/.local/share/JetBrains/Toolbox/scripts",
  ]);
});

test("Linux editor lookup recognizes common Flatpak application IDs", async () => {
  const definitions = [
    {
      id: "vscode",
      label: "VS Code",
      bundleIds: [],
      applicationNames: [],
      priority: 1,
    },
  ];
  const resolved = await resolveInstalledLinuxEditors(definitions, [], {
    executablePath: "/usr/bin/flatpak",
    applicationIds: new Set(["com.visualstudio.code"]),
  });
  assert.deepEqual(resolved, [
    {
      id: "vscode",
      label: "VS Code",
      appPath: "/usr/bin/flatpak",
      launch: {
        kind: "flatpak",
        executablePath: "/usr/bin/flatpak",
        applicationId: "com.visualstudio.code",
      },
    },
  ]);
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
