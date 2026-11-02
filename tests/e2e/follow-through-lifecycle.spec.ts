import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { E2E_WORKSPACE_ID, expect, test } from "./fixtures";
import type { ChatFollowThroughV1 } from "../../renderer/shared/follow-through";

function invoke<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(({ channel, args }) => {
    const { ipc } = (window as unknown as {
      aidenAPI: { ipc: { invoke<T>(name: string, ...args: unknown[]): Promise<T> } };
    }).aidenAPI;
    return ipc.invoke<T>(channel, ...args);
  }, { channel, args });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test.use({ workspaceSeed: true });

test("a crashed check is reaped before new work, and its chat keeps the interrupted check waiting", async ({ aiden }) => {
  test.setTimeout(90_000);
  let page = aiden.page;
  const { id } = await invoke<{ id: string }>(page, "chats:create", { workspaceId: E2E_WORKSPACE_ID });
  const destination = await invoke<{ id: string }>(page, "workspaces:create", { name: "Another workspace" });
  const pidFile = path.join(aiden.workspaceDir, "check.pid");
  await invoke(page, "chats:followThroughSetCheck", { chatId: id, command: "trap '' TERM; echo $$ >>check.pid && exec sleep 60" });
  await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).toMatch(/^\d+\n$/);
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(alive(pid)).toBe(true);
  await expect(invoke(page, "chats:moveEmptyToWorkspace", id, destination.id)).rejects.toThrow(/stop this chat.s check/i);

  aiden.app.process().kill("SIGKILL");
  page = await aiden.relaunch(async () => {
    // A damaged neighboring entry must not prevent recovery of this live group.
    const ledger = path.join(aiden.userDataDir, "background-jobs", "running.json");
    const record = JSON.parse(await readFile(ledger, "utf8"));
    record.jobs.unshift(null);
    await writeFile(ledger, JSON.stringify(record));
  });
  const restored = await invoke<ChatFollowThroughV1>(page, "chats:followThrough", id);
  expect(alive(pid)).toBe(false);
  expect(restored.check).toMatchObject({ state: "waiting", checksRun: 0 });
  expect(await readFile(pidFile, "utf8")).toBe(`${pid}\n`);

  // The first new command after recovery owns its own group. Even a child
  // that closed both output pipes cannot outlive the completed check.
  await invoke(page, "chats:followThroughSetCheck", {
    chatId: id, command: "sleep 60 >/dev/null 2>&1 & echo $! >leftover.pid",
  });
  await expect.poll(async () => (await invoke<ChatFollowThroughV1>(page, "chats:followThrough", id)).check?.state).toBe("passed");
  expect(alive(Number(await readFile(path.join(aiden.workspaceDir, "leftover.pid"), "utf8")))).toBe(false);
});

