import assert from "node:assert/strict";
import test from "node:test";
import {
  AidenRemoteWorkspaceGitCache,
  projectAidenRemoteWorkspaceGit,
  type AidenRemoteWorkspaceGitRead,
} from "./aiden-remote-workspace-git-cache.js";

/** A clock and timer queue the test moves by hand, so nothing really sleeps. */
function manualTime() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    schedule: (ms: number, run: () => void) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((value) => !value.cancelled && value.at <= now)) {
        timer.cancelled = true;
        timer.run();
      }
    },
  };
}

interface PendingRead {
  folder: string;
  signal: AbortSignal;
  resolve: (read: AidenRemoteWorkspaceGitRead) => void;
  reject: (error: unknown) => void;
}

/** A reader whose answers the test gives one at a time. */
function manualReader() {
  const reads: PendingRead[] = [];
  return {
    reads,
    read: (folder: string, signal: AbortSignal) =>
      new Promise<AidenRemoteWorkspaceGitRead>((resolve, reject) => {
        reads.push({ folder, signal, resolve, reject });
      }),
    pending(folder: string): PendingRead {
      const read = reads.find((value) => value.folder === folder);
      assert.ok(read, `no read of ${folder}`);
      reads.splice(reads.indexOf(read), 1);
      return read;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const repo = (root: string, branch = "main", uncommitted = 0): AidenRemoteWorkspaceGitRead => ({
  root,
  info: { isRepo: true, branch, uncommitted },
});

function cache(options: { concurrency?: number } = {}) {
  const time = manualTime();
  const reader = manualReader();
  const git = new AidenRemoteWorkspaceGitCache({
    read: reader.read,
    now: time.now,
    schedule: time.schedule,
    freshMs: 30_000,
    readTimeoutMs: 15_000,
    concurrency: options.concurrency ?? 3,
    backoffMaxMs: 10 * 60_000,
  });
  return { time, reader, git };
}

test("a peek answers at once, and the summary appears once the background read finishes", async () => {
  const { reader, git } = cache();

  assert.equal(git.peek("/code/app"), undefined, "nothing is known before the first read");
  assert.equal(reader.reads.length, 1);

  reader.pending("/code/app").resolve(repo("/code/app", "feature/mobile", 2));
  await settle();
  assert.deepEqual(git.peek("/code/app"), { isRepo: true, branch: "feature/mobile", uncommitted: 2 });
  assert.equal(reader.reads.length, 0, "a fresh summary starts no read");
});

test("a stale summary is served while one refresh replaces it", async () => {
  const { time, reader, git } = cache();
  git.peek("/code/app");
  reader.pending("/code/app").resolve(repo("/code/app", "main", 0));
  await settle();

  time.advance(30_000);
  assert.deepEqual(git.peek("/code/app"), { isRepo: true, branch: "main", uncommitted: 0 });
  assert.deepEqual(git.peek("/code/app"), { isRepo: true, branch: "main", uncommitted: 0 });
  assert.equal(reader.reads.length, 1, "repeated peeks share one refresh");

  reader.pending("/code/app").resolve(repo("/code/app", "main", 4));
  await settle();
  assert.deepEqual(git.peek("/code/app"), { isRepo: true, branch: "main", uncommitted: 4 });
});

test("folders in one repository share its entry and its refresh", async () => {
  const { time, reader, git } = cache();
  git.peek("/code/app");
  git.peek("/code/app/packages/web");
  reader.pending("/code/app").resolve(repo("/code/app", "main", 1));
  reader.pending("/code/app/packages/web").resolve(repo("/code/app", "main", 1));
  await settle();

  time.advance(30_000);
  git.peek("/code/app");
  git.peek("/code/app/packages/web");
  assert.equal(reader.reads.length, 1, "one refresh for the repository");

  reader.reads[0]!.resolve(repo("/code/app", "release", 5));
  reader.reads.length = 0;
  await settle();
  assert.deepEqual(git.peek("/code/app/packages/web"), { isRepo: true, branch: "release", uncommitted: 5 });
  assert.deepEqual(git.peek("/code/app"), { isRepo: true, branch: "release", uncommitted: 5 });
});

test("background reads respect the concurrency limit and never repeat a folder already waiting", async () => {
  const { reader, git } = cache({ concurrency: 2 });
  for (const folder of ["/a", "/b", "/c", "/d"]) git.peek(folder);
  for (const folder of ["/a", "/b", "/c", "/d"]) git.peek(folder);
  assert.deepEqual(reader.reads.map((value) => value.folder), ["/a", "/b"]);

  reader.pending("/a").resolve(repo("/a"));
  await settle();
  assert.deepEqual(reader.reads.map((value) => value.folder), ["/b", "/c"]);

  reader.pending("/b").reject(new Error("unreadable"));
  reader.pending("/c").resolve(repo("/c"));
  await settle();
  assert.deepEqual(reader.reads.map((value) => value.folder), ["/d"]);
});

test("a failed read leaves the folder without a summary and backs it off, longer each time", async () => {
  const { time, reader, git } = cache();
  git.peek("/code/app");
  reader.pending("/code/app").resolve(repo("/code/app", "main", 0));
  await settle();

  time.advance(30_000);
  git.peek("/code/app");
  reader.pending("/code/app").reject(new Error("fatal: not readable"));
  await settle();
  assert.equal(git.peek("/code/app"), undefined, "a failure drops the old summary rather than reporting it");
  assert.equal(reader.reads.length, 0);

  time.advance(59_999);
  git.peek("/code/app");
  assert.equal(reader.reads.length, 0, "still backing off");
  time.advance(1);
  git.peek("/code/app");
  reader.pending("/code/app").reject(new Error("fatal: not readable"));
  await settle();

  time.advance(60_000);
  git.peek("/code/app");
  assert.equal(reader.reads.length, 0, "the second failure waits longer");
  time.advance(60_000);
  git.peek("/code/app");
  assert.equal(reader.reads.length, 1);
});

test("a read that outlasts its deadline is abandoned, and holds its slot until it actually stops", async () => {
  const { time, reader, git } = cache({ concurrency: 1 });
  git.peek("/slow");
  git.peek("/fast");
  const slow = reader.pending("/slow");
  assert.equal(reader.reads.length, 0, "the second folder waits for the slot");

  time.advance(15_000);
  assert.equal(slow.signal.aborted, true, "the abandoned read is cancelled");
  assert.equal(git.peek("/slow"), undefined);
  await settle();
  assert.equal(reader.reads.length, 0, "the slot stays taken until the read settles");

  slow.resolve(repo("/slow", "late", 9));
  await settle();
  assert.equal(git.peek("/slow"), undefined, "an answer after the deadline is ignored");
  assert.deepEqual(reader.reads.map((value) => value.folder), ["/fast"]);
});

test("the summary omits a detached HEAD's branch and cuts long names between code points", () => {
  assert.deepEqual(
    projectAidenRemoteWorkspaceGit({ isRepo: true, detached: true, branch: "HEAD", uncommitted: 1 }),
    { isRepo: true, uncommitted: 1 },
  );

  const long = projectAidenRemoteWorkspaceGit({ isRepo: true, branch: `${"a".repeat(254)}\u{1F600}tail` })!.branch!;
  assert.equal(Array.from(long).length, 255);
  assert.equal(long.endsWith("\u{1F600}"), true, "the emoji is kept whole");

  const emoji = projectAidenRemoteWorkspaceGit({ isRepo: true, branch: "\u{1F33F}".repeat(300) })!.branch!;
  assert.equal(Array.from(emoji).length, 255);
  assert.equal(/[\uD800-\uDFFF]/u.test(emoji), false, "no lone surrogate");

  assert.deepEqual(projectAidenRemoteWorkspaceGit({ isRepo: true, branch: "bad\nname" }), { isRepo: true });
  assert.deepEqual(projectAidenRemoteWorkspaceGit({ isRepo: false, branch: "main" }), { isRepo: false });
});
