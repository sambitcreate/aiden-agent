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
    /** Runs before the service's own mkdir, to simulate a racing writer. */
    beforeMkdir?: (target: string) => Promise<void>;
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
    randomId: () => randomUUID(),
    realpath: (target) => fs.realpath(target),
    readdir: (target) => fs.readdir(target),
    mkdir: async (target) => {
      await options.beforeMkdir?.(target);
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

test("a failed clone removes what it created and keeps a folder that already existed", async (t) => {
  const partialThenFail = async (request: GitCloneRequest) => {
    await fs.mkdir(request.destination, { recursive: true });
    await fs.mkdir(path.join(request.destination, ".git"));
    await fs.writeFile(path.join(request.destination, ".git", "HEAD"), "partial");
    return {
      ok: false as const,
      reason: "exit" as const,
      stderrTail: "Cloning into 'widget'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    };
  };
  const { root, home, service, cloneRequests } = await fixture(t, { runClone: partialThenFail });

  const fresh = await service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!fresh.ok && fresh.code, "auth-failed");
  assert.equal(cloneRequests[0]?.url, "https://github.com/acme/widget.git");
  assert.equal(cloneRequests[0]?.cwd, home);
  assert.equal(await exists(path.join(home, "widget")), false);

  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  const reused = await service.clone({ url: "acme/widget", destination: empty }, cloneOptions());
  assert.equal(!reused.ok && reused.code, "auth-failed");
  assert.deepEqual(await fs.readdir(empty), [], "the pre-existing folder is emptied, not removed");
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

test("a destination that appears after inspection is never deleted", async (t) => {
  // A writer fills the folder between inspection and Aiden's mkdir.
  const filled = await fixture(t, {
    beforeMkdir: async (target) => {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "theirs.txt"), "keep");
    },
    runClone: async () => assert.fail("Git must not run in a folder Aiden could not claim"),
  });
  const occupied = await filled.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!occupied.ok && occupied.code, "destination-exists");
  assert.equal(await fs.readFile(path.join(filled.home, "widget", "theirs.txt"), "utf8"), "keep");

  // The racing writer made an empty folder: Aiden adopts it, and a failed clone
  // empties it again but leaves the folder Aiden did not create.
  const adopted = await fixture(t, {
    beforeMkdir: (target) => fs.mkdir(target),
    runClone: async (request) => {
      await fs.mkdir(path.join(request.destination, ".git"));
      return { ok: false as const, reason: "exit" as const, stderrTail: "fatal: early EOF" };
    },
  });
  const failed = await adopted.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!failed.ok && failed.code, "failed");
  assert.deepEqual(await fs.readdir(path.join(adopted.home, "widget")), []);

  // Git itself found the folder non-empty (filled after Aiden's claim): nothing is touched.
  const late = await fixture(t, {
    runClone: async (request) => {
      await fs.writeFile(path.join(request.destination, "theirs.txt"), "keep");
      return {
        ok: false as const,
        reason: "exit" as const,
        stderrTail: "fatal: destination path 'widget' already exists and is not an empty directory.\n",
      };
    },
  });
  await late.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(late.home, "widget", "theirs.txt"), "utf8"), "keep");
});

test("failed-clone cleanup only deletes the directory it claimed, never through links", async (t) => {
  /** A directory outside the clone whose contents must survive every case. */
  const outsider = async (root: string) => {
    const dir = path.join(root, "unrelated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "keep.txt"), "keep");
    return dir;
  };
  const earlyEof = { ok: false as const, reason: "exit" as const, stderrTail: "fatal: early EOF" };

  // Reported repro: the claimed folder is swapped for a symlink while Git runs.
  const swapped = await fixture(t, {
    runClone: async (request) => {
      const target = await outsider(path.dirname(path.dirname(request.destination)));
      await fs.rmdir(request.destination);
      await fs.symlink(target, request.destination);
      return earlyEof;
    },
  });
  const swappedResult = await swapped.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(!swappedResult.ok && swappedResult.code, "failed");
  assert.equal(await fs.readFile(path.join(swapped.root, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.equal((await fs.lstat(path.join(swapped.home, "widget"))).isSymbolicLink(), true, "the replacement is put back");

  // The same swap of an adopted (pre-existing, empty) folder.
  const adoptedSwap = await fixture(t, {
    beforeMkdir: (target) => fs.mkdir(target),
    runClone: async (request) => {
      const target = await outsider(path.dirname(path.dirname(request.destination)));
      await fs.rmdir(request.destination);
      await fs.symlink(target, request.destination);
      return earlyEof;
    },
  });
  await adoptedSwap.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(adoptedSwap.root, "unrelated", "keep.txt"), "utf8"), "keep");

  // Replaced by a different real directory: not the one claimed, so untouched.
  const replaced = await fixture(t, {
    runClone: async (request) => {
      await fs.rmdir(request.destination);
      await fs.mkdir(request.destination);
      await fs.writeFile(path.join(request.destination, "keep.txt"), "keep");
      return earlyEof;
    },
  });
  await replaced.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(replaced.home, "widget", "keep.txt"), "utf8"), "keep");

  // A link the clone wrote inside its own folder is removed, not followed.
  const inner = await fixture(t, {
    runClone: async (request) => {
      const target = await outsider(path.dirname(path.dirname(request.destination)));
      await fs.mkdir(path.join(request.destination, ".git"));
      await fs.symlink(target, path.join(request.destination, ".git", "escape"));
      await fs.symlink(target, path.join(request.destination, "escape"));
      return earlyEof;
    },
  });
  await inner.service.clone({ url: "acme/widget" }, cloneOptions());
  assert.equal(await fs.readFile(path.join(inner.root, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.equal(await exists(path.join(inner.home, "widget")), false, "the claimed folder itself is removed");
  assert.deepEqual(
    (await fs.readdir(inner.home)).filter((name) => name.startsWith(".aiden-clone-cleanup-")),
    [],
    "no quarantine is left behind",
  );
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
      await fs.mkdir(path.join(request.destination, ".git"));
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
