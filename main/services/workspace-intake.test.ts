import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkspaceCloneProgress } from "../../renderer/shared/workspace-intake.js";
import { createGitCloneRunner, parseGitCloneProgress } from "./git-clone-runner.js";
import type { Workspace } from "./types.js";
import {
  createWorkspaceApplicationService,
  type WorkspaceApplicationDependencies,
} from "./workspace-application-service.js";
import {
  classifyCloneFailure,
  cloneFailureDetail,
  createWorkspaceIntakeService,
  defaultCloneBaseDirectory,
  parseWorkspacePathInput,
  type GitCloneRequest,
  type WorkspaceIntakeDependencies,
} from "./workspace-intake.js";
import { processRunning } from "../shared/process-liveness-test-support.js";

const FIXTURE_URL = "https://example.invalid/acme/widget.git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Aiden Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function fixture(
  t: test.TestContext,
  options: {
    runClone?: WorkspaceIntakeDependencies["runClone"];
    logError?: (error: unknown) => void;
    caseInsensitivePaths?: boolean;
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-intake-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const workspaces: Workspace[] = [];
  let nextId = 0;
  const application = createWorkspaceApplicationService({
    configStore: {
      listWorkspaces: async () => [...workspaces],
      getWorkspace: async (id: string) => workspaces.find((workspace) => workspace.id === id),
      saveWorkspace: async (workspace: Workspace) => {
        workspaces.push(workspace);
        return workspace;
      },
      removeWorkspace: async () => undefined,
    },
    realpath: (value: string) => fs.realpath(value),
    stat: (value: string) => fs.stat(value),
    createId: () => `w-${++nextId}`,
    now: () => 1,
  } as unknown as WorkspaceApplicationDependencies);
  const cloneRequests: GitCloneRequest[] = [];
  const service = createWorkspaceIntakeService({
    home,
    stat: (target) => fs.stat(target),
    lstat: (target) => fs.lstat(target),
    rename: (from, to) => fs.rename(from, to),
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    writeNewFile: (target, content) => fs.writeFile(target, content, { flag: "wx", mode: 0o600 }),
    readFile: (target) => fs.readFile(target, "utf8"),
    randomId: () => randomUUID(),
    logError: (_area, _message, error) => options.logError?.(error),
    realpath: (target) => fs.realpath(target),
    readdir: (target) => fs.readdir(target),
    mkdir: async (target) => {
      await fs.mkdir(target);
    },
    rmdir: (target) => fs.rmdir(target),
    removeTree: (target) => fs.rm(target, { recursive: true, force: true }),
    listWorkspaces: async () => [...workspaces],
    getWorkspace: async (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    createFromFolder: (folderPath) => application.createFromFolder(folderPath),
    ...(options.caseInsensitivePaths === undefined ? {} : { caseInsensitivePaths: options.caseInsensitivePaths }),
    runClone: async (request) => {
      cloneRequests.push(request);
      return options.runClone ? options.runClone(request) : assert.fail("no clone expected");
    },
  });
  return { root, home, service, application, workspaces, cloneRequests };
}

/** A bare repository with one commit, reachable only through file://. */
async function bareRepository(root: string): Promise<string> {
  const source = path.join(root, "source");
  await fs.mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(source, "README.md"), "# Widget\n");
  git(source, "add", "README.md");
  git(source, "commit", "-q", "-m", "Initial");
  const bare = path.join(root, "widget.git");
  git(root, "clone", "-q", "--bare", source, bare);
  return bare;
}

const cloneOptions = (progress: WorkspaceCloneProgress[] = [], signal = new AbortController().signal) => ({
  cloneId: "clone-test-0001",
  signal,
  onProgress: (event: WorkspaceCloneProgress) => progress.push(event),
});

