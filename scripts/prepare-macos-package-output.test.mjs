import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginMacDistribution,
  prepareMacPackageOutput,
  promoteMacDistribution,
  resolveComputerUseAcceptanceReceipt,
  resolveMacDistributionStaging,
  resolveMacPackageOutput,
  writeComputerUseAcceptanceReceipt,
} from "./prepare-macos-package-output.mjs";

test("package outputs isolate development, staging, and distribution artifacts", () => {
  const root = path.resolve("/tmp/aiden-package-output-contract");
  assert.equal(
    resolveMacPackageOutput("development", root),
    path.join(root, "release", "development"),
  );
  assert.equal(
    resolveMacPackageOutput("distribution", root),
    path.join(root, "release", "distribution"),
  );
  assert.equal(
    resolveMacDistributionStaging(root),
    path.join(root, "release", ".distribution-staging"),
  );
  assert.throws(() => resolveMacPackageOutput("release", root), /development or distribution/u);
});

test("preparing an output removes stale artifacts only inside the selected lane and receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-package-output-"));
  const development = resolveMacPackageOutput("development", root);
  const distribution = resolveMacPackageOutput("distribution", root);
  const receipt = resolveComputerUseAcceptanceReceipt(root);
  try {
    await Promise.all([
      mkdir(development, { recursive: true }),
      mkdir(distribution, { recursive: true }),
      mkdir(path.dirname(receipt), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(development, "stale.app"), "stale", "utf8"),
      writeFile(path.join(distribution, "release.dmg"), "keep", "utf8"),
      writeFile(receipt, "stale acceptance", "utf8"),
    ]);
    assert.equal(await prepareMacPackageOutput("development", root), development);
    await assert.rejects(readFile(path.join(development, "stale.app")), /ENOENT/u);
    await assert.rejects(readFile(receipt), /ENOENT/u);
    assert.equal(await readFile(path.join(distribution, "release.dmg"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package cleanup refuses a symlinked release ancestor without touching its target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-package-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "aiden-package-outside-"));
  const sentinel = path.join(outside, "distribution", "outside.txt");
  try {
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await symlink(outside, path.join(root, "release"));
    await assert.rejects(prepareMacPackageOutput("distribution", root), /symlink component/u);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("a distribution is promoted atomically only from the staging lane", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-package-transaction-"));
  try {
    const transaction = await beginMacDistribution(root);
    await writeFile(path.join(transaction.staging, "Aiden Agent.dmg"), "verified", "utf8");
    await assert.rejects(
      readFile(path.join(transaction.distribution, "Aiden Agent.dmg")),
      /ENOENT/u,
    );
    assert.equal(await promoteMacDistribution(root), transaction.distribution);
    assert.equal(
      await readFile(path.join(transaction.distribution, "Aiden Agent.dmg"), "utf8"),
      "verified",
    );
    await assert.rejects(readFile(path.join(transaction.staging, "Aiden Agent.dmg")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance receipts are new private files and never overwrite prior evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-acceptance-receipt-"));
  try {
    const receipt = await writeComputerUseAcceptanceReceipt("evidence", root);
    assert.equal(await readFile(receipt, "utf8"), "evidence");
    assert.equal((await lstat(receipt)).mode & 0o777, 0o600);
    await assert.rejects(
      writeComputerUseAcceptanceReceipt("replacement", root),
      /Refusing to replace existing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
