import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOT_MANAGED_HOME_RECEIPTS_DIRECTORY,
  BOT_MANAGED_HOME_RECEIPT_SUFFIX,
  BOT_MANAGED_HOMES_DIRECTORY,
  BOT_MANAGED_WORKSPACE_MANIFEST,
  createBotManagedWorkspaceService,
  createFileBotManagedWorkspaceStorage,
} from "./bot-managed-workspace.js";
import {
  BotManagedWorkspaceConflictError,
  BotManagedWorkspaceRollbackError,
  BotManagedWorkspaceStateError,
  BOT_MANAGED_WORKSPACE_VERSION,
  botManagedHomeDirectoryName,
  createBotManagedWorkspaceCore,
  type BotManagedHomeProvisioningReceipt,
} from "./bot-managed-workspace-core.js";

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";

async function temporaryRoot(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return { parent, root: join(parent, "bot-private") };
}

function mode(value: { mode: number }): number {
  return value.mode & 0o777;
}

function receiptPath(root: string, workspaceId: string): string {
  return join(
    root,
    BOT_MANAGED_HOME_RECEIPTS_DIRECTORY,
    `${botManagedHomeDirectoryName(workspaceId)}${BOT_MANAGED_HOME_RECEIPT_SUFFIX}`,
  );
}