test("typed paths normalise ~, absolute and workspace-relative forms and reject the rest", () => {
  const home = "/Users/me";
  const base = "/Users/me/projects/app";
  const cases: Array<[unknown, string | undefined, string]> = [
    ["~", undefined, "/Users/me"],
    ["  ~/projects/../code/ ", undefined, "/Users/me/code"],
    ["/opt//repos/widget/", undefined, "/opt/repos/widget"],
    [".", base, base],
    ["./packages/cli", base, "/Users/me/projects/app/packages/cli"],
    ["..", base, "/Users/me/projects"],
    ["../sibling", base, "/Users/me/projects/sibling"],
  ];
  for (const [input, relativeBase, expected] of cases) {
    assert.deepEqual(parseWorkspacePathInput(input, { home, relativeBase }), { ok: true, path: expected }, String(input));
  }
  const rejected: Array<[unknown, string | undefined, string]> = [
    ["", undefined, "empty"],
    ["   ", undefined, "empty"],
    [undefined, undefined, "empty"],
    ["./sub", undefined, "no-relative-base"],
    ["../sub", "relative/base", "no-relative-base"],
    ["~bob/projects", undefined, "unsupported-prefix"],
    ["projects/widget", base, "unsupported-prefix"],
    ["C:widget", base, "unsupported-prefix"],
    ["/tmp/a\u0000b", undefined, "invalid-characters"],
    ["/tmp/a\nb", undefined, "invalid-characters"],
    [`/${"a".repeat(4_100)}`, undefined, "too-long"],
  ];
  for (const [input, relativeBase, code] of rejected) {
    const result = parseWorkspacePathInput(input, { home, relativeBase });
    assert.equal(result.ok, false, String(input));
    assert.equal(!result.ok && result.code, code, String(input));
  }
});

test("inspection reports folders, repositories, creatable paths and invalid parents without writing", async (t) => {
  const { root, home, service, application } = await fixture(t);
  const plain = path.join(root, "plain");
  const repo = path.join(root, "repo");
  const file = path.join(root, "notes.txt");
  await fs.mkdir(plain);
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  await fs.writeFile(file, "x");

  assert.deepEqual(await service.inspect(plain), { kind: "folder", path: plain, isGitRepo: false });
  assert.deepEqual(await service.inspect(`${repo}/`), { kind: "folder", path: repo, isGitRepo: true });
  assert.deepEqual(await service.inspect(path.join(root, "new-app")), {
    kind: "creatable",
    path: path.join(root, "new-app"),
  });
  assert.equal(await exists(path.join(root, "new-app")), false, "inspection must not create folders");
  assert.deepEqual(await service.inspect("~"), { kind: "folder", path: home, isGitRepo: false });

  const invalid = async (input: string, code: string) => {
    const result = await service.inspect(input);
    assert.equal(result.kind, "invalid", input);
    assert.equal(result.kind === "invalid" && result.code, code, input);
  };
  await invalid(path.join(root, "missing", "child"), "parent-missing");
  await invalid(file, "not-a-folder");
  await invalid(path.join(file, "child"), "parent-not-a-folder");
  await invalid("relative/path", "unsupported-prefix");

  // A registered folder is found through its canonical path, even via a symlink.
  const registered = await application.createFromFolder(repo);
  const link = path.join(root, "repo-link");
  await fs.symlink(repo, link);
  assert.deepEqual(await service.inspect(link), {
    kind: "existing-workspace",
    workspaceId: registered.id,
    path: link,
  });
  // `.` paths resolve against the given workspace's folder.
  await fs.mkdir(path.join(repo, "pkg"));
  assert.deepEqual(await service.inspect("./pkg", registered.id), {
    kind: "folder",
    path: path.join(repo, "pkg"),
    isGitRepo: false,
  });
  await invalid("./pkg", "no-relative-base");
});

test("inspection reports a parent Aiden cannot read as permission denied", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const { root, service } = await fixture(t);
  const locked = path.join(root, "locked");
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  let result;
  try {
    result = await service.inspect(path.join(locked, "child"));
  } finally {
    await fs.chmod(locked, 0o755);
  }
  assert.equal(result.kind === "invalid" && result.code, "permission-denied");
});

