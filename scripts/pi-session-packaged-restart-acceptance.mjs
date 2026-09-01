/* global Buffer, process */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import playwright from "playwright";
import { installedApplicationIdentity } from "../main/services/pi-upgrade-rollout.ts";

const { chromium } = playwright;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const timeoutMs = 45_000;

async function findApps(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) results.push(candidate);
    else if (entry.isDirectory()) results.push(...await findApps(candidate));
  }
  return results;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a DevTools port.");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function launch(executable, root, userData, config, overrides = {}) {
  const port = await freePort();
  const environment = {};
  for (const name of ["AIDEN_BUILD_ID", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "TZ", "USER"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    AIDEN_CONFIG_DIR: config,
    AIDEN_DISABLE_PRODUCTION_DIAGNOSTICS: "1",
    AIDEN_RUNTIME_PROFILE: "production",
    HOME: root,
  }, overrides);
  const child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, "--disable-gpu"],
    { cwd: root, env: environment, stdio: "ignore" },
  );
  const deadline = Date.now() + timeoutMs;
  let browser;
  while (Date.now() < deadline && !browser) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Packaged Aiden exited before the renderer was ready.");
    }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await delay(100);
    }
  }
  if (!browser) throw new Error("Packaged Aiden did not expose its renderer before timeout.");
  let page;
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) await delay(50);
  }
  if (!page) throw new Error("Packaged Aiden renderer is unavailable.");
  await page.waitForFunction(() => Boolean(globalThis.aidenAPI?.ipc), undefined, {
    timeout: timeoutMs,
  });
  return {
    page,
    async stop() {
      await browser.close().catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

async function jsonlFiles(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await jsonlFiles(candidate));
    else if (entry.name.endsWith(".jsonl")) results.push(candidate);
  }
  return results;
}

const supplied = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const apps = supplied
  ? [supplied]
  : await findApps(path.join(repositoryRoot, "release", "development"));
if (apps.length !== 1) throw new Error(`Expected exactly one packaged Aiden app, found ${apps.length}.`);
const app = apps[0];
const executable = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
if (!(await stat(executable)).isFile()) throw new Error("Packaged Aiden executable is missing.");

