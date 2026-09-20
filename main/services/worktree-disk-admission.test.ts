import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assertWorktreeDiskAdmission,
  estimateTrackedCheckoutBytes,
  MAX_TRACKED_CHECKOUT_BYTES,
  MAX_TRACKED_CHECKOUT_FILES,
  requiredWorktreeFreeBytes,
  WorktreeDiskAdmissionError,
  worktreeReserveBytes,
  type FilesystemStats,
} from "./worktree-disk-admission.js";

const GIB = 1024 * 1024 * 1024;

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-disk-admission-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function stats(freeBytes: number, capacityBytes: number): FilesystemStats {
  return { freeBytes, capacityBytes };
}

test("worktree reserve is 10% of capacity clamped to [4 GiB, 16 GiB]", () => {
  assert.equal(worktreeReserveBytes(GIB), 4 * GIB); // floor
  assert.equal(worktreeReserveBytes(100 * GIB), 10 * GIB); // 10%
  assert.equal(worktreeReserveBytes(1_000 * GIB), 16 * GIB); // cap
});

test("required free bytes double estimates and add the reserve", () => {
  const capacity = 100 * GIB;
  assert.equal(
    requiredWorktreeFreeBytes(capacity, { checkoutBytes: GIB, provisionedBytes: 0 }),
    10 * GIB + 2 * GIB,
  );
  assert.equal(
    requiredWorktreeFreeBytes(capacity, { checkoutBytes: GIB, provisionedBytes: 0.5 * GIB }),
    10 * GIB + 2 * GIB + GIB,
  );
});

test("required free bytes fail closed on overflow and unsafe inputs", () => {
  const capacity = 100 * GIB;
  for (const estimate of [
    { checkoutBytes: -1, provisionedBytes: 0 },
    { checkoutBytes: 0.5, provisionedBytes: 0 },
    { checkoutBytes: Number.MAX_SAFE_INTEGER, provisionedBytes: 0 },
    { checkoutBytes: MAX_TRACKED_CHECKOUT_BYTES + 1, provisionedBytes: 0 },
    { checkoutBytes: 0, provisionedBytes: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(
      () => requiredWorktreeFreeBytes(capacity, estimate),
      (error) =>
        error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
      JSON.stringify(estimate),
    );
  }
});

test("disk admission passes with enough free space, walking to an existing ancestor", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "not", "created", "yet");
  let probed: string | undefined;
  await assertWorktreeDiskAdmission(
    target,
    { checkoutBytes: GIB, provisionedBytes: 0 },
    async (candidate) => {
      probed = candidate;
      await fs.stat(candidate); // pretend statfs: ENOENT for missing paths
      return stats(100 * GIB, 200 * GIB);
    },
  );
  assert.equal(probed, root);
});

test("disk admission rejects with an actionable message when space is insufficient", async () => {
  await assert.rejects(
    assertWorktreeDiskAdmission(
      "/worktrees",
      { checkoutBytes: 10 * GIB, provisionedBytes: 0 },
      async () => stats(25 * GIB, 100 * GIB),
    ),
    (error) => {
      assert.ok(error instanceof WorktreeDiskAdmissionError);
      assert.equal(error.failure, "insufficient");
      assert.match(error.message, /Aiden needs approximately 30\.0 GB/u);
      assert.match(error.message, /only 25\.0 GB is free/u);
      return true;
    },
  );
});

test("disk admission fails closed when statfs fails or reports unsafe values", async () => {
  await assert.rejects(
    assertWorktreeDiskAdmission("/anywhere", { checkoutBytes: 0, provisionedBytes: 0 }, async () => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    }),
    (error) =>
      error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
  );
  for (const broken of [
    stats(-1, 100 * GIB),
    stats(0.5, 100 * GIB),
    stats(10 * GIB, 0),
    stats(10 * GIB, Number.MAX_SAFE_INTEGER + 1),
  ]) {
    await assert.rejects(
      assertWorktreeDiskAdmission(
        "/anywhere",
        { checkoutBytes: 0, provisionedBytes: 0 },
        async () => broken,
      ),
      (error) =>
        error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
      JSON.stringify(broken),
    );
  }
});

test("checkout estimate sums file sizes and skips vanished files", async (t) => {
  const repository = await temporaryDirectory(t);
  await fs.mkdir(path.join(repository, "sub"));
  await fs.writeFile(path.join(repository, "a.txt"), "12345", "utf8");
  await fs.writeFile(path.join(repository, "sub", "b.txt"), "1234567", "utf8");
  const listing = ["a.txt", "sub/b.txt", "gone.txt"].join("\u0000") + "\u0000";
  const bytes = await estimateTrackedCheckoutBytes(listing, repository);
  assert.equal(bytes, 12);
});

test("checkout estimate refuses corrupted or unbounded listings", async (t) => {
  const repository = await temporaryDirectory(t);
  await fs.writeFile(path.join(repository, "a.txt"), "12345", "utf8");

  await assert.rejects(
    estimateTrackedCheckoutBytes(["a.txt", "../escape"].join("\u0000"), repository),
    (error) =>
      error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
  );
  await assert.rejects(
    estimateTrackedCheckoutBytes(["a.txt", "/etc/passwd"].join("\u0000"), repository),
    (error) =>
      error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
  );
  const tooMany = Array.from({ length: MAX_TRACKED_CHECKOUT_FILES + 1 }, (_, i) => `f${i}`);
  await assert.rejects(
    estimateTrackedCheckoutBytes(tooMany.join("\u0000"), repository, async () => {
      throw new Error("must not reach lstat for every entry");
    }),
    (error) =>
      error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
  );
  await assert.rejects(
    estimateTrackedCheckoutBytes(["big.bin"].join("\u0000"), repository, async () => ({
      size: MAX_TRACKED_CHECKOUT_BYTES + 1,
    })),
    (error) =>
      error instanceof WorktreeDiskAdmissionError && error.failure === "unavailable",
  );
});