test("opening a path registers it once and creates only the final folder on request", async (t) => {
  const { root, service, workspaces } = await fixture(t);
  const target = path.join(root, "new-app");

  assert.deepEqual(await service.open(target, { create: false }), {
    ok: false,
    code: "missing",
    reason: "That folder doesn't exist yet.",
  });
  assert.equal(await exists(target), false);

  const created = await service.open(target, { create: true });
  assert.ok(created.ok);
  assert.equal(created.created, true);
  assert.equal(created.existing, false);
  assert.equal(created.workspace.folderPath, target);
  assert.equal((await fs.stat(target)).isDirectory(), true);

  const again = await service.open(`${target}/`, { create: true });
  assert.ok(again.ok);
  assert.equal(again.existing, true);
  assert.equal(again.workspace.id, created.workspace.id);
  assert.equal(workspaces.length, 1);

  const deep = path.join(root, "a", "b", "c");
  const refused = await service.open(deep, { create: true });
  assert.equal(!refused.ok && refused.code, "parent-missing");
  assert.equal(await exists(path.join(root, "a")), false, "never creates intermediate folders");

  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  const opened = await service.open(plain, { create: false });
  assert.ok(opened.ok);
  assert.equal(opened.created, false);
  assert.equal(opened.workspace.name, "plain");
});

test("the clone base is ~/projects when present, otherwise home", async (t) => {
  const { home, service } = await fixture(t);
  const stat = (target: string) => fs.stat(target);
  assert.equal(await defaultCloneBaseDirectory(home, stat), home);
  assert.deepEqual(await service.previewClone("acme/widget"), {
    ok: true,
    url: "https://github.com/acme/widget.git",
    repoName: "widget",
    destination: path.join(home, "widget"),
  });
  await fs.mkdir(path.join(home, "projects"));
  assert.equal(await defaultCloneBaseDirectory(home, stat), path.join(home, "projects"));
  const preview = await service.previewClone("git@example.com:team/tool.git");
  assert.equal(preview.ok && preview.destination, path.join(home, "projects", "tool"));
  assert.equal((await service.previewClone("file:///etc")).ok, false);
});

test("a real clone runs without hooks, reports progress and registers the workspace", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-intake-bare-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bare = await bareRepository(root);
  const marker = path.join(root, "hook-ran");
  const templates = path.join(root, "templates");
  await fs.mkdir(path.join(templates, "hooks"), { recursive: true });
  await fs.writeFile(path.join(templates, "hooks", "post-checkout"), `#!/bin/sh\necho ran >> "${marker}"\n`, {
    mode: 0o755,
  });
  // Oracle: without Aiden's settings this template hook does run on clone.
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "-c", `init.templateDir=${templates}`, "clone", "-q", `file://${bare}`, "control"],
    { cwd: root, stdio: "ignore" },
  );
  assert.equal(await exists(marker), true, "control clone must run the template hook");
  await fs.rm(marker);

  const { home, service, workspaces } = await fixture(t, {
    runClone: createGitCloneRunner({
      extraConfig: [
        ["protocol.file.allow", "always"],
        [`url.file://${bare}.insteadOf`, FIXTURE_URL],
        ["init.templateDir", templates],
      ],
    }),
  });
  await fs.mkdir(path.join(home, "projects"));
  const progress: WorkspaceCloneProgress[] = [];
  const result = await service.clone({ url: FIXTURE_URL }, cloneOptions(progress));
  assert.ok(result.ok, JSON.stringify(result));
  const destination = path.join(home, "projects", "widget");
  assert.equal(result.destination, destination);
  assert.equal(result.workspace.folderPath, destination);
  assert.deepEqual(workspaces.map((workspace) => workspace.folderPath), [destination]);
  assert.equal(await fs.readFile(path.join(destination, "README.md"), "utf8"), "# Widget\n");
  assert.equal(git(destination, "remote", "get-url", "origin").trim(), FIXTURE_URL);
  assert.equal(await exists(marker), false, "clone hooks must not run");
  assert.deepEqual(await stagingFolders(path.join(home, "projects")), [], "staging is removed");
  assert.ok(progress.length > 0, "progress events were reported");
  assert.ok(progress.every((event) => event.cloneId === "clone-test-0001" && event.phase.length > 0));
});

test("a real clone that Git rejects leaves no destination behind", async (t) => {
  const { home, service, workspaces } = await fixture(t, {
    runClone: createGitCloneRunner({
      extraConfig: [
        ["protocol.file.allow", "always"],
        // Points at a path that is not a repository; no network is involved.
        [`url.file://${path.join(os.tmpdir(), "aiden-intake-missing-repo.git")}.insteadOf`, FIXTURE_URL],
      ],
    }),
  });
  const result = await service.clone({ url: FIXTURE_URL, destination: "~/widget" }, cloneOptions());
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "not-found");
  assert.ok(!result.ok && result.detail && !result.detail.includes(home), "detail redacts the home folder");
  assert.equal(await exists(path.join(home, "widget")), false);
  assert.equal(workspaces.length, 0);
});