const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-packaged-restart-"));
const userData = path.join(root, "user-data");
const config = path.join(root, "config");
await Promise.all([userData, config].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
try {
  const rolloutRoot = path.join(userData, "pi-upgrade-rollout");
  await mkdir(rolloutRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(rolloutRoot, "pi-upgrade-rollout-v1.json"), `${JSON.stringify({
    version: 1,
    stage: "migrated_low_risk_chats",
    activatedAt: Date.now(),
    revision: 1,
  }, null, 2)}\n`, { mode: 0o600 });
  const first = await launch(executable, root, userData, config);
  const chat = await first.page.evaluate(async () => {
    const bridge = globalThis.aidenAPI;
    const workspace = await bridge.ipc.invoke("workspaces:createScratch");
    return bridge.ipc.invoke("chats:create", {
      workspaceId: workspace.id,
      title: "Pi migration restart acceptance",
    });
  });
  await first.stop();
  if (!chat?.id) throw new Error("Packaged Aiden did not create the acceptance chat.");

  const sessionsRoot = path.join(userData, "pi-compaction-sessions");
  const legacyDirectory = path.join(sessionsRoot, "--packaged-restart--");
  await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  const legacyPath = path.join(legacyDirectory, `legacy_${chat.id}.jsonl`);
  const fixtureLines = (await readFile(
    path.join(repositoryRoot, "main", "services", "fixtures", "pi-legacy", "uncompacted.jsonl"),
    "utf8",
  )).split("\n");
  const header = JSON.parse(fixtureLines[0]);
  header.id = chat.id;
  header.cwd = sessionsRoot;
  header.metadata = { kind: "aiden-chat-compaction-v1", chatId: chat.id };
  fixtureLines[0] = JSON.stringify(header);
  const legacyBytes = Buffer.from(fixtureLines.join("\n"));
  await writeFile(legacyPath, legacyBytes, { mode: 0o600 });

  const second = await launch(executable, root, userData, config);
  await second.page.evaluate(async (chatId) => {
    const result = await globalThis.aidenAPI.ipc.invoke("chats:todoSnapshot", chatId);
    if (!result || result.chatId !== chatId) throw new Error("Migrated chat did not reopen.");
  }, chat.id);
  await second.stop();

  const receiptPath = `${legacyPath}.migration-v1.json`;
  const backupPath = `${legacyPath}.v3-backup`;
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.sourceSha256 !== createHash("sha256").update(legacyBytes).digest("hex")) {
    throw new Error("Packaged migration receipt does not match the seeded v3 journal.");
  }
  if (!Buffer.from(await readFile(backupPath)).equals(legacyBytes)) {
    throw new Error("Packaged migration did not preserve exact v3 rollback bytes.");
  }
  const promotedBeforeRestart = await readFile(legacyPath);
  if (JSON.parse(promotedBeforeRestart.toString("utf8").split("\n")[0]).version !== 4) {
    throw new Error("Packaged migration did not promote the journal to v4.");
  }
  // Exercise the crash window after atomic v4 promotion but before receipt
  // publication/indexing. The next process must recover it before repository use.
  await unlink(receiptPath);

  const third = await launch(executable, root, userData, config);
  await third.page.evaluate(async (chatId) => {
    const result = await globalThis.aidenAPI.ipc.invoke("chats:todoSnapshot", chatId);
    if (!result || result.chatId !== chatId) throw new Error("Migrated chat did not survive restart.");
  }, chat.id);
  await third.stop();
  if (!(await readFile(legacyPath)).equals(promotedBeforeRestart)) {
    throw new Error("Restart unexpectedly rewrote the promoted v4 journal.");
  }
  if (JSON.parse(await readFile(receiptPath, "utf8")).sourceSha256 !== receipt.sourceSha256) {
    throw new Error("Packaged restart did not recover the interrupted migration receipt.");
  }
  if ((await jsonlFiles(sessionsRoot)).length !== 1) {
    throw new Error("Packaged restart created a duplicate chat journal.");
  }
  const beforeRollback = await readFile(legacyPath);
  const rollback = await launch(executable, root, userData, config, {
    AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED: "0",
  });
  await rollback.page.evaluate(async (chatId) => {
    const result = await globalThis.aidenAPI.ipc.invoke("chats:todoSnapshot", chatId);
    if (!result || result.chatId !== chatId) throw new Error("Rollback launch could not read the migrated chat.");
  }, chat.id);
  await rollback.stop();
  if (!(await readFile(legacyPath)).equals(beforeRollback)) {
    throw new Error("Exact-zero rollback rewrote the promoted journal.");
  }

  const receiptRoot = process.env.AIDEN_PI_UPGRADE_RECEIPT_DIR;
  if (receiptRoot) {
    if (!path.isAbsolute(receiptRoot) || !supplied) {
      throw new Error("Installed receipt output requires an absolute AIDEN_PI_UPGRADE_RECEIPT_DIR and an explicit installed app path.");
    }
    const evaluationPath = path.join(receiptRoot, "pi-upgrade-evaluation-v1.json");
    const evaluationBytes = await readFile(evaluationPath);
    const evaluation = JSON.parse(evaluationBytes.toString("utf8"));
    if (evaluation?.schema !== "aiden.pi-upgrade.evaluation" || evaluation?.report?.passed !== true) {
      throw new Error("The installed acceptance receipt requires a passing evaluation receipt.");
    }
    await new Promise((resolve, reject) => {
      const verify = spawn("codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" });
      verify.once("error", reject);
      verify.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Installed app signature verification failed.")));
    });
    const identity = await installedApplicationIdentity(executable, process.env.AIDEN_BUILD_ID);
    const installed = {
      schema: "aiden.pi-upgrade.installed",
      version: 1,
      packageSha256: identity.packageSha256,
      buildId: identity.buildId,
      evaluationSha256: createHash("sha256").update(evaluationBytes).digest("hex"),
      packagedMigrationRestartPassed: true,
      rollbackPassed: true,
      signedInstallPassed: true,
      recordedAt: new Date().toISOString(),
    };
    await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    await chmod(receiptRoot, 0o700);
    const staging = path.join(receiptRoot, `.pi-upgrade-installed.${randomUUID()}.tmp`);
    await writeFile(staging, `${JSON.stringify(installed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(staging, path.join(receiptRoot, "pi-upgrade-installed-v1.json"));
  }
  process.stdout.write("Verified packaged v3 promotion, idempotent v4 restart, and exact-zero rollback.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