test("one private non-Git home is stable across chats, concurrency, and restart", async () => {
  const paths = await temporaryRoot("aiden-bot-home-");
  try {
    const minted = [WORKSPACE_A, WORKSPACE_B];
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      now: () => 42,
      mintWorkspaceId: () => minted.shift()!,
    });
    const [first, concurrent] = await Promise.all([
      service.provision("bot-1"),
      service.provision("bot-1"),
    ]);
    assert.deepEqual(concurrent, first);
    assert.equal(first.workspaceId, WORKSPACE_A);
    assert.equal(first.homePath, join(await realpath(paths.root), "homes", `home-${WORKSPACE_A}`));

    const restarted = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    assert.deepEqual(await restarted.resolve("bot-1"), first);
    assert.deepEqual(await restarted.provision("bot-1"), first);
    assert.deepEqual(await restarted.listBindings(), [
      { botId: "bot-1", workspaceId: WORKSPACE_A, createdAt: 42 },
    ]);
    assert.deepEqual(await readdir(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY)), [
      `home-${WORKSPACE_A}`,
    ]);

    assert.equal(mode(await lstat(paths.root)), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY))), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_MANAGED_HOME_RECEIPTS_DIRECTORY))), 0o700);
    assert.equal(mode(await lstat(first.homePath)), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST))), 0o600);
    assert.equal(mode(await lstat(receiptPath(paths.root, WORKSPACE_A))), 0o600);
    assert.deepEqual(await readdir(first.homePath), [], "the Bot-visible home starts empty");
    await assert.rejects(lstat(join(first.homePath, ".aiden-bot-home.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(first.homePath, ".git")), { code: "ENOENT" });
    await assert.rejects(lstat(join(paths.root, "config.json")), { code: "ENOENT" });

    const manifest = await readFile(join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST), "utf8");
    assert.equal(manifest.includes(paths.parent), false, "absolute paths never enter metadata");
    assert.equal(JSON.stringify(await restarted.listBindings()).includes("homePath"), false);
    assert.equal(JSON.stringify(await restarted.listBindings()).includes("incarnation"), false);
    const manifestDocument = JSON.parse(manifest) as {
      bindings: Array<{ incarnation: { device: string; inode: string } }>;
    };
    const receiptDocument = JSON.parse(
      await readFile(receiptPath(paths.root, WORKSPACE_A), "utf8"),
    ) as { incarnation: { device: string; inode: string } };
    assert.deepEqual(manifestDocument.bindings[0]?.incarnation, first.incarnation);
    assert.deepEqual(receiptDocument.incarnation, first.incarnation);
    assert.match(first.incarnation.device, /^(?:0|[1-9][0-9]*)$/u);
    assert.match(first.incarnation.inode, /^[1-9][0-9]*$/u);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

/**
 * Approved remount boundary. macOS reassigns `st_dev` at mount time, so this
 * test fabricates prior-mount device metadata that no live volume presents and
 * asserts the home still resolves and revalidates: acceptance rests on the
 * surviving inode, the single owned-volume anchor checks, and exact
 * manifest/receipt agreement. A different private volume that reproduced the
 * persisted inode would therefore be accepted by design; inode changes remain
 * rejected by "traversal, symlinked roots, and substituted homes never
 * resolve" and "fresh revalidation rejects a resolve-to-effect directory
 * swap". See `sameHomeByInode` in bot-managed-workspace.ts for why the
 * residual substituted-volume case is out of scope and what a future stable
 * volume identity would require.
 */
test("a remounted volume keeps the same owned home without rewriting its receipt", async () => {
  const paths = await temporaryRoot("aiden-bot-home-remount-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const first = await service.provision("bot-1");
    const manifestPath = join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST);
    const ownedReceiptPath = receiptPath(paths.root, WORKSPACE_A);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      bindings: Array<{ incarnation: { device: string; inode: string } }>;
    };
    const receipt = JSON.parse(await readFile(ownedReceiptPath, "utf8")) as {
      incarnation: { device: string; inode: string };
    };
    const previousDevice = (BigInt(first.incarnation.device) + 1n).toString();
    manifest.bindings[0]!.incarnation.device = previousDevice;
    receipt.incarnation.device = previousDevice;
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await writeFile(ownedReceiptPath, JSON.stringify(receipt), { mode: 0o600 });

    const restarted = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    assert.deepEqual(await restarted.listBindings(), [{
      botId: "bot-1",
      workspaceId: WORKSPACE_A,
      createdAt: first.createdAt,
    }]);
    assert.deepEqual(await restarted.resolve("bot-1"), first);
    assert.deepEqual(await restarted.revalidate(first), first);
    assert.equal(
      (JSON.parse(await readFile(ownedReceiptPath, "utf8")) as typeof receipt).incarnation.device,
      previousDevice,
      "remount handling does not rewrite ownership evidence",
    );

    manifest.bindings[0]!.incarnation.device = first.incarnation.device;
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const inconsistent = createBotManagedWorkspaceService({ root: () => paths.root, mintWorkspaceId: () => WORKSPACE_B });
    await assert.rejects(inconsistent.resolve("bot-1"), /does not match its private ownership record/u);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("journal reconciliation after a remount publishes the receipt's durable token", async () => {
  const paths = await temporaryRoot("aiden-bot-home-remount-reconcile-");
  try {
    const reservation = { botId: "bot-1", workspaceId: WORKSPACE_A, createdAt: 42 };
    const directoryName = botManagedHomeDirectoryName(WORKSPACE_A);
    const storage = createFileBotManagedWorkspaceStorage({ root: () => paths.root });
    const inspection = await storage.createHome(directoryName, {
      version: BOT_MANAGED_WORKSPACE_VERSION,
      directoryName,
      ...reservation,
    });
    const ownedReceiptPath = receiptPath(paths.root, WORKSPACE_A);
    const receipt = JSON.parse(await readFile(ownedReceiptPath, "utf8")) as {
      incarnation: { device: string; inode: string };
    };
    receipt.incarnation.device = (BigInt(inspection.incarnation.device) + 1n).toString();
    await writeFile(ownedReceiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    const recovered = await service.reconcileProvision(reservation);
    assert.deepEqual(recovered.incarnation, inspection.incarnation);
    const manifest = JSON.parse(await readFile(join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST), "utf8")) as {
      bindings: Array<{ incarnation: { device: string; inode: string } }>;
    };
    assert.deepEqual(manifest.bindings[0]?.incarnation, receipt.incarnation);
    assert.deepEqual(await service.resolve("bot-1"), recovered);
    assert.deepEqual(await service.revalidate(recovered), recovered);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("explicit journal reconciliation adopts only its exact reservation and stays idempotent", async () => {
  const paths = await temporaryRoot("aiden-bot-reconcile-");
  try {
    const storage = createFileBotManagedWorkspaceStorage({ root: () => paths.root });
    const reservation = { botId: "bot-recovery", workspaceId: WORKSPACE_A, createdAt: 99 };
    const directoryName = botManagedHomeDirectoryName(reservation.workspaceId);
    const receipt: BotManagedHomeProvisioningReceipt = {
      version: BOT_MANAGED_WORKSPACE_VERSION,
      directoryName,
      ...reservation,
    };
    await storage.createHome(directoryName, receipt);

    const service = createBotManagedWorkspaceCore({
      storage,
      now: () => 100,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    const recovered = await service.reconcileProvision(reservation);
    assert.equal(recovered.workspaceId, WORKSPACE_A);
    assert.deepEqual(await service.reconcileProvision(reservation), recovered);

    await assert.rejects(
      service.reconcileProvision({ ...reservation, workspaceId: WORKSPACE_B }),
      BotManagedWorkspaceConflictError,
    );
    assert.equal((await service.listBindings()).length, 1);
    assert.deepEqual(await readdir(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY)), [directoryName]);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("failed publication rolls a new empty home back without recursive deletion", async () => {
  const paths = await temporaryRoot("aiden-bot-home-rollback-");
  try {
    const storage = createFileBotManagedWorkspaceStorage({ root: () => paths.root });
    const service = createBotManagedWorkspaceCore({
      storage: {
        ...storage,
        writeManifest: async () => {
          throw new Error("manifest unavailable");
        },
      },
      now: () => 1,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    await assert.rejects(service.provision("bot-rollback"), /manifest unavailable/u);
    assert.deepEqual(await readdir(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY)), []);
    assert.deepEqual(await readdir(join(paths.root, BOT_MANAGED_HOME_RECEIPTS_DIRECTORY)), []);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("rollback requires the pre-identity checkpoint and preserves a nonempty home", async () => {
  const paths = await temporaryRoot("aiden-bot-safe-rollback-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      now: () => 7,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const provisioned = await service.provision("bot-draft");
    await assert.rejects(
      service.rollbackProvision({
        botId: "bot-draft",
        workspaceId: WORKSPACE_A,
        createdAt: 7,
        identityCommitted: true,
      } as never),
      BotManagedWorkspaceRollbackError,
    );

    const artifact = join(provisioned.homePath, "draft.txt");
    await writeFile(artifact, "keep me", { mode: 0o600 });
    await assert.rejects(
      service.rollbackProvision({
        botId: "bot-draft",
        workspaceId: WORKSPACE_A,
        createdAt: 7,
        identityCommitted: false,
      }),
      /preserved/u,
    );
    assert.equal(await readFile(artifact, "utf8"), "keep me");
    assert.equal((await service.listBindings()).length, 1);

    await unlink(artifact);
    await service.rollbackProvision({
      botId: "bot-draft",
      workspaceId: WORKSPACE_A,
      createdAt: 7,
      identityCommitted: false,
    });
    await service.rollbackProvision({
      botId: "bot-draft",
      workspaceId: WORKSPACE_A,
      createdAt: 7,
      identityCommitted: false,
    });
    assert.deepEqual(await service.listBindings(), []);
    await assert.rejects(lstat(provisioned.homePath), { code: "ENOENT" });
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("missing, corrupt, future, duplicate, and unbound state fails closed", async () => {
  const paths = await temporaryRoot("aiden-bot-home-invalid-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      now: () => 5,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const home = await service.provision("bot-1");
    const manifest = join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST);
    const valid = JSON.parse(await readFile(manifest, "utf8")) as {
      version: number;
      bindings: unknown[];
    };

    await writeFile(manifest, "{bad", { mode: 0o600 });
    await assert.rejects(service.resolve("bot-1"));

    await writeFile(manifest, JSON.stringify({ ...valid, version: 3 }), { mode: 0o600 });
    const future = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    await assert.rejects(future.resolve("bot-1"), /version is unsupported/u);

    await writeFile(
      manifest,
      JSON.stringify({
        version: BOT_MANAGED_WORKSPACE_VERSION,
        bindings: [valid.bindings[0], valid.bindings[0]],
      }),
      { mode: 0o600 },
    );
    const duplicate = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    await assert.rejects(duplicate.resolve("bot-1"), /duplicate homes/u);

    await unlink(manifest);
    const missing = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    await assert.rejects(missing.resolve("bot-1"), /unbound or foreign home/u);
    await assert.rejects(missing.provision("bot-1"), /unbound or foreign home/u);
    assert.equal((await lstat(home.homePath)).isDirectory(), true);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("traversal, symlinked roots, and substituted homes never resolve", async () => {
  const paths = await temporaryRoot("aiden-bot-home-symlink-");
  const outside = await mkdtemp(join(tmpdir(), "aiden-bot-home-outside-"));
  try {
    const invalid = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    await assert.rejects(invalid.provision("../escape"), BotManagedWorkspaceStateError);

    await mkdir(paths.root, { mode: 0o700 });
    await symlink(outside, join(paths.root, BOT_MANAGED_HOMES_DIRECTORY));
    await assert.rejects(invalid.provision("bot-1"), /symbolic link/u);
    await unlink(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY));

    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const home = await service.provision("bot-1");
    const outsideSentinel = join(outside, "sentinel.txt");
    await writeFile(outsideSentinel, "outside", { mode: 0o600 });
    await rm(home.homePath, { recursive: true });
    await symlink(outside, home.homePath);
    await assert.rejects(service.resolve("bot-1"), /not an owned directory/u);
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside");
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an owned ordinary directory cannot replace a provisioned Bot home", async () => {
  const paths = await temporaryRoot("aiden-bot-home-incarnation-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const home = await service.provision("bot-1");
    const original = join(paths.parent, "original-owned-home");
    await rename(home.homePath, original);
    await mkdir(home.homePath, { mode: 0o700 });

    const restarted = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_B,
    });
    await assert.rejects(
      restarted.resolve("bot-1"),
      /replaced after its ownership receipt was issued/u,
    );
    assert.equal((await lstat(original)).isDirectory(), true);
    assert.equal((await lstat(home.homePath)).isDirectory(), true);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("fresh revalidation rejects a resolve-to-effect directory swap", async () => {
  const paths = await temporaryRoot("aiden-bot-home-revalidate-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const resolved = await service.provision("bot-1");
    assert.deepEqual(await service.revalidate(resolved), resolved);

    const original = join(paths.parent, "resolved-owned-home");
    await rename(resolved.homePath, original);
    await mkdir(resolved.homePath, { mode: 0o700 });

    await assert.rejects(
      service.revalidate(resolved),
      /replaced after its ownership receipt was issued/u,
    );
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("owned directory and metadata permissions are repaired downward", async () => {
  const paths = await temporaryRoot("aiden-bot-home-mode-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const home = await service.provision("bot-1");
    const manifest = join(paths.root, BOT_MANAGED_WORKSPACE_MANIFEST);
    const receipt = receiptPath(paths.root, WORKSPACE_A);
    await Promise.all([
      chmod(paths.root, 0o777),
      chmod(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY), 0o777),
      chmod(join(paths.root, BOT_MANAGED_HOME_RECEIPTS_DIRECTORY), 0o777),
      chmod(home.homePath, 0o777),
      chmod(manifest, 0o666),
      chmod(receipt, 0o666),
    ]);
    await service.resolve("bot-1");
    assert.equal(mode(await lstat(paths.root)), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_MANAGED_HOMES_DIRECTORY))), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_MANAGED_HOME_RECEIPTS_DIRECTORY))), 0o700);
    assert.equal(mode(await lstat(home.homePath)), 0o700);
    assert.equal(mode(await lstat(manifest)), 0o600);
    assert.equal(mode(await lstat(receipt)), 0o600);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("Bot delete erases a nonempty home, its receipt and binding, and leaves other Bots", async () => {
  const paths = await temporaryRoot("aiden-bot-home-delete-");
  try {
    const minted = [WORKSPACE_A, WORKSPACE_B];
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => minted.shift()!,
    });
    const doomed = await service.provision("bot-1");
    const kept = await service.provision("bot-2");
    await mkdir(join(doomed.homePath, "notes"), { mode: 0o700 });
    await writeFile(join(doomed.homePath, "notes", "memory.md"), "private");
    // A link inside the home must be removed, never followed.
    const outside = join(paths.parent, "outside.txt");
    await writeFile(outside, "keep me");
    await symlink(outside, join(doomed.homePath, "link"));

    assert.equal(await service.deleteHome("bot-1"), true);
    await assert.rejects(lstat(doomed.homePath), { code: "ENOENT" });
    await assert.rejects(lstat(receiptPath(paths.root, WORKSPACE_A)), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(paths.root, "removed")), []);
    assert.equal(await readFile(outside, "utf8"), "keep me");
    assert.deepEqual((await service.listBindings()).map(({ botId }) => botId), ["bot-2"]);
    assert.equal((await service.resolve("bot-2")).homePath, kept.homePath);
    await assert.rejects(service.resolve("bot-1"), /does not have a valid managed home/u);

    // Idempotent, and a restarted service still audits clean.
    assert.equal(await service.deleteHome("bot-1"), false);
    await createBotManagedWorkspaceService({ root: () => paths.root }).audit();
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("a Bot home delete interrupted after the move or the receipt removal is retryable", async () => {
  for (const crashAfter of ["move", "receipt"] as const) {
    const paths = await temporaryRoot(`aiden-bot-home-delete-crash-${crashAfter}-`);
    try {
      const service = createBotManagedWorkspaceService({
        root: () => paths.root,
        mintWorkspaceId: () => WORKSPACE_A,
      });
      const home = await service.provision("bot-1");
      await writeFile(join(home.homePath, "file.txt"), "content");
      // Reproduce the on-disk state a crash leaves: the home already moved
      // aside (and, for the second case, its receipt already gone) while the
      // binding still names it.
      await mkdir(join(paths.root, "removed"), { mode: 0o700 });
      await rename(home.homePath, join(paths.root, "removed", "crashed-home"));
      if (crashAfter === "receipt") await unlink(receiptPath(paths.root, WORKSPACE_A));

      const restarted = createBotManagedWorkspaceService({ root: () => paths.root });
      await assert.rejects(restarted.audit());
      assert.equal(await restarted.deleteHome("bot-1"), true);
      assert.deepEqual(await restarted.listBindings(), []);
      assert.deepEqual(await readdir(join(paths.root, "removed")), []);
      await restarted.audit();
    } finally {
      await rm(paths.parent, { recursive: true, force: true });
    }
  }
});

test("Bot home delete refuses a directory that replaced the owned home", async () => {
  const paths = await temporaryRoot("aiden-bot-home-delete-swap-");
  try {
    const service = createBotManagedWorkspaceService({
      root: () => paths.root,
      mintWorkspaceId: () => WORKSPACE_A,
    });
    const home = await service.provision("bot-1");
    const original = join(paths.parent, "original-owned-home");
    await rename(home.homePath, original);
    await mkdir(home.homePath, { mode: 0o700 });
    await writeFile(join(home.homePath, "foreign.txt"), "not Aiden's");

    await assert.rejects(service.deleteHome("bot-1"), /replaced directory/u);
    assert.equal(await readFile(join(home.homePath, "foreign.txt"), "utf8"), "not Aiden's");
    assert.equal((await lstat(original)).isDirectory(), true);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

function workspaceUuid(index: number): string {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((grant) => {
    resolve = grant;
  });
  return { promise, resolve };
}

test("resolve in a 50-Bot fleet inspects only the target Bot while full audits inspect all Bots", async () => {
  const paths = await temporaryRoot("aiden-bot-home-fleet-");
  try {
    const baseStorage = createFileBotManagedWorkspaceStorage({
      root: () => paths.root,
      syncDirectory: async () => undefined,
    });
    const inspected: string[] = [];
    let nextId = 0;
    const service = createBotManagedWorkspaceCore({
      storage: {
        ...baseStorage,
        inspectHome: async (directoryName) => {
          inspected.push(directoryName);
          return baseStorage.inspectHome(directoryName);
        },
      },
      now: () => 1_000 + nextId,
      mintWorkspaceId: () => {
        nextId += 1;
        return workspaceUuid(nextId);
      },
    });

    const provisioned = [];
    for (let index = 1; index <= 50; index += 1) {
      provisioned.push(await service.provision(`bot-${index}`));
    }

    inspected.length = 0;
    const resolved = await service.resolve("bot-25");
    assert.deepEqual(resolved, provisioned[24]);
    assert.deepEqual(inspected, [botManagedHomeDirectoryName(provisioned[24]!.workspaceId)]);

    // Re-provisioning an existing Bot reuses auditDocument's verified resolution instead of inspecting twice.
    inspected.length = 0;
    assert.deepEqual(await service.provision("bot-25"), provisioned[24]);
    assert.equal(inspected.length, 50);

    // Full-fleet checks remain active on listBindings and audit.
    inspected.length = 0;
    assert.equal((await service.listBindings()).length, 50);
    assert.equal(inspected.length, 50);

    inspected.length = 0;
    await service.audit();
    assert.equal(inspected.length, 50);

    // Multi-Bot bounded-parallel audit still fails closed when multiple homes are missing.
    await rm(provisioned[5]!.homePath, { recursive: true, force: true });
    await rm(provisioned[35]!.homePath, { recursive: true, force: true });
    await assert.rejects(service.audit(), /incomplete and requires reconciliation/u);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("resolve and revalidate share read access while mutations wait for active readers and block new readers", async () => {
  const paths = await temporaryRoot("aiden-bot-home-rwlock-");
  try {
    const baseStorage = createFileBotManagedWorkspaceStorage({
      root: () => paths.root,
      syncDirectory: async () => undefined,
    });
    let nextId = 0;
    let activeManifestReads = 0;
    let peakManifestReads = 0;
    const bothSharedReadersEntered = deferred();
    let releaseSharedReaders: (() => void) | undefined;

    let gateFirstReaderInspect: (() => Promise<void>) | undefined;
    let gateWriterCreateHome: (() => Promise<void>) | undefined;
    const events: string[] = [];

    const service = createBotManagedWorkspaceCore({
      storage: {
        ...baseStorage,
        readManifest: async () => {
          activeManifestReads += 1;
          peakManifestReads = Math.max(peakManifestReads, activeManifestReads);
          if (releaseSharedReaders && activeManifestReads === 2) {
            bothSharedReadersEntered.resolve();
          }
          try {
            if (releaseSharedReaders) {
              await bothSharedReadersEntered.promise;
            }
            return await baseStorage.readManifest();
          } finally {
            activeManifestReads -= 1;
          }
        },
        inspectHome: async (directoryName) => {
          if (gateFirstReaderInspect) {
            const wait = gateFirstReaderInspect;
            gateFirstReaderInspect = undefined;
            events.push("reader-1:inspect-enter");
            await wait();
            events.push("reader-1:inspect-exit");
          }
          return baseStorage.inspectHome(directoryName);
        },
        createHome: async (directoryName, receipt) => {
          events.push(`create:${receipt.botId}:enter`);
          if (gateWriterCreateHome) {
            const wait = gateWriterCreateHome;
            gateWriterCreateHome = undefined;
            await wait();
          }
          const created = await baseStorage.createHome(directoryName, receipt);
          events.push(`create:${receipt.botId}:exit`);
          return created;
        },
        removeOwnedHome: async (directoryName, receipt) => {
          events.push(`delete:${receipt.botId}:enter`);
          await baseStorage.removeOwnedHome(directoryName, receipt);
          events.push(`delete:${receipt.botId}:exit`);
        },
      },
      now: () => 2_000 + nextId,
      mintWorkspaceId: () => {
        nextId += 1;
        return workspaceUuid(nextId);
      },
    });

    const bot1 = await service.provision("bot-1");
    const bot2 = await service.provision("bot-2");
    events.length = 0;

    // 1. Concurrent resolve + revalidate enter storage in parallel without blocking one another.
    peakManifestReads = 0;
    releaseSharedReaders = () => undefined;
    const [concurrentResolved, concurrentRevalidated] = await Promise.all([
      service.resolve("bot-2"),
      service.revalidate(bot1),
    ]);
    releaseSharedReaders = undefined;
    assert.deepEqual(concurrentResolved, bot2);
    assert.deepEqual(concurrentRevalidated, bot1);
    assert.equal(peakManifestReads, 2);

    // 2. Active reader holds the shared lock; waiting writers drain active readers, block new readers,
    // serialize mutations, and then release queued readers as a shared batch before a trailing writer.
    const reader1Gate = deferred();
    const writer1Gate = deferred();
    const reader1Entered = deferred();
    const writer1Entered = deferred();

    gateFirstReaderInspect = async () => {
      reader1Entered.resolve();
      await reader1Gate.promise;
    };
    gateWriterCreateHome = async () => {
      writer1Entered.resolve();
      await writer1Gate.promise;
    };

    const reader1 = service.resolve("bot-1").then((res) => {
      events.push("reader-1:done");
      return res;
    });
    await reader1Entered.promise;

    // Queue writer-1 (provision bot-3), then two readers (blocked behind writer-1), then writer-2 (delete bot-2).
    const writer1 = service.provision("bot-3").then((res) => {
      events.push("writer-1:done");
      return res;
    });
    const queuedReaderA = service.resolve("bot-1").then((res) => {
      events.push("queued-reader-a:done");
      return res;
    });
    const queuedReaderB = service.revalidate(bot1).then((res) => {
      events.push("queued-reader-b:done");
      return res;
    });
    const writer2 = service.deleteHome("bot-2").then((deleted) => {
      events.push("writer-2:done");
      return deleted;
    });

    // Neither writer-1 nor queued readers may run while reader-1 is still active.
    await Promise.resolve();
    assert.deepEqual(events, ["reader-1:inspect-enter"]);

    // Release reader-1; writer-1 must now acquire exclusively and pause inside createHome.
    reader1Gate.resolve();
    await reader1;
    await writer1Entered.promise;
    assert.deepEqual(events, [
      "reader-1:inspect-enter",
      "reader-1:inspect-exit",
      "reader-1:done",
      "create:bot-3:enter",
    ]);

    // Release writer-1; queued readers A and B run before writer-2 deletes bot-2.
    writer1Gate.resolve();
    const [bot3, resolvedAfterWrite, revalidatedAfterWrite, deletedBot2] = await Promise.all([
      writer1,
      queuedReaderA,
      queuedReaderB,
      writer2,
    ]);
    assert.equal(bot3.botId, "bot-3");
    assert.deepEqual(resolvedAfterWrite, bot1);
    assert.deepEqual(revalidatedAfterWrite, bot1);
    assert.equal(deletedBot2, true);

    const writer1DoneIndex = events.indexOf("writer-1:done");
    const readerADoneIndex = events.indexOf("queued-reader-a:done");
    const readerBDoneIndex = events.indexOf("queued-reader-b:done");
    const deleteEnterIndex = events.indexOf("delete:bot-2:enter");
    const writer2DoneIndex = events.indexOf("writer-2:done");
    assert.ok(writer1DoneIndex < readerADoneIndex);
    assert.ok(writer1DoneIndex < readerBDoneIndex);
    assert.ok(readerADoneIndex < deleteEnterIndex);
    assert.ok(readerBDoneIndex < deleteEnterIndex);
    assert.ok(deleteEnterIndex < writer2DoneIndex);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});