test("clone refuses bad URLs and occupied destinations before running Git", async (t) => {
  const { root, home, service, cloneRequests } = await fixture(t);
  const occupied = path.join(root, "occupied");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "keep.txt"), "mine");
  const file = path.join(root, "file.txt");
  await fs.writeFile(file, "x");

  const expectations: Array<[{ url: string; destination?: string }, string]> = [
    [{ url: "--upload-pack=touch /tmp/pwned" }, "invalid-url"],
    [{ url: "ext::sh -c touch% /tmp/pwned" }, "invalid-url"],
    [{ url: "file:///etc" }, "invalid-url"],
    [{ url: "acme/widget", destination: occupied }, "destination-exists"],
    [{ url: "acme/widget", destination: file }, "invalid-destination"],
    [{ url: "acme/widget", destination: path.join(root, "missing", "widget") }, "invalid-destination"],
    [{ url: "acme/widget", destination: "relative/widget" }, "invalid-destination"],
    [{ url: "acme/widget", destination: "./widget" }, "invalid-destination"],
    [{ url: "acme/widget", destination: "/" }, "invalid-destination"],
  ];
  for (const [input, code] of expectations) {
    const result = await service.clone(input, cloneOptions());
    assert.equal(!result.ok && result.code, code, JSON.stringify(input));
  }
  assert.equal(cloneRequests.length, 0, "Git never ran");
  assert.equal(await fs.readFile(path.join(occupied, "keep.txt"), "utf8"), "mine");
  assert.equal(await exists(path.join(home, "widget")), false);
});

test("a failed clone removes only its staging folder and never writes the destination", async (t) => {
  const partialThenFail = async (request: GitCloneRequest) => {
    await fs.mkdir(path.join(request.destination, ".git"), { recursive: true });
    await fs.writeFile(path.join(request.destination, ".git", "HEAD"), "partial");
    return {
      ok: false as const,
      reason: "exit" as const,
      stderrTail: "Cloning into 'repo'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    };
  };
  const { root, home, service, cloneRequests } = await fixture(t, { runClone: partialThenFail });

  const fresh = await service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!fresh.ok && fresh.code, "auth-failed");
  const request = cloneRequests[0];
  assert.equal(request?.url, "https://github.com/acme/widget.git");
  assert.equal(path.dirname(request?.cwd ?? ""), home, "staging sits beside the destination");
  assert.match(path.basename(request?.cwd ?? ""), /^\.aiden-clone-/u);
  assert.equal(request?.destination, path.join(request?.cwd ?? "", "repo"), "Git clones inside the staging folder");
  assert.equal(await exists(path.join(home, "widget")), false);
  assert.deepEqual(await stagingFolders(home), []);

  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  const reused = await service.clone({ url: "acme/widget", destination: empty }, cloneOptions());
  assert.equal(!reused.ok && reused.code, "auth-failed");
  assert.deepEqual(await fs.readdir(empty), [], "an existing empty destination is left as it was");
  assert.deepEqual(await stagingFolders(root), []);
});

test("clone never targets a .git folder, whatever the URL or destination", async (t) => {
  const { root, home, service, cloneRequests } = await fixture(t);
  await fs.mkdir(path.join(home, "projects"));
  for (const url of ["https://evil.example/x/.git.git", "acme/.git.git", "git@evil.example:x/.GIT.git"]) {
    const result = await service.clone({ url }, cloneOptions());
    assert.equal(!result.ok && result.code, "invalid-url", url);
  }
  await fs.mkdir(path.join(root, "repo"));
  for (const destination of ["~/.git", "~/projects/.GIT", path.join(root, "repo", ".git", "nested"), path.join(root, ".Git")]) {
    const result = await service.clone({ url: "acme/widget", destination }, cloneOptions());
    assert.equal(!result.ok && result.code, "invalid-destination", destination);
  }
  assert.equal(cloneRequests.length, 0, "Git never ran");
  assert.deepEqual(await fs.readdir(path.join(home, "projects")), []);
  assert.equal(await exists(path.join(home, ".git")), false);
});

/** A directory outside the clone whose contents must survive every case. */
async function outsider(root: string): Promise<string> {
  const dir = path.join(root, "unrelated");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "keep.txt"), "keep");
  return dir;
}

