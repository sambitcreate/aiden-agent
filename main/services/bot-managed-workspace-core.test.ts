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
