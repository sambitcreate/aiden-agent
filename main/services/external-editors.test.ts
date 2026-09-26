import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  listExternalEditors,
  launchEditorExecutable,
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
      "vscode",
      dependencies({ editors: async () => [] }),
    ),
    /VS Code is no longer installed/,
  );
});

async function withLinuxPath(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden editors "));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const oldPath = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "linux" });
  process.env.PATH = root;
  try {
    await run(root);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    // Expire the platform-specific fixture cache before restoring normal discovery.
    await listExternalEditors(true);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Linux discovers executable editor launchers and keeps the file manager last", async () => {
  await withLinuxPath(async (root) => {
    for (const name of ["cursor", "code", "code-insiders", "codium", "zed", "subl"]) {
      await fs.writeFile(path.join(root, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const editors = await listExternalEditors(true);
    assert.deepEqual(editors.map(({ id }) => id), [
      "vscode", "vscode-insiders", "vscodium", "zed", "sublime-text", "file-manager",
    ]);
    assert.equal(editors[editors.length - 1]?.label, "Files");
    assert.ok(editors.every((editor) => !("appPath" in editor)));
  });
});

test("Linux omits unavailable launchers, non-executable files, directories and relative PATH entries", async () => {
  await withLinuxPath(async (root) => {
    await fs.writeFile(path.join(root, "cursor"), "not executable", { mode: 0o644 });
    await fs.mkdir(path.join(root, "code"));
    const relativeRoot = path.join(root, "relative");
    await fs.mkdir(relativeRoot);
    await fs.writeFile(path.join(relativeRoot, "zed"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `:${path.relative(process.cwd(), relativeRoot)}:${root}`;
    assert.deepEqual(await listExternalEditors(true), [
      { id: "file-manager", label: "Files", iconDataUrl: "" },
    ]);
  });
});

test("Linux launches a discovered editor with a single absolute workspace argument", async () => {
  await withLinuxPath(async (root) => {
    const marker = path.join(root, "argv.json");
    const launcher = path.join(root, "code");
    await fs.writeFile(launcher,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o755 });
    const workspace = path.join(root, "--workspace ; $() ' spaces");
    await fs.mkdir(workspace);
    assert.equal((await listExternalEditors(true)).find(({ id }) => id === "file-manager")?.label, "Files");
    await openFolderInExternalEditor(workspace, "vscode");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fs.stat(marker).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), [workspace]);
    await fs.unlink(launcher);
    await assert.rejects(openFolderInExternalEditor(workspace, "vscode"), /no longer installed/);
  });
});


test("executable launch failures are reported and leading-option paths become absolute", async () => {
  await assert.rejects(launchEditorExecutable("/nonexistent/aiden-editor", "/tmp/workspace"), /ENOENT/);
  let launchPath = "";
  const linuxEditor: ResolvedExternalEditor = {
    ...cursor,
    launch: { kind: "executable", executablePath: "/usr/bin/cursor" },
  };
  await assert.rejects(openFolderInExternalEditor("--workspace with spaces", "cursor", dependencies({
    editors: async () => [linuxEditor],
    launchApplication: async (editor, folder) => {
      if (editor.launch.kind !== "executable") throw new Error("Expected an executable launch.");
      assert.equal(editor.launch.executablePath, "/usr/bin/cursor");
      launchPath = folder;
      throw new Error("EACCES");
    },
  })), /Could not open workspace in Cursor: EACCES/);
  assert.equal(launchPath, path.resolve("--workspace with spaces"));
});

test("file manager preserves shell.openPath and uses its returned platform label in errors", async () => {
  for (const [id, label] of [["finder", "Finder"], ["file-manager", "Files"]] as const) {
    const fileManager: ResolvedExternalEditor = {
      ...cursor,
      id,
      label,
      launch: { kind: "file-manager" },
    };
    let opened = "";
    await openFolderInExternalEditor("/tmp/workspace", id, dependencies({
      editors: async () => [fileManager],
      openPath: async (folder) => { opened = folder; return ""; },
      launchApplication: async () => assert.fail("file manager uses Electron"),
    }));
    assert.equal(opened, "/tmp/workspace");
    await assert.rejects(openFolderInExternalEditor("/tmp/workspace", id, dependencies({
      editors: async () => [fileManager],
      openPath: async () => "no handler",
    })), new RegExp(`Could not open workspace in ${label}: no handler`));
  }
});


test("Linux honors PATH precedence, follows launcher symlinks and skips unusable earlier entries", async () => {
  await withLinuxPath(async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);
    const target = path.join(root, "editor executable");
    await fs.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(first, "code"), "no execution", { mode: 0o644 });
    await fs.symlink(target, path.join(second, "code"));
    process.env.PATH = `${first}:${second}`;
    assert.deepEqual((await listExternalEditors(true)).map(({ id }) => id), ["vscode", "file-manager"]);
    // A denied/broken launcher must disappear on a forced refresh.
    await fs.chmod(target, 0o644);
    assert.deepEqual((await listExternalEditors(true)).map(({ id }) => id), ["file-manager"]);
    delete process.env.PATH;
    assert.equal((await listExternalEditors(true)).find(({ id }) => id === "file-manager")?.label, "Files");
  });
});


test("Linux Zed aliases preserve PATH precedence, executable guards and literal workspace argv", async () => {
  await withLinuxPath(async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);
    const workspace = path.join(root, "--project ; $() ' spaces");
    await fs.mkdir(workspace);
    const marker = path.join(root, "zed-argv.json");
    const writeLauncher = async (directory: string, name: string) => {
      const executable = path.join(directory, name);
      await fs.writeFile(executable,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ executable: ${JSON.stringify(executable)}, args: process.argv.slice(2) }));`,
        { mode: 0o755 });
      return executable;
    };
    const assertLaunch = async (expected: string) => {
      await fs.rm(marker, { force: true });
      assert.deepEqual((await listExternalEditors(true)).map(({ id }) => id), ["zed", "file-manager"]);
      await openFolderInExternalEditor(workspace, "zed");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await fs.stat(marker).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), { executable: expected, args: [workspace] });
    };
    process.env.PATH = `${first}:${second}`;
    const alias = await writeLauncher(first, "zeditor");
    await assertLaunch(alias); // A zeditor-only installation must be available.
    const laterZed = await writeLauncher(second, "zed");
    await assertLaunch(alias); // Earlier PATH entry beats a preferred name in a later entry.
    const preferred = await writeLauncher(first, "zed");
    await assertLaunch(preferred); // Deterministic tie-break in a single directory.
    await fs.chmod(preferred, 0o644);
    await assertLaunch(alias);
    await fs.chmod(alias, 0o644);
    await assertLaunch(laterZed);
    await fs.unlink(alias);
    await fs.mkdir(alias);
    await assertLaunch(laterZed); // An executable directory is not a launcher.
    await fs.unlink(laterZed);
    assert.deepEqual((await listExternalEditors(true)).map(({ id }) => id), ["file-manager"]);
    await assert.rejects(openFolderInExternalEditor(workspace, "zed"), /no longer installed/);
  });
});

test("Linux excludes Cursor until its launcher has a reliable editor-surface contract", async () => {
  await withLinuxPath(async (root) => {
    await fs.writeFile(path.join(root, "cursor"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.deepEqual((await listExternalEditors(true)).map(({ id }) => id), ["file-manager"]);
    await assert.rejects(openFolderInExternalEditor(root, "cursor"), /Opening Cursor from Aiden is not supported on Linux/);
  });
});