async function stagingFolders(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.startsWith(".aiden-clone-"));
}

const earlyEof = { ok: false as const, reason: "exit" as const, stderrTail: "fatal: early EOF" };
/** The user-visible destination for `acme/widget` in a fixture without ~/projects. */
const visibleDestination = (request: GitCloneRequest) => path.join(path.dirname(request.cwd), "widget");

test("a failed clone never touches whatever occupies the destination", async (t) => {
  // The destination path becomes a link to unrelated data while Git runs.
  const linked = await fixture(t, {
    runClone: async (request) => {
      await fs.symlink(await outsider(path.dirname(path.dirname(request.cwd))), visibleDestination(request));
      return earlyEof;
    },
  });
  const linkedResult = await linked.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!linkedResult.ok && linkedResult.code, "failed");
  assert.equal(await fs.readFile(path.join(linked.root, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.equal((await fs.lstat(path.join(linked.home, "widget"))).isSymbolicLink(), true);
  assert.deepEqual(await stagingFolders(linked.home), []);

  // An adopted empty destination is swapped for a link: still untouched.
  const adopted = await fixture(t, {
    runClone: async (request) => {
      await fs.rmdir(visibleDestination(request));
      await fs.symlink(await outsider(path.dirname(path.dirname(request.cwd))), visibleDestination(request));
      return earlyEof;
    },
  });
  await fs.mkdir(path.join(adopted.home, "widget"));
  await adopted.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(adopted.root, "unrelated", "keep.txt"), "utf8"), "keep");

  // A different real directory with data takes the destination's place.
  const replaced = await fixture(t, {
    runClone: async (request) => {
      await fs.mkdir(visibleDestination(request));
      await fs.writeFile(path.join(visibleDestination(request), "keep.txt"), "keep");
      return earlyEof;
    },
  });
  await replaced.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(replaced.home, "widget", "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await stagingFolders(replaced.home), []);

  // Links the clone wrote inside staging are removed, never followed.
  const inner = await fixture(t, {
    runClone: async (request) => {
      const target = await outsider(path.dirname(path.dirname(request.cwd)));
      await fs.mkdir(path.join(request.destination, ".git"), { recursive: true });
      await fs.symlink(target, path.join(request.destination, ".git", "escape"));
      await fs.symlink(target, path.join(request.cwd, "escape"));
      return earlyEof;
    },
  });
  await inner.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(inner.root, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.equal(await exists(path.join(inner.home, "widget")), false);
  assert.deepEqual(await stagingFolders(inner.home), []);
});

test("a staging folder that lost Aiden's owner marker is never deleted", async (t) => {
  const marker = (request: GitCloneRequest) => path.join(request.cwd, ".aiden-clone-owner");
  const cases: Array<[string, (request: GitCloneRequest) => Promise<void>]> = [
    [
      "staging swapped for another folder",
      async (request) => {
        await fs.rename(request.cwd, `${request.cwd}-aside`);
        await fs.mkdir(request.cwd);
        await fs.writeFile(path.join(request.cwd, "keep.txt"), "keep");
      },
    ],
    [
      "marker replaced by a link to a file holding the token",
      async (request) => {
        const copy = path.join(path.dirname(request.cwd), "token-copy");
        await fs.writeFile(copy, await fs.readFile(marker(request), "utf8"));
        await fs.rm(marker(request));
        await fs.symlink(copy, marker(request));
        await fs.writeFile(path.join(request.cwd, "keep.txt"), "keep");
      },
    ],
    [
      "marker rewritten with another token",
      async (request) => {
        await fs.writeFile(marker(request), "someone-else");
        await fs.writeFile(path.join(request.cwd, "keep.txt"), "keep");
      },
    ],
  ];
  for (const [name, tamper] of cases) {
    let staging = "";
    const errors: unknown[] = [];
    const { service } = await fixture(t, {
      logError: (error) => errors.push(error),
      runClone: async (request) => {
        staging = request.cwd;
        await tamper(request);
        return earlyEof;
      },
    });
    const result = await service.clone({ url: "acme/widget" }, cloneOptions());
    assert.equal(!result.ok && result.code, "failed", name);
    assert.equal(await fs.readFile(path.join(staging, "keep.txt"), "utf8"), "keep", name);
    assert.equal(errors.length, 1, `${name}: the skipped cleanup is logged`);
  }
});

test("a destination that appears during a successful clone is never overwritten", async (t) => {
  const finishedClone = async (request: GitCloneRequest) => {
    await fs.mkdir(path.join(request.destination, ".git"), { recursive: true });
  };

  const filled = await fixture(t, {
    runClone: async (request) => {
      await finishedClone(request);
      await fs.mkdir(visibleDestination(request));
      await fs.writeFile(path.join(visibleDestination(request), "theirs.txt"), "keep");
      return { ok: true as const };
    },
  });
  const filledResult = await filled.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!filledResult.ok && filledResult.code, "destination-exists");
  assert.deepEqual(await fs.readdir(path.join(filled.home, "widget")), ["theirs.txt"]);
  assert.deepEqual(await stagingFolders(filled.home), [], "the discarded clone is cleaned up");
  assert.equal(filled.workspaces.length, 0);

  const linked = await fixture(t, {
    runClone: async (request) => {
      await finishedClone(request);
      await fs.symlink(await outsider(path.dirname(path.dirname(request.cwd))), visibleDestination(request));
      return { ok: true as const };
    },
  });
  const linkedResult = await linked.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!linkedResult.ok && linkedResult.code, "destination-exists");
  assert.deepEqual(await fs.readdir(path.join(linked.root, "unrelated")), ["keep.txt"]);
  assert.equal((await fs.lstat(path.join(linked.home, "widget"))).isSymbolicLink(), true);

  // An empty folder, whether there before or created meanwhile, is replaced by the clone.
  const adopted = await fixture(t, {
    runClone: async (request) => {
      await finishedClone(request);
      return { ok: true as const };
    },
  });
  await fs.mkdir(path.join(adopted.home, "widget"));
  const adoptedResult = await adopted.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.ok(adoptedResult.ok, JSON.stringify(adoptedResult));
  assert.equal(await exists(path.join(adopted.home, "widget", ".git")), true);
  assert.deepEqual(await stagingFolders(adopted.home), []);
});

