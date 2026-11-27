// Release acceptance for DESIGN.md support (spec §6.9, §11 item 1, S41):
// launches the packaged app with the live design flag on, makes a scratch
// workspace and a chat in it, writes the linter's valid fixture as the
// workspace's DESIGN.md, and reads it back through `designCanvas:designSystem`.
// That runs the lint worker and the linter from inside app.asar.
//
// Usage: node scripts/design-md-packaged-acceptance.mjs [path/to/Aiden.app]
// Without a path it looks for exactly one app under release/distribution.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const distributionRoot = path.join(repositoryRoot, "release", "distribution");
const fixture = path.join(repositoryRoot, "main", "services", "design-canvas", "design-md", "fixtures", "valid.md");
const timeoutMs = 45_000;

async function findApps(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) results.push(candidate);
    else if (entry.isDirectory()) results.push(...(await findApps(candidate)));
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

async function waitForRenderer(journal, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged Aiden exited before its window was ready (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const records = (await readFile(journal, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (records.some((record) => record.event === "renderer-ready")) return;
    } catch (error) {
      if ((error?.code ?? "") !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error("Packaged Aiden did not report its renderer ready before the deadline.");
}

const supplied = process.argv[2] ? path.resolve(process.argv[2]) : null;
const apps = supplied ? [supplied] : await findApps(distributionRoot);
if (apps.length !== 1) throw new Error(`Expected exactly one packaged Aiden app, found ${apps.length}.`);
const app = apps[0];
const executable = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
if (!(await stat(executable)).isFile()) throw new Error("Packaged Aiden executable is missing.");
const valid = await readFile(fixture, "utf8");

const root = await mkdtemp(path.join(os.tmpdir(), "aiden-design-md-acceptance-"));
const userData = path.join(root, "user-data");
const config = path.join(root, "config");
const xdgCache = path.join(root, "xdg-cache");
const xdgConfig = path.join(root, "xdg-config");
const xdgData = path.join(root, "xdg-data");
await Promise.all(
  [userData, config, xdgCache, xdgConfig, xdgData].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
);

const environment = {};
for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "TZ", "USER"]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
Object.assign(environment, {
  AIDEN_CONFIG_DIR: config,
  AIDEN_RUNTIME_PROFILE: "production",
  AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1",
  // Acceptance launches of a release build must not count as usage.
  AIDEN_ANALYTICS: "0",
  HOME: root,
  XDG_CACHE_HOME: xdgCache,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
});

const devtoolsPort = await freePort();
const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${devtoolsPort}`, "--disable-gpu"], {
  cwd: root,
  env: environment,
  stdio: "ignore",
});
let browser;
try {
  await waitForRenderer(path.join(userData, "logs", "aiden.log"), child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error("Packaged renderer was not available through DevTools.");
  const invoke = (channel, ...args) =>
    page.evaluate(
      async ({ channel: name, args: values }) => {
        const bridge = globalThis.aidenAPI;
        if (!bridge) throw new Error("Packaged preload bridge is unavailable.");
        return bridge.ipc.invoke(name, ...values);
      },
      { channel, args },
    );
  const workspace = await invoke("workspaces:createScratch");
  if (!workspace?.id || typeof workspace.folderPath !== "string") throw new Error("The scratch workspace has no folder.");
  const chat = await invoke("chats:create", { workspaceId: workspace.id, title: "DESIGN.md acceptance" });
  if (!chat?.id) throw new Error("The acceptance chat was not created.");
  await writeFile(path.join(workspace.folderPath, "DESIGN.md"), valid);
  const answer = await invoke("designCanvas:designSystem", { chatId: chat.id });
  if (
    answer?.status !== "ok" ||
    answer.path !== "DESIGN.md" ||
    answer.summary?.errors !== 0 ||
    answer.sections?.[0] !== "Overview" ||
    !Array.isArray(answer.findings)
  ) {
    throw new Error(`The packaged DESIGN.md read failed: ${JSON.stringify(answer).slice(0, 500)}`);
  }
  process.stdout.write(
    `Verified the packaged DESIGN.md linter: ${answer.summary.errors} errors, ${answer.summary.warnings} warnings, ${answer.sections.length} sections.\n`,
  );
} finally {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