test("checks refuse a replaced worktree and drain before its original checkout is removed", async ({ aiden }) => {
  test.setTimeout(90_000);
  const git = (...args: string[]) => execFileSync("git", ["-C", aiden.workspaceDir, ...args]);
  git("init", "-b", "main");
  git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const worktree = await invoke<{ id: string; folderPath: string }>(aiden.page, "git:createWorktree", E2E_WORKSPACE_ID, "check-cleanup");
  const chat = await invoke<{ id: string }>(aiden.page, "chats:create", { workspaceId: worktree.id });
  const original = worktree.folderPath + "-original";
  await rename(worktree.folderPath, original);
  await mkdir(worktree.folderPath);
  try {
    await expect(invoke(aiden.page, "chats:followThroughSetCheck", { chatId: chat.id, command: "touch unexpected" }))
      .rejects.toThrow(/managed worktree/i);
    await expect(readFile(path.join(worktree.folderPath, "unexpected"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rmdir(worktree.folderPath);
    await rename(original, worktree.folderPath);
  }

  await invoke(aiden.page, "chats:followThroughSetCheck", { chatId: chat.id, command: "echo $$ >check.pid && exec sleep 60" });
  const pidFile = path.join(worktree.folderPath, "check.pid");
  await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).toMatch(/^\d+\n$/);
  const pid = Number(await readFile(pidFile, "utf8"));
  // An unprovisioned ignored file makes ordinary removal refuse before Git
  // mutates the checkout. The process stops, but its check stays configured.
  await writeFile(path.join(worktree.folderPath, ".gitignore"), "keep.local\n");
  await writeFile(path.join(worktree.folderPath, "keep.local"), "keep me");
  await expect(invoke(aiden.page, "git:deleteManagedWorktree", worktree.id)).rejects.toThrow(/ignored files/i);
  expect(alive(pid)).toBe(false);
  const retained = (await invoke<ChatFollowThroughV1>(aiden.page, "chats:followThrough", chat.id)).check;
  expect(retained).toMatchObject({ state: "waiting", checksRun: 0 });
  await invoke(aiden.page, "git:deleteManagedWorktree", worktree.id, { force: true });
  expect(alive(pid)).toBe(false);
  expect((await invoke<ChatFollowThroughV1>(aiden.page, "chats:followThrough", chat.id)).check).toBeNull();
});

test("revoking folder access ends a restored pull request follow across relaunch", async ({ aiden }) => {
  test.setTimeout(90_000);
  const chat = await invoke<{ id: string }>(aiden.page, "chats:create", { workspaceId: E2E_WORKSPACE_ID });
  const state = () => invoke<ChatFollowThroughV1>(aiden.page, "chats:followThrough", chat.id);
  await aiden.relaunch(async () => {
    // A prior release's record has a chat id and no workspace id. Its next
    // poll is in the future, so this test never needs a GitHub connection.
    const now = Date.now();
    const dir = path.join(aiden.userDataDir, "follow-through");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify({
      version: 1, checks: [], follows: [{
        version: 1, chatId: chat.id, host: "github.com", repository: "example/repo", number: 1,
        url: "https://github.com/example/repo/pull/1", startedBy: "person", state: "following",
        startedAt: now, lastActivityAt: now, nextCheckAt: now + 3_600_000, noticesSent: 0, readFailures: 0, seenCommentIds: [],
      }],
    }));
  });
  expect((await state()).pullRequests[0]?.state).toBe("following");
  await invoke(aiden.page, "workspaces:update", E2E_WORKSPACE_ID, { permission: "none" });
  expect((await state()).pullRequests[0]?.endedReason).toBe("access-changed");
  await aiden.relaunch();
  expect((await state()).pullRequests[0]?.endedReason).toBe("access-changed");
});

test("moving an empty chat retries a retained check after its last process exits", async ({ aiden }) => {
  const chat = await invoke<{ id: string }>(aiden.page, "chats:create", { workspaceId: E2E_WORKSPACE_ID });
  const next = await invoke<{ id: string }>(aiden.page, "workspaces:create", { name: "Destination" });
  // The group leader exits and its surviving child has no visible Aiden
  // marker. Crash recovery can neither attribute nor safely stop the child.
  const shell = spawn("/bin/sh", ["-c", "sleep 120 </dev/null >/dev/null 2>&1 & echo $! > retained.pid"], {
    detached: true, cwd: aiden.workspaceDir, stdio: "ignore",
  });
  const [code] = await once(shell, "exit");
  expect(code).toBe(0);
  const child = Number(await readFile(path.join(aiden.workspaceDir, "retained.pid"), "utf8"));
  try {
    const page = await aiden.relaunch(async () => {
      const dir = path.join(aiden.userDataDir, "background-jobs");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "running.json"), JSON.stringify({
        version: 1, jobs: [{ id: "job_abcdefab", pid: shell.pid, check: { chatId: chat.id, workspaceId: E2E_WORKSPACE_ID } }],
      }));
    });
    const move = () => invoke<{ workspaceId: string }>(page, "chats:moveEmptyToWorkspace", chat.id, next.id);
    await expect(move()).rejects.toThrow(/confirm.*check stopped/i);
    expect(alive(child)).toBe(true);
    process.kill(child, "SIGKILL");
    await expect(move()).resolves.toMatchObject({ workspaceId: next.id });
  } finally {
    if (alive(child)) process.kill(child, "SIGKILL");
  }
});