test("clone refuses a destination that is a symlink, even to an empty folder", async (t) => {
  const { root, service, cloneRequests } = await fixture(t);
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  const link = path.join(root, "widget-link");
  await fs.symlink(empty, link);
  const result = await service.clone({ url: "acme/widget", destination: link }, cloneOptions());
  assert.equal(!result.ok && result.code, "invalid-destination");
  assert.equal(cloneRequests.length, 0);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test("clones into aliases of one folder cannot run at the same time", async (t) => {
  let release: (() => void) | undefined;
  const { root, service, cloneRequests } = await fixture(t, {
    caseInsensitivePaths: true,
    runClone: async (request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await fs.mkdir(path.join(request.destination, ".git"), { recursive: true });
      return { ok: true as const };
    },
  });
  const real = path.join(root, "real");
  await fs.mkdir(real);
  await fs.symlink(real, path.join(root, "link"));

  const first = service.clone({ url: "acme/widget", destination: path.join(real, "widget") }, cloneOptions());
  for (let attempt = 0; attempt < 200 && cloneRequests.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cloneRequests.length, 1);
  for (const alias of [path.join(root, "link", "widget"), path.join(real, "WIDGET")]) {
    const second = await service.clone({ url: "acme/widget", destination: alias }, cloneOptions());
    assert.equal(!second.ok && second.code, "busy", alias);
  }
  release?.();
  const result = await first;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(await exists(path.join(real, "widget", ".git")), true, "the running clone was left intact");
  assert.equal(cloneRequests.length, 1);
});

test("the real runner streams progress, and cancel or timeout stops Git", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-intake-runner-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slowGit = path.join(root, "slow-git");
  await fs.writeFile(
    slowGit,
    "#!/bin/sh\nprintf 'Cloning into widget...\\n' >&2\nprintf 'Receiving objects:  10%% (1/10)\\rReceiving objects:  40%% (4/10)\\r' >&2\nexec sleep 30\n",
    { mode: 0o755 },
  );
  const request = (signal: AbortSignal, progress: Array<{ phase: string; percent?: number }>) => ({
    url: FIXTURE_URL,
    destination: path.join(root, "widget"),
    cwd: root,
    signal,
    onProgress: (event: { phase: string; percent?: number }) => progress.push(event),
  });

  const controller = new AbortController();
  const progress: Array<{ phase: string; percent?: number }> = [];
  const started = Date.now();
  const running = createGitCloneRunner({ gitBinary: slowGit })(request(controller.signal, progress));
  while (!progress.some((event) => event.phase === "Receiving objects") && Date.now() - started < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(progress[0]?.phase, "Cloning");
  assert.equal(progress.find((event) => event.phase === "Receiving objects")?.percent, 10);
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.ok === false && cancelled.reason, "cancelled");
  assert.ok(Date.now() - started < 10_000, "cancel stops the process promptly");

  const timedOut = await createGitCloneRunner({ gitBinary: slowGit, timeoutMs: 150 })(
    request(new AbortController().signal, []),
  );
  assert.equal(timedOut.ok === false && timedOut.reason, "timeout");
});

test("a cancelled clone settles only after Git helpers that ignore SIGTERM are gone", async (t) => {
  if (process.platform === "win32") return;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-intake-helper-")));
  const helperPidFile = path.join(root, "helper.pid");
  let helperPid = 0;
  t.after(async () => {
    if (helperPid > 0) { try { process.kill(helperPid, "SIGKILL"); } catch { /* gone */ } }
    await fs.rm(root, { recursive: true, force: true });
  });
  const slowGit = path.join(root, "slow-git");
  // Git exits on SIGTERM; its helper (think index-pack) ignores it and would
  // keep writing into the staging folder the caller is about to delete.
  await fs.writeFile(
    slowGit,
    `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > "${helperPidFile}"; while :; do sleep 0.05; done' >/dev/null 2>&1 &\nwait\n`,
    { mode: 0o755 },
  );
  const controller = new AbortController();
  const running = createGitCloneRunner({ gitBinary: slowGit })({
    url: FIXTURE_URL,
    destination: path.join(root, "widget"),
    cwd: root,
    signal: controller.signal,
    onProgress: () => {},
  });
  const deadline = Date.now() + 5_000;
  while (!helperPid && Date.now() < deadline) {
    helperPid = Number(await fs.readFile(helperPidFile, "utf8").catch(() => "0"));
    if (!helperPid) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(helperPid > 0, "the helper must start");
  controller.abort();
  const outcome = await running;
  assert.equal(outcome.ok === false && outcome.reason, "cancelled");
  let helperAlive = true;
  for (let attempt = 0; attempt < 25 && helperAlive; attempt += 1) {
    helperAlive = processRunning(helperPid);
    if (helperAlive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(helperAlive, false, "the helper is stopped with Git's process group");
});

test("clone progress lines and failures are parsed into short user-facing results", () => {
  assert.deepEqual(parseGitCloneProgress("Cloning into 'widget'..."), { phase: "Cloning" });
  assert.deepEqual(parseGitCloneProgress("remote: Counting objects: 100% (12/12), done."), {
    phase: "Counting objects",
    percent: 100,
  });
  assert.deepEqual(parseGitCloneProgress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s"), {
    phase: "Receiving objects",
    percent: 45,
  });
  assert.deepEqual(parseGitCloneProgress("remote: Enumerating objects: 1234, done."), { phase: "Enumerating objects" });
  assert.equal(parseGitCloneProgress("warning: You appear to have cloned an empty repository."), undefined);

  const cases: Array<[string, string]> = [
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "auth-failed"],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "auth-failed"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found", "not-found"],
    ["fatal: unable to access 'https://nope.invalid/a.git/': Could not resolve host: nope.invalid", "network"],
    ["ssh: Could not resolve hostname nope.invalid: nodename nor servname provided", "network"],
    ["Host key verification failed.\nfatal: Could not read from remote repository.", "host-key"],
    ["fatal: early EOF", "failed"],
  ];
  for (const [stderr, code] of cases) assert.equal(classifyCloneFailure(stderr).code, code, stderr);

  assert.equal(
    cloneFailureDetail(
      "Receiving objects:  10% (1/10)\rfatal: unable to access 'https://user:s3cret@host.example/x.git/' from /Users/me/projects\n",
      "/Users/me",
    ),
    "fatal: unable to access 'https://***@host.example/x.git/' from ~/projects",
  );
});
