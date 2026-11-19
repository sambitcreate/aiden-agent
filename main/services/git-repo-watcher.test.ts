import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, watch as fsWatch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitRepoWatcher, resolveGitWatchTargets, type GitRepoWatcherOptions, type GitWatchTargets } from "./git-repo-watcher.js";

type GitRunner = (cwd: string, ...args: string[]) => Buffer;

async function makeRepo(t: test.TestContext) {
  const root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), "aiden-git-watch-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  const git: GitRunner = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Synthetic");
  git(repo, "config", "user.email", "s@example.test");
  await fs.writeFile(path.join(repo, "src", "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return { root, repo, git };
}

interface SyntheticHandle {
  target: string;
  recursive: boolean;
  closed: boolean;
  listener: (event: string, filename: string | Buffer | null) => void;
  emitter: EventEmitter;
}

function syntheticWatchHarness(
  t: test.TestContext,
  targets: GitWatchTargets,
  options: { debounceMs?: number; failRecursive?: boolean } = {},
) {
  const handles = new Map<string, SyntheticHandle>();
  const events: { workspaceId: string; generation: number }[] = [];
  const watcher = new GitRepoWatcher({
    notify: (workspaceId, generation) => events.push({ workspaceId, generation }),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    resolveTargets: async () => targets,
    watch: (target, watchOptions, listener) => {
      if (options.failRecursive && watchOptions.recursive) {
        throw new Error("recursive watch unsupported");
      }
      const emitter = new EventEmitter();
      const handle: SyntheticHandle = {
        target,
        recursive: Boolean(watchOptions.recursive),
        closed: false,
        listener,
        emitter,
      };
      handles.set(target, handle);
      return Object.assign(emitter, {
        close() {
          handle.closed = true;
        },
      }) as unknown as Pick<FSWatcher, "close" | "on">;
    },
  });
  t.after(() => watcher.dispose());
  return {
    watcher,
    events,
    handles,
    emit(target: string, event: string, filename: string | Buffer | null) {
      const handle = handles.get(target);
      assert.ok(handle && !handle.closed, `expected an open watcher for ${target}`);
      handle.listener(event, filename);
    },
  };
}

function nativeWatchHarness(t: test.TestContext, options: Omit<GitRepoWatcherOptions, "notify" | "watch"> = {}) {
  let phase = "setup";
  let rawSeq = 0;
  let sentinelSeq = 0;
  const targets: { target: string; recursive: boolean }[] = [];
  const rawEvents: { seq: number; phase: string; target: string; event: string; filename: string | null }[] = [];
  const events: { workspaceId: string; generation: number; phase: string; rawSeq: number }[] = [];

  const watcher = new GitRepoWatcher({
    ...options,
    notify: (workspaceId, generation) => {
      events.push({ workspaceId, generation, phase, rawSeq });
    },
    watch: (target, watchOptions, listener) => {
      targets.push({ target, recursive: Boolean(watchOptions.recursive) });
      return fsWatch(target, watchOptions, (event, filename) => {
        rawSeq += 1;
        rawEvents.push({
          seq: rawSeq,
          phase,
          target,
          event,
          filename: filename == null ? null : filename.toString(),
        });
        listener(event, filename);
      });
    },
  });
  t.after(() => watcher.dispose());

  const diagnostics = (workspaceId: string) =>
    JSON.stringify({
      phase,
      generation: watcher.generation(workspaceId),
      targets,
      recentRawEvents: rawEvents.slice(-20),
      events,
    });

  return {
    watcher,
    events,
    setPhase(next: string) {
      phase = next;
    },
    /**
     * macOS starts `fs.watch` event streams asynchronously on libuv's CFRunLoop
     * thread, so a single write immediately after `observe()` can complete before
     * the stream begins, and late setup events can arrive right after it starts.
     * Creating a uniquely named sentinel branch ref until its debounced
     * notification lands proves the native stream is live and drains prior
     * setup events before the caller records a generation baseline.
     */
    async waitUntilLive(workspaceId: string, gitRepo: string, git: GitRunner): Promise<number> {
      phase = "ready";
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        sentinelSeq += 1;
        const sentinel = `__watch_ready_${sentinelSeq}`;
        const rawFloor = rawSeq;
        git(gitRepo, "branch", sentinel);
        const probeWindow = Math.min(deadline, Date.now() + 150);
        while (Date.now() < probeWindow) {
          const sentinelRaw = rawEvents.find(
            (entry) =>
              entry.phase === "ready" &&
              entry.seq > rawFloor &&
              (entry.filename === null || path.basename(entry.filename) === sentinel),
          );
          if (
            sentinelRaw &&
            events.some((entry) => entry.workspaceId === workspaceId && entry.rawSeq >= sentinelRaw.seq)
          ) {
            return watcher.generation(workspaceId);
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      assert.fail(`timed out waiting for native Git watcher readiness on ${workspaceId}: ${diagnostics(workspaceId)}`);
    },
    async waitForGeneration(workspaceId: string, minGeneration: number): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (events.some((entry) => entry.workspaceId === workspaceId && entry.generation >= minGeneration)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.fail(
        `expected ${workspaceId} generation >= ${minGeneration}, saw ${watcher.generation(workspaceId)}: ${diagnostics(workspaceId)}`,
      );
    },
    lastGeneration(workspaceId: string): number | undefined {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.workspaceId === workspaceId) return events[index]?.generation;
      }
      return undefined;
    },
  };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

test("resolves the administrative and shared Git directories for checkouts, subfolders and linked worktrees", async (t) => {
  const { root, repo, git } = await makeRepo(t);
  const gitDir = path.join(repo, ".git");
  assert.deepEqual(await resolveGitWatchTargets(repo), { gitDir, commonDir: gitDir });
  assert.deepEqual(await resolveGitWatchTargets(path.join(repo, "src")), { gitDir, commonDir: gitDir });

  const linked = path.join(root, "linked");
  git(repo, "worktree", "add", "-b", "feature", linked);
  assert.deepEqual(await resolveGitWatchTargets(linked), {
    gitDir: path.join(gitDir, "worktrees", "linked"),
    commonDir: gitDir,
  });

  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  // tmpdir() is not inside a repository, so discovery must stop at the filesystem root.
  assert.equal(await resolveGitWatchTargets(plain), undefined);
});

test("coalesces metadata bursts across the quiet period, ignores unrelated Git files, and advances generations monotonically", async (t) => {
  const gitDir = path.join("/synthetic/repo", ".git");
  const refsDir = path.join(gitDir, "refs");
  const harness = syntheticWatchHarness(t, { gitDir, commonDir: gitDir });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  await harness.watcher.observe("ws-1", "/synthetic/repo");
  assert.equal(harness.handles.get(gitDir)?.recursive, false);
  assert.equal(harness.handles.get(refsDir)?.recursive, true);

  for (const ignored of ["COMMIT_EDITMSG", "index.lock", "HEAD.lock", "config", "logs", "objects"]) {
    harness.emit(gitDir, "change", ignored);
  }
  t.mock.timers.tick(500);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.watcher.generation("ws-1"), 0);

  // Commit metadata changes arrive as a burst across .git admin files and refs;
  // each relevant event restarts the 250 ms quiet period, while ignored lockfiles do not.
  harness.emit(gitDir, "rename", "index");
  t.mock.timers.tick(249);
  harness.emit(gitDir, "rename", "HEAD");
  t.mock.timers.tick(249);
  harness.emit(refsDir, "rename", Buffer.from(path.join("heads", "main")));
  t.mock.timers.tick(249);
  harness.emit(gitDir, "rename", "ORIG_HEAD");
  t.mock.timers.tick(249);
  harness.emit(gitDir, "rename", "index.lock");
  assert.deepEqual(harness.events, [], "no notification fires before the quiet period completes");

  t.mock.timers.tick(1);
  assert.deepEqual(harness.events, [{ workspaceId: "ws-1", generation: 1 }]);
  assert.equal(harness.watcher.generation("ws-1"), 1);
  t.mock.timers.tick(2_500);
  assert.equal(harness.events.length, 1);

  harness.emit(gitDir, "rename", "HEAD");
  harness.emit(refsDir, "rename", path.join("heads", "topic"));
  t.mock.timers.tick(249);
  assert.equal(harness.events.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(harness.events, [
    { workspaceId: "ws-1", generation: 1 },
    { workspaceId: "ws-1", generation: 2 },
  ]);
  assert.equal(harness.watcher.generation("ws-1"), 2);

  // Platforms or overflowed event queues that omit the filename still invalidate conservatively.
  harness.emit(gitDir, "change", null);
  t.mock.timers.tick(250);
  assert.deepEqual([...harness.events], [
    { workspaceId: "ws-1", generation: 1 },
    { workspaceId: "ws-1", generation: 2 },
    { workspaceId: "ws-1", generation: 3 },
  ]);
  assert.equal(harness.watcher.generation("ws-1"), 3);

  // Closing and re-observing a workspace never rewinds its generation counter.
  harness.watcher.close("ws-1");
  await harness.watcher.observe("ws-1", "/synthetic/repo");
  harness.emit(gitDir, "change", "HEAD");
  t.mock.timers.tick(250);
  assert.equal(harness.watcher.generation("ws-1"), 4);
});

test("linked worktrees filter common-dir admin noise and fall back to refs/heads when recursive watch is unavailable", async (t) => {
  const commonDir = path.join("/synthetic/repo", ".git");
  const linkedGitDir = path.join(commonDir, "worktrees", "linked");
  const headsDir = path.join(commonDir, "refs", "heads");
  const harness = syntheticWatchHarness(
    t,
    { gitDir: linkedGitDir, commonDir },
    { debounceMs: 50, failRecursive: true },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });

  await harness.watcher.observe("linked", "/synthetic/linked");
  assert.ok(harness.handles.has(headsDir), "falls back to watching refs/heads directly");

  // Another checkout's index or HEAD inside commonDir does not belong to the linked worktree.
  harness.emit(commonDir, "change", "index");
  harness.emit(commonDir, "change", "HEAD");
  t.mock.timers.tick(100);
  assert.deepEqual(harness.events, []);

  harness.emit(commonDir, "rename", "packed-refs");
  t.mock.timers.tick(50);
  assert.deepEqual(harness.events, [{ workspaceId: "linked", generation: 1 }]);

  harness.emit(headsDir, "rename", "main");
  t.mock.timers.tick(50);
  assert.deepEqual(harness.events, [
    { workspaceId: "linked", generation: 1 },
    { workspaceId: "linked", generation: 2 },
  ]);
});

test("a commit advances the repository generation once the native watch is live", async (t) => {
  const { repo, git } = await makeRepo(t);
  const harness = nativeWatchHarness(t, { debounceMs: 20 });
  await harness.watcher.observe("ws-1", repo);
  const baseline = await harness.waitUntilLive("ws-1", repo, git);

  harness.setPhase("commit");
  await fs.writeFile(path.join(repo, "src", "a.txt"), "a\nb\n");
  git(repo, "commit", "-am", "second");
  await harness.waitForGeneration("ws-1", baseline + 1);
  assert.ok(harness.watcher.generation("ws-1") > baseline);
  assert.equal(harness.watcher.generation("ws-1"), harness.lastGeneration("ws-1"));
});

test("unstaged working-tree edits do not notify because only Git metadata is watched", async (t) => {
  const { repo, git } = await makeRepo(t);
  const harness = nativeWatchHarness(t, { debounceMs: 20 });
  await harness.watcher.observe("ws-1", repo);
  await harness.waitUntilLive("ws-1", repo, git);

  const before = harness.events.length;
  harness.setPhase("edits");
  await fs.writeFile(path.join(repo, "src", "a.txt"), "edited\n");
  await fs.writeFile(path.join(repo, "src", "new.txt"), "new\n");
  await settle();
  assert.deepEqual(harness.events.slice(before), []);
});

test("a linked worktree is told when another checkout moves a shared branch", async (t) => {
  const { root, repo, git } = await makeRepo(t);
  const linked = path.join(root, "linked");
  git(repo, "worktree", "add", "-b", "feature", linked);
  const harness = nativeWatchHarness(t, { debounceMs: 20 });
  await harness.watcher.observe("linked", linked);
  const baseline = await harness.waitUntilLive("linked", repo, git);

  // The main checkout commits on main: refs live in the common dir, not the linked gitdir.
  harness.setPhase("shared-commit");
  git(repo, "commit", "--allow-empty", "-m", "elsewhere");
  await harness.waitForGeneration("linked", baseline + 1);
  assert.ok(harness.watcher.generation("linked") > baseline);
});

test("idle workspaces stop being watched until they are read again", async (t) => {
  const { repo, git } = await makeRepo(t);
  let clock = 0;
  const harness = nativeWatchHarness(t, { debounceMs: 20, idleMs: 1_000, now: () => clock });
  await harness.watcher.observe("ws-1", repo);
  await harness.waitUntilLive("ws-1", repo, git);

  clock = 500;
  harness.watcher.evictIdle();
  assert.equal(harness.watcher.watchedWorkspaceCount, 1);
  clock = 1_000;
  harness.watcher.evictIdle();
  assert.equal(harness.watcher.watchedWorkspaceCount, 0);

  const beforeIdleCommit = harness.events.length;
  harness.setPhase("idle");
  git(repo, "commit", "--allow-empty", "-m", "while idle");
  await settle();
  assert.deepEqual(harness.events.slice(beforeIdleCommit), []);

  harness.setPhase("reobserve");
  await harness.watcher.observe("ws-1", repo);
  const baseline = await harness.waitUntilLive("ws-1", repo, git);

  harness.setPhase("after-reobserve");
  git(repo, "commit", "--allow-empty", "-m", "after reading again");
  await harness.waitForGeneration("ws-1", baseline + 1);
  assert.ok(harness.watcher.generation("ws-1") > baseline);
});

test("non-repository folders are tolerated and never notify", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aiden-git-watch-plain-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const harness = nativeWatchHarness(t, { debounceMs: 20 });
  await harness.watcher.observe("plain", root);
  await fs.writeFile(path.join(root, "file.txt"), "x");
  await settle(200);
  assert.deepEqual(harness.events, []);
});
